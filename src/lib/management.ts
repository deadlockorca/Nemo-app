import "server-only";
import { randomBytes } from "node:crypto";
import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { getDb } from "./db";
import { tokenHash } from "./password";
import type { Admin } from "./auth";
import { parseIdentityConfig, type IdentityConfig } from "./identity-config";

import { InputError, id } from "./validation";
export { InputError, record, id } from "./validation";
function text(value: unknown, max: number, required = false) {
  if (value !== undefined && value !== null && typeof value !== "string") throw new InputError("Nội dung phải là văn bản.");
  const result = ((value as string) || "").trim();
  if ((required && !result) || Array.from(result).length > max || /\u0000/.test(result)) throw new InputError(`Nội dung cần ${required ? '1' : '0'}–${max} ký tự.`);
  return result;
}
function days(value: unknown) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 365) throw new InputError("Số ngày phải từ 1 đến 365.");
  return value;
}
function revision(value: unknown) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new InputError("Thiếu phiên bản bản ghi. Hãy tải lại trang.");
  return value;
}
function expectVersion(expected: unknown, actual: number) {
  if (revision(expected) !== actual) throw new InputError("Dữ liệu đã thay đổi. Hãy tải lại danh sách trước khi thao tác.", 409);
}
async function transaction<T>(fn: (db: PoolConnection) => Promise<T>) {
  const db = await getDb().getConnection();
  try { await db.beginTransaction(); const value = await fn(db); await db.commit(); return value; }
  catch (error) { await db.rollback(); throw error; }
  finally { db.release(); }
}
async function audit(db: PoolConnection, admin: Admin, action: string, target: string, details: object) {
  await db.execute(`INSERT INTO audit_events (admin_id, action, target_id, details) VALUES (?, ?, ?, ?)`, [admin.id, action, target, JSON.stringify(details)]);
}

export async function saveCustomer(admin: Admin, data: Record<string, unknown>, customerId?: string) {
  const name = text(data.name, 120, true);
  const contact = text(data.contact, 254);
  const notes = text(data.notes, 2000);
  return transaction(async (db) => {
    if (!customerId) {
      const [result] = await db.execute<ResultSetHeader>(`INSERT INTO customers (name, contact, notes) VALUES (?, ?, ?)`, [name, contact || null, notes || null]);
      const newId = String(result.insertId);
      await audit(db, admin, "customer.created", newId, { name });
      return { id: newId };
    }
    id(customerId);
    const [rows] = await db.execute<(RowDataPacket & { name: string; version: number })[]>(`SELECT name, version FROM customers WHERE id = ? FOR UPDATE`, [customerId]);
    if (!rows[0]) throw new InputError("Không tìm thấy khách hàng.", 404);
    expectVersion(data.version, rows[0].version);
    await db.execute(`UPDATE customers SET name = ?, contact = ?, notes = ?, version = version + 1 WHERE id = ?`, [name, contact || null, notes || null, customerId]);
    await audit(db, admin, "customer.updated", customerId, { before: rows[0].name, after: name });
    return { id: customerId };
  });
}

export async function deleteCustomer(admin: Admin, customerId: string, data: Record<string, unknown>) {
  id(customerId);
  return transaction(async (db) => {
    const [rows] = await db.execute<RowDataPacket[]>(`SELECT name, version FROM customers WHERE id = ? FOR UPDATE`, [customerId]);
    if (!rows[0]) throw new InputError("Không tìm thấy khách hàng.", 404);
    expectVersion(data.version, rows[0].version);
    const [licenses] = await db.execute<RowDataPacket[]>(`SELECT id FROM licenses WHERE customer_id = ? LIMIT 1 FOR UPDATE`, [customerId]);
    if (licenses.length) throw new InputError("Khách hàng còn key. Hãy xóa các key của khách trước khi xóa khách hàng.", 409);
    const [profiles] = await db.execute<RowDataPacket[]>(`SELECT id FROM customer_device_profiles WHERE customer_id = ? LIMIT 1 FOR UPDATE`, [customerId]);
    if (profiles.length) throw new InputError("Khách hàng còn hồ sơ thiết bị. Hãy xóa các hồ sơ đó trước khi xóa khách hàng.", 409);
    await db.execute(`DELETE FROM customers WHERE id = ?`, [customerId]);
    await audit(db, admin, "customer.deleted", customerId, { name: rows[0].name });
    return { id: customerId };
  });
}

