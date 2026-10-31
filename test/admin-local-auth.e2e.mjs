// Real Chromium exercises the shipped admin UI and private setup page against
// an isolated HTTP contract fixture. No real provider, database or credentials.
// Backend KDF/role/transaction security is covered separately by server tests.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { createRequire } from 'node:module';
import { renderAuthSetup } from '../server/auth-setup.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const site = resolve(new URL('../site/', import.meta.url).pathname);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
const nonce = 'private-setup-local-fixture-nonce';
const initialPassword = 'Local test password 123!';
let password = initialPassword, sequence = 0, active = null, googleEnabled = true, bootstrapCalls = 0;
let owner = true, origin, browser;
const seen = [], errors = [], external = [];
const user = () => ({ email: 'local:0123456789abcdef0123456789abcdef', name: 'מנהל בדיקה', owner, publisher: owner });
const json = (response, data, status = 200, headers = {}) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }); response.end(JSON.stringify(data)); };
const settings = () => ({ localEnabled: true, googleEnabled, canDisableLocal: false, canDisableGoogle: true, username: 'admin', method: 'local' });
function issue(response) {
  active = { id: 'test-cookie-' + (++sequence), csrf: 'c'.repeat(40) + sequence };
  response.setHeader('Set-Cookie', `__Host-ui_auth=${active.id}; Path=/; Secure; HttpOnly; SameSite=Strict`);
  return { user: user(), method: 'local', csrfToken: active.csrf };
}
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, origin), path = url.pathname;
    if (path === '/admin/config.json') return json(response, { repo: 'o/r', branch: 'live', worker: origin + '/cms-api', googleClientId: 'fixture-client' });
    if (path === '/admin/photos/index.json' || path === '/admin/pages/index.json') return json(response, []);
    if (path === '/admin/links.json') return json(response, { stats: { errors: 0, warnings: 0 }, suggestions: [] });
    if (path === '/cms-api/auth/setup') {
      response.writeHead(200, { 'Content-Type': 'text/html', 'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'`, 'Referrer-Policy': 'no-referrer' });
      return response.end(renderAuthSetup({ apiBasePath: '/cms-api', nonce }));
    }
    if (path.startsWith('/cms-api/')) {
      seen.push({ path, method: request.method, authorization: request.headers.authorization, csrf: request.headers['x-csrf-token'] });
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      const signedIn = active && (request.headers.cookie || '').split(';').some((part) => part.trim() === '__Host-ui_auth=' + active.id);
      const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
      if (path === '/cms-api/auth/options') return json(response, { localEnabled: true, googleEnabled, settingsAvailable: true, readOnly: true, publishEnabled: false });
      if (path === '/cms-api/auth/bootstrap') {
        bootstrapCalls++;
        assert.equal(body.code, 'one-time-private-test-code'); assert.equal(body.username, 'first-admin'); assert.equal(body.displayName, 'מנהל ראשון'); assert.equal(body.password, initialPassword);
        return json(response, { created: true }, 201);
      }
      if (path === '/cms-api/auth/login') {
        if (body.username !== 'admin' || body.password !== password) return json(response, { message: 'שם המשתמש או הסיסמה אינם נכונים.' }, 401);
        return json(response, issue(response));
      }
      if (!signedIn) return json(response, { message: 'צריך להתחבר מחדש' }, 401);
      if (mutation && request.headers['x-csrf-token'] !== active.csrf) return json(response, { message: 'csrf failed' }, 403);
      if (path === '/cms-api/auth/session') return json(response, { user: user(), method: 'local', csrfToken: active.csrf });
      if (path === '/cms-api/auth/logout') { active = null; response.setHeader('Set-Cookie', '__Host-ui_auth=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0'); return json(response, { loggedOut: true }); }
      if (path === '/cms-api/auth/settings') {
        if (!owner) return json(response, { message: 'אין הרשאה' }, 403);
        if (mutation) {
          assert.equal(body.currentPassword, password); assert.equal(body.localEnabled, true);
          googleEnabled = body.googleEnabled; return json(response, { ...settings(), ...issue(response) });
        }
        return json(response, settings());
      }
      if (path === '/cms-api/auth/password') {
        assert.equal(body.currentPassword, password); password = body.newPassword; return json(response, issue(response));
      }
      if (path === '/cms-api/me') return json(response, user());
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

async function open(dark = false) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: dark ? 'dark' : 'light', serviceWorkers: 'block' });
  await context.route('**/*', (route) => {
    const url = route.request().url();
    if (new URL(url).origin === origin) return route.continue();
    if (url === 'https://accounts.google.com/gsi/client') return route.fulfill({ contentType: 'text/javascript', body: 'window.google={accounts:{oauth2:{initTokenClient:function(){return {requestAccessToken:function(){}};}}}};' });
    external.push(url); return route.abort('blockedbyclient');
  });
  const page = await context.newPage(); page.on('pageerror', (error) => errors.push(String(error)));
  await page.goto(origin + '/admin/'); await page.locator('#local-login:not([hidden])').waitFor();
  return { page, context };
}
async function login(page, value = password) {
  await page.locator('#local-user').fill('admin'); await page.locator('#local-password').fill(value); await page.locator('#local-signin').click();
}
async function storage(page) {
  return page.evaluate(() => ({ local: Object.fromEntries(Object.entries(localStorage)), session: Object.fromEntries(Object.entries(sessionStorage)), cookies: document.cookie }));
}
function contrast(foreground, background) {
  const lum = (color) => color.match(/[\d.]+/g).slice(0, 3).map(Number).map((v) => v / 255).map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
  const a = lum(foreground), b = lum(background); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}
try {
  await new Promise((done) => server.listen(0, '127.0.0.1', done)); origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium' });
  for (const dark of [false, true]) {
    active = null; googleEnabled = true; password = initialPassword; owner = true;
    const { page, context } = await open(dark);
    await login(page, 'incorrect-password'); await page.getByText('שם המשתמש או הסיסמה אינם נכונים.', { exact: true }).waitFor();
    assert.equal(await page.locator('#local-password').inputValue(), '');
    await login(page); await page.locator('#app:not([hidden])').waitFor();
    assert.match(await page.locator('#preview-state').textContent(), /קריאה בלבד/);
    assert.equal(await page.locator('#who').textContent(), 'מנהל בדיקה');
    const firstSession = active.id;
    assert.equal((await storage(page)).cookies, '');
    assert.equal((await storage(page)).local['cms-token'], undefined); assert.equal((await storage(page)).session['cms-token'], undefined);
    await page.reload(); await page.locator('#app:not([hidden])').waitFor();
    assert.equal(active.id, firstSession, 'reload restores the existing HttpOnly cookie without logging in again');
    await page.locator('#nav a[href="#/auth"]').click(); await page.locator('#auth-methods').waitFor();
    assert.equal(await page.locator('#auth-local-enabled').isDisabled(), true, 'UI reflects server last-method guard');
    await page.locator('#auth-google-enabled').uncheck(); await page.locator('#auth-method-password').fill(password);
    await page.locator('#auth-methods button[type=submit]').click(); await page.getByText('דרכי הכניסה נשמרו.', { exact: true }).waitFor();
    assert.notEqual(active.id, firstSession, 'settings fixture rotates session');
    await page.locator('#auth-password-currentPassword').fill(password);
    await page.locator('#auth-password-newPassword').fill('Changed local test pass 456!');
    await page.locator('#auth-password-confirmation').fill('Another mismatching password!');
    await page.locator('#auth-password-change button[type=submit]').click(); await page.getByText('הסיסמאות החדשות אינן זהות.', { exact: true }).waitFor();
    await page.locator('#auth-password-confirmation').fill('Changed local test pass 456!');
    await page.locator('#auth-password-change button[type=submit]').click(); await page.getByText('הסיסמה הוחלפה. שאר ההתחברויות לחשבון הסתיימו.', { exact: true }).waitFor();
    assert.equal(await page.locator('#auth-password-newPassword').inputValue(), '');
    await page.setViewportSize({ width: 320, height: 740 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    const colors = await page.locator('#auth-password-change button[type=submit]').evaluate((node) => { const s = getComputedStyle(node); return { foreground: s.color, background: s.backgroundColor }; });
    assert(contrast(colors.foreground, colors.background) >= 4.5);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.locator('#out').click(); await page.locator('#login:not([hidden])').waitFor();
    assert.equal(active, null); assert.equal(await page.locator('#gbox').isHidden(), true);
    assert.equal(await page.locator('#main').textContent(), '');
    assert.equal(await page.locator('#preview-state').isHidden(), true);
    console.log(`PASS ${dark ? 'dark' : 'light'} password login, cookie reload, settings/password session rotation, CSRF, logout, readable320px layout`);
    await context.close();
  }
  owner = false; googleEnabled = true; active = null;
  const regular = await open(); await login(regular.page); await regular.page.locator('#app:not([hidden])').waitFor();
  assert.equal(await regular.page.locator('#nav a[href="#/auth"]').count(), 0);
  await regular.page.evaluate(() => { location.hash = '#/auth'; });
  assert.equal(await regular.page.locator('#auth-methods').count(), 0);
  await regular.context.close();
  const setupContext = await browser.newContext({ viewport: { width: 320, height: 740 }, serviceWorkers: 'block' });
  await setupContext.route('**/*', (route) => new URL(route.request().url()).origin === origin ? route.continue() : (external.push(route.request().url()), route.abort('blockedbyclient')));
  const setup = await setupContext.newPage(); setup.on('pageerror', (error) => errors.push(String(error)));
  await setup.goto(origin + '/cms-api/auth/setup');
  await setup.locator('#setup-code').fill('one-time-private-test-code'); await setup.locator('#setup-user').fill('first-admin');
  await setup.locator('#setup-name').fill('מנהל ראשון'); await setup.locator('#setup-password').fill(initialPassword); await setup.locator('#setup-confirm').fill(initialPassword);
  await setup.locator('#setup-submit').click(); await setup.locator('#setup-success:not([hidden])').waitFor();
  assert.equal(bootstrapCalls, 1); assert.equal(await setup.locator('#setup-password').inputValue(), ''); assert.equal(await setup.locator('#setup-code').inputValue(), '');
  assert.deepEqual(await storage(setup), { local: {}, session: {}, cookies: '' });
  assert.equal(new URL(setup.url()).search + new URL(setup.url()).hash, '');
  assert.equal(await setup.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  assert.equal(await setup.locator('#setup-login').getAttribute('href'), '/admin/');
  console.log('PASS owner-only settings and private setup: no auto-login, no secret URL/storage, password/code clear, no third parties');
  assert.equal(seen.filter((r) => r.authorization !== undefined).length, 0, 'cookie UI must never emit a fake bearer');
  assert(seen.filter((r) => ['PUT', 'POST'].includes(r.method) && !['/cms-api/auth/login', '/cms-api/auth/bootstrap'].includes(r.path)).every((r) => typeof r.csrf === 'string' && r.csrf.length >= 32));
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
} finally { await browser?.close(); server.closeAllConnections(); await new Promise((done) => server.close(done)); }
