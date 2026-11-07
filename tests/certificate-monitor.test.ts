import "../scripts/env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import nodemailer from "nodemailer";
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { getDb } from "../src/lib/db";
import { tokenHash } from "../src/lib/password";
import { alertMessage, mailConfig, sendCertificateEmail } from "../src/lib/certificate-email";
import { CERTIFICATE_CHECK_SECONDS, deliverCertificateAlert, expiryPhase, profileExpiry, queueExpiryAlerts, runCertificateCheck } from "../src/lib/certificate-monitor";
import { listDeviceProfiles } from "../src/lib/device-profiles";
import type { CertificateResult } from "../src/lib/certificate-monitor-types";

if (process.env.DB_HOST !== "127.0.0.1" || process.env.DB_NAME !== "nemo_blank_test") throw new Error("Dedicated local database required");
const result = (status: CertificateResult["status"]): CertificateResult => ({ status, detail: status === "unknown" ? "ocsp_unverified" : "verified", method: status === "expired" ? null : "ocsp", validUntil: status === "unknown" || status === "expired" ? null : new Date(Date.now() + 4 * 3600000).toISOString() });

test("hourly certificate monitoring, durable alerts and legacy customer compatibility", async t => {
  const db = getDb(), prefix = `cert-${randomBytes(8).toString("hex")}`, sha = tokenHash(prefix), installationId = randomBytes(16).toString("hex");
  const [customer] = await db.execute<ResultSetHeader>(`INSERT INTO customers (name) VALUES (?)`, [prefix]);
  const [license] = await db.execute<ResultSetHeader>(`INSERT INTO licenses (customer_id, key_hash, key_hint, status, activated_at, expires_at) VALUES (?, ?, 'CERTTEST', 'active', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3) + INTERVAL 30 DAY)`, [customer.insertId, tokenHash(randomUUID())]);
  await db.execute(`INSERT INTO license_identities (license_id, device_id, registration_uuid) VALUES (?, ?, ?)`, [license.insertId, randomUUID().toUpperCase(), randomBytes(32).toString("hex")]);
  const metadata = { certificateSha256: sha, certificateExpiresAt: new Date(Date.now() + 30 * 86400000).toISOString(), profileExpiresAt: new Date(Date.now() + 30 * 86400000).toISOString() };
  await db.execute(`INSERT INTO ios_installations (id, license_id, label, apple_udid, code_hash, source_key, secrets_key, metadata, code_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3) + INTERVAL 15 MINUTE)`, [installationId, license.insertId, prefix, `00008120-${randomBytes(8).toString("hex").toUpperCase()}`, tokenHash(randomUUID()), randomBytes(16).toString("hex"), randomBytes(16).toString("hex"), JSON.stringify(metadata)]);
  const [profile] = await db.execute<ResultSetHeader>(`INSERT INTO customer_device_profiles (customer_id, license_id, label, apple_udid, signing_label, installation_id) SELECT ?, ?, ?, apple_udid, ?, id FROM ios_installations WHERE id = ?`, [customer.insertId, license.insertId, prefix, prefix, installationId]);
  const before = JSON.stringify((await db.query(`SELECT * FROM licenses WHERE id = ?`, [license.insertId]))[0]);
  const identities = JSON.stringify((await db.query(`SELECT * FROM license_identities WHERE license_id = ?`, [license.insertId]))[0]);
  const due = () => db.execute(`UPDATE ios_certificate_checks SET next_check_at = UTC_TIMESTAMP(3) - INTERVAL 1 SECOND WHERE certificate_sha256 = ?`, [sha]);
  const run = (status: CertificateResult["status"]) => runCertificateCheck(async () => result(status), sha);
  const rows = async () => (await db.execute<RowDataPacket[]>(`SELECT * FROM ios_certificate_checks WHERE certificate_sha256 = ?`, [sha]))[0];
  try {
    await t.test("one-hour schedule persists in the database and concurrent workers claim once", async () => {
      assert.equal(CERTIFICATE_CHECK_SECONDS, 3600);
      let calls = 0;
      const check = async () => { calls++; return result("good"); };
      await Promise.all([runCertificateCheck(check, sha), runCertificateCheck(check, sha)]);
      assert.equal(calls, 1); const row = (await rows())[0]; assert.equal(row.status, "good");
      assert.ok(new Date(row.next_check_at).getTime() - new Date(row.checked_at).getTime() >= 3599000);
      assert.equal(await runCertificateCheck(check, sha), false); assert.equal(calls, 1);
    });
    await t.test("revocation creates one durable alert across repeated hourly checks", async () => {
      await due(); await run("revoked"); await due(); await run("revoked");
      const [alerts] = await db.execute<RowDataPacket[]>(`SELECT * FROM ios_certificate_alerts WHERE certificate_sha256 = ?`, [sha]);
      assert.equal(alerts.length, 1); assert.equal(alerts[0].status, "pending"); assert.equal((await rows())[0].incident, 1);
      assert.equal(alerts[0].payload.affected[0].customer, prefix); assert.equal(alerts[0].payload.affected[0].udidSuffix.length, 8);
      assert.equal(await deliverCertificateAlert(async () => assert.fail("SMTP not configured"), false), false);
    });
    await t.test("offline check is unknown and preserves the last confirmed revocation", async () => {
      await due(); await run("unknown"); const row = (await rows())[0];
      assert.equal(row.status, "unknown"); assert.equal(row.last_confirmed_status, "revoked");
      const listed = await listDeviceProfiles(new URLSearchParams({ q: prefix }));
      assert.equal(listed.items[0].certificate_status, "unknown"); assert.equal(listed.items[0].certificate_last_confirmed_status, "revoked");
      assert.equal(JSON.stringify(listed).includes("secrets_key"), false);
    });
    await t.test("email failure retries, then success is not resent every hour", async () => {
      assert.equal(await deliverCertificateAlert(async () => { throw new Error("synthetic SMTP failure"); }, true), true);
      const [failed] = await db.execute<RowDataPacket[]>(`SELECT * FROM ios_certificate_alerts WHERE certificate_sha256 = ?`, [sha]);
      assert.equal(failed[0].status, "pending"); assert.equal(failed[0].last_error, "smtp_failed"); assert.equal(failed[0].attempts, 1);
      assert.ok(new Date(failed[0].next_attempt_at).getTime() - Date.now() > 890000);
      await db.execute(`UPDATE ios_certificate_alerts SET next_attempt_at = UTC_TIMESTAMP(3) - INTERVAL 1 SECOND WHERE certificate_sha256 = ?`, [sha]);
      let sends = 0; await deliverCertificateAlert(async (_id, payload) => { sends++; assert.equal(payload.affected.length, 1); }, true);
      assert.equal(sends, 1); await due(); await run("revoked");
      assert.equal(await deliverCertificateAlert(async () => { sends++; }, true), false); assert.equal(sends, 1);
    });
    await t.test("recovery followed by a new revocation opens a new alert incident", async () => {
      await due(); await run("good"); await due(); await run("revoked");
      assert.equal((await rows())[0].incident, 2);
      const [alerts] = await db.execute<RowDataPacket[]>(`SELECT * FROM ios_certificate_alerts WHERE certificate_sha256 = ?`, [sha]); assert.equal(alerts.length, 2);
      // A successful recovery cancels a queued incident before it is sent.
      await due(); await run("good"); let sends = 0;
      await deliverCertificateAlert(async () => { sends++; }, true); assert.equal(sends, 0);
      const [cancelled] = await db.execute<RowDataPacket[]>(`SELECT status FROM ios_certificate_alerts WHERE certificate_sha256 = ? AND generation = '2'`, [sha]); assert.equal(cancelled[0].status, "cancelled");
    });
    await t.test("stale good evidence becomes unknown on admin", async () => {
      await db.execute(`UPDATE ios_certificate_checks SET checked_at = UTC_TIMESTAMP(3) - INTERVAL 3 HOUR WHERE certificate_sha256 = ?`, [sha]);
      const list = await listDeviceProfiles(new URLSearchParams({ q: prefix })); assert.equal(list.items[0].certificate_status, "unknown"); assert.equal(list.items[0].certificate_detail, "stale");
    });
    await t.test("expiry alerts use verified metadata, deduplicate and cancel old reminders after replacement", async () => {
      const expiry = new Date(Date.now() + 2 * 86400000).toISOString();
      assert.equal(profileExpiry({ metadata, certificate_expires_at: new Date(0) } as RowDataPacket)!.toISOString(), metadata.certificateExpiresAt);
      assert.equal(expiryPhase(new Date(Date.now() + 6 * 86400000)), "expiry_7");
      assert.equal(expiryPhase(new Date(Date.now() + 2 * 86400000)), "expiry_3");
      assert.equal(expiryPhase(new Date(Date.now() + 3600000)), "expiry_1");
      assert.equal(expiryPhase(new Date(0)), "expired");
      await db.execute(`UPDATE ios_installations SET metadata = ? WHERE id = ?`, [JSON.stringify({ ...metadata, profileExpiresAt: expiry }), installationId]);
      await queueExpiryAlerts(); await queueExpiryAlerts();
      const [alerts] = await db.execute<RowDataPacket[]>(`SELECT * FROM ios_certificate_alerts WHERE device_profile_id = ?`, [profile.insertId]); assert.equal(alerts.length, 1); assert.equal(alerts[0].kind, "expiry_3");
      await db.execute(`UPDATE ios_installations SET metadata = ? WHERE id = ?`, [JSON.stringify(metadata), installationId]);
      await deliverCertificateAlert(async () => assert.fail("outdated reminder"), true);
      const [cancelled] = await db.execute<RowDataPacket[]>(`SELECT status FROM ios_certificate_alerts WHERE device_profile_id = ?`, [profile.insertId]); assert.equal(cancelled[0].status, "cancelled");
    });
    await t.test("revoking an OTA download does not stop monitoring the app's certificate", async () => {
      await db.execute(`UPDATE ios_installations SET state = 'revoked' WHERE id = ?`, [installationId]);
      await due(); assert.equal(await run("unknown"), true);
      await db.execute(`UPDATE ios_installations SET state = 'active' WHERE id = ?`, [installationId]);
    });
    await t.test("a standalone profile can override monitoring without changing the signing assets", async () => {
      const alternate = tokenHash(`${prefix}-alternate`), secret = randomBytes(16).toString("hex");
      try {
        await db.execute(`INSERT INTO ios_device_certificate_assets (device_profile_id, bound_installation_id, secrets_key, certificate_sha256, metadata) VALUES (?, ?, ?, ?, ?)`, [profile.insertId, installationId, secret, alternate, JSON.stringify({ ...metadata, certificateSha256: alternate })]);
        let seen = "";
        await runCertificateCheck(async source => { seen = source.secrets_key; return result("good"); }, alternate); assert.equal(seen, secret);
        const listed = await listDeviceProfiles(new URLSearchParams({ q: prefix })); assert.equal(listed.items[0].certificate_status, "good"); assert.equal(listed.items[0].certificate_monitor_attached, true);
        // A later installation is authoritative. A manual attachment made for
        // the previous installation must not silently override that new source.
        await db.execute(`UPDATE ios_device_certificate_assets SET bound_installation_id = NULL WHERE device_profile_id = ?`, [profile.insertId]);
        const newer = await listDeviceProfiles(new URLSearchParams({ q: prefix })); assert.equal(newer.items[0].certificate_monitor_attached, false);
      } finally {
        await db.execute(`DELETE FROM ios_device_certificate_assets WHERE device_profile_id = ?`, [profile.insertId]);
        await db.execute(`DELETE FROM ios_certificate_checks WHERE certificate_sha256 = ?`, [alternate]);
      }
    });
    await t.test("monitoring never changes license state, dates, identity or installation state", async () => {
      assert.equal(JSON.stringify((await db.query(`SELECT * FROM licenses WHERE id = ?`, [license.insertId]))[0]), before);
      assert.equal(JSON.stringify((await db.query(`SELECT * FROM license_identities WHERE license_id = ?`, [license.insertId]))[0]), identities);
      const [installs] = await db.execute<RowDataPacket[]>(`SELECT state, code_expires_at FROM ios_installations WHERE id = ?`, [installationId]); assert.equal(installs[0].state, "active"); assert.ok(new Date(installs[0].code_expires_at).getTime() > Date.now());
    });
  } finally {
    await db.execute(`DELETE FROM customer_device_profiles WHERE customer_id = ?`, [customer.insertId]);
    await db.execute(`DELETE FROM ios_certificate_alerts WHERE certificate_sha256 = ?`, [sha]);
    await db.execute(`DELETE FROM ios_certificate_checks WHERE certificate_sha256 = ?`, [sha]);
    await db.execute(`DELETE FROM ios_installations WHERE id = ?`, [installationId]);
    await db.execute(`DELETE FROM licenses WHERE id = ?`, [license.insertId]); await db.execute(`DELETE FROM customers WHERE id = ?`, [customer.insertId]);
    await db.end();
  }
});

