import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { handle, makeSession } from '../cms-worker/worker.mjs';
import { makeD1 } from './helpers/d1.mjs';

const mp4 = (size = 24) => { const bytes = Buffer.alloc(size, 7); bytes.write('ftyp', 4); return bytes; };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const sourceOf = (chunks) => {
  const state = { pulls: 0, cancelled: false };
  let index = 0;
  const body = new ReadableStream({
    pull(controller) {
      state.pulls++;
      if (index === chunks.length) controller.close();
      else controller.enqueue(chunks[index++]);
    },
    cancel(reason) { state.cancelled = true; state.reason = reason; },
  }, { highWaterMark: 0 });
  return { body, state };
};

// Pause after a real SQLite read so competing requests use the same stale row.
// The following conditional UPDATE must still decide which request owns it.
function pauseMediaReads(db, count) {
  const prepared = db.prepare, ready = deferred(), release = deferred();
  db.prepare = (sql) => {
    const statement = prepared(sql);
    if (sql !== 'SELECT * FROM media WHERE id = ?') return statement;
    return { ...statement, bind(...args) {
      const bound = statement.bind(...args);
      return { ...bound, async first() {
        const pause = count > 0;
        if (pause) count--;
        const row = await bound.first();
        if (pause) {
          if (!count) ready.resolve();
          await release.promise;
        }
        return row;
      } };
    } };
  };
  return { ready: ready.promise, release: release.resolve };
}

async function world(t, { fixedLength = true } = {}) {
  const db = makeD1();
  t.after(() => db.raw.close());
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('No network requests are expected'); });
  const oldFixed = Object.getOwnPropertyDescriptor(globalThis, 'FixedLengthStream');
  const lengths = new WeakMap();
  class FakeFixedLengthStream {
    constructor(size) {
      let bytes = 0;
      const stream = new TransformStream({
        transform(chunk, controller) {
          bytes += chunk.byteLength;
          assert.ok(bytes <= size);
          controller.enqueue(chunk);
        },
        flush() { assert.equal(bytes, size); },
      });
      this.readable = stream.readable;
      this.writable = stream.writable;
      lengths.set(this.readable, size);
    }
  }
  Object.defineProperty(globalThis, 'FixedLengthStream', { configurable: true, writable: true, value: fixedLength ? FakeFixedLengthStream : undefined });
  t.after(() => {
    if (oldFixed) Object.defineProperty(globalThis, 'FixedLengthStream', oldFixed);
    else delete globalThis.FixedLengthStream;
  });
  const objects = new Map();
  const state = { putCalls: 0, forwarded: 0, deletes: [], failPut: null, failDelete: false, gate: null, started: deferred() };
  const bucket = {
    async put(key, body, options) {
      state.putCalls++;
      state.knownLength = lengths.get(body);
      state.httpMetadata = options.httpMetadata;
      state.started.resolve();
      if (state.gate) await state.gate.promise;
      if (state.failPut === 'before-read') throw new Error('simulated R2 unavailability');
      const reader = body.getReader(), chunks = [];
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          state.forwarded += value.byteLength;
          chunks.push(Buffer.from(value));
          if (state.afterChunkGate) await state.afterChunkGate.promise;
          if (state.failPut === 'after-chunk') throw new Error('simulated R2 write failure');
        }
      } catch (cause) {
        // Storage services may replace the stream error with their own error.
        throw new Error('R2 rejected the stream', { cause });
      } finally { reader.releaseLock(); }
      objects.set(key, Buffer.concat(chunks));
      return {};
    },
    async head(key) { const bytes = objects.get(key); return bytes ? { size: bytes.length } : null; },
    async get(key, { range }) {
      const bytes = objects.get(key);
      return bytes ? { arrayBuffer: async () => Uint8Array.from(bytes.subarray(range.offset, range.offset + range.length)).buffer } : null;
    },
    async delete(key) {
      state.deletes.push(key);
      if (state.failDelete) throw new Error('simulated cleanup failure');
      objects.delete(key);
    },
  };
  const env = {
    ALLOWED_ORIGIN: 'https://site.example', REPO: 'o/r', BRANCH: 'live',
    GITHUB_TOKEN: 'local-github-test', SESSION_SECRET: 'local-signing-test', DB: db, MEDIA: bucket,
    EDITORS: { get: async (key) => key === 'people' ? JSON.stringify([{ email: 'editor@example.test', name: 'Editor', publisher: true }]) : null },
  };
  const token = await makeSession('editor@example.test', env);
  const api = async (path, options = {}) => {
    const response = await worker.fetch(new Request(`https://worker.example${path}`, {
      ...options,
      headers: { Origin: env.ALLOWED_ORIGIN, Authorization: `Bearer ${token}`, ...options.headers },
    }), env);
    return { status: response.status, body: await response.json() };
  };
  const init = async (size = 24) => {
    const response = await api('/media/init', { method: 'POST', body: JSON.stringify({ name: 'movie.mp4', size }) });
    assert.equal(response.status, 200);
    assert.equal(response.body.store, 'r2');
    return response.body.id;
  };
  const upload = (id, body, headers) => api(`/media/r2?id=${id}`, { method: 'PUT', body, duplex: 'half', headers });
  const row = (id) => db.raw.prepare('SELECT * FROM media WHERE id = ?').get(id);
  return { api, init, upload, row, objects, state, db, bucket, env, token };
}

