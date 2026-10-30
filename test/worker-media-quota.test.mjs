import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { makeSession } from '../cms-worker/worker.mjs';
import { makeD1 } from './helpers/d1.mjs';
import { makeGithub } from './helpers/fake-github.mjs';

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const barrier = (count) => {
  const ready = deferred();
  return async () => { if (--count === 0) ready.resolve(); await ready.promise; };
};
const EMAIL = 'editor@example.test';
const expired = () => Date.now() - 2 * 36e5;

async function world(t, { r2 = true, ghTotal = 32, r2Total = 32, ghFile = 32, r2File = 32, files = {} } = {}) {
  const db = makeD1(), state = { failReserve: false, failCleanup: false, beforeReserve: null, beforeCleanup: null, beforeChunk: null, storageDeletes: 0 };
  t.after(() => db.raw.close());
  const basePrepare = db.prepare;
  const prepared = (sql, args = []) => {
    const bound = basePrepare(sql).bind(...args);
    return {
      sql, args,
      bind: (...values) => prepared(sql, values),
      async first() {
        if (sql.startsWith('WITH requested AS')) {
          if (state.beforeReserve) await state.beforeReserve();
          if (state.failReserve) throw new Error('simulated reservation write failure');
        }
        if (sql.startsWith('INSERT INTO media_chunks') && state.beforeChunk) await state.beforeChunk();
        return bound.first();
      },
      all: () => bound.all(),
      run: () => bound.run(),
    };
  };
  db.prepare = prepared;
  // Model D1's documented batch transaction synchronously. The general helper's
  // sequential async runner does not model rollback or inter-statement isolation.
  db.batch = async (statements) => {
    const cleanup = statements[0]?.sql.startsWith('DELETE FROM media_chunks WHERE id IN');
    if (cleanup && state.beforeCleanup) await state.beforeCleanup();
    db.raw.exec('BEGIN');
    try {
      for (const [i, statement] of statements.entries()) {
        db.raw.prepare(statement.sql).run(...statement.args);
        if (cleanup && i === 0 && state.failCleanup) throw new Error('simulated cleanup failure');
      }
      db.raw.exec('COMMIT');
      return [];
    } catch (error) { db.raw.exec('ROLLBACK'); throw error; }
  };
  const github = await makeGithub({ files });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const response = await github.fetch(url, options);
    if (!response) throw new Error(`Unexpected network request: ${url}`);
    return response;
  });
  const env = {
    ALLOWED_ORIGIN: 'https://site.example', REPO: 'o/r', BRANCH: 'live',
    GITHUB_TOKEN: 'local-test-github', SESSION_SECRET: 'local-test-signing', DB: db,
    MEDIA_GH_FILE_MB: ghFile / 1048576, MEDIA_GH_TOTAL_MB: ghTotal / 1048576,
    MEDIA_R2_FILE_MB: r2File / 1048576, MEDIA_R2_TOTAL_GB: r2Total / 1024 ** 3,
    EDITORS: { get: async (key) => key === 'people' ? JSON.stringify([{ email: EMAIL, name: 'Editor', publisher: true }]) : null },
    ...(r2 ? { MEDIA: { delete: async () => { state.storageDeletes++; } } } : {}),
  };
  const token = await makeSession(EMAIL, env);
  const api = async (path, body, method = 'POST') => {
    const response = await worker.fetch(new Request(`https://worker.example${path}`, {
      method, headers: { Origin: env.ALLOWED_ORIGIN, Authorization: `Bearer ${token}` },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), env);
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await api('/me', undefined, 'GET')).status, 200);
  const rows = () => db.raw.prepare('SELECT * FROM media ORDER BY id').all();
  const seed = ({ id = '12345678', store = 'github', status = 'uploading', size = 24, createdAt = Date.now(), chunk = false } = {}) => {
    const key = store === 'github' ? `site/media/${id}-file.txt` : `${id}-file.mp4`;
    db.raw.prepare("INSERT INTO media (id, name, kind, mime, size, store, key, status, email, by_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Editor', ?)")
      .run(id, 'file', store === 'github' ? 'doc' : 'video', store === 'github' ? 'text/plain' : 'video/mp4', size, store, key, status, EMAIL, createdAt);
    if (chunk) db.raw.prepare('INSERT INTO media_chunks (id, n, data) VALUES (?, 0, ?)').run(id, Buffer.alloc(size, 97).toString('base64'));
    return id;
  };
  return { api, db, env, state, rows, seed };
}

