import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle, makeSession } from '../cms-worker/worker.mjs';
import { makeD1 } from './helpers/d1.mjs';
import { makeGithub } from './helpers/fake-github.mjs';

const MAX_FILE = 2e6;
const SESSION_BYTES = 16384;
const CHUNK_BODY_BYTES = 524288 + 16384;
const email = 'publisher@example.test';

async function world(t) {
  const db = makeD1();
  t.after(() => db.raw.close());
  const github = await makeGithub();
  let googleRequests = 0;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (new URL(url).origin === 'https://oauth2.googleapis.com') {
      googleRequests++;
      return Response.json({ aud: 'test-client', email, email_verified: 'true', expires_in: '3000' });
    }
    const response = await github.fetch(url, options);
    if (!response) throw new Error(`Unexpected network request: ${url}`);
    return response;
  });
  const env = {
    ALLOWED_ORIGIN: 'https://site.example', REPO: 'o/r', BRANCH: 'live', GOOGLE_CLIENT_ID: 'test-client',
    GITHUB_TOKEN: 'test-github-token', SESSION_SECRET: 'test-session-secret', DB: db,
    EDITORS: { get: async (key) => key === 'people' ? JSON.stringify([{ email, name: 'Publisher', publisher: true }]) : null },
  };
  const token = await makeSession(email, env);
  const request = (path, body, method = 'POST') => new Request(`https://worker.example${path}`, {
    method,
    headers: { Origin: env.ALLOWED_ORIGIN, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body,
    ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
  });
  const send = async (req) => {
    const response = await handle(req, env);
    return { status: response.status, body: await response.json() };
  };
  return { db, github, request, send, get googleRequests() { return googleRequests; } };
}

function streamBytes(bytes) {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset === bytes.length) { controller.close(); return; }
      const end = Math.min(offset + 65536, bytes.length);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
  }, { highWaterMark: 0 });
}

test('authenticated mutations reject malformed JSON and non-object envelopes', async (t) => {
  const w = await world(t);
  for (const body of ['{broken', '[]', 'null', '"text"', '42', ' \n ']) {
    const response = await w.send(w.request('/discard', body));
    assert.equal(response.status, 400, `invalid envelope: ${body}`);
  }
  assert.equal(w.db.raw.prepare('SELECT COUNT(*) AS n FROM drafts').get().n, 0);
  assert.equal(w.db.raw.prepare('SELECT COUNT(*) AS n FROM log').get().n, 0);
  assert.equal(w.github.log.length, 0);
  assert.equal(w.googleRequests, 0);
});

test('empty bodies preserve endpoints that intentionally accept an empty object', async (t) => {
  const w = await world(t);
  for (const body of [undefined, '']) {
    const discarded = await w.send(w.request('/discard', body));
    assert.equal(discarded.status, 200);
    assert.deepEqual(discarded.body, { discarded: [] });
    const translated = await w.send(w.request('/translate', body));
    assert.equal(translated.status, 200);
    assert.deepEqual(translated.body, { slug: null });
  }
  assert.equal(w.github.log.length, 0);
  assert.equal(w.googleRequests, 0);
});

test('invalid UTF-8 JSON is a client error in authenticated and login bodies', async (t) => {
  const w = await world(t);
  const bytes = Buffer.concat([Buffer.from('{"note":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')]);
  for (const path of ['/discard', '/session']) {
    const response = await w.send(w.request(path, bytes));
    assert.equal(response.status, 400);
  }
  assert.equal(w.googleRequests, 0);
  assert.equal(w.github.log.length, 0);
});

test('oversized streamed chunk envelopes are rejected before pending storage without Content-Length', async (t) => {
  const w = await world(t);
  const init = await w.send(w.request('/media/init', JSON.stringify({ name: 'small.txt', size: 1 })));
  assert.equal(init.status, 200);
  const id = init.body.id;
  const bytes = Buffer.from(JSON.stringify({ id, n: 0, data: 'A'.repeat(CHUNK_BODY_BYTES) }));
  assert.ok(bytes.length > CHUNK_BODY_BYTES);
  const req = w.request('/media/chunk', streamBytes(bytes));
  assert.equal(req.headers.get('Content-Length'), null);
  const response = await w.send(req);
  assert.equal(response.status, 413);
  assert.equal(w.db.raw.prepare('SELECT COUNT(*) AS n FROM media_chunks WHERE id = ?').get(id).n, 0);
  assert.equal(w.db.raw.prepare('SELECT status FROM media WHERE id = ?').get(id).status, 'uploading');
  assert.equal(w.db.raw.prepare('SELECT COUNT(*) AS n FROM log').get().n, 0);
  assert.equal(w.googleRequests, 0);
});

test('login requires a JSON object and rejects oversized streams before asking Google', async (t) => {
  const w = await world(t);
  for (const body of [undefined, '', '{broken', '[]', 'null']) {
    assert.equal((await w.send(w.request('/session', body))).status, 400);
  }
  const bytes = Buffer.from(JSON.stringify({ access_token: 'test', padding: 'x'.repeat(SESSION_BYTES) }));
  const req = w.request('/session', streamBytes(bytes));
  assert.equal(req.headers.get('Content-Length'), null);
  assert.equal((await w.send(req)).status, 413);
  assert.equal(w.googleRequests, 0);
  assert.equal(w.github.log.length, 0);
  assert.equal(w.db.raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table'").get().n, 0, 'rejected login bodies must not initialize storage');
});

test('a valid login envelope at the 16 KiB boundary still signs in', async (t) => {
  const w = await world(t);
  const envelope = { access_token: 'test', padding: '' };
  envelope.padding = 'x'.repeat(SESSION_BYTES - Buffer.byteLength(JSON.stringify(envelope)));
  const body = JSON.stringify(envelope);
  assert.equal(Buffer.byteLength(body), SESSION_BYTES);
  const response = await w.send(w.request('/session', streamBytes(Buffer.from(body))));
  assert.equal(response.status, 200);
  assert.equal(response.body.email, email);
  assert.equal(typeof response.body.token, 'string');
  assert.equal(w.googleRequests, 1);
});

test('the data-file envelope preserves the existing two-million-code-unit limit for Unicode JSON', async (t) => {
  const w = await world(t), path = 'data/pages/unicode.json';
  const page = { title: 'Unicode page', blocks: [], lead: '' };
  page.lead = '界'.repeat(MAX_FILE - JSON.stringify(page).length);
  const content = JSON.stringify(page);
  assert.equal(content.length, MAX_FILE, 'the existing file limit counts UTF-16 code units');
  const body = JSON.stringify({ content: Buffer.from(content).toString('base64'), sha: null });
  const bytes = Buffer.byteLength(body);
  assert.ok(bytes > 3 * 1048576, 'this valid Unicode envelope exceeds the previous smaller request budget');
  assert.ok(bytes <= MAX_FILE * 4 + 65536);
  const req = w.request(`/gh/contents/${path}`, streamBytes(Buffer.from(body)), 'PUT');
  assert.equal(req.headers.get('Content-Length'), null);
  const response = await w.send(req);
  assert.equal(response.status, 200);
  assert.equal(response.body.draft, true);
  assert.equal(w.db.raw.prepare('SELECT content FROM drafts WHERE path = ?').get(path).content, content);
  assert.equal(w.github.read(path), null, 'saving still only stages a draft');
  assert.ok(w.github.log.every((entry) => entry.startsWith('GET ')));
  assert.equal(w.googleRequests, 0);
});
