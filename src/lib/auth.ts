import "server-only";
import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { RowDataPacket } from "mysql2/promise";
import { getDb } from "./db";
import { DUMMY_PASSWORD_HASH, normalizeUsername, tokenHash, verifyPassword } from "./password";

export const SESSION_COOKIE = "nemo_admin_session";
export const SESSION_SECONDS = 12 * 60 * 60;
type AdminRow = RowDataPacket & { id: string; username: string; display_name: string; password_hash: string; is_active: number };
export type Admin = { id: string; username: string; name: string };

export async function currentAdmin(): Promise<Admin | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const [rows] = await getDb().execute<AdminRow[]>(
    `SELECT a.id, a.username, a.display_name FROM admins a
     JOIN admin_sessions s ON s.admin_id = a.id
     WHERE s.token_hash = ? AND s.expires_at > UTC_TIMESTAMP(3) AND a.is_active = TRUE LIMIT 1`,
    [tokenHash(token)],
  );
  return rows[0] ? { id: rows[0].id, username: rows[0].username, name: rows[0].display_name } : null;
}

export async function requireAdmin() {
  const admin = await currentAdmin();
  if (!admin) redirect("/");
  return admin;
}

export async function authenticate(usernameInput: string, password: string): Promise<
  { kind: "ok"; token: string } | { kind: "invalid" | "limited" }
> {
  const username = normalizeUsername(usernameInput);
  const connection = await getDb().getConnection();
  try {
    await connection.beginTransaction();
    // Row locking makes the attempt limit atomic across workers/processes.
    const bucket = tokenHash(username);
    await connection.execute(`INSERT INTO login_limits (bucket) VALUES (?) ON DUPLICATE KEY UPDATE bucket = login_limits.bucket`, [bucket]);
    const [limits] = await connection.execute<(RowDataPacket & { attempts: number; fresh: number })[]>(
      `SELECT attempts, window_start > UTC_TIMESTAMP(3) - INTERVAL 15 MINUTE AS fresh
       FROM login_limits WHERE bucket = ? FOR UPDATE`, [bucket],
    );
    const attempts = Number(limits[0].fresh) ? Number(limits[0].attempts) : 0;
    if (attempts >= 5) { await connection.commit(); return { kind: "limited" }; }
    await connection.execute(
      `UPDATE login_limits SET attempts = ?, window_start = IF(?, window_start, UTC_TIMESTAMP(3)) WHERE bucket = ?`,
      [attempts + 1, Number(limits[0].fresh), bucket],
    );
    const [admins] = await connection.execute<AdminRow[]>(`SELECT * FROM admins WHERE username = ? LIMIT 1`, [username]);
    const admin = admins[0];
    const valid = await verifyPassword(password, admin?.password_hash || DUMMY_PASSWORD_HASH);
    if (!valid || !admin?.is_active) {
      await connection.commit();
      return { kind: "invalid" };
    }
    const token = randomBytes(32).toString("hex");
    await connection.execute(
      `INSERT INTO admin_sessions (token_hash, admin_id, expires_at) VALUES (?, ?, UTC_TIMESTAMP(3) + INTERVAL 12 HOUR)`,
      [tokenHash(token), admin.id],
    );
    await connection.execute(`DELETE FROM login_limits WHERE bucket = ?`, [bucket]);
    await connection.execute(`DELETE FROM admin_sessions WHERE expires_at <= UTC_TIMESTAMP(3)`);
    await connection.execute(`INSERT INTO audit_events (admin_id, action) VALUES (?, 'admin.login')`, [admin.id]);
    await connection.commit();
    return { kind: "ok", token };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally { connection.release(); }
}

export async function destroySession(token?: string) {
  if (token && /^[a-f0-9]{64}$/.test(token)) {
    await getDb().execute(`DELETE FROM admin_sessions WHERE token_hash = ?`, [tokenHash(token)]);
  }
}
