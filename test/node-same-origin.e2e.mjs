// Real Chromium -> same-origin Node bridge -> real Worker, with local fixtures.
// Run: CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium node test/node-same-origin.e2e.mjs
// NODE_HTTP_BRIDGE_PATH may select an isolated prior bridge for regression proof.
// No build, provider credentials, external network or production database needed.
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { readFileSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { makeSession, sha256 } from '../cms-worker/worker.mjs';
import { runtimeHandler } from '../server/runtime.mjs';
import { makeD1 } from './helpers/d1.mjs';
import { makeGithub } from './helpers/fake-github.mjs';
import { repoFiles } from './helpers/editor-world.mjs';

const bridgeUrl = process.env.NODE_HTTP_BRIDGE_PATH
  ? pathToFileURL(resolve(process.env.NODE_HTTP_BRIDGE_PATH)) : new URL('../server/http.mjs', import.meta.url);
const { createCmsServer } = await import(bridgeUrl.href);
const { chromium } = createRequire(import.meta.url)('playwright');
const site = fileURLToPath(new URL('../site/', import.meta.url)).replace(/\/$/, '');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.woff2': 'font/woff2' };
const email = 'owner@example.test', name = 'עורך בדיקה';
const db = makeD1(), requests = [], pageErrors = [], externalRequests = [];
const github = await makeGithub({ files: repoFiles() });
const realFetch = globalThis.fetch;
let browser, api, origin;

const json = (response, value) => {
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(value));
};
const server = createServer((incoming, outgoing) => {
  const path = new URL(incoming.url, origin).pathname;
  if (path.startsWith('/cms-api/')) {
    // Observe the actual browser headers before the canonical bridge handles them.
    const seen = { method: incoming.method, path, origin: incoming.headers.origin,
      host: incoming.headers.host, site: incoming.headers['sec-fetch-site'],
      mode: incoming.headers['sec-fetch-mode'], dest: incoming.headers['sec-fetch-dest'],
      referer: incoming.headers.referer, rawOrigin: incoming.rawHeaders.some((v, i) => i % 2 === 0 && v.toLowerCase() === 'origin'),
      authenticated: Boolean(incoming.headers.authorization), status: null };
    requests.push(seen);
    outgoing.once('finish', () => { seen.status = outgoing.statusCode; });
    return api(incoming, outgoing);
  }
  if (path === '/admin/config.json') return json(outgoing, { repo: 'o/r', branch: 'live', worker: origin + '/cms-api', googleClientId: 'local-fixture' });
  if (path === '/admin/photos/index.json') return json(outgoing, []);
  const file = resolve(site, '.' + (path === '/admin/' ? '/admin/index.html' : path));
  if (!file.startsWith(site + sep)) { outgoing.writeHead(404); return outgoing.end(); }
  try {
    const bytes = readFileSync(file);
    outgoing.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' });
    outgoing.end(bytes);
  } catch { outgoing.writeHead(404); outgoing.end(); }
});
const foreign = createServer((_incoming, outgoing) => {
  outgoing.writeHead(200, { 'Content-Type': 'text/html' });
  outgoing.end('<!doctype html><meta name="referrer" content="no-referrer"><title>Foreign local fixture</title>');
});
const listen = (server) => new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const close = async (server) => {
  server.closeAllConnections();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
};
const send = ({ method = 'GET', path = '/cms-api/me', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const outgoing = request(new URL(path, origin), { method, headers }, (response) => {
    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }));
    response.on('error', reject);
  });
  outgoing.on('error', reject); outgoing.end(body);
});

