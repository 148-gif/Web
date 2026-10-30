// Native Node boundary for the existing Fetch-based editor API. No listener,
// credentials, database setup or production actions run merely by importing it.
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import worker from '../cms-worker/worker.mjs';
import { clientAddressResolver } from './proxy-address.mjs';

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS']);
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
const privateHeaders = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

function originOf(value) {
  if (typeof value !== 'string') throw new TypeError('publicOrigin must be an explicit HTTP(S) origin');
  let url;
  try { url = new URL(value); } catch { throw new TypeError('publicOrigin must be an explicit HTTP(S) origin'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new TypeError('publicOrigin must be an HTTP(S) origin without credentials, path, query or fragment');
  return url;
}

function requestHeaders(incoming, origin) {
  const headers = new Headers();
  const hop = new Set([...HOP_HEADERS, ...String(incoming.headers.connection || '').toLowerCase().split(',').map((part) => part.trim())]);
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (value === undefined || hop.has(name) || name === 'host' || name === 'forwarded' || name === 'cf-connecting-ip' || name === 'true-client-ip' || name === 'x-real-ip' || name.startsWith('x-forwarded-')) continue;
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item);
  }
  headers.set('Host', origin.host);
  return headers;
}

// Cancelling Readable.toWeb(incoming) destroys the socket, losing a useful 413
// response. Read only on demand; cancellation stops reads without destroying the
// socket. The response path closes that connection after its error is delivered.
function incomingBody(incoming) {
  let pending = null, ended = false, controller;
  const detach = () => {
    incoming.removeListener('readable', flush);
    incoming.removeListener('end', onEnd);
    incoming.removeListener('error', onError);
  };
  const settle = () => { const waiting = pending; pending = null; if (waiting) waiting(); };
  function flush() {
    if (!pending || ended) return;
    const chunk = incoming.read();
    if (chunk === null) return;
    controller.enqueue(chunk);
    settle();
  }
  function onEnd() {
    if (ended) return;
    ended = true; detach(); controller.close(); settle();
  }
  function onError(error) {
    if (ended) return;
    ended = true; detach(); controller.error(error); settle();
  }
  return new ReadableStream({
    start(value) {
      controller = value;
      incoming.on('readable', flush);
      incoming.on('end', onEnd);
      incoming.on('error', onError);
    },
    pull() {
      if (ended) return;
      if (incoming.readableEnded) return onEnd();
      return new Promise((resolve) => { pending = resolve; flush(); });
    },
    cancel() {
      if (ended) return;
      ended = true; detach(); incoming.pause(); settle();
    },
  }, { highWaterMark: 0 });
}

function sendError(outgoing, incoming, env, status) {
  const headers = { ...privateHeaders, Connection: 'close' };
  if (typeof incoming.headers.origin === 'string' && incoming.headers.origin === env.ALLOWED_ORIGIN) {
    headers['Access-Control-Allow-Origin'] = env.ALLOWED_ORIGIN;
    headers.Vary = 'Origin';
  }
  if (status === 405) headers.Allow = [...METHODS].join(', ');
  const message = status === 500 ? 'שגיאה בשרת העריכה' : status === 405 ? 'method not allowed' : 'invalid request';
  outgoing.writeHead(status, headers);
  outgoing.end(incoming.method === 'HEAD' ? undefined : JSON.stringify({ message }));
}

