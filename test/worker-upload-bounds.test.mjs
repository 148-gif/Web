import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle, makeSession } from '../cms-worker/worker.mjs';
import { makeD1 } from './helpers/d1.mjs';
import { makeGithub } from './helpers/fake-github.mjs';

const CHUNK_BYTES = 393216;
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (size) => { const bytes = Buffer.alloc(size, 7); PNG_HEADER.copy(bytes); return bytes; };

async function world(t) {
  const db = makeD1();
  t.after(() => db.raw.close());
  const github = await makeGithub();
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const response = await github.fetch(url, options);
    if (!response) throw new Error(`Unexpected network request: ${url}`);
    return response;
  });
  const env = {
    ALLOWED_ORIGIN: 'https://site.example', REPO: 'o/r', BRANCH: 'live',
    GITHUB_TOKEN: 'test-github-token', SESSION_SECRET: 'test-session-secret', DB: db,
    EDITORS: { get: async (key) => key === 'people' ? JSON.stringify([{ email: 'editor@example.com', name: 'Editor', publisher: false }]) : null },
  };
  const token = await makeSession('editor@example.com', env);
  const api = async (path, body) => {
    const response = await handle(new Request(`https://worker.example${path}`, {
      method: 'POST', headers: { Origin: env.ALLOWED_ORIGIN, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }), env);
    return { status: response.status, body: await response.json() };
  };
  const init = async (size, name = 'photo.png') => {
    const response = await api('/media/init', { name, size });
    assert.equal(response.status, 200);
    assert.equal(response.body.store, 'github');
    assert.equal(response.body.chunk, 524288);
    return response.body.id;
  };
  const chunks = (id) => db.raw.prepare('SELECT n, data FROM media_chunks WHERE id = ? ORDER BY n').all(id);
  return { api, init, chunks, db };
}

for (const n of [1, 1000, Number.MAX_SAFE_INTEGER + 1]) {
  test(`an upload cannot store a chunk outside its declared file (n=${n})`, async (t) => {
    const w = await world(t), bytes = png(48), id = await w.init(bytes.length);
    const response = await w.api('/media/chunk', { id, n, data: bytes.toString('base64') });
    assert.ok([400, 413].includes(response.status), `expected rejection, received ${response.status}`);
    assert.equal(w.chunks(id).length, 0, 'rejected bytes must never enter pending storage');
  });
}

for (const actualSize of [47, 49]) {
  test(`a chunk must match its declared byte budget (declared 48, actual ${actualSize})`, async (t) => {
    const w = await world(t), id = await w.init(48);
    const response = await w.api('/media/chunk', { id, n: 0, data: png(actualSize).toString('base64') });
    assert.ok([400, 413].includes(response.status), `expected rejection, received ${response.status}`);
    assert.equal(w.chunks(id).length, 0);
  });
}

test('a nonfinal chunk cannot use padding to store fewer bytes than its reserved piece', async (t) => {
  const w = await world(t), id = await w.init(CHUNK_BYTES + 1);
  const data = png(CHUNK_BYTES - 1).toString('base64');
  assert.equal(data.length, 524288, 'encoded length alone must not validate the piece');
  assert.ok(data.endsWith('='));
  const response = await w.api('/media/chunk', { id, n: 0, data });
  assert.ok([400, 413].includes(response.status), `expected rejection, received ${response.status}`);
  assert.equal(w.chunks(id).length, 0);
});

test('malformed base64 padding is rejected before storage', async (t) => {
  const w = await world(t), id = await w.init(48);
  const valid = png(48).toString('base64');
  const response = await w.api('/media/chunk', { id, n: 0, data: `${valid}=` });
  assert.ok([400, 413].includes(response.status), `expected rejection, received ${response.status}`);
  assert.equal(w.chunks(id).length, 0);
});

