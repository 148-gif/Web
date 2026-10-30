import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, readlink, rm, chmod, stat, symlink, writeFile, open, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { constants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createFileMedia } from '../server/file-media.mjs';
import { handle, makeSession } from '../cms-worker/worker.mjs';
import { makeD1 } from './helpers/d1.mjs';

const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const bytes = (text) => new TextEncoder().encode(text);
const stream = (...chunks) => new ReadableStream({
  pull(controller) { if (chunks.length) controller.enqueue(chunks.shift()); else controller.close(); },
}, { highWaterMark: 0 });
const textOf = async (object) => new TextDecoder().decode(await object.arrayBuffer());

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'cms-media-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'private');
  return { directory, root, media: createFileMedia({ root, ...options }) };
}

test('metadata and streamed bytes survive adapter restart with private permissions', async (t) => {
  const { root, media } = await fixture(t);
  const metadata = { contentType: 'text/plain; charset=utf-8', cacheControl: 'public, max-age=60' };
  const body = bytes('שלום עולם!');
  const written = await media.put('a-file.txt', stream(body.subarray(0, 5), body.subarray(5)), { httpMetadata: metadata });
  assert.equal(written.size, body.length);
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  assert.equal((await stat(join(root, 'a-file.txt.media'))).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(root), ['a-file.txt.media']);
  const restarted = createFileMedia({ root });
  assert.deepEqual(await restarted.head('a-file.txt'), { key: 'a-file.txt', size: body.length, httpMetadata: metadata });
  assert.equal(await textOf(await restarted.get('a-file.txt')), 'שלום עולם!');
  await restarted.delete('a-file.txt');
  await restarted.delete('a-file.txt');
  assert.equal(await restarted.head('a-file.txt'), null);
  assert.equal(await restarted.get('a-file.txt'), null);
});

test('range reads expose only the requested bytes and can be cancelled', async (t) => {
  const { media } = await fixture(t);
  await media.put('bytes.bin', stream(bytes('0123456789')));
  const middle = await media.get('bytes.bin', { range: { offset: 3, length: 4 } });
  assert.equal(middle.size, 10);
  assert.deepEqual(middle.range, { offset: 3, length: 4 });
  assert.equal(await textOf(middle), '3456');
  assert.equal(await textOf(await media.get('bytes.bin', { range: { offset: 8, length: 99 } })), '89');
  assert.equal(await textOf(await media.get('bytes.bin', { range: { offset: 10, length: 4 } })), '');
  assert.equal(await textOf(await media.get('bytes.bin', { range: { offset: 2, length: 0 } })), '');
  const cancelled = await media.get('bytes.bin');
  await cancelled.body.cancel();
  for (const range of [null, {}, { offset: -1 }, { offset: 0.1 }, { offset: 11 }, { offset: 1, length: -1 }]) {
    await assert.rejects(media.get('bytes.bin', { range }), /Invalid media range/);
  }
  await media.delete('bytes.bin');
});

test('empty objects remain readable and the cap applies to payload bytes only', async (t) => {
  const { media } = await fixture(t, { maxBytes: 3 });
  await media.put('empty.txt', stream());
  assert.equal((await media.head('empty.txt')).size, 0);
  assert.equal(await textOf(await media.get('empty.txt')), '');
  await media.put('exact.txt', stream(bytes('a'), bytes('bc')));
  assert.equal(await textOf(await media.get('exact.txt')), 'abc');
});

test('oversized streams cancel promptly and never promote temporary bytes', { timeout: 3000 }, async (t) => {
  const { root, media } = await fixture(t, { maxBytes: 4 });
  let cancelled = false, pulls = 0;
  const body = new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(bytes('abc')); },
    cancel() { cancelled = true; return new Promise(() => {}); },
  }, { highWaterMark: 0 });
  await assert.rejects(media.put('oversize.bin', body), (error) => error.status === 413);
  assert.equal(cancelled, true);
  assert.equal(pulls, 2);
  assert.equal(await media.head('oversize.bin'), null);
  assert.deepEqual(await readdir(root), []);
});

