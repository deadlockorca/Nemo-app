import { randomBytes, randomUUID } from "node:crypto";
import type { RowDataPacket, ResultSetHeader, PoolConnection } from "mysql2/promise";
import { getDb } from "./db";
import { tokenHash } from "./password";
import { InputError, id } from "./validation";
import { loadSecret, objectPath, removeObject, runPackager, SigningError, storeObject, type SigningSecrets } from "./install-storage";
import { signingError, type CustomerInstall, type PackageMetadata } from "./installation-types";
import type { Admin } from "./auth";
import { attachVerifiedInstallation } from "./device-profiles";

type InstallRow = RowDataPacket & {
  id: string; license_id: string; label: string; apple_udid: string; source_key: string;
  secrets_key: string; metadata: PackageMetadata; state: string;
};
type JobRow = RowDataPacket & { id: string; installation_id: string; status: string; attempt: number; error_code: string | null; output_key: string | null };
const randomId = () => randomBytes(16).toString("hex");
const eligible = `l.status <> 'revoked' AND (l.expires_at IS NULL OR l.expires_at > UTC_TIMESTAMP(3))`;
export const INSTALL_COOKIE = "nemo_install_session";
export const INSTALL_SESSION_SECONDS = 6 * 60 * 60;

async function transaction<T>(fn: (db: PoolConnection) => Promise<T>) {
  const db = await getDb().getConnection();
  try { await db.beginTransaction(); const result = await fn(db); await db.commit(); return result; }
  catch (e) { await db.rollback(); throw e; }
  finally { db.release(); }
}
export async function adminInstallations() {
  const [items] = await getDb().execute<RowDataPacket[]>(`SELECT i.id, i.license_id, i.label, i.apple_udid, i.metadata, i.state, i.created_at,
    c.name AS customer_name, l.key_hint, j.status AS job_status, j.error_code FROM ios_installations i
    JOIN licenses l ON l.id = i.license_id JOIN customers c ON c.id = l.customer_id
    LEFT JOIN ios_signing_jobs j ON j.installation_id = i.id ORDER BY i.created_at DESC, i.id DESC LIMIT 100`);
  const [licenses] = await getDb().execute<RowDataPacket[]>(`SELECT l.id, l.key_hint, c.name AS customer_name FROM licenses l
    JOIN customers c ON c.id = l.customer_id JOIN license_identities li ON li.license_id = l.id
    WHERE ${eligible} ORDER BY l.id DESC LIMIT 200`);
  return { items, licenses };
}
export async function createInstallation(admin: Admin, form: FormData) {
  const licenseId = id(form.get("licenseId"));
  const signingLabel = form.get("signingLabel");
  if (signingLabel !== null && (typeof signingLabel !== "string" || signingLabel.trim().length > 120 || signingLabel.includes("\u0000"))) throw new InputError("Tên bộ chứng chỉ cần tối đa 120 ký tự.");
  const label = form.get("label"), udid = form.get("appleUdid"), password = form.get("password");
  if (typeof label !== "string" || !label.trim() || label.trim().length > 120 || /\u0000/.test(label)) throw new InputError("Tên bản cài cần 1–120 ký tự.");
  if (typeof udid !== "string" || !/^(?:[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}|[0-9A-Fa-f]{40})$/.test(udid)) throw new InputError("Cần UDID Apple của iPhone/iPad, không phải device_id của Nemo.");
  if (typeof password !== "string" || password.length > 512 || /\u0000/.test(password)) throw new InputError("Mật khẩu chứng chỉ không hợp lệ.");
  const files = [form.get("ipa"), form.get("p12"), form.get("profile")];
  if (files.some((f) => !(f instanceof File) || !f.size)) throw new InputError("Cần chọn đủ IPA trắng, .p12 và .mobileprovision.");
  const [ipa, p12, profile] = files as File[];
  if (ipa.size > 150 * 1024 * 1024 || p12.size > 1024 * 1024 || profile.size > 2 * 1024 * 1024) throw new InputError("Tệp tải lên vượt dung lượng cho phép.", 413);
  const [allowed] = await getDb().execute<RowDataPacket[]>(`SELECT l.id FROM licenses l JOIN license_identities li ON li.license_id = l.id WHERE l.id = ? AND ${eligible}`, [licenseId]);
  if (!allowed.length) throw new InputError("Key cần còn hiệu lực và đã gán hai ID cho IPA trắng.", 409);
  const source = await storeObject(Buffer.from(await ipa.arrayBuffer()), "ipa");
  let encrypted: string | undefined;
  try {
    const secrets: SigningSecrets = { password, p12: Buffer.from(await p12.arrayBuffer()).toString("base64"), profile: Buffer.from(await profile.arrayBuffer()).toString("base64") };
    const metadata = await runPackager({ ...secrets, mode: "inspect", source: objectPath(source, "ipa"), udid: udid.toUpperCase() });
    encrypted = await storeObject(Buffer.from(JSON.stringify(secrets)), "secret");
    const installId = randomId(), code = randomUUID();
    await transaction(async (db) => {
      const [current] = await db.execute<RowDataPacket[]>(`SELECT l.id, l.customer_id FROM licenses l JOIN license_identities li ON li.license_id = l.id WHERE l.id = ? AND ${eligible} FOR UPDATE`, [licenseId]);
      if (!current.length) throw new InputError("Key đã thay đổi. Hãy kiểm tra lại.", 409);
      await db.execute(`INSERT INTO ios_installations (id, license_id, label, apple_udid, code_hash, source_key, secrets_key, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [installId, licenseId, label.trim(), udid.toUpperCase(), tokenHash(code), source, encrypted!, JSON.stringify(metadata)]);
      await attachVerifiedInstallation(db, admin, { customerId: String(current[0].customer_id), licenseId,
        udid: udid.toUpperCase(), label: label.trim(), signingLabel: typeof signingLabel === "string" ? signingLabel.trim() : "",
        installationId: installId, metadata });
      await db.execute(`INSERT INTO audit_events (admin_id, action, target_id, details) VALUES (?, 'installation.created', ?, ?)`,
        [admin.id, installId, JSON.stringify({ licenseId, sourceSha256: metadata.sourceSha256, team: metadata.team })]);
    });
    return { id: installId, code, metadata };
  } catch (e) {
    await removeObject(source, "ipa");
    if (encrypted) await removeObject(encrypted, "secret");
    if (e instanceof SigningError) throw new InputError(signingError(e.code));
    throw e;
  }
}
function installId(value: string) { if (!/^[a-f0-9]{32}$/.test(value)) throw new InputError("Không tìm thấy bản cài.", 404); return value; }
export async function updateInstallation(admin: Admin, value: string, action: string) {
  const target = installId(value), code = randomUUID();
  if (action !== "revoke" && action !== "rotate") throw new InputError("Không tìm thấy thao tác.", 404);
  await transaction(async (db) => {
    const [rows] = await db.execute<InstallRow[]>(`SELECT * FROM ios_installations WHERE id = ? FOR UPDATE`, [target]);
    if (!rows.length) throw new InputError("Không tìm thấy bản cài.", 404);
    if (action === "rotate" && rows[0].state !== "active") throw new InputError("Bản cài đã thu hồi. Hãy tạo bản cài mới.", 409);
    if (action === "rotate") await db.execute(`UPDATE ios_installations SET code_hash = ? WHERE id = ?`, [tokenHash(code), target]);
    else await db.execute(`UPDATE ios_installations SET state = 'revoked' WHERE id = ?`, [target]);
    await db.execute(`DELETE FROM ios_install_sessions WHERE installation_id = ?`, [target]);
    await db.execute(`DELETE d FROM ios_downloads d JOIN ios_signing_jobs j ON j.id = d.job_id WHERE j.installation_id = ?`, [target]);
    await db.execute(`INSERT INTO audit_events (admin_id, action, target_id) VALUES (?, ?, ?)`, [admin.id, `installation.${action === "rotate" ? "code_rotated" : "revoked"}`, target]);
  });
  return action === "rotate" ? { code } : { ok: true };
}
async function consumeLoginLimit(code: string) {
  // A code has 122 random bits. The database limit also bounds online attempts
  // across server processes; no untrusted forwarded IP is accepted as identity.
  const limited = await transaction(async (db) => {
    let exceeded = false;
    for (const [label, max] of [["global", 300], [`code:${tokenHash(code)}`, 20]] as const) {
      const bucket = tokenHash(`install-login:${label}`);
      await db.execute(`INSERT INTO ios_install_limits (bucket) VALUES (?) ON DUPLICATE KEY UPDATE bucket = ios_install_limits.bucket`, [bucket]);
      const [limits] = await db.execute<RowDataPacket[]>(`SELECT attempts, window_start > UTC_TIMESTAMP(3) - INTERVAL 1 MINUTE AS fresh FROM ios_install_limits WHERE bucket = ? FOR UPDATE`, [bucket]);
      const attempts = Number(limits[0].fresh) ? Number(limits[0].attempts) : 0;
      if (attempts >= max) exceeded = true;
      else await db.execute(`UPDATE ios_install_limits SET attempts = ?, window_start = IF(?, window_start, UTC_TIMESTAMP(3)) WHERE bucket = ?`, [attempts + 1, Number(limits[0].fresh), bucket]);
    }
    return exceeded;
  });
  if (limited) throw new InputError("Bạn thử quá nhiều lần. Hãy chờ một phút.", 429);
}
export async function loginInstallation(value: unknown) {
  if (typeof value !== "string" || value.length > 100) throw new InputError("Mã cài không hợp lệ.", 401);
  const code = value.trim().toLowerCase();
  await consumeLoginLimit(code);
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(code)) throw new InputError("Mã cài không hợp lệ hoặc đã hết hiệu lực.", 401);
  return transaction(async (db) => {
    const [rows] = await db.execute<InstallRow[]>(`SELECT i.* FROM ios_installations i JOIN licenses l ON l.id = i.license_id
      WHERE i.code_hash = ? AND i.state = 'active' AND ${eligible} FOR SHARE`, [tokenHash(code)]);
    if (!rows.length) throw new InputError("Mã cài không hợp lệ hoặc đã hết hiệu lực.", 401);
    // Bound session count per code without invalidating active download tokens.
    await db.execute(`DELETE FROM ios_install_sessions WHERE installation_id = ? AND expires_at <= UTC_TIMESTAMP(3)`, [rows[0].id]);
    const [count] = await db.execute<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ios_install_sessions WHERE installation_id = ?`, [rows[0].id]);
    if (Number(count[0].n) >= 30) throw new InputError("Mã cài đang có nhiều phiên. Hãy liên hệ người cấp mã.", 429);
    const token = randomBytes(32).toString("hex");
    await db.execute(`INSERT INTO ios_install_sessions (token_hash, installation_id, expires_at) VALUES (?, ?, TIMESTAMPADD(SECOND, ?, UTC_TIMESTAMP(3)))`, [tokenHash(token), rows[0].id, INSTALL_SESSION_SECONDS]);
    return { token };
  });
}
export async function installationForSession(token: string | undefined) {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new InputError("Hãy nhập lại mã cài.", 401);
  const [rows] = await getDb().execute<InstallRow[]>(`SELECT i.* FROM ios_installations i JOIN ios_install_sessions s ON s.installation_id = i.id
    JOIN licenses l ON l.id = i.license_id WHERE s.token_hash = ? AND s.expires_at > UTC_TIMESTAMP(3) AND i.state = 'active' AND ${eligible}`, [tokenHash(token)]);
  if (!rows.length) throw new InputError("Mã cài đã hết hiệu lực. Hãy nhập lại mã hoặc liên hệ người cấp mã.", 401);
  const row = rows[0];
  const expiry = Math.min(Date.parse(row.metadata.profileExpiresAt), Date.parse(row.metadata.certificateExpiresAt));
  if (!Number.isFinite(expiry) || expiry <= Date.now()) throw new InputError("Bộ chứng chỉ đã hết hạn. Hãy liên hệ người cấp mã.", 409);
  return row;
}
export async function installationStatus(token: string | undefined): Promise<CustomerInstall> {
  const i = await installationForSession(token);
  const [jobs] = await getDb().execute<JobRow[]>(`SELECT * FROM ios_signing_jobs WHERE installation_id = ?`, [i.id]);
  const job = jobs[0];
  return { label: i.label, deviceSuffix: i.apple_udid.slice(-8), version: i.metadata.version, status: job?.status || "new",
    error: job?.status === "failed" ? signingError(job.error_code) : null, development: i.metadata.signingMode === "development" };
}
export async function queueInstallation(token: string | undefined) {
  const i = await installationForSession(token);
  await transaction(async (db) => {
    const [active] = await db.execute<RowDataPacket[]>(`SELECT state FROM ios_installations WHERE id = ? FOR UPDATE`, [i.id]);
    if (active[0]?.state !== "active") throw new InputError("Bản cài đã thu hồi.", 409);
    const [jobs] = await db.execute<JobRow[]>(`SELECT *, finished_at < UTC_TIMESTAMP(3) - INTERVAL 30 SECOND AS retry_allowed FROM ios_signing_jobs WHERE installation_id = ? FOR UPDATE`, [i.id]);
    const current = jobs[0];
    if (current && current.status !== "failed") return;
    if (current && (current.attempt >= 5 || !current.retry_allowed)) throw new InputError("Chưa thể thử lại. Hãy chờ 30 giây hoặc liên hệ người cấp mã.", 429);
    const [count] = await db.execute<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ios_signing_jobs WHERE status IN ('queued', 'signing')`);
    if (Number(count[0].n) >= 50) throw new InputError("Hệ thống đang chuẩn bị nhiều bản cài. Hãy thử lại sau.", 429);
    if (current) await db.execute(`UPDATE ios_signing_jobs SET status = 'queued', attempt = attempt + 1, claim_token = NULL, heartbeat_at = NULL, error_code = NULL, finished_at = NULL WHERE id = ?`, [current.id]);
    else await db.execute(`INSERT INTO ios_signing_jobs (id, installation_id) VALUES (?, ?)`, [randomId(), i.id]);
  });
  return { ok: true };
}
export async function issueDownload(token: string | undefined) {
  const i = await installationForSession(token);
  const raw = randomBytes(32).toString("hex");
  // INSERT...SELECT rechecks revocation and expiry at the point of issuing.
  const [result] = await getDb().execute<ResultSetHeader>(`INSERT INTO ios_downloads (token_hash, job_id, expires_at)
    SELECT ?, j.id, LEAST(TIMESTAMPADD(MINUTE, 30, UTC_TIMESTAMP(3)), COALESCE(l.expires_at, TIMESTAMPADD(MINUTE, 30, UTC_TIMESTAMP(3))))
    FROM ios_signing_jobs j JOIN ios_installations i ON i.id = j.installation_id JOIN licenses l ON l.id = i.license_id
    WHERE i.id = ? AND i.state = 'active' AND j.status = 'ready' AND ${eligible}
    AND (SELECT COUNT(*) FROM ios_downloads d WHERE d.job_id = j.id AND d.expires_at > UTC_TIMESTAMP(3)) < 20`, [tokenHash(raw), i.id]);
  if (!result.affectedRows) throw new InputError("Bản cài chưa sẵn sàng hoặc đã có nhiều lượt tải. Hãy thử lại sau.", 409);
  return { token: raw, expiresIn: 1800 };
}
export async function authorizedDownload(raw: string) {
  if (!/^[a-f0-9]{64}$/.test(raw)) throw new InputError("Liên kết cài đã hết hiệu lực.", 404);
  const [rows] = await getDb().execute<(InstallRow & { output_key: string; output_sha256: string })[]>(`SELECT i.*, j.output_key, j.output_sha256
    FROM ios_downloads d JOIN ios_signing_jobs j ON j.id = d.job_id JOIN ios_installations i ON i.id = j.installation_id JOIN licenses l ON l.id = i.license_id
    WHERE d.token_hash = ? AND d.expires_at > UTC_TIMESTAMP(3) AND j.status = 'ready' AND i.state = 'active' AND ${eligible}`, [tokenHash(raw)]);
  if (!rows.length) throw new InputError("Liên kết cài đã hết hiệu lực.", 404);
  const row = rows[0];
  if (Math.min(Date.parse(row.metadata.profileExpiresAt), Date.parse(row.metadata.certificateExpiresAt)) <= Date.now()) throw new InputError("Chứng chỉ đã hết hạn.", 404);
  return row;
}

export async function runSigningJob() {
  const claim = randomId();
  // A stale attempt is failed rather than silently retried; a customer can retry
  // explicitly. Claim tokens prevent a delayed worker from publishing its result.
  await getDb().execute(`UPDATE ios_signing_jobs SET status = 'failed', error_code = 'worker_interrupted', finished_at = UTC_TIMESTAMP(3), claim_token = NULL
    WHERE status = 'signing' AND heartbeat_at < UTC_TIMESTAMP(3) - INTERVAL 20 MINUTE`);
  const job = await transaction(async (db) => {
    const [jobs] = await db.execute<JobRow[]>(`SELECT * FROM ios_signing_jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`);
    if (!jobs.length) return null;
    await db.execute(`UPDATE ios_signing_jobs SET status = 'signing', claim_token = ?, heartbeat_at = UTC_TIMESTAMP(3) WHERE id = ?`, [claim, jobs[0].id]);
    return jobs[0];
  });
  if (!job) return false;
  const output = randomId();
  const heartbeat = setInterval(() => {
    void getDb().execute(`UPDATE ios_signing_jobs SET heartbeat_at = UTC_TIMESTAMP(3) WHERE id = ? AND claim_token = ?`, [job.id, claim]).catch(() => { /* stale-claim recovery handles database outages */ });
  }, 30000);
  try {
    const [rows] = await getDb().execute<InstallRow[]>(`SELECT i.* FROM ios_installations i JOIN licenses l ON l.id = i.license_id WHERE i.id = ? AND i.state = 'active' AND ${eligible}`, [job.installation_id]);
    const i = rows[0];
    if (!i) throw new SigningError("installation_unavailable");
    const secrets = await loadSecret(i.secrets_key);
    const result = await runPackager({ ...secrets, mode: "sign", source: objectPath(i.source_key, "ipa"), udid: i.apple_udid,
      expectedSourceSha256: i.metadata.sourceSha256, output: objectPath(output, "ipa") });
    if (!result.verified || !/^[a-f0-9]{64}$/.test(result.outputSha256 || "") || result.certificateSha256 !== i.metadata.certificateSha256) throw new SigningError("signature_verification_failed");
    const [saved] = await getDb().execute<ResultSetHeader>(`UPDATE ios_signing_jobs j JOIN ios_installations i ON i.id = j.installation_id JOIN licenses l ON l.id = i.license_id
      SET j.status = 'ready', j.output_key = ?, j.output_sha256 = ?, j.finished_at = UTC_TIMESTAMP(3), j.error_code = NULL
      WHERE j.id = ? AND j.claim_token = ? AND j.status = 'signing' AND i.state = 'active' AND ${eligible}`, [output, result.outputSha256!, job.id, claim]);
    if (!saved.affectedRows) throw new SigningError("installation_unavailable");
    console.log(`Signing job ${job.id}: ready`);
  } catch (e) {
    await removeObject(output, "ipa");
    const code = e instanceof SigningError ? e.code : "signing_failed";
    await getDb().execute(`UPDATE ios_signing_jobs SET status = 'failed', error_code = ?, finished_at = UTC_TIMESTAMP(3) WHERE id = ? AND claim_token = ?`, [code, job.id, claim]);
    console.error(`Signing job ${job.id}: ${code}`);
  } finally { clearInterval(heartbeat); }
  return true;
}

export async function cleanupInstallTokens() {
  await getDb().execute(`DELETE FROM ios_downloads WHERE expires_at <= UTC_TIMESTAMP(3)`);
  await getDb().execute(`DELETE FROM ios_install_sessions WHERE expires_at <= UTC_TIMESTAMP(3)`);
  await getDb().execute(`DELETE FROM ios_install_limits WHERE window_start < UTC_TIMESTAMP(3) - INTERVAL 1 DAY`);
}
