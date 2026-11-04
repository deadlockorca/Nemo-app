import "server-only";
import { randomBytes, verify } from "node:crypto";
import type { RowDataPacket } from "mysql2/promise";
import { getDb } from "./db";
import { tokenHash } from "./password";
import { LEASE_SECONDS, LICENSE_ISSUER, LICENSE_AUDIENCE, publicIdentity, signLease, signingIdentity, type LeaseClaims } from "./license-crypto";
import { parseIdentityConfig } from "./identity-config";

export class LicenseApiError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
function keyRef(value: unknown) {
  if (typeof value !== "string" || value.length > 60) throw new LicenseApiError("invalid_key", "Key không hợp lệ.");
  const key = value.trim().toUpperCase();
  if (!/^NEMO-(?:[A-F0-9]{8}-){4}[A-F0-9]{8}$/.test(key)) throw new LicenseApiError("invalid_key", "Key không hợp lệ.");
  return tokenHash(key);
}
function licenseRef(value: unknown) {
  if (typeof value !== "string" || !/^[1-9]\d{0,19}$/.test(value) || BigInt(value) > BigInt("18446744073709551615")) throw new LicenseApiError("invalid_request", "Mã giấy phép không hợp lệ.");
  return value;
}

// Shared database counters work across Node workers; do not trust client IP headers.
export async function rateLimit(scopes: { scope: string; max: number }[]) {
  const db = await getDb().getConnection();
  try {
    await db.beginTransaction();
    for (const entry of scopes.map((s) => ({ bucket: tokenHash(s.scope), max: s.max })).sort((a, b) => a.bucket.localeCompare(b.bucket))) {
      await db.execute(`INSERT INTO license_rate_limits (bucket) VALUES (?) ON DUPLICATE KEY UPDATE bucket = license_rate_limits.bucket`, [entry.bucket]);
      const [rows] = await db.execute<(RowDataPacket & { attempts: number; fresh: number })[]>(
        `SELECT attempts, window_start > UTC_TIMESTAMP(3) - INTERVAL 1 MINUTE AS fresh FROM license_rate_limits WHERE bucket = ? FOR UPDATE`, [entry.bucket],
      );
      const fresh = Number(rows[0].fresh);
      const attempts = fresh ? Number(rows[0].attempts) : 0;
      if (attempts >= entry.max) {
        await db.commit();
        throw new LicenseApiError("rate_limited", "Quá nhiều yêu cầu. Vui lòng thử lại sau một phút.", 429);
      }
      await db.execute(`UPDATE license_rate_limits SET attempts = ?, window_start = IF(?, window_start, UTC_TIMESTAMP(3)) WHERE bucket = ?`, [attempts + 1, fresh, entry.bucket]);
    }
    await db.commit();
  } catch (error) { await db.rollback(); throw error; }
  finally { db.release(); }
}

