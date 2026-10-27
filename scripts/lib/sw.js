// Service worker: pages already read stay available offline.
// Pages: network first, a copy kept for offline (the most recent 150); without a connection, the copy or the offline page.
// Versioned files (?v=: styles, scripts, fonts, search index): cache first, since a new version has a new URL.
// Everything else (PDFs, images, other sites) is left to the browser.
// Template: the build fills in VERSION and PRECACHE and writes it to dist/sw.js (scripts/lib/sections/offline.mjs).
const VERSION = 'dev';
const PRECACHE = [];
const SCOPE = self.registration.scope;
const STATIC = `static-${VERSION}`, PAGES = 'pages', MAX_PAGES = 150;
const OFFLINE = `${SCOPE}offline/`;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(STATIC).then((c) => c.addAll(PRECACHE.map((p) => SCOPE + p))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('static-') && k !== STATIC) await caches.delete(k);
    if (self.registration.navigationPreload) await self.registration.navigationPreload.enable();
    await self.clients.claim();
  })());
});

const keepPage = async (req, res) => {
  const c = await caches.open(PAGES);
  await c.delete(req, { ignoreSearch: true }); // re-adding moves the page to the end, so the oldest are trimmed first
  await c.put(req, res);
  const keys = await c.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX_PAGES))) await c.delete(k);
};

const page = async (e) => {
  try {
    const res = (await e.preloadResponse) || (await fetch(e.request));
    if (res.ok && res.type === 'basic') e.waitUntil(keepPage(e.request, res.clone()));
    return res;
  } catch {
    return (await caches.match(e.request, { ignoreSearch: true })) || (await caches.match(OFFLINE)) || Response.error();
  }
};

const versioned = async (req) => {
  const hit = await caches.match(req);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok) { const c = await caches.open(STATIC); await c.put(req, res.clone()); }
    return res;
  } catch {
    // Offline, a page kept from an older version asks for its own ?v=: any cached version of the file will do.
    return (await caches.match(req, { ignoreSearch: true })) || Response.error();
  }
};

self.addEventListener('fetch', (e) => {
  const req = e.request, u = new URL(req.url);
  if (req.method !== 'GET' || !req.url.startsWith(SCOPE)) return;
  if (req.mode === 'navigate') e.respondWith(page(e));
  else if (u.searchParams.has('v') && !u.pathname.endsWith('.pdf')) e.respondWith(versioned(req));
});
