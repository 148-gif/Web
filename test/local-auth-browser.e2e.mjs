// Actual Chromium + same-origin Node bridge + local auth + MySQL stores.
// MYSQL_TEST_CONFIG must select a loopback-only disposable lab; the helper
// creates and removes its own database. GitHub/Google never leave this process.
// Pass --local-only to test a deployment with no configured Google provider.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { createRequire } from 'node:module';
import { createCmsServer } from '../server/http.mjs';
import { runtimeHandler } from '../server/runtime.mjs';
import { createLocalAuth } from '../server/local-auth.mjs';
import { createMysqlAuthStore } from '../server/mysql-auth-store.mjs';
import { createMysqlDataStore } from '../server/mysql-store.mjs';
import { createMysqlKv } from '../server/mysql-kv.mjs';
import { createMysqlRateLimitStore } from '../server/mysql-rate-limit.mjs';
import { createInitializedMysqlPool } from '../server/mysql-pool.mjs';
import { randomToken, digestToken } from '../server/local-auth-crypto.mjs';
import { initializeLocalAuthSchema } from '../scripts/setup-local-auth.mjs';
import worker, { sha256 } from '../cms-worker/worker.mjs';
import { mysqlEnabled, withMysqlDatabase } from './helpers/mysql.mjs';
import { makeGithub } from './helpers/fake-github.mjs';
import { repoFiles } from './helpers/editor-world.mjs';

const localOnly = process.argv.includes('--local-only');

