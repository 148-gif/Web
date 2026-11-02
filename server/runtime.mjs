// Node composition root. Importing this module opens no sockets or databases.
import { readFile, realpath, stat } from 'node:fs/promises';
import { isIP } from 'node:net';
import { isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCmsServer } from './http.mjs';
import { createFileMedia } from './file-media.mjs';
import { createInitializedMysqlPool } from './mysql-pool.mjs';
import { readRuntimeIdentity } from './runtime-identity.mjs';
import { loadRuntimeEnvironment } from './runtime-env.mjs';
import { createLocalAuth } from './local-auth.mjs';
import { createWorkersAi, WorkersAiConfigurationError, WORKERS_AI_PROVIDER } from './workers-ai.mjs';
import worker from '../cms-worker/worker.mjs';

const APP_ROOT = fileURLToPath(new URL('../', import.meta.url));
const inside = (a, b) => a === b || a.startsWith(b + sep);
const loopback = (host) => host === 'localhost' || host === '::1' || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host);
export class RuntimeConfigurationError extends Error {}
const invalid = (name, detail) => { throw new RuntimeConfigurationError(`${name}: ${detail}`); };
const text = (values, name) => {
  if (typeof values[name] !== 'string' || !values[name].trim()) invalid(name, 'a nonempty value is required');
  return values[name];
};
const flag = (values, name, fallback = false) => {
  if (values[name] === undefined) return fallback;
  if (!['true', 'false'].includes(values[name])) invalid(name, 'must be true or false');
  return values[name] === 'true';
};
const integer = (values, name, fallback, maximum = 65535) => {
  const value = values[name] === undefined ? fallback : values[name];
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum) invalid(name, 'must be a positive integer within its supported limit');
  return Number(value);
};
const origin = (values, name, allowLocal) => {
  const value = text(values, name);
  let url;
  try { url = new URL(value); } catch { invalid(name, 'must be an explicit HTTPS origin'); }
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || (url.protocol !== 'https:' && !(allowLocal && url.protocol === 'http:' && loopback(url.hostname)))) invalid(name, 'must be an HTTPS origin without credentials or a path; explicitly enabled local development may use loopback HTTP');
  return url.origin;
};