export async function createLicense(admin: Admin, data: Record<string, unknown>) {
  const customerId = id(data.customerId);
  const duration = days(data.durationDays ?? 30);
  let identity: IdentityConfig | undefined;
  if (data.identity !== undefined) {
    try { identity = parseIdentityConfig(data.identity); }
    catch (error) { throw new InputError((error as Error).message); }
  }
  // 160 random bits; raw keys are returned once and never persisted or logged.
  const rawKey = `NEMO-${randomBytes(20).toString("hex").toUpperCase().match(/.{8}/g)!.join("-")}`;
  return transaction(async (db) => {
    const [customers] = await db.execute<RowDataPacket[]>(`SELECT id FROM customers WHERE id = ? FOR SHARE`, [customerId]);
    if (!customers[0]) throw new InputError("Không tìm thấy khách hàng.", 404);
    const [result] = await db.execute<ResultSetHeader>(
      `INSERT INTO licenses (customer_id, key_hash, key_hint, duration_days, status, activated_at, expires_at)
       VALUES (?, ?, ?, ?, 'active', UTC_TIMESTAMP(3), TIMESTAMPADD(DAY, ?, UTC_TIMESTAMP(3)))`,
      [customerId, tokenHash(rawKey), rawKey.slice(-8), duration, duration],
    );
    const newId = String(result.insertId);
    if (identity) await db.execute(`INSERT INTO license_identities (license_id, device_id, registration_uuid) VALUES (?, ?, ?)`, [newId, identity.device_id, identity.uuid]);
    await audit(db, admin, "license.created", newId, { customerId, durationDays: duration, hasIdentity: Boolean(identity) });
    return { id: newId, key: rawKey };
  });
}

export async function saveLicenseIdentity(admin: Admin, licenseId: string, data: Record<string, unknown>) {
  id(licenseId);
  let identity: IdentityConfig;
  try { identity = parseIdentityConfig(data.identity); }
  catch (error) { throw new InputError((error as Error).message); }
  return transaction(async (db) => {
    const [licenses] = await db.execute<(RowDataPacket & { version: number; status: string })[]>(
      `SELECT version, status FROM licenses WHERE id = ? FOR UPDATE`, [licenseId]);
    if (!licenses[0]) throw new InputError("Không tìm thấy key.", 404);
    expectVersion(data.version, licenses[0].version);
    if (licenses[0].status === "revoked") throw new InputError("Hãy khôi phục key trước khi gán cấu hình.", 409);
    const [before] = await db.execute<(RowDataPacket & { device_id: string; registration_uuid: string })[]>(
      `SELECT device_id, registration_uuid FROM license_identities WHERE license_id = ?`, [licenseId]);
    if (before[0]?.device_id === identity.device_id && before[0]?.registration_uuid === identity.uuid) return { id: licenseId, unchanged: true };
    // Replacement after activation is explicit, because the next lease changes the app's IDs.
    const [devices] = await db.execute<RowDataPacket[]>(`SELECT id FROM devices WHERE license_id = ?`, [licenseId]);
    if (devices.length && data.confirmBoundDevice !== true) throw new InputError("Key đã liên kết thiết bị. Cần xác nhận cấp cấu hình cho lần xác minh tiếp theo.", 409);
    await db.execute(`INSERT INTO license_identities (license_id, device_id, registration_uuid) VALUES (?, ?, ?)
      ON DUPLICATE KEY UPDATE device_id = VALUES(device_id), registration_uuid = VALUES(registration_uuid), updated_at = UTC_TIMESTAMP(3)`,
      [licenseId, identity.device_id, identity.uuid]);
    await db.execute(`UPDATE licenses SET version = version + 1 WHERE id = ?`, [licenseId]);
    // Do not copy customer identifiers into the audit trail or server logs.
    await audit(db, admin, before.length ? "license.identity_updated" : "license.identity_assigned", licenseId,
      { hasIdentity: true, boundDeviceConfirmed: devices.length > 0 });
    return { id: licenseId };
  });
}

export async function getLicenseIdentity(licenseId: string) {
  id(licenseId);
  const [rows] = await getDb().execute<(RowDataPacket & { device_id: string | null; registration_uuid: string | null; version: number; bound: number })[]>(
    `SELECT l.version, i.device_id, i.registration_uuid, EXISTS(SELECT 1 FROM devices d WHERE d.license_id = l.id) AS bound
     FROM licenses l LEFT JOIN license_identities i ON i.license_id = l.id WHERE l.id = ?`, [licenseId]);
  if (!rows[0]) throw new InputError("Không tìm thấy key.", 404);
  const row = rows[0];
  return { id: licenseId, version: row.version, bound: Boolean(row.bound),
    identity: row.device_id ? { v: 1, device_id: row.device_id, uuid: row.registration_uuid } : null };
}