test("SMTP configuration and message transport enforce TLS without exposing signing assets", async t => {
  const vars = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD", "SMTP_FROM", "CERTIFICATE_ALERT_TO"];
  const before = Object.fromEntries(vars.map(v => [v, process.env[v]]));
  try {
    for (const v of vars) delete process.env[v]; assert.equal(mailConfig(), null);
    Object.assign(process.env, { SMTP_HOST: "smtp.example.invalid", SMTP_PORT: "465", SMTP_USER: "sender@example.invalid", SMTP_PASSWORD: "test-only-secret", CERTIFICATE_ALERT_TO: "recipient@example.invalid" });
    assert.ok(mailConfig()); process.env.SMTP_PORT = "25"; assert.equal(mailConfig(), null); process.env.SMTP_PORT = "465";
    process.env.CERTIFICATE_ALERT_TO = "recipient@example.invalid\r\nBcc: attacker@example.invalid"; assert.equal(mailConfig(), null); process.env.CERTIFICATE_ALERT_TO = "recipient@example.invalid";
    const payload = { title: "Chứng chỉ đã thu hồi", affected: [{ customer: "Synthetic customer", device: "Synthetic iPad", signingLabel: "TEST", udidSuffix: "12345678" }] };
    const message = alertMessage("a".repeat(32), payload); assert.match(message.text, /Synthetic customer/); assert.ok(!message.text.includes("test-only-secret"));
    let sent = false;
    const transport = { sendMail: async (mail: { to: string; from: string }) => { assert.equal(mail.to, "recipient@example.invalid"); assert.equal(mail.from, "sender@example.invalid"); sent = true; return { accepted: [mail.to], rejected: [] }; }, close() {} };
    t.mock.method(nodemailer, "createTransport", (options: unknown) => {
      const opts = options as { secure: boolean; requireTLS: boolean; tls: { rejectUnauthorized: boolean } };
      assert.equal(opts.secure, true); assert.equal(opts.requireTLS, true); assert.equal(opts.tls.rejectUnauthorized, true);
      return transport as unknown as ReturnType<typeof nodemailer.createTransport>;
    });
    await sendCertificateEmail("a".repeat(32), payload); assert.equal(sent, true);
  } finally { for (const v of vars) if (before[v] === undefined) delete process.env[v]; else process.env[v] = before[v]; }
});
