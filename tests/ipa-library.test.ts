import "../scripts/env";
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import type { RowDataPacket, ResultSetHeader } from "mysql2/promise";
import { getDb } from "../src/lib/db";
import { hashPassword, tokenHash } from "../src/lib/password";
import { objectPath, removeObject, prepareStorage, storageRoot } from "../src/lib/install-storage";
import { runSigningJob } from "../src/lib/installations";

const base = process.env.TEST_BASE_URL || "http://localhost:3000", origin = new URL(base).origin;
const realAssets = process.env.INSTALL_TEST_IPA && process.env.INSTALL_TEST_P12 && process.env.INSTALL_TEST_PROFILE && process.env.INSTALL_TEST_UDID;
test("shared IPA library: validated sources, deduplication, archival and existing installation compatibility", { skip: !realAssets, timeout: 240000 }, async t => {
  const db = getDb(), prefix = `library-${randomBytes(8).toString("hex")}`, password = randomBytes(20).toString("hex");
  const [admin] = await db.execute<ResultSetHeader>(`INSERT INTO admins (username, display_name, password_hash) VALUES (?, ?, ?)`, [prefix, prefix, await hashPassword(password)]);
  const [customer] = await db.execute<ResultSetHeader>(`INSERT INTO customers (name) VALUES (?)`, [prefix]);
  const [license] = await db.execute<ResultSetHeader>(`INSERT INTO licenses (customer_id, key_hash, key_hint, status, activated_at, expires_at) VALUES (?, ?, 'LIBTEST', 'active', UTC_TIMESTAMP(3), TIMESTAMPADD(DAY, 30, UTC_TIMESTAMP(3)))`, [customer.insertId, tokenHash(randomBytes(32).toString("hex"))]);
  const nemoIds = { device_id: randomUUID().toUpperCase(), uuid: randomBytes(32).toString("hex") };
  await db.execute(`INSERT INTO license_identities (license_id, device_id, registration_uuid) VALUES (?, ?, ?)`, [license.insertId, nemoIds.device_id, nemoIds.uuid]);
  // A ZIP comment makes this fixture independent of any real library entries,
  // while leaving the exact production app payload available for signing.
  const bytes = execFileSync(process.env.IOS_SIGN_PYTHON || "python3", ["-c", "import io,sys,zipfile; b=io.BytesIO(open(sys.argv[1],'rb').read()); z=zipfile.ZipFile(b,'a'); z.comment=sys.argv[2].encode(); z.close(); sys.stdout.buffer.write(b.getvalue())", process.env.INSTALL_TEST_IPA!, prefix], { maxBuffer: 160 * 1024 * 1024 });
  const sha = createHash("sha256").update(bytes).digest("hex");
  let cookie = "", releaseId = "", source = "", installCode = "";
  const extraSources: string[] = [];
  const request = (path: string, data?: unknown, auth = cookie, suppliedOrigin = origin) => fetch(new URL(path, base), { method: data === undefined ? "GET" : "POST", headers: { cookie: auth, origin: suppliedOrigin, "Content-Type": "application/json" }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  async function upload(payload: Buffer = bytes, label = prefix) {
    const form = new FormData(); form.set("label", label); form.set("notes", "Local library integration test"); form.set("ipa", new Blob([new Uint8Array(payload)]), "Nemo.ipa");
    return fetch(new URL("/api/admin/ipa-releases", base), { method: "POST", headers: { cookie, origin }, body: form });
  }
  async function install(changes: Record<string, string> = {}) {
    const form = new FormData();
    for (const [k, v] of Object.entries({ licenseId: String(license.insertId), label: prefix, appleUdid: process.env.INSTALL_TEST_UDID!, password: process.env.INSTALL_TEST_PASSWORD || "", releaseId, ...changes })) form.set(k, v);
    form.set("p12", new Blob([await readFile(process.env.INSTALL_TEST_P12!)]), "cert.p12");
    form.set("profile", new Blob([await readFile(process.env.INSTALL_TEST_PROFILE!)]), "cert.mobileprovision");
    return fetch(new URL("/api/admin/installations", base), { method: "POST", headers: { cookie, origin }, body: form });
  }
  try {
    const login = await fetch(new URL("/api/auth/login", base), { method: "POST", redirect: "manual", headers: { origin }, body: new URLSearchParams({ username: prefix, password }) });
    assert.equal(login.status, 303); cookie = login.headers.get("set-cookie")!.split(";")[0];
    await t.test("admin and same-origin authorization protect library operations", async () => {
      assert.equal((await request("/api/admin/ipa-releases", undefined, "")).status, 401);
      assert.equal((await request("/api/admin/ipa-releases", {}, "")).status, 401);
      assert.equal((await request("/api/admin/ipa-releases", {}, cookie, "https://evil.invalid")).status, 403);
      assert.equal((await request(`/api/admin/ipa-releases/${"a".repeat(32)}/archive`, { version: 1 }, cookie, "https://evil.invalid")).status, 403);
    });
    await t.test("invalid IPA leaves no stored source or database entry", async () => {
      await prepareStorage(); const before = (await readdir(storageRoot())).sort();
      const r = await upload(Buffer.from("not a ZIP archive")); assert.equal(r.status, 400, await r.clone().text());
      assert.deepEqual((await readdir(storageRoot())).sort(), before);
      const [rows] = await db.execute<RowDataPacket[]>(`SELECT id FROM ios_ipa_releases WHERE label = ?`, [prefix]); assert.equal(rows.length, 0);
    });
    await t.test("simultaneous identical uploads store a single immutable version and file", async () => {
      const before = new Set(await readdir(storageRoot()));
      const responses = await Promise.all([upload(), upload()]);
      assert.deepEqual(responses.map(r => r.status).sort(), [200, 201]);
      const results = await Promise.all(responses.map(r => r.json()));
      releaseId = results[0].id; assert.equal(results[1].id, releaseId);
      assert.equal(results.filter(r => r.duplicate).length, 1);
      const [rows] = await db.execute<RowDataPacket[]>(`SELECT * FROM ios_ipa_releases WHERE source_sha256 = ?`, [sha]);
      assert.equal(rows.length, 1); source = rows[0].source_key;
      assert.equal(rows[0].metadata.name, "Nemo"); assert.equal(rows[0].metadata.blankIdentity, true);
      assert.equal(Number(rows[0].size_bytes), bytes.length);
      assert.deepEqual((await readdir(storageRoot())).filter(f => !before.has(f)), [`${source}.ipa`]);
      const list = await request(`/api/admin/ipa-releases?q=${prefix}`); const text = await list.text(); const parsed = JSON.parse(text);
      assert.equal(parsed.total, 1); assert.equal(parsed.items[0].source_sha256, sha);
      assert.ok(!text.includes(source)); assert.ok(!text.includes(storageRoot())); assert.ok(!text.includes(nemoIds.uuid));
    });
    await t.test("different IPA content gets its own version even with the same displayed app version", async () => {
      const second = execFileSync(process.env.IOS_SIGN_PYTHON || "python3", ["-c", "import io,sys,zipfile; b=io.BytesIO(sys.stdin.buffer.read()); z=zipfile.ZipFile(b,'a'); z.comment+=b'-v2'; z.close(); sys.stdout.buffer.write(b.getvalue())"], { input: bytes, maxBuffer: 160 * 1024 * 1024 });
      const r = await upload(second, `${prefix}-v2`); assert.equal(r.status, 201, await r.clone().text());
      const result = await r.json(); assert.notEqual(result.id, releaseId);
      const [rows] = await db.execute<RowDataPacket[]>(`SELECT source_key FROM ios_ipa_releases WHERE id = ?`, [result.id]); extraSources.push(rows[0].source_key);
      const list = await (await request(`/api/admin/ipa-releases?q=${prefix}`)).json(); assert.equal(list.total, 2);
    });
    await t.test("failed customer certificate validation cannot delete the shared source", async () => {
      const before = (await readdir(storageRoot())).sort();
      const r = await install({ password: "intentionally-wrong" }); assert.equal(r.status, 400, await r.clone().text());
      assert.deepEqual((await readdir(storageRoot())).sort(), before);
      assert.equal(createHash("sha256").update(await readFile(objectPath(source, "ipa"))).digest("hex"), sha);
    });
    await t.test("changed source bytes are rejected instead of being signed as the stored release", async () => {
      const sourcePath = objectPath(source, "ipa"), before = (await readdir(storageRoot())).sort();
      await writeFile(sourcePath, Buffer.concat([bytes, Buffer.from("changed-source")]));
      try {
        const r = await install(); assert.equal(r.status, 400, await r.clone().text());
        assert.match((await r.json()).error, /IPA nguồn đã thay đổi/);
        assert.deepEqual((await readdir(storageRoot())).sort(), before);
      } finally { await writeFile(sourcePath, bytes); }
    });
    await t.test("two installations share one source, retain separate encrypted signing assets and preserve key dates", async () => {
      const [before] = await db.execute<RowDataPacket[]>(`SELECT status, activated_at, expires_at, version FROM licenses WHERE id = ?`, [license.insertId]);
      for (let n = 0; n < 2; n++) {
        const r = await install(); assert.equal(r.status, 201, await r.clone().text()); installCode = (await r.json()).code;
      }
      const [rows] = await db.execute<RowDataPacket[]>(`SELECT source_key, secrets_key, release_id FROM ios_installations WHERE license_id = ?`, [license.insertId]);
      assert.equal(rows.length, 2); assert.ok(rows.every(r => r.source_key === source && r.release_id === releaseId));
      assert.notEqual(rows[0].secrets_key, rows[1].secrets_key);
      const [after] = await db.execute<RowDataPacket[]>(`SELECT status, activated_at, expires_at, version FROM licenses WHERE id = ?`, [license.insertId]); assert.deepEqual(after, before);
      const list = await (await request(`/api/admin/ipa-releases?q=${prefix}`)).json(); assert.equal(Number(list.items.find((r: {id:string}) => r.id === releaseId).installation_count), 2);
      const installations = await (await request("/api/admin/installations")).json();
      assert.ok(installations.releases.some((r: {id:string}) => r.id === releaseId));
      assert.ok(installations.items.filter((i: {license_id:string}) => String(i.license_id) === String(license.insertId)).every((i: {release_label:string}) => i.release_label === prefix));
    });
    await t.test("archive blocks new selections, uses optimistic versioning and deduplicates archived uploads", async () => {
      assert.equal((await request(`/api/admin/ipa-releases/${releaseId}/archive`, { version: 1 })).status, 200);
      assert.equal((await request(`/api/admin/ipa-releases/${releaseId}/restore`, { version: 1 })).status, 409);
      const r = await install(); assert.equal(r.status, 409, await r.clone().text());
      const again = await upload(); assert.equal(again.status, 200); assert.equal((await again.json()).state, "archived");
      const list = await (await request("/api/admin/installations")).json(); assert.ok(!list.releases.some((r: {id:string}) => r.id === releaseId));
      assert.equal(createHash("sha256").update(await readFile(objectPath(source, "ipa"))).digest("hex"), sha);
    });
    await t.test("existing installation can still log in, sign and download after its source is archived", async () => {
      const login = await request("/api/install/login", { code: installCode }, ""); assert.equal(login.status, 200);
      const customerCookie = login.headers.get("set-cookie")!.split(";")[0];
      assert.equal((await request("/api/install/prepare", {}, customerCookie)).status, 202);
      await runSigningJob();
      const status = await (await request("/api/install/status", undefined, customerCookie)).json(); assert.equal(status.status, "ready", JSON.stringify(status));
      const link = await request("/api/install/link", {}, customerCookie); assert.equal(link.status, 200, await link.clone().text());
      const manifest = new URL(new URL((await link.json()).installUrl).searchParams.get("url")!).pathname;
      const r = await request(manifest, undefined, ""); assert.equal(r.status, 200); assert.ok((await r.text()).includes("<string>Nemo</string>"));
      const ipa = await fetch(new URL(manifest.replace("manifest.plist", "Nemo.ipa"), base), { headers: { Range: "bytes=0-31" } }); assert.equal(ipa.status, 206);
    });
    await t.test("restore makes an unchanged source selectable again", async () => {
      assert.equal((await request(`/api/admin/ipa-releases/${releaseId}/restore`, { version: 2 })).status, 200);
      const list = await (await request("/api/admin/installations")).json(); assert.ok(list.releases.some((r: {id:string}) => r.id === releaseId));
      assert.equal(createHash("sha256").update(await readFile(objectPath(source, "ipa"))).digest("hex"), sha);
    });
  } finally {
    const [installs] = await db.execute<RowDataPacket[]>(`SELECT i.secrets_key, j.output_key FROM ios_installations i LEFT JOIN ios_signing_jobs j ON j.installation_id = i.id WHERE i.license_id = ?`, [license.insertId]);
    const [releases] = await db.execute<RowDataPacket[]>(`SELECT source_key FROM ios_ipa_releases WHERE label IN (?, ?)`, [prefix, `${prefix}-v2`]);
    await db.execute(`DELETE FROM customer_device_profiles WHERE customer_id = ?`, [customer.insertId]);
    await db.execute(`DELETE FROM ios_installations WHERE license_id = ?`, [license.insertId]);
    await db.execute(`DELETE FROM ios_ipa_releases WHERE label IN (?, ?)`, [prefix, `${prefix}-v2`]);
    await db.execute(`DELETE FROM licenses WHERE id = ?`, [license.insertId]); await db.execute(`DELETE FROM customers WHERE id = ?`, [customer.insertId]);
    await db.execute(`DELETE FROM audit_events WHERE admin_id = ?`, [admin.insertId]); await db.execute(`DELETE FROM admins WHERE id = ?`, [admin.insertId]);
    await db.execute(`DELETE FROM login_limits WHERE bucket = ?`, [tokenHash(prefix)]);
    for (const row of installs) { await removeObject(row.secrets_key, "secret"); if (row.output_key) await removeObject(row.output_key, "ipa"); }
    for (const key of new Set([...releases.map(r => r.source_key), ...extraSources, ...(source ? [source] : [])])) await removeObject(key, "ipa");
    await db.end();
  }
});
