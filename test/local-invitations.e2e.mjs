// Chromium exercises the shipped UI and the real Node/auth/MySQL flow in two
// separate browser contexts. Additional contract fixtures test delayed replies
// and browser safety without external services. No production credentials.
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
import { randomToken, digestToken, hashPassword } from '../server/local-auth-crypto.mjs';
import { initializeLocalAuthSchema } from '../scripts/setup-local-auth.mjs';
import { initializeLocalInvitationsSchema } from '../scripts/setup-local-invitations.mjs';
import worker from '../cms-worker/worker.mjs';
import { mysqlEnabled, withMysqlDatabase } from './helpers/mysql.mjs';
import { makeGithub } from './helpers/fake-github.mjs';
import { repoFiles } from './helpers/editor-world.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const site = resolve(new URL('../site/', import.meta.url).pathname);
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
const OWNER_PASSWORD = 'Invitation fixture owner password 123!';
const RECIPIENT_PASSWORD = 'Invitation fixture recipient password 456!';
const OWNER_EMAIL = 'inviting-owner@example.test', RECIPIENT_EMAIL = 'invited-owner@example.test';
const UNICODE_PASSWORD = '🔐'.repeat(70) + 'Aa12!fixture';
const UNICODE_REPLACEMENT = '🚀'.repeat(72) + 'Bb34!changed';
const UNICODE_EMAIL = 'unicode-owner@example.test', FOLLOWUP_EMAIL = 'next-owner@example.test';
const localUser = { email: 'local:' + 'a'.repeat(32), name: 'מנהל מזמין', owner: true, publisher: true };
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const json = (response, value, status = 200) => {
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value));
};

async function startSite(handleApi, { stripPolicy = false } = {}) {
  const audit = { requests: [], urls: [], logs: [], errors: [], external: [] };
  let origin;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, origin);
      audit.requests.push({ path: url.pathname, method: request.method, search: url.search });
      audit.urls.push(url.href, request.headers.referer || '');
      if (url.pathname.startsWith('/cms-api/')) return await handleApi(request, response, origin);
      if (url.pathname === '/admin/config.json') return json(response, { repo: 'o/r', branch: 'live', worker: origin + '/cms-api', googleClientId: '' });
      if (['/admin/photos/index.json', '/admin/pages/index.json'].includes(url.pathname)) return json(response, []);
      if (url.pathname === '/admin/links.json') return json(response, { stats: { errors: 0, warnings: 0 }, suggestions: [] });
      const file = resolve(site, '.' + (url.pathname === '/admin/' ? '/admin/index.html' : url.pathname));
      if (!file.startsWith(site + sep)) { response.writeHead(403); return response.end(); }
      try {
        let bytes = await readFile(file);
        if (stripPolicy && extname(file) === '.html') bytes = Buffer.from(bytes.toString().replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, ''));
        response.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' }); response.end(bytes);
      } catch { response.writeHead(404); response.end(); }
    } catch { audit.errors.push('local fixture request failed'); if (!response.headersSent) json(response, { message: 'fixture failure' }, 500); else response.end(); }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, audit, async close() { server.closeAllConnections(); await new Promise((done) => server.close(done)); } };
}

async function open(browser, fixture, { bearer = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  await context.addInitScript((seedBearer) => {
    window.__invitationCopies = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value) => { window.__invitationCopies.push(value); } } });
    if (seedBearer) sessionStorage.setItem('cms-token', JSON.stringify({ token: 'fixture-bearer', email: 'google-owner@example.test', owner: true }));
  }, bearer);
  await context.route('**/*', (route) => {
    if (new URL(route.request().url()).origin === fixture.origin) return route.continue();
    fixture.audit.external.push('unexpected external browser request'); return route.abort('blockedbyclient');
  });
  const page = await context.newPage();
  page.on('console', (message) => fixture.audit.logs.push(message.text()));
  page.on('pageerror', () => fixture.audit.errors.push('browser script error'));
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) fixture.audit.urls.push(frame.url()); });
  return { context, page };
}