test('a failed replacement leaves the previous bytes and metadata intact', async (t) => {
  const { root, media } = await fixture(t);
  await media.put('saved.txt', stream(bytes('original')), { httpMetadata: { contentType: 'text/plain' } });
  let pulls = 0;
  const failed = new ReadableStream({
    pull(controller) { if (!pulls++) controller.enqueue(bytes('partial')); else throw new Error('client disconnected'); },
  }, { highWaterMark: 0 });
  await assert.rejects(media.put('saved.txt', failed, { httpMetadata: { contentType: 'application/octet-stream' } }), /client disconnected/);
  assert.equal(await textOf(await media.get('saved.txt')), 'original');
  assert.equal((await media.head('saved.txt')).httpMetadata.contentType, 'text/plain');
  assert.deepEqual(await readdir(root), ['saved.txt.media']);
});

test('partial writes are invisible and opened reads keep one complete generation', async (t) => {
  const { media } = await fixture(t);
  await media.put('same.txt', stream(bytes('old data')), { httpMetadata: { contentType: 'text/plain' } });
  const old = await media.get('same.txt'), started = deferred(), finish = deferred();
  let step = 0;
  const updating = media.put('same.txt', new ReadableStream({
    async pull(controller) {
      if (!step++) { controller.enqueue(bytes('new ')); started.resolve(); }
      else { await finish.promise; controller.enqueue(bytes('data')); controller.close(); }
    },
  }, { highWaterMark: 0 }), { httpMetadata: { contentType: 'application/octet-stream' } });
  await started.promise;
  assert.equal(await textOf(await media.get('same.txt')), 'old data');
  finish.resolve(); await updating;
  assert.equal(await textOf(old), 'old data');
  assert.equal(await textOf(await media.get('same.txt')), 'new data');
  assert.equal((await media.head('same.txt')).httpMetadata.contentType, 'application/octet-stream');
});

test('same-key writers and deletion serialize across adapter instances in one process', async (t) => {
  const { root, media } = await fixture(t);
  const other = createFileMedia({ root }), started = deferred(), release = deferred();
  let pulled = false, secondRead = false, deleted = false;
  const first = media.put('queued.txt', new ReadableStream({
    async pull(controller) {
      if (pulled) return;
      pulled = true; started.resolve(); await release.promise;
      controller.enqueue(bytes('first')); controller.close();
    },
  }, { highWaterMark: 0 }));
  await started.promise;
  const second = other.put('queued.txt', new ReadableStream({
    pull(controller) { secondRead = true; controller.enqueue(bytes('second')); controller.close(); },
  }, { highWaterMark: 0 }));
  const removal = media.delete('queued.txt').then(() => { deleted = true; });
  await Promise.resolve();
  assert.equal(secondRead, false); assert.equal(deleted, false);
  release.resolve();
  await Promise.all([first, second, removal]);
  assert.equal(secondRead, true); assert.equal(deleted, true);
  assert.equal(await media.head('queued.txt'), null);
});

test('delete never invalidates an already-open streamed response', async (t) => {
  const { media } = await fixture(t);
  const original = Buffer.alloc(100000, 7);
  await media.put('old.bin', stream(original));
  const opened = await media.get('old.bin');
  await media.delete('old.bin');
  assert.equal(await media.head('old.bin'), null);
  assert.deepEqual(Buffer.from(await opened.arrayBuffer()), original);
});

test('an unconsumed large response keeps bounded reads and cancellation closes its descriptor', { skip: process.platform !== 'linux', timeout: 3000 }, async (t) => {
  const { root, media } = await fixture(t);
  await media.put('large.bin', stream(Buffer.alloc(1024 * 1024, 7)));
  const descriptors = async () => {
    const links = await Promise.all((await readdir('/proc/self/fd')).map((name) => readlink(`/proc/self/fd/${name}`).catch(() => '')));
    return links.filter((path) => path.startsWith(`${root}/`) && path.includes('.media'));
  };
  assert.equal((await descriptors()).length, 0);
  const object = await media.get('large.bin');
  // If toWeb used an item-count queue instead of a byte budget, it could read
  // this whole file and close its descriptor even without a response consumer.
  await delay(20);
  assert.equal((await descriptors()).length, 1);
  await object.body.cancel();
  for (let n = 0; n < 100 && (await descriptors()).length; n++) await delay(5);
  assert.equal((await descriptors()).length, 0);
});