try {
  await listen(server); await listen(foreign);
  origin = `http://127.0.0.1:${server.address().port}`;
  const foreignOrigin = `http://localhost:${foreign.address().port}`;
  const owner = await sha256(email), names = new Map([['owner-names', JSON.stringify({ [owner]: name })]]);
  const env = { ALLOWED_ORIGIN: origin, REPO: 'o/r', BRANCH: 'live', OWNERS: owner,
    SESSION_SECRET: 'local-only-browser-session-secret-32-bytes', GITHUB_TOKEN: 'local-only-github-fixture',
    DB: db, EDITORS: { get: async (key) => names.get(key) ?? null, put: async (key, value) => { names.set(key, value); } }, CMS_STAGING: true };
  const bridge = createCmsServer({ env, publicOrigin: origin, basePath: '/cms-api', noIndex: true,
    handleRequest: runtimeHandler({ readOnly: true, publishEnabled: false }) });
  // The local static gateway passes the original IncomingMessage unchanged.
  // It neither adds Origin nor synthesizes Fetch Metadata, unlike routed mocks.
  api = bridge.listeners('request')[0];
  globalThis.fetch = async (url, options = {}) => {
    const response = await github.fetch(url, options);
    if (!response) throw new Error('Unexpected provider request in local browser regression');
    return response;
  };
  const token = await makeSession(email, env);
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium' });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.route('**/*', (route) => {
    const target = new URL(route.request().url());
    if ([origin, foreignOrigin].includes(target.origin)) return route.continue();
    externalRequests.push(target.origin);
    return route.abort('blockedbyclient');
  });
  await context.addInitScript(({ token, email, origin }) => {
    if (location.origin === origin) localStorage.setItem('cms-token', JSON.stringify({ token, email, owner: true }));
  }, { token, email, origin });
  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const firstMe = page.waitForResponse((response) => response.url() === origin + '/cms-api/me' && response.request().method() === 'GET');
  await page.goto(origin + '/admin/');
  assert.equal((await firstMe).status(), 200, 'real Chromium same-origin authenticated GET /me must succeed without an Origin header');
  await page.waitForSelector('#app:not([hidden])');
  assert.equal(await page.locator('#who').textContent(), name);
  assert.equal(await page.locator('meta[name=referrer]').getAttribute('content'), 'no-referrer');
  await page.evaluate(() => { location.hash = '#/file/uman.json'; });
  await page.waitForSelector('#main input[type=text]');
  const expectedTitle = JSON.parse(github.read('data/uman.json')).title;
  assert.equal(await page.getByLabel('כותרת', { exact: true }).first().inputValue(), expectedTitle);
  for (const path of ['/cms-api/me', '/cms-api/gh', '/cms-api/gh/contents/data/uman.json']) {
    const seen = requests.find((item) => item.path === path && item.method === 'GET' && item.status === 200);
    assert.ok(seen, `the actual editor must load ${path} through Node and the Worker`);
    assert.equal(seen.authenticated, true);
    assert.equal(seen.rawOrigin, false); assert.equal(seen.origin, undefined);
    assert.equal(seen.referer, undefined, 'meta no-referrer must remain effective');
    assert.equal(seen.host, new URL(origin).host);
    assert.equal(seen.site, 'same-origin'); assert.equal(seen.mode, 'cors'); assert.equal(seen.dest, 'empty');
  }
  console.log('PASS saved editor session opens and loads Git content through real same-origin browser GETs with no Origin or Referer');

  const responses = await page.evaluate(async ({ token }) => {
    const ask = async (path, options = {}) => {
      const response = await fetch('/cms-api' + path, options);
      return { status: response.status, text: await response.text(), noindex: response.headers.get('x-robots-tag') };
    };
    const authorization = { Authorization: 'Bearer ' + token };
    return {
      invalidLogin: await ask('/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
      anonymous: await ask('/me'),
      sameOriginMode: await ask('/me', { mode: 'same-origin', headers: authorization }),
      head: await ask('/me', { method: 'HEAD', headers: authorization }),
      rename: await ask('/me', { method: 'PUT', headers: { ...authorization, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'must not change' }) }),
      publish: await ask('/publish', { method: 'POST', headers: { ...authorization, 'Content-Type': 'application/json' }, body: '{}' }),
    };
  }, { token });
  assert.equal(responses.invalidLogin.status, 401, 'a browser login POST must reach credential validation, not fail Origin validation');
  const login = requests.find((item) => item.path === '/cms-api/session' && item.method === 'POST' && item.status === 401);
  assert.ok(login, 'the real browser login request must reach the Worker');
  assert.equal(login.rawOrigin, true); assert.equal(login.origin, origin);
  assert.equal(login.referer, undefined, 'no-referrer must not remove the Origin on a login POST');
  assert.equal(responses.anonymous.status, 401, 'same-origin inference must not bypass bearer authentication');
  assert.equal(responses.sameOriginMode.status, 200);
  assert.equal(responses.head.status, 200); assert.equal(responses.head.text, '');
  assert.equal(responses.rename.status, 503); assert.equal(responses.publish.status, 503);
  for (const response of Object.values(responses)) assert.equal(response.noindex, 'noindex, nofollow');
  assert.equal(JSON.parse(names.get('owner-names'))[owner], name);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM drafts').first()).n, 0);
  assert.ok(github.log.every((line) => line.startsWith('GET ')), 'read-only browsing must never mutate fake GitHub');
  console.log('PASS browser login POST carries Origin and reaches credential validation (401); anonymous reads stay 401, HEAD/same-origin mode work, and writes stay 503');

  const metadata = { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' };
  assert.equal((await send({ headers: { ...metadata, Origin: foreignOrigin, Authorization: 'Bearer ' + token } })).status, 403, 'an explicit foreign Origin must never be replaced');
  assert.equal((await send({ headers: { Authorization: 'Bearer ' + token } })).status, 403, 'absence of browser metadata must not authorize an Origin-less client');
  assert.equal((await send({ method: 'POST', path: '/cms-api/session', headers: { ...metadata, 'Content-Type': 'application/json' }, body: '{}' })).status, 403, 'write methods must not receive an inferred Origin');

  const other = await context.newPage();
  await other.goto(foreignOrigin);
  const crossOrigin = await other.evaluate(async (origin) => {
    try { await fetch(origin + '/cms-api/me', { credentials: 'omit' }); return 'unexpectedly-readable'; }
    catch { return 'blocked'; }
  }, origin);
  assert.equal(crossOrigin, 'blocked', 'the foreign page must not be able to read the API response');
  const crossSite = requests.find((item) => item.origin === foreignOrigin && item.site === 'cross-site');
  assert.ok(crossSite, 'the offsite browser request must reach the actual bridge');
  assert.equal(crossSite.status, 403); assert.equal(crossSite.rawOrigin, true);
  assert.equal(crossSite.referer, undefined);
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(externalRequests, []);
  console.log('PASS real offsite Chromium GETs and explicit foreign Origins stay denied; missing-Origin writes stay denied');
} finally {
  try { await browser?.close(); }
  finally { await close(server); await close(foreign); globalThis.fetch = realFetch; db.raw.close(); }
}