for (const fixedLength of [true, false]) {
  test(`an exact R2 upload publishes with bounded streaming (known length: ${fixedLength})`, { timeout: 2000 }, async (t) => {
    const w = await world(t, { fixedLength }), bytes = mp4(), id = await w.init(bytes.length);
    const source = sourceOf([bytes.subarray(0, 8), bytes.subarray(8)]);
    const response = await w.upload(id, source.body, { 'Content-Length': '1' });
    assert.equal(response.status, 200);
    assert.equal(w.row(id).status, 'published');
    assert.deepEqual(w.objects.get(w.row(id).key), bytes);
    assert.equal(w.state.knownLength, fixedLength ? bytes.length : undefined);
    assert.equal(w.state.httpMetadata.contentType, 'video/mp4');
    assert.equal(w.state.deletes.length, 0);
    assert.equal(source.state.cancelled, false);
  });
}

test('oversize without Content-Length is stopped before its overflowing chunk reaches R2', { timeout: 2000 }, async (t) => {
  const w = await world(t), id = await w.init(24);
  const source = sourceOf([mp4(16), new Uint8Array(16), new Uint8Array(100)]);
  const response = await w.upload(id, source.body);
  assert.equal(response.status, 413, 'the body error survives storage error wrapping');
  assert.equal(w.state.forwarded, 16);
  assert.equal(source.state.pulls, 2);
  assert.equal(source.state.cancelled, true);
  assert.equal(w.state.deletes.length, 1);
  assert.equal(w.row(id).status, 'uploading');
  assert.equal(w.objects.size, 0);
});

test('a short R2 stream returns 400 and only releases its reservation after cleanup', { timeout: 2000 }, async (t) => {
  const w = await world(t), id = await w.init(24);
  const originalDelete = w.bucket.delete;
  w.bucket.delete = async (key) => { assert.equal(w.row(id).status, 'receiving'); await originalDelete(key); };
  const response = await w.upload(id, sourceOf([mp4(16)]).body);
  assert.equal(response.status, 400);
  assert.equal(w.state.deletes.length, 1);
  assert.equal(w.row(id).status, 'uploading');
});

for (const failPut of ['before-read', 'after-chunk']) {
  test(`a storage failure ${failPut} cancels its source without a stalled pipe`, { timeout: 2000 }, async (t) => {
    const w = await world(t), id = await w.init(24);
    w.state.failPut = failPut;
    const source = sourceOf([mp4(8), new Uint8Array(8), new Uint8Array(8)]);
    const response = await w.upload(id, source.body);
    assert.equal(response.status, 500);
    assert.equal(source.state.cancelled, true, JSON.stringify(source.state));
    assert.equal(w.state.deletes.length, 1);
    assert.equal(w.row(id).status, 'uploading');
  });
}

