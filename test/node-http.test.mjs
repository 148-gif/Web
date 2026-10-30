import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { createConnection } from 'node:net';
import { once } from 'node:events';
import { createCmsServer } from '../server/http.mjs';
import { readJsonBody, RequestBodyError } from '../cms-worker/request-guards.mjs';

const ORIGIN = 'https://editor.example';
const PUBLIC = 'https://api.example';
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

async function world(t, handleRequest, extra = {}) {
  const env = { ALLOWED_ORIGIN: ORIGIN, ...extra };
  const server = createCmsServer({ env, publicOrigin: PUBLIC, ...(handleRequest ? { handleRequest } : {}) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const port = server.address().port;
  const send = ({ method = 'GET', path = '/', headers = {}, chunks = [] } = {}) => new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port, method, path, headers }, (res) => {
      const bytes = [];
      res.on('data', (chunk) => bytes.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(bytes) }));
    });
    req.on('error', reject);
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });
  return { server, env, port, send };
}

test('the Node bridge requires explicit configuration and does not listen on import or construction', () => {
  assert.throws(() => createCmsServer(), /environment/);
  for (const publicOrigin of [undefined, '', 'file:///tmp', 'https://user:pass@api.example', 'https://api.example/cms', 'https://api.example/?q=1', 'https://api.example/#fragment']) {
    assert.throws(() => createCmsServer({ env: {}, publicOrigin }), /publicOrigin/);
  }
  const server = createCmsServer({ env: {}, publicOrigin: PUBLIC });
  assert.equal(server.listening, false);
  assert.equal(server.headersTimeout, 15000);
  assert.equal(server.requestTimeout, 300000);
  assert.equal(server.keepAliveTimeout, 5000);
  assert.equal(server.timeout, 120000);
  assert.equal(server.maxHeadersCount, 64);
});

