import "../scripts/env";
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { getDb } from "../src/lib/db";
import { hashPassword, tokenHash } from "../src/lib/password";

const base = process.env.TEST_BASE_URL || process.env.APP_URL || "http://localhost:3000";
const origin = new URL(base).origin;
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(base).hostname)) throw new Error("Local integration tests only.");

test("admin customer, license and device workflows with real MySQL", async (t) => {
  const db = getDb();
  const prefix = `management-${randomBytes(8).toString("hex")}`;
  const password = randomBytes(24).toString("hex");
  const [admin] = await db.execute<ResultSetHeader>(`INSERT INTO admins (username, display_name, password_hash) VALUES (?, ?, ?)`, [prefix, prefix, await hashPassword(password)]);
  let cookie = "";
  const customerIds: string[] = [];
  const licenseIds: string[] = [];
  let customerId = "", licenseId = "", issuedKey = "";
  const call = (path: string, method = "GET", data?: unknown, headers = {}) => fetch(new URL(`/api/admin/${path}`, base), {
    method, redirect: "manual", headers: { cookie, origin, "Content-Type": "application/json", ...headers },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  async function licenseRow() {
    const [rows] = await db.execute<RowDataPacket[]>(`SELECT * FROM licenses WHERE id = ?`, [licenseId]);
    return rows[0];
  }
  try {
    await t.test("every management API and page requires an admin session", async () => {
      for (const section of ["customers", "licenses", "devices", "activity"]) {
        assert.equal((await call(section)).status, 401);
        const response = await fetch(new URL(`/admin/${section}`, base), { redirect: "manual" });
        assert.equal(response.status, 307);
      }
      assert.equal((await call("customers", "POST", { name: "unauthorized" })).status, 401);
      assert.equal((await call("licenses/1/restore", "POST", { version: 1 })).status, 401);
      assert.equal((await call("licenses/1/delete", "POST", { version: 1 })).status, 401);
    });
    const login = await fetch(new URL("/api/auth/login", base), { method: "POST", redirect: "manual", headers: { origin }, body: new URLSearchParams({ username: prefix, password }) });
    assert.equal(login.status, 303);
    cookie = login.headers.get("set-cookie")!.split(";")[0];
    await t.test("cross-origin, malformed input and excessive payloads are rejected", async () => {
      assert.equal((await call("customers", "POST", { name: "blocked" }, { origin: "https://untrusted.example" })).status, 403);
      assert.equal((await call("customers", "POST", { name: "" })).status, 400);
      assert.equal((await call("customers", "POST", { name: "x".repeat(121) })).status, 400);
      assert.equal((await call("customers", "POST", { name: "oversized", notes: "a".repeat(17000) })).status, 413);
    });
    await t.test("create, edit and search a customer; stale edits are rejected", async () => {
      const create = await call("customers", "POST", { name: prefix, contact: "contact@example.test", notes: "Test only" });
      assert.equal(create.status, 201);
      customerId = (await create.json()).id; customerIds.push(customerId);
      assert.equal((await call(`customers/${customerId}`, "PATCH", { name: prefix + " edited", contact: "", notes: "updated", version: 1 })).status, 200);
      assert.equal((await call(`customers/${customerId}`, "PATCH", { name: "stale", version: 1 })).status, 409);
      const list = await (await call(`customers?q=${prefix}`)).json();
      assert.equal(list.total, 1);
      assert.equal(list.items[0].version, 2);
      assert.equal(list.items[0].name, prefix + " edited");
      assert.equal((await call("customers/invalid", "PATCH", { name: "test", version: 1 })).status, 400);
    });
    await t.test("create immediately active 30-day key; keep only hash and never leak full key in lists/history", async () => {
      assert.equal((await call("licenses", "POST", { customerId, durationDays: 0 })).status, 400);
      assert.equal((await call("licenses", "POST", { customerId: "18446744073709551615", durationDays: 30 })).status, 404);
      const response = await call("licenses", "POST", { customerId, durationDays: 30 });
      assert.equal(response.status, 201);
      const created = await response.json();
      licenseId = created.id; licenseIds.push(licenseId); issuedKey = created.key;
      assert.match(issuedKey, /^NEMO-(?:[A-F0-9]{8}-){4}[A-F0-9]{8}$/);
      const row = await licenseRow();
      assert.equal(row.key_hash, tokenHash(issuedKey));
      assert.equal(row.status, "active"); assert.equal(row.duration_days, 30);
      assert.ok(Math.abs(Date.now() - row.activated_at.getTime()) < 5000);
      assert.equal(row.expires_at.getTime() - row.activated_at.getTime(), 30 * 86400000);
      const list = await call(`licenses?q=${prefix}`);
      assert.match(list.headers.get("cache-control") || "", /no-store/);
      const content = await list.text();
      assert.ok(!content.includes(issuedKey)); assert.ok(!content.includes(row.key_hash));
      const history = await (await call(`activity?q=${prefix}`)).text();
      assert.ok(!history.includes(issuedKey)); assert.ok(!history.includes(row.key_hash));
    });
    await t.test("legacy pending extension changes duration without starting the clock", async () => {
      await db.execute(`UPDATE licenses SET status = 'pending', activated_at = NULL, expires_at = NULL WHERE id = ?`, [licenseId]);
      assert.equal((await call(`licenses/${licenseId}/extend`, "POST", { days: 30, version: 1 })).status, 200);
      const row = await licenseRow();
      assert.equal(row.duration_days, 60); assert.equal(row.activated_at, null); assert.equal(row.expires_at, null);
      assert.equal((await call(`licenses/${licenseId}/extend`, "POST", { days: 30, version: 1 })).status, 409);
    });
    await t.test("concurrent extension with the same version applies exactly once", async () => {
      const responses = await Promise.all([call(`licenses/${licenseId}/extend`, "POST", { days: 30, version: 2 }), call(`licenses/${licenseId}/extend`, "POST", { days: 30, version: 2 })]);
      assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
      assert.equal((await licenseRow()).duration_days, 90);
    });
    await t.test("active extension adds to remaining time; expired extension starts now", async () => {
      // Activation is simulated only in test fixtures; no public activation API exists yet.
      await db.execute(`UPDATE licenses SET status = 'active', activated_at = UTC_TIMESTAMP(3), expires_at = UTC_TIMESTAMP(3) + INTERVAL 10 DAY WHERE id = ?`, [licenseId]);
      const before = await licenseRow();
      assert.equal((await call(`licenses/${licenseId}/extend`, "POST", { days: 30, version: before.version })).status, 200);
      let row = await licenseRow();
      assert.equal(row.expires_at.getTime() - before.expires_at.getTime(), 30 * 86400000);
      await db.execute(`UPDATE licenses SET expires_at = UTC_TIMESTAMP(3) - INTERVAL 10 DAY WHERE id = ?`, [licenseId]);
      const start = Date.now();
      assert.equal((await call(`licenses/${licenseId}/extend`, "POST", { days: 30, version: row.version })).status, 200);
      row = await licenseRow();
      assert.ok(Math.abs(row.expires_at.getTime() - start - 30 * 86400000) < 5000);
      const active = await (await call(`licenses?q=${prefix}&status=active`)).json();
      const expired = await (await call(`licenses?q=${prefix}&status=expired`)).json();
      assert.equal(active.total, 1); assert.equal(expired.total, 0);
    });
    await t.test("device release preserves expiry and permits only one detach", async () => {
      const fingerprint = tokenHash(prefix);
      const [device] = await db.execute<ResultSetHeader>(`INSERT INTO devices (license_id, public_key, fingerprint, name) VALUES (?, ?, ?, ?)`, [licenseId, "temporary-public-key", fingerprint, prefix]);
      const row = await licenseRow();
      const list = await (await call(`devices?q=${prefix}`)).json();
      assert.equal(list.total, 1); assert.ok(!JSON.stringify(list).includes("temporary-public-key"));
      assert.equal((await call(`devices/${device.insertId}/release`, "POST", { version: 999 })).status, 409);
      assert.equal((await call(`devices/${device.insertId}/release`, "POST", { version: row.version })).status, 200);
      const after = await licenseRow();
      assert.equal(after.expires_at.getTime(), row.expires_at.getTime());
      assert.equal(after.version, row.version + 1);
      assert.equal((await call(`devices/${device.insertId}/release`, "POST", { version: after.version })).status, 404);
    });
    await t.test("revocation blocks renewal and remains auditable", async () => {
      const row = await licenseRow();
      assert.equal((await call(`licenses/${licenseId}/revoke`, "POST", { version: row.version })).status, 200);
      const revoked = await licenseRow();
      assert.equal(revoked.status, "revoked");
      assert.equal((await call(`licenses/${licenseId}/extend`, "POST", { version: revoked.version, days: 30 })).status, 409);
      const list = await (await call(`licenses?q=${prefix}&status=revoked`)).json(); assert.equal(list.total, 1);
      const [events] = await db.execute<RowDataPacket[]>(`SELECT action, details FROM audit_events WHERE admin_id = ? ORDER BY id`, [admin.insertId]);
      assert.ok(events.some((e) => e.action === "license.revoked"));
      assert.ok(events.some((e) => e.action === "device.released"));
      assert.ok(!JSON.stringify(events).includes(issuedKey));
    });
    await t.test("restoration preserves active expiry and rejects stale or duplicate restores", async () => {
      const before = await licenseRow();
      assert.equal((await call(`licenses/${licenseId}/restore`, "POST", { version: before.version }, { origin: "https://untrusted.example" })).status, 403);
      const responses = await Promise.all([
        call(`licenses/${licenseId}/restore`, "POST", { version: before.version }),
        call(`licenses/${licenseId}/restore`, "POST", { version: before.version }),
      ]);
      assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
      const after = await licenseRow();
      assert.equal(after.status, "active"); assert.equal(after.version, before.version + 1);
      assert.equal(after.expires_at.getTime(), before.expires_at.getTime());
      assert.equal(after.activated_at.getTime(), before.activated_at.getTime());
      assert.equal((await call(`licenses/${licenseId}/restore`, "POST", { version: after.version })).status, 409);
      const [events] = await db.execute<RowDataPacket[]>(`SELECT action FROM audit_events WHERE admin_id = ? AND action = 'license.restored'`, [admin.insertId]);
      assert.equal(events.length, 1);
    });
    await t.test("restoring expired keys does not grant extra time", async () => {
      await db.execute(`UPDATE licenses SET expires_at = UTC_TIMESTAMP(3) - INTERVAL 1 DAY WHERE id = ?`, [licenseId]);
      let row = await licenseRow();
      assert.equal((await call(`licenses/${licenseId}/revoke`, "POST", { version: row.version })).status, 200);
      row = await licenseRow();
      assert.equal((await call(`licenses/${licenseId}/restore`, "POST", { version: row.version })).status, 200);
      const after = await licenseRow();
      assert.equal(after.expires_at.getTime(), row.expires_at.getTime());
      const list = await (await call(`licenses?q=${prefix}&status=expired`)).json();
      assert.equal(list.total, 1);
      assert.equal((await call(`licenses/${licenseId}/extend`, "POST", { version: after.version, days: 30 })).status, 200);
    });
    await t.test("restoring a legacy never-activated key returns to pending without starting expiry", async () => {
      const response = await call("licenses", "POST", { customerId, durationDays: 30 });
      assert.equal(response.status, 201);
      const created = await response.json(); licenseIds.push(created.id);
      await db.execute(`UPDATE licenses SET status = 'pending', activated_at = NULL, expires_at = NULL WHERE id = ?`, [created.id]);
      assert.equal((await call(`licenses/${created.id}/revoke`, "POST", { version: 1 })).status, 200);
      assert.equal((await call(`licenses/${created.id}/restore`, "POST", { version: 2 })).status, 200);
      const [rows] = await db.execute<RowDataPacket[]>(`SELECT * FROM licenses WHERE id = ?`, [created.id]);
      assert.equal(rows[0].status, "pending"); assert.equal(rows[0].duration_days, 30);
      assert.equal(rows[0].activated_at, null); assert.equal(rows[0].expires_at, null);
    });
    await t.test("deleting keys removes bindings and list entries but preserves audit history", async () => {
      for (const status of ["pending", "active", "expired", "revoked"]) {
        const createdResponse = await call("licenses", "POST", { customerId, durationDays: 30 });
        assert.equal(createdResponse.status, 201);
        const created = await createdResponse.json(); licenseIds.push(created.id);
        if (status === "pending") {
          await db.execute(`UPDATE licenses SET status = 'pending', activated_at = NULL, expires_at = NULL WHERE id = ?`, [created.id]);
        } else {
          await db.execute(`UPDATE licenses SET status = ?, activated_at = UTC_TIMESTAMP(3), expires_at = TIMESTAMPADD(DAY, ?, UTC_TIMESTAMP(3)) WHERE id = ?`, [status === "revoked" ? "revoked" : "active", status === "expired" ? -1 : 30, created.id]);
          await db.execute(`INSERT INTO devices (license_id, public_key, fingerprint, name) VALUES (?, ?, ?, ?)`, [created.id, "temporary-public-key", tokenHash(prefix + status), prefix]);
        }
        const before = await (await call(`licenses?q=${prefix}`)).json();
        assert.equal((await call(`licenses/${created.id}/delete`, "POST", { version: 1 }, { origin: "https://untrusted.example" })).status, 403);
        assert.equal((await call(`licenses/${created.id}/delete`, "POST", { version: 999 })).status, 409);
        const responses = await Promise.all([
          call(`licenses/${created.id}/delete`, "POST", { version: 1 }),
          call(`licenses/${created.id}/delete`, "POST", { version: 1 }),
        ]);
        assert.deepEqual(responses.map((r) => r.status).sort(), [200, 404]);
        assert.equal((await call(`licenses/${created.id}/restore`, "POST", { version: 1 })).status, 404);
        const after = await (await call(`licenses?q=${prefix}`)).json();
        assert.equal(after.total, before.total - 1);
        assert.ok(!after.items.some((item: {id: string}) => item.id === created.id));
        const [devices] = await db.execute<RowDataPacket[]>(`SELECT id FROM devices WHERE license_id = ?`, [created.id]);
        assert.equal(devices.length, 0);
        const [events] = await db.execute<RowDataPacket[]>(`SELECT action, details FROM audit_events WHERE admin_id = ? AND target_id = ?`, [admin.insertId, created.id]);
        assert.ok(events.some((e) => e.action === "license.created"));
        assert.equal(events.filter((e) => e.action === "license.deleted").length, 1);
        assert.ok(!JSON.stringify(events).includes(created.key));
      }
    });
    await t.test("lists paginate, clamp page numbers and handle search as data", async () => {
      for (let i = 0; i < 25; i++) {
        const [customer] = await db.execute<ResultSetHeader>(`INSERT INTO customers (name) VALUES (?)`, [prefix + " page " + i]);
        customerIds.push(String(customer.insertId));
      }
      const first = await (await call(`customers?q=${prefix}`)).json();
      const second = await (await call(`customers?q=${prefix}&page=99`)).json();
      assert.equal(first.total, 26); assert.equal(first.items.length, 25);
      assert.equal(second.items.length, 1); assert.equal(second.page, 2);
      const injection = await (await call(`customers?q=${encodeURIComponent("' OR 1=1 --")}`)).json();
      assert.equal(injection.total, 0);
    });
  } finally {
    for (const keyId of licenseIds) { await db.execute(`DELETE FROM devices WHERE license_id = ?`, [keyId]); await db.execute(`DELETE FROM licenses WHERE id = ?`, [keyId]); }
    for (const customer of customerIds) await db.execute(`DELETE FROM customers WHERE id = ?`, [customer]);
    await db.execute(`DELETE FROM audit_events WHERE admin_id = ?`, [admin.insertId]);
    await db.execute(`DELETE FROM admins WHERE id = ?`, [admin.insertId]);
    await db.execute(`DELETE FROM login_limits WHERE bucket = ?`, [tokenHash(prefix)]);
    await db.end();
  }
});