type License = RowDataPacket & { status: "pending" | "active" | "revoked"; version: number; duration_days: number; activated_at: Date | null; expires_at: Date | null };
export async function changeLicense(admin: Admin, licenseId: string, operation: string, data: Record<string, unknown>) {
  id(licenseId);
  if (!["extend", "revoke", "restore", "delete"].includes(operation)) throw new InputError("Thao tác không tồn tại.", 404);
  return transaction(async (db) => {
    const [rows] = await db.execute<License[]>(`SELECT status, version, customer_id, key_hint, duration_days, activated_at, expires_at FROM licenses WHERE id = ? FOR UPDATE`, [licenseId]);
    const license = rows[0];
    if (!license) throw new InputError("Không tìm thấy key.", 404);
    expectVersion(data.version, license.version);
    if (operation === "delete") {
      const [devices] = await db.execute<RowDataPacket[]>(`SELECT id, name FROM devices WHERE license_id = ? FOR UPDATE`, [licenseId]);
      await db.execute(`DELETE FROM devices WHERE license_id = ?`, [licenseId]);
      await db.execute(`DELETE FROM licenses WHERE id = ?`, [licenseId]);
      await audit(db, admin, "license.deleted", licenseId, { customerId: license.customer_id, keyHint: license.key_hint, previousStatus: license.status, expiresAt: license.expires_at, releasedDevices: devices });
    } else if (operation === "restore") {
      if (license.status !== "revoked") throw new InputError("Chỉ khôi phục được key đã thu hồi.", 409);
      if (Boolean(license.activated_at) !== Boolean(license.expires_at)) throw new InputError("Key thiếu thông tin thời hạn; cần kiểm tra dữ liệu.", 409);
      const restoredStatus = license.activated_at ? "active" : "pending";
      await db.execute(`UPDATE licenses SET status = ?, version = version + 1 WHERE id = ?`, [restoredStatus, licenseId]);
      await audit(db, admin, "license.restored", licenseId, { restoredStatus, expiresAt: license.expires_at });
    } else if (license.status === "revoked") {
      throw new InputError("Key đã bị thu hồi. Hãy khôi phục trước khi gia hạn.", 409);
    } else if (operation === "revoke") {
      await db.execute(`UPDATE licenses SET status = 'revoked', version = version + 1 WHERE id = ?`, [licenseId]);
      await audit(db, admin, "license.revoked", licenseId, { previousStatus: license.status });
    } else {
      const addedDays = days(data.days);
      if (license.status === "pending") {
        if (license.duration_days + addedDays > 3650) throw new InputError("Tổng thời hạn không được vượt 3650 ngày.");
        await db.execute(`UPDATE licenses SET duration_days = duration_days + ?, version = version + 1 WHERE id = ?`, [addedDays, licenseId]);
      } else {
        if (!license.expires_at) throw new InputError("Key thiếu ngày hết hạn; cần kiểm tra dữ liệu.", 409);
        await db.execute(`UPDATE licenses SET expires_at = TIMESTAMPADD(DAY, ?, GREATEST(expires_at, UTC_TIMESTAMP(3))), version = version + 1 WHERE id = ?`, [addedDays, licenseId]);
      }
      await audit(db, admin, "license.extended", licenseId, { days: addedDays, previousExpiry: license.expires_at, previousDuration: license.duration_days });
    }
    return { id: licenseId };
  });
}

export async function releaseDevice(admin: Admin, deviceId: string, data: Record<string, unknown>) {
  id(deviceId);
  return transaction(async (db) => {
    // Lock the license first: activation/renewal must use this same lock ordering.
    const [found] = await db.execute<(RowDataPacket & { license_id: string })[]>(`SELECT license_id FROM devices WHERE id = ?`, [deviceId]);
    if (!found[0]) throw new InputError("Thiết bị đã được gỡ hoặc không tồn tại.", 404);
    const licenseId = found[0].license_id;
    const [licenses] = await db.execute<License[]>(`SELECT version, status FROM licenses WHERE id = ? FOR UPDATE`, [licenseId]);
    expectVersion(data.version, licenses[0].version);
    const [devices] = await db.execute<(RowDataPacket & { name: string | null; fingerprint: string })[]>(`SELECT name, fingerprint FROM devices WHERE id = ? AND license_id = ? FOR UPDATE`, [deviceId, licenseId]);
    if (!devices[0]) throw new InputError("Thiết bị đã được gỡ. Hãy tải lại danh sách.", 409);
    await db.execute(`DELETE FROM devices WHERE id = ?`, [deviceId]);
    await db.execute(`UPDATE licenses SET version = version + 1 WHERE id = ?`, [licenseId]);
    await audit(db, admin, "device.released", licenseId, { deviceId, name: devices[0].name, fingerprint: devices[0].fingerprint });
    return { id: deviceId };
  });
}

