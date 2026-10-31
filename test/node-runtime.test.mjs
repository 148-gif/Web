import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { EventEmitter } from 'node:events';
import { createRuntime, runtimeConfiguration, runtimeHandler, installShutdownHandlers } from '../server/runtime.mjs';
import { mysqlEnabled, withMysqlDatabase } from './helpers/mysql.mjs';
import { WORKERS_AI_ACCOUNT_ID, WORKERS_AI_MODEL, WORKERS_AI_PROVIDER } from '../server/workers-ai.mjs';

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'cms-runtime-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  for (const dir of ['app', 'media', 'public']) await mkdir(join(base, dir), { mode: 0o700 });
  const probe = createServer(); await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port; await new Promise((r) => probe.close(r));
  const values = {
    CMS_PUBLIC_ORIGIN: 'https://api.example.test', ALLOWED_ORIGIN: 'https://hichal.example.test',
    REPO: 'owner/repo', BRANCH: 'main', OWNERS: 'a'.repeat(64), GOOGLE_CLIENT_ID: 'test-client',
    GITHUB_TOKEN: 'private-test-github-token', SESSION_SECRET: 'private-test-session-secret-at-least-32-bytes',
    MYSQL_HOST: '127.0.0.1', MYSQL_DATABASE: 'cms_test', MYSQL_USER: 'test-user', MYSQL_PASSWORD: 'private-test-password',
    CMS_APP_ROOT: join(base, 'app'), CMS_MEDIA_ROOT: join(base, 'media'), CMS_PUBLIC_ROOT: join(base, 'public'), PORT: String(port),
  };
  const state = { constructed: 0, ended: 0, verified: 0, mysql: null };
  const dependencies = {
    createPool(options) { state.constructed++; state.mysql = options; return { async getConnection() { throw new Error('Unexpected fixture database access'); }, async end() { state.ended++; } }; },
    createDataStore() { return { async ensureSchema() { state.verified++; } }; },
    createKv() { return {}; }, createRateLimitStore() { return async () => true; },
    handleRequest: async () => Response.json({ ok: true }),
  };
  return { base, values, state, dependencies, options: { values, applicationRoot: values.CMS_APP_ROOT, dependencies } };
}

test('runtime config validates secrets and owner identities without including their values in errors', async (t) => {
  const { values } = await fixture(t);
  for (const [name, value] of [['OWNERS', 'not-a-hash'], ['SESSION_SECRET', 'short-private-secret'], ['MYSQL_HOST', 'remote/path'], ['BRANCH', '../private']]) {
    assert.throws(() => runtimeConfiguration({ ...values, [name]: value }), (error) => error.message.startsWith(name + ':') && !error.message.includes(value));
  }
  assert.throws(() => runtimeConfiguration(values, '22.0.0'), /Node/);
  const config = runtimeConfiguration(values);
  assert.equal(config.publishEnabled, false); assert.equal(config.staging, true);
  assert.equal(config.mysql.multipleStatements, false); assert.equal(config.mysql.bigNumberStrings, true);
  assert.equal(config.mysql.charset, 'utf8mb4_bin');
  assert.deepEqual(config.trustedProxyIps, []);
  assert.equal(runtimeConfiguration({ ...values, MEDIA_R2_FILE_MB: '2' }).mediaMaxBytes, 2 * 1024 ** 2);
  for (const bad of ['0', '-1', 'NaN', '1e9', '999999999999999']) assert.throws(() => runtimeConfiguration({ ...values, MEDIA_R2_FILE_MB: bad }), /MEDIA_R2_FILE_MB/);
});

test('remote database TLS and local proxy trust require explicit verified configuration', async (t) => {
  const { values } = await fixture(t);
  assert.throws(() => runtimeConfiguration({ ...values, MYSQL_HOST: 'db.example.test', MYSQL_SSL: 'local' }), /MYSQL_SSL/);
  assert.equal(runtimeConfiguration({ ...values, MYSQL_HOST: 'db.example.test' }).sslMode, 'verify');
  assert.throws(() => runtimeConfiguration({ ...values, MYSQL_HOST: '192.0.2.1' }), /certificate identity/);
  for (const bad of ['*', '127.0.0.1', '["127.0.0.0/8"]', '["127.0.0.1", null]']) assert.throws(() => runtimeConfiguration({ ...values, CMS_TRUSTED_PROXY_IPS: bad }), /CMS_TRUSTED_PROXY_IPS/);
  assert.deepEqual(runtimeConfiguration({ ...values, CMS_TRUSTED_PROXY_IPS: '["127.0.0.1"]' }).trustedProxyIps, ['127.0.0.1']);
  assert.throws(() => runtimeConfiguration({ ...values, CMS_BIND_HOST: '0.0.0.0' }), /CMS_BIND_HOST/);
  assert.throws(() => runtimeConfiguration({ ...values, CMS_PUBLIC_ORIGIN: 'http://api.example.test' }), /CMS_PUBLIC_ORIGIN/);
  assert.equal(runtimeConfiguration({ ...values, CMS_PUBLIC_ORIGIN: 'http://127.0.0.1:3000', CMS_LOCAL_DEVELOPMENT: 'true' }).publicOrigin, 'http://127.0.0.1:3000');
});

