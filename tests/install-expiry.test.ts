import "../scripts/env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { getDb } from "../src/lib/db";
import { hashPassword, tokenHash } from "../src/lib/password";
import { storeObject, removeObject } from "../src/lib/install-storage";

const base = process.env.TEST_BASE_URL || "http://localhost:3117", origin = new URL(base).origin;
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(base).hostname)) throw new Error("Local tests only");

test("install codes expire after 15 minutes without changing signed packages, licenses or Nemo IDs", async t => {
  const db = getDb(), prefix = `expiry-${randomBytes(6).toString("hex")}`, password = randomBytes(20).toString("hex");
  const [admin] = await db.execute<ResultSetHeader>(`INSERT INTO admins (username, display_name, password_hash) VALUES (?, ?, ?)`, [prefix, prefix, await hashPassword(password)]);
  const [customer] = await db.execute<ResultSetHeader>(`INSERT INTO customers (name) VALUES (?)`, [prefix]);
  const [license] = await db.execute<ResultSetHeader>(`INSERT INTO licenses (customer_id, key_hash, key_hint, status, activated_at, expires_at) VALUES (?, ?, 'TESTONLY', 'active', UTC_TIMESTAMP(3), TIMESTAMPADD(DAY, 30, UTC_TIMESTAMP(3)))`, [customer.insertId, tokenHash(randomUUID())]);
  await db.execute(`INSERT INTO license_identities (license_id, device_id, registration_uuid) VALUES (?, ?, ?)`, [license.insertId, randomUUID().toUpperCase(), randomBytes(32).toString("hex")]);
  await db.execute(`INSERT INTO devices (license_id, public_key, fingerprint) VALUES (?, 'test-only', ?)`, [license.insertId, tokenHash(prefix)]);
  const installation = randomBytes(16).toString("hex"), job = randomBytes(16).toString("hex"), rawCode = randomUUID();
  const bytes = Buffer.from("PK-test-fixture-for-download-authorization"), output = await storeObject(bytes, "ipa");
  const metadata = { bundle: "vn.fractal.nemo-rebuild", build: "322", version: "6.11.23", signingMode: "ad-hoc", certificateExpiresAt: new Date(Date.now() + 86400000).toISOString(), profileExpiresAt: new Date(Date.now() + 86400000).toISOString() };
  await db.execute(`INSERT INTO ios_installations (id, license_id, label, apple_udid, code_hash, source_key, secrets_key, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [installation, license.insertId, prefix, `00008120-${randomBytes(8).toString("hex").toUpperCase()}`, tokenHash(rawCode), randomBytes(16).toString("hex"), randomBytes(16).toString("hex"), JSON.stringify(metadata)]);
  await db.execute(`INSERT INTO ios_signing_jobs (id, installation_id, status, output_key, output_sha256, finished_at) VALUES (?, ?, 'ready', ?, ?, UTC_TIMESTAMP(3))`, [job, installation, output, createHash("sha256").update(bytes).digest("hex")]);
  let adminCookie = "", customerCookie = "", code = "", manifest = "";
  const request = (path: string, data?: unknown, cookie = customerCookie) => fetch(new URL(path, base), { method: data === undefined ? "GET" : "POST", redirect: "manual", headers: { cookie, origin, "content-type": "application/json" }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const rotate = () => request(`/api/admin/installations/${installation}/rotate`, {}, adminCookie);
  async function login() {
    const r = await request("/api/install/login", { code }, ""); assert.equal(r.status, 200, await r.clone().text());
    const header = r.headers.get("set-cookie")!, age = Number(/Max-Age=(\d+)/i.exec(header)![1]);
    assert.ok(age > 0 && age <= 900); customerCookie = header.split(";")[0]; return age;
  }
  async function link() {
    const r = await request("/api/install/link", {}); assert.equal(r.status, 200, await r.clone().text());
    const body = await r.json(); assert.ok(body.expiresIn >= 0 && body.expiresIn <= 900);
    manifest = new URL(new URL(body.installUrl).searchParams.get("url")!).pathname; return body;
  }
  const snapshot = async () => JSON.stringify((await db.execute<RowDataPacket[]>(`SELECT l.*, i.device_id, i.registration_uuid, d.public_key, d.fingerprint FROM licenses l JOIN license_identities i ON i.license_id = l.id JOIN devices d ON d.license_id = l.id WHERE l.id = ?`, [license.insertId]))[0]);
  const before = await snapshot();
  try {
    const auth = await fetch(`${base}/api/auth/login`, { method: "POST", redirect: "manual", headers: { origin }, body: new URLSearchParams({ username: prefix, password }) });
    assert.equal(auth.status, 303); adminCookie = auth.headers.get("set-cookie")!.split(";")[0];
    await t.test("migration grants existing install codes 15 minutes and caps their old sessions/downloads", async () => {
      // Temporary tables shadow only this connection; exercise the exact migration
      // without changing any real installation or migration checksum.
      const connection = await db.getConnection();
      const tables = ["ios_downloads", "ios_install_sessions", "ios_signing_jobs", "ios_installations"];
      try {
        await connection.query(`CREATE TEMPORARY TABLE ios_installations (id INT PRIMARY KEY)`);
        await connection.query(`CREATE TEMPORARY TABLE ios_signing_jobs (id INT PRIMARY KEY, installation_id INT)`);
        await connection.query(`CREATE TEMPORARY TABLE ios_install_sessions (installation_id INT, expires_at DATETIME(3))`);
        await connection.query(`CREATE TEMPORARY TABLE ios_downloads (job_id INT, expires_at DATETIME(3))`);
        await connection.query(`INSERT INTO ios_installations VALUES (1)`);
        await connection.query(`INSERT INTO ios_signing_jobs VALUES (1, 1)`);
        await connection.query(`INSERT INTO ios_install_sessions VALUES (1, TIMESTAMPADD(HOUR, 6, UTC_TIMESTAMP(3)))`);
        await connection.query(`INSERT INTO ios_downloads VALUES (1, TIMESTAMPADD(MINUTE, 30, UTC_TIMESTAMP(3)))`);
        const sql = await readFile("migrations/008-install-code-expiry.sql", "utf8");
        for (const statement of sql.split(";").map(s => s.trim()).filter(Boolean)) await connection.query(statement);
        const [rows] = await connection.query<RowDataPacket[]>(`SELECT TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(3), i.code_expires_at) AS seconds, s.expires_at = i.code_expires_at AS session_capped, d.expires_at = i.code_expires_at AS link_capped FROM ios_installations i JOIN ios_install_sessions s ON s.installation_id = i.id JOIN ios_signing_jobs j ON j.installation_id = i.id JOIN ios_downloads d ON d.job_id = j.id`);
        assert.ok(rows[0].seconds >= 895 && rows[0].seconds <= 900);
        assert.equal(Number(rows[0].session_capped), 1); assert.equal(Number(rows[0].link_capped), 1);
      } finally {
        for (const table of tables) await connection.query(`DROP TEMPORARY TABLE IF EXISTS ${table}`);
        connection.release();
      }
    });
    await t.test("missing expiry fails closed; issuing a code starts exactly 900 seconds", async () => {
      assert.equal((await request("/api/install/login", { code: rawCode }, "")).status, 401);
      const r = await rotate(); assert.equal(r.status, 200); const body = await r.json(); code = body.code;
      const [rows] = await db.execute<RowDataPacket[]>(`SELECT code_expires_at, TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(3), code_expires_at) AS seconds FROM ios_installations WHERE id = ?`, [installation]);
      assert.ok(rows[0].seconds >= 895 && rows[0].seconds <= 900);
      assert.equal(body.expiresAt, rows[0].code_expires_at.toISOString());
      await login();
    });
    await t.test("logging in and refreshing reuse the original deadline; sessions and links cannot extend it", async () => {
      await db.execute(`UPDATE ios_installations SET code_expires_at = TIMESTAMPADD(SECOND, 120, UTC_TIMESTAMP(3)) WHERE id = ?`, [installation]);
      const age = await login(); assert.ok(age <= 120);
      const first = await (await request("/api/install/status")).json(); assert.equal(first.status, "ready"); assert.ok(first.expiresIn <= 120);
      await login(); const second = await (await request("/api/install/status")).json(); assert.equal(first.expiresAt, second.expiresAt);
      const body = await link(); assert.equal(body.expiresAt, first.expiresAt); assert.ok(body.expiresIn <= 120);
      const [rows] = await db.execute<RowDataPacket[]>(`SELECT s.expires_at > i.code_expires_at AS too_long FROM ios_install_sessions s JOIN ios_installations i ON i.id = s.installation_id WHERE s.token_hash = ?`, [tokenHash(customerCookie.split("=")[1])]); assert.equal(Number(rows[0].too_long), 0);
      assert.equal((await request(manifest, undefined, "")).status, 200);
      const part = await fetch(new URL(manifest.replace("manifest.plist", "Nemo.ipa"), base), { headers: { Range: "bytes=0-3" } }); assert.equal(part.status, 206); assert.equal((await part.arrayBuffer()).byteLength, 4);
    });
    await t.test("expiry blocks the code, an existing session, manifest, IPA HEAD and range requests", async () => {
      await db.execute(`UPDATE ios_installations SET code_expires_at = UTC_TIMESTAMP(3) - INTERVAL 1 SECOND WHERE id = ?`, [installation]);
      assert.equal((await request("/api/install/login", { code }, "")).status, 401);
      assert.equal((await request("/api/install/status")).status, 401);
      for (const action of ["prepare", "link"]) assert.equal((await request(`/api/install/${action}`, {})).status, 401);
      assert.equal((await request(manifest, undefined, "")).status, 404);
      const ipa = new URL(manifest.replace("manifest.plist", "Nemo.ipa"), base);
      assert.equal((await fetch(ipa, { method: "HEAD" })).status, 404);
      assert.equal((await fetch(ipa, { headers: { Range: "bytes=0-3" } })).status, 404);
      const list = await (await request("/api/admin/installations", undefined, adminCookie)).json();
      const item = list.items.find((i: { id: string }) => i.id === installation); assert.equal(item.code_expired, 1); assert.equal(item.state, "active");
      assert.equal(await snapshot(), before);
    });
    await t.test("a new code renews 15 minutes and reuses the signed IPA while invalidating every old session/link", async () => {
      const oldCode = code, oldCookie = customerCookie, oldManifest = manifest;
      const r = await rotate(); assert.equal(r.status, 200); const rotated = await r.json(); code = rotated.code;
      assert.ok(Date.parse(rotated.expiresAt) - Date.now() > 895000);
      assert.equal((await request("/api/install/login", { code: oldCode }, "")).status, 401);
      assert.equal((await request("/api/install/status", undefined, oldCookie)).status, 401);
      assert.equal((await request(oldManifest, undefined, "")).status, 404);
      await login(); await link(); assert.equal((await request(manifest, undefined, "")).status, 200);
      const [jobs] = await db.execute<RowDataPacket[]>(`SELECT status, output_key, attempt FROM ios_signing_jobs WHERE id = ?`, [job]);
      assert.equal(jobs[0].status, "ready"); assert.equal(jobs[0].output_key, output); assert.equal(jobs[0].attempt, 1);
      assert.equal(await snapshot(), before);
    });
    await t.test("sessions and bearer links also stop at an earlier license expiry", async () => {
      await db.execute(`UPDATE licenses SET expires_at = TIMESTAMPADD(SECOND, 60, UTC_TIMESTAMP(3)) WHERE id = ?`, [license.insertId]);
      assert.ok(await login() <= 60); const body = await link(); assert.ok(body.expiresIn <= 60);
      await db.execute(`UPDATE licenses SET expires_at = UTC_TIMESTAMP(3) - INTERVAL 1 SECOND WHERE id = ?`, [license.insertId]);
      assert.equal((await request("/api/install/status")).status, 401); assert.equal((await request(manifest, undefined, "")).status, 404);
    });
  } finally {
    await db.execute(`DELETE FROM ios_installations WHERE id = ?`, [installation]);
    await db.execute(`DELETE FROM devices WHERE license_id = ?`, [license.insertId]);
    await db.execute(`DELETE FROM licenses WHERE id = ?`, [license.insertId]);
    await db.execute(`DELETE FROM customers WHERE id = ?`, [customer.insertId]);
    await db.execute(`DELETE FROM audit_events WHERE admin_id = ?`, [admin.insertId]);
    await db.execute(`DELETE FROM admins WHERE id = ?`, [admin.insertId]);
    await removeObject(output, "ipa"); await db.end();
  }
});
