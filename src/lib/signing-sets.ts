import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { Admin } from './auth';
import { getDb } from './db';
import { InputError, id } from './validation';
import { storeObject, removeObject } from './install-storage';
import { inspectSigningSet } from './signing-set-inspection';
import type { SigningSet, SigningSetList, SigningSetDetail, SigningSetMetadata } from './signing-set-types';

// This is the recorded signing/monitoring identity, not proof of installation on the phone.
const observed = `COALESCE(a.certificate_sha256, CONVERT(JSON_UNQUOTE(JSON_EXTRACT(i.metadata, '$.certificateSha256')) USING ascii) COLLATE ascii_bin)`;
const deviceJoins = `customer_device_profiles p JOIN customers c ON c.id = p.customer_id
  LEFT JOIN ios_installations i ON i.id = p.installation_id
  LEFT JOIN ios_device_certificate_assets a ON a.device_profile_id = p.id AND a.bound_installation_id <=> p.installation_id`;
const fields = `s.id, s.name, s.notes, s.state, s.version, s.metadata, s.certificate_sha256, k.status AS certificate_status, k.checked_at, k.response_valid_until,
  (SELECT COUNT(*) FROM ios_signing_set_devices l WHERE l.signing_set_id = s.id) AS linked_count,
  (SELECT COUNT(*) FROM ${deviceJoins} WHERE ${observed} = s.certificate_sha256) AS observed_count`;
