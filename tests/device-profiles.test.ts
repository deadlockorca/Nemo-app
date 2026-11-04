import "../scripts/env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { getDb } from "../src/lib/db";
import { hashPassword, tokenHash } from "../src/lib/password";
import { attachVerifiedInstallation } from "../src/lib/device-profiles";
import type { PackageMetadata } from "../src/lib/installation-types";

const base = process.env.TEST_BASE_URL || "http://localhost:3117", origin = new URL(base).origin;
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(base).hostname)) throw new Error("Local tests only");
test("device records preserve existing keys and stay separate from activation and signing", async t => {
  const db = getDb(), prefix = `profile-${randomBytes(6).toString("hex")}`, password = randomBytes(24).toString("hex");
  const udid = `00008120-${randomBytes(8).toString("hex").toUpperCase()}`;
  const [admin] = await db.execute<ResultSetHeader>(`INSERT INTO admins (username, display_name, password_hash) VALUES (?, ?, ?)`, [prefix, prefix, await hashPassword(password)]);
  const ids: string[] = [], licenseIds: string[] = [];
  for (let i = 0; i < 2; i++) {
    const [c] = await db.execute<ResultSetHeader>(`INSERT INTO customers (name) VALUES (?)`, [`${prefix}-${i}`]); ids.push(String(c.insertId));
    const [l] = await db.execute<ResultSetHeader>(`INSERT INTO licenses (customer_id, key_hash, key_hint, status, activated_at, expires_at) VALUES (?, ?, ?, 'active', UTC_TIMESTAMP(3), TIMESTAMPADD(DAY, 30, UTC_TIMESTAMP(3)))`, [c.insertId, tokenHash(randomUUID()), `${prefix}-${i}`.slice(-16)]); licenseIds.push(String(l.insertId));
  }
  let cookie = "", profileId = "";
  const call = (suffix = "", method = "GET", body?: unknown, requestOrigin = origin) => fetch(`${base}/api/admin/device-profiles${suffix}`, {
    method, redirect: "manual", headers: { cookie, origin: requestOrigin, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const input = { customerId: ids[0], licenseId: licenseIds[0], label: "iPad kiểm thử", model: "iPad15,8", appleUdid: udid.toLowerCase(), signingLabel: prefix, certificateExpiresAt: "2027-12-01T00:00:00.000Z", profileExpiresAt: "2027-11-01T00:00:00.000Z", notes: "Ghi chú chỉ cho hồ sơ" };
  const licenseSnapshot = async () => (await db.execute<RowDataPacket[]>(`SELECT id, customer_id, status, activated_at, expires_at, duration_days, version, key_hash FROM licenses WHERE id IN (?, ?) ORDER BY id`, licenseIds))[0];
  const before = JSON.stringify(await licenseSnapshot());
  try {
    assert.equal((await call()).status, 401);
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", redirect: "manual", headers: { origin }, body: new URLSearchParams({ username: prefix, password }) });
    assert.equal(login.status, 303); cookie = login.headers.get("set-cookie")!.split(";")[0];
    await t.test("admin, same-origin and input validation", async () => {
      assert.equal((await call("", "POST", input, "https://evil.invalid")).status, 403);
      for (const appleUdid of [randomUUID(), randomBytes(32).toString("hex"), "bad-udid"]) assert.equal((await call("", "POST", { ...input, appleUdid })).status, 400);
      assert.equal((await call("", "POST", { ...input, profileExpiresAt: "2027-02-31T00:00:00Z" })).status, 400);
      assert.equal((await call("", "POST", { ...input, licenseId: licenseIds[1] })).status, 409);
    });
    await t.test("create before activation; search UDID, label and signing label", async () => {
      const r = await call("", "POST", input); assert.equal(r.status, 201, await r.clone().text()); profileId = (await r.json()).id;
      for (const q of [udid, "iPad kiểm thử", prefix]) {
        const r = await call(`?q=${encodeURIComponent(q)}`); assert.equal(r.status, 200, await r.clone().text()); assert.match(r.headers.get("cache-control")!, /no-store/);
        const result = await r.json(); assert.ok(result.items.some((p: { id: string }) => p.id === profileId));
      }
      const [rows] = await db.execute<RowDataPacket[]>(`SELECT * FROM customer_device_profiles WHERE id = ?`, [profileId]);
      assert.equal(rows[0].apple_udid, udid);
      const listed = await (await call(`?q=${udid}`)).json(); assert.equal(listed.items[0].fingerprint, null);
      assert.equal((await call("", "POST", { ...input, licenseId: null })).status, 409);
      assert.equal(JSON.stringify(await licenseSnapshot()), before);
    });
    await t.test("stale updates fail; a key cannot be attached to another device", async () => {
      assert.equal((await call(`/${profileId}`, "PATCH", { ...input, version: 1, label: "Tên mới" })).status, 200);
      assert.equal((await call(`/${profileId}`, "PATCH", { ...input, version: 1 })).status, 409);
      assert.equal((await call("", "POST", { ...input, appleUdid: `00008120-${randomBytes(8).toString("hex")}` })).status, 409);
      assert.equal(JSON.stringify(await licenseSnapshot()), before);
    });
    await t.test("activation is displayed without conflating fingerprint and UDID", async () => {
      const fingerprint = tokenHash(prefix);
      await db.execute(`INSERT INTO devices (license_id, public_key, fingerprint, name) VALUES (?, 'test-public-key', ?, 'iPad')`, [licenseIds[0], fingerprint]);
      const listed = await (await call(`?q=${udid}`)).json(); assert.equal(listed.items[0].fingerprint, fingerprint); assert.equal(listed.items[0].apple_udid, udid);
      const oldList = await fetch(`${base}/api/admin/devices?q=${udid}`, { headers: { cookie } }); assert.equal((await oldList.json()).items[0].device_label, "Tên mới");
      await db.execute(`DELETE FROM devices WHERE license_id = ?`, [licenseIds[0]]);
      assert.equal((await (await call(`?q=${udid}`)).json()).total, 1);
    });
    await t.test("verified installations update metadata and preserve labels, notes and old key state", async () => {
      const installId = randomBytes(16).toString("hex");
      const metadata = { certificateExpiresAt: "2027-12-03T04:00:00Z", profileExpiresAt: "2027-11-02T04:00:00Z" } as PackageMetadata;
      await db.execute(`INSERT INTO ios_installations (id, license_id, label, apple_udid, code_hash, source_key, secrets_key, metadata) VALUES (?, ?, 'test', ?, ?, ?, ?, ?)`, [installId, licenseIds[0], udid, tokenHash(randomUUID()), randomBytes(16).toString("hex"), randomBytes(16).toString("hex"), JSON.stringify(metadata)]);
      const connection = await db.getConnection();
      try {
        await connection.beginTransaction();
        await attachVerifiedInstallation(connection, { id: String(admin.insertId), username: prefix, name: prefix }, { customerId: ids[0], licenseId: licenseIds[0], udid, label: "Generated installation name", signingLabel: "HNF-test", installationId: installId, metadata });
        await connection.commit();
      } finally { connection.release(); }
      const listed = await (await call(`?q=${udid}`)).json(), row = listed.items[0];
      assert.equal(row.label, "Tên mới"); assert.equal(row.notes, input.notes); assert.equal(row.signing_label, "HNF-test"); assert.equal(row.installation_id, installId);
      assert.equal((await call(`/${profileId}`, "PATCH", { ...input, appleUdid: `00008120-${randomBytes(8).toString("hex")}`, version: row.version })).status, 409);
      assert.equal(JSON.stringify(await licenseSnapshot()), before);
      await db.execute(`DELETE FROM ios_installations WHERE id = ?`, [installId]);
    });
    await t.test("a profile can exist without a key and existing customer/license lists expose its label", async () => {
      const r = await call("", "POST", { ...input, appleUdid: `00008120-${randomBytes(8).toString("hex")}`, licenseId: null }); assert.equal(r.status, 201);
      const listed = await fetch(`${base}/api/admin/customers?q=${prefix}`, { headers: { cookie } }); assert.equal(Number((await listed.json()).items.find((c: { id: string }) => c.id === ids[0]).device_profile_count), 2);
      assert.equal((await (await call(`?q=${encodeURIComponent("' OR 1=1 --")}`)).json()).total, 0);
    });
    await t.test("profile inspection rejects a forged file", async () => {
      const form = new FormData(); form.set("profile", new Blob(["not an Apple-signed profile"]), "bad.mobileprovision");
      const r = await fetch(`${base}/api/admin/device-profiles/inspect`, { method: "POST", headers: { cookie, origin }, body: form }); assert.equal(r.status, 400);
      if (process.env.PROFILE_TEST_FILE) {
        const good = new FormData(); good.set("profile", new Blob([await readFile(process.env.PROFILE_TEST_FILE)]), "cert.mobileprovision");
        const ok = await fetch(`${base}/api/admin/device-profiles/inspect`, { method: "POST", headers: { cookie, origin }, body: good }); assert.equal(ok.status, 200, await ok.clone().text());
        assert.ok((await ok.json()).udids.includes(process.env.PROFILE_TEST_UDID));
      }
    });
  } finally {
    await db.execute(`DELETE FROM customer_device_profiles WHERE customer_id IN (?, ?)`, ids);
    for (const licenseId of licenseIds) { await db.execute(`DELETE FROM devices WHERE license_id = ?`, [licenseId]); await db.execute(`DELETE FROM ios_installations WHERE license_id = ?`, [licenseId]); await db.execute(`DELETE FROM licenses WHERE id = ?`, [licenseId]); }
    for (const customerId of ids) await db.execute(`DELETE FROM customers WHERE id = ?`, [customerId]);
    await db.execute(`DELETE FROM audit_events WHERE admin_id = ?`, [admin.insertId]);
    await db.execute(`DELETE FROM admins WHERE id = ?`, [admin.insertId]); await db.end();
  }
});
