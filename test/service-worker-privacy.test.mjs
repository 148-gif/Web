import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../scripts/lib/sw.js', import.meta.url), 'utf8');
const origin = 'https://site.example';
function networkResponse(url, body = 'public', options = {}) {
  const decorate = (res) => {
    const clone = res.clone.bind(res);
    Object.defineProperties(res, { url: { value: url }, type: { value: options.type || 'basic' },
      redirected: { value: options.redirected || false }, clone: { value: () => decorate(clone()) } });
    return res;
  };
  return decorate(new Response(body, { status: options.status || 200, headers: options.headers }));
}
function request(path, options = {}) {
  const req = new Request(origin + path, options);
  if (options.navigate) Object.defineProperty(req, 'mode', { value: 'navigate' });
  return req;
}
function world({ code = source, base = '/', precache = [] } = {}) {
  const stores = new Map(), listeners = new Map(); let network = (req) => networkResponse(req.url);
  const match = (a, b, options = {}) => {
    const x = new URL(typeof a === 'string' ? a : a.url), y = new URL(typeof b === 'string' ? b : b.url);
    if (options.ignoreSearch) { x.search = ''; y.search = ''; }
    return x.href === y.href;
  };
  const cache = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const entries = stores.get(name);
    return {
      keys: async (req, opts) => [...entries.values()].filter((x) => !req || match(x.req, req, opts)).map((x) => x.req.clone()),
      match: async (req, opts) => [...entries.values()].find((x) => match(x.req, req, opts))?.res.clone(),
      put: async (req, res) => entries.set(req.url, { req: req.clone(), res: res.clone() }),
      delete: async (req, opts) => { let deleted = false; for (const [url, x] of entries) if (match(x.req, req, opts)) { entries.delete(url); deleted = true; } return deleted; },
      addAll: async (urls) => { for (const url of urls) { const req = new Request(url); await cache(name).put(req, await network(req)); } },
    };
  };
  const caches = { open: async (name) => cache(name), keys: async () => [...stores.keys()], delete: async (name) => stores.delete(name),
    match: async (req, opts) => { for (const name of stores.keys()) { const hit = await cache(name).match(req, opts); if (hit) return hit; } } };
  vm.runInNewContext(code.replace('const PRECACHE = [];', `const PRECACHE = ${JSON.stringify(precache)};`), {
    self: { registration: { scope: origin + base, navigationPreload: { disable: async () => {} } },
      clients: { claim: async () => {} }, skipWaiting: async () => {}, addEventListener: (name, fn) => listeners.set(name, fn) },
    caches, fetch: (req) => Promise.resolve().then(() => network(req)), Request, Response, URL,
    setTimeout: (fn) => { queueMicrotask(fn); return 0; },
  });
  const dispatch = async (kind, req) => {
    const waits = []; let response;
    listeners.get(kind)({ request: req, waitUntil: (p) => waits.push(p), respondWith: (p) => { response = p; } });
    let result, error;
    try { if (kind === 'fetch') result = await (response || network(req)); } catch (e) { error = e; }
    await Promise.all(waits);
    if (error) throw error;
    return { response: result, intercepted: response !== undefined };
  };
  return { stores, cache, dispatch, network: (fn) => { network = fn; }, offline: () => { network = () => { throw new Error('offline'); }; } };
}

test('private navigation and versioned session data are neither cached nor served offline', async () => {
  for (const base of ['/', '/Web/']) {
    const w = world({ base });
    const paths = ['admin/', 'admin/config.json?v=1', 'cms-api/auth/setup', 'cms-api/auth/session?v=1', 'cms-api-check-12345678/me?v=1', 'cms-api-rollback-old/auth/options?v=1', 'cms-api-anything/me?v=1', 'auth/session?v=1', 'session?v=1'];
    for (const path of paths) {
      const req = request(base + path, { navigate: !path.includes('?') });
      w.network(() => networkResponse(req.url, 'private sentinel', { headers: { 'Cache-Control': 'no-store' } }));
      assert.equal((await w.dispatch('fetch', req)).intercepted, false, path);
      assert.equal(w.stores.size, 0);
      w.offline();
      await assert.rejects(w.dispatch('fetch', req), /offline/, path);
    }
  }
});

test('encoded letters, separators, dot segments and aliases cannot disguise private scope-relative paths', async () => {
  for (const base of ['/', '/Web/']) {
    const w = world({ base });
    for (const path of ['%61dmin/', 'admin%2fconfig.json', 'admin%5cindex.html', '%2561dmin/', 'public%2f..%2fadmin/', '/admin/', 'ADMIN/', 'admin;ignored/', 'cms%2dapi%2fme', 'cms-api%2dcheck-any/me', '%61uth/session', '%252525252561dmin/', 'broken%zz']) {
      const req = request(base + path + '?v=1', { navigate: true });
      assert.equal((await w.dispatch('fetch', req)).intercepted, false, base + path);
    }
    assert.equal(w.stores.size, 0);
  }
});

test('request Authorization and private cache directives bypass existing public cache entries', async () => {
  const w = world(), path = '/library/?v=1';
  await w.cache('pages').put(request(path), networkResponse(origin + path, 'old public'));
  for (const options of [{ headers: { Authorization: 'Bearer private' } }, { headers: { Authorization: '' } },
    { cache: 'no-store' }, { headers: { 'Cache-Control': 'public, No-Store' } }, { headers: { 'Cache-Control': 'private="Set-Cookie"' } }]) {
    const req = request(path, { ...options, navigate: true });
    assert.equal((await w.dispatch('fetch', req)).intercepted, false);
    w.offline(); await assert.rejects(w.dispatch('fetch', req), /offline/);
    w.network((r) => networkResponse(r.url));
  }
});