function publicSet(row: RowDataPacket): SigningSet {
  const metadata = row.metadata as SigningSetMetadata;
  let status = row.certificate_status || 'unknown';
  if (Date.parse(metadata.certificateExpiresAt) <= Date.now()) status = 'expired';
  else if (!row.checked_at || Date.now() - new Date(row.checked_at).getTime() > 2 * 3600000 ||
    (status === 'good' && (!row.response_valid_until || new Date(row.response_valid_until).getTime() <= Date.now()))) status = 'unknown';
  return { id: String(row.id), name: row.name, notes: row.notes, state: row.state, version: row.version, metadata,
    certificate_sha256: row.certificate_sha256, certificate_status: status, checked_at: row.checked_at,
    linked_count: Number(row.linked_count), observed_count: Number(row.observed_count) };
}
function pageNumber(params: URLSearchParams) { return Math.max(1, Math.min(1000000, Math.floor(Number(params.get('page'))) || 1)); }
function text(value: unknown, max: number, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new InputError('Tên hoặc ghi chú không hợp lệ.');
  return value.trim();
}
function version(value: unknown) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new InputError('Hãy tải lại dữ liệu trước khi thao tác.');
  return value;
}
export async function listSigningSets(params: URLSearchParams): Promise<SigningSetList> {
  const page = pageNumber(params), q = (params.get('q') || '').slice(0, 160), state = params.get('state') || 'active';
  if (!['active', 'archived', 'all'].includes(state)) throw new InputError('Trạng thái không hợp lệ.');
  const where = `WHERE (? = 'all' OR s.state = ?) AND (s.name LIKE ? OR s.certificate_sha256 LIKE ?)`;
  const args = [state, state, `%${q}%`, `%${q}%`];
  const [count] = await getDb().execute<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ios_signing_sets s ${where}`, args);
  const [rows] = await getDb().execute<RowDataPacket[]>(`SELECT ${fields} FROM ios_signing_sets s LEFT JOIN ios_certificate_checks k ON k.certificate_sha256 = s.certificate_sha256 ${where} ORDER BY s.id DESC LIMIT 25 OFFSET ${(page - 1) * 25}`, args);
  return { items: rows.map(publicSet), total: Number(count[0].n), page, pages: Math.max(1, Math.ceil(Number(count[0].n) / 25)) };
}
export async function signingSetDetail(setId: string, params = new URLSearchParams()): Promise<SigningSetDetail> {
  id(setId);
  const [sets] = await getDb().execute<RowDataPacket[]>(`SELECT ${fields} FROM ios_signing_sets s LEFT JOIN ios_certificate_checks k ON k.certificate_sha256 = s.certificate_sha256 WHERE s.id = ?`, [setId]);
  if (!sets.length) throw new InputError('Không tìm thấy bộ ký.', 404);
  const set = publicSet(sets[0]), page = pageNumber(params), q = (params.get('q') || '').slice(0, 160), mode = params.get('mode') || 'linked';
  if (!['all', 'linked', 'observed'].includes(mode)) throw new InputError('Bộ lọc không hợp lệ.');
  const joins = `${deviceJoins} LEFT JOIN ios_signing_set_devices l ON l.device_profile_id = p.id AND l.signing_set_id = ?`;
  const where = `WHERE (p.label LIKE ? OR p.apple_udid LIKE ? OR c.name LIKE ?) ${mode === 'linked' ? 'AND l.device_profile_id IS NOT NULL' : mode === 'observed' ? `AND ${observed} = ?` : ''}`;
  const args = [setId, `%${q}%`, `%${q}%`, `%${q}%`, ...(mode === 'observed' ? [set.certificate_sha256] : [])];
  const [count] = await getDb().execute<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ${joins} ${where}`, args);
  const [rows] = await getDb().execute<RowDataPacket[]>(`SELECT p.id, p.label, p.apple_udid, p.version, c.name AS customer_name, l.linked_udid, ${observed} AS recorded_sha FROM ${joins} ${where} ORDER BY p.id DESC LIMIT 25 OFFSET ${(page - 1) * 25}`, args);
  return { set, devices: rows.map(r => ({ id: String(r.id), label: r.label, apple_udid: r.apple_udid, version: r.version, customer_name: r.customer_name,
    linked: r.linked_udid !== null, linked_udid: r.linked_udid, eligible: set.metadata.udids.includes(String(r.apple_udid).toUpperCase()), observed: r.recorded_sha === set.certificate_sha256 })),
    total: Number(count[0].n), page, pages: Math.max(1, Math.ceil(Number(count[0].n) / 25)) };
}
async function audit(db: PoolConnection, admin: Admin, action: string, setId: string, details: object = {}) {
  await db.execute(`INSERT INTO audit_events (admin_id, action, target_id, details) VALUES (?, ?, ?, ?)`, [admin.id, `signing_set.${action}`, setId, JSON.stringify(details)]);
}
export async function createSigningSet(admin: Admin, form: FormData, inspect = inspectSigningSet) {
  const name = text(form.get('name'), 160, true), notes = text(form.get('notes') || '', 2000);
  const p12 = form.get('p12'), profile = form.get('profile'), password = form.get('password');
  if (!(p12 instanceof File) || !p12.size || p12.size > 1024 * 1024 || !(profile instanceof File) || !profile.size || profile.size > 2 * 1024 * 1024 || typeof password !== 'string' || password.length > 1024) throw new InputError('Chọn .p12 tối đa 1 MB, profile tối đa 2 MB và nhập mật khẩu.');
  const secrets = { p12: Buffer.from(await p12.arrayBuffer()).toString('base64'), profile: Buffer.from(await profile.arrayBuffer()).toString('base64'), password };
  const metadata = await inspect(secrets);
  const stored = await storeObject(Buffer.from(JSON.stringify(secrets)), 'secret');
  let db: PoolConnection | undefined;
  try {
    db = await getDb().getConnection();
    await db.beginTransaction();
    await db.execute(`INSERT INTO ios_signing_sets (name, notes, secrets_key, certificate_sha256, metadata) VALUES (?, ?, ?, ?, ?)`, [name, notes, stored, metadata.certificateSha256, JSON.stringify(metadata)]);
    const [created] = await db.query<RowDataPacket[]>('SELECT CAST(LAST_INSERT_ID() AS CHAR) AS id');
    const setId = String(created[0].id);
    await audit(db, admin, 'created', setId, { certificateSha256: metadata.certificateSha256, profileUuid: metadata.profileUuid });
    await db.commit();
    return { id: setId };
  } catch (e) {
    await db?.rollback().catch(() => {});
    // COMMIT can succeed even if the connection fails. Do not delete referenced secrets.
    try {
      const [used] = await getDb().execute<RowDataPacket[]>('SELECT 1 FROM ios_signing_sets WHERE secrets_key = ?', [stored]);
      if (!used.length) await removeObject(stored, 'secret');
    } catch { /* retain possible orphan for reconciliation */ }
    throw e;
  } finally { db?.release(); }
}
export async function changeSigningSet(admin: Admin, setId: string, action: string, input: Record<string, unknown>) {
  id(setId); const expected = version(input.version);
  if (!['edit', 'archive', 'restore', 'link', 'unlink'].includes(action)) throw new InputError('Không tìm thấy thao tác.', 404);
  const db = await getDb().getConnection();
  try {
    await db.beginTransaction();
    const [sets] = await db.execute<RowDataPacket[]>('SELECT id, state, version, metadata FROM ios_signing_sets WHERE id = ? FOR UPDATE', [setId]);
    if (!sets.length) throw new InputError('Không tìm thấy bộ ký.', 404);
    const set = sets[0];
    if (set.version !== expected) throw new InputError('Bộ ký vừa thay đổi. Hãy tải lại rồi thử lại.', 409);
    let details: object = {};
    if (action === 'edit') {
      await db.execute('UPDATE ios_signing_sets SET name = ?, notes = ? WHERE id = ?', [text(input.name, 160, true), text(input.notes, 2000), setId]);
    } else if (action === 'archive' || action === 'restore') {
      await db.execute('UPDATE ios_signing_sets SET state = ? WHERE id = ?', [action === 'archive' ? 'archived' : 'active', setId]);
    } else {
      const deviceId = id(input.deviceId);
      const [devices] = await db.execute<RowDataPacket[]>('SELECT id, apple_udid, version FROM customer_device_profiles WHERE id = ? FOR UPDATE', [deviceId]);
      if (!devices.length) throw new InputError('Không tìm thấy thiết bị.', 404);
      if (devices[0].version !== version(input.deviceVersion)) throw new InputError('Thiết bị vừa thay đổi. Hãy tải lại rồi thử lại.', 409);
      if (action === 'link') {
        const metadata = set.metadata as SigningSetMetadata;
        if (set.state !== 'active') throw new InputError('Khôi phục bộ ký trước khi liên kết.');
        if (Math.min(Date.parse(metadata.certificateExpiresAt), Date.parse(metadata.profileExpiresAt)) <= Date.now()) throw new InputError('Bộ ký đã hết hạn.');
        if (!metadata.udids.includes(String(devices[0].apple_udid).toUpperCase())) throw new InputError('UDID thiết bị không nằm trong profile của bộ ký.');
        await db.execute(`INSERT INTO ios_signing_set_devices (signing_set_id, device_profile_id, linked_udid) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE linked_udid = VALUES(linked_udid), created_at = UTC_TIMESTAMP(3)`, [setId, deviceId, String(devices[0].apple_udid).toUpperCase()]);
      } else await db.execute('DELETE FROM ios_signing_set_devices WHERE signing_set_id = ? AND device_profile_id = ?', [setId, deviceId]);
      details = { deviceProfileId: deviceId };
    }
    await db.execute('UPDATE ios_signing_sets SET version = version + 1, updated_at = UTC_TIMESTAMP(3) WHERE id = ?', [setId]);
    await audit(db, admin, action, setId, details);
    await db.commit();
    return { ok: true };
  } catch (e) { await db.rollback(); throw e; }
  finally { db.release(); }
}
