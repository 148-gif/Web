// Real Chromium/Cache API regression. All identities are loopback fixtures;
// no provider credentials, external requests or production API are involved.
// SW_BASELINE_REF optionally reproduces the old committed worker separately.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';

const source = await readFile(new URL('../scripts/lib/sw.js', import.meta.url), 'utf8');
let baselineSource;
if (process.env.SW_BASELINE_REF) {
  const commit = execFileSync('git', ['rev-parse', '--verify', '--end-of-options', `${process.env.SW_BASELINE_REF}^{commit}`], { encoding: 'utf8' }).trim();
  assert.match(commit, /^[a-f0-9]{40}$/);
  baselineSource = execFileSync('git', ['show', `${commit}:scripts/lib/sw.js`], { encoding: 'utf8' });
}
const PERSONAL = 'private authenticated loopback fixture';
let currentSource = baselineSource || source, origin, browser;
const hits = new Map();
const server = createServer((req, res) => {
  const url = new URL(req.url, origin), path = url.pathname;
  hits.set(path, (hits.get(path) || 0) + 1);
  res.setHeader('Cache-Control', 'no-store');
  if (path.endsWith('/sw.js')) {
    res.setHeader('Content-Type', 'text/javascript');
    return res.end(currentSource.replace("const VERSION = 'dev';", `const VERSION = '${currentSource === baselineSource ? 'old' : 'privacy'}';`));
  }
  if (path.endsWith('/fixture-login')) {
    res.setHeader('Set-Cookie', 'fixtureSession=1; HttpOnly; SameSite=Strict; Path=/'); return res.end('ok');
  }
  if (path.endsWith('/fixture-logout')) {
    res.setHeader('Set-Cookie', 'fixtureSession=; Max-Age=0; HttpOnly; SameSite=Strict; Path=/'); return res.end('ok');
  }
  const privatePath = /\/(?:cms-api[^/]*|admin|auth)(?:\/|$)/.test(path);
  if (privatePath || path.endsWith('/private-asset.js')) {
    const loggedIn = req.headers.cookie?.includes('fixtureSession=1');
    res.writeHead(loggedIn ? 200 : 401, { 'Content-Type': path.endsWith('/admin/') ? 'text/html' : 'application/json', 'Cache-Control': 'private, no-store' });
    return res.end(loggedIn ? PERSONAL : 'signed out');
  }
  if (path.endsWith('/public.js')) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Content-Type', 'text/javascript'); return res.end('public asset');
  }
  if (path.endsWith('/redirect.js')) { res.writeHead(302, { Location: path.replace('redirect.js', 'cms-api/me') }); return res.end(); }
  res.setHeader('Content-Type', 'text/html'); res.setHeader('Cache-Control', 'public, max-age=0');
  res.end('<!doctype html><html><title>Public offline fixture</title><body>Public offline fixture</body></html>');
});

