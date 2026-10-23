import "./env";
import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { RowDataPacket } from "mysql2/promise";
import { getDb } from "../src/lib/db";

const pool = getDb();
const connection = await pool.getConnection();
try {
  const [locks] = await connection.query<(RowDataPacket & { acquired: number })[]>(
    `SELECT GET_LOCK(CONCAT(DATABASE(), ':migrate'), 10) AS acquired`,
  );
  if (Number(locks[0].acquired) !== 1) throw new Error("Another migration is running.");
  await connection.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name VARCHAR(190) NOT NULL PRIMARY KEY, checksum CHAR(64) NOT NULL,
    applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  const files = (await readdir("migrations")).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
  for (const name of files) {
    const source = await readFile(`migrations/${name}`, "utf8");
    const checksum = createHash("sha256").update(source).digest("hex");
    const [applied] = await connection.execute<(RowDataPacket & { checksum: string })[]>(
      `SELECT checksum FROM schema_migrations WHERE name = ?`, [name],
    );
    if (applied.length) {
      if (applied[0].checksum !== checksum) throw new Error(`Applied migration changed: ${name}`);
      console.log(`Already applied: ${name}`);
      continue;
    }
    // MySQL DDL auto-commits; the initial CREATE TABLE statements are idempotent.
    for (const statement of source.split(";").map((s) => s.trim()).filter(Boolean)) await connection.query(statement);
    await connection.execute(`INSERT INTO schema_migrations (name, checksum) VALUES (?, ?)`, [name, checksum]);
    console.log(`Applied: ${name}`);
  }
} finally {
  await connection.query(`SELECT RELEASE_LOCK(CONCAT(DATABASE(), ':migrate'))`);
  connection.release();
  await pool.end();
}