export function runtimeConfiguration(values = process.env, nodeVersion = process.versions.node) {
  if (typeof nodeVersion !== 'string' || !/^\d+\.\d+\.\d+/.test(nodeVersion) || Number(nodeVersion.split('.')[0]) < 24) invalid('Node', 'version24 or newer is required');
  const deploymentCandidate = flag(values, 'CMS_DEPLOYMENT_CANDIDATE');
  const readOnly = flag(values, 'CMS_READ_ONLY'), publishEnabled = flag(values, 'CMS_PUBLISH_ENABLED');
  if (deploymentCandidate && (!readOnly || publishEnabled)) invalid('CMS_DEPLOYMENT_CANDIDATE', 'requires CMS_READ_ONLY=true and CMS_PUBLISH_ENABLED=false');
  const allowLocal = flag(values, 'CMS_LOCAL_DEVELOPMENT');
  const publicOrigin = origin(values, 'CMS_PUBLIC_ORIGIN', allowLocal);
  const allowedOrigin = origin(values, 'ALLOWED_ORIGIN', allowLocal);
  const localAuthEnabled = flag(values, 'CMS_LOCAL_AUTH_ENABLED');
  const localInvitationsEnabled = flag(values, 'CMS_LOCAL_INVITATIONS_ENABLED');
  const googleEnabled = flag(values, 'CMS_GOOGLE_AUTH_ENABLED', true);
  const googleSetupEnabled = flag(values, 'CMS_GOOGLE_SETUP_ENABLED');
  if (googleSetupEnabled && !localAuthEnabled) invalid('CMS_GOOGLE_SETUP_ENABLED', 'managed Google setup requires local authentication');
  if (localInvitationsEnabled && !localAuthEnabled) invalid('CMS_LOCAL_INVITATIONS_ENABLED', 'local owner invitations require local authentication');
  if (!localAuthEnabled && !googleEnabled) invalid('CMS_GOOGLE_AUTH_ENABLED', 'at least one configured authentication provider is required');
  if (localAuthEnabled && allowedOrigin !== publicOrigin) invalid('ALLOWED_ORIGIN', 'local authentication requires the same public and API origin');
  const apiBasePath = values.CMS_API_BASE_PATH || '';
  if (typeof apiBasePath !== 'string' || (apiBasePath && !/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(apiBasePath))) invalid('CMS_API_BASE_PATH', 'must be empty or a canonical path without a trailing slash');
  const repo = text(values, 'REPO'), branch = text(values, 'BRANCH');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) invalid('REPO', 'must identify one GitHub owner/repository');
  if (!/^[\w./-]+$/.test(branch) || branch.includes('..') || branch.startsWith('-') || branch.endsWith('/') || branch.includes('//')) invalid('BRANCH', 'must be an explicit Git branch');
  const owners = text(values, 'OWNERS');
  if (!/^[a-f0-9]{64}(?:\s*,\s*[a-f0-9]{64})*$/.test(owners)) invalid('OWNERS', 'must contain SHA-256 owner identifiers');
  const sessionSecret = text(values, 'SESSION_SECRET');
  if (Buffer.byteLength(sessionSecret) < 32) invalid('SESSION_SECRET', 'must contain at least32 bytes');
  const env = {
    ALLOWED_ORIGIN: allowedOrigin, REPO: repo, BRANCH: branch, OWNERS: owners, CMS_STAGING: flag(values, 'CMS_STAGING', true),
    GOOGLE_CLIENT_ID: googleEnabled && !googleSetupEnabled ? text(values, 'GOOGLE_CLIENT_ID') : '', GITHUB_TOKEN: text(values, 'GITHUB_TOKEN'), SESSION_SECRET: sessionSecret,
  };
  for (const name of ['MEDIA_GH_FILE_MB', 'MEDIA_GH_TOTAL_MB', 'MEDIA_R2_FILE_MB', 'MEDIA_R2_TOTAL_GB', 'TRANSLATE_PER_USER', 'TRANSLATE_PER_DAY', 'RATE_LOGIN_PER_MINUTE', 'RATE_LOGIN_PER_CLIENT', 'RATE_WRITE_PER_MINUTE']) {
    if (values[name] !== undefined) env[name] = text(values, name);
  }
  for (const name of ['MEDIA_GH_FILE_MB', 'MEDIA_GH_TOTAL_MB', 'MEDIA_R2_FILE_MB', 'MEDIA_R2_TOTAL_GB']) {
    if (env[name] === undefined) continue;
    const bytes = Number(env[name]) * (name.endsWith('_GB') ? 1024 ** 3 : 1024 ** 2);
    if (!/^\d+(?:\.\d+)?$/.test(env[name]) || !Number.isSafeInteger(bytes) || bytes < 1) invalid(name, 'must represent a positive exact byte budget');
  }
  // Existing media URLs are served by this API; raw private containers are never
  // exposed through an Apache public-directory mapping.
  if (values.MEDIA_PUBLIC_URL) invalid('MEDIA_PUBLIC_URL', 'the filesystem backend serves media through the configured API /m/ route');
  if (apiBasePath) env.MEDIA_PUBLIC_URL = `${publicOrigin}${apiBasePath}/m`;
  const host = text(values, 'MYSQL_HOST');
  if (!/^[A-Za-z0-9.:-]+$/.test(host)) invalid('MYSQL_HOST', 'must be a database hostname or IP address');
  const database = text(values, 'MYSQL_DATABASE'), user = text(values, 'MYSQL_USER');
  if (!/^[\w$-]{1,64}$/.test(database)) invalid('MYSQL_DATABASE', 'must be a supported explicit database name');
  const sslMode = values.MYSQL_SSL || (loopback(host) ? 'local' : 'verify');
  if (!['local', 'verify'].includes(sslMode) || (sslMode === 'local' && !loopback(host))) invalid('MYSQL_SSL', 'remote databases require verify mode');
  if (sslMode === 'verify' && isIP(host)) invalid('MYSQL_HOST', 'verified TLS requires a DNS hostname for certificate identity verification');
  const bindHost = values.CMS_BIND_HOST || '127.0.0.1';
  if (!isIP(bindHost) || !loopback(bindHost)) invalid('CMS_BIND_HOST', 'must be a loopback IP; expose the API through the verified hosting proxy');
  let trustedProxyIps = [];
  if (values.CMS_TRUSTED_PROXY_IPS !== undefined) {
    try { trustedProxyIps = JSON.parse(values.CMS_TRUSTED_PROXY_IPS); } catch { invalid('CMS_TRUSTED_PROXY_IPS', 'must be a JSON array of exact verified proxy IPs'); }
    if (!Array.isArray(trustedProxyIps) || trustedProxyIps.length > 16 || trustedProxyIps.some((ip) => typeof ip !== 'string' || !isIP(ip))) invalid('CMS_TRUSTED_PROXY_IPS', 'must be a JSON array of at most16 exact verified proxy IPs');
  }
  let ai;
  try { ai = createWorkersAi(values); }
  catch (error) {
    if (error instanceof WorkersAiConfigurationError) throw new RuntimeConfigurationError(error.message);
    throw error;
  }
  return {
    publicOrigin, apiBasePath, env, ai, bindHost, trustedProxyIps, staging: env.CMS_STAGING, port: integer(values, 'PORT', 3000),
    publishEnabled, readOnly, deploymentCandidate, localAuthEnabled, localInvitationsEnabled, googleEnabled, googleSetupEnabled,
    mediaRoot: text(values, 'CMS_MEDIA_ROOT'), publicRoot: text(values, 'CMS_PUBLIC_ROOT'),
    mediaMaxBytes: Number(env.MEDIA_R2_FILE_MB || 90) * 1024 ** 2,
    appRoot: values.CMS_APP_ROOT, sslMode, caFile: values.MYSQL_SSL_CA,
    mysql: {
      host, port: integer(values, 'MYSQL_PORT', 3306), database, user, password: text(values, 'MYSQL_PASSWORD'),
      connectionLimit: integer(values, 'MYSQL_CONNECTION_LIMIT', 5, 20), queueLimit: 64, waitForConnections: true,
      connectTimeout: 10000, enableKeepAlive: true, supportBigNumbers: true, bigNumberStrings: true,
      // mysql2's handshake field is one byte; 0900_bin's id309 does not fit.
      // Table columns retain utf8mb4_0900_bin and its NO_PAD exact comparisons.
      decimalNumbers: false, charset: 'utf8mb4_bin', multipleStatements: false, timezone: 'Z',
    },
  };
}

