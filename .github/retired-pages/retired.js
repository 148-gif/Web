/* global URL, location, document, navigator, setTimeout */
'use strict';
(async () => {
  const scope = new URL('/Web/', location.origin);
  if (scope.origin !== 'https://148-gif.github.io' || (location.pathname !== '/Web' && !location.pathname.startsWith(scope.pathname))) return;
  const target = new URL('https://hichal.yoterberama.com/');
  target.pathname = '/' + location.pathname.slice('/Web'.length).replace(/^\/+/, '');
  document.getElementById('destination').href = target.href;
  if ('serviceWorker' in navigator) {
    const update = navigator.serviceWorker.getRegistration(scope.href).then(reg =>
      reg && reg.scope === scope.href && reg.active?.scriptURL === scope.href + 'sw.js' ? reg.update() : undefined);
    await Promise.race([update.catch(() => {}), new Promise(resolve => setTimeout(resolve, 1200))]);
  }
  location.replace(target.href);
})();
