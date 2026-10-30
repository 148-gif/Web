import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMysqlDataStore } from '../server/mysql-store.mjs';
import { createMysqlKv } from '../server/mysql-kv.mjs';
import { createMysqlRateLimitStore } from '../server/mysql-rate-limit.mjs';
import { createFileMedia } from '../server/file-media.mjs';
import { handle, makeSession, sha256 } from '../cms-worker/worker.mjs';
import { makeGithub } from './helpers/fake-github.mjs';
import { mysqlEnabled, withMysqlDatabase } from './helpers/mysql.mjs';

const integration = (name, fn) => test(name, { skip: !mysqlEnabled, timeout: 30000 }, () => withMysqlDatabase(fn));
// Opt-in tests must still be discoverable before npm installation in the
// dependency-free Worker/Pages checks. Only the actual MySQL run loads its driver.
const createPool = async (config) => (await import('mysql2/promise')).createPool(config);
const draft = (path = 'data/site.json', extra = {}) => ({ path, content: '{"title":"שלום"}', deleted: 0, base_sha: null, created_at: 1700000000000, updated_at: 1700000000000, email: 'editor@example.test', name: 'Editor', ...extra });
const actor = { email: 'editor@example.test', name: 'Editor' };
const limits = { ghFile: 32, ghTotal: 32, r2File: 32, r2Total: 32, r2: true };
const reservation = (id, extra = {}) => ({ item: { id, name: 'file.txt', kind: 'doc', mime: 'text/plain; charset=utf-8', size: 24, githubKey: `site/media/${id}.txt`, r2Key: `${id}.txt`, ...extra }, actor, now: 1700000000000, limits });

integration('real MySQL schema validation verifies the prepared schema without mutating it', async ({ pool }) => {
  const store = createMysqlDataStore(pool), result = await store.ensureSchema();
  assert.match(result.version, /^8\.4\./); assert.equal(result.schemaVerified, true);
  const [locks] = await pool.query('SELECT name FROM cms_locks ORDER BY name');
  assert.deepEqual(locks.map((row) => row.name), ['ai', 'kv:editors', 'kv:owner-names', 'kv:people', 'media']);
  const [collations] = await pool.query("SELECT PAD_ATTRIBUTE AS padding FROM information_schema.COLLATIONS WHERE COLLATION_NAME = 'utf8mb4_0900_bin'");
  assert.equal(collations[0].padding, 'NO PAD');
});

test('real MySQL validation refuses an empty database without creating tables', { skip: !mysqlEnabled }, () => withMysqlDatabase(async ({ pool }) => {
  await assert.rejects(createMysqlDataStore(pool).ensureSchema(), /required MySQL table/);
  const [tables] = await pool.query('SHOW TABLES'); assert.equal(tables.length, 0);
}, { schema: false }));

integration('real MySQL validation rejects schema drift that would truncate draft content', async ({ pool }) => {
  await pool.query('ALTER TABLE drafts MODIFY content TEXT NULL');
  await assert.rejects(createMysqlDataStore(pool).ensureSchema(), /required MySQL columns: drafts/);
});

integration('real MySQL concurrent draft create and full-snapshot update each admit one writer', async ({ pool, config }) => {
  const otherPool = await createPool(config), a = createMysqlDataStore(pool), b = createMysqlDataStore(otherPool);
  try {
    const initial = draft();
    const created = await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? a : b).writeDraftSnapshot(initial, null)));
    assert.equal(created.filter(Boolean).length, 1);
    const expected = await a.getDraft(initial.path);
    const changes = Array.from({ length: 12 }, (_, i) => ({ ...expected, content: JSON.stringify({ writer: i }), updated_at: expected.updated_at + 1 }));
    const updated = await Promise.all(changes.map((next, i) => (i % 2 ? a : b).writeDraftSnapshot(next, expected)));
    assert.equal(updated.filter(Boolean).length, 1);
    assert.equal((await a.getDraft(initial.path)).content, changes[updated.indexOf(true)].content);
    assert.equal(await b.clearDraftSnapshot(initial.path, expected), false);
  } finally { await otherPool.end(); }
});

