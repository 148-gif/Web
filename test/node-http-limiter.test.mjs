import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { createCmsServer } from '../server/http.mjs';
import { makeSession } from '../cms-worker/worker.mjs';
import { makeD1 } from './helpers/d1.mjs';

async function world(t) {
  t.mock.method(Date, 'now', () => 1800000000000);
  const db = makeD1(), origin = 'https://editor.example.test';
  const env = {
    DB: db, SESSION_SECRET: 'fixture-signing-secret', GITHUB_TOKEN: 'fixture-github-token', GOOGLE_CLIENT_ID: 'fixture-client', ALLOWED_ORIGIN: origin,
    RATE_LOGIN_PER_CLIENT: 1, RATE_LOGIN_PER_MINUTE: 2, RATE_WRITE_PER_MINUTE: 1,
    EDITORS: { get: async (key) => key === 'people' ? JSON.stringify([{ email: 'editor@example.test', name: 'Editor', publisher: false }]) : null },
  };
  let googleCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(new URL(url).origin, 'https://oauth2.googleapis.com'); googleCalls++;
    return Response.json({ aud: env.GOOGLE_CLIENT_ID, email: 'editor@example.test', email_verified: true, expires_in: 60 });
  });
  const server = createCmsServer({ env, publicOrigin: 'https://api.example.test' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); db.raw.close(); });
  const send = (path, headers, data) => new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: server.address().port, path, method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers } }, (res) => {
      let body = ''; res.setEncoding('utf8'); res.on('data', (chunk) => { body += chunk; }); res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, json: JSON.parse(body) }));
    });
    req.on('error', reject); req.end(JSON.stringify(data));
  });
  return { send, env, origin, db, get googleCalls() { return googleCalls; } };
}

test('Node login limits use socket identity despite changing forwarded headers', async (t) => {
  const w = await world(t);
  const first = await w.send('/session', { 'CF-Connecting-IP': '192.0.2.1', 'X-Forwarded-For': '192.0.2.1' }, { access_token: 'fixture' });
  assert.equal(first.status, 200);
  const second = await w.send('/session', { 'CF-Connecting-IP': '192.0.2.2', 'X-Forwarded-For': '192.0.2.2' }, { access_token: 'fixture' });
  assert.equal(second.status, 429); assert.equal(w.googleCalls, 1);
  assert.equal(second.headers['access-control-allow-origin'], w.origin);
  assert.equal(second.headers['cache-control'], 'no-store');
  assert.ok(Number(second.headers['retry-after']) >= 1 && Number(second.headers['retry-after']) <= 60);
  const row = w.db.raw.prepare("SELECT n, clients FROM request_limits WHERE scope = 'login'").get();
  assert.equal(row.n, 1); assert.equal(Object.keys(JSON.parse(row.clients)).length, 1);
});

test('Node authenticated requests return 429 before performing the second mutation', async (t) => {
  const w = await world(t), token = await makeSession('editor@example.test', w.env);
  const headers = { Authorization: `Bearer ${token}` };
  assert.equal((await w.send('/translate', headers, { text: 'ברסלב' })).status, 200);
  const second = await w.send('/translate', headers, { text: 'אומן' });
  assert.equal(second.status, 429); assert.equal(w.googleCalls, 0);
  assert.equal(w.db.raw.prepare('SELECT COUNT(*) AS n FROM ai_usage').get().n, 0);
});