async function directories(config, applicationRoot) {
  const paths = {};
  for (const [name, value] of [['CMS_APP_ROOT', config.appRoot || applicationRoot], ['CMS_MEDIA_ROOT', config.mediaRoot], ['CMS_PUBLIC_ROOT', config.publicRoot]]) {
    if (typeof value !== 'string' || !isAbsolute(value)) invalid(name, 'an existing absolute directory is required');
    let canonical, info;
    try { canonical = await realpath(value); info = await stat(canonical); } catch { invalid(name, 'directory is unavailable'); }
    if (!info.isDirectory() || canonical !== resolve(value)) invalid(name, 'must be a canonical directory without symlink components');
    if (name === 'CMS_MEDIA_ROOT' && (info.mode & 0o077)) invalid(name, 'must be private with mode0700');
    paths[name] = canonical;
  }
  if (paths.CMS_APP_ROOT !== await realpath(applicationRoot)) invalid('CMS_APP_ROOT', 'must identify this installed application');
  const publicRoot = paths.CMS_PUBLIC_ROOT;
  for (const name of ['CMS_APP_ROOT', 'CMS_MEDIA_ROOT']) if (inside(paths[name], publicRoot) || inside(publicRoot, paths[name])) invalid(name, 'must be a separate directory tree from public documents');
  if (inside(paths.CMS_MEDIA_ROOT, paths.CMS_APP_ROOT) || inside(paths.CMS_APP_ROOT, paths.CMS_MEDIA_ROOT)) invalid('CMS_MEDIA_ROOT', 'must remain separate from replaceable application releases');
  return paths;
}