// A dedicated API origin preserves existing /session, /gh, /media and /m paths.
// Proxy identities require an explicit verified allowlist; default is socket-only.
export function createCmsServer({ env, publicOrigin, handleRequest = worker.fetch, trustedProxyIps = [], noIndex = false, basePath = '' } = {}) {
  if (!env || typeof env !== 'object') throw new TypeError('An explicit server environment is required');
  if (typeof handleRequest !== 'function') throw new TypeError('handleRequest must be a function');
  const origin = originOf(publicOrigin);
  if (typeof basePath !== 'string' || (basePath !== '' && !/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(basePath))) throw new TypeError('basePath must be empty or a canonical path without a trailing slash');
  if (typeof noIndex !== 'boolean') throw new TypeError('noIndex must be a boolean');
  const clientAddress = clientAddressResolver(trustedProxyIps);
  const server = createServer({
    maxHeaderSize: 16384,
    headersTimeout: 15000,
    requestTimeout: 300000,
    keepAliveTimeout: 5000,
  }, async (incoming, outgoing) => {
    if (noIndex) outgoing.setHeader('X-Robots-Tag', 'noindex, nofollow');
    const abort = new AbortController();
    const address = clientAddress(incoming.socket.remoteAddress, incoming.headers['x-forwarded-for']);
    const disconnected = () => { if (!abort.signal.aborted) abort.abort(new DOMException('The client disconnected', 'AbortError')); };
    const responseClosed = () => { if (!outgoing.writableFinished) disconnected(); };
    incoming.on('aborted', disconnected);
    // Keep an error listener after body cancellation, when its own listeners detach.
    incoming.on('error', disconnected);
    outgoing.on('close', responseClosed);
    let request, response;
    try {
      if (!METHODS.has(incoming.method)) return sendError(outgoing, incoming, env, 405);
      const target = incoming.url || '';
      // Reject control characters before URL normalization can remove them.
      // eslint-disable-next-line no-control-regex
      if (!target.startsWith('/') || target.startsWith('//') || /[\\#\u0000-\u0020\u007f]/.test(target)) return sendError(outgoing, incoming, env, 400);
      let apiTarget = target;
      if (basePath) {
        if (target === basePath) apiTarget = '/';
        else if (target.startsWith(basePath + '?')) apiTarget = '/' + target.slice(basePath.length);
        else if (target.startsWith(basePath + '/')) apiTarget = target.slice(basePath.length);
        else return sendError(outgoing, incoming, env, 404);
      }
      if (apiTarget.startsWith('//')) return sendError(outgoing, incoming, env, 400);
      const hasBody = incoming.method !== 'GET' && incoming.method !== 'HEAD';
      if (!hasBody && (incoming.headers['transfer-encoding'] || Number(incoming.headers['content-length'] || 0) !== 0)) return sendError(outgoing, incoming, env, 400);
      request = new Request(new URL(apiTarget, origin), {
        method: incoming.method,
        headers: requestHeaders(incoming, origin),
        signal: abort.signal,
        ...(hasBody ? { body: incomingBody(incoming), duplex: 'half' } : {}),
      });
      // The request identity is supplied by this boundary, never by caller headers.
      const requestEnv = Object.create(env);
      Object.defineProperty(requestEnv, 'CLIENT_IP', { value: (candidate) => candidate === request ? address : null });
      response = await handleRequest(request, requestEnv);
      if (!(response instanceof Response)) throw new TypeError('The API handler must return a Response');
      if (abort.signal.aborted || outgoing.destroyed) {
        if (response.body) void response.body.cancel().catch(() => {});
        return;
      }
      const headers = {};
      const responseHop = new Set([...HOP_HEADERS, ...String(response.headers.get('connection') || '').toLowerCase().split(',').map((part) => part.trim())]);
      for (const [name, value] of response.headers) if (!responseHop.has(name) && name !== 'set-cookie') headers[name] = value;
      if (noIndex) headers['x-robots-tag'] = 'noindex, nofollow';
      const cookies = response.headers.getSetCookie();
      if (cookies.length && !responseHop.has('set-cookie')) headers['set-cookie'] = cookies;
      // Do not drain an untrusted, rejected upload just to keep its socket alive.
      if (hasBody && !incoming.readableEnded) headers.connection = 'close';
      outgoing.writeHead(response.status, headers);
      if (incoming.method === 'HEAD' || !response.body) {
        if (response.body) void response.body.cancel().catch(() => {});
        outgoing.end();
      } else await pipeline(Readable.fromWeb(response.body), outgoing, { signal: abort.signal });
    } catch {
      if (!outgoing.headersSent && !outgoing.destroyed && !abort.signal.aborted) sendError(outgoing, incoming, env, 500);
      else if (!outgoing.destroyed) outgoing.destroy();
    } finally {
      // The handler may reject authentication without ever reading its body.
      if (request?.body && !request.body.locked) void request.body.cancel().catch(() => {});
      incoming.removeListener('aborted', disconnected);
      // Incoming errors can still occur while an early response closes its socket.
      outgoing.removeListener('close', responseClosed);
    }
  });
  server.maxHeadersCount = 64;
  server.maxRequestsPerSocket = 1000;
  server.setTimeout(120000);
  return server;
}