test('invalid keys are rejected before any filesystem access', async (t) => {
  const { root, media } = await fixture(t);
  for (const key of ['../secret', '/abs', '.upload-anything', 'A.txt', 'a/b', 'a\\b', 'x\0.txt', '', 'a'.repeat(102), null]) {
    await assert.rejects(media.put(key, stream(bytes('x'))), /Invalid media key/);
    await assert.rejects(media.head(key), /Invalid media key/);
    await assert.rejects(media.get(key), /Invalid media key/);
    await assert.rejects(media.delete(key), /Invalid media key/);
  }
  await assert.rejects(stat(root), { code: 'ENOENT' });
});

test('symlink roots, ancestors and object targets cannot escape private storage', async (t) => {
  const { directory, root, media } = await fixture(t);
  const outside = join(directory, 'outside'); await mkdir(outside, { mode: 0o700 });
  await symlink(outside, root);
  await assert.rejects(media.put('escape.txt', stream(bytes('x'))), /real directories/);
  assert.deepEqual(await readdir(outside), []);
  await rm(root); await mkdir(root, { mode: 0o700 });
  const target = join(outside, 'keep.txt'); await writeFile(target, 'untouched', { mode: 0o600 });
  await symlink(target, join(root, 'escape.txt.media'));
  await assert.rejects(media.put('escape.txt', stream(bytes('x'))), /Unsafe media container/);
  await assert.rejects(media.head('escape.txt'));
  await assert.rejects(media.get('escape.txt'));
  await assert.rejects(media.delete('escape.txt'), /Unsafe media container/);
  assert.equal(await readFile(target, 'utf8'), 'untouched');
  const parent = join(directory, 'linked-parent'); await symlink(outside, parent);
  await assert.rejects(createFileMedia({ root: join(parent, 'private') }).put('escape.txt', stream(bytes('x'))), /real directories/);
  assert.deepEqual(await readdir(outside), ['keep.txt']);
});

test('nonprivate directories, hardlinks and unsafe metadata are refused', async (t) => {
  const { root, media } = await fixture(t);
  await mkdir(root, { mode: 0o700 }); await chmod(root, 0o755);
  await assert.rejects(media.head('safe.txt'), /private/);
  await chmod(root, 0o700);
  await media.put('safe.txt', stream(bytes('safe')));
  await link(join(root, 'safe.txt.media'), join(root, 'linked.txt.media'));
  await assert.rejects(media.head('safe.txt'), /Unsafe media container/);
  await assert.rejects(media.delete('linked.txt'), /Unsafe media container/);
  for (const httpMetadata of [{ contentType: 'text/plain\r\nX: test' }, { cacheControl: 'x'.repeat(1025) }, { contentType: 42 }, []]) {
    await assert.rejects(media.put('metadata.txt', stream(bytes('x')), { httpMetadata }), /Invalid media metadata/);
  }
  await assert.rejects(media.put('wrong.txt', stream('not bytes')), (error) => error.status === 400);
  assert.equal(await media.head('wrong.txt'), null);
});

