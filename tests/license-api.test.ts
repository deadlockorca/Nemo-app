import "../scripts/env";
import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKeyPairSync, randomBytes, sign, createPublicKey, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { getDb } from "../src/lib/db";
import { tokenHash, hashPassword } from "../src/lib/password";
import { verifyLease, type LeaseClaims } from "../src/lib/license-crypto";

const base = process.env.TEST_BASE_URL || process.env.APP_URL || "http://localhost:3000";
const origin = new URL(base).origin;
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(base).hostname)) throw new Error("Local integration tests only.");
function identity() {
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  return { ...keys, publicKeyText: publicKey, fingerprint: createHash("sha256").update(keys.publicKey.export({ format: "der", type: "spki" })).digest("hex") };
}
type Device = ReturnType<typeof identity>;
const post = (path: string, data: unknown) => fetch(new URL(`/api/v1/${path}`, base), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });

// Check the signed bytes against a trusted local public key, not response-provided key material.
const trustedPublicKey = createPublicKey(readFileSync(new URL("../.local/license-keys/public.pem", import.meta.url)));

test("signed device activation and lease lifecycle", async (t) => {
  const db = getDb();
  const prefix = `license-${randomBytes(8).toString("hex")}`;
  const [customer] = await db.execute<ResultSetHeader>(`INSERT INTO customers (name) VALUES (?)`, [prefix]);
  const licenseIds: string[] = [], refs: string[] = [];
  const devices = [identity(), identity(), identity(), identity(), identity()];
  let cookie = "", adminId = 0;
  async function newKey(days = 30) {
    const key = `NEMO-${randomBytes(20).toString("hex").toUpperCase().match(/.{8}/g)!.join("-")}`;
    const [insert] = await db.execute<ResultSetHeader>(`INSERT INTO licenses (customer_id, key_hash, key_hint, duration_days) VALUES (?, ?, ?, ?)`, [customer.insertId, tokenHash(key), key.slice(-8), days]);
    const id = String(insert.insertId); licenseIds.push(id); refs.push(tokenHash(key)); return { key, id };
  }
  async function requestChallenge(purpose: string, device: Device, keyOrId: string) {
    const clientNonce = randomBytes(24).toString("base64url");
    const response = await post("challenge", { purpose, clientNonce, publicKey: device.publicKeyText, ...(purpose === "activate" ? { key: keyOrId } : { licenseId: keyOrId }), deviceName: prefix });
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json() as { challengeId: string; message: string; expiresAt: string; serverTime: string };
    assert.equal(JSON.parse(result.message).nonce, clientNonce);
    return result;
  }
  function signed(challenge: { challengeId: string; message: string }, device: Device) {
    return { challengeId: challenge.challengeId, signature: sign(null, Buffer.from(challenge.message, "utf8"), device.privateKey).toString("base64url") };
  }
  async function row(id: string) { const [rows] = await db.execute<RowDataPacket[]>(`SELECT * FROM licenses WHERE id = ?`, [id]); return rows[0]; }
  const adminCall = (path: string, data: unknown) => fetch(new URL(`/api/admin/${path}`, base), { method: "POST", headers: { cookie, origin, "Content-Type": "application/json" }, body: JSON.stringify(data) });
  const key = await newKey();
  let firstLease: { token: string; device: string; licenseExpiresAt: string };
  let firstClaims: LeaseClaims;
  try {
    const password = randomBytes(20).toString("hex");
    const [admin] = await db.execute<ResultSetHeader>(`INSERT INTO admins (username, display_name, password_hash) VALUES (?, ?, ?)`, [prefix, prefix, await hashPassword(password)]);
    adminId = admin.insertId;
    const login = await fetch(new URL("/api/auth/login", base), { method: "POST", redirect: "manual", headers: { origin }, body: new URLSearchParams({ username: prefix, password }) });
    assert.equal(login.status, 303); cookie = login.headers.get("set-cookie")!.split(";")[0];
    await t.test("admin-issued keys count down immediately and first device binding preserves expiry", async () => {
      const response = await adminCall("licenses", { customerId: String(customer.insertId), durationDays: 30 });
      assert.equal(response.status, 201);
      const issued = await response.json(); licenseIds.push(issued.id); refs.push(tokenHash(issued.key));
      const created = await row(issued.id);
      assert.equal(created.status, "active");
      assert.equal(created.expires_at.getTime() - created.activated_at.getTime(), 30 * 86400000);
      const [unbound] = await db.execute<RowDataPacket[]>(`SELECT id FROM devices WHERE license_id = ?`, [issued.id]);
      assert.equal(unbound.length, 0);
      // Simulate two days between issuing the key and the first device entry.
      await db.execute(`UPDATE licenses SET activated_at = TIMESTAMPADD(DAY, -2, activated_at), expires_at = TIMESTAMPADD(DAY, -2, expires_at) WHERE id = ?`, [issued.id]);
      const before = await row(issued.id);
      const device = identity();
      const c = await requestChallenge("activate", device, issued.key);
      const activated = await post("activate", signed(c, device));
      assert.equal(activated.status, 200);
      const result = await activated.json();
      const claims = verifyLease(result.token, trustedPublicKey, device.fingerprint);
      assert.equal(claims.licenseExpiresAt, Math.floor(before.expires_at.getTime() / 1000));
      const after = await row(issued.id);
      assert.equal(after.activated_at.getTime(), before.activated_at.getTime());
      assert.equal(after.expires_at.getTime(), before.expires_at.getTime());
      const repeat = await requestChallenge("activate", device, issued.key);
      assert.equal((await post("activate", signed(repeat, device))).status, 200);
      assert.equal((await row(issued.id)).expires_at.getTime(), before.expires_at.getTime());
      await db.execute(`UPDATE licenses SET expires_at = UTC_TIMESTAMP(3) - INTERVAL 1 SECOND WHERE id = ?`, [issued.id]);
      const [bound] = await db.execute<RowDataPacket[]>(`SELECT id FROM devices WHERE license_id = ?`, [issued.id]);
      assert.equal((await adminCall(`devices/${bound[0].id}/release`, { version: after.version })).status, 200);
      // The proof must be signed by the matching identity, even when the key expired.
      const other = identity();
      const expiredProof = await requestChallenge("activate", other, issued.key);
      const rejected = await post("activate", signed(expiredProof, other));
      assert.equal(rejected.status, 403); assert.equal((await rejected.json()).code, "license_expired");
    });
    await t.test("reject malformed keys, non-Ed25519 public keys and oversized payloads", async () => {
      assert.equal((await post("challenge", { purpose: "activate", publicKey: devices[0].publicKeyText, key: "bad" })).status, 400);
      const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      assert.equal((await post("challenge", { purpose: "activate", publicKey: ec.publicKey.export({ type: "spki", format: "der" }).toString("base64"), key: key.key })).status, 400);
      assert.equal((await post("challenge", { purpose: "activate", key: "a".repeat(5000) })).status, 413);
    });
    await t.test("challenge binds purpose and a device signature; expiry and forgery fail", async () => {
      const c = await requestChallenge("activate", devices[0], key.key);
      assert.ok(!c.message.includes(key.key));
      assert.equal((await post("activate", signed(c, devices[1]))).status, 401);
      assert.equal((await post("verify", signed(c, devices[0]))).status, 409);
      await db.execute(`UPDATE license_challenges SET expires_at = UTC_TIMESTAMP(3) - INTERVAL 1 SECOND WHERE id = ?`, [c.challengeId]);
      assert.equal((await post("activate", signed(c, devices[0]))).status, 409);
      assert.equal((await row(key.id)).status, "pending");
    });
    await t.test("legacy pending activation starts 30 days once and returns a verifiable 24-hour lease", async () => {
      const c = await requestChallenge("activate", devices[0], key.key);
      const response = await post("activate", signed(c, devices[0]));
      assert.equal(response.status, 200, await response.clone().text());
      assert.match(response.headers.get("cache-control") || "", /no-store/);
      firstLease = await response.json();
      firstClaims = verifyLease(firstLease.token, trustedPublicKey, firstLease.device);
      assert.equal(firstClaims.nonce, JSON.parse(c.message).nonce);
      assert.equal(firstClaims.sub, key.id); assert.equal(firstClaims.exp - firstClaims.iat, 86400);
      const current = await row(key.id);
      assert.equal(current.status, "active"); assert.equal(current.version, 2);
      assert.equal(current.expires_at.getTime() - current.activated_at.getTime(), 30 * 86400000);
      assert.equal((await post("activate", signed(c, devices[0]))).status, 409);
    });
    await t.test("tampered, expired, wrong-device and wrong-server-key leases fail local verification", () => {
      const parts = firstLease.token.split(".");
      parts[1] = Buffer.from(JSON.stringify({ ...firstClaims, exp: firstClaims.exp + 100000 })).toString("base64url");
      assert.throws(() => verifyLease(parts.join("."), trustedPublicKey, firstLease.device));
      assert.throws(() => verifyLease(firstLease.token, trustedPublicKey, "f".repeat(64)));
      assert.throws(() => verifyLease(firstLease.token, devices[1].publicKey, firstLease.device));
      assert.throws(() => verifyLease(firstLease.token, trustedPublicKey, firstLease.device, firstClaims.exp));
    });
    await t.test("repeat activation on the same device keeps original expiry; a second device is blocked", async () => {
      const expiry = (await row(key.id)).expires_at.getTime();
      let c = await requestChallenge("activate", devices[0], key.key);
      assert.equal((await post("activate", signed(c, devices[0]))).status, 200);
      assert.equal((await row(key.id)).expires_at.getTime(), expiry);
      c = await requestChallenge("activate", devices[1], key.key);
      const denied = await post("activate", signed(c, devices[1]));
      assert.equal(denied.status, 403); assert.equal((await denied.json()).code, "device_mismatch");
    });
    await t.test("verify refreshes lease and last-seen time without altering key expiry", async () => {
      const current = await row(key.id);
      const c = await requestChallenge("verify", devices[0], key.id);
      const response = await post("verify", signed(c, devices[0]));
      assert.equal(response.status, 200);
      const result = await response.json();
      const claims = verifyLease(result.token, trustedPublicKey, firstLease.device);
      assert.equal(claims.licenseExpiresAt, Math.floor(current.expires_at.getTime() / 1000));
      const [bound] = await db.execute<RowDataPacket[]>(`SELECT last_seen_at FROM devices WHERE license_id = ?`, [key.id]);
      assert.ok(bound[0].last_seen_at instanceof Date);
    });
    await t.test("lease never extends beyond license expiry; expired license cannot refresh", async () => {
      await db.execute(`UPDATE licenses SET expires_at = UTC_TIMESTAMP(3) + INTERVAL 20 MINUTE WHERE id = ?`, [key.id]);
      let c = await requestChallenge("verify", devices[0], key.id);
      let response = await post("verify", signed(c, devices[0]));
      assert.equal(response.status, 200);
      const result = await response.json();
      const claims = verifyLease(result.token, trustedPublicKey, firstLease.device);
      assert.equal(claims.exp, claims.licenseExpiresAt); assert.ok(claims.exp - claims.iat <= 1200);
      await db.execute(`UPDATE licenses SET expires_at = UTC_TIMESTAMP(3) - INTERVAL 1 SECOND WHERE id = ?`, [key.id]);
      c = await requestChallenge("verify", devices[0], key.id);
      response = await post("verify", signed(c, devices[0]));
      assert.equal(response.status, 403); assert.equal((await response.json()).code, "license_expired");
      const before = await row(key.id);
      assert.equal((await adminCall(`licenses/${key.id}/extend`, { version: before.version, days: 30 })).status, 200);
      c = await requestChallenge("verify", devices[0], key.id);
      assert.equal((await post("verify", signed(c, devices[0]))).status, 200);
    });
    await t.test("admin release blocks old online device and allows a new device with unchanged expiry", async () => {
      const before = await row(key.id);
      const [bound] = await db.execute<RowDataPacket[]>(`SELECT id FROM devices WHERE license_id = ?`, [key.id]);
      assert.equal((await adminCall(`devices/${bound[0].id}/release`, { version: before.version })).status, 200);
      let c = await requestChallenge("verify", devices[0], key.id);
      assert.equal((await post("verify", signed(c, devices[0]))).status, 403);
      c = await requestChallenge("activate", devices[1], key.key);
      const response = await post("activate", signed(c, devices[1]));
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.notEqual(result.device, firstLease.device);
      const after = await row(key.id);
      assert.equal(after.expires_at.getTime(), before.expires_at.getTime());
      assert.equal(after.activated_at.getTime(), before.activated_at.getTime());
      c = await requestChallenge("activate", devices[0], key.key);
      assert.equal((await post("activate", signed(c, devices[0]))).status, 403);
    });
    await t.test("admin revocation blocks both activation and verification", async () => {
      const before = await row(key.id);
      assert.equal((await adminCall(`licenses/${key.id}/revoke`, { version: before.version })).status, 200);
      for (const purpose of ["activate", "verify"]) {
        const c = await requestChallenge(purpose, devices[1], purpose === "activate" ? key.key : key.id);
        const response = await post(purpose, signed(c, devices[1]));
        assert.equal(response.status, 403); assert.equal((await response.json()).code, "license_revoked");
      }
    });
    await t.test("restored key verifies on its existing device without reactivation", async () => {
      const before = await row(key.id);
      const [boundBefore] = await db.execute<RowDataPacket[]>(`SELECT id, fingerprint FROM devices WHERE license_id = ?`, [key.id]);
      assert.equal((await adminCall(`licenses/${key.id}/restore`, { version: before.version })).status, 200);
      const c = await requestChallenge("verify", devices[1], key.id);
      const response = await post("verify", signed(c, devices[1]));
      assert.equal(response.status, 200);
      const claims = verifyLease((await response.json()).token, trustedPublicKey, devices[1].fingerprint);
      assert.equal(claims.sub, key.id);
      const after = await row(key.id);
      assert.equal(after.expires_at.getTime(), before.expires_at.getTime());
      assert.equal(after.activated_at.getTime(), before.activated_at.getTime());
      const [boundAfter] = await db.execute<RowDataPacket[]>(`SELECT id, fingerprint FROM devices WHERE license_id = ?`, [key.id]);
      assert.deepEqual(boundAfter, boundBefore);
      const wrong = await requestChallenge("verify", devices[0], key.id);
      assert.equal((await post("verify", signed(wrong, devices[0]))).status, 403);
    });
    await t.test("deletion rejects outstanding proofs and frees device for another key", async () => {
      const before = await row(key.id);
      const outstanding = await requestChallenge("verify", devices[1], key.id);
      assert.equal((await adminCall(`licenses/${key.id}/delete`, { version: before.version })).status, 200);
      const rejected = await post("verify", signed(outstanding, devices[1]));
      assert.equal(rejected.status, 403); assert.equal((await rejected.json()).code, "invalid_license");
      const activation = await requestChallenge("activate", devices[1], key.key);
      assert.equal((await post("activate", signed(activation, devices[1]))).status, 403);
      const replacement = await newKey();
      const fresh = await requestChallenge("activate", devices[1], replacement.key);
      assert.equal((await post("activate", signed(fresh, devices[1]))).status, 200);
    });
    await t.test("simultaneous devices race for one key; only one can bind", async () => {
      const raced = await newKey();
      const c1 = await requestChallenge("activate", devices[2], raced.key);
      const c2 = await requestChallenge("activate", devices[3], raced.key);
      const responses = await Promise.all([post("activate", signed(c1, devices[2])), post("activate", signed(c2, devices[3]))]);
      assert.deepEqual(responses.map((r) => r.status).sort(), [200, 403]);
      const [rows] = await db.execute<RowDataPacket[]>(`SELECT COUNT(*) AS total FROM devices WHERE license_id = ?`, [raced.id]);
      assert.equal(Number(rows[0].total), 1);
    });
    await t.test("the same accepted proof cannot be replayed concurrently", async () => {
      const once = await newKey();
      const c = await requestChallenge("activate", devices[4], once.key);
      const proof = signed(c, devices[4]);
      const responses = await Promise.all([post("activate", proof), post("activate", proof)]);
      assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
    });
    await t.test("one device cannot bind multiple keys and unknown keys do not activate", async () => {
      const other = await newKey();
      let c = await requestChallenge("activate", devices[4], other.key);
      assert.equal((await post("activate", signed(c, devices[4]))).status, 409);
      const fakeKey = `NEMO-${"DEADBEEF-".repeat(4)}DEADBEEF`;
      c = await requestChallenge("activate", devices[4], fakeKey);
      const response = await post("activate", signed(c, devices[4]));
      assert.equal(response.status, 403); assert.equal((await response.json()).code, "invalid_license");
      refs.push(tokenHash(fakeKey));
    });
    await t.test("database rate limits return 429 with retry hint", async () => {
      const { createHash } = await import("node:crypto");
      const fingerprint = createHash("sha256").update(devices[0].publicKey.export({ type: "spki", format: "der" })).digest("hex");
      const bucket = tokenHash(`device:${fingerprint}`);
      await db.execute(`UPDATE license_rate_limits SET attempts = 60, window_start = UTC_TIMESTAMP(3) WHERE bucket = ?`, [bucket]);
      const response = await post("challenge", { purpose: "activate", publicKey: devices[0].publicKeyText, key: key.key });
      assert.equal(response.status, 429); assert.equal(response.headers.get("retry-after"), "60");
    });
  } finally {
    for (const device of devices) {
      await db.execute(`DELETE FROM license_challenges WHERE public_key = ?`, [device.publicKeyText]);
      const { createHash } = await import("node:crypto");
      const fp = createHash("sha256").update(device.publicKey.export({ type: "spki", format: "der" })).digest("hex");
      await db.execute(`DELETE FROM license_rate_limits WHERE bucket = ?`, [tokenHash(`device:${fp}`)]);
    }
    for (const id of licenseIds) {
      await db.execute(`DELETE FROM devices WHERE license_id = ?`, [id]);
      await db.execute(`DELETE FROM audit_events WHERE target_id = ? AND action IN ('device.activated', 'license.extended', 'license.revoked', 'license.restored', 'license.deleted', 'device.released')`, [id]);
      await db.execute(`DELETE FROM licenses WHERE id = ?`, [id]);
      await db.execute(`DELETE FROM license_rate_limits WHERE bucket = ?`, [tokenHash(`license:verify:${id}`)]);
    }
    for (const ref of refs) await db.execute(`DELETE FROM license_rate_limits WHERE bucket = ?`, [tokenHash(`license:activate:${ref}`)]);
    await db.execute(`DELETE FROM customers WHERE id = ?`, [customer.insertId]);
    if (adminId) { await db.execute(`DELETE FROM audit_events WHERE admin_id = ?`, [adminId]); await db.execute(`DELETE FROM admins WHERE id = ?`, [adminId]); }
    await db.execute(`DELETE FROM login_limits WHERE bucket = ?`, [tokenHash(prefix)]);
    await db.end();
  }
});
