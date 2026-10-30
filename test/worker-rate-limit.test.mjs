import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { makeSession } from '../cms-worker/worker.mjs';
import { loginLimit, writeLimit } from '../cms-worker/rate-limit.mjs';
import { makeD1 } from './helpers/d1.mjs';
import { makeGithub } from './helpers/fake-github.mjs';

const NOW = 120005;
const EMAIL = 'publisher@example.test';
const origin = 'https://site.example';

function storage(t, overrides = {}) {
  const db = makeD1();
  t.after(() => db.raw.close());
  return { db, env: { DB: db, ...overrides } };
}

function clientRequest(address, { cloudflare = false, forwarded = address } = {}) {
  const request = new Request('https://worker.example/session', {
    method: 'POST', headers: { 'CF-Connecting-IP': address, 'X-Forwarded-For': forwarded, Forwarded: `for=${forwarded}` },
  });
  if (cloudflare) Object.defineProperty(request, 'cf', { value: {} });
  return request;
}

test('concurrent per-client denials do not spend the shared login allowance or add unbounded clients', async (t) => {
  const { db, env } = storage(t, { RATE_LOGIN_PER_MINUTE: 5, RATE_LOGIN_PER_CLIENT: 2 });
  const sameClient = clientRequest('192.0.2.1', { cloudflare: true });
  const first = await Promise.all(Array.from({ length: 20 }, () => loginLimit(sameClient, env, NOW)));
  assert.equal(first.filter((r) => r.allowed).length, 2);
  assert.equal(db.raw.prepare('SELECT n FROM request_limits WHERE scope = ?').get('login').n, 2);
  for (const address of ['192.0.2.2', '192.0.2.2', '192.0.2.3']) {
    assert.equal((await loginLimit(clientRequest(address, { cloudflare: true }), env, NOW)).allowed, true);
  }
  const denied = await Promise.all(Array.from({ length: 40 }, (_, i) => loginLimit(clientRequest(`198.51.100.${i}`, { cloudflare: true }), env, NOW)));
  assert.ok(denied.every((r) => !r.allowed));
  const rows = db.raw.prepare('SELECT * FROM request_limits').all();
  assert.equal(rows.length, 1, 'client addresses never create individual rows');
  assert.equal(rows[0].n, 5);
  const clients = JSON.parse(rows[0].clients);
  assert.equal(Object.keys(clients).length, 3);
  assert.equal(Object.values(clients).reduce((a, n) => a + n, 0), 5);
  assert.ok(Object.keys(clients).every((key) => /^[0-9a-f]{64}$/.test(key)));
  assert.ok(!rows[0].clients.includes('192.0.2.') && !rows[0].clients.includes('198.51.100.'));
});

test('login windows reset atomically, report remaining seconds and never roll backward', async (t) => {
  const { db, env } = storage(t, { RATE_LOGIN_PER_MINUTE: '1', RATE_LOGIN_PER_CLIENT: '1' });
  const request = clientRequest('192.0.2.1', { cloudflare: true });
  assert.equal((await loginLimit(request, env, 120000)).allowed, true);
  assert.deepEqual(await loginLimit(request, env, 179100), { allowed: false, retryAfter: 1 });
  assert.deepEqual(await loginLimit(request, env, 180000), { allowed: true, retryAfter: 60 });
  assert.equal((await loginLimit(request, env, 120000)).allowed, false);
  const row = db.raw.prepare('SELECT * FROM request_limits').get();
  assert.equal(row.window_start, 180000);
  assert.equal(row.n, 1);
  assert.deepEqual(Object.values(JSON.parse(row.clients)), [1]);
});

test('untrusted forwarding headers share the unknown subject; only trusted runtime addresses separate clients', async (t) => {
  const { db, env } = storage(t, { RATE_LOGIN_PER_CLIENT: 1 });
  assert.equal((await loginLimit(clientRequest('192.0.2.1'), env, NOW)).allowed, true);
  assert.equal((await loginLimit(clientRequest('192.0.2.2'), env, NOW)).allowed, false);
  assert.equal((await loginLimit(new Request('https://worker.example/session'), env, NOW)).allowed, false);
  assert.equal((await loginLimit(clientRequest('192.0.2.1', { cloudflare: true }), env, NOW)).allowed, true);
  assert.equal((await loginLimit(clientRequest('192.0.2.2', { cloudflare: true }), env, NOW)).allowed, true);
  const bridged = { ...env, CLIENT_IP: () => '2001:db8::1' };
  assert.equal((await loginLimit(clientRequest('203.0.113.1', { cloudflare: true }), bridged, NOW)).allowed, true);
  assert.equal((await loginLimit(clientRequest('203.0.113.2', { cloudflare: true }), bridged, NOW)).allowed, false, 'the trusted bridge takes precedence over caller headers');
  assert.equal(db.raw.prepare('SELECT n FROM request_limits').get().n, 4);
});

