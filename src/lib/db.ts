import mysql, { type Pool } from "mysql2/promise";
import { readFileSync } from "node:fs";

const globalDb = globalThis as typeof globalThis & { nemoDb?: Pool };

export function getDb(): Pool {
  if (globalDb.nemoDb) return globalDb.nemoDb;
  for (const key of ["DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD"]) {
    if (!process.env[key]) throw new Error(`Missing environment variable: ${key}`);
  }
  const port = Number(process.env.DB_PORT || 3306);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid DB_PORT");
  globalDb.nemoDb = mysql.createPool({
    host: process.env.DB_HOST,
    port,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    connectionLimit: 5,
    queueLimit: 20,
    connectTimeout: 5000,
    timezone: "Z",
    charset: "utf8mb4",
    supportBigNumbers: true,
    bigNumberStrings: true,
    ssl: process.env.DB_SSL_CA_FILE
      ? { ca: readFileSync(process.env.DB_SSL_CA_FILE, "utf8"), rejectUnauthorized: true }
      : undefined,
  });
  return globalDb.nemoDb;
}