for (const tier of ['github', 'r2', 'photo']) {
  test(`concurrent ${tier} reservations cannot both spend 24 of 32 available bytes`, { timeout: 2000 }, async (t) => {
    const w = await world(t, { r2: tier !== 'github' });
    w.state.beforeReserve = barrier(2);
    const input = (i) => tier === 'photo' ? { photo: { id: `photo-${i}`, file: '640.webp' }, size: 24 } : { name: tier === 'r2' ? 'movie.mp4' : 'image.png', size: 24 };
    const responses = await Promise.all([w.api('/media/init', input(1)), w.api('/media/init', input(2))]);
    assert.deepEqual(responses.map((r) => r.status).sort(), [200, 413]);
    assert.equal(w.rows().length, 1);
    assert.equal(w.rows()[0].size, 24);
    assert.equal(w.rows()[0].store, tier === 'r2' ? 'r2' : 'github');
    assert.equal(responses.find((r) => r.status === 200).body.chunk, 524288);
  });
}

test('concurrent small files retain GitHub-first routing and atomically fall back to R2', { timeout: 2000 }, async (t) => {
  const w = await world(t);
  w.state.beforeReserve = barrier(2);
  const input = { name: 'image.png', size: 24 };
  const responses = await Promise.all([w.api('/media/init', input), w.api('/media/init', input)]);
  assert.deepEqual(responses.map((r) => r.status), [200, 200]);
  assert.deepEqual(w.rows().map((r) => r.store).sort(), ['github', 'r2']);
  assert.equal((await w.api('/media/init', input)).status, 413);
  assert.equal(w.rows().length, 2);
});

for (const [label, options, input, expected] of [
  ['exact GitHub file limit', {}, { name: 'file.png', size: 32 }, 'github'],
  ['exact R2 file limit', {}, { name: 'movie.mp4', size: 32 }, 'r2'],
  ['video bypasses free GitHub space', {}, { name: 'movie.mp4', size: 1 }, 'r2'],
  ['larger nonvideo uses R2', { ghFile: 16 }, { name: 'file.png', size: 24 }, 'r2'],
  ['full GitHub aggregate uses R2', { ghTotal: 16 }, { name: 'file.png', size: 24 }, 'r2'],
  ['both file limits reject oversize', {}, { name: 'file.png', size: 33 }, 413],
  ['video requires R2', { r2: false }, { name: 'movie.mp4', size: 1 }, 413],
  ['photos never spill into R2', { ghFile: 16 }, { photo: { id: 'photo-a', file: '640.webp' }, size: 24 }, 413],
]) {
  test(`atomic reservation preserves routing: ${label}`, async (t) => {
    const w = await world(t, options), response = await w.api('/media/init', input);
    assert.equal(response.status, typeof expected === 'string' ? 200 : expected);
    assert.equal(w.rows().length, typeof expected === 'string' ? 1 : 0);
    if (typeof expected === 'string') assert.equal(response.body.store, expected);
  });
}

