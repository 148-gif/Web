/* global URL, self, caches */
'use strict';
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil((async () => {
  const scope = new URL(self.registration.scope);
  if (scope.origin !== 'https://148-gif.github.io' || scope.pathname !== '/Web/') return;
  for (const name of await caches.keys()) {
    if (name !== 'pages' && !name.startsWith('static-')) continue;
    const cache = await caches.open(name);
    for (const req of await cache.keys()) {
      const url = new URL(req.url);
      if (url.origin === scope.origin && (url.pathname === '/Web' || url.pathname.startsWith(scope.pathname))) {
        await cache.delete(req, { ignoreVary: true });
      }
    }
  }
  await self.clients.claim();
  await self.registration.unregister();
})()));
