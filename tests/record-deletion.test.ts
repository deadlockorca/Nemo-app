import "../scripts/env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { getDb } from "../src/lib/db";
import { hashPassword, tokenHash } from "../src/lib/password";

const base = process.env.TEST_BASE_URL || "http://localhost:3117", origin = new URL(base).origin;
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(base).hostname)) throw new Error("Local tests only");

test("delete customers and device profiles without deleting linked licenses or another customer's records", async t => {
  const db = getDb(), prefix = `delete-${randomBytes(6).toString("hex")}`, password = randomBytes(24).toString("hex");
  const [admin] = await db.execute<ResultSetHeader>(`INSERT INTO admins (username, display_name, password_hash) VALUES (?, ?, ?)`, [prefix, prefix, await hashPassword(password)]);
  const customers: string[] = [], licenses: string[] = [], profiles: string[] = [];
  let cookie = "";
  const call = (endpoint: string, method = "DELETE", body: unknown = { version: 1 }, requestOrigin = origin) => fetch(`${base}/api/admin/${endpoint}`, {
    method, headers: { cookie, origin: requestOrigin, "content-type": "application/json" }, body: JSON.stringify(body), redirect: "manual",
  });
  const udid = `00008120-${randomBytes(8).toString("hex").toUpperCase()}`;
  try {
    for (let n = 0; n < 2; n++) {
      const [customer] = await db.execute<ResultSetHeader>(`INSERT INTO customers (name) VALUES (?)`, [`${prefix}-${n}`]); customers.push(String(customer.insertId));
      const [license] = await db.execute<ResultSetHeader>(`INSERT INTO licenses (customer_id, key_hash, key_hint, status, activated_at, expires_at) VALUES (?, ?, ?, 'active', UTC_TIMESTAMP(3), TIMESTAMPADD(DAY, 30, UTC_TIMESTAMP(3)))`, [customer.insertId, tokenHash(randomUUID()), prefix.slice(-8)]); licenses.push(String(license.insertId));
      await db.execute(`INSERT INTO devices (license_id, public_key, fingerprint, name) VALUES (?, 'test', ?, ?)`, [license.insertId, tokenHash(`${prefix}-${n}`), prefix]);
      await db.execute(`INSERT INTO license_identities (license_id, device_id, registration_uuid) VALUES (?, ?, ?)`, [license.insertId, randomUUID().toUpperCase(), randomBytes(32).toString("hex")]);
      const installation = randomBytes(16).toString("hex"), deviceUdid = n ? `00008120-${randomBytes(8).toString("hex").toUpperCase()}` : udid;
      await db.execute(`INSERT INTO ios_installations (id, license_id, label, apple_udid, code_hash, source_key, secrets_key, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, '{}')`, [installation, license.insertId, prefix, deviceUdid, tokenHash(randomUUID()), randomBytes(16).toString("hex"), randomBytes(16).toString("hex")]);
      const [profile] = await db.execute<ResultSetHeader>(`INSERT INTO customer_device_profiles (customer_id, license_id, label, apple_udid, installation_id, version) VALUES (?, ?, ?, ?, ?, 2)`, [customer.insertId, license.insertId, prefix, deviceUdid, installation]); profiles.push(String(profile.insertId));
    }
    const snapshot = async (n: number) => JSON.stringify((await db.execute<RowDataPacket[]>(`SELECT l.*, d.public_key, d.fingerprint, d.last_seen_at, i.device_id, i.registration_uuid FROM licenses l JOIN devices d ON d.license_id = l.id JOIN license_identities i ON i.license_id = l.id WHERE l.id = ?`, [licenses[n]]))[0]);
    const original = await snapshot(0), other = await snapshot(1);
    await t.test("deletion requires admin, same origin, valid IDs and a revision", async () => {
      assert.equal((await call(`customers/${customers[0]}`)).status, 401);
      assert.equal((await call(`device-profiles/${profiles[0]}`)).status, 401);
      const login = await fetch(`${base}/api/auth/login`, { method: "POST", redirect: "manual", headers: { origin }, body: new URLSearchParams({ username: prefix, password }) });
      assert.equal(login.status, 303); cookie = login.headers.get("set-cookie")!.split(";")[0];
      for (const endpoint of [`customers/${customers[0]}`, `device-profiles/${profiles[0]}`]) {
        assert.equal((await call(endpoint, "DELETE", { version: 2 }, "https://evil.invalid")).status, 403);
        assert.equal((await call(endpoint, "DELETE", {})).status, 400);
        assert.equal((await call(endpoint, "DELETE", { version: 999 })).status, 409);
      }
      assert.equal((await call("customers/invalid")).status, 400);
      assert.equal((await call("device-profiles/invalid")).status, 400);
    });
    await t.test("linked customers and profiles cannot be deleted; old keys and IDs stay unchanged", async () => {
      const customer = await call(`customers/${customers[0]}`); assert.equal(customer.status, 409); assert.match((await customer.json()).error, /còn key/);
      const profile = await call(`device-profiles/${profiles[0]}`, "DELETE", { version: 2 }); assert.equal(profile.status, 409); assert.match((await profile.json()).error, /còn gắn key/);
      assert.equal(await snapshot(0), original); assert.equal(await snapshot(1), other);
    });
    await t.test("after explicit key deletion, remaining device profile must be removed first", async () => {
      assert.equal((await call(`licenses/${licenses[0]}/delete`, "POST")).status, 200);
      const [rows] = await db.execute<RowDataPacket[]>(`SELECT license_id, installation_id FROM customer_device_profiles WHERE id = ?`, [profiles[0]]);
      assert.equal(rows[0].license_id, null); assert.equal(rows[0].installation_id, null);
      const blocked = await call(`customers/${customers[0]}`); assert.equal(blocked.status, 409); assert.match((await blocked.json()).error, /còn hồ sơ/);
      assert.equal((await call(`device-profiles/${profiles[0]}`)).status, 409);
      const deletes = await Promise.all([call(`device-profiles/${profiles[0]}`, "DELETE", { version: 2 }), call(`device-profiles/${profiles[0]}`, "DELETE", { version: 2 })]);
      assert.deepEqual(deletes.map(r => r.status).sort(), [200, 404]);
    });
    await t.test("customer removal checks current revision, is auditable, and keeps other customers", async () => {
      assert.equal((await call(`customers/${customers[0]}`, "PATCH", { name: `${prefix}-edited`, version: 1 })).status, 200);
      assert.equal((await call(`customers/${customers[0]}`)).status, 409);
      const deletes = await Promise.all([call(`customers/${customers[0]}`, "DELETE", { version: 2 }), call(`customers/${customers[0]}`, "DELETE", { version: 2 })]);
      assert.deepEqual(deletes.map(r => r.status).sort(), [200, 404]);
      const [events] = await db.execute<RowDataPacket[]>(`SELECT action FROM audit_events WHERE admin_id = ? AND action IN ('customer.deleted', 'device_profile.deleted')`, [admin.insertId]);
      assert.deepEqual(events.map(e => e.action).sort(), ["customer.deleted", "device_profile.deleted"]);
      assert.equal(await snapshot(1), other);
      const list = await fetch(`${base}/api/admin/customers?q=${prefix}`, { headers: { cookie } });
      const listed = await list.json(); assert.ok(!listed.items.some((c: { id: string }) => c.id === customers[0])); assert.ok(listed.items.some((c: { id: string }) => c.id === customers[1]));
    });
    await t.test("the deleted UDID is available for a new test profile", async () => {
      const created = await call("device-profiles", "POST", { customerId: customers[1], label: prefix, appleUdid: udid });
      assert.equal(created.status, 201, await created.clone().text());
    });
  } finally {
    for (const customer of customers) {
      await db.execute(`DELETE FROM customer_device_profiles WHERE customer_id = ?`, [customer]);
      await db.execute(`DELETE d FROM devices d JOIN licenses l ON l.id = d.license_id WHERE l.customer_id = ?`, [customer]);
      await db.execute(`DELETE FROM licenses WHERE customer_id = ?`, [customer]);
      await db.execute(`DELETE FROM customers WHERE id = ?`, [customer]);
    }
    await db.execute(`DELETE FROM audit_events WHERE admin_id = ?`, [admin.insertId]);
    await db.execute(`DELETE FROM admins WHERE id = ?`, [admin.insertId]); await db.end();
  }
});