async function controlled(page, scope) {
  await page.goto(origin + scope);
  await page.evaluate(async (base) => {
    await navigator.serviceWorker.register(base + 'sw.js', { scope: base, updateViaCache: 'none' });
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
  }, scope);
}
const request = (page, url, options = {}) => page.evaluate(async ({ url, options }) => {
  try { const res = await fetch(url, options); return { status: res.status, body: await res.text() }; }
  catch { return { networkFailed: true }; }
}, { url, options });
const cached = (page, url) => page.evaluate(async (url) => Boolean(await caches.match(url)), url);
const results = [];
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium' });
  // Root hosting and the GitHub Pages subdirectory use the same worker source.
  for (const scope of ['/', '/Web/']) {
    const context = await browser.newContext({ serviceWorkers: 'allow' }), page = await context.newPage();
    await controlled(page, scope);
    const privateURL = origin + scope + 'cms-api/me?v=fixture';
    await request(page, scope + 'fixture-login', { method: 'POST' });
    assert.equal((await request(page, privateURL)).body, PERSONAL);
    if (baselineSource && currentSource === baselineSource) {
      assert.equal(await cached(page, privateURL), true);
      await request(page, scope + 'fixture-logout', { method: 'POST' });
      await context.setOffline(true);
      assert.equal((await request(page, privateURL)).body, PERSONAL, 'baseline leaks cached authenticated data after logout offline');
      await context.setOffline(false);
      results.push({ scope, originalPrivateCacheLeakReproduced: true });
    }
    await request(page, scope + 'fixture-login', { method: 'POST' });
    const historical = ['admin/', 'cms-api/me', 'cms-api-check-12345678/auth/options', 'cms-api-rollback-12345678/me', 'auth/setup'];
    await page.evaluate(async ({ scope, historical }) => {
      const pages = await caches.open('pages');
      for (const path of historical) await pages.put(scope + path, await fetch(scope + path, { cache: 'no-store' }));
      await pages.put(scope + 'formerly-public/', await fetch(scope + 'cms-api/me', { cache: 'no-store' }));
      await pages.put(scope + 'public-read/', await fetch(scope + 'public-read/'));
      const unrelated = await caches.open('other-application'); await unrelated.put(scope + 'unrelated/', new Response('unrelated'));
    }, { scope, historical });
    // Always run an actual worker update so activation has historical entries.
    currentSource = source + '\n// activation regression ' + scope + '\n';
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      const changed = new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
      await registration.update(); await changed;
      const active = registration.active;
      if (active.state !== 'activated') await new Promise((resolve) => active.addEventListener('statechange', () => { if (active.state === 'activated') resolve(); }));
    });
    for (const path of [...historical, 'formerly-public/']) assert.equal(await cached(page, origin + scope + path), false, 'historic private cache removed: ' + path);
    assert.equal(await cached(page, origin + scope + 'public-read/'), true, 'public offline copy preserved');
    assert.equal(await page.evaluate(async (url) => Boolean(await (await caches.open('other-application')).match(url)), scope + 'unrelated/'), true);
    assert.equal((await request(page, privateURL)).body, PERSONAL);
    assert.equal(await cached(page, privateURL), false);
    const admin = await context.newPage(); await admin.goto(origin + scope + 'admin/');
    assert.equal(await admin.locator('body').innerText(), PERSONAL);
    assert.equal(await cached(page, origin + scope + 'admin/'), false); await admin.close();
    const asset = origin + scope + 'public.js?v=fixture', before = hits.get(scope + 'public.js') || 0;
    assert.equal((await request(page, asset)).body, 'public asset');
    assert.equal((await request(page, asset)).body, 'public asset');
    assert.equal(hits.get(scope + 'public.js'), before + 1, 'public versioned asset cache still works');
    for (const path of ['private-asset.js?v=fixture', 'redirect.js?v=fixture']) {
      assert.equal((await request(page, scope + path)).body, PERSONAL);
      assert.equal(await cached(page, origin + scope + path), false);
    }
    await request(page, scope + 'fixture-logout', { method: 'POST' });
    assert.equal((await request(page, privateURL)).status, 401);
    await context.setOffline(true);
    for (const path of ['cms-api/me?v=fixture', 'admin/', 'cms-api-check-12345678/auth/options', 'cms-api-rollback-12345678/me', 'auth/setup', 'private-asset.js?v=fixture', 'redirect.js?v=fixture']) {
      assert.equal((await request(page, scope + path)).networkFailed, true, 'private request must fail offline, never return old identity');
    }
    assert.equal((await request(page, asset)).body, 'public asset');
    await page.goto(origin + scope + 'public-read/');
    assert.equal(await page.title(), 'Public offline fixture');
    results.push({ scope, authenticatedPrivateGet: true, logoutOfflineBlocked: true, historicalPrivatePurged: true, publicOfflinePreserved: true, actualServiceWorker: true });
    await context.close();
    if (baselineSource) currentSource = baselineSource;
  }
  console.log(JSON.stringify({ passed: true, results }));
} finally {
  await browser?.close(); await new Promise((resolve) => server.close(resolve));
}