test('two photo initializations cannot reserve the same active key', { timeout: 2000 }, async (t) => {
  const w = await world(t, { ghTotal: 64 });
  w.state.beforeReserve = barrier(2);
  const input = { photo: { id: 'same-photo', file: '640.webp' }, size: 24 };
  const responses = await Promise.all([w.api('/media/init', input), w.api('/media/init', input)]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  assert.equal(w.rows().length, 1);
});

test('published photo conflicts remain protected without reserving any quota', async (t) => {
  const w = await world(t, { files: { 'data/img/existing/640.webp': 'published image' } });
  assert.equal((await w.api('/media/init', { photo: { id: 'existing', file: '640.webp' }, size: 24 })).status, 409);
  assert.equal(w.rows().length, 0);
});

test('a failed reservation write does not consume quota and can be retried', async (t) => {
  const w = await world(t);
  w.state.failReserve = true;
  assert.equal((await w.api('/media/init', { name: 'movie.mp4', size: 24 })).status, 500);
  assert.equal(w.rows().length, 0);
  w.state.failReserve = false;
  assert.equal((await w.api('/media/init', { name: 'movie.mp4', size: 24 })).status, 200);
  assert.equal(w.rows().length, 1);
});

for (const store of ['github', 'r2']) {
  test(`expiration releases abandoned ${store} reservations and their chunks together`, async (t) => {
    const w = await world(t, { r2: store === 'r2' });
    const id = w.seed({ store, createdAt: expired(), chunk: true });
    const response = await w.api('/media/init', { name: store === 'r2' ? 'movie.mp4' : 'file.txt', size: 24 });
    assert.equal(response.status, 200);
    assert.equal(w.rows().length, 1);
    assert.notEqual(w.rows()[0].id, id);
    assert.equal(w.db.raw.prepare('SELECT COUNT(*) AS n FROM media_chunks').get().n, 0);
    assert.equal(w.state.storageDeletes, 0, 'only reservations not receiving bytes expire by age');
  });
}

for (const status of ['receiving', 'removing', 'published']) {
  test(`old R2 ${status} objects retain their reservation during initialization cleanup`, async (t) => {
    const w = await world(t), id = w.seed({ store: 'r2', status, createdAt: expired() });
    assert.equal((await w.api('/media/init', { name: 'movie.mp4', size: 24 })).status, 413);
    assert.equal(w.rows().length, 1);
    assert.equal(w.rows()[0].id, id);
    assert.equal(w.rows()[0].status, status);
    assert.equal(w.state.storageDeletes, 0);
  });
}

test('cleanup rechecks status atomically when an old R2 upload is claimed before the batch runs', { timeout: 2000 }, async (t) => {
  const w = await world(t), id = w.seed({ store: 'r2', createdAt: expired() }), paused = deferred(), release = deferred();
  w.state.beforeCleanup = async () => { paused.resolve(); await release.promise; };
  const init = w.api('/media/init', { name: 'movie.mp4', size: 24 });
  await paused.promise;
  w.db.raw.prepare("UPDATE media SET status = 'receiving' WHERE id = ? AND status = 'uploading'").run(id);
  release.resolve();
  assert.equal((await init).status, 413);
  assert.equal(w.rows()[0].status, 'receiving');
  assert.equal(w.rows()[0].id, id);
});

test('cleanup rolls back deleted chunks if removing their expired reservation fails', async (t) => {
  const w = await world(t, { r2: false }), id = w.seed({ createdAt: expired(), chunk: true });
  w.state.failCleanup = true;
  assert.equal((await w.api('/media/init', { name: 'file.txt', size: 24 })).status, 500);
  assert.equal(w.rows()[0].id, id);
  assert.equal(w.db.raw.prepare('SELECT COUNT(*) AS n FROM media_chunks WHERE id = ?').get(id).n, 1);
  w.state.failCleanup = false;
  assert.equal((await w.api('/media/init', { name: 'file.txt', size: 24 })).status, 200);
  assert.equal(w.rows().length, 1);
  assert.notEqual(w.rows()[0].id, id);
  assert.equal(w.db.raw.prepare('SELECT COUNT(*) AS n FROM media_chunks').get().n, 0);
});

test('a delayed chunk cannot recreate orphan data after expiration removes its upload', { timeout: 2000 }, async (t) => {
  const w = await world(t, { r2: false }), id = w.seed({ createdAt: expired() }), paused = deferred(), release = deferred();
  w.state.beforeChunk = async () => { paused.resolve(); await release.promise; };
  const chunk = w.api('/media/chunk', { id, n: 0, data: Buffer.alloc(24, 97).toString('base64') });
  await paused.promise;
  assert.equal((await w.api('/media/init', { name: 'file.txt', size: 24 })).status, 200);
  release.resolve();
  assert.equal((await chunk).status, 409);
  assert.equal(w.db.raw.prepare('SELECT COUNT(*) AS n FROM media_chunks').get().n, 0);
});
