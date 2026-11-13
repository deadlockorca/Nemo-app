import '../scripts/env';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import type { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { getDb } from '../src/lib/db';
import { tokenHash } from '../src/lib/password';
import { storeObject, removeObject, objectPath, runPackager, SigningError } from '../src/lib/install-storage';
import { queueReplacement, replacementContext, runReplacementJob, cancelReplacement, issueReplacement } from '../src/lib/signing-replacements';
import { loginInstallation, installationStatus } from '../src/lib/installations';
import type { CertificateResult } from '../src/lib/certificate-monitor-types';

if (process.env.DB_HOST !== '127.0.0.1' || process.env.DB_NAME !== 'nemo_blank_test') throw new Error('Dedicated local database required');
test('replacement workflow preserves live state until verified issuance and rejects unsafe transitions', async t => {
  const db = getDb(), name = 'replace-' + randomBytes(8).toString('hex');
  const [adminRow] = await db.execute<ResultSetHeader>('INSERT INTO admins (username, display_name, password_hash) VALUES (?, ?, ?)', [name, name, 'unused']);
  const admin = { id: String(adminRow.insertId), username: name, name };
  const [customer] = await db.execute<ResultSetHeader>('INSERT INTO customers (name) VALUES (?)', [name]);
  const [license] = await db.execute<ResultSetHeader>(`INSERT INTO licenses (customer_id, key_hash, key_hint, status, activated_at, expires_at) VALUES (?, ?, 'REPLACE', 'active', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3) + INTERVAL 30 DAY)`, [customer.insertId, tokenHash(randomUUID())]);
  await db.execute('INSERT INTO license_identities (license_id, device_id, registration_uuid) VALUES (?, ?, ?)', [license.insertId, randomUUID().toUpperCase(), randomBytes(32).toString('hex')]);
  const udid = '00008120-' + randomBytes(8).toString('hex').toUpperCase(), sha = randomBytes(32).toString('hex'), sourceSha = randomBytes(32).toString('hex');
  const metadata = { name: 'Nemo', bundle: 'vn.fractal.nemo-rebuild', version: '1', build: '1', blankIdentity: true, sourceSha256: sourceSha,
    certificateSha256: sha, certificateExpiresAt: new Date(Date.now() + 86400000 * 20).toISOString(), profileExpiresAt: new Date(Date.now() + 86400000 * 10).toISOString(), team: 'TESTTEAM00', profileName: 'Synthetic', profileDeviceCount: 1, signingMode: 'ad-hoc' as const };
  const oldId = randomBytes(16).toString('hex'), releaseId = randomBytes(16).toString('hex');
  const sourceKey = await storeObject(Buffer.from('test IPA source'), 'ipa');
  const secretKey = await storeObject(Buffer.from(JSON.stringify({ p12: 'test-private', profile: 'test-profile', password: 'test-password' })), 'secret');
  await db.execute(`INSERT INTO ios_ipa_releases (id, label, source_key, source_sha256, size_bytes, metadata) VALUES (?, ?, ?, ?, 15, ?)`, [releaseId, name, sourceKey, sourceSha, JSON.stringify(metadata)]);
  await db.execute(`INSERT INTO ios_installations (id, license_id, label, apple_udid, code_hash, source_key, secrets_key, metadata, code_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3) + INTERVAL 1 HOUR)`, [oldId, license.insertId, name, udid, tokenHash(randomUUID()), sourceKey, secretKey, JSON.stringify({ ...metadata, certificateSha256: randomBytes(32).toString('hex') })]);
  const [profile] = await db.execute<ResultSetHeader>('INSERT INTO customer_device_profiles (customer_id, license_id, label, apple_udid, installation_id) VALUES (?, ?, ?, ?, ?)', [customer.insertId, license.insertId, name, udid, oldId]);
  const deviceId = String(profile.insertId);
  const [set] = await db.execute<ResultSetHeader>('INSERT INTO ios_signing_sets (name, secrets_key, certificate_sha256, metadata) VALUES (?, ?, ?, ?)', [name, secretKey, sha, JSON.stringify({ ...metadata, profileUuid: randomUUID(), udids: [udid] })]);
  const setId = String(set.insertId);
  await db.execute(`INSERT INTO ios_certificate_checks (certificate_sha256, status, checked_at, response_valid_until) VALUES (?, 'good', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3) + INTERVAL 1 HOUR)`, [sha]);
  const state = async () => JSON.stringify((await db.query('SELECT * FROM customer_device_profiles WHERE id = ?', [deviceId]))[0]);
  const initial = await state();
  const contract = async () => JSON.stringify((await db.query('SELECT l.*, li.device_id, li.registration_uuid FROM licenses l JOIN license_identities li ON li.license_id = l.id WHERE l.id = ?', [license.insertId]))[0]);
  const originalContract = await contract();
  const originalInstall = JSON.stringify((await db.query('SELECT * FROM ios_installations WHERE id = ?', [oldId]))[0]);
  const status = async (id: string) => (await db.execute<RowDataPacket[]>('SELECT status FROM ios_signing_replacements WHERE id = ?', [id]))[0][0].status;
  const input = { deviceVersion: 1, setId, setVersion: 1, releaseId, releaseVersion: 1 };
  const queue = async () => (await queueReplacement(admin, deviceId, input)).id;
  const good = async (): Promise<CertificateResult> => ({ status: 'good', detail: 'verified', method: 'ocsp', validUntil: new Date(Date.now() + 3600000).toISOString() });
  const bad = async (): Promise<CertificateResult> => ({ status: 'revoked', detail: 'verified', method: 'ocsp', validUntil: new Date(Date.now() + 3600000).toISOString() });
  const signed = Buffer.from('synthetic verified IPA contract fixture');
  const pack: typeof runPackager = async data => { await writeFile(data.output!, signed); return { ...metadata, verified: true, outputSha256: createHash('sha256').update(signed).digest('hex') }; };
  let issuedId = '';
  try {
    await t.test('stale version, wrong UDID, archived release and unknown Apple status rejected', async () => {
      await assert.rejects(queueReplacement(admin, deviceId, { ...input, deviceVersion: 99 }), /thay đổi/);
      await db.execute(`UPDATE ios_signing_sets SET metadata = JSON_SET(metadata, '$.udids', JSON_ARRAY('00008120-0000000000000000')) WHERE id = ?`, [setId]);
      await assert.rejects(queue(), /UDID/);
      await db.execute(`UPDATE ios_signing_sets SET metadata = JSON_SET(metadata, '$.udids', JSON_ARRAY(?)) WHERE id = ?`, [udid, setId]);
      await db.execute("UPDATE ios_ipa_releases SET state = 'archived' WHERE id = ?", [releaseId]);
      await assert.rejects(queue(), /IPA/);
      await db.execute("UPDATE ios_ipa_releases SET state = 'active' WHERE id = ?", [releaseId]);
      await db.execute("UPDATE ios_certificate_checks SET status = 'unknown' WHERE certificate_sha256 = ?", [sha]);
      await assert.rejects(queue(), /Apple/);
      await db.execute("UPDATE ios_certificate_checks SET status = 'good' WHERE certificate_sha256 = ?", [sha]);
    });
    await t.test('double submit queues one request and issuance cannot precede signing', async () => {
      const results = await Promise.allSettled([queue(), queue()]);
      const ok = results.filter(r => r.status === 'fulfilled'); assert.equal(ok.length, 1);
      const target = (ok[0] as PromiseFulfilledResult<string>).value;
      await assert.rejects(issueReplacement(admin, target, good), /chưa sẵn sàng/);
      await cancelReplacement(admin, target); assert.equal(await state(), initial);
    });
    await t.test('signing failure and Apple revocation preserve all old data', async () => {
      let target = await queue();
      await runReplacementJob(async () => { throw new SigningError('signing_tool_failed'); }, good, target);
      assert.equal(await status(target), 'failed'); assert.equal(await state(), initial);
      target = await queue();
      await runReplacementJob(async () => { assert.fail('must not sign revoked certificate'); }, bad, target);
      assert.equal(await status(target), 'failed'); assert.equal(await state(), initial);
    });
    await t.test('cancelling during signing prevents a late worker result from publishing', async () => {
      const target = await queue();
      await runReplacementJob(async data => { const result = await pack(data); await cancelReplacement(admin, target); return result; }, good, target);
      assert.equal(await status(target), 'cancelled'); assert.equal(await state(), initial);
    });
    await t.test('verified ready artifact does not change the device; stale device prevents issuance', async () => {
      const target = await queue(); await runReplacementJob(pack, good, target);
      assert.equal(await status(target), 'ready'); assert.equal(await state(), initial);
      await db.execute('UPDATE customer_device_profiles SET version = 2 WHERE id = ?', [deviceId]);
      await assert.rejects(issueReplacement(admin, target, good), /Hồ sơ đã thay đổi/);
      await db.execute('UPDATE customer_device_profiles SET version = 1 WHERE id = ?', [deviceId]);
      await cancelReplacement(admin, target);
    });
    await t.test('revoked Apple evidence blocks issuance even when cached check still says good', async () => {
      const target = await queue(); await runReplacementJob(pack, good, target);
      await assert.rejects(issueReplacement(admin, target, bad), /Apple/);
      assert.equal(await status(target), 'ready'); assert.equal(await state(), initial);
      await cancelReplacement(admin, target);
    });
    await t.test('output tampering blocks issuance', async () => {
      const target = await queue(); await runReplacementJob(async data => {
        const result = await pack(data); await writeFile(data.output!, 'tampered'); return result;
      }, good, target);
      assert.equal(await status(target), 'failed'); assert.equal(await state(), initial);
    });
    await t.test('artifact changed after ready is rejected before granting a link', async () => {
      const target = await queue(); await runReplacementJob(pack, good, target);
      const [rows] = await db.execute<RowDataPacket[]>('SELECT output_key FROM ios_signing_replacements WHERE id = ?', [target]);
      await writeFile(objectPath(rows[0].output_key, 'ipa'), 'changed after signing');
      await assert.rejects(issueReplacement(admin, target, good), /IPA đã ký bị thay đổi/);
      assert.equal(await state(), initial); await cancelReplacement(admin, target);
    });
    await t.test('successful issuance is atomic, preserves license and old install, and creates a ready customer session', async () => {
      const target = await queue(); await runReplacementJob(pack, good, target);
      const issued = await issueReplacement(admin, target, good); issuedId = issued.installationId;
      assert.equal(await status(target), 'issued');
      const [devices] = await db.execute<RowDataPacket[]>('SELECT installation_id, version FROM customer_device_profiles WHERE id = ?', [deviceId]);
      assert.equal(devices[0].installation_id, issuedId); assert.equal(devices[0].version, 2);
      assert.equal(await contract(), originalContract);
      assert.equal(JSON.stringify((await db.query('SELECT * FROM ios_installations WHERE id = ?', [oldId]))[0]), originalInstall);
      await assert.rejects(issueReplacement(admin, target, good), /đã cấp/);
      const session = await loginInstallation(issued.code);
      assert.equal((await installationStatus(session.token)).status, 'ready');
      const serialized = JSON.stringify(await replacementContext(deviceId));
      for (const secret of [secretKey, sourceKey, 'test-password', 'test-private', issued.code, 'secrets_key', 'output_key']) assert.equal(serialized.includes(secret), false);
    });
  } finally {
    const [outputs] = await db.execute<RowDataPacket[]>('SELECT output_key FROM ios_signing_replacements WHERE device_profile_id = ?', [deviceId]);
    await db.execute('DELETE FROM ios_signing_replacements WHERE device_profile_id = ?', [deviceId]);
    await db.execute('DELETE FROM customer_device_profiles WHERE id = ?', [deviceId]);
    await db.execute('DELETE FROM ios_installations WHERE id IN (?, ?)', [oldId, issuedId || oldId]);
    await db.execute('DELETE FROM ios_signing_sets WHERE id = ?', [setId]);
    await db.execute('DELETE FROM ios_ipa_releases WHERE id = ?', [releaseId]);
    await db.execute('DELETE FROM ios_certificate_checks WHERE certificate_sha256 = ?', [sha]);
    await db.execute('DELETE FROM licenses WHERE id = ?', [license.insertId]);
    await db.execute('DELETE FROM customers WHERE id = ?', [customer.insertId]);
    await db.execute('DELETE FROM audit_events WHERE admin_id = ?', [admin.id]);
    await db.execute('DELETE FROM admins WHERE id = ?', [admin.id]);
    for (const row of outputs) if (row.output_key) await removeObject(row.output_key, 'ipa');
    await removeObject(sourceKey, 'ipa'); await removeObject(secretKey, 'secret');
    await db.end();
  }
});