test('the configured API origin and socket address cannot be replaced by caller headers', async (t) => {
  const identities = [];
  const w = await world(t, async (req, env) => {
    identities.push({ req, env });
    return Response.json({ url: req.url, headers: Object.fromEntries(req.headers), body: await req.text(), address: env.CLIENT_IP(req), other: env.CLIENT_IP(new Request(req.url)) });
  });
  const res = await w.send({ method: 'POST', path: '/gh/contents/data/test.json?ref=test', headers: {
    Host: 'attacker.example', Origin: ORIGIN, 'CF-Connecting-IP': '203.0.113.1', 'True-Client-IP': '203.0.113.2',
    'X-Real-IP': '203.0.113.3', 'X-Forwarded-For': '203.0.113.4', 'X-Forwarded-Host': 'spoof.example',
    'X-Forwarded-Proto': 'http', Forwarded: 'for=203.0.113.5;host=spoof.example', Authorization: 'Bearer local-test',
  }, chunks: ['{"title":"', 'שלום', '"}'] });
  assert.equal(res.status, 200);
  const json = JSON.parse(res.body);
  assert.equal(json.url, `${PUBLIC}/gh/contents/data/test.json?ref=test`);
  assert.equal(json.headers.host, 'api.example');
  assert.equal(json.headers.origin, ORIGIN);
  assert.equal(json.headers.authorization, 'Bearer local-test');
  assert.equal(json.body, '{"title":"שלום"}');
  assert.equal(json.address, '127.0.0.1');
  assert.equal(json.other, null);
  for (const name of ['cf-connecting-ip', 'true-client-ip', 'x-real-ip', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded', 'transfer-encoding']) assert.equal(json.headers[name], undefined);
  assert.equal(Object.hasOwn(w.env, 'CLIENT_IP'), false, 'request identity must not mutate a shared environment');
  await w.send();
  assert.notEqual(identities[0].env, identities[1].env);
  assert.equal(identities[0].env.CLIENT_IP(identities[1].req), null);
});

test('absolute-form, authority-like and backslash request targets never reach the handler', async (t) => {
  let calls = 0;
  const w = await world(t, () => { calls++; return Response.json({ ok: true }); });
  for (const path of ['https://attacker.example/me', '//attacker.example/me', '/\\attacker.example/me', '/me#fragment']) {
    const res = await w.send({ path });
    assert.equal(res.status, 400, path);
  }
  assert.equal((await w.send({ method: 'TRACE' })).status, 405);
  assert.equal((await w.send({ method: 'GET', headers: { 'Content-Length': '1' }, chunks: ['x'] })).status, 400);
  assert.equal(calls, 0);
});

test('the real worker CORS and private response boundary remain intact', async (t) => {
  const w = await world(t);
  const missing = await w.send({ path: '/me' });
  assert.equal(missing.status, 403);
  assert.equal(missing.headers['access-control-allow-origin'], undefined);
  const foreign = await w.send({ path: '/me', headers: { Origin: 'https://attacker.example' } });
  assert.equal(foreign.status, 403);
  assert.equal(foreign.headers['access-control-allow-origin'], undefined);
  const unauthenticated = await w.send({ path: '/me', headers: { Origin: ORIGIN } });
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.headers['access-control-allow-origin'], ORIGIN);
  assert.equal(unauthenticated.headers['cache-control'], 'no-store');
  assert.equal(unauthenticated.headers['x-content-type-options'], 'nosniff');
  const preflight = await w.send({ method: 'OPTIONS', path: '/media/r2', headers: { Origin: ORIGIN } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], ORIGIN);
  assert.match(preflight.headers['access-control-allow-methods'], /PUT/);
});

test('bounded chunked requests can return 413 without their cancellation destroying the response socket', async (t) => {
  const w = await world(t, async (req) => {
    try { return Response.json(await readJsonBody(req, { maxBytes: 32 })); }
    catch (error) { if (error instanceof RequestBodyError) return Response.json({ message: error.message }, { status: error.status }); throw error; }
  });
  const valid = await w.send({ method: 'POST', chunks: ['{"word":"', 'שלום', '"}'] });
  assert.equal(valid.status, 200);
  assert.equal(JSON.parse(valid.body).word, 'שלום');
  const tooLarge = await w.send({ method: 'POST', chunks: ['{"value":"', 'x'.repeat(65536), '"}'] });
  assert.equal(tooLarge.status, 413);
  assert.equal(tooLarge.headers.connection, 'close');
  assert.match(JSON.parse(tooLarge.body).message, /גדולה מדי/);
});

test('the real session endpoint rejects a large streamed body without an identity-provider call', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('No external requests are allowed'); });
  const w = await world(t);
  const res = await w.send({ method: 'POST', path: '/session', headers: { Origin: ORIGIN }, chunks: ['{"padding":"', 'x'.repeat(32768), '"}'] });
  assert.equal(res.status, 413);
  assert.equal(res.headers['access-control-allow-origin'], ORIGIN);
  assert.equal(res.headers['cache-control'], 'no-store');
});

test('an aborted upload aborts the Fetch request and rejects its body reader', { timeout: 5000 }, async (t) => {
  const started = deferred(), finished = deferred();
  const w = await world(t, async (req) => {
    started.resolve(req);
    try { await req.arrayBuffer(); }
    catch { finished.resolve({ aborted: req.signal.aborted }); }
    return new Response(null, { status: 204 });
  });
  const socket = createConnection({ host: '127.0.0.1', port: w.port });
  await once(socket, 'connect');
  socket.write('PUT /media/r2 HTTP/1.1\r\nHost: api.example\r\nContent-Length: 100000\r\n\r\nfirst bytes');
  const request = await started.promise;
  socket.destroy();
  const result = await finished.promise;
  assert.equal(request.signal.aborted, true);
  assert.equal(result.aborted, true);
});