test('local authentication is opt-in, same-origin and permits explicitly configured local-only login', async (t) => {
  const { values } = await fixture(t);
  assert.equal(runtimeConfiguration(values).localAuthEnabled, false);
  assert.equal(runtimeConfiguration(values).googleEnabled, true);
  assert.throws(() => runtimeConfiguration({ ...values, CMS_LOCAL_AUTH_ENABLED: 'true' }), /same public and API origin/);
  const local = { ...values, ALLOWED_ORIGIN: values.CMS_PUBLIC_ORIGIN, CMS_LOCAL_AUTH_ENABLED: 'true', CMS_GOOGLE_AUTH_ENABLED: 'false' };
  delete local.GOOGLE_CLIENT_ID;
  assert.equal(runtimeConfiguration(local).env.GOOGLE_CLIENT_ID, '');
  assert.throws(() => runtimeConfiguration({ ...local, CMS_LOCAL_AUTH_ENABLED: 'false' }), /at least one/);
  assert.throws(() => runtimeConfiguration({ ...local, CMS_GOOGLE_AUTH_ENABLED: 'true' }), /GOOGLE_CLIENT_ID/);
});

test('read-only auth exceptions are exact method/path pairs and never unlock content or publication', async () => {
  const env = { ALLOWED_ORIGIN: 'https://example.test', CMS_STAGING: true };
  const handler = runtimeHandler({ readOnly: true, publishEnabled: false, localAuthEnabled: true }, async () => Response.json({ reached: true }));
  for (const [method, path] of [['POST', '/auth/login'], ['POST', '/auth/logout'], ['POST', '/auth/bootstrap'], ['POST', '/auth/password'], ['PUT', '/auth/settings'], ['POST', '/session']]) {
    assert.equal((await handler(new Request('https://example.test'+path, { method, headers: { Origin: env.ALLOWED_ORIGIN } }), env)).status, 200);
  }
  for (const [method, path] of [['POST', '/publish'], ['PUT', '/me'], ['PUT', '/editors'], ['POST', '/auth/settings'], ['DELETE', '/auth/login'], ['POST', '/auth/login/'], ['POST', '/auth/anything'], ['POST', '/session/'], ['PUT', '/session']]) {
    assert.equal((await handler(new Request('https://example.test'+path, { method }), env)).status, 503);
  }
  const disabled = runtimeHandler({ readOnly: true, publishEnabled: false, localAuthEnabled: false }, async () => Response.json({ reached: true }));
  assert.equal((await disabled(new Request('https://example.test/auth/login', { method: 'POST' }), env)).status, 503);
});

test('enabled local authentication verifies its separate schema and closes the pool on failure', async (t) => {
  const f = await fixture(t);
  f.values.CMS_LOCAL_AUTH_ENABLED = 'true'; f.values.ALLOWED_ORIGIN = f.values.CMS_PUBLIC_ORIGIN;
  f.dependencies.createAuthStore = () => ({ async ensureSchema() { throw new Error('auth schema missing'); } });
  await assert.rejects(createRuntime(f.options), /auth schema missing/);
  assert.equal(f.state.ended, 1);
});

test('managed Google setup is opt-in and missing addon schema fails startup closed', async (t) => {
  const f = await fixture(t);
  assert.equal(runtimeConfiguration(f.values).googleSetupEnabled, false);
  assert.throws(() => runtimeConfiguration({ ...f.values, CMS_GOOGLE_SETUP_ENABLED: 'true' }), /requires local/);
  Object.assign(f.values, { CMS_LOCAL_AUTH_ENABLED: 'true', CMS_GOOGLE_SETUP_ENABLED: 'true', ALLOWED_ORIGIN: f.values.CMS_PUBLIC_ORIGIN });
  delete f.values.GOOGLE_CLIENT_ID;
  assert.equal(runtimeConfiguration(f.values).env.GOOGLE_CLIENT_ID, '');
  f.dependencies.createAuthStore = (pool, options) => {
    assert.deepEqual(options, { googleSetup: true });
    return { async ensureSchema() { throw new Error('managed Google schema missing'); } };
  };
  await assert.rejects(createRuntime(f.options), /managed Google schema missing/);
  assert.equal(f.state.ended, 1);
});

