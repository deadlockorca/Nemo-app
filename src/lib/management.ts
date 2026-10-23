import "server-only";
import { randomBytes } from "node:crypto";
import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { getDb } from "./db";
import { tokenHash } from "./password";
import type { Admin } from "./auth";

export class InputError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InputError("Dữ liệu không hợp lệ.");
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number, required = false) {
  if (value !== undefined && value !== null && typeof value !== "string") throw new InputError("Nội dung phải là văn bản.");
  const result = ((value as string) || "").trim();
  if ((required && !result) || Array.from(result).length > max || /\u0000/.test(result)) throw new InputError(`Nội dung cần ${required ? '1' : '0'}–${max} ký tự.`);
  return result;
}
export function id(value: unknown) {
  if (typeof value !== "string" || !/^[1-9]\d{0,19}$/.test(value) || BigInt(value) > BigInt("18446744073709551615")) throw new InputError("Mã bản ghi không hợp lệ.");
  return value;
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

export async function createLicense(admin: Admin, data: Record<string, unknown>) {
  const customerId = id(data.customerId);
  const duration = days(data.durationDays ?? 30);
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
    await audit(db, admin, "license.created", newId, { customerId, durationDays: duration });
    return { id: newId, key: rawKey };
  });
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
      (SELECT COUNT(*) FROM licenses l WHERE l.customer_id = c.id) AS license_count`;
    order = "c.id DESC";
    if (q) { where = "(c.name LIKE ? OR c.contact LIKE ?)"; values.push(search, search); }
  } else if (section === "licenses") {
    from = "licenses l JOIN customers c ON c.id = l.customer_id";
    select = `l.id, l.customer_id, c.name AS customer_name, l.key_hint, l.status, l.duration_days,
      l.activated_at, l.expires_at, l.version, l.created_at,
      CASE WHEN l.status = 'active' AND l.expires_at <= UTC_TIMESTAMP(3) THEN 'expired' ELSE l.status END AS display_status`;
    order = "l.id DESC";
    if (q) { where += " AND (c.name LIKE ? OR l.key_hint LIKE ? OR CAST(l.id AS CHAR) = ?)"; values.push(search, search, q); }
    const status = params.get("status");
    if (status === "expired") where += " AND l.status = 'active' AND l.expires_at <= UTC_TIMESTAMP(3)";
    else if (status === "active") where += " AND l.status = 'active' AND l.expires_at > UTC_TIMESTAMP(3)";
    else if (status === "pending" || status === "revoked") { where += " AND l.status = ?"; values.push(status); }
  } else if (section === "devices") {
    from = "devices d JOIN licenses l ON l.id = d.license_id JOIN customers c ON c.id = l.customer_id";
    select = `d.id, d.name, d.fingerprint, d.bound_at, d.last_seen_at, l.id AS license_id,
      l.version, l.key_hint, c.name AS customer_name`;
    order = "d.id DESC";
    if (q) { where += " AND (c.name LIKE ? OR d.name LIKE ? OR l.key_hint LIKE ?)"; values.push(search, search, search); }
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