test('the default write budget is atomic per verified user and stores no email or client map', async (t) => {
  const { db, env } = storage(t);
  const attempts = await Promise.all(Array.from({ length: 310 }, () => writeLimit(env, EMAIL, NOW)));
  assert.equal(attempts.filter((r) => r.allowed).length, 300);
  assert.equal((await writeLimit(env, 'other@example.test', NOW)).allowed, true);
  const rows = db.raw.prepare('SELECT * FROM request_limits ORDER BY n DESC').all();
  assert.deepEqual(rows.map((r) => r.n), [300, 1]);
  assert.ok(rows.every((r) => /^write:[0-9a-f]{64}$/.test(r.scope) && r.clients === '{}'));
  assert.equal((await writeLimit(env, EMAIL, 180000)).allowed, true);
});

test('invalid configuration and malformed or unavailable stores fail closed', async (t) => {
  const { db, env } = storage(t);
  for (const value of [0, -1, 1.5, true, null, '', ' 2 ', 'abc', 5001]) {
    await assert.rejects(writeLimit({ ...env, RATE_WRITE_PER_MINUTE: value }, EMAIL, NOW), /Invalid RATE_WRITE_PER_MINUTE/);
  }
  const request = clientRequest('192.0.2.1');
  await assert.rejects(loginLimit(request, { ...env, RATE_LOGIN_PER_MINUTE: 1001 }, NOW), /Invalid RATE_LOGIN_PER_MINUTE/);
  await assert.rejects(loginLimit(request, { ...env, RATE_LOGIN_PER_CLIENT: 1001 }, NOW), /Invalid RATE_LOGIN_PER_CLIENT/);
  await assert.rejects(loginLimit(request, { ...env, CLIENT_IP: 'untrusted' }, NOW), /Invalid CLIENT_IP/);
  await assert.rejects(writeLimit({ ...env, RATE_LIMIT_STORE: async () => undefined }, EMAIL, NOW), /Invalid rate-limit storage result/);
  await assert.rejects(writeLimit({ ...env, RATE_LIMIT_STORE: async () => { throw new Error('store unavailable'); } }, EMAIL, NOW), /store unavailable/);
  const malformedDB = { prepare: () => ({ run: async () => ({}), bind() { return this; }, first: async () => undefined }) };
  await assert.rejects(writeLimit({ DB: malformedDB }, EMAIL, NOW), /Invalid rate-limit storage result/);
  assert.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'request_limits'").get().n, 0);
});

test('an injected atomic store receives only bounded limits and hashed identifiers', async () => {
  const seen = [];
  const env = { CLIENT_IP: () => '192.0.2.4', RATE_LIMIT_STORE: async (admission) => { seen.push(admission); return false; } };
  assert.deepEqual(await loginLimit(clientRequest('203.0.113.9'), env, NOW), { allowed: false, retryAfter: 60 });
  assert.deepEqual(await writeLimit(env, EMAIL, NOW), { allowed: false, retryAfter: 60 });
  assert.equal(seen[0].scope, 'login');
  assert.match(seen[0].subject, /^[0-9a-f]{64}$/);
  assert.equal(seen[0].limit, 120);
  assert.equal(seen[0].subjectLimit, 10);
  assert.match(seen[1].scope, /^write:[0-9a-f]{64}$/);
  assert.equal(seen[1].subject, null);
  assert.equal(seen[1].limit, 300);
  assert.ok(!JSON.stringify(seen).includes(EMAIL) && !JSON.stringify(seen).includes('192.0.2.4'));
});

async function world(t, overrides = {}) {
  const { db } = storage(t);
  const github = await makeGithub();
  const clients = new WeakMap();
  let googleRequests = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (new URL(url).origin === 'https://oauth2.googleapis.com') {
      googleRequests++;
      return Response.json({ aud: 'test-client', email: EMAIL, email_verified: 'true', expires_in: '3000' });
    }
    const response = await github.fetch(url, options);
    if (!response) throw new Error(`Unexpected network request: ${url}`);
    return response;
  });
  const env = {
    DB: db, ALLOWED_ORIGIN: origin, GOOGLE_CLIENT_ID: 'test-client', REPO: 'o/r', BRANCH: 'live',
    GITHUB_TOKEN: 'test-github-token', SESSION_SECRET: 'test-session-secret', CLIENT_IP: (request) => clients.get(request),
    EDITORS: { get: async (key) => key === 'people' ? JSON.stringify([{ email: EMAIL, name: 'Publisher', publisher: true }]) : null },
    ...overrides,
  };
  const token = await makeSession(EMAIL, env);
  const api = async (method, path, body, options = {}) => {
    const request = new Request(`https://worker.example${path}`, {
      method, headers: { Origin: origin, Authorization: `Bearer ${options.token ?? token}`, 'Content-Type': 'application/json', ...options.headers },
      body: Object.hasOwn(options, 'raw') ? options.raw : body === undefined ? undefined : JSON.stringify(body),
    });
    if (options.ip) clients.set(request, options.ip);
    const response = await worker.fetch(request, env);
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  return { db, env, api, get googleRequests() { return googleRequests; } };
}

