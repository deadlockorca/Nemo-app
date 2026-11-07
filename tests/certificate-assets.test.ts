import "../scripts/env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import type { RowDataPacket, ResultSetHeader } from "mysql2/promise";
import { getDb } from "../src/lib/db";
import { hashPassword, tokenHash } from "../src/lib/password";
import { prepareStorage, storageRoot, loadSecret, removeObject, objectPath } from "../src/lib/install-storage";

const base = process.env.TEST_BASE_URL || "http://localhost:3117", origin = new URL(base).origin;
if (process.env.DB_HOST !== "127.0.0.1" || process.env.DB_NAME !== "nemo_blank_test" || !["localhost", "127.0.0.1"].includes(new URL(base).hostname)) throw new Error("Dedicated local test environment required");
test("monitor-profile upload authorization and Apple-signed profile inspection preserve existing customers", { skip: !process.env.INSTALL_TEST_PROFILE || !process.env.INSTALL_TEST_UDID }, async t => {
  const db = getDb(), name = `cert-assets-${randomBytes(6).toString("hex")}`, password = randomBytes(20).toString("hex");
  const [admin] = await db.execute<ResultSetHeader>(`INSERT INTO admins (username, display_name, password_hash) VALUES (?, ?, ?)`, [name, name, await hashPassword(password)]);
  const [customer] = await db.execute<ResultSetHeader>(`INSERT INTO customers (name) VALUES (?)`, [name]);
  const [own] = await db.execute<ResultSetHeader>(`INSERT INTO customer_device_profiles (customer_id, label, apple_udid) VALUES (?, ?, ?)`, [customer.insertId, name, `00008120-${randomBytes(8).toString("hex").toUpperCase()}`]);
  const [existing] = await db.execute<RowDataPacket[]>(`SELECT * FROM customer_device_profiles WHERE apple_udid = ?`, [process.env.INSTALL_TEST_UDID!]);
  const createdActual = !existing.length;
  if (createdActual) {
    await db.execute(`INSERT INTO customer_device_profiles (customer_id, label, apple_udid) VALUES (?, ?, ?)`, [customer.insertId, `${name}-actual`, process.env.INSTALL_TEST_UDID!]);
    existing.push((await db.execute<RowDataPacket[]>(`SELECT * FROM customer_device_profiles WHERE apple_udid = ?`, [process.env.INSTALL_TEST_UDID!]))[0][0]);
  }
  const before = JSON.stringify(existing[0]); let cookie = "";
  const bytes = await readFile(process.env.INSTALL_TEST_PROFILE!);
  async function upload(target: string, operation: string, data = bytes, auth = cookie, requestOrigin = origin, version = 1) {
    const form = new FormData(); form.set("profile", new Blob([new Uint8Array(data)]), "cert.mobileprovision"); form.set("version", String(version));
    return fetch(`${base}/api/admin/device-profiles/${target}/${operation}`, { method: "POST", headers: { cookie: auth, origin: requestOrigin }, body: form });
  }
  try {
    assert.equal((await upload(String(own.insertId), "certificate")).status, 401);
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", redirect: "manual", headers: { origin }, body: new URLSearchParams({ username: name, password }) }); assert.equal(login.status, 303); cookie = login.headers.get("set-cookie")!.split(";")[0];
    await t.test("cross-origin uploads and invalid or mismatched profiles are rejected", async () => {
      assert.equal((await upload(String(own.insertId), "certificate", bytes, cookie, "https://evil.invalid")).status, 403);
      assert.equal((await upload(String(own.insertId), "certificate", Buffer.from("fake unsigned profile"))).status, 400);
      assert.equal((await upload(String(own.insertId), "certificate", bytes)).status, 400);
    });
    await t.test("real public profile is inspected without a P12 or password", async () => {
      const r = await upload(String(existing[0].id), "certificate-inspect"); assert.equal(r.status, 200, await r.clone().text());
      const data = await r.json(); assert.ok(data.certificates.length > 0); assert.match(data.certificates[0].sha256, /^[a-f0-9]{64}$/); assert.ok(Number.isFinite(Date.parse(data.profileExpiresAt)));
      assert.equal(JSON.stringify(data).includes("DeveloperCertificates"), false); assert.equal(JSON.stringify(data).includes("password"), false);
    });
    await t.test("stale asset attachment is rejected without orphaning an encrypted file or editing inventory", async () => {
      await prepareStorage(); const files = (await readdir(storageRoot())).sort();
      const r = await upload(String(existing[0].id), "certificate", bytes, cookie, origin, Number(existing[0].version) + 1000); assert.equal(r.status, 409, await r.clone().text());
      assert.deepEqual((await readdir(storageRoot())).sort(), files);
      const [after] = await db.execute<RowDataPacket[]>(`SELECT * FROM customer_device_profiles WHERE id = ?`, [existing[0].id]); assert.equal(JSON.stringify(after[0]), before);
    });
    await t.test("a legacy device with no installation can attach only its public profile", { skip: !createdActual }, async () => {
      const r = await upload(String(existing[0].id), "certificate"); assert.equal(r.status, 200, await r.clone().text());
      const [assets] = await db.execute<RowDataPacket[]>(`SELECT * FROM ios_device_certificate_assets WHERE device_profile_id = ?`, [existing[0].id]); assert.equal(assets.length, 1); assert.equal(assets[0].bound_installation_id, null);
      const stored = await loadSecret(assets[0].secrets_key); assert.equal(stored.p12, ""); assert.equal(stored.password, ""); assert.equal(stored.profile, bytes.toString("base64"));
      assert.equal((await readFile(objectPath(assets[0].secrets_key, "secret"))).includes(bytes), false);
      const list = await fetch(`${base}/api/admin/device-profiles?q=${encodeURIComponent(name)}`, { headers: { cookie } }); assert.equal(list.status, 200);
      const device = (await list.json()).items.find((p: {id:string}) => String(p.id) === String(existing[0].id)); assert.equal(device.certificate_monitor_attached, true); assert.equal(device.installation_id, null);
    });
  } finally {
    const [assets] = await db.execute<RowDataPacket[]>(`SELECT a.secrets_key FROM ios_device_certificate_assets a JOIN customer_device_profiles p ON p.id = a.device_profile_id WHERE p.customer_id = ?`, [customer.insertId]);
    for (const asset of assets) await removeObject(asset.secrets_key, "secret");
    await db.execute(`DELETE FROM customer_device_profiles WHERE customer_id = ?`, [customer.insertId]); await db.execute(`DELETE FROM customers WHERE id = ?`, [customer.insertId]);
    await db.execute(`DELETE FROM audit_events WHERE admin_id = ?`, [admin.insertId]); await db.execute(`DELETE FROM admins WHERE id = ?`, [admin.insertId]); await db.execute(`DELETE FROM login_limits WHERE bucket = ?`, [tokenHash(name)]);
    await db.end();
  }
});
