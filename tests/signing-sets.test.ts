import '../scripts/env';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { getDb } from '../src/lib/db';
import { createSigningSet, changeSigningSet, listSigningSets, signingSetDetail } from '../src/lib/signing-sets';
import { loadSecret, objectPath, removeObject } from '../src/lib/install-storage';
import { runCertificateCheck } from '../src/lib/certificate-monitor';
import type { SigningSetMetadata } from '../src/lib/signing-set-types';
import { InputError } from '../src/lib/validation';

if (process.env.DB_HOST !== '127.0.0.1' || process.env.DB_NAME !== 'nemo_blank_test') throw new Error('Dedicated local database required');
test('signing inventory: encrypted storage, scoped associations, concurrency and shared monitoring', async t => {
  const db = getDb(), prefix = 'sets-' + randomBytes(8).toString('hex'), sha = randomBytes(32).toString('hex');
  const udid = '00008120-' + randomBytes(8).toString('hex').toUpperCase();
  const [adminRow] = await db.execute<ResultSetHeader>('INSERT INTO admins (username, display_name, password_hash) VALUES (?, ?, ?)', [prefix, prefix, 'unused']);
  const admin = { id: String(adminRow.insertId), username: prefix, name: prefix };
  const [customer] = await db.execute<ResultSetHeader>('INSERT INTO customers (name) VALUES (?)', [prefix]);
  const [device] = await db.execute<ResultSetHeader>('INSERT INTO customer_device_profiles (customer_id, label, apple_udid) VALUES (?, ?, ?)', [customer.insertId, prefix, udid]);
  const deviceId = String(device.insertId);
  const [wrong] = await db.execute<ResultSetHeader>('INSERT INTO customer_device_profiles (customer_id, label, apple_udid) VALUES (?, ?, ?)', [customer.insertId, prefix + '-other', '00008120-' + randomBytes(8).toString('hex').toUpperCase()]);
  const metadata: SigningSetMetadata = { certificateSha256: sha, certificateExpiresAt: new Date(Date.now() + 86400000 * 30).toISOString(), profileExpiresAt: new Date(Date.now() + 86400000 * 20).toISOString(), profileUuid: '00000000-0000-0000-0000-000000000000', profileName: 'Synthetic profile', team: 'TESTTEAM00', applicationIdentifier: 'TESTTEAM00.*', udids: [udid], signingMode: 'ad-hoc' };
  const form = () => { const f = new FormData(); f.set('name', prefix); f.set('notes', 'inventory'); f.set('password', 'synthetic-secret-value'); f.set('p12', new Blob(['synthetic-private-key']), 'cert.p12'); f.set('profile', new Blob(['synthetic-public-profile']), 'cert.mobileprovision'); return f; };
  const before = JSON.stringify((await db.execute<RowDataPacket[]>('SELECT * FROM customer_device_profiles WHERE customer_id = ? ORDER BY id', [customer.insertId]))[0]);
  let setId = '', otherId = '';
  try {
    await t.test('invalid assets rejected by real helper', async () => { await assert.rejects(createSigningSet(admin, form()), InputError); });
    await t.test('validated assets encrypted at rest and excluded from read responses', async () => {
      setId = (await createSigningSet(admin, form(), async () => metadata)).id;
      const [rows] = await db.execute<RowDataPacket[]>('SELECT secrets_key FROM ios_signing_sets WHERE id = ?', [setId]);
      const key = rows[0].secrets_key;
      assert.equal((await loadSecret(key)).password, 'synthetic-secret-value');
      const raw = await readFile(objectPath(key, 'secret'));
      assert.equal(raw.includes('synthetic-secret-value'), false);
      assert.equal(raw.includes(Buffer.from('synthetic-private-key').toString('base64')), false);
      const result = JSON.stringify(await listSigningSets(new URLSearchParams({ q: prefix })));
      for (const forbidden of [key, 'secrets_key', 'password', 'synthetic-private-key', 'synthetic-secret-value']) assert.equal(result.includes(forbidden), false);
    });
    await t.test('ineligible UDID, stale device and stale set are rejected', async () => {
      await assert.rejects(changeSigningSet(admin, setId, 'link', { version: 1, deviceId: String(wrong.insertId), deviceVersion: 1 }), /UDID/);
      await assert.rejects(changeSigningSet(admin, setId, 'link', { version: 1, deviceId, deviceVersion: 999 }), /vừa thay đổi/);
      await assert.rejects(changeSigningSet(admin, setId, 'edit', { version: 999, name: prefix, notes: '' }), /vừa thay đổi/);
    });
    await t.test('linking preserves actual installation, device, license and monitoring records', async () => {
      await changeSigningSet(admin, setId, 'link', { version: 1, deviceId, deviceVersion: 1 });
      const detail = await signingSetDetail(setId);
      assert.equal(detail.set.linked_count, 1); assert.equal(detail.set.observed_count, 0);
      assert.equal(detail.devices[0].linked, true); assert.equal(detail.devices[0].observed, false);
      assert.equal(JSON.stringify((await db.execute<RowDataPacket[]>('SELECT * FROM customer_device_profiles WHERE customer_id = ? ORDER BY id', [customer.insertId]))[0]), before);
      assert.equal((await db.execute<RowDataPacket[]>('SELECT * FROM ios_device_certificate_assets WHERE device_profile_id = ?', [deviceId]))[0].length, 0);
    });
    await t.test('concurrent edits cannot silently overwrite each other', async () => {
      const outcomes = await Promise.allSettled([changeSigningSet(admin, setId, 'edit', { version: 2, name: prefix, notes: 'A' }), changeSigningSet(admin, setId, 'edit', { version: 2, name: prefix, notes: 'B' })]);
      assert.equal(outcomes.filter(o => o.status === 'fulfilled').length, 1);
      assert.equal(outcomes.filter(o => o.status === 'rejected').length, 1);
    });
    await t.test('archiving retains associations and blocks new links; unlink and restore still work', async () => {
      await changeSigningSet(admin, setId, 'archive', { version: 3 });
      assert.equal((await signingSetDetail(setId)).set.linked_count, 1);
      await assert.rejects(changeSigningSet(admin, setId, 'link', { version: 4, deviceId, deviceVersion: 1 }), /Khôi phục/);
      await changeSigningSet(admin, setId, 'unlink', { version: 4, deviceId, deviceVersion: 1 });
      await changeSigningSet(admin, setId, 'restore', { version: 5 });
      assert.equal((await signingSetDetail(setId)).set.linked_count, 0);
    });
    await t.test('same certificate in multiple profiles checked once; inventory-only revocation sends no misleading affected-device alert', async () => {
      otherId = (await createSigningSet(admin, form(), async () => ({ ...metadata, profileUuid: '11111111-1111-1111-1111-111111111111' }))).id;
      let calls = 0;
      const check = async () => { calls++; return { status: 'revoked' as const, detail: 'verified', method: 'ocsp' as const, validUntil: new Date(Date.now() + 3600000).toISOString() }; };
      await runCertificateCheck(check, sha); await runCertificateCheck(check, sha);
      assert.equal(calls, 1);
      assert.equal((await signingSetDetail(setId)).set.certificate_status, 'revoked');
      assert.equal((await signingSetDetail(otherId)).set.certificate_status, 'revoked');
      assert.equal((await db.execute<RowDataPacket[]>('SELECT * FROM ios_certificate_alerts WHERE certificate_sha256 = ?', [sha]))[0].length, 0);
    });
  } finally {
    const [sets] = await db.execute<RowDataPacket[]>('SELECT secrets_key FROM ios_signing_sets WHERE name = ?', [prefix]);
    await db.execute('DELETE FROM ios_signing_sets WHERE name = ?', [prefix]);
    for (const set of sets) await removeObject(set.secrets_key, 'secret');
    await db.execute('DELETE FROM ios_certificate_checks WHERE certificate_sha256 = ?', [sha]);
    await db.execute('DELETE FROM customer_device_profiles WHERE customer_id = ?', [customer.insertId]);
    await db.execute('DELETE FROM customers WHERE id = ?', [customer.insertId]);
    await db.execute('DELETE FROM audit_events WHERE admin_id = ?', [admin.id]);
    await db.execute('DELETE FROM admins WHERE id = ?', [admin.id]);
    await db.end();
  }
});