const limitedResponse = (response) => {
  assert.equal(response.status, 429);
  const seconds = Number(response.headers.get('Retry-After'));
  assert.ok(Number.isInteger(seconds) && seconds >= 1 && seconds <= 60);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
};

test('login admission follows bounded JSON parsing and gates Google with CORS and Retry-After', async (t) => {
  const w = await world(t, { RATE_LOGIN_PER_MINUTE: 2, RATE_LOGIN_PER_CLIENT: 1 });
  assert.equal((await w.api('POST', '/session', undefined, { raw: '{broken', ip: '192.0.2.1' })).status, 400);
  assert.equal(w.db.raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'request_limits'").get().n, 0);
  assert.equal((await w.api('POST', '/session', { access_token: 'test' }, { ip: '192.0.2.1' })).status, 200);
  limitedResponse(await w.api('POST', '/session', { access_token: 'test' }, { ip: '192.0.2.1' }));
  assert.equal((await w.api('POST', '/session', { access_token: 'test' }, { ip: '192.0.2.2' })).status, 200);
  limitedResponse(await w.api('POST', '/session', { access_token: 'test' }, { ip: '192.0.2.3' }));
  assert.equal(w.googleRequests, 2);
  assert.equal(w.db.raw.prepare("SELECT n FROM request_limits WHERE scope = 'login'").get().n, 2);
});

test('verified-user writes are limited before mutation while reads and invalid sessions do not consume admission', async (t) => {
  const w = await world(t, { RATE_WRITE_PER_MINUTE: 2 });
  assert.equal((await w.api('POST', '/translate', { text: 'ברסלב' })).status, 200);
  assert.equal((await w.api('POST', '/translate', { text: 'ברסלב' })).status, 200);
  limitedResponse(await w.api('PUT', '/me', { name: 'Must not change' }));
  const me = await w.api('GET', '/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.name, 'Publisher');
  assert.equal((await w.api('POST', '/translate', {}, { token: 'invalid' })).status, 401);
  assert.equal(w.db.raw.prepare('SELECT n FROM request_limits').get().n, 2);
  assert.equal(w.db.raw.prepare('SELECT COUNT(*) AS n FROM log').get().n, 0);
});

test('limiter storage failures stop login and mutations without calling Google or changing content', async (t) => {
  const w = await world(t, { RATE_LIMIT_STORE: async () => { throw new Error('test storage unavailable'); } });
  for (const [method, path, body] of [['POST', '/session', { access_token: 'test' }], ['PUT', '/me', { name: 'Must not change' }]]) {
    const response = await w.api(method, path, body);
    assert.equal(response.status, 500);
    assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
  assert.equal(w.googleRequests, 0);
  assert.equal(w.db.raw.prepare('SELECT COUNT(*) AS n FROM log').get().n, 0);
});

test('a normal small-file upload stays within the default mutation budget', async (t) => {
  const w = await world(t);
  const init = await w.api('POST', '/media/init', { name: 'note.txt', size: 3 });
  assert.equal(init.status, 200);
  assert.equal((await w.api('POST', '/media/chunk', { id: init.body.id, n: 0, data: 'YWJj' })).status, 200);
  const completed = await w.api('POST', '/media/done', { id: init.body.id });
  assert.equal(completed.status, 200);
  assert.equal(completed.body.item.status, 'staged');
  assert.equal(w.db.raw.prepare('SELECT n FROM request_limits').get().n, 3);
});

test('membership revoked between session verification and mutation is rejected before limiter storage', async (t) => {
  let reads = 0, admissions = 0;
  const w = await world(t, {
    EDITORS: { get: async (key) => key === 'people' && ++reads === 1 ? JSON.stringify([{ email: EMAIL, name: 'Publisher', publisher: true }]) : null },
    RATE_LIMIT_STORE: async () => { admissions++; return true; },
  });
  assert.equal((await w.api('POST', '/translate', { text: 'ברסלב' })).status, 401);
  assert.equal(admissions, 0);
  assert.equal(w.db.raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get().n, 0);
});
