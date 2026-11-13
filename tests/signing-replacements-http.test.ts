import '../scripts/env';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { ResultSetHeader } from 'mysql2/promise';
import { getDb } from '../src/lib/db';
import { tokenHash } from '../src/lib/password';
const base = process.env.TEST_BASE_URL || 'http://localhost:3117';
if (process.env.DB_HOST !== '127.0.0.1' || process.env.DB_NAME !== 'nemo_blank_test' || !['localhost', '127.0.0.1'].includes(new URL(base).hostname)) throw new Error('Dedicated local environment required');
test('replacement endpoints enforce authentication, CSRF, validation and render a protected device page', { skip: !process.env.TEST_BASE_URL }, async () => {
  const db = getDb(), name = 'replace-http-' + randomBytes(8).toString('hex'), token = randomBytes(32).toString('hex');
  const [admin] = await db.execute<ResultSetHeader>('INSERT INTO admins (username, display_name, password_hash) VALUES (?, ?, ?)', [name, name, 'unused']);
  const [customer] = await db.execute<ResultSetHeader>('INSERT INTO customers (name) VALUES (?)', [name]);
  const [device] = await db.execute<ResultSetHeader>('INSERT INTO customer_device_profiles (customer_id, label, apple_udid) VALUES (?, ?, ?)', [customer.insertId, name, '00008120-' + randomBytes(8).toString('hex').toUpperCase()]);
  await db.execute('INSERT INTO admin_sessions (token_hash, admin_id, expires_at) VALUES (?, ?, UTC_TIMESTAMP(3) + INTERVAL 5 MINUTE)', [tokenHash(token), admin.insertId]);
  const cookie = 'nemo_admin_session=' + token, origin = new URL(base).origin;
  const url = base + '/api/admin/signing-replacements/' + device.insertId;
  try {
    assert.equal((await fetch(url)).status, 401);
    for (const action of ['queue', 'cancel', 'issue']) {
      assert.equal((await fetch(url + '/' + action, { method: 'POST', headers: { origin, 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
      assert.equal((await fetch(url + '/' + action, { method: 'POST', headers: { cookie, origin: 'https://evil.invalid', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    }
    const response = await fetch(url, { headers: { cookie } });
    assert.equal(response.status, 200); assert.match(response.headers.get('cache-control') || '', /no-store/);
    const result = await response.json(); assert.equal(result.device.id, String(device.insertId)); assert.equal(result.device.license_id, null);
    const invalid = await fetch(url + '/queue', { method: 'POST', headers: { cookie, origin, 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(invalid.status, 400);
    const page = await fetch(base + `/admin/devices/${device.insertId}/replace-signing`, { headers: { cookie } });
    assert.equal(page.status, 200); assert.match(await page.text(), /Thay bộ ký/);
    const noAuth = await fetch(base + `/admin/devices/${device.insertId}/replace-signing`, { redirect: 'manual' }); assert.equal(noAuth.status, 307);
  } finally {
    await db.execute('DELETE FROM customer_device_profiles WHERE id = ?', [device.insertId]);
    await db.execute('DELETE FROM customers WHERE id = ?', [customer.insertId]);
    await db.execute('DELETE FROM admin_sessions WHERE admin_id = ?', [admin.insertId]);
    await db.execute('DELETE FROM admins WHERE id = ?', [admin.insertId]);
    await db.end();
  }
});
