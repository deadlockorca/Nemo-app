import "server-only";
import { createHash, verify } from "node:crypto";
import type { RowDataPacket } from "mysql2/promise";
import { getDb } from "./db";
import { signingIdentity, verifyLease, publicIdentity } from "./license-crypto";
import { locationProofMessage, parseCenters, parseLocationRequest } from "./location-contract";
import { InputError } from "./validation";

export class LocationApiError extends Error {
  constructor(public code: string, public status: number) { super(code); }
}
function fail(code: string, status = 403): never { throw new LocationApiError(code, status); }
function decode(value: unknown) { return typeof value === "string" ? JSON.parse(value) : value; }

export async function resolveLocation(request: Request, rawBody: string) {
  // Authorization is managed per license in admin; absent policy stays disabled.
  const auth = request.headers.get("authorization") || "";
  if (!auth.startsWith("Bearer ") || auth.length > 4103) fail("UNAUTHORIZED", 401);
  const token = auth.slice(7);
  let claims;
  try {
    // Decode device only to supply the expected format to the existing verifier.
    // No decoded field is trusted until its signature and full claims validate.
    const untrusted = JSON.parse(Buffer.from(token.split(".")[1] || "", "base64url").toString("utf8"));
    claims = verifyLease(token, signingIdentity().publicKey, untrusted.device);
  } catch { fail("UNAUTHORIZED", 401); }
  const timestamp = request.headers.get("x-nemo-timestamp") || "";
  const signature = request.headers.get("x-nemo-signature") || "";
  if (!/^\d{10}$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 60 || !/^[A-Za-z0-9_-]{86}$/.test(signature)) fail("INVALID_PROOF", 401);
  let data;
  try { data = JSON.parse(rawBody); } catch { throw new InputError("JSON không hợp lệ."); }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new InputError("Cần JSON object.");
  const context = parseLocationRequest(data);
  const db = await getDb().getConnection();
  try {
    await db.beginTransaction();
    // Serialize requests and admin changes for this license. Check live state on
    // every retry, including before serving a cached successful response.
    const [licenses] = await db.execute<RowDataPacket[]>(`SELECT customer_id, status, version, expires_at, expires_at > UTC_TIMESTAMP(3) AS usable,
      UTC_TIMESTAMP(3) AS now FROM licenses WHERE id = ? FOR UPDATE`, [claims.sub]);
    const license = licenses[0];
    if (!license || license.status !== "active" || !Number(license.usable) || license.version !== claims.version) fail("INVALID_LICENSE");
    const [devices] = await db.execute<RowDataPacket[]>(`SELECT public_key, fingerprint FROM devices WHERE license_id = ? FOR SHARE`, [claims.sub]);
    const device = devices[0];
    if (!device || device.fingerprint !== claims.device) fail("INVALID_DEVICE");
    const identity = publicIdentity(device.public_key);
    const proof = Buffer.from(signature, "base64url");
    if (identity.fingerprint !== claims.device || proof.toString("base64url") !== signature || !verify(null, Buffer.from(locationProofMessage(timestamp, rawBody)), identity.publicKey, proof)) fail("INVALID_PROOF", 401);
    const [customers] = await db.execute<RowDataPacket[]>(`SELECT nemo_username FROM customers WHERE id = ? FOR SHARE`, [license.customer_id]);
    if (!customers[0]?.nemo_username || customers[0].nemo_username !== context.employeeUsername) fail("ACCOUNT_MISMATCH");
    const [policies] = await db.execute<RowDataPacket[]>(`SELECT enabled, centers, version FROM license_location_policies WHERE license_id = ? FOR SHARE`, [claims.sub]);
    const policy = policies[0];
    if (!policy || !Number(policy.enabled)) fail("FEATURE_DISABLED");
    const center = parseCenters(decode(policy.centers)).find(c => c.hospitalId === context.hospitalId);
    if (!center) fail("CENTER_NOT_FOUND", 404);
    const now = license.now as Date;
    if (claims.exp * 1000 <= now.getTime()) fail("UNAUTHORIZED", 401);
    const hash = createHash("sha256").update(JSON.stringify({ ...context, policyVersion: policy.version })).digest("hex");
    const [previous] = await db.execute<RowDataPacket[]>(`SELECT context_hash, response, expires_at FROM location_context_requests WHERE license_id = ? AND request_id = ?`, [claims.sub, context.requestId]);
    if (previous[0]) {
      if (previous[0].context_hash !== hash) fail("REQUEST_CONTEXT_MISMATCH", 409);
      if (previous[0].expires_at.getTime() <= now.getTime()) fail("REQUEST_EXPIRED", 409);
      await db.commit();
      return decode(previous[0].response);
    }
    const [counts] = await db.execute<RowDataPacket[]>(`SELECT COUNT(*) AS total FROM location_context_requests WHERE license_id = ? AND created_at > UTC_TIMESTAMP(3) - INTERVAL 1 MINUTE`, [claims.sub]);
    if (Number(counts[0].total) >= 30) fail("RATE_LIMITED", 429);
    const expiresAt = new Date(Math.min(now.getTime() + 60000, claims.exp * 1000, license.expires_at.getTime()));
    const response = { requestId: context.requestId, sessionId: context.sessionId, action: context.action, hospitalId: context.hospitalId,
      center: { latitude: center.latitude, longitude: center.longitude }, radiusMeters: center.radiusMeters,
      expiresAt: expiresAt.toISOString(), serverTime: now.toISOString() };
    // Retain used IDs for a day so expired retries cannot become new actions.
    await db.execute(`DELETE FROM location_context_requests WHERE license_id = ? AND created_at < UTC_TIMESTAMP(3) - INTERVAL 1 DAY`, [claims.sub]);
    await db.execute(`INSERT INTO location_context_requests (license_id, request_id, context_hash, response, expires_at) VALUES (?, ?, ?, ?, ?)`,
      [claims.sub, context.requestId, hash, JSON.stringify(response), expiresAt]);
    await db.commit();
    return response;
  } catch (error) { await db.rollback(); throw error; }
  finally { db.release(); }
}