test('response streaming preserves bytes and HEAD cancels its unused response body', async (t) => {
  let cancelled = false;
  const w = await world(t, (req) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('שלום'));
      if (req.method !== 'HEAD') { controller.enqueue(new TextEncoder().encode(' עולם')); controller.close(); }
    },
    cancel() { cancelled = true; },
  }), { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Example': 'kept', 'Set-Cookie': 'test=value; HttpOnly', Connection: 'X-Internal-Hop', 'X-Internal-Hop': 'not forwarded' } }));
  const get = await w.send();
  assert.equal(get.body.toString(), 'שלום עולם');
  assert.equal(get.headers['x-example'], 'kept');
  assert.equal(get.headers['x-internal-hop'], undefined);
  assert.deepEqual(get.headers['set-cookie'], ['test=value; HttpOnly']);
  const head = await w.send({ method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal(cancelled, true);
});

test('disconnecting a streaming response cancels its source instead of reading it all', { timeout: 5000 }, async (t) => {
  const cancelled = deferred();
  let pulls = 0, signal;
  const w = await world(t, (req) => {
    signal = req.signal;
    return new Response(new ReadableStream({
      pull(controller) { pulls++; controller.enqueue(new Uint8Array(65536)); },
      cancel() { cancelled.resolve(); },
    }, { highWaterMark: 0 }));
  });
  await new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: w.port, path: '/' }, (res) => {
      res.once('data', () => { res.destroy(); resolve(); });
      res.on('error', () => {});
    });
    req.on('error', reject); req.end();
  });
  await cancelled.promise;
  assert.equal(signal.aborted, true);
  assert.ok(pulls < 256, `backpressure should bound queued bytes, saw ${pulls} chunks`);
});

test('handler exceptions and invalid results produce masked private errors', async (t) => {
  let invalid = false;
  const w = await world(t, () => { if (invalid) return { secret: 'not a Response' }; throw new Error('private-secret-123'); });
  for (const value of [false, true]) {
    invalid = value;
    const res = await w.send({ headers: { Origin: ORIGIN } });
    assert.equal(res.status, 500);
    assert.deepEqual(JSON.parse(res.body), { message: 'שגיאה בשרת העריכה' });
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['access-control-allow-origin'], ORIGIN);
    assert.doesNotMatch(res.body.toString(), /secret|stack|Response/);
  }
});

test('an unconfigured allowed origin does not break generic server errors or grant CORS', async (t) => {
  const w = await world(t, () => { throw new Error('private configuration failure'); }, { ALLOWED_ORIGIN: undefined });
  const res = await w.send();
  assert.equal(res.status, 500);
  assert.equal(res.headers['access-control-allow-origin'], undefined);
  assert.deepEqual(JSON.parse(res.body), { message: 'שגיאה בשרת העריכה' });
});

test('an upstream response stream failure closes the connection without leaking a second error body', { timeout: 5000 }, async (t) => {
  const w = await world(t, () => {
    let sent = false;
    return new Response(new ReadableStream({
      pull(controller) {
        if (!sent) { sent = true; controller.enqueue(new TextEncoder().encode('safe prefix')); }
        else controller.error(new Error('private storage failure'));
      },
    }, { highWaterMark: 0 }));
  });
  const received = await new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: w.port, path: '/' }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('aborted', () => resolve(Buffer.concat(chunks).toString()));
      res.on('error', () => {});
      res.on('end', () => reject(new Error('The incomplete stream must not finish successfully')));
    });
    // The server may close before the first response bytes reach the socket.
    req.on('error', (error) => error.code === 'ECONNRESET' ? resolve('') : reject(error));
    req.end();
  });
  assert.doesNotMatch(received, /private|storage|stack|שגיאה/);
  assert.ok(received === '' || received === 'safe prefix');
});

test('HEAD does not wait forever for a response source cancellation hook', { timeout: 5000 }, async (t) => {
  let cancelled = false;
  const w = await world(t, () => new Response(new ReadableStream({
    cancel() { cancelled = true; return new Promise(() => {}); },
  }, { highWaterMark: 0 })));
  const res = await w.send({ method: 'HEAD' });
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 0);
  assert.equal(cancelled, true);
});
