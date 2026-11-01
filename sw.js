// Service worker: pages already read stay available offline.
// Pages: network first (checked against the server, at most 3 seconds before a saved copy is shown), a copy kept for offline
// (the most recent 150); without a connection, the copy or the offline page.
// Versioned files (?v=: styles, scripts, fonts, search index): cache first, since a new version has a new URL.
// Everything else (PDFs, images, other sites) is left to the browser.
// Template: the build fills in VERSION and PRECACHE and writes it to dist/sw.js (scripts/lib/sections/offline.mjs).
const VERSION = "mvyccq6p";
const PRECACHE = ["offline/","style.css?v=mvyccq6p","app.js?v=mvyccq6p","fonts/assistant-hebrew.woff2?v=f9805e7a16","fonts/assistant-latin.woff2?v=26b77cc317","fonts/frank-ruhl-libre-hebrew.woff2?v=acdf9ed0a3","fonts/frank-ruhl-libre-latin.woff2?v=b8081e5e9a"];
const SCOPE = self.registration.scope;
const STATIC = `static-${VERSION}`, PAGES = 'pages', MAX_PAGES = 150;
const OFFLINE = `${SCOPE}offline/`;

// Cache API does not enforce HTTP no-store/private. Apply the same policy to
// requests, responses, old entries and precaching, including redirected URLs.
const scopeURL = new URL(SCOPE);
const privateCache = (headers) => /(?:^|,)\s*(?:no-store|private)\s*(?:[=,]|$)/i.test(headers.get('Cache-Control') || '');
const publicURL = (value) => {
  try {
    const url = new URL(value);
    if (url.origin !== scopeURL.origin || url.username || url.password || !url.pathname.startsWith(scopeURL.pathname)) return false;
    let path = url.pathname;
    // Servers differ in decoding aliases. Ambiguous/malformed encodings are
    // never cached; decoded separators and dot segments cannot hide an API.
    for (let n = 0; path.includes('%') && n < 5; n++) path = decodeURIComponent(path);
    if (path.includes('%') || /[?#\p{Cc}]/u.test(path)) return false;
    const parts = [];
    for (const part of path.replace(/\\/g, '/').split('/')) {
      if (part === '..') parts.pop();
      else if (part && part !== '.') parts.push(part);
    }
    path = '/' + parts.join('/');
    const base = scopeURL.pathname.replace(/\/$/, '');
    if (path !== base && !path.startsWith(base + '/')) return false;
    const first = path.slice(base.length).split('/')[1] || '';
    return !/^(?:admin(?:;|$)|cms-api(?:-|;|$)|auth(?:;|$)|session(?:;|$))/i.test(first);
  } catch { return false; }
};
const publicRequest = (req) => req.method === 'GET' && publicURL(req.url) && !req.headers.has('Authorization') && req.cache !== 'no-store' && !privateCache(req.headers);
const publicResponse = (res) => res && res.ok && res.type === 'basic' && publicURL(res.url) && !privateCache(res.headers);
const safeMatch = async (name, req, options) => {
  if (!publicRequest(req)) return;
  const cache = await caches.open(name);
  for (const key of await cache.keys(req, options)) {
    const res = await cache.match(key);
    if (publicRequest(key) && publicResponse(res)) return res;
    await cache.delete(key);
  }
};
const offlinePage = () => safeMatch(STATIC, new Request(OFFLINE));

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(STATIC);
    for (const path of PRECACHE) {
      const req = new Request(SCOPE + path);
      if (!publicRequest(req)) continue;
      const res = await fetch(req);
      if (!res.ok) throw new Error('Public offline resource unavailable');
      if (publicResponse(res)) await cache.put(req, res);
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name !== PAGES && !name.startsWith('static-')) continue;
      // Preserve the existing cleanup of obsolete build assets. Current public
      // offline entries and unrelated applications' caches remain intact.
      if (name.startsWith('static-') && name !== STATIC) { await caches.delete(name); continue; }
      const cache = await caches.open(name);
      for (const req of await cache.keys()) if (!publicRequest(req) || !publicResponse(await cache.match(req))) await cache.delete(req);
    }
    // Pages are fetched by the worker itself (see page()), so the browser's own early request is turned off.
    if (self.registration.navigationPreload) await self.registration.navigationPreload.disable();
    await self.clients.claim();
  })());
});

const keepPage = async (req, res) => {
  const c = await caches.open(PAGES);
  if (!publicRequest(req) || !publicResponse(res)) { await c.delete(req, { ignoreSearch: true }); return; }
  await c.delete(req, { ignoreSearch: true }); // re-adding moves the page to the end, so the oldest are trimmed first
  await c.put(req, res);
  const keys = await c.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_PAGES))) await c.delete(k);
};

// Pages: always asked from the network and checked against the server (cache: 'no-cache'), so a page changed in the editor shows
// on the next visit instead of after the browser's 10-minute cache. If the network does not answer within 3 seconds and the page
// was read before, the saved copy is shown at once (and the fresh one is saved for next time); a page never read waits for the network.
const NET_WAIT = 3000;
const page = (e) => {
  const net = fetch(e.request, { cache: 'no-cache' });
  e.waitUntil(net.then((res) => keepPage(e.request, res.clone())).catch(() => {}));
  const saved = safeMatch(PAGES, e.request, { ignoreSearch: true });
  const late = new Promise((r) => setTimeout(r, NET_WAIT)).then(() => saved);
  return Promise.race([net, late])
    .then((first) => first || net)
    .catch(async () => (await saved) || (await offlinePage()) || Response.error());
};

const versioned = async (req) => {
  const hit = await safeMatch(STATIC, req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (publicRequest(req) && publicResponse(res)) { const c = await caches.open(STATIC); await c.put(req, res.clone()); }
    return res;
  } catch {
    // Offline, a page kept from an older version asks for its own ?v=: any cached version of the file will do.
    return (await safeMatch(STATIC, req, { ignoreSearch: true })) || Response.error();
  }
};

self.addEventListener('fetch', (e) => {
  const req = e.request, u = new URL(req.url);
  if (!publicRequest(req)) return;
  if (req.mode === 'navigate') e.respondWith(page(e));
  else if (u.searchParams.has('v') && !u.pathname.endsWith('.pdf')) e.respondWith(versioned(req));
});