async function login(page, origin, username = 'inviting-owner', password = OWNER_PASSWORD) {
  await page.goto(origin + '/admin/'); await page.locator('#local-login:not([hidden])').waitFor();
  await page.locator('#local-user').fill(username); await page.locator('#local-password').fill(password);
  await page.locator('#local-signin').click(); await page.locator('#app:not([hidden])').waitFor();
  assert.match(await page.locator('#preview-state').textContent(), /קריאה בלבד/);
}
async function settings(page) {
  await page.locator('#nav a[href="#/auth"]').click(); await page.locator('#auth-methods').waitFor();
}
async function createInvitation(page, email = RECIPIENT_EMAIL) {
  await page.locator('#auth-invitation-submit:enabled').waitFor();
  await page.locator('#auth-invitation-email').fill(email); await page.locator('#auth-invitation-password').fill(OWNER_PASSWORD);
  await page.locator('#auth-invitation-submit').click();
  assert.equal(await page.locator('#auth-invitation-password').inputValue(), '', 'password clears before the response');
}
async function visibleInvitation(page) {
  await page.locator('#auth-invitation-result:not([hidden])').waitFor();
  return { code: await page.locator('#auth-invitation-code').inputValue(), setupUrl: await page.locator('#auth-invitation-url').inputValue() };
}
async function emptyResult(page) {
  assert.equal(await page.locator('#auth-invitation-result').isHidden(), true);
  for (const id of ['code', 'url']) assert.equal(await page.locator('#auth-invitation-' + id).inputValue(), '');
}
async function typeCompletePassword(page, selector, value) {
  const input = page.locator(selector);
  assert.equal(await input.getAttribute('maxlength'), '256', selector + ' admits the backend UTF-16 limit');
  // Browser keyboard input must honor maxlength; assigning input.value would
  // conceal the regression where valid supplementary characters were cut off.
  await input.fill(''); await input.pressSequentially(value);
  assert((await input.inputValue()) === value, selector + ' retains the entire intended password before submission');
}
async function privateBrowserState(page, audit, secrets) {
  const state = await page.evaluate(() => ({ storage: JSON.stringify([Object.fromEntries(Object.entries(localStorage)), Object.fromEntries(Object.entries(sessionStorage))]), url: location.href,
    resources: performance.getEntriesByType('resource').map((entry) => entry.name), historyState: JSON.stringify(history.state) }));
  const session = await page.context().newCDPSession(page);
  let history;
  try { history = await session.send('Page.getNavigationHistory'); } finally { await session.detach(); }
  const surfaces = [state.storage, state.url, state.historyState, ...state.resources, ...history.entries.map((entry) => entry.url), ...audit.urls, ...audit.logs];
  assert(secrets.every((secret) => [secret, encodeURIComponent(secret)].every((variant) => surfaces.every((value) => !String(value).includes(variant)))), 'credentials must not enter URLs, history, browser storage, referrers or console output');
  assert(audit.requests.filter((request) => request.path.startsWith('/cms-api/auth/')).every((request) => !request.search), 'authentication URLs never carry query credentials');
  assert.deepEqual(audit.external, []); assert.deepEqual(audit.errors, []);
}

