import '../scripts/env';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import type { ResultSetHeader } from 'mysql2/promise';
import { getDb } from '../src/lib/db';
import { tokenHash } from '../src/lib/password';

const base = process.env.TEST_BASE_URL || 'http://localhost:3117';
if (process.env.DB_HOST !== '127.0.0.1' || process.env.DB_NAME !== 'nemo_blank_test' || !['localhost', '127.0.0.1'].includes(new URL(base).hostname)) throw new Error('Dedicated local environment required');
test('signing-set HTTP authorization, CSRF, bounds and no secret-download route', { skip: !process.env.TEST_BASE_URL }, async () => {
  const db = getDb(), token = randomBytes(32).toString('hex'), name = 'http-sets-' + randomBytes(8).toString('hex');
  const [row] = await db.execute<ResultSetHeader>('INSERT INTO admins (username, display_name, password_hash) VALUES (?, ?, ?)', [name, name, 'unused']);
  await db.execute('INSERT INTO admin_sessions (token_hash, admin_id, expires_at) VALUES (?, ?, UTC_TIMESTAMP(3) + INTERVAL 5 MINUTE)', [tokenHash(token), row.insertId]);
  const origin = new URL(base).origin, cookie = 'nemo_admin_session=' + token;
  const url = base + '/api/admin/signing-sets';
  try {
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { method: 'POST' })).status, 401);
    const list = await fetch(url, { headers: { cookie } });
    assert.equal(list.status, 200); assert.match(list.headers.get('cache-control') || '', /no-store/);
    assert.equal((await fetch(url, { method: 'POST', headers: { cookie, origin: 'https://evil.invalid' } })).status, 403);
    assert.equal((await fetch(url + '/1/archive', { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    assert.equal((await fetch(url, { method: 'POST', headers: { cookie, origin, 'Content-Type': 'text/plain' }, body: 'invalid' })).status, 415);
    const form = new FormData(); form.set('name', name); form.set('password', '');
    form.set('p12', new Blob(['invalid']), 'fake.p12'); form.set('profile', new Blob(['invalid']), 'fake.mobileprovision');
    assert.equal((await fetch(url, { method: 'POST', headers: { cookie, origin }, body: form })).status, 400);
    assert.equal((await fetch(url, { method: 'POST', headers: { cookie, origin, 'Content-Type': 'multipart/form-data; boundary=test' }, body: Buffer.alloc(3 * 1024 * 1024 + 32769) })).status, 413);
    assert.equal((await fetch(url + '/1/download', { headers: { cookie } })).status, 404);
    const page = await fetch(base + '/admin/signing-sets', { headers: { cookie } });
    assert.equal(page.status, 200); assert.match(await page.text(), /Bộ ký/);
  } finally {
    await db.execute('DELETE FROM admin_sessions WHERE admin_id = ?', [row.insertId]);
    await db.execute('DELETE FROM admins WHERE id = ?', [row.insertId]);
    await db.end();
  }
});