export function runtimeHandler(config, handleRequest = worker.fetch) {
  return async (request, env) => {
    const path = new URL(request.url).pathname;
    if (config.deploymentCandidate) {
      // A second runtime may verify the shared schema and existing session, but
      // it must never become a second writer. This outer gate runs before all
      // auth handlers, admission counters, bootstrap and Worker operations.
      // Limit reads too: only the reviewed smoke routes can reach application
      // code, so a future GET with cleanup side effects is not exposed here.
      const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'X-Robots-Tag': 'noindex, nofollow', Vary: 'Origin' };
      const origin = request.headers.get('Origin');
      const read = ['GET', 'HEAD'].includes(request.method);
      if (request.headers.has('Origin') && origin !== env.ALLOWED_ORIGIN || !read && request.method !== 'OPTIONS' && origin !== env.ALLOWED_ORIGIN) {
        return Response.json({ message: 'origin not allowed' }, { status: 403, headers });
      }
      if (origin === env.ALLOWED_ORIGIN) headers['Access-Control-Allow-Origin'] = origin;
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: {
        ...headers, 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      } });
      if (!read || !['/version', '/me'].includes(path)) return new Response(request.method === 'HEAD' ? null : JSON.stringify({ message: 'גרסת הבדיקה אינה מאפשרת פעולות ניהול.' }), {
        status: 503, headers: { ...headers, 'Content-Type': 'application/json', 'Retry-After': '60' },
      });
    }
    if (path === '/version' && ['GET', 'HEAD'].includes(request.method)) {
      const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Vary: 'Origin' };
      if (config.deploymentCandidate || env.CMS_STAGING !== false) headers['X-Robots-Tag'] = 'noindex, nofollow';
      const requestOrigin = request.headers.get('Origin');
      const forbidden = requestOrigin && requestOrigin !== env.ALLOWED_ORIGIN;
      if (requestOrigin && !forbidden) headers['Access-Control-Allow-Origin'] = env.ALLOWED_ORIGIN;
      const status = forbidden ? 403 : config.runtimeIdentity ? 200 : 404;
      const body = status === 200 ? { version: 1, ...config.runtimeIdentity, schemaVerified: true, deploymentCandidate: Boolean(config.deploymentCandidate) } : { message: 'Runtime identity unavailable' };
      return new Response(request.method === 'HEAD' ? null : JSON.stringify(body), { status, headers });
    }
    // Same-origin Node discovery also exists in legacy Google-only mode. A
    // failed discovery can then fail closed without breaking that deployment.
    if (!config.localAuthEnabled && path === '/auth/options' && request.method === 'GET') {
      const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
      if (env.CMS_STAGING !== false) headers['X-Robots-Tag'] = 'noindex, nofollow';
      if (request.headers.get('Origin') !== env.ALLOWED_ORIGIN) return Response.json({ message: 'origin not allowed' }, { status: 403, headers });
      headers['Access-Control-Allow-Origin'] = env.ALLOWED_ORIGIN; headers.Vary = 'Origin';
      return Response.json({ localEnabled: false, googleEnabled: config.googleEnabled !== false, settingsAvailable: false,
        readOnly: Boolean(config.readOnly), publishEnabled: Boolean(config.publishEnabled) }, { headers });
    }
    const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    const authWrite = path === '/session' && request.method === 'POST' || config.localAuthEnabled && (
      request.method === 'POST' && ['/auth/login', '/auth/logout', '/auth/bootstrap', '/auth/password'].includes(path) ||
      request.method === 'PUT' && path === '/auth/settings' ||
      config.localInvitationsEnabled && request.method === 'POST' && ['/auth/invitations', '/auth/invitations/accept'].includes(path) ||
      config.googleSetupEnabled && request.method === 'POST' && ['/auth/google/prepare', '/auth/google/verify', '/auth/google/activate'].includes(path));
    const blocked = mutation && ((config.readOnly && !authWrite) || (!config.publishEnabled && path === '/publish'));
    if (blocked) {
      const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Retry-After': '60' };
      if (request.headers.get('Origin') === env.ALLOWED_ORIGIN) { headers['Access-Control-Allow-Origin'] = env.ALLOWED_ORIGIN; headers.Vary = 'Origin'; }
      if (env.CMS_STAGING !== false) headers['X-Robots-Tag'] = 'noindex, nofollow';
      return Response.json({ message: config.readOnly ? 'המערכת במצב קריאה בלבד לצורך תחזוקה. נסו שוב בהמשך.' : 'הפרסום מושהה עד להשלמת הגדרת הפרסום לאתר.' }, { status: 503, headers });
    }
    const response = await handleRequest(request, env);
    if (env.CMS_STAGING === false && !config.deploymentCandidate) return response;
    const headers = new Headers(response.headers);
    headers.set('X-Robots-Tag', 'noindex, nofollow');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  };
}

