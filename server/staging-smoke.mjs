// Read-only checks for a staging site's indexing protection. No authentication,
// cookies, page contents or response bodies are retained in the returned report.
const MAX_PATHS = 32;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const RAW_TAGS = new Set(['script', 'style', 'title', 'textarea', 'xmp', 'iframe', 'noembed', 'noframes']);
const finding = (code, message) => ({ code, message });

function originOf(value) {
  let url;
  try { url = new URL(value); }
  catch { throw new TypeError('An explicit staging origin is required'); }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new TypeError('Use an HTTPS origin without credentials, path, query or fragment; HTTP is allowed only on loopback');
  return url.origin;
}

function pathOf(path, origin) {
  if (typeof path !== 'string' || path.length > 2048 || !path.startsWith('/') || path.startsWith('//') || /[\\#\s]/u.test(path) || [...path].some((c) => c.codePointAt(0) < 32 || c.codePointAt(0) === 127)) throw new TypeError('Each inspected path must be a bounded absolute path on the staging origin');
  const url = new URL(path, origin);
  if (url.origin !== origin || url.username || url.password) throw new TypeError('Inspected paths must remain on the staging origin');
  return url.pathname + url.search;
}

function integer(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`Invalid ${label}`);
  return value;
}

function directives(value, header = false) {
  let scoped = false;
  const found = new Set();
  for (const part of String(value || '').toLowerCase().split(',')) {
    // A crawler-prefixed header does not establish protection for all crawlers.
    // Fetch combines repeated headers; ambiguous scoped combinations fail closed.
    if (header && /^\s*[a-z][\w-]*\s*:/.test(part)) scoped = true;
    if (!scoped) for (const token of part.trim().split(/\s+/)) found.add(token);
  }
  return { noindex: found.has('noindex') || found.has('none'), nofollow: found.has('nofollow') || found.has('none') };
}

function decodeAttribute(value) {
  const named = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', comma: ',', Tab: '\t', NewLine: '\n' };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, entity) => {
    if (entity[0] !== '#') return named[entity] ?? all;
    const n = /^#x/i.test(entity) ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : all;
  });
}

function attributes(text) {
  const out = Object.create(null);
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const match of text.matchAll(pattern)) {
    const name = match[1].toLowerCase();
    if (!Object.hasOwn(out, name)) out[name] = decodeAttribute(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return out;
}

function tagEnd(html, start) {
  let quote = '';
  for (let i = start; i < html.length; i++) {
    const char = html[i];
    if (quote) { if (char === quote) quote = ''; }
    else if (char === '"' || char === "'") quote = char;
    else if (char === '>') return i;
  }
  return -1;
}

// A small conservative head tokenizer: comments and raw-text elements cannot
// counterfeit a robots meta tag. Unsupported/incomplete heads fail the check.
function inspectHead(html) {
  let cursor = 0, inHead = false, sawHead = false, raw = null;
  const values = [];
  while (cursor < html.length) {
    if (raw) {
      const close = new RegExp(`</${raw}(?=[\\s/>])[^>]*>`, 'ig');
      close.lastIndex = cursor;
      const match = close.exec(html);
      if (!match) return { complete: false };
      cursor = close.lastIndex; raw = null; continue;
    }
    const start = html.indexOf('<', cursor);
    if (start < 0) break;
    if (html.startsWith('<!--', start)) {
      const end = html.indexOf('-->', start + 4);
      if (end < 0) return { complete: false };
      cursor = end + 3; continue;
    }
    const end = tagEnd(html, start + 1);
    if (end < 0) return { complete: false };
    const tag = /^<\s*(\/?)\s*([a-z][\w:-]*)\b([\s\S]*?)>$/i.exec(html.slice(start, end + 1));
    cursor = end + 1;
    if (!tag) continue;
    const closing = !!tag[1], name = tag[2].toLowerCase();
    if (name === 'head') {
      if (closing) return { complete: true, sawHead, values };
      inHead = true; sawHead = true;
    } else if (name === 'body' || (closing && name === 'html')) return { complete: true, sawHead: false, values: [] };
    else if (!closing && RAW_TAGS.has(name)) raw = name;
    else if (inHead && !closing && name === 'meta') {
      const attrs = attributes(tag[3]);
      if ((attrs.name || '').trim().toLowerCase() === 'robots') values.push(attrs.content || '');
    }
  }
  return { complete: false };
}

async function boundedText(response, maxBodyBytes, headOnly) {
  const reader = response.body?.getReader();
  if (!reader) return { text: '', bytes: 0, head: { complete: false } };
  const decoder = new TextDecoder();
  let text = '', bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        text += decoder.decode();
        return { text, bytes, head: headOnly ? inspectHead(text) : null };
      }
      const remaining = maxBodyBytes - bytes;
      const part = value.subarray(0, remaining);
      bytes += part.byteLength; text += decoder.decode(part, { stream: true });
      const head = headOnly ? inspectHead(text) : null;
      if (head?.complete) return { text: '', bytes, head };
      if (value.byteLength > remaining || bytes === maxBodyBytes) {
        const error = new Error('Response inspection exceeded its byte limit'); error.code = 'BODY_LIMIT'; throw error;
      }
    }
  } finally {
    // Cancellation also covers stopping once the head has been inspected.
    await reader.cancel().catch(() => {});
  }
}