test('network response privacy, opaque types and unsafe final redirect URLs cannot enter either cache', async () => {
  for (const navigate of [true, false]) {
    for (const options of [{ headers: { 'Cache-Control': 'no-store' } }, { headers: { 'Cache-Control': 'PUBLIC, PRIVATE="x"' } }, { type: 'opaque' }, { type: 'opaqueredirect' }, { type: 'cors' }]) {
      const w = world(), req = request('/library/?v=1', { navigate });
      w.network(() => networkResponse(req.url, 'private sentinel', options));
      await w.dispatch('fetch', req);
      assert.equal([...w.stores.values()].reduce((n, entries) => n + entries.size, 0), 0);
    }
    for (const final of ['/admin/', '/cms-api/auth/setup', '/%61dmin/', 'https://elsewhere.example/public/']) {
      const w = world(), req = request('/library/?v=1', { navigate });
      w.network(() => networkResponse(final.startsWith('http') ? final : origin + final, 'private redirect', { redirected: true }));
      await w.dispatch('fetch', req);
      assert.equal([...w.stores.values()].reduce((n, entries) => n + entries.size, 0), 0);
    }
  }
});

test('activation removes historical private entries and preserves public pages, current assets and unrelated caches', async () => {
  const w = world();
  for (const name of ['pages', 'static-dev', 'unrelated-app']) {
    for (const path of ['/admin/', '/cms-api/auth/session?v=1', '/cms-api-check-old/me?v=1', '/%61dmin/', '/public-private/']) {
      await w.cache(name).put(request(path), networkResponse(origin + path, 'private', { headers: path.includes('public-private') ? { 'Cache-Control': 'private' } : {} }));
    }
    await w.cache(name).put(request('/public-redirect/'), networkResponse(origin + '/admin/', 'redirected private', { redirected: true }));
    await w.cache(name).put(request('/library/'), networkResponse(origin + '/library/', 'public'));
    await w.cache(name).put(request('/offline/'), networkResponse(origin + '/offline/', 'offline'));
  }
  await w.cache('static-old').put(request('/admin/'), networkResponse(origin + '/admin/', 'private'));
  await w.dispatch('activate');
  for (const name of ['pages', 'static-dev']) assert.deepEqual([...w.stores.get(name).keys()], [origin + '/library/', origin + '/offline/']);
  assert.equal(w.stores.get('unrelated-app').size, 8);
  assert.equal(w.stores.has('static-old'), false);
});

test('cache reads reject historical private responses even before activation and ignore other applications caches', async () => {
  for (const navigate of [true, false]) {
    for (const options of [{ headers: { 'Cache-Control': 'no-store' } }, { type: 'opaque' }, { redirected: true }]) {
      const w = world(), req = request('/library/?v=1', { navigate });
      const res = networkResponse(origin + (options.redirected ? '/cms-api/me' : '/library/?v=1'), 'private sentinel', options);
      await w.cache(navigate ? 'pages' : 'static-dev').put(req, res);
      await w.cache('unrelated-app').put(req, networkResponse(req.url, 'foreign cache sentinel'));
      w.offline();
      const result = await w.dispatch('fetch', req);
      assert.equal(result.response.type, 'error');
      assert.equal(w.stores.get(navigate ? 'pages' : 'static-dev').size, 0);
      assert.equal(w.stores.get('unrelated-app').size, 1);
    }
  }
});

test('public navigation, offline fallback, redirects and versioned asset controls retain their behavior', async () => {
  const w = world({ base: '/Web/' }), page = request('/Web/library/', { navigate: true });
  w.network((req) => networkResponse(req.url, 'public read'));
  assert.equal(await (await w.dispatch('fetch', page)).response.text(), 'public read');
  w.offline(); assert.equal(await (await w.dispatch('fetch', page)).response.text(), 'public read');
  await w.cache('static-dev').put(request('/Web/offline/'), networkResponse(origin + '/Web/offline/', 'offline guide'));
  assert.equal(await (await w.dispatch('fetch', request('/Web/missing/', { navigate: true }))).response.text(), 'offline guide');
  const script = request('/Web/app.js?v=old'); let requests = 0;
  w.network((req) => { requests++; return networkResponse(req.url, 'public script'); });
  assert.equal(await (await w.dispatch('fetch', script)).response.text(), 'public script');
  assert.equal(await (await w.dispatch('fetch', script)).response.text(), 'public script'); assert.equal(requests, 1);
  w.offline(); assert.equal(await (await w.dispatch('fetch', request('/Web/app.js?v=new'))).response.text(), 'public script');
  w.network(() => networkResponse(origin + '/Web/destination/', 'public redirect', { redirected: true }));
  await w.dispatch('fetch', request('/Web/from/', { navigate: true })); w.offline();
  assert.equal(await (await w.dispatch('fetch', request('/Web/from/', { navigate: true }))).response.text(), 'public redirect');
});

test('precache validates final URLs and privacy headers instead of relying on addAll', async () => {
  const w = world({ precache: ['offline/', 'style.css?v=1', 'app.js?v=1', 'admin/config.json?v=1'] });
  w.network((req) => req.url.includes('style.css') ? networkResponse(req.url, 'private', { headers: { 'Cache-Control': 'no-store' } }) :
    req.url.includes('app.js') ? networkResponse(origin + '/admin/', 'private redirect', { redirected: true }) : networkResponse(req.url, 'offline'));
  await w.dispatch('install');
  assert.deepEqual([...w.stores.get('static-dev').keys()], [origin + '/offline/']);
});