export type Section = "customers" | "licenses" | "devices" | "activity";
export async function listRecords(section: Section, params: URLSearchParams) {
  const q = (params.get("q") || "").trim().slice(0, 120);
  const requestedPage = Math.max(1, Math.min(1000000, Number.parseInt(params.get("page") || "1", 10) || 1));
  let from = "";
  let where = "1 = 1";
  let select = "";
  let order = "";
  const values: (string | number)[] = [];
  const search = `%${q}%`;
  if (section === "customers") {
    from = "customers c";
    select = `c.id, c.name, c.contact, c.notes, c.version, c.created_at,
      (SELECT COUNT(*) FROM licenses l WHERE l.customer_id = c.id) AS license_count,
      (SELECT COUNT(*) FROM customer_device_profiles p WHERE p.customer_id = c.id) AS device_profile_count`;
    order = "c.id DESC";
    if (q) { where = `(c.name LIKE ? OR c.contact LIKE ? OR EXISTS(SELECT 1 FROM customer_device_profiles p
      WHERE p.customer_id = c.id AND (p.label LIKE ? OR CONVERT(p.apple_udid USING utf8mb4) LIKE ? OR p.signing_label LIKE ?)))`; values.push(search, search, search, search, search); }
  } else if (section === "licenses") {
    from = "licenses l JOIN customers c ON c.id = l.customer_id LEFT JOIN customer_device_profiles p ON p.license_id = l.id";
    select = `l.id, l.customer_id, c.name AS customer_name, l.key_hint, l.status, l.duration_days,
      l.activated_at, l.expires_at, l.version, l.created_at,
      p.id AS device_profile_id, p.label AS device_label, p.apple_udid, p.signing_label,
      EXISTS(SELECT 1 FROM license_identities i WHERE i.license_id = l.id) AS has_identity,
      CASE WHEN l.status = 'active' AND l.expires_at <= UTC_TIMESTAMP(3) THEN 'expired' ELSE l.status END AS display_status`;
    order = "l.id DESC";
    if (q) { where += " AND (c.name LIKE ? OR l.key_hint LIKE ? OR CAST(l.id AS CHAR) = ? OR p.label LIKE ? OR CONVERT(p.apple_udid USING utf8mb4) LIKE ? OR p.signing_label LIKE ?)"; values.push(search, search, q, search, search, search); }
    const customerId = params.get("customerId");
    if (customerId) { where += " AND l.customer_id = ?"; values.push(id(customerId)); }
    const status = params.get("status");
    if (status === "expired") where += " AND l.status = 'active' AND l.expires_at <= UTC_TIMESTAMP(3)";
    else if (status === "active") where += " AND l.status = 'active' AND l.expires_at > UTC_TIMESTAMP(3)";
    else if (status === "pending" || status === "revoked") { where += " AND l.status = ?"; values.push(status); }
  } else if (section === "devices") {
    from = "devices d JOIN licenses l ON l.id = d.license_id JOIN customers c ON c.id = l.customer_id LEFT JOIN customer_device_profiles p ON p.license_id = l.id";
    select = `d.id, d.name, d.fingerprint, d.bound_at, d.last_seen_at, l.id AS license_id,
      l.version, l.key_hint, c.id AS customer_id, c.name AS customer_name,
      p.id AS device_profile_id, p.label AS device_label, p.apple_udid, p.signing_label`;
    order = "d.id DESC";
    if (q) { where += " AND (c.name LIKE ? OR d.name LIKE ? OR l.key_hint LIKE ? OR p.label LIKE ? OR CONVERT(p.apple_udid USING utf8mb4) LIKE ? OR p.signing_label LIKE ?)"; values.push(search, search, search, search, search, search); }
  } else {
    from = "audit_events e LEFT JOIN admins a ON a.id = e.admin_id";
    select = "e.id, e.action, e.target_id, e.details, e.created_at, a.display_name";
    order = "e.id DESC";
    if (q) { where += " AND (e.action LIKE ? OR e.target_id LIKE ? OR a.display_name LIKE ?)"; values.push(search, search, search); }
  }
  const db = getDb();
  const [totals] = await db.execute<(RowDataPacket & { total: string })[]>(`SELECT COUNT(*) AS total FROM ${from} WHERE ${where}`, values);
  const total = Number(totals[0].total);
  const pages = Math.max(1, Math.ceil(total / 25));
  const page = Math.min(requestedPage, pages);
  // LIMIT/OFFSET are derived integers, not user-supplied SQL fragments.
  const [items] = await db.execute<RowDataPacket[]>(`SELECT ${select} FROM ${from} WHERE ${where} ORDER BY ${order} LIMIT 25 OFFSET ${(page - 1) * 25}`, values);
  return { items, total, page, pages };
}
