// Browser credential-form fallback regression, using the real Node auth
// handler and an armed read-only memory fixture. No DB/provider credentials.
// AUTH_FORM_EVIDENCE_DIR optionally saves a private, value-redacted report.
// AUTH_FORM_BASELINE_REF optionally reproduces the old renderer from a local
// Git ref. Current regression checks require neither Git nor that history.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createCmsServer } from '../server/http.mjs';
import { createLocalAuth } from '../server/local-auth.mjs';
import { digestToken } from '../server/local-auth-crypto.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
let baselineCommit = null, baselineRenderer = null;
if (process.env.AUTH_FORM_BASELINE_REF) {
  const gitOptions = { cwd: new URL('../', import.meta.url), encoding: 'utf8' };
  baselineCommit = execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${process.env.AUTH_FORM_BASELINE_REF}^{commit}`], gitOptions).trim();
  assert.match(baselineCommit, /^[a-f0-9]{40}$/);
  const baselineSource = execFileSync('git', ['show', `${baselineCommit}:server/auth-setup.mjs`], gitOptions);
  baselineRenderer = (await import('data:text/javascript;base64,' + Buffer.from(baselineSource).toString('base64'))).renderAuthSetup;
}
const FAKE = { code: 'Q'.repeat(43), username: 'isolated-form-user', displayName: 'בדיקת טופס', password: 'No real credential test only 123!' };
const ownerHash = 'b'.repeat(64), fixedTime = 1800000000000;
let storeWrites = 0, rateCalls = 0, browser, origin;
const settings = { id: 1, local_enabled: false, google_enabled: true, local_verified: false, google_verified_until: 0, bootstrap_hash: digestToken(FAKE.code), bootstrap_expires: fixedTime + 600_000, bootstrap_owner_hash: ownerHash, bootstrap_consumed: false };
const store = {
  getSettings: async () => structuredClone(settings),
  atomic: async () => { storeWrites++; throw new Error('Unexpected fixture mutation'); },
  getUserById: async () => null,
  getUserByUsername: async () => null,
  getSession: async () => null,
};
const observed = [], external = [], results = [];
const server = createServer();
let bridge;

function summarizeRequest(request) {
  const u = new URL(request.url());
  const data = request.postData() || '';
  const submitted = new URLSearchParams(data);
  return { method: request.method(), path: u.pathname, queryKeys: [...u.searchParams.keys()],
    credentialQuery: u.searchParams.get('code') === FAKE.code || u.searchParams.get('password') === FAKE.password,
    credentialBody: submitted.get('code') === FAKE.code && submitted.get('password') === FAKE.password,
    contentType: request.headers()['content-type'] || null, origin: request.headers().origin || null, isNavigation: request.isNavigationRequest() };
}
async function fill(page) {
  await page.locator('#setup-code').fill(FAKE.code);
  await page.locator('#setup-user').fill(FAKE.username);
  await page.locator('#setup-name').fill(FAKE.displayName);
  await page.locator('#setup-password').fill(FAKE.password);
  await page.locator('#setup-confirm').fill(FAKE.password);
}
async function fixturePage({ javaScriptEnabled, blockScript = false, removeFormAction = false, allowSameOriginReferrer = false } = {}) {
  const context = await browser.newContext({ javaScriptEnabled, serviceWorkers: 'block' });
  await context.route('**/*', async (route) => {
    if (new URL(route.request().url()).origin !== origin) { external.push(new URL(route.request().url()).origin); return route.abort('blockedbyclient'); }
    if (route.request().url() === origin + '/cms-api/auth/setup' && (blockScript || removeFormAction)) {
      const response = await route.fetch(), headers = { ...response.headers() };
      let policy = headers['content-security-policy'];
      if (blockScript) policy = policy.replace(/script-src [^;]+/, "script-src 'none'");
      if (removeFormAction) policy = policy.replace(/;\s*form-action [^;]+/, '');
      headers['content-security-policy'] = policy;
      if (allowSameOriginReferrer) {
        headers['referrer-policy'] = 'same-origin';
        const body = (await response.text()).replace('<meta name="referrer" content="no-referrer">', '<meta name="referrer" content="same-origin">');
        return route.fulfill({ response, headers, body });
      }
      return route.fulfill({ response, headers });
    }
    return route.continue();
  });
  const page = await context.newPage(), requests = [];
  page.on('request', (request) => { const entry = summarizeRequest(request); requests.push(entry); observed.push(entry); });
  await page.goto(origin + '/cms-api/auth/setup'); await fill(page);
  return { context, page, requests };
}
try {
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${server.address().port}`;
  const env = { OWNERS: ownerHash, ALLOWED_ORIGIN: origin, SESSION_SECRET: 'isolated-form-secret-never-production-32', RATE_LIMIT_STORE: async () => { rateCalls++; throw new Error('Unexpected limiter mutation'); } };
  const config = { env, publicOrigin: origin, apiBasePath: '/cms-api', googleEnabled: true, readOnly: true, publishEnabled: false, staging: true };
  const auth = createLocalAuth({ store, config, clock: () => fixedTime });
  bridge = createCmsServer({ env, publicOrigin: origin, basePath: '/cms-api', noIndex: true, handleRequest: (request, requestEnv) => auth.handle(request, requestEnv, async () => new Response(null, { status: 404 })) });
  const api = bridge.listeners('request')[0];
  server.on('request', (request, response) => {
    if (new URL(request.url, origin).pathname === '/baseline/auth/setup') {
      if (!baselineRenderer) { response.writeHead(404); return response.end(); }
      const nonce = 'baseline-nonce-isolated-fixture';
      response.writeHead(200, { 'Content-Type': 'text/html', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'` });
      return response.end(baselineRenderer({ apiBasePath: '/baseline', nonce }));
    }
    return api(request, response);
  });
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium' });

  // Baseline proof uses the original committed renderer, with JS disabled and
  // only deliberately fake fixture values. Do not log credential-bearing URLs.
  if (baselineRenderer) {
    const oldContext = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: 'block' });
    const oldPage = await oldContext.newPage(), oldRequests = [];
    oldPage.on('request', (request) => oldRequests.push(summarizeRequest(request)));
    await oldPage.goto(origin + '/baseline/auth/setup'); await fill(oldPage);
    assert.equal(await oldPage.locator('#setup-form').evaluate((form) => form.method), 'get');
    assert.equal(await oldPage.locator('#setup-submit').isDisabled(), false);
    await Promise.all([oldPage.waitForNavigation(), oldPage.locator('#setup-submit').click()]);
    const leaked = oldRequests.find((r) => r.method === 'GET' && r.credentialQuery);
    assert(leaked, 'selected old renderer must reproduce credential-bearing GET');
    results.push({ name: 'baseline-no-javascript', sourceCommit: baselineCommit, nativeSubmission: leaked, reproduced: true });
    await oldContext.close();
  }

  for (const mode of [{ name: 'javascript-disabled', javaScriptEnabled: false }, { name: 'script-blocked-by-csp', javaScriptEnabled: true, blockScript: true }]) {
    const { context, page, requests } = await fixturePage(mode);
    assert.equal(await page.locator('#setup-submit').isDisabled(), true);
    const form = await page.locator('#setup-form').evaluate((node) => ({ method: node.method, action: new URL(node.action).pathname }));
    assert.deepEqual(form, { method: 'post', action: '/cms-api/auth/bootstrap' });
    const before = requests.length;
    await page.locator('#setup-confirm').press('Enter'); await page.waitForTimeout(150);
    assert.equal(requests.length, before, 'disabled submit prevents implicit Enter submission');
    await page.evaluate(() => HTMLFormElement.prototype.submit.call(document.querySelector('#setup-form'))); await page.waitForTimeout(150);
    assert.equal(requests.length, before, 'form-action none blocks forced native navigation');
    assert.equal(new URL(page.url()).search, '');
    assert(!requests.some((r) => r.credentialQuery));
    results.push({ name: mode.name, submitDisabled: true, method: form.method, action: form.action, enterCreatedRequest: false, forcedNativeSubmitCreatedRequest: false, noCredentialQuery: true });
    await context.close();

    // Strip form-action to test the independent POST fallback. Chromium's
    // no-referrer navigation sends Origin:null, rejected403 before parsing.
    // The second deliberate fixture also permits a same-origin referrer so
    // a natural valid Origin reaches the actual JSON parser, which rejects400.
    for (const allowSameOriginReferrer of [false, true]) {
      const degraded = await fixturePage({ ...mode, removeFormAction: true, allowSameOriginReferrer });
      const beforeWrites = storeWrites, beforeRates = rateCalls;
      const [response] = await Promise.all([
        degraded.page.waitForResponse((r) => new URL(r.url()).pathname === '/cms-api/auth/bootstrap'),
        degraded.page.evaluate(() => HTMLFormElement.prototype.submit.call(document.querySelector('#setup-form'))),
      ]);
      const expected = allowSameOriginReferrer ? 400 : 403;
      assert.equal(response.status(), expected, allowSameOriginReferrer ? 'actual JSON parser rejects native URL-encoded body' : 'no-referrer native navigation has null Origin and is rejected');
      const submitted = degraded.requests.filter((r) => r.path === '/cms-api/auth/bootstrap');
      assert.equal(submitted.length, 1); assert.equal(submitted[0].method, 'POST'); assert.deepEqual(submitted[0].queryKeys, []);
      assert.equal(submitted[0].credentialQuery, false); assert.equal(submitted[0].credentialBody, true);
      assert.equal(submitted[0].origin, allowSameOriginReferrer ? origin : 'null');
      assert.match(submitted[0].contentType, /^application\/x-www-form-urlencoded/);
      assert.equal(storeWrites, beforeWrites); assert.equal(rateCalls, beforeRates);
      results.push({ name: mode.name + (allowSameOriginReferrer ? '-form-policy-and-referrer-degraded' : '-form-policy-stripped'), nativeSubmission: submitted[0], responseStatus: response.status(), rateMutations: rateCalls - beforeRates, storeMutations: storeWrites - beforeWrites });
      await degraded.context.close();
    }
  }
  assert(!observed.some((r) => r.credentialQuery)); assert.equal(storeWrites, 0); assert.equal(rateCalls, 0); assert.deepEqual(external, []);
  const report = { format: 'heichal-credential-form-fallback-browser-v1', testedAt: new Date().toISOString(), productionAccess: false, credentials: 'deliberately fake fixture values only; values omitted from evidence', browser: await browser.version(), results, canonicalRequests: observed, noExternalRequests: true, rateMutations: rateCalls, storeMutations: storeWrites };
  if (process.env.AUTH_FORM_EVIDENCE_DIR) {
    const dir = resolve(process.env.AUTH_FORM_EVIDENCE_DIR); await mkdir(dir, { recursive: true, mode: 0o700 }); await chmod(dir, 0o700);
    await writeFile(join(dir, 'credential-form-fallback.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    await chmod(join(dir, 'credential-form-fallback.json'), 0o600);
  }
  if (baselineRenderer) console.log('PASS baseline old renderer reproduces credential GET with JavaScript disabled (fake fixtures only)');
  console.log('PASS fixed no-JS and blocked-script pages keep submit disabled; Enter and forced native submission cannot navigate under CSP');
  console.log('PASS degraded-policy native submits remain POST with empty query: null-Origin403, valid-Origin JSON-parser400, zero limiter/store mutations');
} finally { await browser?.close(); server.closeAllConnections(); await new Promise((done) => server.close(done)); bridge?.closeAllConnections(); }
