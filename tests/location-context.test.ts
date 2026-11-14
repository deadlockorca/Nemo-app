import "../scripts/env";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import type { RowDataPacket, ResultSetHeader } from "mysql2/promise";
import { getDb } from "../src/lib/db";
import { hashPassword } from "../src/lib/password";
import { locationProofMessage, mergeLocationCenters, parseCenters, parseEmployeeUsername } from "../src/lib/location-contract";
import catalog from "../data/location-catalogs/12436899.json";

const base = process.env.TEST_BASE_URL || "http://localhost:3000";
const origin = new URL(base).origin;
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(base).hostname)) throw new Error("Local tests only.");

test("location validation preserves employee IDs and rejects invalid centers", () => {
  assert.equal(parseEmployeeUsername(" 0012436899 "), "0012436899");
  assert.equal(parseEmployeeUsername("NVabc"), "NVabc");
  for (const value of [123, "", "x\ny", "x".repeat(121)]) assert.throws(() => parseEmployeeUsername(value));
  const center = { hospitalId: "102175", latitude: 21.0337507, longitude: 105.7788244, radiusMeters: 120 };
  assert.deepEqual(parseCenters([center]), [center]);
  for (const rows of [[center, center], [{ ...center, latitude: 91 }], [{ ...center, radiusMeters: 121 }], [{ ...center, longitude: null }]]) assert.throws(() => parseCenters(rows));
});

test("catalog imports add missing IDs while preserving saved centers and rejecting invalid drafts", () => {
  const original = parseCenters(catalog.centers);
  assert.equal(original.length, 15); assert.equal(catalog.missingCoordinates, 7);
  const edited = { ...original[0], latitude: 20, radiusMeters: 80 };
  const merged = mergeLocationCenters([edited], original);
  assert.equal(merged.length, 15); assert.deepEqual(merged[0], edited);
  assert.deepEqual(mergeLocationCenters(merged, original), merged);
  assert.throws(() => mergeLocationCenters([{ ...edited, hospitalId: "" }], original));
  const many = Array.from({ length: 100 }, (_, i) => ({ ...edited, hospitalId: String(900000 + i) }));
  assert.throws(() => mergeLocationCenters(many, original));
});