test('corrupted FIFO targets are rejected without waiting for a writer', { skip: process.platform !== 'linux', timeout: 3000 }, async (t) => {
  const { root, media } = await fixture(t);
  await mkdir(root, { mode: 0o700 });
  const fifo = join(root, 'pipe.bin.media');
  const made = spawnSync('mkfifo', ['-m', '600', fifo], { encoding: 'utf8' });
  if (made.error?.code === 'ENOENT') { t.skip('mkfifo is unavailable'); return; }
  assert.equal(made.status, 0, made.stderr || made.error?.message);
  for (const read of [() => media.head('pipe.bin'), () => media.get('pipe.bin')]) {
    const settled = read().then(() => ({ state: 'resolved' }), (error) => ({ state: 'rejected', error }));
    const result = await Promise.race([settled, delay(150).then(() => ({ state: 'waiting' }))]);
    if (result.state === 'waiting') {
      // Release an older blocking implementation so a failed regression does
      // not leave a libuv worker hung after the test reports its failure.
      const writer = await open(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
      await writer.close(); await settled;
    }
    assert.equal(result.state, 'rejected', 'reading a special file must reject promptly');
    assert.match(result.error.message, /Unsafe media container/);
  }
  await assert.rejects(media.delete('pipe.bin'), /Unsafe media container/);
});

test('corrupt and crash-leftover files are never returned as completed objects', async (t) => {
  const { root, media } = await fixture(t);
  await media.put('broken.bin', stream(bytes('content')));
  const f = await open(join(root, 'broken.bin.media'), 'r+');
  await f.write(Buffer.from('BROKEN!!'), 0, 8, 0); await f.close();
  await assert.rejects(media.head('broken.bin'), /Invalid media container/);
  await writeFile(join(root, '.upload-abandoned'), 'partial', { mode: 0o600 });
  await assert.rejects(media.head('.upload-abandoned'), /Invalid media key/);
  await assert.rejects(media.get('.upload-abandoned'), /Invalid media key/);
  assert.equal(await media.head('absent.txt'), null);
  assert.equal(await readFile(join(root, '.upload-abandoned'), 'utf8'), 'partial');
});

test('configuration requires an absolute dedicated root and a bounded byte budget', () => {
  for (const root of [undefined, '', 'relative', '/']) assert.throws(() => createFileMedia({ root }), /absolute private media root/);
  for (const maxBytes of [-1, 0, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => createFileMedia({ root: '/tmp/private', maxBytes }), /positive safe integer/);
});

test('the real worker can publish, range-serve and delete media through the filesystem adapter', async (t) => {
  const { media } = await fixture(t), db = makeD1();
  t.after(() => db.raw.close());
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected external request'); });
  const env = {
    DB: db, MEDIA: media, SESSION_SECRET: 'local-test-secret', ALLOWED_ORIGIN: 'https://site.example',
    REPO: 'o/r', BRANCH: 'live', EDITORS: { get: async (key) => key === 'people' ? JSON.stringify([{ email: 'editor@example.test', name: 'Editor', publisher: true }]) : null },
  };
  const token = await makeSession('editor@example.test', env);
  const api = (path, method, body) => handle(new Request(`https://api.example${path}`, {
    method, headers: { Origin: env.ALLOWED_ORIGIN, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body,
  }), env);
  const payload = Buffer.alloc(24, 7); payload.write('ftyp', 4);
  const initialized = await api('/media/init', 'POST', JSON.stringify({ name: 'example.mp4', size: payload.length }));
  assert.equal(initialized.status, 200);
  const { id, store } = await initialized.json(); assert.equal(store, 'r2');
  const uploaded = await api(`/media/r2?id=${id}`, 'PUT', payload);
  assert.equal(uploaded.status, 200);
  const { item } = await uploaded.json(); assert.equal(item.status, 'published');
  let getCalls = 0;
  const get = media.get;
  t.mock.method(media, 'get', (...args) => { getCalls++; return get(...args); });
  const range = await handle(new Request(`https://api.example/m/${item.key}`, { headers: { Range: 'bytes=4-7' } }), env);
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('Content-Range'), 'bytes 4-7/24');
  assert.equal(range.headers.get('Content-Type'), 'video/mp4');
  assert.equal(range.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(await range.text(), 'ftyp');
  assert.equal(getCalls, 1);
  const head = await handle(new Request(`https://api.example/m/${item.key}`, { method: 'HEAD' }), env);
  assert.equal(head.status, 200); assert.equal(head.headers.get('Content-Length'), '24');
  assert.equal(await head.text(), '');
  assert.equal(getCalls, 1, 'HEAD must not open a body that will never be consumed');
  assert.equal((await api(`/media/${id}`, 'DELETE')).status, 200);
  assert.equal(await media.head(item.key), null);
});