function contentKind(response, path, checkRobots) {
  if (checkRobots && new URL(path, 'https://inspection.invalid').pathname === '/robots.txt') return 'robots';
  const mime = (response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'html';
  return 'asset';
}

async function inspectPath(origin, path, options) {
  const observations = [], visited = new Set();
  let target = new URL(path, origin);
  for (let hop = 0; hop <= options.maxRedirects; hop++) {
    const currentPath = target.pathname + target.search;
    // A redirect's query may contain application tokens. Report only its path,
    // never raw Location, cookie/header values, or remote error messages.
    const observation = { path: target.pathname, status: null, kind: null, inspectedBytes: 0, header: { noindex: false, nofollow: false }, findings: [] };
    observations.push(observation);
    if (visited.has(target.href)) { observation.findings.push(finding('redirect-loop', 'A redirect loop prevented inspection')); break; }
    visited.add(target.href);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const response = await fetch(target, { method: 'GET', credentials: 'omit', redirect: 'manual', signal: controller.signal, headers: { Accept: '*/*' } });
      observation.status = response.status;
      observation.header = directives(response.headers.get('x-robots-tag'), true);
      if (!observation.header.noindex || !observation.header.nofollow) observation.findings.push(finding('missing-robots-header', 'The response needs global X-Robots-Tag noindex and nofollow directives'));
      if (REDIRECTS.has(response.status)) {
        observation.kind = 'redirect';
        const location = response.headers.get('location');
        let next;
        try { if (!location || location.length > 4096) throw new Error(); next = new URL(location, target); }
        catch { observation.findings.push(finding('invalid-redirect', 'The redirect has no valid bounded destination')); break; }
        if (next.origin !== origin || next.username || next.password) { observation.findings.push(finding('cross-origin-redirect', 'Redirects outside the selected origin or containing credentials are not followed')); break; }
        next.hash = '';
        if (hop === options.maxRedirects) { observation.findings.push(finding('redirect-limit', 'The redirect limit was reached')); break; }
        target = next; continue;
      }
      if (response.status !== 200) observation.findings.push(finding('http-status', 'The inspected path did not return HTTP 200'));
      observation.kind = contentKind(response, currentPath, options.checkRobots);
      if (observation.kind === 'html' || observation.kind === 'robots') {
        const result = await boundedText(response, options.maxBodyBytes, observation.kind === 'html');
        observation.inspectedBytes = result.bytes;
        if (observation.kind === 'html') {
          const meta = result.head?.complete && result.head.sawHead ? directives(result.head.values.join(',')) : { noindex: false, nofollow: false };
          observation.meta = meta;
          if (!meta.noindex || !meta.nofollow) observation.findings.push(finding('missing-robots-meta', 'HTML needs a robots meta tag with noindex and nofollow in its completed head'));
        } else {
          // Conservative check: staging robots should allow fetching indexing
          // directives. A Disallow rule is never accepted as a noindex control.
          const blocked = result.text.split(/\r?\n/).some((line) => /^\s*disallow\s*:\s*\S/i.test(line.replace(/#.*/, '')));
          observation.crawlingAllowed = !blocked;
          if (blocked) observation.findings.push(finding('robots-disallow', 'robots.txt contains a nonempty Disallow rule; crawlers must be able to see noindex responses'));
        }
      }
      break;
    } catch (error) {
      const code = controller.signal.aborted ? 'timeout' : error?.code === 'BODY_LIMIT' ? 'body-limit' : 'request-failed';
      observation.findings.push(finding(code, code === 'timeout' ? 'The request or body inspection timed out' : code === 'body-limit' ? 'The response exceeded the bounded inspection size' : 'The response could not be inspected'));
      break;
    } finally {
      clearTimeout(timer);
      controller.abort(); // Close unread assets/redirects; no large media download.
    }
  }
  return { path, ok: observations.every((entry) => entry.findings.length === 0), observations };
}

export async function inspectStaging({ origin, paths = ['/'], checkRobots = false, timeoutMs = 10000, maxBodyBytes = 262144, maxRedirects = 3 } = {}) {
  origin = originOf(origin);
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > MAX_PATHS) throw new TypeError('Provide between 1 and 32 explicit staging paths');
  if (typeof checkRobots !== 'boolean') throw new TypeError('checkRobots must be boolean');
  const selected = [...new Set(paths.map((path) => pathOf(path, origin)))];
  if (checkRobots && !selected.includes('/robots.txt')) selected.push('/robots.txt');
  const options = {
    checkRobots,
    timeoutMs: integer(timeoutMs, 1, 60000, 'request timeout'),
    maxBodyBytes: integer(maxBodyBytes, 256, 1048576, 'inspection byte limit'),
    maxRedirects: integer(maxRedirects, 0, 5, 'redirect limit'),
  };
  const checks = [];
  for (const path of selected) checks.push(await inspectPath(origin, path, options));
  return { format: 'heichal-staging-smoke', version: 1, origin, readOnly: true, ok: checks.every((check) => check.ok), checks };
}