for (const pendingRead of [false, true]) {
  test(`R2 failure after a chunk settles despite stalled source cancellation (pending read: ${pendingRead})`, { timeout: 2000 }, async (t) => {
    const w = await world(t), id = await w.init(24), readingNext = deferred();
    w.state.failPut = 'after-chunk';
    if (pendingRead) w.state.afterChunkGate = readingNext;
    let pulls = 0, cancelled = false;
    const body = new ReadableStream({
      pull(controller) {
        pulls++;
        if (pendingRead && pulls > 1) {
          readingNext.resolve();
          return new Promise(() => {});
        }
        controller.enqueue(pulls === 1 ? mp4(8) : new Uint8Array(8));
      },
      cancel() { cancelled = true; return new Promise(() => {}); },
    }, { highWaterMark: 0 });
    const response = await w.upload(id, body);
    assert.equal(response.status, 500);
    assert.equal(cancelled, true);
    assert.equal(body.locked, false);
    if (pendingRead) assert.equal(pulls, 2, 'the failure occurs while the next read is waiting');
    assert.equal(w.state.forwarded, 8);
    assert.equal(w.state.deletes.length, 1);
    assert.equal(w.row(id).status, 'uploading', 'cleanup releases the exclusive reservation');
  });
}

test('transport failures are server errors and release storage only after cleanup', { timeout: 2000 }, async (t) => {
  const w = await world(t), id = await w.init(24);
  const body = new ReadableStream({ pull(controller) { controller.error(new Error('transport failure')); } });
  const response = await w.upload(id, body);
  assert.equal(response.status, 500);
  assert.equal(w.state.deletes.length, 1);
  assert.equal(w.row(id).status, 'uploading');
});

test('a valid-sized file with the wrong signature is removed before it becomes published', { timeout: 2000 }, async (t) => {
  const w = await world(t), id = await w.init(24);
  const response = await w.upload(id, sourceOf([new Uint8Array(24)]).body);
  assert.equal(response.status, 400);
  assert.equal(w.objects.size, 0);
  assert.equal(w.state.deletes.length, 1);
  assert.equal(w.row(id).status, 'uploading');
});

test('parallel uploads and removal cannot interfere with the active upload reservation', { timeout: 2000 }, async (t) => {
  const w = await world(t), id = await w.init(24), gate = deferred();
  w.state.gate = gate;
  const pending = w.upload(id, sourceOf([mp4()]).body);
  try {
    await w.state.started.promise;
    assert.equal(w.row(id).status, 'receiving');
    assert.equal((await w.upload(id, sourceOf([mp4()]).body)).status, 409);
    assert.equal((await w.api(`/media/${id}`, { method: 'DELETE' })).status, 409);
    const listing = await w.api('/media');
    assert.deepEqual(listing.body.items, []);
    assert.equal(listing.body.quota.r2.used, 24, 'the reserved bytes still count toward quota');
    assert.equal(w.state.putCalls, 1);
    assert.equal(w.state.deletes.length, 0);
  } finally { gate.resolve(); }
  assert.equal((await pending).status, 200);
  assert.equal(w.row(id).status, 'published');
  assert.deepEqual(w.objects.get(w.row(id).key), mp4());
});

test('two uploads that both read the uploading row still have only one atomic winner', { timeout: 2000 }, async (t) => {
  const w = await world(t), id = await w.init(24), pause = pauseMediaReads(w.db, 2);
  const first = w.upload(id, sourceOf([mp4()]).body);
  const second = w.upload(id, sourceOf([mp4()]).body);
  await pause.ready;
  pause.release();
  assert.deepEqual((await Promise.all([first, second])).map((result) => result.status).sort(), [200, 409]);
  assert.equal(w.state.putCalls, 1);
  assert.equal(w.state.deletes.length, 0);
  assert.equal(w.row(id).status, 'published');
});

