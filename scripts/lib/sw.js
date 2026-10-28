// Service worker: pages already read stay available offline.
// Pages: network first (checked against the server, at most 3 seconds before a saved copy is shown), a copy kept for offline
// (the most recent 150); without a connection, the copy or the offline page.
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
    // Pages are fetched by the worker itself (see page()), so the browser's own early request is turned off.
    if (self.registration.navigationPreload) await self.registration.navigationPreload.disable();
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

// Pages: always asked from the network and checked against the server (cache: 'no-cache'), so a page changed in the editor shows
// on the next visit instead of after the browser's 10-minute cache. If the network does not answer within 3 seconds and the page
// was read before, the saved copy is shown at once (and the fresh one is saved for next time); a page never read waits for the network.
const NET_WAIT = 3000;
const page = (e) => {
  const net = fetch(e.request, { cache: 'no-cache' });
  e.waitUntil(net.then((res) => (res.ok && res.type === 'basic' ? keepPage(e.request, res.clone()) : null)).catch(() => {}));
  const saved = caches.match(e.request, { ignoreSearch: true });
  const late = new Promise((r) => setTimeout(r, NET_WAIT)).then(() => saved);
  return Promise.race([net, late])
    .then((first) => first || net)
    .catch(async () => (await saved) || (await caches.match(OFFLINE)) || Response.error());
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