async function realBrowserFlow(browser) {
  if (!mysqlEnabled) { console.log('SKIP real invitation/MySQL flow: MYSQL_TEST_CONFIG is not configured'); return; }
  await withMysqlDatabase(async ({ pool: raw, database }) => {
    const pool = createInitializedMysqlPool(raw);
    for (const initialize of [initializeLocalAuthSchema, initializeLocalInvitationsSchema]) {
      const plan = await initialize(null);
      await initialize(pool, { apply: true, targetDatabase: database, expectedSchemaSha256: plan.schemaSha256 });
    }
    const store = createMysqlAuthStore(pool, { localInvitations: true }); await store.ensureSchema();
    const ownerHash = digestToken(OWNER_EMAIL), recipientHash = digestToken(RECIPIENT_EMAIL);
    const ownerPasswordHash = await hashPassword(OWNER_PASSWORD);
    await store.atomic(async (tx) => {
      await tx.insertUser({ id: 'a'.repeat(32), username: 'inviting-owner', display_name: localUser.name, password_hash: ownerPasswordHash, owner_hash: ownerHash, role: 'owner', version: 1, disabled: false });
      await tx.saveSettings({ ...await tx.getSettings(), local_enabled: true, local_verified: true, google_enabled: false, bootstrap_consumed: true });
    });
    const baselineSettings = await store.getSettings();
    const github = await makeGithub({ repo: 'o/r', branch: 'live', files: repoFiles() }), oldHead = github.head;
    const realFetch = globalThis.fetch; let api, bridge, ownerContext, recipientContext;
    const fixture = await startSite((request, response) => api(request, response));
    const env = { ALLOWED_ORIGIN: fixture.origin, REPO: 'o/r', BRANCH: 'live', OWNERS: [ownerHash, recipientHash, digestToken(UNICODE_EMAIL), digestToken(FOLLOWUP_EMAIL)].join(','),
      GITHUB_TOKEN: 'isolated-invitation-provider-fixture', SESSION_SECRET: 'isolated-invitation-session-secret-at-least-32-bytes', CMS_STAGING: true,
      // Independent browser users share one loopback IP in this longer flow;
      // retain real MySQL admission and the unchanged per-account limit.
      RATE_LOGIN_PER_CLIENT: 30,
      DATA_STORE: createMysqlDataStore(pool), EDITORS: createMysqlKv(pool), RATE_LIMIT_STORE: createMysqlRateLimitStore(pool) };
    const config = { env, publicOrigin: fixture.origin, apiBasePath: '/cms-api', localAuthEnabled: true, localInvitationsEnabled: true, googleEnabled: false, readOnly: true, publishEnabled: false, staging: true };
    const auth = createLocalAuth({ store, config });
    bridge = createCmsServer({ env, publicOrigin: fixture.origin, basePath: config.apiBasePath, noIndex: true,
      handleRequest: runtimeHandler(config, (request, currentEnv) => auth.handle(request, currentEnv, worker.fetch)) });
    api = bridge.listeners('request')[0];
    globalThis.fetch = async (url, options) => {
      const response = await github.fetch(url, options);
      if (!response) throw new Error('External provider call blocked by invitation browser fixture');
      return response;
    };
    try {
      const owner = await open(browser, fixture); ownerContext = owner.context;
      await login(owner.page, fixture.origin); await settings(owner.page);
      await owner.page.locator('#auth-invitations').waitFor();
      assert.equal(await owner.page.locator('#auth-invitations select').count(), 0, 'no client-selected role');
      assert.equal(await owner.page.locator('#auth-invitation-form').getAttribute('method'), 'post');
      await createInvitation(owner.page); const invitation = await visibleInvitation(owner.page);
      assert.match(invitation.code, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(invitation.setupUrl, fixture.origin + '/cms-api/auth/invitation');
      for (const id of ['code', 'url']) {
        const input = owner.page.locator('#auth-invitation-' + id);
        assert.equal(await input.getAttribute('readonly'), ''); assert.equal(await input.getAttribute('name'), null); assert.equal(await input.getAttribute('value'), null);
      }
      await owner.page.locator('#auth-invitation-copy-code').click(); await owner.page.locator('#auth-invitation-copy-url').click();
      assert.deepEqual(await owner.page.evaluate(() => window.__invitationCopies), [invitation.code, invitation.setupUrl], 'explicit copy buttons keep code and URL separate');
      const row = await store.getInvitationByHash(digestToken(invitation.code));
      assert(row && !row.consumed && row.owner_hash === recipientHash && row.issuer_id === 'a'.repeat(32));
      assert(!JSON.stringify(row).includes(invitation.code), 'database stores only the invitation digest');
      await owner.page.locator('#auth-invitation-clear').click(); await emptyResult(owner.page);
      assert.equal((await store.getInvitationByHash(digestToken(invitation.code))).consumed, false, 'clearing presentation does not revoke the invitation');
      const recipient = await open(browser, fixture); recipientContext = recipient.context;
      const response = await recipient.page.goto(invitation.setupUrl);
      assert.equal(response.status(), 200); assert.equal(response.headers()['cache-control'], 'no-store');
      assert.match(response.headers()['content-security-policy'], /form-action 'none'/);
      await recipient.page.locator('#invitation-code').fill(invitation.code); await recipient.page.locator('#invitation-user').fill('invited-owner');
      await recipient.page.locator('#invitation-name').fill('מנהל מוזמן'); await recipient.page.locator('#invitation-password').fill(RECIPIENT_PASSWORD);
      await recipient.page.locator('#invitation-confirm').fill(RECIPIENT_PASSWORD);
      const acceptedRequests = () => fixture.audit.requests.filter((request) => request.path === '/cms-api/auth/invitations/accept').length;
      const beforeInvalid = acceptedRequests();
      await recipient.page.locator('#invitation-user').fill('invalid username'); await recipient.page.locator('#invitation-submit').click();
      await recipient.page.waitForFunction(() => Boolean(document.querySelector('#invitation-error')?.textContent));
      assert.equal(acceptedRequests(), beforeInvalid, 'invalid username is rejected before any POST');
      assert.equal(await recipient.page.locator('#invitation-code').inputValue(), invitation.code, 'local validation preserves the code');
      assert.equal(await recipient.page.locator('#invitation-password').inputValue(), RECIPIENT_PASSWORD, 'local validation preserves the password');
      await recipient.page.locator('#invitation-user').fill('invited-owner'); await recipient.page.locator('#invitation-code').fill(randomToken());
      const rejected = recipient.page.waitForResponse((result) => new URL(result.url()).pathname === '/cms-api/auth/invitations/accept');
      await recipient.page.locator('#invitation-submit').click(); assert.equal((await rejected).status(), 403);
      await recipient.page.waitForFunction(() => Boolean(document.querySelector('#invitation-error')?.textContent));
      for (const id of ['code', 'password', 'confirm']) assert.equal(await recipient.page.locator('#invitation-' + id).inputValue(), '', 'a submitted rejection clears secrets');
      assert.equal(await store.getUserByUsername('invited-owner'), null);
      await recipient.page.locator('#invitation-code').fill(invitation.code); await recipient.page.locator('#invitation-password').fill(RECIPIENT_PASSWORD);
      await recipient.page.locator('#invitation-confirm').fill(RECIPIENT_PASSWORD);
      await recipient.page.locator('#invitation-submit').click(); await recipient.page.locator('#invitation-success:not([hidden])').waitFor();
      assert.equal((await recipient.context.cookies()).length, 0, 'acceptance creates no session');
      for (const id of ['code', 'password', 'confirm']) assert.equal(await recipient.page.locator('#invitation-' + id).inputValue(), '');
      const created = await store.getUserByUsername('invited-owner');
      assert.equal(created.owner_hash, recipientHash); assert.equal(created.role, 'owner'); assert.match(created.password_hash, /^scrypt\$v1\$/);
      assert(!created.password_hash.includes(RECIPIENT_PASSWORD)); assert.equal((await store.getInvitationByHash(digestToken(invitation.code))).consumed, true);
      const replay = await realFetch(invitation.setupUrl.replace('/auth/invitation', '/auth/invitations/accept'), { method: 'POST', headers: { Origin: fixture.origin, 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: invitation.code, username: 'replay-owner', displayName: 'ניסיון חוזר', password: RECIPIENT_PASSWORD }) });
      assert.equal(replay.status, 403); await replay.arrayBuffer(); assert.equal(await store.getUserByUsername('replay-owner'), null);
      await recipient.page.locator('#invitation-login').click();
      await recipient.page.locator('#local-login:not([hidden])').waitFor(); await recipient.page.locator('#local-user').fill('invited-owner');
      await recipient.page.locator('#local-password').fill(RECIPIENT_PASSWORD); await recipient.page.locator('#local-signin').click();
      await recipient.page.locator('#app:not([hidden])').waitFor(); assert.equal(await recipient.page.locator('#who').textContent(), 'מנהל מוזמן');
      assert.match(await recipient.page.locator('#preview-state').textContent(), /קריאה בלבד/);
      const cookie = (await recipient.context.cookies()).find((item) => item.name === '__Host-heichal_local');
      assert(cookie?.httpOnly && cookie.secure && cookie.sameSite === 'Strict');
      const writeStatus = await recipient.page.evaluate(async () => (await fetch('/cms-api/publish', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status);
      assert.equal(writeStatus, 503, 'the invited owner cannot enable content publication');
      await unicodePasswordFlow(browser, fixture, owner.page, store);
      assert.equal((await store.getUserByUsername('inviting-owner')).password_hash, ownerPasswordHash);
      assert.deepEqual(await store.getSettings(), baselineSettings, 'bootstrap and provider settings remain unchanged');
      const [[counts]] = await pool.query('SELECT (SELECT COUNT(*) FROM drafts) AS drafts, (SELECT COUNT(*) FROM media) AS media, (SELECT COUNT(*) FROM editors_kv) AS editors, (SELECT COUNT(*) FROM log) AS log');
      assert.deepEqual(Object.values(counts).map(Number), [0, 0, 0, 0]); assert.equal(github.head, oldHead);
      for (const page of [owner.page, recipient.page]) await privateBrowserState(page, fixture.audit, [OWNER_PASSWORD, RECIPIENT_PASSWORD, invitation.code]);
      console.log('PASS real Chromium/MySQL: separate owner/recipient contexts, invitation creation, digest storage, clear without revocation, invalid input stays local, rejected submission clears secrets, one-shot acceptance, scrypt password, no automatic session, recipient login, readonly content and unchanged bootstrap/providers');
    } finally {
      await ownerContext?.close(); await recipientContext?.close(); globalThis.fetch = realFetch; await fixture.close(); bridge.closeAllConnections();
    }
  });
}

async function unicodePasswordFlow(browser, fixture, ownerPage, store) {
  for (const value of [UNICODE_PASSWORD, UNICODE_REPLACEMENT]) {
    assert(value.length > 128 && value.length <= 256, 'regression input crosses 128 UTF-16 units');
    assert([...value].length <= 128 && Buffer.byteLength(value, 'utf8') <= 512, 'regression input remains within the actual backend policy');
  }
  await createInvitation(ownerPage, UNICODE_EMAIL); const invitation = await visibleInvitation(ownerPage);
  const { context, page } = await open(browser, fixture);
  try {
    await page.goto(invitation.setupUrl);
    await page.locator('#invitation-code').fill(invitation.code); await page.locator('#invitation-user').fill('unicode-owner');
    await page.locator('#invitation-name').fill('מנהל יוניקוד');
    await typeCompletePassword(page, '#invitation-password', UNICODE_PASSWORD);
    await typeCompletePassword(page, '#invitation-confirm', UNICODE_PASSWORD);
    const accepted = page.waitForResponse((response) => new URL(response.url()).pathname === '/cms-api/auth/invitations/accept');
    await page.locator('#invitation-submit').click(); assert.equal((await accepted).status(), 201);
    await page.locator('#invitation-success:not([hidden])').waitFor(); assert.equal((await context.cookies()).length, 0);
    const created = await store.getUserByUsername('unicode-owner');
    assert.equal(created.owner_hash, digestToken(UNICODE_EMAIL)); assert.match(created.password_hash, /^scrypt\$v1\$/);
    assert.equal((await store.getInvitationByHash(digestToken(invitation.code))).consumed, true);
    await page.locator('#invitation-login').click(); await page.locator('#local-login:not([hidden])').waitFor();
    await page.locator('#local-user').fill('unicode-owner'); await typeCompletePassword(page, '#local-password', UNICODE_PASSWORD);
    const loggedIn = page.waitForResponse((response) => new URL(response.url()).pathname === '/cms-api/auth/login');
    await page.locator('#local-signin').click(); assert.equal((await loggedIn).status(), 200); await page.locator('#app:not([hidden])').waitFor();
    assert.equal(await page.locator('#who').textContent(), 'מנהל יוניקוד');
    const cookie = async () => (await context.cookies()).find((item) => item.name === '__Host-heichal_local');
    const initialCookie = await cookie(); assert(initialCookie?.secure && initialCookie.httpOnly && initialCookie.sameSite === 'Strict');
    await settings(page); await typeCompletePassword(page, '#auth-method-password', UNICODE_PASSWORD);
    const saved = page.waitForResponse((response) => new URL(response.url()).pathname === '/cms-api/auth/settings' && response.request().method() === 'PUT');
    await page.locator('#auth-methods button[type="submit"]').click(); assert.equal((await saved).status(), 200);
    await page.getByText('דרכי הכניסה נשמרו.', { exact: true }).waitFor();
    const settingsCookie = await cookie(); assert(settingsCookie.value !== initialCookie.value, 'fresh settings reauthentication rotates the local cookie');
    assert.equal(await store.getSession(digestToken(initialCookie.value)), null);
    await typeCompletePassword(page, '#auth-password-currentPassword', UNICODE_PASSWORD);
    await typeCompletePassword(page, '#auth-password-newPassword', UNICODE_REPLACEMENT);
    await typeCompletePassword(page, '#auth-password-confirmation', UNICODE_REPLACEMENT);
    const changed = page.waitForResponse((response) => new URL(response.url()).pathname === '/cms-api/auth/password');
    await page.locator('#auth-password-change button[type="submit"]').click(); assert.equal((await changed).status(), 200);
    await page.getByText('הסיסמה הוחלפה. שאר ההתחברויות לחשבון הסתיימו.', { exact: true }).waitFor();
    const updated = await store.getUserByUsername('unicode-owner');
    assert.equal(updated.version, created.version + 1); assert(updated.password_hash !== created.password_hash); assert.match(updated.password_hash, /^scrypt\$v1\$/);
    assert.equal(await store.getSession(digestToken(settingsCookie.value)), null, 'password change revokes the prior session');
    await page.locator('#out').click(); await page.locator('#login:not([hidden])').waitFor();
    await page.locator('#local-user').fill('unicode-owner'); await typeCompletePassword(page, '#local-password', UNICODE_REPLACEMENT);
    const relogged = page.waitForResponse((response) => new URL(response.url()).pathname === '/cms-api/auth/login');
    await page.locator('#local-signin').click(); assert.equal((await relogged).status(), 200); await page.locator('#app:not([hidden])').waitFor();
    await settings(page); await page.locator('#auth-invitation-email').fill(FOLLOWUP_EMAIL);
    await typeCompletePassword(page, '#auth-invitation-password', UNICODE_REPLACEMENT);
    const issued = page.waitForResponse((response) => new URL(response.url()).pathname === '/cms-api/auth/invitations');
    await page.locator('#auth-invitation-submit').click(); assert.equal((await issued).status(), 201);
    assert.equal(await page.locator('#auth-invitation-password').inputValue(), '');
    const next = await visibleInvitation(page), row = await store.getInvitationByHash(digestToken(next.code));
    assert(row && !row.consumed && row.owner_hash === digestToken(FOLLOWUP_EMAIL) && row.issuer_id === created.id && row.issuer_version === updated.version,
      'changed Unicode password authorizes an invitation only for the newly preconfigured owner');
    assert.match(await page.locator('#preview-state').textContent(), /קריאה בלבד/);
    await privateBrowserState(page, fixture.audit, [UNICODE_PASSWORD, UNICODE_REPLACEMENT, invitation.code, next.code]);
    console.log('PASS real Unicode passwords: browser-typed values above 128 UTF-16 units survive invitation acceptance, login, fresh settings reauthentication, password change, changed-password login and invitation reauthentication through Node/MySQL');
  } finally { await context.close(); }
}

async function contractFixture(options = {}) {
  let session = null, sequence = 0;
  const state = { capability: true, method: 'local', owner: true, delay: null, reply: null, logoutDelay: null, ...options };
  const fixture = await startSite(async (request, response, origin) => {
    const path = new URL(request.url, origin).pathname;
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length && request.headers['content-type']?.includes('application/json') ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const user = { ...localUser, owner: state.owner, publisher: state.owner };
    if (path === '/cms-api/auth/options') return json(response, { localEnabled: true, googleEnabled: Boolean(state.bearer), settingsAvailable: true, readOnly: true, publishEnabled: false });
    if (path === '/cms-api/auth/login') {
      assert(body.username === 'inviting-owner' && body.password === OWNER_PASSWORD, 'fixture login credentials');
      session = { id: 'fixture-' + (++sequence), csrf: 'c'.repeat(43) };
      response.setHeader('Set-Cookie', `__Host-invitation_fixture=${session.id}; Path=/; Secure; HttpOnly; SameSite=Strict`);
      return json(response, { user, method: 'local', csrfToken: session.csrf });
    }
    const cookie = session && (request.headers.cookie || '').includes('__Host-invitation_fixture=' + session.id);
    const bearer = request.headers.authorization === 'Bearer fixture-bearer';
    if (!cookie && !bearer) return json(response, { message: 'צריך להתחבר מחדש' }, 401);
    if (path === '/cms-api/auth/session') return cookie ? json(response, { user, method: 'local', csrfToken: session.csrf }) : json(response, { message: 'no cookie session' }, 401);
    if (path === '/cms-api/auth/logout') {
      if (state.logoutDelay) await state.logoutDelay.promise;
      session = null; response.setHeader('Set-Cookie', '__Host-invitation_fixture=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0'); return json(response, { loggedOut: true });
    }
    if (path === '/cms-api/auth/settings') return json(response, { localEnabled: true, googleEnabled: false, googleAvailable: Boolean(state.googleSetup),
      canDisableLocal: false, canDisableGoogle: false, username: 'inviting-owner', method: state.method,
      ...(state.googleSetup ? { googleSetup: { origin, clientId: '', activeClientId: '', activeVersion: 0, revision: 0, pending: false, verified: false,
        pendingExpiresAt: null, verifiedUntil: null, configurable: true, activationAllowed: true } } : {}),
      ...(state.capability === undefined ? {} : { invitationsAvailable: state.capability }) });
    if (path === '/cms-api/auth/invitations') {
      if (request.method !== 'POST' || !request.headers['content-type']?.includes('application/json')) return json(response, { message: 'fixture requires JSON POST' }, 415);
      assert.deepEqual(Object.keys(body).sort(), ['currentPassword', 'email']);
      assert(body.currentPassword === OWNER_PASSWORD && body.email === RECIPIENT_EMAIL, 'invitation carries only the requested email and fresh password');
      assert.equal(request.headers['x-csrf-token'], session.csrf);
      const invitation = { code: randomToken(), expiresAt: Date.now() + 600000, setupUrl: origin + '/cms-api/auth/invitation', ...state.reply };
      if (state.delay) { state.delay.started.resolve(); await state.delay.release.promise; }
      return json(response, invitation, 201);
    }
    if (path === '/cms-api/me') return json(response, user);
    if (path === '/cms-api/changes') return json(response, { changes: [] });
    if (path === '/cms-api/gh') return json(response, { permissions: { push: true } });
    if (path === '/cms-api/gh/contents/data/pages') return json(response, []);
    if (path === '/cms-api/gh/contents/data/topics.json') return json(response, { sha: 'fixture', content: Buffer.from('[]').toString('base64') });
    return json(response, { message: 'fixture path unavailable' }, 404);
  }, options);
  return { ...fixture, state };
}

async function browserContracts(browser) {
  const fixture = await contractFixture(); let context;
  try {
    let opened = await open(browser, fixture); context = opened.context; let page = opened.page;
    await login(page, fixture.origin); await settings(page);
    await createInvitation(page); const first = await visibleInvitation(page);
    await page.setViewportSize({ width: 320, height: 740 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'invitation panel fits a narrow screen');
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator('#auth-invitation-email').fill('changed-owner@example.test'); await emptyResult(page);
    await createInvitation(page); await visibleInvitation(page);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }))); await emptyResult(page);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    for (const action of ['clear', 'navigation', 'pagehide', 'logout']) {
      if (action !== 'clear') { await page.evaluate(() => { location.hash = '#/'; }); await settings(page); }
      const started = deferred(), release = deferred(); fixture.state.delay = { started, release };
      await createInvitation(page); await started.promise;
      const response = page.waitForResponse((result) => new URL(result.url()).pathname === '/cms-api/auth/invitations');
      if (action === 'clear') await page.locator('#auth-invitation-clear').click();
      if (action === 'navigation') await page.evaluate(() => { location.hash = '#/'; });
      if (action === 'pagehide') await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
      if (action === 'logout') {
        fixture.state.logoutDelay = deferred(); await page.locator('#out').click();
        assert.equal(await page.locator('#auth-invitation-code').inputValue(), '', 'logout click clears code before the logout response');
      }
      release.resolve(); await response; await page.waitForTimeout(80); fixture.state.delay = null;
      if (action === 'navigation') { await settings(page); await emptyResult(page); }
      else await emptyResult(page);
      if (action === 'pagehide') await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
      if (action === 'logout') { fixture.state.logoutDelay.resolve(); await page.locator('#login:not([hidden])').waitFor(); fixture.state.logoutDelay = null; }
    }
    await privateBrowserState(page, fixture.audit, [OWNER_PASSWORD, first.code]);
    await login(page, fixture.origin); await settings(page);
    fixture.state.reply = { expiresAt: Date.now() + 1200 }; await createInvitation(page); await visibleInvitation(page);
    await page.locator('#auth-invitation-result').waitFor({ state: 'hidden' }); await emptyResult(page);
    for (const reply of [{ code: 'bad-code' }, { expiresAt: 1 }, { expiresAt: '9999999999999' }, { setupUrl: 'https://foreign.example.test/auth/invitation' }, { setupUrl: fixture.origin + '/cms-api/auth/invitation?code=forbidden' }]) {
      fixture.state.reply = reply; await createInvitation(page); await page.waitForFunction(() => Boolean(document.querySelector('#auth-invitation-error')?.textContent)); await emptyResult(page);
    }
    fixture.state.reply = null;
    await page.locator('#auth-invitation-email').fill(RECIPIENT_EMAIL); await page.locator('#auth-invitation-password').fill(OWNER_PASSWORD);
    const before = fixture.audit.requests.length;
    const blocked = await page.evaluate(() => new Promise((done) => {
      const timer = setTimeout(() => done(false), 2000);
      document.addEventListener('securitypolicyviolation', (event) => { if (event.effectiveDirective === 'form-action') { clearTimeout(timer); done(true); } }, { once: true });
      HTMLFormElement.prototype.submit.call(document.querySelector('#auth-invitation-form'));
    }));
    assert.equal(blocked, true, 'CSP blocks forced native submission even when JS handlers are bypassed');
    assert.equal(fixture.audit.requests.length, before, 'forced submit emits no network request with policy intact');
    await privateBrowserState(page, fixture.audit, [OWNER_PASSWORD, first.code]); await context.close(); context = null;
    for (const options of [{ capability: undefined }, { capability: false }, { capability: 'true' }, { capability: true, method: 'google' }, { capability: true, owner: false }, { capability: true, bearer: true }]) {
      Object.assign(fixture.state, { capability: true, method: 'local', owner: true, bearer: false, ...options });
      opened = await open(browser, fixture, options); context = opened.context; page = opened.page;
      if (options.bearer) { await page.goto(fixture.origin + '/admin/'); await page.locator('#app:not([hidden])').waitFor(); }
      else await login(page, fixture.origin);
      if (options.owner === false) { await page.evaluate(() => { location.hash = '#/auth'; }); await page.waitForTimeout(100); }
      else await settings(page);
      assert.equal(await page.locator('#auth-invitations').count(), 0, 'only an explicitly enabled local cookie owner sees invitation controls');
      await privateBrowserState(page, fixture.audit, [OWNER_PASSWORD]); await context.close(); context = null;
    }
    console.log('PASS invitation UI: capability/local-cookie-owner gating, narrow layout, separate copy controls, email/pagehide/expiry cleanup, delayed response cancellation on clear/navigation/pagehide/logout, malformed replies rejected, native submit blocked by CSP');
  } finally { await context?.close(); await fixture.close(); }

  const native = await contractFixture({ stripPolicy: true });
  try {
    const opened = await open(browser, native); context = opened.context; const page = opened.page;
    await login(page, native.origin); await settings(page);
    await page.locator('#auth-invitation-email').fill(RECIPIENT_EMAIL); await page.locator('#auth-invitation-password').fill(OWNER_PASSWORD);
    assert.equal(await page.locator('meta[http-equiv="Content-Security-Policy"]').count(), 0);
    const sent = page.waitForRequest((request) => request.isNavigationRequest() && new URL(request.url()).pathname === '/cms-api/auth/invitations');
    const rejected = page.waitForResponse((response) => response.request().isNavigationRequest() && new URL(response.url()).pathname === '/cms-api/auth/invitations');
    const navigated = page.waitForURL(native.origin + '/cms-api/auth/invitations', { waitUntil: 'load' });
    await page.evaluate(() => HTMLFormElement.prototype.submit.call(document.querySelector('#auth-invitation-form')));
    const request = await sent; assert.equal(request.method(), 'POST'); assert.equal(new URL(request.url()).search, '');
    assert(request.postData()?.includes('currentPassword='), 'without CSP, the explicit POST keeps credentials in the body');
    assert.equal((await rejected).status(), 415, 'the contract fixture refuses a native form body');
    await navigated; await privateBrowserState(page, native.audit, [OWNER_PASSWORD]);
    console.log('PASS defense in depth: with CSP deliberately stripped, forced native invitation submission remains POST, is refused with 415, and never leaks credentials into URL/history/storage/logs');
  } finally { await context?.close(); await native.close(); }
}