export async function challenge(data: Record<string, unknown>) {
  const purpose = data.purpose;
  if (purpose !== "activate" && purpose !== "verify") throw new LicenseApiError("invalid_request", "Mục đích thử thách không hợp lệ.");
  let identity;
  try {
    if (typeof data.publicKey !== "string") throw new Error();
    identity = publicIdentity(data.publicKey);
  } catch { throw new LicenseApiError("invalid_public_key", "Cần khóa công khai Ed25519 dạng SPKI/base64."); }
  const ref = purpose === "activate" ? keyRef(data.key) : licenseRef(data.licenseId);
  const clientNonce = data.clientNonce;
  if (clientNonce !== undefined && (typeof clientNonce !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(clientNonce))) throw new LicenseApiError("invalid_request", "Nonce không hợp lệ.");
  const deviceName = data.deviceName ?? "iPad";
  if (typeof deviceName !== "string" || Array.from(deviceName).length > 120 || /\u0000/.test(deviceName)) throw new LicenseApiError("invalid_request", "Tên thiết bị không hợp lệ.");
  await rateLimit([{ scope: "challenge-global", max: 600 }, { scope: `device:${identity.fingerprint}`, max: 60 }, { scope: `license:${purpose}:${ref}`, max: 60 }]);
  const db = getDb();
  const [clock] = await db.query<(RowDataPacket & { now: Date })[]>(`SELECT UTC_TIMESTAMP(3) AS now`);
  const now = clock[0].now;
  const expiresAt = new Date(now.getTime() + 5 * 60 * 1000);
  const challengeId = randomBytes(16).toString("hex");
  const message = JSON.stringify({ v: 1, domain: "nemo-device-proof", challengeId, purpose, licenseRef: ref, device: identity.fingerprint, deviceName: deviceName.trim(), nonce: clientNonce ?? randomBytes(24).toString("base64url"), issuedAt: now.toISOString(), expiresAt: expiresAt.toISOString() });
  await db.execute(`DELETE FROM license_challenges WHERE expires_at <= UTC_TIMESTAMP(3)`);
  await db.execute(`DELETE FROM license_rate_limits WHERE window_start < UTC_TIMESTAMP(3) - INTERVAL 2 HOUR`);
  await db.execute(`INSERT INTO license_challenges (id, purpose, license_ref, public_key, fingerprint, message, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, [challengeId, purpose, ref, identity.base64, identity.fingerprint, message, expiresAt]);
  return { challengeId, message, expiresAt: expiresAt.toISOString(), serverTime: now.toISOString() };
}

type ChallengeRow = RowDataPacket & { purpose: string; license_ref: string; public_key: string; fingerprint: string; message: string; fresh: number };
type LicenseRow = RowDataPacket & { id: string; status: string; version: number; duration_days: number; expires_at: Date | null; usable: number; now: Date };
type DeviceRow = RowDataPacket & { id: string; license_id: string; fingerprint: string };

export async function prove(purpose: "activate" | "verify", data: Record<string, unknown>) {
  if (typeof data.challengeId !== "string" || !/^[a-f0-9]{32}$/.test(data.challengeId)
    || typeof data.signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(data.signature)) throw new LicenseApiError("invalid_request", "Thiếu thử thách hoặc chữ ký hợp lệ.");
  const signature = Buffer.from(data.signature, "base64url");
  if (signature.length !== 64 || signature.toString("base64url") !== data.signature) throw new LicenseApiError("invalid_request", "Chữ ký không hợp lệ.");
  await rateLimit([{ scope: "proof-global", max: 1200 }, { scope: `proof:${data.challengeId}`, max: 10 }]);
  // Read signing configuration before any license/device mutation; fail closed if unavailable.
  const signer = signingIdentity();
  const db = await getDb().getConnection();
  try {
    // The license row serializes competing bindings for the same key. Avoid
    // gap-locking absent device rows for unrelated keys during simultaneous
    // first activation; unique indexes still arbitrate the same fingerprint.
    await db.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
    await db.beginTransaction();
    const [challenges] = await db.execute<ChallengeRow[]>(`SELECT *, expires_at > UTC_TIMESTAMP(3) AS fresh FROM license_challenges WHERE id = ? FOR UPDATE`, [data.challengeId]);
    const proof = challenges[0];
    if (!proof || !Number(proof.fresh) || proof.purpose !== purpose) throw new LicenseApiError("invalid_challenge", "Thử thách đã hết hạn hoặc đã dùng. Hãy xin thử thách mới.", 409);
    const identity = publicIdentity(proof.public_key);
    if (!verify(null, Buffer.from(proof.message, "utf8"), identity.publicKey, signature)) throw new LicenseApiError("invalid_proof", "Không xác minh được chữ ký thiết bị.", 401);
    const [licenses] = await db.execute<LicenseRow[]>(
      `SELECT *, expires_at > UTC_TIMESTAMP(3) AS usable FROM licenses WHERE ${purpose === "activate" ? "key_hash" : "id"} = ? FOR UPDATE`, [proof.license_ref],
    );
    const license = licenses[0];
    if (!license) throw new LicenseApiError("invalid_license", "Không tìm thấy giấy phép hợp lệ.", 403);
    if (license.status === "revoked") throw new LicenseApiError("license_revoked", "Key đã bị thu hồi.", 403);
    if (license.status !== "pending" && (license.status !== "active" || !Number(license.usable))) throw new LicenseApiError("license_expired", "Key đã hết hạn.", 403);
    const [devices] = await db.execute<DeviceRow[]>(`SELECT id, license_id, fingerprint FROM devices WHERE license_id = ? FOR UPDATE`, [license.id]);
    let device = devices[0];
    if (purpose === "verify") {
      if (license.status !== "active" || !device || device.fingerprint !== proof.fingerprint) throw new LicenseApiError("device_mismatch", "Thiết bị chưa được liên kết với key hoặc đã bị gỡ.", 403);
    } else {
      if (device && device.fingerprint !== proof.fingerprint) throw new LicenseApiError("device_mismatch", "Key đang được dùng trên thiết bị khác.", 403);
      if (!device) {
        const [alreadyBound] = await db.execute<RowDataPacket[]>(`SELECT id FROM devices WHERE fingerprint = ?`, [proof.fingerprint]);
        if (alreadyBound.length) throw new LicenseApiError("device_in_use", "Thiết bị này đã gắn với một key khác.", 409);
        const message = JSON.parse(proof.message) as { deviceName: string };
        const [insert] = await db.execute<import("mysql2/promise").ResultSetHeader>(`INSERT INTO devices (license_id, public_key, fingerprint, name, last_seen_at) VALUES (?, ?, ?, ?, UTC_TIMESTAMP(3))`, [license.id, proof.public_key, proof.fingerprint, message.deviceName || "iPad"]);
        device = { id: String(insert.insertId), license_id: license.id, fingerprint: proof.fingerprint } as DeviceRow;
        if (license.status === "pending") {
          await db.execute(`UPDATE licenses SET status = 'active', activated_at = UTC_TIMESTAMP(3), expires_at = TIMESTAMPADD(DAY, duration_days, UTC_TIMESTAMP(3)), version = version + 1 WHERE id = ?`, [license.id]);
        } else {
          await db.execute(`UPDATE licenses SET version = version + 1 WHERE id = ?`, [license.id]);
        }
        await db.execute(`INSERT INTO audit_events (action, target_id, details) VALUES ('device.activated', ?, ?)`, [license.id, JSON.stringify({ deviceId: device.id, fingerprint: proof.fingerprint, firstActivation: license.status === "pending" })]);
      }
    }
    await db.execute(`UPDATE devices SET last_seen_at = UTC_TIMESTAMP(3) WHERE id = ?`, [device.id]);
    const [updated] = await db.execute<LicenseRow[]>(`SELECT id, version, expires_at, UTC_TIMESTAMP(3) AS now FROM licenses WHERE id = ?`, [license.id]);
    const current = updated[0];
    const iat = Math.floor(current.now.getTime() / 1000);
    const licenseExpiresAt = Math.floor(current.expires_at!.getTime() / 1000);
    const exp = Math.min(iat + LEASE_SECONDS, licenseExpiresAt);
    if (exp <= iat) throw new LicenseApiError("license_expired", "Key đã hết hạn.", 403);
    const claims: LeaseClaims = { v: 1, iss: LICENSE_ISSUER, aud: LICENSE_AUDIENCE, sub: String(license.id), device: proof.fingerprint, version: current.version, iat, exp, licenseExpiresAt, nonce: JSON.parse(proof.message).nonce };
    // Read assignment under the already-held license lock. Never use client-supplied IDs.
    const [assignments] = await db.execute<(RowDataPacket & { device_id: string; registration_uuid: string })[]>(
      `SELECT device_id, registration_uuid FROM license_identities WHERE license_id = ?`, [license.id],
    );
    if (assignments[0]) {
      claims.identity = parseIdentityConfig({ v: 1, device_id: assignments[0].device_id, uuid: assignments[0].registration_uuid });
    }
    const token = signLease(claims, signer);
    await db.execute(`DELETE FROM license_challenges WHERE id = ?`, [data.challengeId]);
    await db.commit();
    return { token, licenseId: String(license.id), device: proof.fingerprint, serverTime: current.now.toISOString(), leaseExpiresAt: new Date(exp * 1000).toISOString(), licenseExpiresAt: current.expires_at!.toISOString(), refreshAfter: new Date(Math.max(iat, Math.min(iat + 3600, exp - 60)) * 1000).toISOString() };
  } catch (error) {
    await db.rollback();
    if ((error as { code?: string }).code === "ER_DUP_ENTRY") throw new LicenseApiError("device_in_use", "Thiết bị này vừa được liên kết với key khác.", 409);
    throw error;
  } finally { db.release(); }
}