integration('real MySQL snapshot comparison distinguishes trailing spaces, case, normalization and null', async ({ pool }) => {
  const store = createMysqlDataStore(pool), initial = draft('data/letters.json', { content: '{"é":"א"}', name: 'Name ' });
  assert.equal(await store.writeDraftSnapshot(initial, null), true);
  for (const changed of [{ name: 'Name' }, { name: 'name ' }, { content: '{"é":"א"}' }, { base_sha: '' }]) {
    assert.equal(await store.clearDraftSnapshot(initial.path, { ...initial, ...changed }), false);
  }
  assert.deepEqual(await store.getDraft(initial.path), initial);
  assert.equal(await store.clearDraftSnapshot(initial.path, initial), true);
});

integration('real MySQL publication cleanup preserves a newer draft and bounds each content packet', async ({ pool }) => {
  const store = createMysqlDataStore(pool), content = JSON.stringify({ text: 'א'.repeat(1_500_000) });
  const snapshots = Array.from({ length: 6 }, (_, i) => draft(`data/large-${i}.json`, { content }));
  for (const row of snapshots) assert.equal(await store.writeDraftSnapshot(row, null), true);
  const next = { ...snapshots[2], content: '{"newer":true}', updated_at: snapshots[2].updated_at + 1 };
  assert.equal(await store.writeDraftSnapshot(next, snapshots[2]), true);
  await store.cleanupPublishedDrafts(snapshots);
  assert.deepEqual(await store.listDrafts(), [next]);
});

integration('real MySQL cleanup rolls back earlier deletes if a later delete fails', async ({ pool }) => {
  const store = createMysqlDataStore(pool), rows = [draft('data/a.json'), draft('data/z.json')];
  for (const row of rows) await store.writeDraftSnapshot(row, null);
  await pool.query("CREATE TRIGGER reject_cleanup BEFORE DELETE ON drafts FOR EACH ROW BEGIN IF OLD.path = 'data/z.json' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'test rollback'; END IF; END");
  await assert.rejects(store.cleanupPublishedDrafts(rows), /test rollback/);
  assert.equal((await store.listDrafts()).length, 2);
});

integration('real MySQL aggregate media quota serializes independent pools and keeps GitHub-first routing', async ({ pool, config }) => {
  const otherPool = await createPool(config), stores = [createMysqlDataStore(pool), createMysqlDataStore(otherPool)];
  try {
    const admitted = await Promise.all(Array.from({ length: 10 }, (_, i) => stores[i % 2].reserveMedia(reservation(`file${i}`))));
    assert.deepEqual(admitted.filter(Boolean).map((row) => row.store).sort(), ['github', 'r2']);
    assert.deepEqual((await stores[0].mediaUsage()).map((row) => [row.store, row.n, row.c]).sort(), [['github', 24, 1], ['r2', 24, 1]]);
  } finally { await otherPool.end(); }
});

