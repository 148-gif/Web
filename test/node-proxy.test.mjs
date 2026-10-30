import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { clientAddressResolver } from '../server/proxy-address.mjs';
import { createCmsServer } from '../server/http.mjs';

test('forwarded identities require an explicit trusted peer and stop at the closest untrusted address', () => {
  const socketOnly = clientAddressResolver();
  assert.equal(socketOnly('127.0.0.1', '198.51.100.9'), '127.0.0.1');
  const proxy = clientAddressResolver(['127.0.0.1', '2001:db8::1']);
  assert.equal(proxy('203.0.113.2', '198.51.100.9'), '203.0.113.2');
  assert.equal(proxy('127.0.0.1', '198.51.100.9, 203.0.113.2'), '203.0.113.2');
  assert.equal(proxy('127.0.0.1', '198.51.100.9, 2001:db8::1'), '198.51.100.9');
  assert.equal(proxy('::ffff:127.0.0.1', '198.51.100.9'), '198.51.100.9');
  for (const malformed of ['', 'unknown', '1.2.3.4:80', '198.51.100.9, nope', Array(18).fill('127.0.0.1').join(','), 'a'.repeat(2049)]) assert.equal(proxy('127.0.0.1', malformed), '127.0.0.1');
  for (const setting of ['127.0.0.1', ['0.0.0.0/0'], ['*'], ['localhost'], ['[::1]']]) assert.throws(() => clientAddressResolver(setting), /trustedProxyIps/);
});

test('HTTP proxy identity remains request-scoped and staging headers cover success and bridge errors', async (t) => {
  const server = createCmsServer({
    env: {}, publicOrigin: 'https://api.example', trustedProxyIps: ['127.0.0.1'], noIndex: true,
    handleRequest: (req, env) => {
      if (new URL(req.url).pathname === '/error') throw Error('private error');
      return Response.json({ address: env.CLIENT_IP(req), forwarded: req.headers.get('x-forwarded-for'), other: env.CLIENT_IP(new Request(req.url)) }, { headers: { 'X-Robots-Tag': 'index' } });
    },
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(base, { headers: { 'X-Forwarded-For': '198.51.100.9, 203.0.113.2' } });
  assert.deepEqual(await response.json(), { address: '203.0.113.2', forwarded: null, other: null });
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
  const failed = await fetch(base + '/error');
  assert.equal(failed.status, 500);
  assert.equal(failed.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.doesNotMatch(await failed.text(), /private error/);
});

test('an explicit API base path strips only its own path boundary and preserves query data', async (t) => {
  const server = createCmsServer({ env: {}, publicOrigin: 'https://stage.example', basePath: '/cms-api', noIndex: true,
    handleRequest: (req) => Response.json({ path: new URL(req.url).pathname, query: new URL(req.url).search }) });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual(await (await fetch(base + '/cms-api/me?q=hello')).json(), { path: '/me', query: '?q=hello' });
  assert.deepEqual(await (await fetch(base + '/cms-api?q=hello')).json(), { path: '/', query: '?q=hello' });
  assert.equal((await fetch(base + '/cms-api//other.example/me')).status, 400);
  for (const path of ['/', '/me', '/cms-api-wrong/me']) {
    const res = await fetch(base + path);
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow');
  }
  for (const basePath of ['/cms-api/', '//cms-api', '/a/../cms-api', '/cms-api?x', '/cms.api']) assert.throws(() => createCmsServer({ env: {}, publicOrigin: 'https://stage.example', basePath }), /basePath/);
});
