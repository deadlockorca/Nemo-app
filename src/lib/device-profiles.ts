import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { getDb } from "./db";
import type { Admin } from "./auth";
import { monitorSummary } from "./certificate-monitor";
import { InputError, id } from "./validation";
import type { PackageMetadata } from "./installation-types";

const fields = `p.*, c.name AS customer_name, l.key_hint, l.expires_at AS key_expires_at,
  CASE WHEN l.status = 'active' AND l.expires_at <= UTC_TIMESTAMP(3) THEN 'expired' ELSE l.status END AS key_status,
  d.fingerprint, d.last_seen_at, COALESCE(a.metadata, i.metadata) AS monitor_metadata, a.device_profile_id AS monitor_assets_id,
  s.status AS certificate_status, s.detail_code AS certificate_detail, s.checked_at AS certificate_checked_at,
  s.last_confirmed_status AS certificate_last_confirmed_status, s.last_confirmed_at AS certificate_last_confirmed_at,
  s.response_valid_until AS certificate_valid_until, s.next_check_at AS certificate_next_check_at`;
const joins = `customer_device_profiles p JOIN customers c ON c.id = p.customer_id
  LEFT JOIN licenses l ON l.id = p.license_id LEFT JOIN devices d ON d.license_id = l.id
  LEFT JOIN ios_installations i ON i.id = p.installation_id
  LEFT JOIN ios_device_certificate_assets a ON a.device_profile_id = p.id AND a.bound_installation_id <=> p.installation_id
  LEFT JOIN ios_certificate_checks s ON s.certificate_sha256 = COALESCE(a.certificate_sha256, CONVERT(JSON_UNQUOTE(JSON_EXTRACT(i.metadata, '$.certificateSha256')) USING ascii) COLLATE ascii_bin)`;

