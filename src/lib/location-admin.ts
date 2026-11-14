import "server-only";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import type { Admin } from "./auth";
import { getDb } from "./db";
import { parseCenters } from "./location-contract";
import { locationCatalog } from "./location-catalog";
import { id, InputError } from "./validation";

function decode(value: unknown) { return typeof value === "string" ? JSON.parse(value) : value; }

export async function getLocationPolicy(licenseId: string) {
  id(licenseId);
  const [rows] = await getDb().execute<RowDataPacket[]>(`SELECT c.nemo_username, p.enabled, p.centers, p.version
    FROM licenses l JOIN customers c ON c.id = l.customer_id
    LEFT JOIN license_location_policies p ON p.license_id = l.id WHERE l.id = ?`, [licenseId]);
  if (!rows[0]) throw new InputError("Không tìm thấy key.", 404);
  const row = rows[0];
  return { employeeUsername: row.nemo_username, enabled: Boolean(row.enabled), centers: row.centers ? parseCenters(decode(row.centers)) : [], version: row.version ?? 0,
    catalog: locationCatalog(row.nemo_username) };
}

export async function saveLocationPolicy(admin: Admin, licenseId: string, data: Record<string, unknown>) {
  id(licenseId);
  if (typeof data.enabled !== "boolean" || !Number.isSafeInteger(data.version) || Number(data.version) < 0) throw new InputError("Thiếu trạng thái hoặc phiên bản cấu hình.");
  const centers = parseCenters(data.centers);
  const db = await getDb().getConnection();
  try {
    await db.beginTransaction();
    const [licenses] = await db.execute<RowDataPacket[]>(`SELECT customer_id, status FROM licenses WHERE id = ? FOR UPDATE`, [licenseId]);
    if (!licenses[0]) throw new InputError("Không tìm thấy key.", 404);
    const [customers] = await db.execute<RowDataPacket[]>(`SELECT nemo_username FROM customers WHERE id = ? FOR SHARE`, [licenses[0].customer_id]);
    const [policies] = await db.execute<RowDataPacket[]>(`SELECT version FROM license_location_policies WHERE license_id = ? FOR UPDATE`, [licenseId]);
    if ((policies[0]?.version ?? 0) !== data.version) throw new InputError("Cấu hình đã thay đổi. Hãy tải lại.", 409);
    if (data.enabled && (licenses[0].status !== "active" || !customers[0]?.nemo_username || !centers.length)) throw new InputError("Cần key active, tên đăng nhập và ít nhất một tâm đã đối chiếu trước khi bật.");
    await db.execute<ResultSetHeader>(`INSERT INTO license_location_policies (license_id, enabled, centers) VALUES (?, ?, ?)
      ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), centers = VALUES(centers), version = version + 1, updated_at = UTC_TIMESTAMP(3)`, [licenseId, data.enabled, JSON.stringify(centers)]);
    await db.execute(`INSERT INTO audit_events (admin_id, action, target_id, details) VALUES (?, 'license.location_updated', ?, ?)`,
      [admin.id, licenseId, JSON.stringify({ enabled: data.enabled, centerCount: centers.length })]);
    // Location-only edits deliberately do not change license version, identity,
    // device bindings, expiry, or any existing activation/verify response.
    await db.commit();
    return { id: licenseId };
  } catch (error) { await db.rollback(); throw error; }
  finally { db.release(); }
}