test("admin-managed location API isolates legacy licenses and checks current account/device/config on retries", async t => {
  const db = getDb();
  const prefix = `location-${randomBytes(8).toString("hex")}`, password = randomBytes(24).toString("hex");
  let pilotId = "", customerId = "", adminId = "", otherId = "", cookie = "", token = "", otherToken = "";
  const device = generateKeyPairSync("ed25519"), other = generateKeyPairSync("ed25519");
  const der = device.publicKey.export({ format: "der", type: "spki" });
  const fingerprint = createHash("sha256").update(der).digest("hex");
  const center = { hospitalId: "102175", latitude: 21.0337507, longitude: 105.7788244, radiusMeters: 120 };
  const context: { requestId: string; sessionId: string; action: string; hospitalId: string; employeeUsername: string } = { requestId: randomUUID(), sessionId: randomUUID(), action: "start", hospitalId: center.hospitalId, employeeUsername: "12436899" };
  const admin = (path: string, method = "GET", body?: unknown, headers = {}) => fetch(new URL(`/api/admin/${path}`, base), {
    method, headers: { origin, cookie, "Content-Type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const api = (path: string, body: unknown) => fetch(new URL(`/api/v1/${path}`, base), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  async function activate(key: string, pair: typeof device, licenseId?: string) {
    const c = await api("challenge", { purpose: licenseId ? "verify" : "activate", publicKey: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
      clientNonce: randomBytes(24).toString("base64url"), ...(licenseId ? { licenseId } : { key }) });
    assert.equal(c.status, 200); const proof = await c.json();
    const r = await api(licenseId ? "verify" : "activate", { challengeId: proof.challengeId, signature: sign(null, Buffer.from(proof.message), pair.privateKey).toString("base64url") });
    assert.equal(r.status, 200); return r.json();
  }
  const call = (body = context, options: { token?: string; timestamp?: string; signBody?: string; pair?: typeof device; origin?: string } = {}) => {
    const raw = JSON.stringify(body), timestamp = options.timestamp || String(Math.floor(Date.now() / 1000));
    const signature = sign(null, Buffer.from(locationProofMessage(timestamp, options.signBody ?? raw)), (options.pair || device).privateKey).toString("base64url");
    return fetch(new URL("/api/v1/location-context", base), { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${options.token ?? token}`,
      "X-Nemo-Timestamp": timestamp, "X-Nemo-Signature": signature, ...(options.origin ? { origin: options.origin } : {}) }, body: raw });
  };
  async function expectCode(response: Response, status: number, code: string) { assert.equal(response.status, status, await response.clone().text()); assert.equal((await response.json()).code, code); }
  async function savePolicy(enabled: boolean, centers = [center]) {
    const r = await admin(`licenses/${pilotId}/location`); assert.equal(r.status, 200); const p = await r.json();
    const saved = await admin(`licenses/${pilotId}/location`, "POST", { version: p.version, enabled, centers });
    assert.equal(saved.status, 200, await saved.clone().text());
  }
  const snapshot = async () => JSON.stringify((await db.execute<RowDataPacket[]>(`SELECT l.status, l.version, l.activated_at, l.expires_at, d.fingerprint, d.public_key
    FROM licenses l JOIN devices d ON d.license_id = l.id WHERE l.id = ?`, [pilotId]))[0]);
  try {
    const [a] = await db.execute<ResultSetHeader>(`INSERT INTO admins (username, display_name, password_hash) VALUES (?, ?, ?)`, [prefix, prefix, await hashPassword(password)]); adminId = String(a.insertId);
    const login = await fetch(new URL("/api/auth/login", base), { method: "POST", redirect: "manual", headers: { origin }, body: new URLSearchParams({ username: prefix, password }) });
    assert.equal(login.status, 303); cookie = login.headers.get("set-cookie")!.split(";")[0];
    const created = await admin("customers", "POST", { name: prefix, nemoUsername: context.employeeUsername }); assert.equal(created.status, 201); customerId = (await created.json()).id;
    const createdLicense = await admin("licenses", "POST", { customerId, durationDays: 30 });
    assert.equal(createdLicense.status, 201); const pilot = await createdLicense.json(); pilotId = pilot.id;
    token = (await activate(pilot.key, device)).token;
    const legacy = await admin("licenses", "POST", { customerId, durationDays: 30 }); assert.equal(legacy.status, 201); const issued = await legacy.json(); otherId = issued.id;
    const legacyLease = await activate(issued.key, other); otherToken = legacyLease.token;
    const oldClaims = JSON.parse(Buffer.from(otherToken.split(".")[1], "base64url").toString());
    assert.equal(oldClaims.identity, undefined); assert.equal(oldClaims.employeeUsername, undefined); assert.equal(oldClaims.location, undefined);
    const before = await snapshot();

    await t.test("configuration requires admin, same origin, username, valid centers and fresh revision", async () => {
      assert.equal((await admin(`licenses/${pilotId}/location`, "GET", undefined, { cookie: "" })).status, 401);
      assert.equal((await admin(`licenses/${pilotId}/location`, "POST", {}, { origin: "https://example.invalid" })).status, 403);
      const initial = await (await admin(`licenses/${pilotId}/location`)).json(); assert.equal(initial.enabled, false); assert.equal(initial.version, 0);
      assert.equal(initial.catalog.centers.length, 15); assert.deepEqual(initial.centers, []);
      const [unmodified] = await db.execute<RowDataPacket[]>(`SELECT license_id FROM license_location_policies WHERE license_id = ?`, [pilotId]);
      assert.equal(unmodified.length, 0, "Reading suggestions must not enable or write a policy");
      await db.execute(`UPDATE customers SET nemo_username = 'OTHER' WHERE id = ?`, [customerId]);
      assert.equal((await (await admin(`licenses/${pilotId}/location`)).json()).catalog, null);
      await db.execute(`UPDATE customers SET nemo_username = ? WHERE id = ?`, [context.employeeUsername, customerId]);
      await expectCode(await call(), 403, "FEATURE_DISABLED");
      assert.equal((await admin(`licenses/${pilotId}/location`, "POST", { version: 0, enabled: true, centers: [] })).status, 400);
      await savePolicy(true);
      const saved = await (await admin(`licenses/${pilotId}/location`)).json();
      assert.deepEqual(saved.centers, [center], "Catalog must not overwrite saved centers");
      assert.equal((await admin(`licenses/${pilotId}/location`, "POST", { version: 0, enabled: true, centers: [center] })).status, 409);
      assert.equal(await snapshot(), before);
    });
    let response: Record<string, unknown>;
    await t.test("only an enabled license with matching account/hospital may resolve a center", async () => {
      await expectCode(await call(context, { token: "bad" }), 401, "UNAUTHORIZED");
      await expectCode(await call(context, { token: otherToken, pair: other }), 403, "FEATURE_DISABLED");
      await expectCode(await call({ ...context, employeeUsername: "OTHER" }), 403, "ACCOUNT_MISMATCH");
      await expectCode(await call({ ...context, hospitalId: "999999" }), 404, "CENTER_NOT_FOUND");
      const r = await call(); assert.equal(r.status, 200, await r.clone().text()); response = await r.json();
      assert.deepEqual(response.center, { latitude: center.latitude, longitude: center.longitude });
      assert.equal(response.requestId, context.requestId); assert.equal(response.sessionId, context.sessionId); assert.equal(response.radiusMeters, 120);
      assert.equal(r.headers.get("cache-control"), "no-store");
      assert.ok(!JSON.stringify(response).includes(context.employeeUsername));
    });
    await t.test("device proof binds exact body; stale signatures and other origins fail", async () => {
      await expectCode(await call(context, { pair: other }), 401, "INVALID_PROOF");
      await expectCode(await call(context, { signBody: JSON.stringify({ ...context, action: "end" }) }), 401, "INVALID_PROOF");
      await expectCode(await call(context, { timestamp: String(Math.floor(Date.now() / 1000) - 120) }), 401, "INVALID_PROOF");
      await expectCode(await call(context, { origin: "https://example.invalid" }), 403, "INVALID_ORIGIN");
    });
    await t.test("strict request schema, content type and body limits apply only to the new endpoint", async () => {
      await expectCode(await call({ ...context, requestId: "invalid" }), 400, "INVALID_REQUEST");
      const extra = { ...context, access_token: "must-not-be-forwarded" };
      await expectCode(await call(extra), 400, "INVALID_REQUEST");
      const url = new URL("/api/v1/location-context", base);
      assert.equal((await fetch(url, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" })).status, 415);
      assert.equal((await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "x".repeat(4097) })).status, 413);
    });
    await t.test("retry is stable, races converge, request ID cannot change context or outlive expiry", async () => {
      assert.deepEqual(await (await call()).json(), response);
      await expectCode(await call({ ...context, action: "end" }), 409, "REQUEST_CONTEXT_MISMATCH");
      await expectCode(await call({ ...context, sessionId: randomUUID() }), 409, "REQUEST_CONTEXT_MISMATCH");
      const next = { ...context, requestId: randomUUID(), action: "end" };
      const results = await Promise.all([call(next), call(next)]); for (const r of results) assert.equal(r.status, 200);
      assert.deepEqual(await results[0].json(), await results[1].json());
      await db.execute(`UPDATE location_context_requests SET expires_at = UTC_TIMESTAMP(3) - INTERVAL 1 SECOND WHERE license_id = ? AND request_id = ?`, [pilotId, context.requestId]);
      await expectCode(await call(), 409, "REQUEST_EXPIRED");
    });
    await t.test("turning policy off immediately blocks cached requests and leaves legacy verify unchanged", async () => {
      const fresh = { ...context, requestId: randomUUID() }; assert.equal((await call(fresh)).status, 200);
      await savePolicy(false); await expectCode(await call(fresh), 403, "FEATURE_DISABLED");
      assert.equal(await snapshot(), before);
      const verified = await activate(issued.key, other, otherId);
      const claims = JSON.parse(Buffer.from(verified.token.split(".")[1], "base64url").toString());
      assert.equal(claims.version, oldClaims.version); assert.equal(claims.licenseExpiresAt, oldClaims.licenseExpiresAt);
      assert.equal(claims.identity, undefined); assert.equal(claims.employeeUsername, undefined);
      await savePolicy(true);
    });
    await t.test("admin may enable a second license without env changes; policies and centers stay independent", async () => {
      const fresh = { ...context, requestId: randomUUID() }; assert.equal((await call(fresh)).status, 200);
      await savePolicy(true, [{ ...center, radiusMeters: 119 }]);
      await expectCode(await call(fresh), 409, "REQUEST_CONTEXT_MISMATCH");
      const secondCenter = { ...center, latitude: 20.5, radiusMeters: 100 };
      const r = await admin(`licenses/${otherId}/location`, "POST", { enabled: true, version: 0, centers: [secondCenter] }); assert.equal(r.status, 200);
      const secondContext = { ...context, requestId: randomUUID() };
      const otherResponse = await call(secondContext, { token: otherToken, pair: other });
      assert.equal(otherResponse.status, 200); const otherBody = await otherResponse.json();
      assert.deepEqual(otherBody.center, { latitude: secondCenter.latitude, longitude: secondCenter.longitude });
      assert.equal(otherBody.radiusMeters, 100);
      await savePolicy(false);
      await expectCode(await call({ ...context, requestId: randomUUID() }), 403, "FEATURE_DISABLED");
      assert.equal((await call(secondContext, { token: otherToken, pair: other })).status, 200);
      await savePolicy(true);
    });
    await t.test("new actions are rate limited while retries keep their existing result", async () => {
      const fresh = { ...context, requestId: randomUUID() }; assert.equal((await call(fresh)).status, 200);
      let limited = false;
      for (let i = 0; i < 31; i++) {
        const r = await call({ ...context, requestId: randomUUID() });
        if (r.status === 429) { assert.equal(r.headers.get("retry-after"), "60"); limited = true; break; }
        assert.equal(r.status, 200);
      }
      assert.equal(limited, true); assert.equal((await call(fresh)).status, 200);
      await db.execute(`DELETE FROM location_context_requests WHERE license_id = ?`, [pilotId]);
    });
    await t.test("changing username, revoking license or releasing device blocks previously accepted requests", async () => {
      const fresh = { ...context, requestId: randomUUID() }; assert.equal((await call(fresh)).status, 200);
      await db.execute(`UPDATE customers SET nemo_username = 'OTHER' WHERE id = ?`, [customerId]);
      await expectCode(await call(fresh), 403, "ACCOUNT_MISMATCH");
      await db.execute(`UPDATE customers SET nemo_username = ? WHERE id = ?`, [context.employeeUsername, customerId]);
      await db.execute(`UPDATE licenses SET status = 'revoked' WHERE id = ?`, [pilotId]);
      await expectCode(await call(fresh), 403, "INVALID_LICENSE");
      await db.execute(`UPDATE licenses SET status = 'active' WHERE id = ?`, [pilotId]);
      await db.execute(`DELETE FROM devices WHERE license_id = ?`, [pilotId]);
      await expectCode(await call(fresh), 403, "INVALID_DEVICE");
    });
    await t.test("legacy admin updates preserve username if the new field is omitted", async () => {
      const [rows] = await db.execute<RowDataPacket[]>(`SELECT version FROM customers WHERE id = ?`, [customerId]);
      assert.equal((await admin(`customers/${customerId}`, "PATCH", { name: prefix, contact: "", notes: "", version: rows[0].version })).status, 200);
      const [updated] = await db.execute<RowDataPacket[]>(`SELECT nemo_username FROM customers WHERE id = ?`, [customerId]); assert.equal(updated[0].nemo_username, context.employeeUsername);
    });
  } finally {
    if (customerId) {
      await db.execute(`DELETE FROM license_challenges WHERE fingerprint IN (?, ?)`, [fingerprint, createHash("sha256").update(other.publicKey.export({ format: "der", type: "spki" })).digest("hex")]);
      await db.execute(`DELETE FROM devices WHERE license_id IN (?, ?)`, [pilotId || "0", otherId || "0"]);
      await db.execute(`DELETE FROM licenses WHERE customer_id = ?`, [customerId]);
      await db.execute(`DELETE FROM customers WHERE id = ?`, [customerId]);
    }
    if (adminId) { await db.execute(`DELETE FROM audit_events WHERE admin_id = ?`, [adminId]); await db.execute(`DELETE FROM admin_sessions WHERE admin_id = ?`, [adminId]); await db.execute(`DELETE FROM admins WHERE id = ?`, [adminId]); }
    await db.end();
  }
});
