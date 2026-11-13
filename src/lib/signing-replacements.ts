import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { RowDataPacket, PoolConnection, ResultSetHeader } from 'mysql2/promise';
import { getDb } from './db';
import type { Admin } from './auth';
import { InputError, id } from './validation';
import { ipaReleaseId } from './ipa-releases';
import { loadSecret, objectPath, runPackager, removeObject, SigningError } from './install-storage';
import { checkCertificateAssets } from './certificate-monitor';
import { tokenHash } from './password';
import { signingError } from './installation-types';
import type { ReplacementContext } from './signing-replacement-types';

const randomId = () => randomBytes(16).toString('hex');
const eligible = `l.status <> 'revoked' AND (l.expires_at IS NULL OR l.expires_at > UTC_TIMESTAMP(3))`;
const good = `k.status = 'good' AND k.checked_at > UTC_TIMESTAMP(3) - INTERVAL 2 HOUR AND k.response_valid_until > UTC_TIMESTAMP(3)`;
const deviceSql = `SELECT p.*, c.name AS customer_name, COALESCE(a.certificate_sha256, CONVERT(JSON_UNQUOTE(JSON_EXTRACT(i.metadata, '$.certificateSha256')) USING ascii) COLLATE ascii_bin) AS old_certificate
 FROM customer_device_profiles p JOIN customers c ON c.id = p.customer_id
 LEFT JOIN ios_installations i ON i.id = p.installation_id
 LEFT JOIN ios_device_certificate_assets a ON a.device_profile_id = p.id AND a.bound_installation_id <=> p.installation_id WHERE p.id = ?`;