if (!mysqlEnabled) {
  console.log('SKIP real MySQL local-auth browser flow: MYSQL_TEST_CONFIG is not configured');
} else await withMysqlDatabase(async ({ pool: rawPool, database }) => {
  const pool = createInitializedMysqlPool(rawPool);
  const plan = await initializeLocalAuthSchema(null);
  await initializeLocalAuthSchema(pool, { apply: true, targetDatabase: database, expectedSchemaSha256: plan.schemaSha256 });
  const store = createMysqlAuthStore(pool); await store.ensureSchema();
  const data = createMysqlDataStore(pool); await data.ensureSchema();
  const ownerHash = await sha256('cloud-lab-owner@example.test'), code = randomToken();
  await store.atomic(async (tx) => tx.saveSettings({ ...await tx.getSettings(), bootstrap_hash: digestToken(code), bootstrap_expires: Date.now() + 600_000, bootstrap_owner_hash: ownerHash }));
  const site = resolve(new URL('../site/', import.meta.url).pathname), mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
  const github = await makeGithub({ repo: 'o/r', branch: 'live', files: repoFiles() });
  const originalHead = github.head, realFetch = globalThis.fetch, providerCalls = [], browserErrors = [], outgoingRequests = [];
  let browser, context, bridge, origin, api, googleScriptRequests = 0;
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, origin).pathname;
    if (path.startsWith('/cms-api/')) return api(request, response);
    const json = (value) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
    if (path === '/admin/config.json') return json({ repo: 'o/r', branch: 'live', worker: origin + '/cms-api', googleClientId: localOnly ? '' : 'not-a-real-provider-client' });
    if (path === '/admin/photos/index.json' || path === '/admin/pages/index.json') return json([]);
    if (path === '/admin/links.json') return json({ stats: { errors: 0, warnings: 0 }, suggestions: [] });
    const file = resolve(site, '.' + (path === '/admin/' ? '/admin/index.html' : path));
    if (!file.startsWith(site + sep)) { response.writeHead(403); return response.end(); }
    try { const bytes = await readFile(file); response.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' }); response.end(bytes); }
    catch { response.writeHead(404); response.end(); }
  });
  try {
    await new Promise((done) => server.listen(0, '127.0.0.1', done)); origin = `http://127.0.0.1:${server.address().port}`;
    const env = { ALLOWED_ORIGIN: origin, REPO: 'o/r', BRANCH: 'live', OWNERS: ownerHash,
      ...(localOnly ? {} : { GOOGLE_CLIENT_ID: 'not-a-real-provider-client' }),
      GITHUB_TOKEN: 'isolated-github-fixture', SESSION_SECRET: 'isolated-local-auth-browser-secret-32-bytes', CMS_STAGING: true,
      DATA_STORE: data, EDITORS: createMysqlKv(pool), RATE_LIMIT_STORE: createMysqlRateLimitStore(pool) };
    const config = { env, publicOrigin: origin, apiBasePath: '/cms-api', localAuthEnabled: true, googleEnabled: !localOnly, readOnly: true, publishEnabled: false, staging: true };
    const auth = createLocalAuth({ store, config });
    bridge = createCmsServer({ env, publicOrigin: origin, basePath: config.apiBasePath, noIndex: true, handleRequest: runtimeHandler(config, (request, currentEnv) => auth.handle(request, currentEnv, worker.fetch)) });
    api = bridge.listeners('request')[0];
    globalThis.fetch = async (url, options = {}) => {
      providerCalls.push(new URL(url).origin);
      const result = await github.fetch(url, options);
      if (!result) throw new Error('External provider call blocked by local-auth browser fixture');
      return result;
    };
    const { chromium } = createRequire(import.meta.url)('playwright');
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium' });
    context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (new URL(url).origin === origin) return route.continue();
      if (url === 'https://accounts.google.com/gsi/client') {
        googleScriptRequests++;
        return route.fulfill({ contentType: 'text/javascript', body: 'window.google={accounts:{oauth2:{initTokenClient:function(){return {requestAccessToken:function(){}};}}}};' });
      }
      outgoingRequests.push(url); return route.abort('blockedbyclient');
    });
    const page = await context.newPage(); page.on('pageerror', (error) => browserErrors.push(String(error)));
    if (process.env.DEBUG_AUTH_BROWSER) page.on('response', (response) => { const url = new URL(response.url()); if (url.pathname.startsWith('/cms-api/')) console.log('HTTP', response.status(), url.pathname); });
    const firstPassword = 'Isolated admin password 123!';
    await page.goto(origin + '/cms-api/auth/setup');
    await page.locator('#setup-code').fill(code); await page.locator('#setup-user').fill('lab-administrator');
    await page.locator('#setup-name').fill('מנהל תרגול'); await page.locator('#setup-password').fill(firstPassword); await page.locator('#setup-confirm').fill(firstPassword);
    await page.locator('#setup-submit').click(); await page.locator('#setup-success:not([hidden])').waitFor();
    assert.equal((await context.cookies()).length, 0, 'bootstrap does not authenticate the browser');
    const account = await store.getUserByUsername('lab-administrator');
    assert.match(account.password_hash, /^scrypt\$v1\$/); assert(!account.password_hash.includes(firstPassword));
    assert.equal(account.owner_hash, ownerHash); assert.equal(account.role, 'owner');
    assert.equal((await store.getSettings()).bootstrap_consumed, true);
    assert.equal((await realFetch(origin + '/cms-api/auth/setup')).status, 404, 'consumed bootstrap page closes');
    await page.locator('#setup-login').click(); await page.locator('#local-login:not([hidden])').waitFor();
    const options = await page.evaluate(async () => (await (await fetch('/cms-api/auth/options')).json()));
    assert.deepEqual(options, { localEnabled: true, googleEnabled: !localOnly, settingsAvailable: true, readOnly: true, publishEnabled: false });
    assert.equal(await page.locator('#gbox').isVisible(), !localOnly, 'Google login follows the configured provider');
    await page.locator('#local-user').fill('lab-administrator'); await page.locator('#local-password').fill(firstPassword);
    await page.locator('#local-signin').click();
    await page.waitForFunction(() => !document.querySelector('#app').hidden || Boolean(document.querySelector('#lerr').textContent));
    assert.equal(await page.locator('#lerr').textContent(), '', 'local login must enter the app');
    await page.locator('#app:not([hidden])').waitFor();
    assert.match(await page.locator('#preview-state').textContent(), /קריאה בלבד/);
    assert.equal(await page.locator('#who').textContent(), 'מנהל תרגול');
    const firstCookie = (await context.cookies()).find((cookie) => cookie.name === '__Host-heichal_local');
    assert(firstCookie && firstCookie.httpOnly && firstCookie.secure && firstCookie.sameSite === 'Strict' && firstCookie.path === '/');
    assert.equal(await page.evaluate(() => document.cookie), '');
    assert.equal(await page.evaluate(() => localStorage.getItem('cms-token') || sessionStorage.getItem('cms-token')), null);
    await page.reload(); await page.locator('#app:not([hidden])').waitFor();
    assert.equal((await context.cookies()).find((cookie) => cookie.name === firstCookie.name).value, firstCookie.value);
    const me = await page.evaluate(async () => { const r = await fetch('/cms-api/me'); return { status: r.status, value: await r.json() }; });
    assert.equal(me.status, 200); assert.match(me.value.email, /^local:[a-f0-9]{32}$/); assert.equal(me.value.owner, true);
    const csrf = await page.evaluate(async () => (await (await fetch('/cms-api/auth/session')).json()).csrfToken);
    const noCsrf = await page.evaluate(async () => (await fetch('/cms-api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status);
    assert.equal(noCsrf, 403); assert(await store.getSession(digestToken(firstCookie.value)), 'CSRF rejection keeps the session valid');
    const blockedWrite = await page.evaluate(async (token) => (await fetch('/cms-api/publish', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token }, body: '{}' })).status, csrf);
    assert.equal(blockedWrite, 503, 'administrator credentials do not turn on publishing');
    await page.locator('#nav a[href="#/auth"]').click(); await page.locator('#auth-methods').waitFor();
    assert.equal(await page.locator('#auth-local-enabled').isChecked(), true);
    assert.equal(await page.locator('#auth-local-enabled').isDisabled(), true);
    assert.equal(await page.locator('#auth-google-enabled').isChecked(), !localOnly);
    assert.equal(await page.locator('#auth-google-enabled').isDisabled(), localOnly);
    if (localOnly) {
      await page.getByText('Google אינו מופעל באתר הזה. ניתן להפעילו לאחר השלמת ההגדרה באחסון.', { exact: true }).waitFor();
    } else await page.locator('#auth-google-enabled').uncheck();
    await page.locator('#auth-method-password').fill(firstPassword);
    await page.locator('#auth-methods button[type=submit]').click(); await page.getByText('דרכי הכניסה נשמרו.', { exact: true }).waitFor();
    assert.equal((await store.getSettings()).google_enabled, false);
    assert.equal(await store.getSession(digestToken(firstCookie.value)), null, 'settings rotation revokes old session');
    const passwordBefore = (await context.cookies()).find((cookie) => cookie.name === firstCookie.name);
    assert.notEqual(passwordBefore.value, firstCookie.value, 'settings save rotates the current cookie in either provider mode');
    const secondPassword = 'Replacement password local 456!';
    await page.locator('#auth-password-currentPassword').fill(firstPassword); await page.locator('#auth-password-newPassword').fill(secondPassword); await page.locator('#auth-password-confirmation').fill(secondPassword);
    await page.locator('#auth-password-change button[type=submit]').click(); await page.getByText('הסיסמה הוחלפה. שאר ההתחברויות לחשבון הסתיימו.', { exact: true }).waitFor();
    const passwordAfter = (await context.cookies()).find((cookie) => cookie.name === firstCookie.name);
    assert.notEqual(passwordAfter.value, passwordBefore.value); assert.equal(await store.getSession(digestToken(passwordBefore.value)), null);
    const oldReplay = await realFetch(origin + '/cms-api/me', { headers: { Origin: origin, Cookie: firstCookie.name + '=' + passwordBefore.value } });
    assert.equal(oldReplay.status, 401);
    assert.equal((await store.getUserById(account.id)).version, account.version + 1);
    await page.locator('#out').click(); await page.locator('#login:not([hidden])').waitFor();
    assert.equal(await page.locator('#gbox').isVisible(), false, 'Google remains hidden after logout when disabled');
    assert.equal(await store.getSession(digestToken(passwordAfter.value)), null); assert.equal((await context.cookies()).some((cookie) => cookie.name === firstCookie.name), false);
    const [[counts]] = await pool.query('SELECT (SELECT COUNT(*) FROM drafts) AS drafts, (SELECT COUNT(*) FROM media) AS media, (SELECT COUNT(*) FROM editors_kv) AS editors, (SELECT COUNT(*) FROM log) AS log');
    assert.deepEqual(Object.values(counts).map(Number), [0, 0, 0, 0]); assert.equal(github.head, originalHead);
    assert(providerCalls.every((host) => host === 'https://api.github.com')); assert.deepEqual(outgoingRequests, []); assert.deepEqual(browserErrors, []);
    if (localOnly) assert.equal(googleScriptRequests, 0, 'local-only mode does not load the Google library');
    console.log(`PASS real Chromium/MySQL (${localOnly ? 'local-only' : 'dual-provider'}): private one-shot setup, scrypt storage, local owner identity, provider availability/last-method protection, Secure/HttpOnly cookie login/reload, CSRF rejection, read-only publication503, settings/password rotation, revoked-cookie401, logout, content/membership unchanged`);
  } finally {
    await context?.close(); await browser?.close(); globalThis.fetch = realFetch;
    server.closeAllConnections(); await new Promise((done) => server.close(done)); bridge?.closeAllConnections();
  }
});
