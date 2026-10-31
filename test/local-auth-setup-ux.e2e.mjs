// Real browser setup-form UX regression. Deliberately fake fixture credentials;
// the loopback endpoint returns controlled responses and never accesses a DB.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { renderAuthSetup } from '../server/auth-setup.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const nonce = 'isolated-setup-ux-nonce-32-characters';
const fake = { code: 'Q'.repeat(43), password: 'Only fixture password never real 123!', username: 'fixture.owner', displayName: 'מנהל בדיקה' };
const posts = [], outsideRequests = [], pageErrors = [], requests = [];
let browser, origin, nextStatus = 400;
const server = createServer(async (request, response) => {
  const url = new URL(request.url, origin);
  const headers = { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'Referrer-Policy': 'no-referrer' };
  if (request.method === 'GET' && url.pathname === '/cms-api/auth/setup') {
    response.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'` });
    return response.end(renderAuthSetup({ apiBasePath: '/cms-api', nonce }));
  }
  if (request.method === 'POST' && url.pathname === '/cms-api/auth/bootstrap') {
    let data = '';
    for await (const chunk of request) data += chunk;
    posts.push({ method: request.method, path: url.pathname, query: url.search, headers: request.headers, body: JSON.parse(data) });
    response.writeHead(nextStatus, { ...headers, 'Content-Type': 'application/json' });
    return response.end(JSON.stringify(nextStatus === 201 ? { created: true } : {
      message: 'בדקו את השדות המסומנים ונסו שוב.', fieldErrors: { username: 'שם המשתמש צריך להכיל 3–64 תווים באנגלית.' },
    }));
  }
  response.writeHead(404, headers); response.end();
});

async function fill(page, overrides = {}) {
  const values = { ...fake, ...overrides };
  for (const [selector, value] of [
    ['#setup-code', values.code], ['#setup-user', values.username], ['#setup-name', values.displayName],
    ['#setup-password', values.password], ['#setup-confirm', values.password],
  ]) await page.locator(selector).fill(value);
}
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium' });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.route('**/*', async (route) => {
    if (new URL(route.request().url()).origin !== origin) { outsideRequests.push(true); return route.abort('blockedbyclient'); }
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', () => pageErrors.push(true));
  page.on('request', (request) => requests.push({ method: request.method(), path: new URL(request.url()).pathname, query: new URL(request.url()).search }));
  await page.goto(origin + '/cms-api/auth/setup');
  assert.equal(await page.locator('#setup-submit').isEnabled(), true);
  assert.equal(await page.locator('#setup-form').evaluate((form) => form.noValidate), true);
  await fill(page, { username: 'owner@example.invalid' });
  await page.locator('#setup-submit').click();
  assert.equal(posts.length, 0);
  assert.equal(await page.locator('#setup-user').evaluate((field) => document.activeElement === field), true);
  assert.equal(await page.locator('#setup-user').getAttribute('aria-invalid'), 'true');
  assert.match(await page.locator('#username-error').innerText(), /3–64/);
  assert.match(await page.locator('#setup-error').innerText(), /לא נשלחו/);
  assert.equal(await page.locator('#setup-code').inputValue(), fake.code);
  assert.equal(await page.locator('#setup-password').inputValue(), fake.password);
  assert.equal(await page.locator('#setup-confirm').inputValue(), fake.password);
  assert.match(await page.locator('#setup-user').getAttribute('aria-describedby'), /username-error/);

  // A server-side public validation failure has the same accessible field
  // affordance, but the dispatched attempt must clear credentials explicitly.
  await page.locator('#setup-user').fill('  Fixture.Owner  ');
  await Promise.all([
    page.waitForResponse((response) => response.url() === origin + '/cms-api/auth/bootstrap'),
    page.locator('#setup-submit').click(),
  ]);
  await page.locator('#setup-retry').waitFor({ state: 'visible' });
  assert.equal(posts.length, 1); assert.equal(posts[0].body.username, fake.username);
  assert.equal(posts[0].body.password, fake.password); assert.equal(posts[0].body.code, fake.code);
  assert.equal(posts[0].headers.origin, origin); assert.equal(posts[0].headers.referer, undefined);
  assert.equal(posts[0].query, ''); assert.equal(posts[0].method, 'POST');
  for (const id of ['setup-code', 'setup-password', 'setup-confirm']) assert.equal(await page.locator('#' + id).inputValue(), '');
  assert.equal(await page.locator('#setup-user').evaluate((field) => document.activeElement === field), true);
  assert.match(await page.locator('#setup-retry').innerText(), /הקוד המקורי.*בתוקף ולא נוצל/);
  await page.locator('#setup-submit').click();
  assert.equal(posts.length, 1, 'missing credentials are stopped locally after a failed submitted attempt');
  assert.equal(await page.locator('#setup-code').evaluate((field) => document.activeElement === field), true);
  assert.match(await page.locator('#code-error').innerText(), /יש להזין/);

  // HTML maxlength uses UTF-16 units; a supported 128-codepoint password and
  // 40-codepoint name must reach the server intact, not get truncated by input.
  nextStatus = 201;
  await fill(page, { password: '🔐'.repeat(128), displayName: '🗝️'.repeat(20) });
  assert.equal(await page.locator('#setup-password').inputValue(), '🔐'.repeat(128));
  await page.locator('#setup-submit').click();
  await page.locator('#setup-success').waitFor({ state: 'visible' });
  assert.equal(posts.length, 2); assert.equal(posts[1].body.password, '🔐'.repeat(128));
  assert.equal(posts[1].body.displayName, '🗝️'.repeat(20));
  assert.equal(await page.locator('#setup-form').isHidden(), true);
  assert.equal(await page.locator('#setup-password').inputValue(), '');
  assert.equal(await page.locator('#setup-code').inputValue(), '');
  assert.equal(await page.locator('#setup-success').evaluate((field) => document.activeElement === field), true);
  assert.equal(await page.locator('#setup-login').isVisible(), true);
  assert.equal(new URL(page.url()).search, '');
  assert.deepEqual(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })), { local: 0, session: 0 });
  assert(!requests.some((request) => request.query));
  assert(!requests.some((request) => request.method === 'GET' && request.path === '/cms-api/auth/bootstrap'));
  assert.deepEqual(outsideRequests, []); assert.deepEqual(pageErrors, []);
  await context.close();
  console.log('PASS setup UX: client errors prevent POST and preserve inputs; submitted 400 clears secrets with accessible retry instructions.');
  console.log('PASS supported Unicode bounds, exact normalized POST, success reset, empty query/storage and no external requests.');
} finally {
  await browser?.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
}