test('Google setup read-only exceptions require both flags and exact POST routes', async () => {
  const env = { ALLOWED_ORIGIN: 'https://example.test', CMS_STAGING: true };
  for (const [localAuthEnabled, googleSetupEnabled] of [[true, true], [true, false], [false, true]]) {
    const handle = runtimeHandler({ readOnly: true, publishEnabled: false, localAuthEnabled, googleSetupEnabled }, async () => new Response(null, { status: 204 }));
    for (const path of ['/auth/google/prepare', '/auth/google/verify', '/auth/google/activate']) {
      assert.equal((await handle(new Request('https://example.test' + path, { method: 'POST' }), env)).status, localAuthEnabled && googleSetupEnabled ? 204 : 503);
      for (const method of ['PUT', 'DELETE']) assert.equal((await handle(new Request('https://example.test' + path, { method }), env)).status, 503);
      assert.equal((await handle(new Request('https://example.test' + path + '/', { method: 'POST' }), env)).status, 503);
    }
    for (const path of ['/auth/google/anything', '/publish', '/editors', '/gh/contents/data/topics.json']) {
      assert.equal((await handle(new Request('https://example.test' + path, { method: 'POST' }), env)).status, 503);
    }
  }
});

test('legacy Node Google discovery works without an auth table and refuses foreign origins', async () => {
  const env = { ALLOWED_ORIGIN: 'https://example.test', CMS_STAGING: true };
  const handle = runtimeHandler({ readOnly: true, publishEnabled: false, localAuthEnabled: false, googleEnabled: true }, () => { throw new Error('Discovery must not delegate'); });
  const response = await handle(new Request('https://example.test/auth/options', { headers: { Origin: env.ALLOWED_ORIGIN } }), env);
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.deepEqual(await response.json(), { localEnabled: false, googleEnabled: true, settingsAvailable: false, readOnly: true, publishEnabled: false });
  assert.equal((await handle(new Request('https://example.test/auth/options', { headers: { Origin: 'https://foreign.test' } }), env)).status, 403);
});

test('remote MySQL connections verify both the certificate chain and its DNS identity', async (t) => {
  const { options, values, state } = await fixture(t);
  const runtime = await createRuntime({ ...options, values: { ...values, MYSQL_HOST: 'db.example.test' } });
  t.after(() => runtime.close());
  assert.deepEqual(state.mysql.ssl, { rejectUnauthorized: true, verifyIdentity: true });
});

test('runtime keeps AI disabled by default and rejects partial activation before database setup', async (t) => {
  const { options, values, state } = await fixture(t);
  let providerCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => { providerCalls++; throw new Error('No provider calls are allowed in startup'); });
  assert.equal(runtimeConfiguration(values).ai, undefined);
  await assert.rejects(createRuntime({ ...options, values: { ...values, CMS_AI_PROVIDER: WORKERS_AI_PROVIDER } }), /CLOUDFLARE_AI_ACCOUNT_ID/);
  await assert.rejects(createRuntime({ ...options, values: { ...values, CLOUDFLARE_AI_ACCOUNT_ID: WORKERS_AI_ACCOUNT_ID } }), /CMS_AI_PROVIDER/);
  assert.equal(state.constructed, 0);
  const runtime = await createRuntime(options);
  try {
    assert.equal(runtime.status.slugAiAvailable, false);
    assert.equal(runtime.status.slugAiProvider, 'disabled');
    assert.equal(runtime.status.slugAiVerified, false);
    assert.equal(providerCalls, 0);
  } finally { await runtime.close(); }
});

