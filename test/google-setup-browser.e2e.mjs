// Actual Chromium -> same-origin Node bridge -> MySQL Google setup flow.
// MYSQL_TEST_CONFIG must name a loopback lab; the helper creates/drops its own
// database. GIS and GitHub stay offline, while Google ID proofs use real RS256
// signatures and the production JOSE verifier with an ephemeral local key set.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { createRequire } from 'node:module';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { createCmsServer } from '../server/http.mjs';
import { runtimeHandler } from '../server/runtime.mjs';
import { createLocalAuth } from '../server/local-auth.mjs';
import { createGoogleProofVerifier } from '../server/google-auth-proof.mjs';
import { createMysqlAuthStore } from '../server/mysql-auth-store.mjs';
import { createMysqlDataStore } from '../server/mysql-store.mjs';
import { createMysqlKv } from '../server/mysql-kv.mjs';
import { createMysqlRateLimitStore } from '../server/mysql-rate-limit.mjs';
import { createInitializedMysqlPool } from '../server/mysql-pool.mjs';
import { randomToken, digestToken } from '../server/local-auth-crypto.mjs';
import { initializeLocalAuthSchema } from '../scripts/setup-local-auth.mjs';
import { initializeGoogleAuthSchema } from '../scripts/setup-google-auth.mjs';
import worker from '../cms-worker/worker.mjs';
import { mysqlEnabled, withMysqlDatabase } from './helpers/mysql.mjs';
import { makeGithub } from './helpers/fake-github.mjs';
import { repoFiles } from './helpers/editor-world.mjs';

const OWNER_EMAIL = 'google-setup-browser-owner@example.test';
const OWNER_HASH = digestToken(OWNER_EMAIL);
const PASSWORD = 'Isolated Google setup browser password 123!';
const CLIENT_ID = '123456789012-browserfixtureclientonly.apps.googleusercontent.com';
const STATIC_CLIENT_ID = '123456789012-stalestaticfixtureclient.apps.googleusercontent.com';
const SIGN_PATH = '/__google_setup_fixture/sign';
const sdk = `
window.__gisFixture = { idOptions: [], oauthOptions: [], prompts: 0 };
window.google = { accounts: {
  id: {
    initialize: function(options) { window.__gisFixture.idOptions.push(options); },
    renderButton: function(container) {
      var options = window.__gisFixture.idOptions.at(-1);
      var button = document.createElement('button'); button.type = 'button';
      button.textContent = 'Offline Google proof fixture'; button.dataset.fixtureGoogle = 'true';
      button.addEventListener('click', async function() {
        var response = await fetch('${SIGN_PATH}', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientId: options.client_id, nonce: options.nonce }) });
        if (!response.ok) throw new Error('Offline proof signing failed');
        options.callback(await response.json());
      });
      container.append(button);
    },
    cancel: function() {},
    prompt: function() { window.__gisFixture.prompts++; }
  },
  oauth2: { initTokenClient: function(options) {
    window.__gisFixture.oauthOptions.push(options);
    return { requestAccessToken: function() {} };
  } }
} };
`;