// Dependency injection keeps lifecycle tests independent of credentials, a live
// provider and a database. Production uses the explicitly named local adapters.
export async function createRuntime({ values = process.env, nodeVersion = process.versions.node, applicationRoot = APP_ROOT, dependencies = {} } = {}) {
  values = await loadRuntimeEnvironment({ inherited: values, applicationRoot });
  const config = runtimeConfiguration(values, nodeVersion);
  const paths = await directories(config, applicationRoot);
  if (config.sslMode === 'verify') {
    let ca;
    if (config.caFile) {
      if (!isAbsolute(config.caFile)) invalid('MYSQL_SSL_CA', 'must be an absolute certificate path');
      try { ca = await readFile(config.caFile, 'utf8'); } catch { invalid('MYSQL_SSL_CA', 'certificate is unavailable'); }
    }
    config.mysql.ssl = { rejectUnauthorized: true, verifyIdentity: true, ...(ca ? { ca } : {}) };
  }
  const createPool = dependencies.createPool || (await import('mysql2/promise')).createPool;
  const makeStore = dependencies.createDataStore || (await import('./mysql-store.mjs')).createMysqlDataStore;
  const makeKv = dependencies.createKv || (await import('./mysql-kv.mjs')).createMysqlKv;
  const makeRate = dependencies.createRateLimitStore || (await import('./mysql-rate-limit.mjs')).createMysqlRateLimitStore;
  const pool = createInitializedMysqlPool(createPool(config.mysql));
  let server, closing;
  const close = () => closing ||= (async () => {
    try {
      if (server?.listening) {
        const timeout = setTimeout(() => server.closeAllConnections(), 10000); timeout.unref();
        try { await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose())); }
        finally { clearTimeout(timeout); }
      }
    } finally { await pool.end(); }
  })();
  try {
    const store = makeStore(pool);
    await store.ensureSchema();
    const env = { ...config.env, ...(config.ai ? { AI: config.ai } : {}), DATA_STORE: store, EDITORS: makeKv(pool), RATE_LIMIT_STORE: makeRate(pool), MEDIA: createFileMedia({ root: paths.CMS_MEDIA_ROOT, maxBytes: config.mediaMaxBytes }) };
    let handler = dependencies.handleRequest || worker.fetch;
    if (config.localAuthEnabled) {
      const makeAuth = dependencies.createAuthStore || (await import('./mysql-auth-store.mjs')).createMysqlAuthStore;
      const authStore = makeAuth(pool, { googleSetup: config.googleSetupEnabled, localInvitations: config.localInvitationsEnabled });
      await authStore.ensureSchema();
      const auth = createLocalAuth({ store: authStore, config });
      const next = handler;
      handler = (request, requestEnv) => auth.handle(request, requestEnv, next);
    }
    // An identity is optional for legacy env-only installations, but a present
    // identity must always verify. New private-file deployments require it.
    config.runtimeIdentity = await readRuntimeIdentity({ applicationRoot: paths.CMS_APP_ROOT, required: Boolean(values.CMS_ENV_FILE) });
    server = createCmsServer({ env, publicOrigin: config.publicOrigin, basePath: config.apiBasePath, trustedProxyIps: config.trustedProxyIps, noIndex: config.staging || config.deploymentCandidate, handleRequest: runtimeHandler(config, handler) });
    return {
      server, close,
      status: { publicationEnabled: config.publishEnabled, readOnly: config.readOnly, deploymentCandidate: config.deploymentCandidate, slugAiAvailable: Boolean(config.ai), slugAiProvider: config.ai ? WORKERS_AI_PROVIDER : 'disabled', slugAiVerified: false, schemaVerified: true },
      async listen() {
        if (closing || server.listening) throw new Error('Runtime cannot be started in its current state');
        try {
          await new Promise((resolveListen, reject) => {
            const error = (cause) => { server.removeListener('listening', listening); reject(cause); };
            const listening = () => { server.removeListener('error', error); resolveListen(); };
            server.once('error', error); server.once('listening', listening);
            server.listen(config.port, config.bindHost);
          });
        } catch (error) { await close(); throw error; }
      },
    };
  } catch (error) { await close(); throw error; }
}

export function installShutdownHandlers(runtime, { signals = process, onError = () => {} } = {}) {
  const shutdown = () => { void runtime.close().catch(onError); };
  signals.once('SIGTERM', shutdown); signals.once('SIGINT', shutdown);
  return () => { signals.removeListener('SIGTERM', shutdown); signals.removeListener('SIGINT', shutdown); };
}