test('explicit AI configuration attaches only a private binding and performs no startup probe', async (t) => {
  const { options, values, dependencies } = await fixture(t), localFetch = globalThis.fetch;
  const token = 'fixture-only-runtime-workers-ai-token';
  let providerCalls = 0;
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.equal(url, `https://api.cloudflare.com/client/v4/accounts/${WORKERS_AI_ACCOUNT_ID}/ai/run/${WORKERS_AI_MODEL}`);
    providerCalls++;
    return Response.json({ success: true, result: { translated_text: 'Test topic' }, errors: [] });
  });
  const runtime = await createRuntime({ ...options, values: { ...values,
    CMS_AI_PROVIDER: WORKERS_AI_PROVIDER, CLOUDFLARE_AI_ACCOUNT_ID: WORKERS_AI_ACCOUNT_ID, CLOUDFLARE_AI_API_TOKEN: token,
  }, dependencies: {
    ...dependencies,
    handleRequest: async (_request, env) => {
      assert.equal(env.CLOUDFLARE_AI_API_TOKEN, undefined);
      assert.equal(env.CLOUDFLARE_AI_ACCOUNT_ID, undefined);
      return Response.json(await env.AI.run(WORKERS_AI_MODEL, { text: 'נושא לבדיקה', source_lang: 'he', target_lang: 'en' }));
    },
  } });
  t.after(() => runtime.close());
  assert.equal(providerCalls, 0);
  assert.equal(runtime.status.slugAiAvailable, true);
  assert.equal(runtime.status.slugAiProvider, WORKERS_AI_PROVIDER);
  assert.equal(runtime.status.slugAiVerified, false);
  assert.equal(JSON.stringify(runtime.status).includes(token), false);
  await runtime.listen();
  assert.equal(providerCalls, 0);
  const response = await localFetch(`http://127.0.0.1:${values.PORT}/me`);
  assert.deepEqual(await response.json(), { translated_text: 'Test topic' });
  assert.equal(providerCalls, 1);
});

test('invalid directory isolation fails before a database pool is constructed', async (t) => {
  const { base, values, state, options } = await fixture(t);
  const nested = join(values.CMS_PUBLIC_ROOT, 'private'); await mkdir(nested, { mode: 0o700 });
  await assert.rejects(createRuntime({ ...options, values: { ...values, CMS_MEDIA_ROOT: nested } }), /separate directory tree/);
  const link = join(base, 'media-link'); await symlink(values.CMS_MEDIA_ROOT, link);
  await assert.rejects(createRuntime({ ...options, values: { ...values, CMS_MEDIA_ROOT: link } }), /canonical directory/);
  assert.equal(state.constructed, 0);
});

test('schema verification failure closes the pool without opening an HTTP listener', async (t) => {
  const { state, options, dependencies } = await fixture(t);
  await assert.rejects(createRuntime({ ...options, dependencies: { ...dependencies, createDataStore: () => ({ ensureSchema: async () => { throw new Error('schema mismatch'); } }) } }), /schema mismatch/);
  assert.equal(state.constructed, 1); assert.equal(state.ended, 1);
});

test('runtime initialization failure closes the pool before schema queries or an HTTP listener', async (t) => {
  const { options, dependencies } = await fixture(t);
  let ended = 0, destroyed = 0, reads = 0;
  await assert.rejects(createRuntime({ ...options, dependencies: {
    ...dependencies,
    createPool() {
      return {
        async getConnection() {
          return {
            async query(sql) { assert.ok(sql.startsWith('SET SESSION ')); throw new Error('private driver failure'); },
            async execute() { reads++; },
            release() { assert.fail('Failed session must not be released'); },
            destroy() { destroyed++; },
          };
        },
        async end() { ended++; },
      };
    },
    createDataStore(pool) {
      return { async ensureSchema() { const connection = await pool.getConnection(); await connection.execute('SELECT 1'); connection.release(); } };
    },
  } }), /MySQL session initialization failed/);
  assert.equal(reads, 0); assert.equal(destroyed, 1); assert.equal(ended, 1);
});

test('runtime verifies before explicit listen and owns graceful idempotent cleanup', async (t) => {
  const { state, options, values } = await fixture(t);
  const runtime = await createRuntime(options);
  t.after(() => runtime.close());
  assert.equal(state.verified, 1); assert.equal(runtime.server.listening, false);
  await runtime.listen();
  const response = await fetch(`http://127.0.0.1:${values.PORT}/me`);
  assert.equal(response.status, 200); assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.deepEqual(await response.json(), { ok: true });
  await Promise.all([runtime.close(), runtime.close()]);
  assert.equal(state.ended, 1); assert.equal(runtime.server.listening, false);
  await assert.rejects(runtime.listen(), /current state/);
});