async function googlePasswordFields(browser) {
  const fixture = await contractFixture({ googleSetup: true }); let context;
  try {
    const opened = await open(browser, fixture); context = opened.context; const page = opened.page;
    await login(page, fixture.origin); await settings(page); await page.locator('#auth-google-setup').waitFor();
    await typeCompletePassword(page, '#google-prepare-password', UNICODE_PASSWORD);
    // Reveal only the already-rendered activation control to exercise native
    // maxlength without a Google provider, proof callback or activation request.
    await page.locator('#google-activate').evaluate((form) => { form.hidden = false; });
    await typeCompletePassword(page, '#google-activate-password', UNICODE_REPLACEMENT);
    assert.equal(fixture.audit.requests.filter((request) => request.path.startsWith('/cms-api/auth/google/')).length, 0);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    for (const id of ['google-prepare-password', 'google-activate-password']) assert.equal(await page.locator('#' + id).inputValue(), '');
    await privateBrowserState(page, fixture.audit, [UNICODE_PASSWORD, UNICODE_REPLACEMENT]);
    console.log('PASS Unicode Google password controls: shipped prepare/activate inputs preserve complete browser-typed values and clear on pagehide; no provider or activation is invoked');
  } finally { await context?.close(); await fixture.close(); }
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium' });
try { await realBrowserFlow(browser); await browserContracts(browser); await googlePasswordFields(browser); }
finally { await browser.close(); }
