import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createMysqlRateLimitStore } from '../server/mysql-rate-limit.mjs';
import { loginLimit, writeLimit } from '../cms-worker/rate-limit.mjs';
import { mysqlEnabled, withMysqlDatabase } from './helpers/mysql.mjs';

const hash = (text) => createHash('sha256').update(text).digest('hex');
const login = (overrides = {}) => ({ scope: 'login', windowStart: 120000, limit: 5, subject: hash('client'), subjectLimit: 2, ...overrides });
const write = (overrides = {}) => ({ scope: `write:${hash('editor@example.test')}`, windowStart: 120000, limit: 17, subject: null, subjectLimit: null, ...overrides });

test('MySQL rate admissions validate hashed identity and integer bounds before storage', async () => {
  const store = createMysqlRateLimitStore({ getConnection() { throw new Error('Storage must not be reached'); } });
  for (const value of [null, [], {}, login({ scope: 'login ' }), login({ windowStart: 1 }), login({ windowStart: -60000 }), login({ windowStart: Number.MAX_SAFE_INTEGER + 1 }), login({ limit: 0 }), login({ limit: 1001 }), login({ subject: '192.0.2.1' }), login({ subjectLimit: 0 }), write({ limit: 5001 }), write({ subject: hash('client') }), write({ scope: 'write:editor@example.test' })]) {
    await assert.rejects(store(value), /Invalid rate-limit/);
  }
});

test('MySQL login admission serializes concurrent clients without spending quota on denials', { skip: !mysqlEnabled }, async () => {
  await withMysqlDatabase(async ({ pool }) => {
    const store = createMysqlRateLimitStore(pool);
    const first = await Promise.all(Array.from({ length: 40 }, () => store(login())));
    assert.equal(first.filter(Boolean).length, 2);
    const [[before]] = await pool.query('SELECT n FROM request_limits');
    assert.equal(Number(before.n), 2);
    const others = await Promise.all(Array.from({ length: 40 }, (_, i) => store(login({ subject: hash(`other${i}`) }))));
    assert.equal(others.filter(Boolean).length, 3);
    const [rows] = await pool.query('SELECT * FROM request_limits');
    assert.equal(rows.length, 1);
    assert.equal(Number(rows[0].n), 5);
    const clients = JSON.parse(rows[0].clients);
    assert.equal(clients[hash('client')], 2);
    assert.equal(Object.keys(clients).length, 4, 'globally denied new subjects do not grow the map');
    assert.equal(Object.values(clients).reduce((a, b) => a + b, 0), 5);
  });
});

test('MySQL write limits are exact per user under concurrency and reset without clock rollback', { skip: !mysqlEnabled }, async () => {
  await withMysqlDatabase(async ({ pool }) => {
    const store = createMysqlRateLimitStore(pool);
    const attempts = await Promise.all(Array.from({ length: 80 }, () => store(write())));
    assert.equal(attempts.filter(Boolean).length, 17);
    assert.equal(await store(write({ scope: `write:${hash('other@example.test')}` })), true);
    assert.equal(await store(write({ windowStart: 180000 })), true);
    assert.equal(await store(write()), false, 'an old request cannot roll the window back');
    const [rows] = await pool.query('SELECT * FROM request_limits WHERE scope = ?', [write().scope]);
    assert.equal(Number(rows[0].window_start), 180000);
    assert.equal(Number(rows[0].n), 1);
    assert.equal(rows[0].clients, '{}');
  });
});

test('MySQL rate hook composes with runtime hashing, trusted address and retry-after behavior', { skip: !mysqlEnabled }, async () => {
  await withMysqlDatabase(async ({ pool }) => {
    const env = { RATE_LIMIT_STORE: createMysqlRateLimitStore(pool), CLIENT_IP: () => '192.0.2.1', RATE_LOGIN_PER_CLIENT: 1, RATE_WRITE_PER_MINUTE: 1 };
    const request = new Request('https://api.example.test/session', { headers: { 'X-Forwarded-For': '203.0.113.5' } });
    assert.deepEqual(await loginLimit(request, env, 179100), { allowed: true, retryAfter: 1 });
    assert.deepEqual(await loginLimit(request, env, 179100), { allowed: false, retryAfter: 1 });
    assert.equal((await loginLimit(request, env, 180000)).allowed, true);
    assert.equal((await writeLimit(env, 'editor@example.test', 180000)).allowed, true);
    assert.equal((await writeLimit(env, 'editor@example.test', 180000)).allowed, false);
    const [rows] = await pool.query('SELECT scope, clients FROM request_limits');
    assert.equal(rows.length, 2);
    assert.ok(!JSON.stringify(rows).includes('editor@example.test') && !JSON.stringify(rows).includes('192.0.2.1'));
  });
});

test('MySQL corrupted counters fail closed and are not reset or partially repaired', { skip: !mysqlEnabled }, async () => {
  await withMysqlDatabase(async ({ pool }) => {
    const store = createMysqlRateLimitStore(pool);
    await pool.execute("INSERT INTO request_limits (scope, window_start, n, clients) VALUES ('login', 120000, 2, '{}')");
    await assert.rejects(store(login({ windowStart: 180000 })), /Invalid rate-limit storage result/);
    const [[row]] = await pool.query('SELECT window_start, n, clients FROM request_limits');
    assert.equal(Number(row.window_start), 120000);
    assert.equal(Number(row.n), 2);
    assert.equal(row.clients, '{}');
  });
});
