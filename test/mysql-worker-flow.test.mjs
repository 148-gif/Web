import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { handle } from '../cms-worker/worker.mjs';
import { createMysqlDataStore } from '../server/mysql-store.mjs';
import { createMysqlKv } from '../server/mysql-kv.mjs';
import { createMysqlRateLimitStore } from '../server/mysql-rate-limit.mjs';
import { makeGithub } from './helpers/fake-github.mjs';
import { mysqlEnabled, withMysqlDatabase } from './helpers/mysql.mjs';

const options = { skip: !mysqlEnabled, timeout: 15000 };
const EMAIL = 'editor@example.test';
const OWNER = 'owner@example.test';
const PAGE = 'data/pages/example.json';
const text = (title) => `${JSON.stringify({ title, blocks: [] })}\n`;
const hash = (value) => createHash('sha256').update(value).digest('hex');
const deferred = () => Promise.withResolvers();

async function world(t, pool, patch = {}) {
  // Keep all concurrent calls in one quota window and exercise monotonic saves.
  t.mock.method(Date, 'now', () => 1800000000123);
  const github = await makeGithub({ files: { [PAGE]: text('Published'), 'data/topics.json': '[]\n' } });
  const env = {
    ALLOWED_ORIGIN: 'https://site.example', REPO: 'o/r', BRANCH: 'live',
    GOOGLE_CLIENT_ID: 'fixture-client', GITHUB_TOKEN: 'fixture-github-token',
    SESSION_SECRET: 'fixture-session-signing-key', OWNERS: hash(OWNER),
    DATA_STORE: createMysqlDataStore(pool), EDITORS: createMysqlKv(pool),
    RATE_LIMIT_STORE: createMysqlRateLimitStore(pool), CLIENT_IP: () => '192.0.2.90',
    ...patch,
  };
  assert.equal(Object.hasOwn(env, 'DB'), false, 'this flow must never fall back to the D1 adapter');
  await env.EDITORS.put('people', JSON.stringify([{ email: EMAIL, name: 'עורך', publisher: true }]));
  let gate = null, googleCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url, init = {}) => {
    const target = new URL(url);
    if (target.origin === 'https://oauth2.googleapis.com' && target.pathname === '/tokeninfo') {
      googleCalls++;
      const token = target.searchParams.get('access_token');
      if (!token?.startsWith('fixture:')) return Response.json({}, { status: 401 });
      return Response.json({ aud: env.GOOGLE_CLIENT_ID, email: token.slice(8), email_verified: 'true', expires_in: '3000' });
    }
    if (gate && gate.matches(target, init)) {
      const waiting = gate;
      if (--waiting.remaining === 0) { gate = null; waiting.entered.resolve(); }
      await waiting.release.promise;
    }
    const response = await github.fetch(url, init);
    if (!response) throw new Error('Unexpected external request in MySQL integration fixture');
    return response;
  });
  const api = async (token, method, path, body) => {
    const response = await handle(new Request(`https://worker.example${path}`, {
      method, headers: { Origin: env.ALLOWED_ORIGIN, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), env);
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  const login = async (email = EMAIL) => {
    const response = await api(null, 'POST', '/session', { access_token: `fixture:${email}` });
    assert.equal(response.status, 200);
    assert.equal(response.body.email, email);
    return response.body.token;
  };
  const save = (token, value, sha) => api(token, 'PUT', `/gh/contents/${PAGE}`, { content: Buffer.from(text(value)).toString('base64'), sha });
  const pause = (matches, remaining = 1) => {
    assert.equal(gate, null);
    gate = { matches, remaining, entered: deferred(), release: deferred() };
    const current = gate;
    t.after(() => current.release.resolve());
    return { entered: current.entered.promise, release: current.release.resolve };
  };
  return { env, github, api, login, save, pause, get googleCalls() { return googleCalls; } };
}

test('MySQL-backed Worker authenticates Google sessions, keeps private responses and audits sign-in', options, async (t) => {
  await withMysqlDatabase(async ({ pool }) => {
    const w = await world(t, pool);
    const token = await w.login();
    const me = await w.api(token, 'GET', '/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.name, 'עורך');
    assert.equal(me.body.publisher, true);
    assert.equal(me.headers.get('Cache-Control'), 'no-store');
    assert.equal(me.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal((await w.api(null, 'GET', '/me')).status, 401);
    assert.equal((await w.api(null, 'POST', '/session', { access_token: 'fixture:stranger@example.test' })).status, 403);
    const [rows] = await pool.query('SELECT email, action FROM log');
    assert.deepEqual(rows.map((row) => ({ ...row })), [{ email: EMAIL, action: 'login' }]);
    assert.equal(w.googleCalls, 2);
  });
});

test('MySQL-backed Worker accepts one concurrent save and rejects a stale revision without changing Git', options, async (t) => {
  await withMysqlDatabase(async ({ pool }) => {
    const w = await world(t, pool), token = await w.login();
    const published = await w.api(token, 'GET', `/gh/contents/${PAGE}`);
    const gate = w.pause((url, init) => (init.method || 'GET') === 'GET' && url.pathname === `/repos/o/r/contents/${PAGE}` && url.searchParams.get('ref') === 'live', 2);
    const saves = ['תוכן ראשון 🙂', 'תוכן שני é'].map((value) => w.save(token, value, published.body.sha));
    try { await gate.entered; } finally { gate.release(); }
    const results = await Promise.all(saves);
    assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
    const winner = results[0].status === 200 ? 'תוכן ראשון 🙂' : 'תוכן שני é';
    const read = await w.api(token, 'GET', `/gh/contents/${PAGE}`);
    assert.equal(read.body.draft, true);
    assert.equal(Buffer.from(read.body.content, 'base64').toString(), text(winner));
    assert.equal((await w.save(token, 'stale overwrite', published.body.sha)).status, 409);
    const [[row]] = await pool.query('SELECT content, email FROM drafts WHERE path = ?', [PAGE]);
    assert.equal(row.content, text(winner));
    assert.equal(row.email, EMAIL);
    assert.equal(w.github.read(PAGE), text('Published'));
    const changes = await w.api(token, 'GET', '/changes');
    assert.equal(changes.body.changes.length, 1);
  });
});

test('MySQL-backed publication preserves a newer draft saved while the Git commit is being prepared', options, async (t) => {
  await withMysqlDatabase(async ({ pool }) => {
    const w = await world(t, pool), token = await w.login();
    const published = await w.api(token, 'GET', `/gh/contents/${PAGE}`);
    const saved = await w.save(token, 'Captured snapshot', published.body.sha);
    assert.equal(saved.status, 200);
    const gate = w.pause((url, init) => init.method === 'POST' && url.pathname === '/repos/o/r/git/blobs');
    const publishing = w.api(token, 'POST', '/publish', { paths: [PAGE] });
    try {
      await gate.entered;
      assert.equal((await w.save(token, 'Newer unsent work', saved.body.content.sha)).status, 200);
    } finally { gate.release(); }
    const done = await publishing;
    assert.equal(done.status, 200);
    assert.equal(w.github.read(PAGE), text('Captured snapshot'));
    const [[row]] = await pool.query('SELECT content FROM drafts WHERE path = ?', [PAGE]);
    assert.equal(row.content, text('Newer unsent work'));
    const log = await w.api(token, 'GET', '/log');
    assert.equal(log.status, 200);
    assert.ok(log.body.log.some((entry) => entry.action === 'publish-all'));
    assert.ok(log.body.log.every((entry) => entry.email === null), 'publisher response hides private email addresses');
  });
});

test('MySQL-backed media upload keeps immutable chunks and publishes the original bytes with cleanup', options, async (t) => {
  await withMysqlDatabase(async ({ pool }) => {
    const w = await world(t, pool), token = await w.login();
    const bytes = Buffer.alloc(48, 7);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes);
    const init = await w.api(token, 'POST', '/media/init', { name: 'fixture.png', size: bytes.length });
    assert.equal(init.status, 200);
    assert.equal(init.body.store, 'github');
    const body = { id: init.body.id, n: 0, data: bytes.toString('base64') };
    assert.equal((await w.api(token, 'POST', '/media/chunk', body)).status, 200);
    assert.equal((await w.api(token, 'POST', '/media/chunk', body)).status, 200);
    const changed = Buffer.from(bytes); changed[47] = 8;
    assert.equal((await w.api(token, 'POST', '/media/chunk', { ...body, data: changed.toString('base64') })).status, 409);
    const done = await w.api(token, 'POST', '/media/done', { id: body.id });
    assert.equal(done.status, 200);
    assert.equal(done.body.item.status, 'staged');
    const preview = await w.api(token, 'GET', `/media/${body.id}/chunk?n=0`);
    assert.equal(preview.body.data, body.data);
    assert.equal((await w.api(token, 'POST', '/media/chunk', body)).status, 404);
    const published = await w.api(token, 'POST', '/publish', { paths: [done.body.item.key] });
    assert.equal(published.status, 200);
    assert.deepEqual(w.github.readBytes(done.body.item.key), bytes);
    const [[row]] = await pool.query('SELECT status, size FROM media WHERE id = ?', [body.id]);
    assert.equal(row.status, 'published');
    assert.equal(Number(row.size), bytes.length);
    const [[chunks]] = await pool.query('SELECT COUNT(*) AS n FROM media_chunks WHERE id = ?', [body.id]);
    assert.equal(Number(chunks.n), 0);
  });
});

test('MySQL-backed owner updates retain concurrent additions and a revoked editor cannot restore membership', options, async (t) => {
  await withMysqlDatabase(async ({ pool }) => {
    const w = await world(t, pool), owner = await w.login(OWNER), editor = await w.login();
    const additions = await Promise.all(['first@example.test', 'second@example.test'].map((email) => w.api(owner, 'PUT', '/editors', { email, name: email.split('@')[0], publisher: false })));
    assert.ok(additions.every((response) => response.status === 200));
    const people = await w.env.EDITORS.get('people', 'json');
    assert.deepEqual(new Set(people.map((person) => person.email)), new Set([EMAIL, 'first@example.test', 'second@example.test']));

    const entered = deferred(), release = deferred(), update = w.env.EDITORS.update.bind(w.env.EDITORS);
    let pause = true;
    t.after(() => release.resolve());
    t.mock.method(w.env.EDITORS, 'update', async (key, updater) => {
      if (pause && key === 'people') { pause = false; entered.resolve(); await release.promise; }
      return update(key, updater);
    });
    const renaming = w.api(editor, 'PUT', '/me', { name: 'Delayed rename' });
    try {
      await entered.promise;
      assert.equal((await w.api(owner, 'DELETE', '/editors', { email: EMAIL })).status, 200);
    } finally { release.resolve(); }
    assert.equal((await renaming).status, 401);
    assert.equal((await w.api(editor, 'GET', '/me')).status, 401);
    const remaining = await w.env.EDITORS.get('people', 'json');
    assert.equal(remaining.some((person) => person.email === EMAIL), false);
    assert.equal(remaining.length, 2, 'revocation must not erase concurrent owner additions');
  });
});

test('MySQL-backed Worker returns 429 before login verification or excess mutations consume quota', options, async (t) => {
  await withMysqlDatabase(async ({ pool }) => {
    const w = await world(t, pool, { RATE_LOGIN_PER_CLIENT: 1, RATE_WRITE_PER_MINUTE: 2 });
    const token = await w.login();
    const blockedLogin = await w.api(null, 'POST', '/session', { access_token: `fixture:${EMAIL}` });
    assert.equal(blockedLogin.status, 429);
    assert.equal(w.googleCalls, 1, 'blocked login must never reach Google verification');
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => w.api(token, 'PUT', '/me', { name: `שם ${i}` })));
    assert.equal(results.filter((result) => result.status === 200).length, 2);
    assert.equal(results.filter((result) => result.status === 429).length, 6);
    for (const result of [blockedLogin, ...results.filter((item) => item.status === 429)]) {
      assert.ok(Number(result.headers.get('Retry-After')) >= 1 && Number(result.headers.get('Retry-After')) <= 60);
      assert.equal(result.headers.get('Cache-Control'), 'no-store');
    }
    const [[writes]] = await pool.query('SELECT n FROM request_limits WHERE scope = ?', [`write:${hash(EMAIL)}`]);
    assert.equal(Number(writes.n), 2);
    const [[names]] = await pool.query("SELECT COUNT(*) AS n FROM log WHERE action = 'name'");
    assert.equal(Number(names.n), 2);
  });
});
