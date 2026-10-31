// Shipped admin UI in Chromium against an isolated contract fixture. GIS is a
// local script stub; no credentials, Google project, provider or host is used.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { createRequire } from 'node:module';

const { chromium } = createRequire(import.meta.url)('playwright');
const site = resolve(new URL('../site/', import.meta.url).pathname);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
const password = 'Isolated Google setup password!';
const staticClient = '111-static-must-not-be-used.apps.googleusercontent.com';
const firstClient = '222-first-test.apps.googleusercontent.com';
const secondClient = '333-second-test.apps.googleusercontent.com';
const legacyOrigin = 'https://fixture-google-legacy.workers.dev';
const user = { email: 'local:0123456789abcdef0123456789abcdef', name: 'מנהל בדיקה', owner: true, publisher: true };
let state, origin, browser, sequence = 0;
const seen = [], errors = [], external = [];
function reset(overrides = {}) {
  state = { session: null, managed: true, addon: true, googleEnabled: false, activeClientId: '', activeVersion: 0, revision: 0, pending: null,
    configurable: true, activationAllowed: true, discoveryFail: false, failOptionsAfterActivate: false, legacy: false, expiresIn: 300000, ...overrides };
}
const json = (response, data, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(data)); };
function settings() {
  return { localEnabled: true, googleEnabled: state.googleEnabled, googleAvailable: true, canDisableLocal: false, canDisableGoogle: true, username: 'admin', method: 'local',
    ...(state.addon ? { googleSetup: { origin, clientId: state.pending?.clientId || state.activeClientId, activeClientId: state.activeClientId,
      activeVersion: state.activeVersion, revision: state.revision, pending: !!state.pending, verified: !!state.pending?.verified,
      pendingExpiresAt: state.pending?.expiresAt || null, verifiedUntil: state.pending?.verifiedUntil || null,
      configurable: state.configurable, activationAllowed: state.activationAllowed } } : {}) };
}
function issue(response) {
  state.session = { id: 'fixture-cookie-' + (++sequence), csrf: 'c'.repeat(40) + sequence };
  response.setHeader('Set-Cookie', `__Host-wizard_fixture=${state.session.id}; Path=/; Secure; HttpOnly; SameSite=Strict`);
  return { user, method: 'local', csrfToken: state.session.csrf };
}
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, origin), path = url.pathname;
    if (path === '/admin/config.json') return json(response, { repo: 'o/r', branch: 'live', worker: state.legacy ? legacyOrigin : origin + '/cms-api', googleClientId: staticClient });
    if (path === '/admin/photos/index.json' || path === '/admin/pages/index.json') return json(response, []);
    if (path === '/admin/links.json') return json(response, { stats: { errors: 0, warnings: 0 }, suggestions: [] });
    if (path.startsWith('/cms-api/')) {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      seen.push({ path, method: request.method, search: url.search, body, authorization: request.headers.authorization, csrf: request.headers['x-csrf-token'] });
      if (path === '/cms-api/auth/options') {
        if (state.discoveryFail) return json(response, { message: 'fixture discovery unavailable' }, 503);
        return json(response, { localEnabled: true, googleEnabled: state.googleEnabled, settingsAvailable: true, readOnly: true, publishEnabled: false,
          googleManaged: state.managed, googleClientId: state.activeClientId, googleRevision: state.revision });
      }
      if (path === '/cms-api/auth/login') {
        assert.equal(body.username, 'admin'); assert.equal(body.password, password); return json(response, issue(response));
      }
      if (path === '/cms-api/session') {
        assert.match(body.access_token, /^fixture-access-/);
        return json(response, { token: 'fixture-google-session', email: 'google-owner@example.test', owner: true });
      }
      const signedIn = state.session && (request.headers.cookie || '').split(';').some((part) => part.trim() === '__Host-wizard_fixture=' + state.session.id);
      const googleSignedIn = request.headers.authorization === 'Bearer fixture-google-session';
      if (!signedIn && !googleSignedIn) return json(response, { message: 'צריך להתחבר מחדש' }, 401);
      if (signedIn && !['GET', 'HEAD', 'OPTIONS'].includes(request.method)) assert.equal(request.headers['x-csrf-token'], state.session.csrf);
      if (path === '/cms-api/auth/session') return json(response, { user, method: 'local', csrfToken: state.session.csrf });
      if (path === '/cms-api/auth/logout') { state.session = null; response.setHeader('Set-Cookie', '__Host-wizard_fixture=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0'); return json(response, { loggedOut: true }); }
      if (path === '/cms-api/auth/settings') return json(response, settings());
      if (path === '/cms-api/auth/google/prepare') {
        assert(state.configurable); assert.equal(body.currentPassword, password); assert.equal(typeof body.clientId, 'string');
        state.revision++; state.pending = { clientId: body.clientId, nonce: 'fixture-nonce-' + state.revision, revision: state.revision, expiresAt: Date.now() + state.expiresIn };
        return json(response, state.pending);
      }
      if (path === '/cms-api/auth/google/verify') {
        assert(state.pending); assert.equal(body.revision, state.pending.revision); assert.equal(body.credential, 'fixture-ID-proof-' + state.pending.nonce);
        state.revision++; state.pending = { ...state.pending, verified: true, revision: state.revision, verifiedUntil: Date.now() + 300000 };
        return json(response, { verified: true, clientId: state.pending.clientId, revision: state.revision, verifiedUntil: state.pending.verifiedUntil });
      }
      if (path === '/cms-api/auth/google/activate') {
        assert(state.activationAllowed); assert(state.pending?.verified); assert.equal(body.revision, state.revision); assert.equal(body.currentPassword, password);
        state.googleEnabled = true; state.activeClientId = state.pending.clientId; state.activeVersion++; state.revision++; state.pending = null;
        if (state.failOptionsAfterActivate) state.discoveryFail = true;
        return json(response, { activated: true, clientId: state.activeClientId, googleRevision: state.revision });
      }
      if (path === '/cms-api/me') return json(response, googleSignedIn ? { ...user, email: 'google-owner@example.test' } : user);
      if (path === '/cms-api/changes') return json(response, { changes: [] });
      if (path === '/cms-api/gh') return json(response, { permissions: { push: true } });
      if (path === '/cms-api/gh/contents/data/pages') return json(response, []);
      if (path === '/cms-api/gh/contents/data/topics.json') return json(response, { sha: 'fixture-sha', content: Buffer.from('[]').toString('base64') });
      return json(response, { message: 'fixture path not implemented' }, 404);
    }
    const file = resolve(site, '.' + (path === '/admin/' ? '/admin/index.html' : path));
    if (!file.startsWith(site + sep)) { response.writeHead(403); return response.end(); }
    try { const bytes = await readFile(file); response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' }); response.end(bytes); }
    catch { response.writeHead(404); response.end(); }
  } catch (error) { errors.push(String(error)); if (!response.headersSent) json(response, { message: 'fixture error' }, 500); else response.end(); }
});
const sdk = `
window.__gis = { ids: [], oauth: [], renders: [], prompts: 0, tokens: [] };
window.google = { accounts: {
 id: { initialize: function(options) { window.__gis.ids.push(options); },
   renderButton: function(container, options) {
     window.__gis.renders.push(options);
     var init = window.__gis.ids[window.__gis.ids.length - 1];
     var button = document.createElement('button'); button.type = 'button';
     button.textContent = 'Fixture official Google button'; button.dataset.fixtureGoogle = 'true';
     button.addEventListener('click', function() { init.callback({ credential: 'fixture-ID-proof-' + init.nonce }); });
     container.append(button);
   }, cancel: function() {}, prompt: function() { window.__gis.prompts++; } },
 oauth2: { initTokenClient: function(options) {
   window.__gis.oauth.push(options);
   return { requestAccessToken: function() { window.__gis.tokens.push(options); } };
 } }
} };
`;
async function open(overrides = {}, dark = false) {
  reset(overrides);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: dark ? 'dark' : 'light', serviceWorkers: 'block' });
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (new URL(url).origin === origin) return route.continue();
    if (url === 'https://accounts.google.com/gsi/client') return route.fulfill({ contentType: 'text/javascript', body: sdk });
    if (new URL(url).origin === legacyOrigin) {
      const path = new URL(url).pathname; seen.push({ path: 'legacy:' + path, method: route.request().method() });
      const data = path === '/session' ? { token: 'legacy-token', owner: true, email: 'legacy@example.test' } : path === '/me' ? user : path === '/changes' ? { changes: [] } : path === '/gh' ? { permissions: { push: true } } : path === '/gh/contents/data/topics.json' ? { content: Buffer.from('[]').toString('base64') } : [];
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
    }
    external.push(url); return route.abort('blockedbyclient');
  });
  const page = await context.newPage(); page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(origin + '/admin/');
  return { page, context };
}
async function login(page) {
  await page.locator('#local-login:not([hidden])').waitFor();
  await page.locator('#local-user').fill('admin'); await page.locator('#local-password').fill(password); await page.locator('#local-signin').click();
  await page.locator('#app:not([hidden])').waitFor();
}
async function settingsPage(page) {
  await page.locator('#nav a[href="#/auth"]').click(); await page.locator('#auth-google-setup').waitFor();
}
async function prepare(page, clientId = firstClient) {
  await page.locator('#google-client-id').fill(clientId); await page.locator('#google-prepare-password').fill(password); await page.locator('#google-prepare-submit').click();
  await page.locator('[data-fixture-google]').waitFor();
}
async function verify(page) {
  await page.locator('[data-fixture-google]').click(); await page.locator('#google-activate:not([hidden])').waitFor();
}
async function activate(page) {
  const refreshed = page.waitForResponse((response) => new URL(response.url()).pathname === '/cms-api/auth/settings' && response.request().method() === 'GET');
  await page.locator('#google-activate-password').fill(password); await page.locator('#google-activate-submit').click();
  await refreshed;
}
async function proofCount(page) { return page.evaluate(() => window.__gis?.ids.length || 0); }
const count = (path) => seen.filter((request) => request.path === '/cms-api/auth/google/' + path).length;
async function assertSecretsAbsent(page) {
  const values = await page.evaluate(() => ({ storage: JSON.stringify([Object.fromEntries(Object.entries(localStorage)), Object.fromEntries(Object.entries(sessionStorage))]), url: location.href }));
  for (const value of [password, 'fixture-nonce-', 'fixture-ID-proof-']) {
    assert(!values.storage.includes(value)); assert(!values.url.includes(value));
  }
  assert(seen.filter((request) => request.path.startsWith('/cms-api/auth/')).every((request) => !request.search), 'authentication requests never use query strings');
}
try {
  await new Promise((done) => server.listen(0, '127.0.0.1', done)); origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium' });
  {
    const { page, context } = await open(); await login(page); const session = state.session.id; await settingsPage(page);
    assert.equal(await page.locator('#google-setup-origin').inputValue(), origin); assert.equal(await page.locator('#google-setup-origin').getAttribute('readonly'), '');
    assert.equal(await page.locator('#auth-google-enabled').isChecked(), false); assert.equal(await page.locator('#auth-google-enabled').isDisabled(), true);
    assert.equal(await page.locator('#auth-local-enabled').isDisabled(), true);
    assert.equal(await page.locator('a[href="https://console.cloud.google.com/auth/clients"]').count(), 1);
    assert.equal(await page.locator('a[href="https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid"]').count(), 1);
    assert.equal(await page.locator('#google-prepare').getAttribute('method'), 'post');
    assert.match(await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content'), /form-action 'none'/);
    await page.setViewportSize({ width: 320, height: 740 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'initial wizard fits320px');
    await prepare(page);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'wizard with official button fits320px');
    await page.setViewportSize({ width: 1280, height: 900 });
    assert.equal(await page.locator('#google-prepare-password').inputValue(), '');
    assert.equal(state.googleEnabled, false); assert.equal(count('activate'), 0);
    const idOptions = await page.evaluate(() => { const x = window.__gis.ids.at(-1); return { client_id: x.client_id, nonce: x.nonce, ux_mode: x.ux_mode, auto_select: x.auto_select, button_auto_select: x.button_auto_select }; });
    assert.deepEqual(idOptions, { client_id: firstClient, nonce: state.pending.nonce, ux_mode: 'popup', auto_select: false, button_auto_select: false });
    assert.equal(await page.evaluate(() => window.__gis.prompts), 0, 'custom button must not invoke Google ID prompt');
    await verify(page); assert.equal(state.googleEnabled, false); assert.equal(count('activate'), 0); assert.equal(state.session.id, session);
    assert.equal(await page.locator('#google-activate').getAttribute('method'), 'post');
    assert.equal(await page.locator('#google-activate-password').inputValue(), '', 'activation asks for a fresh password');
    await activate(page);
    await page.waitForFunction(() => document.querySelector('#auth-google-enabled')?.checked);
    assert.equal(state.activeClientId, firstClient); assert.equal(state.session.id, session); assert.equal(count('activate'), 1);
    assert.equal(await page.locator('#who').textContent(), user.name, 'Google proof does not switch local identity');
    await assertSecretsAbsent(page);
    await page.setViewportSize({ width: 320, height: 740 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'wizard fits320px');
    await page.emulateMedia({ colorScheme: 'dark' });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator('#out').click(); await page.locator('#login:not([hidden])').waitFor();
    await page.locator('#gsign:enabled').waitFor(); await page.locator('#gsign').click();
    assert.equal(await page.evaluate(() => window.__gis.oauth.at(-1).client_id), firstClient, 'ordinary login uses managed client only');
    assert.equal(await page.evaluate(() => performance.getEntriesByType('resource').filter((x) => x.name === 'https://accounts.google.com/gsi/client').length), 1, 'ID and OAuth share one SDK load');
    // A server revision/client change discovered through settings must replace
    // the cached token client and reject a callback captured before it changed.
    const oldIndex = await page.evaluate(() => window.__gis.tokens.length - 1);
    await page.evaluate(() => window.__gis.tokens.at(-1).error_callback({ type: 'popup_closed' }));
    await login(page); await settingsPage(page); await prepare(page, secondClient); await verify(page);
    await activate(page);
    await page.waitForFunction((client) => document.querySelector('#google-client-id')?.value === client, secondClient);
    const sessionsBefore = seen.filter((x) => x.path === '/cms-api/session').length;
    await page.evaluate((index) => window.__gis.tokens[index].callback({ access_token: 'fixture-access-stale-before-logout' }), oldIndex);
    await page.waitForTimeout(80);
    assert.equal(seen.filter((x) => x.path === '/cms-api/session').length, sessionsBefore, 'provider revision cancels callbacks even before logout');
    await page.locator('#out').click(); await page.locator('#login:not([hidden])').waitFor();
    await page.locator('#gsign:enabled').waitFor();
    await page.evaluate((index) => window.__gis.tokens[index].callback({ access_token: 'fixture-access-stale' }), oldIndex);
    await page.waitForTimeout(100);
    assert.equal(seen.filter((x) => x.path === '/cms-api/session').length, sessionsBefore, 'stale provider callback is discarded');
    await page.locator('#gsign').click();
    assert.equal(await page.evaluate(() => window.__gis.oauth.at(-1).client_id), secondClient, 'revised managed client replaces the cached provider');
    await page.evaluate(() => window.__gis.tokens.at(-1).callback({ access_token: 'fixture-access-current' }));
    await page.locator('#app:not([hidden])').waitFor();
    assert.equal(seen.filter((x) => x.path === '/cms-api/session').length, sessionsBefore + 1);
    console.log('PASS managed wizard: exact origin, supported GIS button, separate proof/activation, fresh passwords, unchanged local identity, shared SDK, provider revision and stale callback protection,320px light/dark');
    await context.close();
  }
  {
    const { page, context } = await open(); await login(page); await settingsPage(page); await prepare(page);
    const before = count('verify'); const oldProof = await proofCount(page);
    await page.locator('#google-client-id').fill(secondClient);
    await page.evaluate((index) => { const x = window.__gis.ids[index - 1]; x.callback({ credential: 'fixture-ID-proof-' + x.nonce }); }, oldProof);
    await page.waitForTimeout(80); assert.equal(count('verify'), before, 'editing cancels pending callback');
    assert.equal(await page.locator('[data-fixture-google]').count(), 0);
    await prepare(page); await page.locator('#google-setup-cancel').click();
    assert.equal(await page.locator('[data-fixture-google]').count(), 0);
    await prepare(page); const navProof = await proofCount(page);
    await page.evaluate(() => { location.hash = '#/'; }); await page.locator('#auth-google-setup').waitFor({ state: 'detached' });
    await page.evaluate((index) => { const x = window.__gis.ids[index - 1]; x.callback({ credential: 'fixture-ID-proof-' + x.nonce }); }, navProof);
    await page.waitForTimeout(80); assert.equal(count('verify'), before, 'navigation cancels pending callback');
    await settingsPage(page);
    for (let restore = 0; restore < 2; restore++) {
      await prepare(page); const hiddenProof = await proofCount(page);
      await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
      assert.equal(await page.locator('[data-fixture-google]').count(), 0, 'pagehide clears pending proof even after a back/forward restore');
      await page.evaluate((index) => { const x = window.__gis.ids[index - 1]; x.callback({ credential: 'fixture-ID-proof-' + x.nonce }); }, hiddenProof);
      await page.waitForTimeout(80); assert.equal(count('verify'), before, 'pagehide invalidates retained SDK callback');
      await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    }
    await prepare(page); const logoutProof = await proofCount(page);
    await page.locator('#out').click(); await page.locator('#login:not([hidden])').waitFor();
    await page.evaluate((index) => { const x = window.__gis.ids[index - 1]; x.callback({ credential: 'fixture-ID-proof-' + x.nonce }); }, logoutProof);
    await page.waitForTimeout(80); assert.equal(count('verify'), before, 'logout cancels pending callback');
    await assertSecretsAbsent(page); console.log('PASS edit, cancel, navigation, repeated pagehide/restore and logout invalidate pending Google proof'); await context.close();
  }
  {
    const { page, context } = await open({ expiresIn: 700 }); await login(page); await settingsPage(page); await prepare(page);
    const before = count('verify'), oldProof = await proofCount(page);
    await page.locator('[data-fixture-google]').waitFor({ state: 'detached' });
    await page.evaluate((index) => { const x = window.__gis.ids[index - 1]; x.callback({ credential: 'fixture-ID-proof-' + x.nonce }); }, oldProof);
    await page.waitForTimeout(80); assert.equal(count('verify'), before, 'expiry discards delayed credential');
    console.log('PASS pending expiry clears proof and suppresses delayed callback'); await context.close();
  }
  for (const limitation of [{ configurable: false }, { activationAllowed: false }]) {
    const { page, context } = await open(limitation); await login(page); await settingsPage(page);
    assert.equal(await page.locator('#auth-google-enabled').isDisabled(), true);
    if (!state.configurable) assert.equal(await page.locator('#google-prepare-submit:enabled').count(), 0);
    else {
      await prepare(page); await verify(page);
      assert.equal(await page.locator('#google-activate-submit:enabled').count(), 0, 'host ceiling prevents activation');
    }
    console.log('PASS setup respects ' + Object.keys(limitation)[0]); await context.close();
  }
  {
    const { page, context } = await open({ discoveryFail: true }); await page.locator('#auth-discovery-retry').waitFor();
    assert.equal(await page.locator('#gbox').isHidden(), true); assert.equal(await page.locator('#local-login').isHidden(), true);
    assert.equal(await page.evaluate(() => !!window.__gis), false, 'same-origin discovery failure must never load fallback Google');
    state.discoveryFail = false; await page.locator('#auth-discovery-retry').click(); await page.locator('#local-login:not([hidden])').waitFor();
    await login(page); await page.locator('#app:not([hidden])').waitFor();
    console.log('PASS failed same-origin discovery closes sign-in and offers recovery without static fallback'); await context.close();
  }
  {
    const { page, context } = await open({ googleEnabled: true, activeClientId: firstClient, failOptionsAfterActivate: true });
    await page.locator('#gsign:enabled').waitFor(); await page.locator('#gsign').click();
    assert.equal(await page.evaluate(() => window.__gis.oauth.at(-1).client_id), firstClient);
    await page.evaluate(() => window.__gis.tokens.at(-1).error_callback({ type: 'popup_closed' }));
    await login(page); const session = state.session.id; await settingsPage(page); await prepare(page, secondClient); await verify(page);
    await page.locator('#google-activate-password').fill(password); await page.locator('#google-activate-submit').click();
    await page.waitForFunction(() => document.querySelector('#google-setup-error')?.textContent === 'fixture discovery unavailable');
    assert.equal(state.activeClientId, secondClient, 'server activation succeeds before discovery fails');
    assert.equal(state.session.id, session, 'failed discovery does not replace the local session');
    assert.equal(await page.locator('#app').isVisible(), true); assert.equal(await page.locator('#who').textContent(), user.name);
    assert.match(await page.locator('#preview-state').textContent(), /קריאה בלבד/); assert.equal(await page.locator('#preview-state').isVisible(), true);
    assert.equal(await page.locator('#rename').isHidden(), true, 'existing read-only capabilities survive failed discovery');
    assert.equal(await page.locator('#google-activate-password').inputValue(), '');
    const oauthBefore = await page.evaluate(() => window.__gis.oauth.length);
    await page.locator('#out').click(); await page.locator('#auth-discovery-retry').waitFor();
    assert.equal(await page.locator('#local-login').isHidden(), true); assert.equal(await page.locator('#gbox').isHidden(), true);
    await page.evaluate(() => document.querySelector('#gsign').click());
    assert.equal(await page.evaluate(() => window.__gis.oauth.length), oauthBefore, 'failed refresh removes the stale Google provider');
    state.discoveryFail = false; await page.locator('#auth-discovery-retry').click();
    await page.locator('#local-login:not([hidden])').waitFor(); await page.locator('#gsign:enabled').waitFor();
    await page.locator('#gsign').click(); assert.equal(await page.evaluate(() => window.__gis.oauth.at(-1).client_id), secondClient);
    await page.evaluate(() => window.__gis.tokens.at(-1).error_callback({ type: 'popup_closed' }));
    await login(page); await page.locator('#app:not([hidden])').waitFor(); await assertSecretsAbsent(page);
    console.log('PASS post-activation discovery failure preserves local read-only session, blocks stale provider after logout and recovers the new client');
    await context.close();
  }
  {
    const { page, context } = await open({ googleEnabled: true, activeClientId: '' });
    await page.locator('#auth-discovery-retry').waitFor();
    assert.equal(await page.locator('#local-login').isHidden(), true);
    assert.equal(await page.locator('#gbox').isHidden(), true);
    assert.equal(await page.evaluate(() => !!window.__gis), false, 'missing managed client must never fall back to static config');
    console.log('PASS empty managed client fails closed without using static client ID'); await context.close();
  }
  {
    const { page, context } = await open({ managed: false, addon: false }); await login(page);
    await page.locator('#nav a[href="#/auth"]').click(); await page.locator('#auth-methods').waitFor();
    assert.equal(await page.locator('#auth-google-setup').count(), 0);
    assert.equal(await page.locator('#auth-google-enabled').isChecked(), false);
    assert.equal(await page.locator('#auth-google-enabled').isDisabled(), false, 'nonmanaged deployment retains existing Google toggle');
    console.log('PASS deployments without addon retain ordinary authentication settings'); await context.close();
  }
  {
    const { page, context } = await open({ legacy: true }); await page.locator('#gsign:enabled').waitFor();
    assert.equal(seen.some((x) => x.path === 'legacy:/auth/options'), false);
    await page.locator('#gsign').click(); assert.equal(await page.evaluate(() => window.__gis.oauth[0].client_id), staticClient);
    await page.evaluate(() => window.__gis.tokens.at(-1).callback({ access_token: 'fixture-access-legacy' }));
    await page.locator('#app:not([hidden])').waitFor();
    console.log('PASS legacy cross-origin Worker retains static OAuth flow without discovery'); await context.close();
  }
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
} finally { await browser?.close(); server.closeAllConnections(); await new Promise((done) => server.close(done)); }
