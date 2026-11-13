import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import type { RowDataPacket, PoolConnection, ResultSetHeader } from "mysql2/promise";
import { getDb } from "./db";
import { tokenHash } from "./password";
import { loadSecret } from "./install-storage";
import { mailConfig, sendCertificateEmail, type CertificateAlertPayload } from "./certificate-email";
import type { CertificateResult, CertificateMonitorSummary } from "./certificate-monitor-types";

export const CERTIFICATE_CHECK_SECONDS = 3600;
export const monitorEnabled = () => process.env.CERTIFICATE_MONITOR_ENABLED === "true";
const randomId = () => randomBytes(16).toString("hex");
const digest = `COALESCE(a.certificate_sha256, CONVERT(JSON_UNQUOTE(JSON_EXTRACT(i.metadata, '$.certificateSha256')) USING ascii) COLLATE ascii_bin)`;
const sourceJoin = `customer_device_profiles p JOIN customers c ON c.id = p.customer_id LEFT JOIN ios_installations i ON i.id = p.installation_id
  LEFT JOIN ios_device_certificate_assets a ON a.device_profile_id = p.id AND a.bound_installation_id <=> p.installation_id`;
const unknown = (detail: string): CertificateResult => ({ status: "unknown", detail, method: null, validUntil: null });
async function transaction<T>(fn: (db: PoolConnection) => Promise<T>) {
  const db = await getDb().getConnection();
  try { await db.beginTransaction(); const result = await fn(db); await db.commit(); return result; }
  catch (e) { await db.rollback(); throw e; }
  finally { db.release(); }
}
export async function monitorSummary(): Promise<CertificateMonitorSummary> {
  const [rows] = await getDb().execute<RowDataPacket[]>(`SELECT s.*, (SELECT COUNT(*) FROM ios_certificate_alerts WHERE status IN ('pending','sending')) AS pending, EXISTS(SELECT 1 FROM ios_certificate_alerts WHERE status = 'pending' AND last_error IS NOT NULL) AS mail_failed FROM ios_certificate_monitor_state s WHERE s.id = 1`);
  const row = rows[0];
  return { enabled: monitorEnabled(), stale: !row?.heartbeat_at || Date.now() - new Date(row.heartbeat_at).getTime() > 2 * 3600000, heartbeat_at: row?.heartbeat_at || null, mail_configured: !!mailConfig(), pending: Number(row?.pending || 0), mail_failed: !!Number(row?.mail_failed), last_error: row?.last_error || null };
}
export async function monitorHeartbeat(error: string | null = null) {
  await getDb().execute(`UPDATE ios_certificate_monitor_state SET heartbeat_at = UTC_TIMESTAMP(3), mail_configured = ?, last_error = ? WHERE id = 1`, [!!mailConfig(), error]);
}
export async function checkCertificateAssets(installation: { secrets_key: string; certificate_sha256: string }): Promise<CertificateResult> {
  let profile: string;
  try { profile = (await loadSecret(installation.secrets_key)).profile; } catch { return unknown("source_unavailable"); }
  return new Promise(resolve => {
    // Only the public, Apple-signed profile is given to this helper. The P12
    // and its password stay local and are never included in an OCSP request.
    const child = spawn(/* turbopackIgnore: true */ process.env.IOS_SIGN_PYTHON || "python3", [path.join(process.cwd(), "scripts/ios/certificate_status.py")], { stdio: ["pipe", "pipe", "ignore"] });
    let output = "", invalid = false;
    const timer = setTimeout(() => { invalid = true; child.kill("SIGKILL"); }, 90000);
    child.on("error", () => { clearTimeout(timer); resolve(unknown("checker_unavailable")); });
    child.stdout.on("data", chunk => { output += chunk.toString(); if (output.length > 8192) { invalid = true; child.kill("SIGKILL"); } });
    child.stdin.on("error", () => { /* close event resolves safely */ });
    child.on("close", code => {
      clearTimeout(timer);
      try {
        const result = JSON.parse(output);
        if (code !== 0 || invalid || !["unknown", "good", "revoked", "expired"].includes(result.status) || !/^[a-z_]{1,60}$/.test(result.detail) || ![null, "ocsp", "crl"].includes(result.method)) throw new Error();
        if (["good", "revoked"].includes(result.status) && (!result.method || !Number.isFinite(Date.parse(result.validUntil)) || Date.parse(result.validUntil) <= Date.now())) throw new Error();
        resolve(result);
      } catch { resolve(unknown("checker_unavailable")); }
    });
    child.stdin.end(JSON.stringify({ profile, certificateSha256: installation.certificate_sha256 }));
  });
}
function affected(row: RowDataPacket) { return { customer: String(row.customer_name), device: String(row.label), signingLabel: row.signing_label || "", udidSuffix: String(row.apple_udid).slice(-8) }; }
async function enqueue(db: PoolConnection, input: { kind: string; certificate?: string; profileId?: string; installationId?: string; generation: string; payload: CertificateAlertPayload }) {
  const key = tokenHash([input.kind, input.certificate || "", input.profileId || "", input.generation].join(":"));
  await db.execute(`INSERT IGNORE INTO ios_certificate_alerts (id, dedupe_key, kind, certificate_sha256, device_profile_id, source_installation_id, generation, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [randomId(), key, input.kind, input.certificate || null, input.profileId || null, input.installationId || null, input.generation, JSON.stringify(input.payload)]);
}
export async function runCertificateCheck(check = checkCertificateAssets, onlyCertificate?: string) {
  if (onlyCertificate && !/^[a-f0-9]{64}$/.test(onlyCertificate)) throw new Error("Invalid certificate reference");
  await getDb().execute(`INSERT IGNORE INTO ios_certificate_checks (certificate_sha256) SELECT DISTINCT ${digest} FROM ${sourceJoin} WHERE ${digest} REGEXP '^[a-f0-9]{64}$'`);
  await getDb().execute(`INSERT IGNORE INTO ios_certificate_checks (certificate_sha256) SELECT DISTINCT certificate_sha256 FROM ios_signing_sets WHERE state = 'active'`);
  const claim = randomId();
  const task = await transaction(async db => {
    const [rows] = await db.execute<RowDataPacket[]>(`SELECT s.* FROM ios_certificate_checks s WHERE s.next_check_at <= UTC_TIMESTAMP(3) AND (s.claim_until IS NULL OR s.claim_until <= UTC_TIMESTAMP(3))
      AND (EXISTS (SELECT 1 FROM ${sourceJoin} WHERE ${digest} = s.certificate_sha256) OR EXISTS (SELECT 1 FROM ios_signing_sets ss WHERE ss.certificate_sha256 = s.certificate_sha256 AND ss.state = 'active'))
      ${onlyCertificate ? "AND s.certificate_sha256 = ?" : ""} ORDER BY s.next_check_at LIMIT 1 FOR UPDATE SKIP LOCKED`, onlyCertificate ? [onlyCertificate] : []);
    if (!rows.length) return null;
    await db.execute(`UPDATE ios_certificate_checks SET claim_token = ?, claim_until = UTC_TIMESTAMP(3) + INTERVAL 5 MINUTE WHERE certificate_sha256 = ?`, [claim, rows[0].certificate_sha256]);
    const [sources] = await db.execute<RowDataPacket[]>(`SELECT COALESCE(a.secrets_key, i.secrets_key) AS secrets_key, ${digest} AS certificate_sha256 FROM ${sourceJoin} WHERE ${digest} = ? ORDER BY i.created_at DESC LIMIT 1`, [rows[0].certificate_sha256]);
    const [library] = await db.execute<RowDataPacket[]>(`SELECT secrets_key, certificate_sha256 FROM ios_signing_sets WHERE certificate_sha256 = ? AND state = 'active' ORDER BY id DESC LIMIT 1`, [rows[0].certificate_sha256]);
    return { certificate_sha256: String(rows[0].certificate_sha256), incident: Number(rows[0].incident), last_confirmed_status: rows[0].last_confirmed_status as string | null, source: sources[0] || library[0] };
  });
  if (!task) return false;
  let result: CertificateResult;
  try { result = task.source ? await check(task.source as { secrets_key: string; certificate_sha256: string }) : unknown("source_unavailable"); }
  catch { result = unknown("checker_unavailable"); }
  await transaction(async db => {
    const confirmed = result.status !== "unknown";
    const incident = Number(task.incident) + (result.status === "revoked" && task.last_confirmed_status !== "revoked" ? 1 : 0);
    const [saved] = await db.execute<ResultSetHeader>(`UPDATE ios_certificate_checks SET status = ?, detail_code = ?, method = ?, checked_at = UTC_TIMESTAMP(3),
      last_confirmed_status = IF(?, ?, last_confirmed_status), last_confirmed_at = IF(?, UTC_TIMESTAMP(3), last_confirmed_at), response_valid_until = ?,
      next_check_at = TIMESTAMPADD(SECOND, ?, UTC_TIMESTAMP(3)), incident = ?, claim_token = NULL, claim_until = NULL WHERE certificate_sha256 = ? AND claim_token = ?`,
      [result.status, result.detail, result.method, confirmed, confirmed ? result.status : null, confirmed, result.validUntil ? new Date(result.validUntil) : null, CERTIFICATE_CHECK_SECONDS, incident, task.certificate_sha256, claim]);
    if (saved.affectedRows && result.status === "revoked") {
      const [profiles] = await db.execute<RowDataPacket[]>(`SELECT p.*, c.name AS customer_name FROM ${sourceJoin} WHERE ${digest} = ?`, [task.certificate_sha256]);
      if (profiles.length) await enqueue(db, { kind: "revoked", certificate: task.certificate_sha256, generation: String(incident), payload: { title: "Chứng chỉ Apple đã bị thu hồi", affected: profiles.map(affected) } });
    }
  });
  return true;
}
export function expiryPhase(expiry: Date, now = new Date()) {
  const days = (expiry.getTime() - now.getTime()) / 86400000;
  return days <= 0 ? "expired" : days <= 1 ? "expiry_1" : days <= 3 ? "expiry_3" : days <= 7 ? "expiry_7" : null;
}
export function profileExpiry(row: RowDataPacket) {
  // Verified package metadata takes precedence over editable inventory dates.
  const metadata = row.metadata;
  const dates = metadata ? [metadata.certificateExpiresAt, metadata.profileExpiresAt] : [row.certificate_expires_at, row.profile_expires_at];
  const times = dates.filter(Boolean).map((v: string | Date) => new Date(v).getTime()).filter(Number.isFinite);
  return times.length ? new Date(Math.min(...times)) : null;
}
export async function queueExpiryAlerts() {
  await transaction(async db => {
    const [rows] = await db.execute<RowDataPacket[]>(`SELECT p.*, c.name AS customer_name, COALESCE(a.metadata, i.metadata) AS metadata FROM ${sourceJoin}`);
    for (const row of rows) {
      const expiry = profileExpiry(row), kind = expiry && expiryPhase(expiry);
      if (!kind || !expiry) continue;
      const title = kind === "expired" ? "Bộ ký Apple đã hết hạn" : `Bộ ký Apple còn tối đa ${kind.split("_")[1]} ngày`;
      await enqueue(db, { kind, profileId: String(row.id), installationId: row.installation_id || undefined,
        generation: `${row.metadata?.certificateSha256 || row.installation_id || "manual"}:${expiry.toISOString()}`, payload: { title, expiresAt: expiry.toISOString(), affected: [affected(row)] } });
    }
  });
}
async function currentAlert(db: PoolConnection, row: RowDataPacket) {
  if (row.kind === "revoked") {
    const [checks] = await db.execute<RowDataPacket[]>(`SELECT s.last_confirmed_status, s.last_confirmed_at, s.incident FROM ios_certificate_checks s WHERE s.certificate_sha256 = ?
      AND EXISTS (SELECT 1 FROM ${sourceJoin} WHERE ${digest} = s.certificate_sha256)`, [row.certificate_sha256]);
    if (!checks.length || checks[0].last_confirmed_status !== "revoked" || String(checks[0].incident) !== row.generation) return null;
    const [profiles] = await db.execute<RowDataPacket[]>(`SELECT p.*, c.name AS customer_name FROM ${sourceJoin} WHERE ${digest} = ?`, [row.certificate_sha256]);
    return { ...row.payload, observedAt: new Date(checks[0].last_confirmed_at).toISOString(), affected: profiles.map(affected) } as CertificateAlertPayload;
  }
  const [profiles] = await db.execute<RowDataPacket[]>(`SELECT p.*, c.name AS customer_name, COALESCE(a.metadata, i.metadata) AS metadata FROM ${sourceJoin} WHERE p.id = ?`, [row.device_profile_id]);
  const profile = profiles[0], expiry = profile && profileExpiry(profile);
  if (!expiry || `${profile.metadata?.certificateSha256 || profile.installation_id || "manual"}:${expiry.toISOString()}` !== row.generation || expiryPhase(expiry) !== row.kind) return null;
  return { ...row.payload, affected: [affected(profile)] } as CertificateAlertPayload;
}
export async function deliverCertificateAlert(send = sendCertificateEmail, configured = !!mailConfig()) {
  // No SMTP settings means no delivery attempts. Pending alerts remain durable.
  if (!configured) return false;
  const claim = randomId();
  const task = await transaction(async db => {
    const [rows] = await db.execute<RowDataPacket[]>(`SELECT * FROM ios_certificate_alerts WHERE (status = 'pending' AND next_attempt_at <= UTC_TIMESTAMP(3))
      OR (status = 'sending' AND claim_until <= UTC_TIMESTAMP(3)) ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`);
    const row = rows[0]; if (!row) return null;
    const payload = await currentAlert(db, row);
    if (!payload) { await db.execute(`UPDATE ios_certificate_alerts SET status = 'cancelled', claim_token = NULL, claim_until = NULL WHERE id = ?`, [row.id]); return { cancelled: true }; }
    await db.execute(`UPDATE ios_certificate_alerts SET status = 'sending', claim_token = ?, claim_until = UTC_TIMESTAMP(3) + INTERVAL 5 MINUTE, attempts = attempts + 1 WHERE id = ?`, [claim, row.id]);
    return { cancelled: false, row, payload };
  });
  if (!task) return false;
  if (task.cancelled) return true;
  try {
    await send(task.row!.id, task.payload!);
    await getDb().execute(`UPDATE ios_certificate_alerts SET status = 'sent', sent_at = UTC_TIMESTAMP(3), last_error = NULL, claim_token = NULL, claim_until = NULL WHERE id = ? AND claim_token = ?`, [task.row!.id, claim]);
  } catch {
    const retry = Math.min(21600, 900 * 2 ** Math.min(Number(task.row!.attempts), 5));
    await getDb().execute(`UPDATE ios_certificate_alerts SET status = 'pending', last_error = 'smtp_failed', next_attempt_at = TIMESTAMPADD(SECOND, ?, UTC_TIMESTAMP(3)), claim_token = NULL, claim_until = NULL WHERE id = ? AND claim_token = ?`, [retry, task.row!.id, claim]);
  }
  return true;
}