export async function listDeviceProfiles(params: URLSearchParams) {
  const q = (params.get("q") || "").trim().slice(0, 120);
  const customerId = params.get("customerId");
  let where = "1 = 1";
  const values: string[] = [];
  if (customerId) { where += " AND p.customer_id = ?"; values.push(id(customerId)); }
  if (q) {
    where += ` AND (c.name LIKE ? OR p.label LIKE ? OR CONVERT(p.apple_udid USING utf8mb4) LIKE ? OR p.signing_label LIKE ?
      OR p.model LIKE ? OR l.key_hint LIKE ? OR CAST(l.id AS CHAR) = ?)`;
    values.push(...Array<string>(6).fill(`%${q}%`), q);
  }
  const db = getDb();
  const [count] = await db.execute<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM ${joins} WHERE ${where}`, values);
  const total = Number(count[0].n), pages = Math.max(1, Math.ceil(total / 25));
  const page = Math.min(pages, Math.max(1, Number.parseInt(params.get("page") || "1", 10) || 1));
  const [items] = await db.execute<RowDataPacket[]>(`SELECT ${fields} FROM ${joins} WHERE ${where} ORDER BY p.id DESC LIMIT 25 OFFSET ${(page - 1) * 25}`, values);
  const now = Date.now();
  return { items: items.map((row): RowDataPacket => {
    const metadata = row.monitor_metadata;
    const certExpiry = metadata?.certificateExpiresAt || row.certificate_expires_at;
    const profileExpiry = metadata?.profileExpiresAt || row.profile_expires_at;
    const expired = [certExpiry, profileExpiry].some(d => d && new Date(d).getTime() <= now);
    let status = row.certificate_status || "unknown", detail = row.certificate_detail || ((row.installation_id || row.monitor_assets_id) ? "not_checked" : "no_assets");
    if (expired) { status = "expired"; detail = certExpiry && new Date(certExpiry).getTime() <= now ? "certificate_expired" : "profile_expired"; }
    else if ((row.certificate_checked_at && now - new Date(row.certificate_checked_at).getTime() > 2 * 3600000) ||
      (status === "good" && (!row.certificate_valid_until || new Date(row.certificate_valid_until).getTime() <= now))) { status = "unknown"; detail = "stale"; }
    const { monitor_metadata: _privateMetadata, monitor_assets_id: _privateAssetId, ...item } = row;
    void _privateMetadata; void _privateAssetId;
    return { ...item, certificate_expires_at: certExpiry || null, profile_expires_at: profileExpiry || null, certificate_monitor_attached: !!_privateAssetId, certificate_status: status, certificate_detail: detail };
  }), total, page, pages, monitor: await monitorSummary() };
}

function text(value: unknown, max: number, required = false) {
  if (value != null && typeof value !== "string") throw new InputError("Thông tin thiết bị phải là văn bản.");
  const result = (typeof value === "string" ? value : "").trim();
  if ((required && !result) || Array.from(result).length > max || result.includes("\0")) throw new InputError(`Thông tin cần ${required ? 1 : 0}–${max} ký tự.`);
  return result;
}
function date(value: unknown) {
  if (value === "" || value == null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19)) throw new InputError("Ngày hết hạn không hợp lệ.");
  return new Date(value);
}
export function parseDeviceProfile(data: Record<string, unknown>) {
  const udid = text(data.appleUdid, 40, true).toUpperCase();
  if (!/^(?:[0-9A-F]{8}-[0-9A-F]{16}|[0-9A-F]{40})$/.test(udid)) throw new InputError("Nhập UDID Apple, không phải fingerprint hay hai ID của Nemo.");
  return { customerId: id(data.customerId), licenseId: data.licenseId ? id(data.licenseId) : null,
    label: text(data.label, 120, true), model: text(data.model, 80), udid,
    signingLabel: text(data.signingLabel, 120), notes: text(data.notes, 2000),
    certificateExpiry: date(data.certificateExpiresAt), profileExpiry: date(data.profileExpiresAt) };
}

export async function saveDeviceProfile(admin: Admin, data: Record<string, unknown>, profileId?: string) {
  if (profileId) id(profileId);
  const input = parseDeviceProfile(data), db = await getDb().getConnection();
  try {
    await db.beginTransaction();
    const [customers] = await db.execute<RowDataPacket[]>(`SELECT id FROM customers WHERE id = ?`, [input.customerId]);
    if (!customers.length) throw new InputError("Không tìm thấy khách hàng.", 404);
    if (input.licenseId) {
      const [licenses] = await db.execute<RowDataPacket[]>(`SELECT customer_id FROM licenses WHERE id = ? FOR UPDATE`, [input.licenseId]);
      if (!licenses.length || String(licenses[0].customer_id) !== input.customerId) throw new InputError("Key phải thuộc đúng khách hàng của thiết bị.", 409);
    }
    let before: RowDataPacket | undefined;
    if (profileId) {
      const [rows] = await db.execute<RowDataPacket[]>(`SELECT * FROM customer_device_profiles WHERE id = ? FOR UPDATE`, [profileId]);
      before = rows[0];
      if (!before) throw new InputError("Không tìm thấy hồ sơ thiết bị.", 404);
      if (before.version !== data.version) throw new InputError("Hồ sơ đã thay đổi. Hãy tải lại trước khi sửa.", 409);
      if (String(before.customer_id) !== input.customerId) throw new InputError("Không chuyển hồ sơ sang khách khác. Hãy tạo hồ sơ đúng khách.", 409);
      if (before.apple_udid !== input.udid) {
        const [assets] = await db.execute<RowDataPacket[]>(`SELECT device_profile_id FROM ios_device_certificate_assets WHERE device_profile_id = ?`, [profileId]);
        if (assets.length) throw new InputError("Hồ sơ đã gắn profile theo dõi. Giữ nguyên UDID; tạo hồ sơ mới khi đổi máy.", 409);
      }
      if (before.installation_id && (before.apple_udid !== input.udid || String(before.license_id) !== input.licenseId)) throw new InputError("Hồ sơ đã gắn bản cài. Giữ nguyên UDID và key; tạo hồ sơ mới khi đổi máy.", 409);
    }
    const values = [input.label, input.model || null, input.udid, input.signingLabel || null,
      input.certificateExpiry, input.profileExpiry, input.notes || null, input.licenseId];
    let savedId = profileId;
    if (profileId) await db.execute(`UPDATE customer_device_profiles SET label = ?, model = ?, apple_udid = ?, signing_label = ?,
      certificate_expires_at = ?, profile_expires_at = ?, notes = ?, license_id = ?, version = version + 1, updated_at = UTC_TIMESTAMP(3) WHERE id = ?`, [...values, profileId]);
    else {
      const [created] = await db.execute<ResultSetHeader>(`INSERT INTO customer_device_profiles
        (label, model, apple_udid, signing_label, certificate_expires_at, profile_expires_at, notes, license_id, customer_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [...values, input.customerId]);
      savedId = String(created.insertId);
    }
    if (!savedId) throw new Error("Missing saved device profile ID");
    await db.execute(`INSERT INTO audit_events (admin_id, action, target_id, details) VALUES (?, ?, ?, ?)`,
      [admin.id, profileId ? "device_profile.updated" : "device_profile.created", savedId,
        JSON.stringify({ customerId: input.customerId, licenseId: input.licenseId, label: input.label, appleUdid: input.udid, signingLabel: input.signingLabel })]);
    await db.commit();
    return { id: savedId };
  } catch (e) {
    await db.rollback();
    if ((e as { code?: string }).code === "ER_DUP_ENTRY") throw new InputError("UDID hoặc key này đã gắn với một hồ sơ thiết bị. Hãy tìm và sửa hồ sơ hiện có.", 409);
    throw e;
  } finally { db.release(); }
}