if (!mysqlEnabled) {
  console.log('SKIP real MySQL Google setup browser flow: MYSQL_TEST_CONFIG is not configured');
} else await withMysqlDatabase(async ({ pool: rawPool, database }) => {
  const pool = createInitializedMysqlPool(rawPool);
  for (const initialize of [initializeLocalAuthSchema, initializeGoogleAuthSchema]) {
    const plan = await initialize(null);
    await initialize(pool, { apply: true, targetDatabase: database, expectedSchemaSha256: plan.schemaSha256 });
  }
  const store = createMysqlAuthStore(pool, { googleSetup: true }); await store.ensureSchema();
  const data = createMysqlDataStore(pool); await data.ensureSchema();
  const editors = createMysqlKv(pool);
  await editors.put('owner-names', JSON.stringify({ [OWNER_HASH]: 'בעלים קיים' }));
  await editors.put('people', JSON.stringify([{ email: 'browser-editor@example.test', name: 'Existing editor', publisher: false }]));
  const membershipBefore = (await pool.query('SELECT * FROM editors_kv ORDER BY `key`'))[0];
  const code = randomToken();
  await store.atomic(async (tx) => tx.saveSettings({ ...await tx.getSettings(), bootstrap_hash: digestToken(code), bootstrap_expires: Date.now() + 600_000, bootstrap_owner_hash: OWNER_HASH }));
  const signing = await generateKeyPair('RS256'), keyId = 'ephemeral-browser-google-fixture';
  const keySet = createLocalJWKSet({ keys: [{ ...await exportJWK(signing.publicKey), kid: keyId, alg: 'RS256', use: 'sig' }] });
  const loginTime = Date.now(); let serverTime = loginTime;
  const clock = () => serverTime;
  let signatureVerifications = 0;
  const googleProofVerifier = createGoogleProofVerifier({ clock, keySet: async (...args) => { signatureVerifications++; return keySet(...args); } });
  const site = resolve(new URL('../site/', import.meta.url).pathname);
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
  const github = await makeGithub({ repo: 'o/r', branch: 'live', files: repoFiles() });
  const originalHead = github.head, realFetch = globalThis.fetch;
  const providerCalls = [], externalBrowserRequests = [], browserErrors = [], serverErrors = [], apiRequests = [], signedProofs = [];
  let browser, context, bridge, origin, api, googleScriptRequests = 0;
  const server = createServer(async (request, response) => {
    const json = (value, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)); };
    try {
      const url = new URL(request.url, origin), path = url.pathname;
      if (path.startsWith('/cms-api/')) {
        apiRequests.push({ path, method: request.method, search: url.search, csrf: Boolean(request.headers['x-csrf-token']), authorization: Boolean(request.headers.authorization) });
        return api(request, response);
      }
      if (path === SIGN_PATH) {
        assert.equal(request.method, 'POST'); assert.equal(request.headers.origin, origin); assert.equal(url.search, '');
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        assert.deepEqual(Object.keys(body).sort(), ['clientId', 'nonce']); assert.equal(body.clientId, CLIENT_ID);
        assert.match(body.nonce, /^[A-Za-z0-9_-]{43}$/);
        const pending = await store.getGoogleConfig();
        assert.equal(pending.pending_client_id, body.clientId); assert.equal(pending.pending_nonce_hash, digestToken(body.nonce));
        const issuedAt = Math.floor(clock() / 1000);
        const credential = await new SignJWT({ nonce: body.nonce, email: OWNER_EMAIL, email_verified: true })
          .setProtectedHeader({ alg: 'RS256', kid: keyId }).setIssuer('https://accounts.google.com')
          .setAudience(body.clientId).setSubject('offline-browser-google-owner').setIssuedAt(issuedAt).setExpirationTime(issuedAt + 300)
          .sign(signing.privateKey);
        signedProofs.push(credential);
        return json({ credential });
      }
      if (path === '/admin/config.json') return json({ repo: 'o/r', branch: 'live', worker: origin + '/cms-api', googleClientId: STATIC_CLIENT_ID });
      if (path === '/admin/photos/index.json' || path === '/admin/pages/index.json') return json([]);
      if (path === '/admin/links.json') return json({ stats: { errors: 0, warnings: 0 }, suggestions: [] });
      const file = resolve(site, '.' + (path === '/admin/' ? '/admin/index.html' : path));
      if (!file.startsWith(site + sep)) { response.writeHead(403); return response.end(); }
      try { const bytes = await readFile(file); response.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' }); response.end(bytes); }
      catch { response.writeHead(404); response.end(); }
    } catch (error) {
      serverErrors.push(String(error));
      if (!response.headersSent) json({ message: 'Offline browser fixture failed' }, 500); else response.end();
    }
  });
  try {
    await new Promise((done) => server.listen(0, '127.0.0.1', done)); origin = `http://127.0.0.1:${server.address().port}`;
    const env = { ALLOWED_ORIGIN: origin, REPO: 'o/r', BRANCH: 'live', OWNERS: OWNER_HASH, GOOGLE_CLIENT_ID: STATIC_CLIENT_ID,
      GITHUB_TOKEN: 'isolated-github-fixture', SESSION_SECRET: 'isolated-google-setup-browser-secret-32-bytes', CMS_STAGING: true,
      DATA_STORE: data, EDITORS: editors, RATE_LIMIT_STORE: createMysqlRateLimitStore(pool) };
    const config = { env, publicOrigin: origin, apiBasePath: '/cms-api', localAuthEnabled: true, googleSetupEnabled: true,
      googleEnabled: true, readOnly: true, publishEnabled: false, staging: true };
    const auth = createLocalAuth({ store, config, clock, googleProofVerifier });
    bridge = createCmsServer({ env, publicOrigin: origin, basePath: config.apiBasePath, noIndex: true,
      handleRequest: runtimeHandler(config, (request, currentEnv) => auth.handle(request, currentEnv, worker.fetch)) });
    api = bridge.listeners('request')[0];
    globalThis.fetch = async (url, options = {}) => {
      providerCalls.push(new URL(url).origin);
      const result = await github.fetch(url, options);
      if (!result) throw new Error('External provider call blocked by Google setup browser fixture');
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
        return route.fulfill({ contentType: 'text/javascript', body: sdk });
      }
      externalBrowserRequests.push(url); return route.abort('blockedbyclient');
    });
    const page = await context.newPage(); page.on('pageerror', (error) => browserErrors.push(String(error)));
    const authBodies = [];
    page.on('request', request => {
      const { pathname } = new URL(request.url());
      if (request.method() === 'POST' && (pathname.startsWith('/cms-api/auth/google/') || pathname === '/cms-api/auth/confirm')) {
        authBodies.push([pathname.split('/').at(-1), ...Object.keys(request.postDataJSON()).sort()]);
      }
    });
    if (process.env.DEBUG_AUTH_BROWSER) page.on('response', (response) => { const url = new URL(response.url()); if (url.pathname.startsWith('/cms-api/')) console.log('HTTP', response.status(), url.pathname); });
    const options = () => page.evaluate(async () => { const response = await fetch('/cms-api/auth/options'); if (!response.ok) throw new Error('Auth options failed'); return response.json(); });
    const localCookie = async () => (await context.cookies()).find((cookie) => cookie.name === '__Host-heichal_local');
    const apiResponse = (path) => page.waitForResponse((response) => new URL(response.url()).pathname === '/cms-api' + path && response.request().method() === 'POST');
    await page.goto(origin + '/cms-api/auth/setup');
    await page.locator('#setup-code').fill(code); await page.locator('#setup-user').fill('lab-administrator');
    await page.locator('#setup-name').fill('מנהל בדיקת Google'); await page.locator('#setup-password').fill(PASSWORD); await page.locator('#setup-confirm').fill(PASSWORD);
    await page.locator('#setup-submit').click(); await page.locator('#setup-success:not([hidden])').waitFor();
    assert.equal((await context.cookies()).length, 0, 'bootstrap does not sign in');
    assert.equal((await realFetch(origin + '/cms-api/auth/setup')).status, 404);
    const user = await store.getUserByUsername('lab-administrator');
    assert.equal(user.owner_hash, OWNER_HASH); assert.equal(user.role, 'owner'); assert.match(user.password_hash, /^scrypt\$v1\$/);
    await page.locator('#setup-login').click(); await page.locator('#local-login:not([hidden])').waitFor();
    const initialOptions = await options(), initialGoogle = await store.getGoogleConfig();
    assert.equal(initialOptions.googleManaged, true); assert.equal(initialOptions.googleEnabled, false); assert.equal(initialOptions.googleClientId, '');
    assert.equal(initialOptions.googleRevision, initialGoogle.active_version); assert.equal(googleScriptRequests, 0);
    assert.equal(await page.locator('#gbox').isVisible(), false, 'static Google client does not activate managed login');
    await page.locator('#local-user').fill('lab-administrator'); await page.locator('#local-password').fill(PASSWORD); await page.locator('#local-signin').click();
    await page.waitForFunction(() => !document.querySelector('#app').hidden || Boolean(document.querySelector('#lerr').textContent));
    assert.equal(await page.locator('#lerr').textContent(), ''); await page.locator('#app:not([hidden])').waitFor();
    assert.equal(await page.locator('#who').textContent(), 'מנהל בדיקת Google'); assert.match(await page.locator('#preview-state').textContent(), /קריאה בלבד/);
    const cookieBefore = await localCookie(), sessionBefore = await store.getSession(digestToken(cookieBefore.value));
    assert(cookieBefore.httpOnly && cookieBefore.secure && cookieBefore.sameSite === 'Strict');
    assert.equal(await page.evaluate(() => document.cookie), '');
    const authLink = page.locator('#nav a[href="#/auth"]');
    await authLink.click(); await page.locator('#auth-methods').waitFor();
    assert.equal(await page.locator('#auth-google-enabled').isChecked(), false); assert.equal(await page.locator('#auth-google-enabled').isDisabled(), true);
    assert.equal(await page.locator('#auth-local-enabled').isChecked(), true);
    const googleLink = page.locator('#nav').getByRole('link', { name: 'הגדרות Google', exact: true });
    await googleLink.click(); await page.waitForURL('**/#/auth/google');
    await page.locator('#nav a[href="#/auth/google"][aria-current="page"]').waitFor();
    assert.equal(await page.locator('#nav a[aria-current="page"]').count(), 1);
    await page.locator('#auth-google-setup').waitFor();
    assert.equal(await page.locator('#google-setup-origin').inputValue(), origin);
    const prepareResponse = apiResponse('/auth/google/prepare');
    assert.equal(await page.locator('#google-prepare-password').isVisible(), false, 'recent local login prepares Google without another password');
    await page.locator('#google-client-id').fill(CLIENT_ID); await page.locator('#google-prepare-submit').click();
    const preparation = await prepareResponse;
    assert.equal(preparation.status(), 200); const prepared = await preparation.json();
    await page.locator('[data-fixture-google]').waitFor();
    assert.equal(await page.locator('#google-prepare-password').inputValue(), '');
    const pending = await store.getGoogleConfig(), pendingOptions = await options();
    assert.equal(pending.pending_client_id, CLIENT_ID); assert.equal(pending.pending_nonce_hash, digestToken(prepared.nonce));
    assert.equal(pending.pending_session_hash, digestToken(cookieBefore.value)); assert.equal(pending.pending_user_id, user.id);
    assert.equal(pending.active_client_id, null); assert.equal(pending.active_version, initialGoogle.active_version);
    assert.equal(pendingOptions.googleEnabled, false); assert.equal(pendingOptions.googleClientId, '');
    assert.equal(await page.locator('#google-activate').isVisible(), false);
    const gisOptions = await page.evaluate(() => { const value = window.__gisFixture.idOptions.at(-1); return { clientId: value.client_id, nonce: value.nonce, mode: value.ux_mode }; });
    assert.deepEqual(gisOptions, { clientId: CLIENT_ID, nonce: prepared.nonce, mode: 'popup' });
    assert.equal(await page.evaluate(() => window.__gisFixture.prompts), 0);
    const verifyResponse = apiResponse('/auth/google/verify');
    await page.locator('[data-fixture-google]').click();
    const verification = await verifyResponse;
    assert.equal(verification.status(), 200); const verified = await verification.json();
    await page.locator('#google-activate:not([hidden])').waitFor();
    assert.equal(verified.verified, true); assert.equal(signatureVerifications, 1); assert.equal(signedProofs.length, 1);
    assert.match(signedProofs[0], /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const proofState = await store.getGoogleConfig(), proofOptions = await options();
    assert.equal(proofState.pending_nonce_hash, null); assert.equal(proofState.verified_until, verified.verifiedUntil);
    assert.equal(proofState.active_client_id, null); assert.equal(proofState.active_version, initialGoogle.active_version);
    assert.equal(proofOptions.googleEnabled, false); assert.equal(proofOptions.googleClientId, '');
    assert.equal((await localCookie()).value, cookieBefore.value); assert.equal(await page.locator('#google-activate-password').inputValue(), '');
    assert.equal(apiRequests.filter((request) => request.path === '/cms-api/auth/google/activate').length, 0, 'proof cannot activate implicitly');
    const activationResponse = apiResponse('/auth/google/activate');
    const refreshedSettings = page.waitForResponse((response) => new URL(response.url()).pathname === '/cms-api/auth/settings' && response.request().method() === 'GET');
    assert.equal(await page.locator('#google-activate-password').isVisible(), false, 'a recently authenticated owner can approve activation directly');
    await page.locator('#google-activate-submit').click();
    const activation = await activationResponse;
    assert.equal(activation.status(), 200); const activated = await activation.json(); await refreshedSettings;
    await authLink.click(); await page.locator('#auth-methods').waitFor();
    await page.waitForFunction(() => document.querySelector('#auth-google-enabled')?.checked);
    const active = await store.getGoogleConfig(), activeOptions = await options(), settings = await store.getSettings();
    assert.equal(activated.activated, true); assert.equal(activated.clientId, CLIENT_ID);
    assert.equal(active.active_client_id, CLIENT_ID); assert.equal(active.active_version, initialGoogle.active_version + 1);
    assert.equal(active.active_version, activated.googleRevision); assert.equal(active.pending_client_id, null); assert.equal(active.verified_until, 0);
    assert.equal(activeOptions.googleClientId, CLIENT_ID); assert.equal(activeOptions.googleRevision, active.active_version); assert.equal(activeOptions.googleEnabled, true);
    assert.equal(settings.local_enabled, true); assert.equal(settings.local_verified, true); assert.equal(settings.google_enabled, true);
    assert.equal(settings.google_verified_until, 0, 'configuration proof is not ordinary Google sign-in');
    assert.equal((await localCookie()).value, cookieBefore.value); assert.deepEqual(await store.getSession(digestToken(cookieBefore.value)), sessionBefore);
    assert.deepEqual(await store.getUserById(user.id), user); assert.equal(env.OWNERS, OWNER_HASH);
    assert.equal(await page.locator('#who').textContent(), 'מנהל בדיקת Google');
    const browserSession = await page.evaluate(async () => (await (await fetch('/cms-api/auth/session')).json()));
    assert.equal(browserSession.method, 'local'); assert.equal(browserSession.user.email, `local:${user.id}`);
    for (const [path, method] of [['/publish', 'POST'], ['/gh/contents/data/topics.json', 'PUT']]) {
      const status = await page.evaluate(async ({ path, method, csrf }) => (await fetch('/cms-api' + path, { method,
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: '{}' })).status, { path, method, csrf: browserSession.csrfToken });
      assert.equal(status, 503, 'the wizard does not enable content writes');
    }
    const savedBrowserValues = await page.evaluate(() => ({ storage: JSON.stringify([Object.fromEntries(Object.entries(localStorage)), Object.fromEntries(Object.entries(sessionStorage))]), url: location.href }));
    for (const secret of [PASSWORD, code, prepared.nonce, signedProofs[0]]) {
      assert.equal(savedBrowserValues.storage.includes(secret), false); assert.equal(savedBrowserValues.url.includes(secret), false);
    }
    assert.equal(await page.evaluate(() => localStorage.getItem('cms-token') || sessionStorage.getItem('cms-token')), null);
    await page.reload(); await page.locator('#app:not([hidden])').waitFor();
    assert.deepEqual(await options(), activeOptions); assert.equal((await localCookie()).value, cookieBefore.value);
    assert.equal(await page.locator('#who').textContent(), 'מנהל בדיקת Google');
    const [[counts]] = await pool.query('SELECT (SELECT COUNT(*) FROM google_auth_config) AS configs, (SELECT COUNT(*) FROM local_auth_users) AS users, (SELECT COUNT(*) FROM local_auth_sessions) AS sessions, (SELECT COUNT(*) FROM drafts) AS drafts, (SELECT COUNT(*) FROM media) AS media, (SELECT COUNT(*) FROM log) AS log');
    assert.deepEqual(Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, Number(value)])), { configs: 1, users: 1, sessions: 1, drafts: 0, media: 0, log: 0 });
    assert.deepEqual((await pool.query('SELECT * FROM editors_kv ORDER BY `key`'))[0], membershipBefore); assert.equal(github.head, originalHead);
    const setupWrites = apiRequests.filter((request) => request.path.startsWith('/cms-api/auth/google/'));
    assert.deepEqual(setupWrites.map((request) => request.path), ['/cms-api/auth/google/prepare', '/cms-api/auth/google/verify', '/cms-api/auth/google/activate']);
    assert(setupWrites.every((request) => request.method === 'POST' && request.csrf && !request.authorization && !request.search));
    assert.deepEqual(authBodies, [['prepare', 'clientId'], ['verify', 'credential', 'revision'], ['activate', 'revision']]);
    assert.equal(apiRequests.some((request) => request.path === '/cms-api/session'), false);

    // Only the local owner's freshness expires after the second Google proof.
    serverTime = loginTime + 14 * 60_000;
    await googleLink.click(); await page.locator('#google-client-id').waitFor();
    await page.locator('#google-client-id').fill(CLIENT_ID); await page.locator('#google-prepare-submit').click();
    await page.locator('[data-fixture-google]').click(); await page.locator('#google-activate:not([hidden])').waitFor();
    const beforeStepUp = await store.getGoogleConfig();
    serverTime = loginTime + 16 * 60_000;
    const forged = await context.request.post(origin + '/cms-api/auth/google/activate', {
      headers: { Origin: origin, 'X-CSRF-Token': browserSession.csrfToken },
      data: { revision: beforeStepUp.revision, localOwnerFresh: true, confirmedAt: serverTime, freshUntil: serverTime + 900_000 },
    });
    assert.equal(forged.status(), 428); assert.equal((await forged.json()).code, 'reauth_required');
    assert.deepEqual(await store.getGoogleConfig(), beforeStepUp, 'client freshness claims confer no authority');
    const expired = apiResponse('/auth/google/activate'); await page.locator('#google-activate-submit').click();
    assert.equal((await expired).status(), 428); await page.locator('#google-activate-password').waitFor();
    assert.equal(await page.locator('#google-prepare-password').isVisible(), false);
    assert.deepEqual(await store.getGoogleConfig(), beforeStepUp);
    await page.locator('#google-activate-password').fill(PASSWORD);
    const confirmed = apiResponse('/auth/confirm'), retry = apiResponse('/auth/google/activate');
    const renewedView = page.waitForResponse(r => new URL(r.url()).pathname === '/cms-api/auth/settings' && r.request().method() === 'GET');
    await page.locator('#google-activate-submit').click();
    assert.equal((await confirmed).status(), 200); assert.equal((await retry).status(), 200);
    await renewedView; await page.locator('#google-prepare-submit:enabled').waitFor();
    assert.equal((await localCookie()).value, cookieBefore.value);
    assert.equal(signatureVerifications, 2, 'step-up preserves the already verified Google identity');
    assert.deepEqual(authBodies.slice(3), [['prepare', 'clientId'], ['verify', 'credential', 'revision'], ['activate', 'revision'], ['confirm', 'currentPassword'], ['activate', 'revision']]);
    await page.locator('#google-prepare-submit').click(); await page.locator('[data-fixture-google]').waitFor();
    assert.deepEqual(authBodies.at(-1), ['prepare', 'clientId']);
    assert.equal(authBodies.filter(([path]) => path === 'confirm').length, 1, 'the next operation reuses the confirmation');
    assert(providerCalls.every((host) => host === 'https://api.github.com'));
    assert.deepEqual(externalBrowserRequests, []); assert.deepEqual(browserErrors, []); assert.deepEqual(serverErrors, []);
    console.log('PASS real Chromium/Node/MySQL Google wizard: bootstrap and local cookie login, real offline RS256 verification, pending stays inactive, explicit activation, single database client/epoch, unchanged local cookie/user/membership, reload discovery, read-only503 and no external providers');
  } finally {
    await context?.close(); await browser?.close(); globalThis.fetch = realFetch;
    server.closeAllConnections(); await new Promise((done) => server.close(done)); bridge?.closeAllConnections();
  }
});