test('publication stays disabled by default and read-only mode preserves reads and login', async () => {
  const seen = [], env = { ALLOWED_ORIGIN: 'https://site.example.test', CMS_STAGING: true };
  const handler = runtimeHandler({ publishEnabled: false, readOnly: false }, (req) => { seen.push(new URL(req.url).pathname); return Response.json({ ok: true }); });
  const req = (path, method = 'POST') => new Request(`https://api.example.test${path}`, { method, headers: { Origin: env.ALLOWED_ORIGIN } });
  const blocked = await handler(req('/publish'), env);
  assert.equal(blocked.status, 503); assert.equal(blocked.headers.get('access-control-allow-origin'), env.ALLOWED_ORIGIN);
  assert.equal(blocked.headers.get('retry-after'), '60'); assert.deepEqual(seen, []);
  await handler(req('/gh/contents/data/site.json', 'PUT'), env);
  assert.deepEqual(seen, ['/gh/contents/data/site.json']);
  const readOnly = runtimeHandler({ publishEnabled: true, readOnly: true }, () => Response.json({ ok: true }));
  for (const path of ['/publish', '/translate', '/me', '/media/init', '/editors']) assert.equal((await readOnly(req(path), env)).status, 503);
  for (const [path, method] of [['/me', 'GET'], ['/session', 'POST'], ['/me', 'OPTIONS']]) assert.equal((await readOnly(req(path, method), env)).status, 200);
});

test('explicit nonstaging mode does not add a noindex response header', async () => {
  const handler = runtimeHandler({ publishEnabled: true, readOnly: false }, () => Response.json({ ok: true }));
  assert.equal((await handler(new Request('https://api.example.test/me'), { CMS_STAGING: false })).headers.has('x-robots-tag'), false);
});

test('runtime config preserves a same-origin API prefix in media URLs and rejects unsafe prefixes', async (t) => {
  const { values } = await fixture(t);
  const config = runtimeConfiguration({ ...values, CMS_PUBLIC_ORIGIN: values.ALLOWED_ORIGIN, CMS_API_BASE_PATH: '/cms-api' });
  assert.equal(config.apiBasePath, '/cms-api');
  assert.equal(config.env.MEDIA_PUBLIC_URL, values.ALLOWED_ORIGIN + '/cms-api/m');
  for (const prefix of ['/../api', '//api', '/api/', '/api?key=bad']) assert.throws(() => runtimeConfiguration({ ...values, CMS_API_BASE_PATH: prefix }), /CMS_API_BASE_PATH/);
});

test('runtime composition routes the configured API prefix and keeps publication disabled behind it', async (t) => {
  const { values, options, dependencies } = await fixture(t);
  const runtime = await createRuntime({ ...options, values: { ...values, CMS_PUBLIC_ORIGIN: values.ALLOWED_ORIGIN, CMS_API_BASE_PATH: '/cms-api' }, dependencies: {
    ...dependencies, handleRequest: (request, env) => Response.json({ path: new URL(request.url).pathname, media: env.MEDIA_PUBLIC_URL }),
  } });
  t.after(() => runtime.close()); await runtime.listen();
  const local = `http://127.0.0.1:${values.PORT}`;
  const good = await fetch(local + '/cms-api/me');
  assert.deepEqual(await good.json(), { path: '/me', media: values.ALLOWED_ORIGIN + '/cms-api/m' });
  assert.equal((await fetch(local + '/cms-api/publish', { method: 'POST' })).status, 503);
  const outside = await fetch(local + '/me');
  assert.equal(outside.status, 404); assert.equal(outside.headers.get('x-robots-tag'), 'noindex, nofollow');
});

test('shutdown signals release resources and signal handlers can be detached', async (t) => {
  const { options, state } = await fixture(t), runtime = await createRuntime(options), signals = new EventEmitter();
  t.after(() => runtime.close());
  const detach = installShutdownHandlers(runtime, { signals });
  signals.emit('SIGTERM'); await runtime.close();
  assert.equal(state.ended, 1); detach();
  assert.equal(signals.listenerCount('SIGINT'), 0); assert.equal(signals.listenerCount('SIGTERM'), 0);
});

test('Node runtime starts against a real imported MySQL schema and serves the actual Worker', { skip: !mysqlEnabled }, async (t) => {
  const { values, options } = await fixture(t);
  await withMysqlDatabase(async ({ config }) => {
    const runtime = await createRuntime({ ...options, dependencies: {}, values: {
      ...values, MYSQL_HOST: config.host, MYSQL_PORT: String(config.port), MYSQL_DATABASE: config.database, MYSQL_USER: config.user, MYSQL_PASSWORD: config.password,
    } });
    try {
      await runtime.listen();
      const response = await fetch(`http://127.0.0.1:${values.PORT}/me`, { headers: { Origin: values.ALLOWED_ORIGIN } });
      assert.equal(response.status, 401); assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal((await fetch(`http://127.0.0.1:${values.PORT}/publish`, { method: 'POST', headers: { Origin: values.ALLOWED_ORIGIN } })).status, 503);
    } finally { await runtime.close(); }
  });
});