export async function deleteDeviceProfile(admin: Admin, profileId: string, data: Record<string, unknown>) {
  id(profileId);
  if (typeof data.version !== "number" || !Number.isInteger(data.version) || data.version < 1) throw new InputError("Thiếu phiên bản hồ sơ. Hãy tải lại danh sách.");
  const db = await getDb().getConnection();
  try {
    await db.beginTransaction();
    const [rows] = await db.execute<RowDataPacket[]>(`SELECT * FROM customer_device_profiles WHERE id = ? FOR UPDATE`, [profileId]);
    const row = rows[0];
    if (!row) throw new InputError("Không tìm thấy hồ sơ thiết bị.", 404);
    if (row.version !== data.version) throw new InputError("Hồ sơ đã thay đổi. Hãy tải lại trước khi xóa.", 409);
    if (row.installation_id || row.license_id) throw new InputError("Hồ sơ còn gắn key hoặc bản cài. Hãy xóa key liên quan trước; nếu chưa có bản cài, có thể bỏ gắn key trong Chỉnh sửa.", 409);
    await db.execute(`DELETE FROM customer_device_profiles WHERE id = ?`, [profileId]);
    await db.execute(`INSERT INTO audit_events (admin_id, action, target_id, details) VALUES (?, 'device_profile.deleted', ?, ?)`,
      [admin.id, profileId, JSON.stringify({ customerId: String(row.customer_id), label: row.label })]);
    await db.commit();
    return { id: profileId };
  } catch (e) { await db.rollback(); throw e; }
  finally { db.release(); }
}

// Called inside the installation transaction, after the license has been locked
// and both the Apple profile and P12 have been verified. Never updates licenses
// or activation fingerprints. User-entered labels/model/notes are retained.
export async function attachVerifiedInstallation(db: PoolConnection, admin: Admin, input: {
  customerId: string; licenseId: string; udid: string; label: string;
  signingLabel: string; installationId: string; metadata: PackageMetadata;
}) {
  const [rows] = await db.execute<RowDataPacket[]>(`SELECT * FROM customer_device_profiles WHERE apple_udid = ? OR license_id = ? FOR UPDATE`, [input.udid, input.licenseId]);
  if (rows.length > 1 || (rows[0] && (String(rows[0].customer_id) !== input.customerId || rows[0].apple_udid !== input.udid ||
    (rows[0].license_id && String(rows[0].license_id) !== input.licenseId)))) throw new InputError("UDID hoặc key đang thuộc hồ sơ khác. Hãy kiểm tra mục Thiết bị trước khi tạo bản cài.", 409);
  const dates = [new Date(input.metadata.certificateExpiresAt), new Date(input.metadata.profileExpiresAt)];
  let profileId: string;
  if (rows[0]) {
    profileId = String(rows[0].id);
    await db.execute(`UPDATE customer_device_profiles SET license_id = ?, signing_label = COALESCE(NULLIF(?, ''), signing_label),
      certificate_expires_at = ?, profile_expires_at = ?, installation_id = ?, version = version + 1, updated_at = UTC_TIMESTAMP(3) WHERE id = ?`,
      [input.licenseId, input.signingLabel, ...dates, input.installationId, profileId]);
  } else {
    const [result] = await db.execute<ResultSetHeader>(`INSERT INTO customer_device_profiles
      (customer_id, license_id, label, apple_udid, signing_label, certificate_expires_at, profile_expires_at, installation_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [input.customerId, input.licenseId, input.label, input.udid, input.signingLabel || null, ...dates, input.installationId]);
    profileId = String(result.insertId);
  }
  await db.execute(`INSERT INTO audit_events (admin_id, action, target_id, details) VALUES (?, 'device_profile.installation_linked', ?, ?)`,
    [admin.id, profileId, JSON.stringify({ installationId: input.installationId, licenseId: input.licenseId })]);
}