test('a removal that read an old row cannot delete an upload claimed in the meantime', { timeout: 2000 }, async (t) => {
  const w = await world(t), id = await w.init(24), pause = pauseMediaReads(w.db, 1), gate = deferred();
  const removal = w.api(`/media/${id}`, { method: 'DELETE' });
  await pause.ready;
  w.state.gate = gate;
  const upload = w.upload(id, sourceOf([mp4()]).body);
  try {
    await w.state.started.promise;
    pause.release();
    assert.equal((await removal).status, 409);
    assert.equal(w.state.deletes.length, 0);
    assert.equal(w.row(id).status, 'receiving');
  } finally { pause.release(); gate.resolve(); }
  assert.equal((await upload).status, 200);
  assert.deepEqual(w.objects.get(w.row(id).key), mp4());
});

test('failed cleanup retains the reservation and blocks retries from deleting another upload', { timeout: 2000 }, async (t) => {
  const w = await world(t), id = await w.init(24);
  w.state.failDelete = true;
  assert.equal((await w.upload(id, sourceOf([mp4(16)]).body)).status, 500);
  assert.equal(w.row(id).status, 'receiving');
  assert.equal((await w.upload(id, sourceOf([mp4()]).body)).status, 409);
  assert.equal((await w.api(`/media/${id}`, { method: 'DELETE' })).status, 409);
  assert.equal(w.state.putCalls, 1);
  assert.equal(w.state.deletes.length, 1);
});

test('an upload can be retried after successful cleanup without retaining invalid bytes', { timeout: 2000 }, async (t) => {
  const w = await world(t), id = await w.init(24);
  assert.equal((await w.upload(id, sourceOf([mp4(16)]).body)).status, 400);
  assert.equal((await w.upload(id, sourceOf([mp4()]).body)).status, 200);
  assert.equal(w.row(id).status, 'published');
  assert.deepEqual(w.objects.get(w.row(id).key), mp4());
  assert.equal(w.state.deletes.length, 1);
});

test('removal without an R2 binding preserves both metadata and the stored object', { timeout: 2000 }, async (t) => {
  const w = await world(t), id = await w.init(24);
  assert.equal((await w.upload(id, sourceOf([mp4()]).body)).status, 200);
  const before = w.row(id), stored = w.objects.get(before.key);
  w.env.MEDIA = undefined;
  await assert.rejects(handle(new Request(`https://worker.example/media/${id}`, {
    method: 'DELETE', headers: { Origin: w.env.ALLOWED_ORIGIN, Authorization: `Bearer ${w.token}` },
  }), w.env), (error) => error.status === 503);
  const response = await w.api(`/media/${id}`, { method: 'DELETE' });
  assert.equal(response.status, 500, 'the public boundary keeps infrastructure errors generic');
  assert.deepEqual(w.row(id), before, 'failure must occur before claiming or removing metadata');
  assert.deepEqual(w.objects.get(before.key), stored);
  assert.equal(w.state.deletes.length, 0);
});

test('failed R2 deletion keeps its byte reservation until a successful retry removes the object', { timeout: 2000 }, async (t) => {
  const w = await world(t);
  w.env.MEDIA_R2_TOTAL_GB = 32 / 1024 ** 3;
  const id = await w.init(24);
  assert.equal((await w.upload(id, sourceOf([mp4()]).body)).status, 200);
  const key = w.row(id).key;
  w.state.failDelete = true;
  assert.equal((await w.api(`/media/${id}`, { method: 'DELETE' })).status, 500);
  assert.equal(w.row(id).status, 'removing');
  assert.equal(w.objects.has(key), true);
  const held = await w.api('/media');
  assert.equal(held.body.quota.r2.max, 32);
  assert.equal(held.body.quota.r2.used, 24);
  const extra = await w.api('/media/init', { method: 'POST', body: JSON.stringify({ name: 'other.mp4', size: 24 }) });
  assert.equal(extra.status, 413, 'failed deletion must not free quota for another upload');
  w.state.failDelete = false;
  assert.equal((await w.api(`/media/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal(w.row(id), undefined);
  assert.equal(w.objects.has(key), false);
  assert.equal((await w.api('/media')).body.quota.r2.used, 0);
  assert.ok(await w.init(24));
});
