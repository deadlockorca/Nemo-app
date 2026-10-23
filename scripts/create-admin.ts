import "./env";
import { hiddenInput } from "./prompt";
import { createInterface } from "node:readline/promises";
import type { ResultSetHeader } from "mysql2/promise";
import { getDb } from "../src/lib/db";
import { hashPassword, normalizeUsername, validUsername } from "../src/lib/password";


try {
  const cli = createInterface({ input: process.stdin, output: process.stdout });
  const username = normalizeUsername(await cli.question("Tên đăng nhập admin: "));
  const name = (await cli.question("Tên hiển thị: ")).trim();
  cli.close();
  if (!validUsername(username) || !/^[\x21-\x7e]+$/.test(username)) throw new Error("Tên đăng nhập cần 3–254 ký tự: chữ, số hoặc . _ @ + -");
  if (!name || name.length > 120) throw new Error("Tên cần từ 1 đến 120 ký tự.");
  const password = await hiddenInput("Mật khẩu (ít nhất 12 ký tự, không hiện khi nhập): ");
  const confirmation = await hiddenInput("Nhập lại mật khẩu: ");
  if (password !== confirmation) throw new Error("Mật khẩu không khớp.");
  const hash = await hashPassword(password);
  const pool = getDb();
  try {
    const [result] = await pool.execute<ResultSetHeader>(
      `INSERT INTO admins (username, display_name, password_hash) VALUES (?, ?, ?)`, [username, name, hash],
    );
    console.log(`Đã tạo admin #${result.insertId}. Không lưu mật khẩu dạng rõ.`);
  } finally { await pool.end(); }
} catch (error) {
  console.error((error as { code?: string }).code === "ER_DUP_ENTRY" ? "Tên đăng nhập đã tồn tại; không ghi đè tài khoản." : (error instanceof Error ? error.message : "Không thể tạo admin."));
  process.exitCode = 1;
}
