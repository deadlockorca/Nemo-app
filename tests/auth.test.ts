import "../scripts/env";
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { getDb } from "../src/lib/db";
import { hashPassword, tokenHash, verifyPassword } from "../src/lib/password";

const base = process.env.TEST_BASE_URL || process.env.APP_URL || "http://localhost:3000";
const origin = new URL(base).origin;
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(base).hostname)) {
  throw new Error("Integration tests are restricted to a local test server.");
}
const cookieName = "nemo_admin_session";

async function request(path: string, options?: RequestInit) {
  return fetch(new URL(path, base), { redirect: "manual", ...options });
}
function login(username: string, password: string, extraHeaders: Record<string, string> = {}) {
  return request("/api/auth/login", {
    method: "POST", headers: { origin, ...extraHeaders }, body: new URLSearchParams({ username, password }),
  });
}
function session(response: Response) {
  const cookie = response.headers.get("set-cookie");
  assert.ok(cookie);
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  return cookie.split(";")[0];
}
function location(response: Response) { return new URL(response.headers.get("location")!, base); }

test("password hashing rejects wrong and malformed passwords", async () => {
  const password = randomBytes(20).toString("hex");
  const hash = await hashPassword(password);
  assert.equal(await verifyPassword(password, hash), true);
  assert.equal(await verifyPassword("wrong-password", hash), false);
  assert.equal(await verifyPassword(password, "malformed"), false);
  await assert.rejects(hashPassword("short"));
});

test("MySQL-backed admin authentication lifecycle", async (t) => {
  const pool = getDb();
  const username = `test-${randomBytes(8).toString("hex")}@example.test`;
  const password = randomBytes(24).toString("hex");
  let adminId = 0;
  const unknownUsername = `missing-${username}`;
  try {
    const [insert] = await pool.execute<ResultSetHeader>(
      "INSERT INTO admins (username, display_name, password_hash) VALUES (?, ?, ?)",
      [username, "Temporary Test Admin", await hashPassword(password)],
    );
    adminId = insert.insertId;
    await t.test("anonymous users cannot read admin data", async () => {
      const response = await request("/admin");
      assert.equal(response.status, 307);
      assert.equal(location(response).pathname, "/");
      assert.ok(!(await response.text()).includes("Tổng quan hệ thống"));
    });
    await t.test("cross-origin and missing-origin requests are rejected", async () => {
      assert.equal((await login(username, password, { origin: "https://other.example" })).status, 403);
      const response = await request("/api/auth/login", { method: "POST", body: new URLSearchParams({ username, password }) });
      assert.equal(response.status, 403);
    });
    await t.test("wrong passwords and unknown users share a generic error", async () => {
      const bad = await login(username, "not-the-password");
      const unknown = await login(unknownUsername, password);
      assert.equal(location(bad).searchParams.get("error"), "invalid");
      assert.equal(location(unknown).searchParams.get("error"), "invalid");
      assert.equal(bad.headers.get("set-cookie"), null);
    });
    let cookie = "";
    await t.test("valid credentials produce a hashed server session and protected page", async () => {
      const response = await login(username, password);
      assert.equal(response.status, 303);
      assert.equal(location(response).pathname, "/admin");
      cookie = session(response);
      const token = cookie.split("=")[1];
      const [rows] = await pool.execute<(RowDataPacket & { token_hash: string })[]>("SELECT token_hash FROM admin_sessions WHERE admin_id = ?", [adminId]);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].token_hash, tokenHash(token));
      assert.notEqual(rows[0].token_hash, token);
      const dashboard = await request("/admin", { headers: { cookie } });
      assert.equal(dashboard.status, 200);
      const html = await dashboard.text();
      assert.ok(html.includes("Tổng quan hệ thống"));
      assert.ok(html.includes("Temporary Test Admin"));
      assert.ok(!html.includes("password_hash"));
      const home = await request("/", { headers: { cookie } });
      assert.equal(home.status, 307);
      assert.equal(location(home).pathname, "/admin");
    });
    await t.test("forged sessions cannot access dashboard", async () => {
      assert.equal((await request("/admin", { headers: { cookie: `${cookieName}=${"a".repeat(64)}` } })).status, 307);
    });
    await t.test("logout requires same origin and invalidates server session", async () => {
      const blocked = await request("/api/auth/logout", { method: "POST", headers: { cookie, origin: "https://other.example" } });
      assert.equal(blocked.status, 403);
      assert.equal((await request("/admin", { headers: { cookie } })).status, 200);
      const response = await request("/api/auth/logout", { method: "POST", headers: { cookie, origin } });
      assert.equal(response.status, 303);
      assert.match(response.headers.get("set-cookie") || "", /Max-Age=0/i);
      assert.equal((await request("/admin", { headers: { cookie } })).status, 307);
    });
    await t.test("expired sessions and disabled admins are rejected", async () => {
      cookie = session(await login(username, password));
      await pool.execute("UPDATE admin_sessions SET expires_at = UTC_TIMESTAMP(3) - INTERVAL 1 SECOND WHERE admin_id = ?", [adminId]);
      assert.equal((await request("/admin", { headers: { cookie } })).status, 307);
      cookie = session(await login(username, password));
      await pool.execute("UPDATE admins SET is_active = FALSE WHERE id = ?", [adminId]);
      assert.equal((await request("/admin", { headers: { cookie } })).status, 307);
      assert.equal(location(await login(username, password)).searchParams.get("error"), "invalid");
      await pool.execute("UPDATE admins SET is_active = TRUE WHERE id = ?", [adminId]);
    });
    await t.test("five failures lock even correct credentials until window expires", async () => {
      await pool.execute("DELETE FROM login_limits WHERE bucket = ?", [tokenHash(username)]);
      for (let i = 0; i < 5; i++) assert.equal(location(await login(username, "incorrect")).searchParams.get("error"), "invalid");
      assert.equal(location(await login(username, password)).searchParams.get("error"), "limited");
      await pool.execute("UPDATE login_limits SET window_start = UTC_TIMESTAMP(3) - INTERVAL 16 MINUTE WHERE bucket = ?", [tokenHash(username)]);
      assert.equal(location(await login(username, password)).pathname, "/admin");
    });
  } finally {
    if (adminId) {
      await pool.execute("DELETE FROM audit_events WHERE admin_id = ?", [adminId]);
      await pool.execute("DELETE FROM admins WHERE id = ?", [adminId]);
    }
    await pool.execute("DELETE FROM login_limits WHERE bucket IN (?, ?)", [tokenHash(username), tokenHash(unknownUsername)]);
    await pool.end();
  }
});
