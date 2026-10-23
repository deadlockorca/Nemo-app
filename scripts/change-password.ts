import "./env";
import { createInterface } from "node:readline/promises";
import type { RowDataPacket } from "mysql2/promise";
import { getDb } from "../src/lib/db";
import { hashPassword, normalizeUsername } from "../src/lib/password";
import { hiddenInput } from "./prompt";

try {
  const cli = createInterface({ input: process.stdin, output: process.stdout });
  const username = normalizeUsername(await cli.question("Tên đăng nhập admin: "));
  cli.close();
  const password = await hiddenInput("Mật khẩu mới (ít nhất 12 ký tự): ");
  if (password !== await hiddenInput("Nhập lại mật khẩu: ")) throw new Error("Mật khẩu không khớp.");
  const hash = await hashPassword(password);
  const pool = getDb();
  const db = await pool.getConnection();
  try {
    await db.beginTransaction();
    const [rows] = await db.execute<(RowDataPacket & { id: string })[]>("SELECT id FROM admins WHERE username = ? FOR UPDATE", [username]);
    if (!rows[0]) throw new Error("Không tìm thấy tài khoản.");
    await db.execute("UPDATE admins SET password_hash = ? WHERE id = ?", [hash, rows[0].id]);
    await db.execute("DELETE FROM admin_sessions WHERE admin_id = ?", [rows[0].id]);
    await db.execute("INSERT INTO audit_events (admin_id, action) VALUES (?, 'admin.password_changed')", [rows[0].id]);
    await db.commit();
    console.log("Đã đổi mật khẩu và thu hồi các phiên đăng nhập cũ.");
  } catch (error) { await db.rollback(); throw error; }
  finally { db.release(); await pool.end(); }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Không thể đổi mật khẩu.");
  process.exitCode = 1;
}