function replacementId(value: string) { if (!/^[a-f0-9]{32}$/.test(value)) throw new InputError('Yêu cầu không hợp lệ.'); return value; }
function version(value: unknown) { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new InputError('Hãy tải lại dữ liệu.'); return value; }
async function transaction<T>(fn: (db: PoolConnection) => Promise<T>) {
  const db = await getDb().getConnection();
  try { await db.beginTransaction(); const result = await fn(db); await db.commit(); return result; }
  catch (e) { await db.rollback().catch(() => {}); throw e; } finally { db.release(); }
}
function usable(set: RowDataPacket, udid: string) {
  const m = set.metadata;
  if (set.state !== 'active' || !m.udids.includes(udid.toUpperCase()) ||
      !(Date.parse(m.certificateExpiresAt) > Date.now()) || !(Date.parse(m.profileExpiresAt) > Date.now())) throw new InputError('Bộ ký cần còn hạn, đang quản lý và chứa đúng UDID.', 409);
}
function unchanged(p: RowDataPacket | undefined, snapshot: RowDataPacket) {
  if (!p || p.version !== snapshot.version || String(p.license_id) !== snapshot.licenseId || String(p.customer_id) !== snapshot.customerId ||
      p.apple_udid !== snapshot.udid || p.installation_id !== snapshot.oldInstallationId) throw new InputError('Hồ sơ đã thay đổi. Hủy yêu cầu này và tạo lại từ dữ liệu mới.', 409);
}
async function validLicense(db: PoolConnection, licenseId: string, customerId: string) {
  const [rows] = await db.execute<RowDataPacket[]>(`SELECT l.id FROM licenses l JOIN license_identities li ON li.license_id = l.id WHERE l.id = ? AND l.customer_id = ? AND ${eligible} FOR SHARE`, [licenseId, customerId]);
  if (!rows.length) throw new InputError('Key cần còn hiệu lực và đã gán cấu hình thiết bị.', 409);
}
async function validSet(db: PoolConnection, setId: string, udid: string) {
  const [sets] = await db.execute<RowDataPacket[]>(`SELECT s.* FROM ios_signing_sets s JOIN ios_certificate_checks k ON k.certificate_sha256 = s.certificate_sha256 WHERE s.id = ? AND ${good} FOR SHARE`, [setId]);
  if (!sets.length) throw new InputError('Chưa có xác nhận Apple hợp lệ gần đây cho bộ ký mới. Hãy kiểm tra certificate worker rồi tải lại.', 409);
  usable(sets[0], udid); return sets[0];
}
export async function replacementContext(deviceId: string): Promise<ReplacementContext> {
  id(deviceId);
  const [devices] = await getDb().execute<RowDataPacket[]>(deviceSql, [deviceId]);
  if (!devices.length) throw new InputError('Không tìm thấy thiết bị.', 404);
  const p = devices[0];
  const [sets] = await getDb().execute<RowDataPacket[]>(`SELECT s.id, s.name, s.version, s.certificate_sha256, s.metadata, s.state FROM ios_signing_sets s JOIN ios_certificate_checks k ON k.certificate_sha256 = s.certificate_sha256 WHERE s.state = 'active' AND ${good} ORDER BY s.id DESC`);
  const [releases] = await getDb().execute<RowDataPacket[]>('SELECT id, label, version FROM ios_ipa_releases WHERE state = \'active\' ORDER BY created_at DESC');
  const [history] = await getDb().execute<RowDataPacket[]>(`SELECT id, status, snapshot, error_code, created_at, issued_at, installation_id FROM ios_signing_replacements WHERE device_profile_id = ? ORDER BY created_at DESC LIMIT 30`, [deviceId]);
  return { device: { id: String(p.id), label: p.label, apple_udid: p.apple_udid, version: p.version, customer_name: p.customer_name, license_id: p.license_id ? String(p.license_id) : null },
    sets: sets.filter(s => { try { usable(s, p.apple_udid); return true; } catch { return false; } }).map(s => ({ id: String(s.id), name: s.name, version: s.version, certificate_sha256: s.certificate_sha256 })),
    releases: releases.map(r => ({ id: r.id, label: r.label, version: r.version })),
    history: history.map(r => ({ id: r.id, status: r.status, set_name: r.snapshot.setName, release_label: r.snapshot.releaseLabel, old_certificate: r.snapshot.oldCertificate, new_certificate: r.snapshot.certificateSha256,
      created_at: r.created_at, issued_at: r.issued_at, installation_id: r.installation_id, error: r.error_code ? signingError(r.error_code) : null })) };
}
export async function queueReplacement(admin: Admin, deviceId: string, input: Record<string, unknown>) {
  id(deviceId); const setId = id(input.setId), releaseId = ipaReleaseId(input.releaseId);
  return transaction(async db => {
    const [devices] = await db.execute<RowDataPacket[]>(deviceSql + ' FOR UPDATE', [deviceId]);
    const p = devices[0];
    if (!p || p.version !== version(input.deviceVersion)) throw new InputError('Thiết bị vừa thay đổi. Hãy tải lại.', 409);
    if (!p.license_id) throw new InputError('Gắn key cho hồ sơ trước khi thay bộ ký.', 409);
    await validLicense(db, String(p.license_id), String(p.customer_id));
    const [active] = await db.execute<RowDataPacket[]>(`SELECT id FROM ios_signing_replacements WHERE active_device = ?`, [deviceId]);
    if (active.length) throw new InputError('Thiết bị đã có yêu cầu đang xử lý. Xem lịch sử hoặc hủy yêu cầu cũ.', 409);
    const [count] = await db.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ios_signing_replacements WHERE status IN ('queued','signing')`);
    if (Number(count[0].n) >= 50) throw new InputError('Hàng đợi đang đầy. Hãy thử lại sau.', 429);
    const set = await validSet(db, setId, p.apple_udid);
    if (set.version !== version(input.setVersion)) throw new InputError('Bộ ký vừa thay đổi. Hãy tải lại.', 409);
    const [releases] = await db.execute<RowDataPacket[]>(`SELECT * FROM ios_ipa_releases WHERE id = ? AND state = 'active' FOR SHARE`, [releaseId]);
    const release = releases[0];
    if (!release || release.version !== version(input.releaseVersion)) throw new InputError('Phiên bản IPA vừa thay đổi. Hãy tải lại.', 409);
    const snapshot = { version: p.version, licenseId: String(p.license_id), customerId: String(p.customer_id), udid: p.apple_udid, label: p.label,
      oldInstallationId: p.installation_id, oldCertificate: p.old_certificate || null, certificateSha256: set.certificate_sha256,
      sourceSha256: release.source_sha256, setName: set.name, releaseLabel: release.label };
    const target = randomId();
    await db.execute(`INSERT INTO ios_signing_replacements (id, device_profile_id, signing_set_id, release_id, snapshot) VALUES (?, ?, ?, ?, ?)`, [target, deviceId, setId, releaseId, JSON.stringify(snapshot)]);
    await db.execute(`INSERT INTO audit_events (admin_id, action, target_id, details) VALUES (?, 'replacement.queued', ?, ?)`, [admin.id, target, JSON.stringify({ deviceId, setId, releaseId, oldInstallationId: p.installation_id })]);
    return { id: target };
  });
}
export async function cancelReplacement(admin: Admin, target: string) {
  replacementId(target);
  return transaction(async db => {
    const [rows] = await db.execute<RowDataPacket[]>(`SELECT status FROM ios_signing_replacements WHERE id = ? FOR UPDATE`, [target]);
    if (!rows.length || !['queued','signing','ready'].includes(rows[0].status)) throw new InputError('Yêu cầu đã kết thúc. Hãy tải lại.', 409);
    await db.execute(`UPDATE ios_signing_replacements SET status = 'cancelled', claim_token = NULL, finished_at = UTC_TIMESTAMP(3) WHERE id = ?`, [target]);
    await db.execute(`INSERT INTO audit_events (admin_id, action, target_id) VALUES (?, 'replacement.cancelled', ?)`, [admin.id, target]);
    return { ok: true };
  });
}
async function outputDigest(key: string) {
  const hash = createHash('sha256'); for await (const chunk of createReadStream(objectPath(key, 'ipa'))) hash.update(chunk); return hash.digest('hex');
}
export async function issueReplacement(admin: Admin, target: string, check = checkCertificateAssets) {
  replacementId(target);
  // Check the actual artifact before granting access, without holding database locks during file IO.
  const [outputs] = await getDb().execute<RowDataPacket[]>(`SELECT r.output_key, r.output_sha256, s.secrets_key, s.certificate_sha256 FROM ios_signing_replacements r JOIN ios_signing_sets s ON s.id = r.signing_set_id WHERE r.id = ? AND r.status = 'ready'`, [target]);
  if (!outputs.length || !outputs[0].output_key) throw new InputError('IPA chưa sẵn sàng hoặc đã cấp. Hãy tải lại.', 409);
  const evidence = await check({ secrets_key: outputs[0].secrets_key, certificate_sha256: outputs[0].certificate_sha256 });
  if (evidence.status !== 'good' || !evidence.method || !evidence.validUntil || !(Date.parse(evidence.validUntil) > Date.now())) throw new InputError('Chưa xác nhận được chứng chỉ hợp lệ qua Apple. Chưa cấp link cài lại.', 409);
  let digest: string;
  try { digest = await outputDigest(outputs[0].output_key); } catch { throw new InputError('Không đọc được IPA đã ký. Hãy tạo yêu cầu mới.', 409); }
  if (digest !== outputs[0].output_sha256) throw new InputError('IPA đã ký bị thay đổi. Hãy hủy yêu cầu và ký lại.', 409);
  return transaction(async db => {
    const [rows] = await db.execute<RowDataPacket[]>(`SELECT * FROM ios_signing_replacements WHERE id = ? FOR UPDATE`, [target]);
    const r = rows[0];
    if (!r || r.status !== 'ready' || r.output_key !== outputs[0].output_key || r.output_sha256 !== digest) throw new InputError('Yêu cầu vừa thay đổi. Hãy tải lại.', 409);
    if (!(Date.parse(evidence.validUntil!) > Date.now())) throw new InputError('Xác nhận Apple đã hết hiệu lực. Hãy thử cấp link lại.', 409);
    const snap = r.snapshot;
    const [profiles] = await db.execute<RowDataPacket[]>('SELECT * FROM customer_device_profiles WHERE id = ? FOR UPDATE', [r.device_profile_id]);
    unchanged(profiles[0], snap);
    await validLicense(db, snap.licenseId, snap.customerId);
    const set = await validSet(db, String(r.signing_set_id), snap.udid);
    if (set.certificate_sha256 !== snap.certificateSha256 || r.metadata.certificateSha256 !== snap.certificateSha256 || r.metadata.sourceSha256 !== snap.sourceSha256) throw new InputError('Tài liệu ký đã thay đổi.', 409);
    const [releases] = await db.execute<RowDataPacket[]>(`SELECT * FROM ios_ipa_releases WHERE id = ? AND state = 'active' AND source_sha256 = ? FOR SHARE`, [r.release_id, snap.sourceSha256]);
    if (!releases.length) throw new InputError('Phiên bản IPA đã được lưu trữ hoặc thay đổi.', 409);
    const installId = randomId(), code = randomUUID();
    await db.execute(`INSERT INTO ios_installations (id, license_id, label, apple_udid, code_hash, source_key, secrets_key, metadata, release_id, code_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3) + INTERVAL 15 MINUTE)`,
      [installId, snap.licenseId, snap.label, snap.udid, tokenHash(code), releases[0].source_key, set.secrets_key, JSON.stringify(r.metadata), r.release_id]);
    await db.execute(`INSERT INTO ios_signing_jobs (id, installation_id, status, output_key, output_sha256, finished_at) VALUES (?, ?, 'ready', ?, ?, UTC_TIMESTAMP(3))`, [randomId(), installId, r.output_key, r.output_sha256]);
    await db.execute(`UPDATE customer_device_profiles SET installation_id = ?, signing_label = ?, certificate_expires_at = ?, profile_expires_at = ?, version = version + 1, updated_at = UTC_TIMESTAMP(3) WHERE id = ?`,
      [installId, String(set.name).slice(0,120), new Date(r.metadata.certificateExpiresAt), new Date(r.metadata.profileExpiresAt), r.device_profile_id]);
    await db.execute(`INSERT INTO ios_signing_set_devices (signing_set_id, device_profile_id, linked_udid) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE linked_udid = VALUES(linked_udid)`, [r.signing_set_id, r.device_profile_id, snap.udid]);
    await db.execute(`UPDATE ios_signing_replacements SET status = 'issued', installation_id = ?, issued_at = UTC_TIMESTAMP(3) WHERE id = ?`, [installId, target]);
    await db.execute(`INSERT INTO audit_events (admin_id, action, target_id, details) VALUES (?, 'replacement.issued', ?, ?)`, [admin.id, target, JSON.stringify({ deviceId: String(r.device_profile_id), oldInstallationId: snap.oldInstallationId, installationId: installId, signingSetId: String(r.signing_set_id) })]);
    const [expiry] = await db.execute<RowDataPacket[]>('SELECT code_expires_at FROM ios_installations WHERE id = ?', [installId]);
    return { installationId: installId, code, expiresAt: expiry[0].code_expires_at };
  });
}

export async function runReplacementJob(pack = runPackager, check = checkCertificateAssets, onlyId?: string) {
  if (onlyId) replacementId(onlyId);
  await getDb().execute(`UPDATE ios_signing_replacements SET status = 'failed', error_code = 'worker_interrupted', claim_token = NULL, finished_at = UTC_TIMESTAMP(3) WHERE status = 'signing' AND heartbeat_at < UTC_TIMESTAMP(3) - INTERVAL 20 MINUTE`);
  const claim = randomId();
  const job = await transaction(async db => {
    const [rows] = await db.execute<RowDataPacket[]>(`SELECT * FROM ios_signing_replacements WHERE status = 'queued' ${onlyId ? 'AND id = ?' : ''} ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`, onlyId ? [onlyId] : []);
    if (!rows.length) return null;
    await db.execute(`UPDATE ios_signing_replacements SET status = 'signing', claim_token = ?, heartbeat_at = UTC_TIMESTAMP(3) WHERE id = ?`, [claim, rows[0].id]);
    return rows[0];
  });
  if (!job) return false;
  const output = randomId();
  const heartbeat = setInterval(() => { void getDb().execute(`UPDATE ios_signing_replacements SET heartbeat_at = UTC_TIMESTAMP(3) WHERE id = ? AND claim_token = ?`, [job.id, claim]).catch(() => {}); }, 30000);
  try {
    const source = await transaction(async db => {
      const [profiles] = await db.execute<RowDataPacket[]>('SELECT * FROM customer_device_profiles WHERE id = ? FOR SHARE', [job.device_profile_id]);
      unchanged(profiles[0], job.snapshot);
      await validLicense(db, job.snapshot.licenseId, job.snapshot.customerId);
      const set = await validSet(db, String(job.signing_set_id), job.snapshot.udid);
      const [releases] = await db.execute<RowDataPacket[]>(`SELECT * FROM ios_ipa_releases WHERE id = ? AND state = 'active' AND source_sha256 = ? FOR SHARE`, [job.release_id, job.snapshot.sourceSha256]);
      if (!releases.length) throw new SigningError('source_changed');
      return { set, release: releases[0] };
    });
    const evidence = await check({ secrets_key: source.set.secrets_key, certificate_sha256: source.set.certificate_sha256 });
    if (evidence.status !== 'good' || !evidence.method || !evidence.validUntil || !(Date.parse(evidence.validUntil) > Date.now())) throw new SigningError('certificate_not_verified');
    const secrets = await loadSecret(source.set.secrets_key);
    const result = await pack({ ...secrets, mode: 'sign', source: objectPath(source.release.source_key, 'ipa'), udid: job.snapshot.udid, expectedSourceSha256: job.snapshot.sourceSha256, output: objectPath(output, 'ipa') });
    if (!result.verified || !/^[a-f0-9]{64}$/.test(result.outputSha256 || '') || result.sourceSha256 !== job.snapshot.sourceSha256 || result.certificateSha256 !== job.snapshot.certificateSha256) throw new SigningError('signature_verification_failed');
    if (await outputDigest(output) !== result.outputSha256) throw new SigningError('signature_verification_failed');
    const { verified: _verified, outputSha256: _sha, ...metadata } = result;
    void _verified; void _sha;
    const [saved] = await getDb().execute<ResultSetHeader>(`UPDATE ios_signing_replacements SET status = 'ready', metadata = ?, output_key = ?, output_sha256 = ?, finished_at = UTC_TIMESTAMP(3), claim_token = NULL WHERE id = ? AND status = 'signing' AND claim_token = ?`, [JSON.stringify(metadata), output, result.outputSha256, job.id, claim]);
    if (!saved.affectedRows) await removeObject(output, 'ipa');
  } catch (e) {
    // An interrupted COMMIT/UPDATE may already have published this artifact.
    // Keep it if referenced or if DB availability prevents determining ownership.
    try {
      const [used] = await getDb().execute<RowDataPacket[]>('SELECT 1 FROM ios_signing_replacements WHERE output_key = ?', [output]);
      if (!used.length) await removeObject(output, 'ipa');
    } catch { /* deferred orphan cleanup */ }
    const error = e instanceof SigningError ? e.code : e instanceof InputError ? 'replacement_changed' : 'signing_failed';
    await getDb().execute(`UPDATE ios_signing_replacements SET status = 'failed', error_code = ?, finished_at = UTC_TIMESTAMP(3), claim_token = NULL WHERE id = ? AND status = 'signing' AND claim_token = ?`, [error, job.id, claim]);
  } finally { clearInterval(heartbeat); }
  return true;
}