integration('real MySQL photo key reservation is exclusive and photos never fall back to R2', async ({ pool }) => {
  const store = createMysqlDataStore(pool), make = (id) => reservation(id, { kind: 'photo', mime: 'image/webp', githubKey: 'data/img/photo/640.webp' });
  const results = await Promise.all([store.reserveMedia(make('photo1')), store.reserveMedia(make('photo2'))]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(results.find(Boolean).store, 'github');
  assert.equal(await store.reserveMedia(reservation('other', { kind: 'photo', mime: 'image/webp', githubKey: 'data/img/other/640.webp' })), null);
});

integration('real MySQL pending R2 deletion retains quota until the reservation is dropped', async ({ pool }) => {
  const store = createMysqlDataStore(pool), video = (id) => reservation(id, { kind: 'video', mime: 'video/mp4' });
  await store.reserveMedia(video('video1'));
  assert.equal(await store.claimR2Upload('video1', actor.email), true);
  assert.equal(await store.finishR2Upload('video1'), true);
  assert.equal(await store.claimMediaRemoval('video1', 'published'), true);
  assert.equal(await store.claimMediaRemoval('video1', 'removing'), true);
  assert.equal(await store.reserveMedia(video('video2')), null);
  await store.dropMedia('video1');
  assert.equal((await store.reserveMedia(video('video2'))).store, 'r2');
});

integration('real MySQL chunks are immutable, staged uploads reject late writes, and removal leaves no orphans', async ({ pool }) => {
  const store = createMysqlDataStore(pool);
  await store.reserveMedia(reservation('chunks'));
  const chunk = { id: 'chunks', n: 0, data: Buffer.alloc(24, 65).toString('base64'), email: actor.email };
  assert.deepEqual(await Promise.all([store.writeMediaChunk(chunk), store.writeMediaChunk(chunk)]), [true, true]);
  assert.equal(await store.writeMediaChunk({ ...chunk, data: Buffer.alloc(24, 66).toString('base64') }), false);
  assert.equal(await store.finishGithubUpload('chunks', actor.email), true);
  assert.equal(await store.writeMediaChunk(chunk), false);
  assert.equal((await store.getStagedChunk('chunks', 0)).data, chunk.data);
  await store.dropMedia('chunks');
  assert.equal(await store.writeMediaChunk(chunk), false);
  assert.deepEqual(await store.getUploadChunks('chunks'), []);
});

integration('real MySQL upload expiration rolls back chunks and preserves receiving rows', async ({ pool }) => {
  const store = createMysqlDataStore(pool);
  await store.reserveMedia(reservation('expired'));
  await store.writeMediaChunk({ id: 'expired', n: 0, data: Buffer.alloc(24).toString('base64'), email: actor.email });
  await store.reserveMedia(reservation('receiving', { kind: 'video', mime: 'video/mp4' }));
  await store.claimR2Upload('receiving', actor.email);
  await pool.query("CREATE TRIGGER reject_expiry BEFORE DELETE ON media FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'test rollback'");
  await assert.rejects(store.expireMedia(1700000000001), /test rollback/);
  assert.equal((await store.getUploadChunks('expired')).length, 1);
  assert.equal((await store.getMedia('expired')).status, 'uploading');
  await pool.query('DROP TRIGGER reject_expiry');
  await store.expireMedia(1700000000001);
  assert.equal(await store.getMedia('expired'), null);
  assert.deepEqual(await store.getUploadChunks('expired'), []);
  assert.equal((await store.getMedia('receiving')).status, 'receiving');
});

integration('real MySQL AI quota enforces both user and shared budgets under concurrency', async ({ pool, config }) => {
  const otherPool = await createPool(config), stores = [createMysqlDataStore(pool), createMysqlDataStore(otherPool)];
  try {
    const admission = { day: '2026-10-30', perUser: 2, perDay: 5 };
    const attempts = await Promise.all(Array.from({ length: 30 }, (_, i) => stores[i % 2].consumeAiQuota({ ...admission, email: `user${i % 3}@example.test` })));
    assert.equal(attempts.filter(Boolean).length, 5);
    const [usage] = await pool.query('SELECT n FROM ai_usage'); assert(usage.every((row) => Number(row.n) <= 2));
    assert.equal(await stores[0].consumeAiQuota({ ...admission, day: '2026-10-31', email: 'user0@example.test' }), true);
  } finally { await otherPool.end(); }
});

integration('real MySQL activity IDs retain precision and unsafe generated IDs roll back', async ({ pool }) => {
  const store = createMysqlDataStore(pool), row = { ts: 1700000000000, email: actor.email, name: actor.name, action: 'test', path: null, summary: null, sha: null };
  await pool.query('ALTER TABLE log AUTO_INCREMENT = 9007199254740991');
  assert.equal((await store.appendLog(row)).id, Number.MAX_SAFE_INTEGER);
  await assert.rejects(store.appendLog(row), /activity ID/);
  const logged = await store.listLog({ before: 0, limit: 10 });
  assert.equal(logged.length, 1); assert.equal(logged[0].id, Number.MAX_SAFE_INTEGER);
});

test('the real Worker saves, publishes, edits membership and streams media using MySQL without D1', { skip: !mysqlEnabled, timeout: 30000 }, async (t) => withMysqlDatabase(async ({ pool }) => {
  const root = await mkdtemp(join(tmpdir(), 'cms-mysql-flow-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const page = 'data/pages/example.json', github = await makeGithub({ files: { [page]: '{"title":"Before","blocks":[]}\n', 'data/topics.json': '[]\n' } });
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const result = await github.fetch(url, options);
    if (!result) throw new Error('Unexpected external request in MySQL integration test');
    return result;
  });
  const env = {
    ALLOWED_ORIGIN: 'https://site.example', REPO: 'o/r', BRANCH: 'live',
    GITHUB_TOKEN: 'test-github', SESSION_SECRET: 'test-session', OWNERS: await sha256(actor.email),
    DATA_STORE: createMysqlDataStore(pool), EDITORS: createMysqlKv(pool), RATE_LIMIT_STORE: createMysqlRateLimitStore(pool),
    MEDIA: await createFileMedia({ root }),
  };
  Object.defineProperty(env, 'DB', { get() { throw new Error('MySQL runtime must not access D1'); } });
  await env.DATA_STORE.ensureSchema();
  const token = await makeSession(actor.email, env);
  const request = (method, path, body, raw = false) => handle(new Request(`https://api.example${path}`, {
    method, headers: { Origin: env.ALLOWED_ORIGIN, Authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: raw ? body : JSON.stringify(body) }),
  }), env);
  const api = async (...args) => { const response = await request(...args); return { status: response.status, body: await response.json() }; };
  const live = await api('GET', `/gh/contents/${page}`);
  assert.equal(live.status, 200);
  const content = '{"title":"After","blocks":[]}\n';
  assert.equal((await api('PUT', `/gh/contents/${page}`, { content: Buffer.from(content).toString('base64'), sha: live.body.sha })).status, 200);
  assert.equal((await api('POST', '/publish', { paths: [page] })).status, 200);
  assert.equal(github.read(page), content);
  assert.deepEqual((await api('GET', '/changes')).body.changes, []);
  const added = await Promise.all([
    api('PUT', '/editors', { email: 'first@example.test', name: 'First', publisher: true }),
    api('PUT', '/editors', { email: 'second@example.test', name: 'Second', publisher: false }),
  ]);
  assert(added.every((result) => result.status === 200));
  assert.equal((await env.EDITORS.get('people', 'json')).length, 2);
  const video = Buffer.alloc(24, 65); video.write('ftyp', 4, 'ascii');
  const initialized = await api('POST', '/media/init', { name: 'movie.mp4', size: video.length });
  assert.equal(initialized.status, 200); assert.equal(initialized.body.store, 'r2');
  const uploaded = await api('PUT', `/media/r2?id=${initialized.body.id}`, video, true);
  assert.equal(uploaded.status, 200);
  const file = uploaded.body.item.key;
  const publicRead = await handle(new Request(`https://api.example/m/${file}`, { headers: { Range: 'bytes=4-7' } }), env);
  assert.equal(publicRead.status, 206); assert.equal(await publicRead.text(), 'ftyp');
  assert.equal((await api('DELETE', `/media/${initialized.body.id}`)).status, 200);
  assert.equal(await env.MEDIA.head(file), null);
  assert((await api('GET', '/log?limit=10')).body.log.some((row) => row.action === 'publish-all'));
  const [rateRows] = await pool.query('SELECT n FROM request_limits');
  assert(rateRows.some((row) => Number(row.n) >= 6));
}));
