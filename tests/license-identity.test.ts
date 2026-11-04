import "../scripts/env";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { RowDataPacket, ResultSetHeader } from "mysql2/promise";
import { getDb } from "../src/lib/db";
import { hashPassword, tokenHash } from "../src/lib/password";
import { verifyLease } from "../src/lib/license-crypto";

const base = process.env.TEST_BASE_URL || "http://localhost:3000";
const origin = new URL(base).origin;
const trusted = createPublicKey(readFileSync(process.env.TEST_LICENSE_PUBLIC_KEY_FILE || new URL("../.local/license-keys/public.pem", import.meta.url)));
test("admin assignment and authenticated identity provisioning preserve legacy leases", async (t) => {
  const db = getDb(), prefix = `identity-${randomBytes(8).toString("hex")}`, password = randomBytes(18).toString("hex");
  const [admin] = await db.execute<ResultSetHeader>(`INSERT INTO admins (username, display_name, password_hash) VALUES (?, ?, ?)`, [prefix, prefix, await hashPassword(password)]);
  const [customer] = await db.execute<ResultSetHeader>(`INSERT INTO customers (name) VALUES (?)`, [prefix]);
  const ids: string[] = [], fingerprints: string[] = [], keys: string[] = [];
  let cookie = "", keyId = "", key = "", version = 0, initialExpiry = 0;
  let first = { v: 1, device_id: randomUUID().toUpperCase(), uuid: randomBytes(32).toString("hex") };
  const adminCall = (path: string, data?: unknown, options: { cookie?: string; origin?: string } = {}) => fetch(new URL(`/api/admin/${path}`, base), {
    method: data === undefined ? "GET" : "POST", headers: { cookie: options.cookie ?? cookie, origin: options.origin ?? origin, "Content-Type": "application/json" }, ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const post = (path: string, body: unknown) => fetch(new URL(`/api/v1/${path}`, base), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const identity = () => {
    const d = generateKeyPairSync("ed25519");
    const der = d.publicKey.export({ format: "der", type: "spki" });
    const fp = createHash("sha256").update(der).digest("hex"); fingerprints.push(fp);
    return { ...d, fp, der: der.toString("base64") };
  };
  const device = identity();
  async function activate(d: ReturnType<typeof identity>, purpose: string, keyOrId: string) {
    const nonce = randomBytes(24).toString("base64url");
    const r = await post("challenge", { purpose, publicKey: d.der, clientNonce: nonce, ...(purpose === "activate" ? { key: keyOrId } : { licenseId: keyOrId }), identity: { ...first, uuid: "f".repeat(64) } });
    assert.equal(r.status, 200); const challenge = await r.json();
    const signature = sign(null, Buffer.from(challenge.message), d.privateKey).toString("base64url");
    const result = await post(purpose, { challengeId: challenge.challengeId, signature, identity: { ...first, uuid: "f".repeat(64) } });
    if (!result.ok) return { status: result.status, claims: null, token: "" };
    const lease = await result.json();
    return { status: result.status, claims: verifyLease(lease.token, trusted, d.fp), token: lease.token };
  }
  try {
    const login = await fetch(new URL("/api/auth/login", base), { method: "POST", redirect: "manual", headers: { origin }, body: new URLSearchParams({ username: prefix, password }) });
    assert.equal(login.status, 303); cookie = login.headers.get("set-cookie")!.split(";")[0];
    await t.test("legacy key still activates with no identity claim", async () => {
      const r = await adminCall("licenses", { customerId: String(customer.insertId), durationDays: 30 });
      assert.equal(r.status, 201); const issued = await r.json(); ids.push(issued.id); keys.push(issued.key);
      const result = await activate(identity(), "activate", issued.key);
      assert.equal(result.status, 200); assert.equal(result.claims?.identity, undefined);
    });
    await t.test("an already-installed legacy client verifies unchanged after device inventory is added and edited", async () => {
      const r = await adminCall("licenses", { customerId: String(customer.insertId), durationDays: 30 });
      assert.equal(r.status, 201);
      const issued = await r.json(); ids.push(issued.id); keys.push(issued.key);
      const legacy = identity();
      // Old IPA protocol: IDs remain in the app and are never sent to or
      // requested from the license server. No identity field in either request.
      async function legacyProof(purpose: "activate" | "verify") {
        const nonce = randomBytes(24).toString("base64url");
        const challengeResponse = await post("challenge", { purpose, publicKey: legacy.der, clientNonce: nonce,
          ...(purpose === "activate" ? { key: issued.key } : { licenseId: issued.id }) });
        assert.equal(challengeResponse.status, 200, await challengeResponse.clone().text());
        const challenge = await challengeResponse.json();
        const signature = sign(null, Buffer.from(challenge.message), legacy.privateKey).toString("base64url");
        const response = await post(purpose, { challengeId: challenge.challengeId, signature });
        assert.equal(response.status, 200, await response.clone().text());
        const lease = await response.json(), claims = verifyLease(lease.token, trusted, legacy.fp);
        assert.equal(claims.identity, undefined); assert.equal(claims.nonce, nonce);
        assert.equal(claims.sub, issued.id);
        return claims;
      }
      const originalLease = await legacyProof("activate");
      const snapshot = async () => (await db.execute<RowDataPacket[]>(`SELECT l.id, l.status, l.version, l.activated_at, l.expires_at,
        d.fingerprint, d.public_key FROM licenses l JOIN devices d ON d.license_id = l.id WHERE l.id = ?`, [issued.id]))[0];
      const before = JSON.stringify(await snapshot());
      const inventory = { customerId: String(customer.insertId), licenseId: issued.id, label: "Existing embedded-ID iPad",
        appleUdid: `00008120-${randomBytes(8).toString("hex").toUpperCase()}`, signingLabel: "Legacy signing kit" };
      const created = await adminCall("device-profiles", inventory);
      assert.equal(created.status, 201, await created.clone().text());
      const profile = await created.json();
      for (const label of [inventory.label, "Updated inventory label"]) {
        if (label !== inventory.label) {
          const edited = await fetch(new URL(`/api/admin/device-profiles/${profile.id}`, base), {
            method: "PATCH", headers: { cookie, origin, "Content-Type": "application/json" },
            body: JSON.stringify({ ...inventory, label, version: 1 }),
          });
          assert.equal(edited.status, 200, await edited.clone().text());
        }
        const renewed = await legacyProof("verify");
        assert.equal(renewed.licenseExpiresAt, originalLease.licenseExpiresAt);
        assert.equal(renewed.version, originalLease.version);
        assert.equal(JSON.stringify(await snapshot()), before);
      }
    });
    await t.test("unrelated first activations do not deadlock on absent device rows", async () => {
      const pairs = [];
      for (let n = 0; n < 3; n++) {
        const r = await adminCall("licenses", { customerId: String(customer.insertId), durationDays: 30 });
        assert.equal(r.status, 201); const issued = await r.json(); ids.push(issued.id); keys.push(issued.key);
        pairs.push({ key: issued.key, device: identity() });
      }
      const results = await Promise.all(pairs.map((p) => activate(p.device, "activate", p.key)));
      assert.deepEqual(results.map((r) => r.status), [200, 200, 200]);
      assert.ok(results.every((r) => r.claims?.identity === undefined));
    });
    await t.test("rejects invalid configuration atomically when creating a key", async () => {
      const [before] = await db.execute<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM licenses WHERE customer_id = ?`, [customer.insertId]);
      for (const value of [{ ...first, v: 2 }, { ...first, device_id: first.device_id.toLowerCase() }, { ...first, uuid: "x".repeat(64) }, { device_id: first.device_id }, []]) {
        assert.equal((await adminCall("licenses", { customerId: String(customer.insertId), identity: value })).status, 400);
      }
      const [rows] = await db.execute<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM licenses WHERE customer_id = ?`, [customer.insertId]);
      assert.equal(Number(rows[0].n), Number(before[0].n));
    });
    await t.test("admin can issue a key and its pair together, IDs do not appear in list or audit", async () => {
      const r = await adminCall("licenses", { customerId: String(customer.insertId), durationDays: 30, identity: first });
      assert.equal(r.status, 201); const issued = await r.json(); keyId = issued.id; key = issued.key; ids.push(keyId); keys.push(key);
      const list = await adminCall("licenses"); const text = await list.text();
      assert.ok(!text.includes(first.device_id)); assert.ok(!text.includes(first.uuid));
      const config = await adminCall(`licenses/${keyId}/identity`); const data = await config.json();
      assert.deepEqual(data.identity, first); version = data.version;
      const [audits] = await db.execute<RowDataPacket[]>(`SELECT details FROM audit_events WHERE admin_id = ?`, [admin.insertId]);
      assert.ok(!JSON.stringify(audits).includes(first.uuid));
    });
    await t.test("identity read/write requires admin, same-origin mutation and current version", async () => {
      assert.equal((await adminCall(`licenses/${keyId}/identity`, undefined, { cookie: "" })).status, 401);
      assert.equal((await adminCall(`licenses/${keyId}/identity`, { version, identity: first }, { origin: "https://other.invalid" })).status, 403);
      assert.equal((await adminCall(`licenses/${keyId}/identity`, { version: version + 1, identity: first })).status, 409);
    });
    await t.test("proof of key and device returns server-assigned IDs in signed JWT only", async () => {
      const result = await activate(device, "activate", key);
      assert.equal(result.status, 200); assert.deepEqual(result.claims?.identity, first);
      assert.equal(result.claims?.device, device.fp);
      const [rows] = await db.execute<RowDataPacket[]>(`SELECT * FROM licenses WHERE id = ?`, [keyId]);
      initialExpiry = rows[0].expires_at.getTime(); version = rows[0].version;
      // Optional fixture for the Objective-C interoperability check; test key only.
      if (process.env.NATIVE_CONTRACT_FIXTURE) {
        const file = process.env.NATIVE_CONTRACT_FIXTURE;
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        const pub = trusted.export({ format: "der", type: "spki" }).subarray(-32);
        writeFileSync(file, JSON.stringify({ token: result.token, publicKey: pub.toString("base64"), device: device.fp, identity: first, now: result.claims!.iat,
          kid: JSON.parse(Buffer.from(result.token.split(".")[0], "base64url").toString()).kid }), { mode: 0o600 });
      }
      const wrong = await activate(identity(), "activate", key); assert.equal(wrong.status, 403);
    });
    await t.test("changing a bound assignment needs explicit confirmation; refresh preserves expiry", async () => {
      first = { v: 1, device_id: randomUUID().toUpperCase(), uuid: randomBytes(32).toString("hex") };
      assert.equal((await adminCall(`licenses/${keyId}/identity`, { version, identity: first })).status, 409);
      assert.equal((await adminCall(`licenses/${keyId}/identity`, { version, identity: first, confirmBoundDevice: true })).status, 200);
      assert.equal((await adminCall(`licenses/${keyId}/identity`, { version, identity: first, confirmBoundDevice: true })).status, 409);
      const result = await activate(device, "verify", keyId);
      assert.deepEqual(result.claims?.identity, first);
      const [rows] = await db.execute<RowDataPacket[]>(`SELECT * FROM licenses WHERE id = ?`, [keyId]);
      assert.equal(rows[0].expires_at.getTime(), initialExpiry);
      version = rows[0].version;
    });
    await t.test("revoked keys cannot receive or update identity", async () => {
      assert.equal((await adminCall(`licenses/${keyId}/revoke`, { version })).status, 200);
      assert.equal((await adminCall(`licenses/${keyId}/identity`, { version: version + 1, identity: first, confirmBoundDevice: true })).status, 409);
      assert.equal((await activate(device, "verify", keyId)).status, 403);
    });
  } finally {
    await db.execute(`DELETE FROM customer_device_profiles WHERE customer_id = ?`, [customer.insertId]);
    for (const license of ids) {
      await db.execute(`DELETE FROM devices WHERE license_id = ?`, [license]);
      await db.execute(`DELETE FROM licenses WHERE id = ?`, [license]);
      await db.execute(`DELETE FROM audit_events WHERE target_id = ? AND admin_id IS NULL AND action = 'device.activated'`, [license]);
    }
    for (const fp of fingerprints) {
      await db.execute(`DELETE FROM license_challenges WHERE fingerprint = ?`, [fp]);
      await db.execute(`DELETE FROM license_rate_limits WHERE bucket = ?`, [tokenHash(`device:${fp}`)]);
    }
    for (const k of keys) await db.execute(`DELETE FROM license_rate_limits WHERE bucket = ?`, [tokenHash(`license:activate:${tokenHash(k)}`)]);
    await db.execute(`DELETE FROM customers WHERE id = ?`, [customer.insertId]);
    await db.execute(`DELETE FROM audit_events WHERE admin_id = ?`, [admin.insertId]);
    await db.execute(`DELETE FROM admins WHERE id = ?`, [admin.insertId]);
    await db.execute(`DELETE FROM login_limits WHERE bucket = ?`, [tokenHash(prefix)]);
    await db.end();
  }
});
