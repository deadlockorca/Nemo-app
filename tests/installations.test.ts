import "../scripts/env";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile, readdir } from "node:fs/promises";
import type { RowDataPacket, ResultSetHeader } from "mysql2/promise";
import { getDb } from "../src/lib/db";
import { hashPassword, tokenHash } from "../src/lib/password";
import { runSigningJob } from "../src/lib/installations";
import { loadSecret, objectPath, prepareStorage, removeObject, storageRoot } from "../src/lib/install-storage";

const base = process.env.TEST_BASE_URL || "http://localhost:3000", origin = new URL(base).origin;
const realAssets = process.env.INSTALL_TEST_IPA && process.env.INSTALL_TEST_P12 && process.env.INSTALL_TEST_PROFILE && process.env.INSTALL_TEST_UDID;
test("customer installation, actual macOS signing, private OTA delivery and revocation", { skip: !realAssets, timeout: 180000 }, async (t) => {
  const db = getDb(), prefix = `install-${randomBytes(8).toString("hex")}`, password = randomBytes(20).toString("hex");
  const [admin] = await db.execute<ResultSetHeader>(`INSERT INTO admins (username, display_name, password_hash) VALUES (?, ?, ?)`, [prefix, prefix, await hashPassword(password)]);
  const [customer] = await db.execute<ResultSetHeader>(`INSERT INTO customers (name) VALUES (?)`, [prefix]);
  const [license] = await db.execute<ResultSetHeader>(`INSERT INTO licenses (customer_id, key_hash, key_hint, status, activated_at, expires_at) VALUES (?, ?, ?, 'active', UTC_TIMESTAMP(3), TIMESTAMPADD(DAY, 30, UTC_TIMESTAMP(3)))`, [customer.insertId, tokenHash(randomBytes(32).toString("hex")), "TESTONLY"]);
  const nemoIds = { device_id: randomUUID().toUpperCase(), uuid: randomBytes(32).toString("hex") };
  await db.execute(`INSERT INTO license_identities (license_id, device_id, registration_uuid) VALUES (?, ?, ?)`, [license.insertId, nemoIds.device_id, nemoIds.uuid]);
  let adminCookie = "", customerCookie = "", installId = "", installCode = "", downloadPath = "", manifest = "", sourceKey = "", secretKey = "", outputKey = "";
  const request = (path: string, data?: unknown, cookie = customerCookie, suppliedOrigin = origin) => fetch(new URL(path, base), { method: data === undefined ? "GET" : "POST", headers: { cookie, origin: suppliedOrigin, "Content-Type": "application/json" }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  async function upload(changes: Record<string, string> = {}) {
    const form = new FormData();
    form.set("licenseId", String(license.insertId)); form.set("label", prefix); form.set("appleUdid", process.env.INSTALL_TEST_UDID!); form.set("password", process.env.INSTALL_TEST_PASSWORD || "");
    for (const [field, env] of [["ipa", "INSTALL_TEST_IPA"], ["p12", "INSTALL_TEST_P12"], ["profile", "INSTALL_TEST_PROFILE"]]) form.set(field, new Blob([await readFile(process.env[env]!)]), field === "ipa" ? "Nemo.ipa" : field === "p12" ? "cert.p12" : "cert.mobileprovision");
    for (const [k, v] of Object.entries(changes)) form.set(k, v);
    return fetch(new URL("/api/admin/installations", base), { method: "POST", headers: { cookie: adminCookie, origin }, body: form });
  }
  try {
    const login = await fetch(new URL("/api/auth/login", base), { method: "POST", redirect: "manual", headers: { origin }, body: new URLSearchParams({ username: prefix, password }) });
    assert.equal(login.status, 303); adminCookie = login.headers.get("set-cookie")!.split(";")[0];
    await t.test("portal is public, package management requires admin; cross-origin writes fail", async () => {
      assert.equal((await request("/install", undefined, "")).status, 200);
      assert.equal((await request("/api/admin/installations", undefined, "")).status, 401);
      assert.equal((await request("/api/admin/installations", {}, adminCookie, "https://evil.invalid")).status, 403);
      assert.equal((await request("/api/install/status", undefined, "")).status, 401);
      assert.equal((await request("/api/install/prepare", {}, "")).status, 401);
      assert.equal((await request("/api/install/login", { code: nemoIds.uuid }, "")).status, 401);
      assert.equal((await request("/api/install/login", { code: "not-a-code" }, "", "https://evil.invalid")).status, 403);
    });
    await t.test("wrong p12 password and uncovered UDID fail without orphaned files", async () => {
      await prepareStorage();
      const before = await readdir(storageRoot());
      const wrong = await upload({ password: "not-the-correct-password" });
      assert.equal(wrong.status, 400, await wrong.clone().text());
      const target = await upload({ appleUdid: "00008120-0000000000000000" });
      assert.equal(target.status, 400, await target.clone().text());
      assert.deepEqual((await readdir(storageRoot())).sort(), before.sort());
    });
    await t.test("admin upload validates Apple-signed profile and issues only an independent install code", async () => {
      const r = await upload(); assert.equal(r.status, 201, await r.clone().text());
      const result = await r.json(); installId = result.id; installCode = result.code;
      assert.ok(Date.parse(result.expiresAt) - Date.now() > 895000);
      assert.ok(Date.parse(result.expiresAt) - Date.now() <= 900000);
      assert.match(installCode, /^[a-f0-9-]{36}$/); assert.notEqual(installCode, nemoIds.device_id.toLowerCase());
      assert.equal(result.metadata.name, "Nemo"); assert.equal(result.metadata.blankIdentity, true);
      const [rows] = await db.execute<RowDataPacket[]>(`SELECT * FROM ios_installations WHERE id = ?`, [installId]);
      assert.equal(rows[0].code_hash, tokenHash(installCode)); sourceKey = rows[0].source_key; secretKey = rows[0].secrets_key;
      const encrypted = await readFile(objectPath(secretKey, "secret")); const rawP12 = await readFile(process.env.INSTALL_TEST_P12!);
      assert.equal(encrypted.includes(rawP12), false); assert.equal(encrypted.includes(Buffer.from('"password"')), false);
      const secret = await loadSecret(secretKey); assert.equal(secret.password, process.env.INSTALL_TEST_PASSWORD || "");
      const tampered = Buffer.from(encrypted); tampered[tampered.length - 1] ^= 1;
      await writeFile(objectPath(secretKey, "secret"), tampered);
      await assert.rejects(loadSecret(secretKey));
      await writeFile(objectPath(secretKey, "secret"), encrypted);
      const list = await request("/api/admin/installations", undefined, adminCookie); const text = await list.text();
      assert.ok(!text.includes(installCode)); assert.ok(!text.includes(secret.p12)); assert.ok(!text.includes(nemoIds.uuid));
    });
    await t.test("code login sets a private session; portal status never exposes either Nemo ID", async () => {
      const r = await request("/api/install/login", { code: installCode }, ""); assert.equal(r.status, 200);
      const setCookie = r.headers.get("set-cookie")!; assert.match(setCookie, /HttpOnly/i); assert.match(setCookie, /SameSite=strict/i);
      customerCookie = setCookie.split(";")[0];
      const status = await request("/api/install/status"); const text = await status.text();
      assert.equal(JSON.parse(text).status, "new"); assert.ok(!text.includes(nemoIds.device_id)); assert.ok(!text.includes(nemoIds.uuid));
      assert.equal((await request("/api/install/link", {})).status, 409);
    });
    await t.test("simultaneous prepare requests enqueue exactly once and the worker signs real bytes", async () => {
      const responses = await Promise.all([request("/api/install/prepare", {}), request("/api/install/prepare", {})]);
      assert.deepEqual(responses.map((r) => r.status), [202, 202]);
      const [jobs] = await db.execute<RowDataPacket[]>(`SELECT * FROM ios_signing_jobs WHERE installation_id = ?`, [installId]); assert.equal(jobs.length, 1);
      assert.equal(await runSigningJob(), true);
      const r = await request("/api/install/status"); const status = await r.json(); assert.equal(status.status, "ready", JSON.stringify(status));
      const [signed] = await db.execute<RowDataPacket[]>(`SELECT * FROM ios_signing_jobs WHERE installation_id = ?`, [installId]); outputKey = signed[0].output_key;
      const signedBytes = await readFile(objectPath(outputKey, "ipa")); assert.equal(createHash("sha256").update(signedBytes).digest("hex"), signed[0].output_sha256);
      assert.equal(await runSigningJob(), false);
    });
    await t.test("manifest and IPA use expiring bearer links, independent of browser cookies; ranges work", async () => {
      const r = await request("/api/install/link", {}); assert.equal(r.status, 200, await r.clone().text()); const link = await r.json();
      assert.match(link.installUrl, /^itms-services:/); manifest = new URL(new URL(link.installUrl).searchParams.get("url")!).pathname;
      downloadPath = manifest.replace("manifest.plist", "Nemo.ipa");
      const response = await request(manifest, undefined, ""); assert.equal(response.status, 200);
      assert.match(response.headers.get("cache-control") || "", /no-store/);
      const text = await response.text(); assert.ok(text.includes("<string>Nemo</string>")); assert.ok(text.includes("vn.fractal.nemo-rebuild")); assert.ok(!text.includes(nemoIds.uuid));
      assert.equal((await request(manifest.replace(/download\/[a-f0-9]{64}/, `download/${"f".repeat(64)}`), undefined, "")).status, 404);
      const head = await fetch(new URL(downloadPath, base), { method: "HEAD" }); assert.equal(head.status, 200); assert.ok(Number(head.headers.get("content-length")) > 1000000);
      const part = await fetch(new URL(downloadPath, base), { headers: { Range: "bytes=0-31" } }); assert.equal(part.status, 206); const bytes = Buffer.from(await part.arrayBuffer()); assert.equal(bytes.length, 32); assert.equal(bytes.subarray(0, 2).toString(), "PK");
      const suffix = await fetch(new URL(downloadPath, base), { headers: { Range: "bytes=-16" } }); assert.equal(suffix.status, 206); assert.equal((await suffix.arrayBuffer()).byteLength, 16);
      assert.equal((await fetch(new URL(downloadPath, base), { headers: { Range: "bytes=9999999999-" } })).status, 416);
      assert.equal((await fetch(new URL(downloadPath, base), { headers: { Range: "bytes=0-2,5-9" } })).status, 416);
      await db.execute(`UPDATE ios_downloads d JOIN ios_signing_jobs j ON j.id = d.job_id
        SET d.expires_at = UTC_TIMESTAMP(3) - INTERVAL 1 SECOND WHERE j.installation_id = ?`, [installId]);
      assert.equal((await request(manifest, undefined, "")).status, 404);
    });
    await t.test("rotating the install code invalidates old sessions and links while preserving the license", async () => {
      const before = await request("/api/install/link", {}); assert.equal(before.status, 200);
      manifest = new URL(new URL((await before.json()).installUrl).searchParams.get("url")!).pathname;
      const r = await request(`/api/admin/installations/${installId}/rotate`, {}, adminCookie); assert.equal(r.status, 200); const rotated = await r.json();
      assert.equal((await request("/api/install/status")).status, 401); assert.equal((await request(manifest, undefined, "")).status, 404);
      assert.equal((await request("/api/install/login", { code: installCode }, "")).status, 401);
      const newLogin = await request("/api/install/login", { code: rotated.code }, ""); assert.equal(newLogin.status, 200); customerCookie = newLogin.headers.get("set-cookie")!.split(";")[0];
      const newLink = await request("/api/install/link", {}); assert.equal(newLink.status, 200); manifest = new URL(new URL((await newLink.json()).installUrl).searchParams.get("url")!).pathname;
      assert.equal((await request(`/api/admin/installations/${installId}/revoke`, {}, adminCookie)).status, 200);
      assert.equal((await request(manifest, undefined, "")).status, 404); assert.equal((await request("/api/install/status")).status, 401);
      const [rows] = await db.execute<RowDataPacket[]>(`SELECT l.status, li.* FROM licenses l JOIN license_identities li ON li.license_id = l.id WHERE l.id = ?`, [license.insertId]);
      assert.equal(rows[0].status, "active"); assert.equal(rows[0].device_id, nemoIds.device_id); assert.equal(rows[0].registration_uuid, nemoIds.uuid);
    });
  } finally {
    await db.execute(`DELETE FROM customer_device_profiles WHERE customer_id = ?`, [customer.insertId]);
    if (installId) await db.execute(`DELETE FROM ios_installations WHERE id = ?`, [installId]);
    await db.execute(`DELETE FROM licenses WHERE id = ?`, [license.insertId]);
    await db.execute(`DELETE FROM customers WHERE id = ?`, [customer.insertId]);
    await db.execute(`DELETE FROM audit_events WHERE admin_id = ?`, [admin.insertId]);
    await db.execute(`DELETE FROM admins WHERE id = ?`, [admin.insertId]);
    await db.execute(`DELETE FROM login_limits WHERE bucket = ?`, [tokenHash(prefix)]);
    if (sourceKey) await removeObject(sourceKey, "ipa"); if (secretKey) await removeObject(secretKey, "secret"); if (outputKey) await removeObject(outputKey, "ipa");
    await db.end();
  }
});