for (const tail of [1, 2, 3]) {
  test(`full chunks, a ${tail}-byte final chunk and retries preserve the original file`, async (t) => {
    const w = await world(t), bytes = png(CHUNK_BYTES + tail), id = await w.init(bytes.length);
    const pieces = [bytes.subarray(0, CHUNK_BYTES).toString('base64'), bytes.subarray(CHUNK_BYTES).toString('base64')];
    assert.equal(pieces[0].length, 524288);
    assert.equal((pieces[1].match(/=/g) || []).length, tail === 3 ? 0 : 3 - tail);
    for (let n = 0; n < pieces.length; n++) {
      const body = { id, n, data: pieces[n] };
      assert.equal((await w.api('/media/chunk', body)).status, 200);
      assert.equal((await w.api('/media/chunk', body)).status, 200, 'retrying a valid piece is idempotent');
    }
    const stored = w.chunks(id);
    assert.equal(stored.length, 2);
    assert.deepEqual(Buffer.from(stored.map((piece) => piece.data).join(''), 'base64'), bytes);
    const complete = await w.api('/media/done', { id });
    assert.equal(complete.status, 200);
    assert.equal(complete.body.item.status, 'staged');
    assert.equal(complete.body.item.size, bytes.length);
  });
}

test('an exactly full final chunk needs no padding', async (t) => {
  const w = await world(t), bytes = png(CHUNK_BYTES), id = await w.init(bytes.length);
  const data = bytes.toString('base64');
  assert.equal(data.length, 524288);
  assert.ok(!data.endsWith('='));
  assert.equal((await w.api('/media/chunk', { id, n: 0, data })).status, 200);
  assert.equal((await w.api('/media/done', { id })).status, 200);
});

for (const text of ['a', 'ab']) {
  test(`a valid ${text.length}-byte text file remains uploadable`, async (t) => {
    const w = await world(t), id = await w.init(text.length, 'tiny.txt');
    assert.equal((await w.api('/media/chunk', { id, n: 0, data: Buffer.from(text).toString('base64') })).status, 200);
    assert.equal((await w.api('/media/done', { id })).status, 200);
  });
}

test('noncanonical base64 is rejected even when its decoded size is correct', async (t) => {
  const w = await world(t), id = await w.init(1, 'tiny.txt');
  assert.equal(Buffer.from('YR==', 'base64').toString(), 'a');
  assert.equal((await w.api('/media/chunk', { id, n: 0, data: 'YR==' })).status, 400);
  assert.equal(w.chunks(id).length, 0);
});

test('completion rejects invalid chunks accepted by an earlier server version', async (t) => {
  const w = await world(t), id = await w.init(1, 'tiny.txt');
  w.db.raw.prepare('INSERT INTO media_chunks (id, n, data) VALUES (?, 0, ?)').run(id, 'YR==');
  assert.equal((await w.api('/media/done', { id })).status, 400);
  assert.equal(w.chunks(id).length, 0);
});

test('an accepted chunk is immutable, while identical retries remain valid', async (t) => {
  const w = await world(t), bytes = png(48), id = await w.init(bytes.length);
  const original = { id, n: 0, data: bytes.toString('base64') };
  assert.equal((await w.api('/media/chunk', original)).status, 200);
  bytes[47] = 8;
  assert.equal((await w.api('/media/chunk', { ...original, data: bytes.toString('base64') })).status, 409);
  assert.equal((await w.api('/media/chunk', original)).status, 200);
  assert.equal(w.chunks(id)[0].data, original.data);
  assert.equal((await w.api('/media/done', { id })).status, 200);
});

for (const state of ['staged', 'removed']) {
  test(`a delayed chunk cannot write after its upload was ${state}`, async (t) => {
    const w = await world(t), bytes = png(48), id = await w.init(bytes.length);
    const prepare = w.db.prepare;
    let changed = false;
    t.mock.method(w.db, 'prepare', (sql) => {
      const statement = prepare(sql);
      if (sql === 'SELECT * FROM media WHERE id = ?') {
        const bind = statement.bind;
        statement.bind = (...args) => {
          const bound = bind(...args), first = bound.first;
          bound.first = async () => {
            const row = await first();
            if (!changed) {
              changed = true;
              if (state === 'staged') w.db.raw.prepare("UPDATE media SET status = 'staged' WHERE id = ?").run(id);
              else w.db.raw.prepare('DELETE FROM media WHERE id = ?').run(id);
            }
            return row;
          };
          return bound;
        };
      }
      return statement;
    });
    assert.equal((await w.api('/media/chunk', { id, n: 0, data: bytes.toString('base64') })).status, 409);
    assert.equal(w.chunks(id).length, 0, 'no chunks can outlive their active upload');
  });
}
