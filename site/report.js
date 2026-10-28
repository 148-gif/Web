// Failure reports from a visitor's browser: a script error, a file of the site that did not load, a search or prayer-times
// request that failed. Each is sent to the editor server (cms-worker/), which emails it to the site owner.
// Only the kind of failure, its message, the page address without query or hash, and online state are sent; the server adds
// the browser's name and country. A page view sends at most 5 different reports, and none while offline (then failures are expected).
{
const url = document.currentScript.dataset.url;
const seen = new Set();
const send = (kind, where, message, detail) => {
  if (!url || seen.size >= 5 || navigator.onLine === false) return;
  const key = `${kind}|${where}|${message}`;
  if (seen.has(key)) return;
  seen.add(key);
  try {
    // text/plain keeps this a simple request (no preflight), so it still goes out while the page is closing.
    fetch(url, { method: 'POST', keepalive: true, headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ kind, where, message: String(message), detail: detail ? String(detail) : '', page: location.origin + location.pathname, extra: { visibility: document.visibilityState } }) }).catch(() => {});
  } catch { /* a report must never cause a failure */ }
};
const ours = (f) => !!f && f.startsWith(location.origin);

// Capture phase, because a file that fails to load fires "error" on its own element and does not bubble.
addEventListener('error', (e) => {
  const t = e.target;
  if (t && t !== window) {
    const src = t.src || t.href;
    if (ours(src)) send('resource', t.localName, `לא נטען: ${src}`);
  } else if (ours(e.filename)) {
    send('script', e.filename.replace(location.origin, ''), e.message, `${e.filename}:${e.lineno}:${e.colno}\n${(e.error && e.error.stack) || ''}`);
  }
}, true);
addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  if (r && r.stack && r.stack.includes(location.origin)) send('script', 'promise', r.message || String(r), r.stack);
});
// For code that handles a failure itself (shows nothing, falls back) but should still let the owner know.
window.reportFailure = (where, err) => send('load', where, (err && err.message) || err, err && err.stack);
}
