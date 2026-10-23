import "server-only";
import type { RowDataPacket } from "mysql2/promise";
import { requireAdmin } from "./auth";
import { getDb } from "./db";

export async function loadDashboard() {
  const admin = await requireAdmin();
  const [counts] = await getDb().query<(RowDataPacket & { customers: number; active: number; expiring: number; expired: number })[]>(`
    SELECT (SELECT COUNT(*) FROM customers) AS customers,
    (SELECT COUNT(*) FROM licenses WHERE status = 'active' AND expires_at > UTC_TIMESTAMP(3)) AS active,
    (SELECT COUNT(*) FROM licenses WHERE status = 'active' AND expires_at > UTC_TIMESTAMP(3)
      AND expires_at <= UTC_TIMESTAMP(3) + INTERVAL 7 DAY) AS expiring,
    (SELECT COUNT(*) FROM licenses WHERE status = 'active' AND expires_at <= UTC_TIMESTAMP(3)) AS expired
  `);
  const [events] = await getDb().query<(RowDataPacket & { id: string; action: string; display_name: string | null; created_at: Date })[]>(`
    SELECT e.id, e.action, a.display_name, e.created_at FROM audit_events e
    LEFT JOIN admins a ON a.id = e.admin_id ORDER BY e.id DESC LIMIT 8
  `);
  return { admin, counts: counts[0], events };
}
