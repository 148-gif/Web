import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle, makeSession, sha256 } from '../cms-worker/worker.mjs';
import { createD1DataStore, getDataStore } from '../cms-worker/data-store.mjs';
import { makeD1 } from './helpers/d1.mjs';
import { makeGithub } from './helpers/fake-github.mjs';

const owner = 'owner@example.test', otherOwner = 'other-owner@example.test', editor = 'editor@example.test';
const page = 'data/pages/example.json';
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

function atomicKv(initial) {
  const values = new Map(Object.entries(initial)), tails = new Map();
  let pause;
  return {
    values,
    get: async (key) => values.get(key) ?? null,
    put: async () => { throw new Error('Worker must use the atomic update hook for membership mutations'); },
    async update(key, update) {
      if (pause?.key === key) {
        const gate = pause; pause = null;
        gate.entered.resolve(); await gate.release.promise;
      }
      const previous = tails.get(key), current = deferred();
      tails.set(key, current.promise);
      await previous;
      try {
        const next = await update(values.get(key) ?? null);
        values.set(key, next); return next;
      } finally { current.resolve(); }
    },
    delayNext(key) {
      pause = { key, entered: deferred(), release: deferred() };
      const gate = pause;
      return { entered: gate.entered.promise, release: gate.release.resolve };
    },
  };
}

async function world(t, initial = {}) {
  const db = makeD1();
  t.after(() => db.raw.close());
  const kv = atomicKv({ people: JSON.stringify([{ email: editor, name: 'Editor', publisher: false }]), ...initial });
  const github = await makeGithub({ files: { [page]: '{"title":"Before","blocks":[]}\n', 'data/topics.json': '[]\n' } });
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const response = await github.fetch(url, options);
    if (!response) throw new Error('Unexpected outbound request');
    return response;
  });
  const env = {
    ALLOWED_ORIGIN: 'https://site.example', REPO: 'o/r', BRANCH: 'live',
    GITHUB_TOKEN: 'test-github-token', SESSION_SECRET: 'test-session-secret',
    OWNERS: `${await sha256(owner)},${await sha256(otherOwner)}`,
    EDITORS: kv, DATA_STORE: createD1DataStore(db), RATE_LIMIT_STORE: async () => true,
  };
  Object.defineProperty(env, 'DB', { get() { throw new Error('The typed-store runtime must not access D1'); } });
  const tokens = new Map();
  for (const email of [owner, otherOwner, editor]) tokens.set(email, await makeSession(email, env));
  const api = async (email, method, path, body) => {
    const response = await handle(new Request(`https://worker.example${path}`, {
      method, headers: { Origin: env.ALLOWED_ORIGIN, Authorization: `Bearer ${tokens.get(email)}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), env);
    return { status: response.status, body: await response.json() };
  };
  return { env, api, kv };
}

test('the typed store supports saving, staging media and publishing without a D1 binding', async (t) => {
  const w = await world(t);
  assert.equal(getDataStore(w.env), w.env.DATA_STORE);
  const live = await w.api(owner, 'GET', `/gh/contents/${page}`);
  assert.equal(live.status, 200);
  const saved = await w.api(owner, 'PUT', `/gh/contents/${page}`, {
    content: Buffer.from('{"title":"After","blocks":[]}\n').toString('base64'), sha: live.body.sha,
  });
  assert.equal(saved.status, 200);
  assert.equal((await w.api(owner, 'GET', '/changes')).body.changes.length, 1);

  const data = Buffer.from('%PDF-1.7\nexample');
  const upload = await w.api(owner, 'POST', '/media/init', { name: 'example.pdf', size: data.length });
  assert.equal(upload.status, 200);
  const id = upload.body.id;
  assert.equal((await w.api(owner, 'POST', '/media/chunk', { id, n: 0, data: data.toString('base64') })).status, 200);
  const completed = await w.api(owner, 'POST', '/media/done', { id });
  assert.equal(completed.status, 200);
  assert.equal((await w.api(owner, 'GET', `/media/${id}/chunk?n=0`)).body.data, data.toString('base64'));
  const published = await w.api(owner, 'POST', '/publish', { paths: [page, completed.body.item.key] });
  assert.equal(published.status, 200);
  assert.match(published.body.sha, /^[0-9a-f]{40}$/);
  assert.deepEqual((await w.api(owner, 'GET', '/changes')).body.changes, []);
  assert.equal((await w.api(owner, 'GET', '/media')).body.items[0].status, 'published');
  assert.ok((await w.api(owner, 'GET', '/log')).body.log.some((row) => row.action === 'publish-all'));
});

test('a delayed editor name change cannot resurrect a concurrently revoked membership', async (t) => {
  const w = await world(t), gate = w.kv.delayNext('people');
  t.after(gate.release);
  const saving = w.api(editor, 'PUT', '/me', { name: 'New name' });
  await gate.entered;
  const removed = await w.api(owner, 'DELETE', '/editors', { email: editor });
  assert.equal(removed.status, 200);
  gate.release();
  assert.equal((await saving).status, 401);
  assert.deepEqual(JSON.parse(w.kv.values.get('people')), []);
  assert.equal((await w.api(editor, 'GET', '/me')).status, 401);
});

test('concurrent owner edits preserve separate editor records and owner display names', async (t) => {
  const w = await world(t);
  const edits = await Promise.all([
    w.api(owner, 'PUT', '/editors', { email: 'first@example.test', name: 'First', publisher: true }),
    w.api(otherOwner, 'PUT', '/editors', { email: 'second@example.test', name: 'Second', publisher: false }),
  ]);
  assert.ok(edits.every((result) => result.status === 200));
  assert.deepEqual(JSON.parse(w.kv.values.get('people')).map((person) => person.email).sort(), [editor, 'first@example.test', 'second@example.test'].sort());
  const names = await Promise.all([
    w.api(owner, 'PUT', '/me', { name: 'Owner One' }),
    w.api(otherOwner, 'PUT', '/me', { name: 'Owner Two' }),
  ]);
  assert.ok(names.every((result) => result.status === 200));
  assert.deepEqual(JSON.parse(w.kv.values.get('owner-names')), {
    [await sha256(owner)]: 'Owner One', [await sha256(otherOwner)]: 'Owner Two',
  });
});

test('legacy membership is promoted without losing the concurrent first modern update', async (t) => {
  const w = await world(t, { editors: JSON.stringify([editor]) });
  w.kv.values.delete('people');
  const gate = w.kv.delayNext('people');
  t.after(gate.release);
  const name = w.api(editor, 'PUT', '/me', { name: 'Editor name' });
  await gate.entered;
  assert.equal((await w.api(owner, 'PUT', '/editors', { email: 'new@example.test', name: 'New' })).status, 200);
  gate.release();
  assert.equal((await name).status, 200);
  const people = JSON.parse(w.kv.values.get('people'));
  assert.equal(people.length, 2);
  assert.equal(people.find((person) => person.email === editor).name, 'Editor name');
  assert.equal(people.find((person) => person.email === 'new@example.test').name, 'New');
});
