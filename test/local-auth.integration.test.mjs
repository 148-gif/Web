// Real MySQL rehearsal only: helper creates/drops an isolated loopback database.
// Passwords here are test fixtures, never production credentials or owner data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import worker, { makeSession } from '../cms-worker/worker.mjs';
import { createLocalAuth } from '../server/local-auth.mjs';
import { digestToken, randomToken } from '../server/local-auth-crypto.mjs';
import { createMysqlAuthStore } from '../server/mysql-auth-store.mjs';
import { createMysqlDataStore } from '../server/mysql-store.mjs';
import { createMysqlKv } from '../server/mysql-kv.mjs';
import { createMysqlRateLimitStore } from '../server/mysql-rate-limit.mjs';
import { createInitializedMysqlPool } from '../server/mysql-pool.mjs';
import { initializeLocalAuthSchema } from '../scripts/setup-local-auth.mjs';
import { runtimeHandler } from '../server/runtime.mjs';
import { mysqlEnabled, withMysqlDatabase } from './helpers/mysql.mjs';

const ORIGIN = 'https://preview.example.test';
const OWNER_EMAIL = 'existing-owner@example.test';
const OWNER_HASH = digestToken(OWNER_EMAIL);
const PASSWORD = 'Test password only: long enough 123!';
const REPLACEMENT = 'Different test password only 456!';
const integration = (name, fn) => test(name, { skip: !mysqlEnabled }, () => withMysqlDatabase(async ({ pool: raw, database }) => {
  const pool = createInitializedMysqlPool(raw), plan = await initializeLocalAuthSchema(null);
  await initializeLocalAuthSchema(pool, { apply: true, targetDatabase: database, expectedSchemaSha256: plan.schemaSha256 });
  const store = createMysqlAuthStore(pool);
  let now = Date.now();
  const env = { OWNERS: OWNER_HASH, SESSION_SECRET: randomBytes(48).toString('hex'), ALLOWED_ORIGIN: ORIGIN,
    GOOGLE_CLIENT_ID: 'test-only-client', GITHUB_TOKEN: 'unused-test-only-provider-placeholder',
    DATA_STORE: createMysqlDataStore(pool), EDITORS: createMysqlKv(pool), RATE_LIMIT_STORE: createMysqlRateLimitStore(pool), CLIENT_IP: () => '127.0.0.1' };
  const config = { env, publicOrigin: ORIGIN, apiBasePath: '/cms-api', googleEnabled: true, staging: true, readOnly: true, publishEnabled: false };
  const service = createLocalAuth({ store, config, clock: () => now });
  const call = (path, { method = 'GET', body, cookie, csrf, bearer, origin = ORIGIN, next = worker.fetch } = {}) => {
    const headers = new Headers();
    if (origin !== null) headers.set('Origin', origin);
    if (cookie) headers.set('Cookie', cookie);
    if (csrf) headers.set('X-CSRF-Token', csrf);
    if (bearer) headers.set('Authorization', 'Bearer ' + bearer);
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    return service.handle(new Request(ORIGIN + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, next);
  };
  const arm = async () => {
    const code = randomToken();
    await store.atomic(async (tx) => tx.saveSettings({ ...await tx.getSettings(), bootstrap_hash: digestToken(code), bootstrap_expires: now + 900000, bootstrap_owner_hash: OWNER_HASH }));
    return code;
  };
  const bootstrap = async (code) => call('/auth/bootstrap', { method: 'POST', body: { code, username: 'Administrator', displayName: 'מנהל בדיקות', password: PASSWORD,
    // Untrusted role/owner/email claims must not influence the created identity.
    role: 'publisher', owner: false, owner_hash: 'f'.repeat(64), email: OWNER_EMAIL } });
  const login = async (password = PASSWORD, username = 'administrator', oldCookie) => {
    const response = await call('/auth/login', { method: 'POST', body: { username, password }, cookie: oldCookie });
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
    const body = await response.json(), fullCookie = response.headers.get('set-cookie');
    return { cookie: fullCookie.split(';')[0], fullCookie, csrf: body.csrfToken, body };
  };
  await fn({ pool, store, env, config, service, call, arm, bootstrap, login, advance: () => { now += 60000; }, now: () => now });
}));

integration('real local-auth bootstrap is private, atomic, replay-proof and bound to the configured owner', async (f) => {
  assert.equal((await f.call('/auth/setup', { origin: null })).status, 404);
  assert.equal((await f.bootstrap(randomToken())).status, 403);
  assert.equal(await f.store.countUsers(), 0);
  const code = await f.arm();
  const page = await f.call('/auth/setup', { origin: null });
  assert.equal(page.status, 200); assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert(!((await page.text()).includes(code)));
  const attempts = await Promise.all([f.bootstrap(code), f.bootstrap(code)]);
  assert.deepEqual(attempts.map((r) => r.status).sort(), [201, 403]);
  const user = await f.store.getUserByUsername('administrator');
  assert.equal(user.owner_hash, OWNER_HASH); assert.equal(user.role, 'owner');
  assert.match(user.id, /^[a-f0-9]{32}$/); assert(!user.password_hash.includes(PASSWORD));
  assert.equal(await f.store.countUsers(), 1);
  const settings = await f.store.getSettings();
  assert.equal(settings.bootstrap_consumed, true); assert.equal(settings.bootstrap_hash, null); assert.equal(settings.bootstrap_owner_hash, null);
  assert.equal(settings.local_verified, false);
  assert.equal((await f.call('/auth/setup', { origin: null })).status, 404);
  assert.equal((await f.bootstrap(code)).status, 403);
});

integration('real local login returns opaque protected cookies and never aliases a Google owner identity', async (f) => {
  await f.env.EDITORS.put('owner-names', JSON.stringify({ [OWNER_HASH]: 'בעלים קיים' }));
  await f.env.EDITORS.put('people', JSON.stringify([{ email: 'editor@example.test', name: 'עורך קיים', publisher: false }]));
  const before = [await f.env.EDITORS.get('owner-names'), await f.env.EDITORS.get('people')];
  assert.equal((await f.bootstrap(await f.arm())).status, 201);
  const session = await f.login();
  assert.match(session.fullCookie, /^__Host-heichal_local=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=28800$/);
  assert.equal(session.body.token, undefined); assert.equal(session.body.method, 'local');
  assert.match(session.body.user.email, /^local:[a-f0-9]{32}$/); assert.notEqual(session.body.user.email, OWNER_EMAIL);
  assert.equal(session.body.user.owner, true); assert.equal((await f.store.getSettings()).local_verified, true);
  const me = await f.call('/me', { cookie: session.cookie });
  assert.equal(me.status, 200); assert.equal((await me.json()).email, session.body.user.email);
  const changed = await f.call('/me', { method: 'PUT', cookie: session.cookie, csrf: session.csrf, body: { name: 'שם מקומי חדש' } });
  assert.equal(changed.status, 200); assert.equal((await f.store.getUserByUsername('administrator')).display_name, 'שם מקומי חדש');
  assert.deepEqual([await f.env.EDITORS.get('owner-names'), await f.env.EDITORS.get('people')], before);
  const bearer = await makeSession(OWNER_EMAIL, f.env);
  const googleMe = await f.call('/me', { bearer });
  assert.equal(googleMe.status, 200); assert.equal((await googleMe.json()).email, OWNER_EMAIL);
  const opaque = session.cookie.split('=')[1];
  const workerResponse = await worker.fetch(new Request(ORIGIN + '/me', { headers: { Origin: ORIGIN, Authorization: 'Bearer ' + opaque } }), f.env);
  assert.equal(workerResponse.status, 401);
  assert.equal((await f.call('/me', { cookie: session.cookie, bearer })).status, 401);
});

integration('real local auth rejects unknown and wrong-password accounts identically and rate-limits atomically', async (f) => {
  assert.equal((await f.bootstrap(await f.arm())).status, 201); f.advance();
  const unknown = await f.call('/auth/login', { method: 'POST', body: { username: 'unknown-user', password: PASSWORD } });
  const wrong = await f.call('/auth/login', { method: 'POST', body: { username: 'administrator', password: REPLACEMENT } });
  assert.equal(unknown.status, 401); assert.equal(wrong.status, 401); assert.deepEqual(await unknown.json(), await wrong.json());
  const [[counter]] = await f.pool.query("SELECT n FROM request_limits WHERE scope = 'login'"); assert.equal(Number(counter.n), 4);
  f.advance();
  const attempts = await Promise.all(Array.from({ length: 7 }, () => f.call('/auth/login', { method: 'POST', body: { username: 'administrator', password: REPLACEMENT } })));
  assert.equal(attempts.filter((r) => r.status === 429).length >= 2, true);
  assert.equal(attempts.every((r) => [401, 429].includes(r.status)), true);
});

integration('real local session mutations require Origin and CSRF, and logout revokes the stored session', async (f) => {
  assert.equal((await f.bootstrap(await f.arm())).status, 201);
  const s = await f.login();
  for (const params of [{ origin: 'https://foreign.example.test', csrf: s.csrf }, { origin: null, csrf: s.csrf }, {}]) {
    const response = await f.call('/auth/logout', { method: 'POST', body: {}, cookie: s.cookie, ...params }); assert.equal(response.status, 403);
  }
  assert.equal((await f.call('/auth/session', { cookie: s.cookie })).status, 200);
  const response = await f.call('/auth/logout', { method: 'POST', body: {}, cookie: s.cookie, csrf: s.csrf });
  assert.equal(response.status, 200); assert.match(response.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await f.call('/auth/session', { cookie: s.cookie })).status, 401);
  const [[sessions]] = await f.pool.query('SELECT COUNT(*) AS n FROM local_auth_sessions'); assert.equal(Number(sessions.n), 0);
});

integration('real local password rotation revokes all old sessions and rotates both cookie and CSRF', async (f) => {
  assert.equal((await f.bootstrap(await f.arm())).status, 201);
  const a = await f.login(), b = await f.login();
  assert.notEqual(a.cookie, b.cookie); assert.notEqual(a.csrf, b.csrf);
  const response = await f.call('/auth/password', { method: 'POST', cookie: a.cookie, csrf: a.csrf, body: { currentPassword: PASSWORD, newPassword: REPLACEMENT } });
  assert.equal(response.status, 200);
  const next = await response.json(), cookie = response.headers.get('set-cookie').split(';')[0];
  assert.notEqual(cookie, a.cookie); assert.notEqual(next.csrfToken, a.csrf);
  assert.equal((await f.call('/auth/session', { cookie: a.cookie })).status, 401);
  assert.equal((await f.call('/auth/session', { cookie: b.cookie })).status, 401);
  assert.equal((await f.call('/auth/session', { cookie })).status, 200);
  assert.equal((await f.store.getUserByUsername('administrator')).version, 2);
  f.advance();
  assert.equal((await f.call('/auth/login', { method: 'POST', body: { username: 'administrator', password: PASSWORD } })).status, 401);
  await f.login(REPLACEMENT);
});

integration('real auth settings preserve a verified replacement and cannot disable the final login method', async (f) => {
  assert.equal((await f.bootstrap(await f.arm())).status, 201);
  const bearer = await makeSession(OWNER_EMAIL, f.env);
  const premature = await f.call('/auth/settings', { method: 'PUT', bearer, body: { localEnabled: true, googleEnabled: false } });
  assert.equal(premature.status, 409); assert.equal((await f.store.getSettings()).google_enabled, true);
  let s = await f.login();
  const both = await f.call('/auth/settings', { method: 'PUT', cookie: s.cookie, csrf: s.csrf, body: { localEnabled: false, googleEnabled: false, currentPassword: PASSWORD } });
  assert.equal(both.status, 409);
  const local = await f.call('/auth/settings', { method: 'PUT', cookie: s.cookie, csrf: s.csrf, body: { localEnabled: false, googleEnabled: true, currentPassword: PASSWORD } });
  assert.equal(local.status, 409);
  const disableGoogle = await f.call('/auth/settings', { method: 'PUT', cookie: s.cookie, csrf: s.csrf, body: { localEnabled: true, googleEnabled: false, currentPassword: PASSWORD } });
  assert.equal(disableGoogle.status, 200);
  const updated = await disableGoogle.json();
  s = { cookie: disableGoogle.headers.get('set-cookie').split(';')[0], csrf: updated.csrfToken };
  assert.equal((await f.call('/me', { bearer })).status, 401);
  assert.equal((await f.call('/me', { cookie: s.cookie })).status, 200);
  assert.equal((await f.store.getSettings()).local_enabled, true); assert.equal((await f.store.getSettings()).google_enabled, false);
});

integration('removing the bound owner identifier invalidates local sessions without impersonating another owner', async (f) => {
  assert.equal((await f.bootstrap(await f.arm())).status, 201); const s = await f.login();
  const env = { ...f.env, OWNERS: digestToken('other-owner@example.test') }, config = { ...f.config, env };
  const replacement = createLocalAuth({ store: f.store, config, clock: f.now });
  const response = await replacement.handle(new Request(ORIGIN + '/me', { headers: { Origin: ORIGIN, Cookie: s.cookie } }), env, worker.fetch);
  assert.equal(response.status, 401);
  assert.equal((await f.store.getUserByUsername('administrator')).owner_hash, OWNER_HASH);
});

integration('real Node read-only wrapper allows exact auth endpoints while content and publication remain blocked', async (f) => {
  const wrapped = runtimeHandler({ ...f.config, localAuthEnabled: true }, (request, env) => f.service.handle(request, env, worker.fetch));
  const send = (path, { method = 'GET', body, cookie, csrf, origin = ORIGIN } = {}) => wrapped(new Request(ORIGIN + path, { method,
    headers: { ...(origin === null ? {} : { Origin: origin }), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), f.env);
  const code = await f.arm();
  const setup = await send('/auth/bootstrap', { method: 'POST', body: { code, username: 'administrator', password: PASSWORD, displayName: 'מנהל' } });
  assert.equal(setup.status, 201);
  const response = await send('/auth/login', { method: 'POST', body: { username: 'administrator', password: PASSWORD } });
  assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie').split(';')[0], csrf = (await response.json()).csrfToken;
  for (const [path, method] of [['/gh/contents/data/topics.json', 'PUT'], ['/publish', 'POST'], ['/editors', 'PUT'], ['/auth/login/extra', 'POST'], ['/auth/settings', 'DELETE']]) {
    const blocked = await send(path, { method, cookie, csrf, body: {} }); assert.equal(blocked.status, 503);
    assert.equal(blocked.headers.get('cache-control'), 'no-store'); assert.match(blocked.headers.get('x-robots-tag'), /noindex/);
  }
  assert.equal((await send('/auth/settings', { cookie })).status, 200);
  const changed = await send('/auth/settings', { method: 'PUT', cookie, csrf, body: { localEnabled: true, googleEnabled: false, currentPassword: PASSWORD } });
  assert.equal(changed.status, 200);
  const [[drafts]] = await f.pool.query('SELECT COUNT(*) AS n FROM drafts'); assert.equal(Number(drafts.n), 0);
  // Only storage bytes are stubbed here; actual auth boundary and media route run.
  f.env.MEDIA = { head: async () => ({ size: 3, httpMetadata: { contentType: 'application/pdf' } }), get: async () => ({ body: new Uint8Array([1, 2, 3]) }) };
  const media = await send('/m/test.pdf', { origin: null }); assert.equal(media.status, 200); assert.equal(media.headers.get('content-type'), 'application/pdf');
  assert.equal((await send('/m/test.pdf', { method: 'HEAD', origin: null })).status, 200);
});

integration('real local session expiry is enforced and the next login removes expired stored sessions', async (f) => {
  assert.equal((await f.bootstrap(await f.arm())).status, 201); const s = await f.login();
  for (let i = 0; i < 481; i++) f.advance();
  assert.equal((await f.call('/auth/session', { cookie: s.cookie })).status, 401);
  const next = await f.login(); assert.notEqual(next.cookie, s.cookie);
  const [[count]] = await f.pool.query('SELECT COUNT(*) AS n FROM local_auth_sessions'); assert.equal(Number(count.n), 1);
});

integration('disabling local login requires current recent Google-owner proof and revokes every local cookie', async (f) => {
  assert.equal((await f.bootstrap(await f.arm())).status, 201); const s = await f.login();
  const bearer = await makeSession(OWNER_EMAIL, f.env, f.now());
  const body = { localEnabled: false, googleEnabled: true };
  assert.equal((await f.call('/auth/settings', { method: 'PUT', bearer, body })).status, 409);
  // Seed only the result of a prior Google proof: no external OAuth provider is
  // contacted in this isolated test. Current bearer authenticity is still real.
  await f.store.atomic(async (tx) => tx.saveSettings({ ...await tx.getSettings(), google_verified_until: f.now() + 900000 }));
  const old = await makeSession(OWNER_EMAIL, f.env, f.now() - 16 * 60000);
  assert.equal((await f.call('/auth/settings', { method: 'PUT', bearer: old, body })).status, 409);
  const disabled = await f.call('/auth/settings', { method: 'PUT', bearer, body }); assert.equal(disabled.status, 200);
  assert.equal((await f.call('/auth/session', { cookie: s.cookie })).status, 401);
  assert.equal(await f.store.countUsers(), 1);
  const [[count]] = await f.pool.query('SELECT COUNT(*) AS n FROM local_auth_sessions'); assert.equal(Number(count.n), 0);
});

integration('local-only Node mode bootstraps, authenticates and rotates passwords without enabling content writes', async (f) => {
  f.config.googleEnabled = false; f.env.GOOGLE_CLIENT_ID = '';
  const wrapped = runtimeHandler({ ...f.config, localAuthEnabled: true }, (request, env) => f.service.handle(request, env, worker.fetch));
  const send = (path, { method = 'GET', body, cookie, csrf } = {}) => wrapped(new Request(ORIGIN + path, { method,
    headers: { Origin: ORIGIN, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), f.env);
  const options = await (await send('/auth/options')).json();
  assert.equal(options.googleEnabled, false); assert.equal(options.readOnly, true); assert.equal(options.publishEnabled, false);
  assert.equal((await send('/auth/setup')).status, 404, 'empty auth state does not open bootstrap');
  const code = await f.arm();
  assert.equal((await send('/auth/bootstrap', { method: 'POST', body: { code, username: 'administrator', displayName: 'מנהל מקומי', password: PASSWORD } })).status, 201);
  const login = await send('/auth/login', { method: 'POST', body: { username: 'administrator', password: PASSWORD } });
  assert.equal(login.status, 200);
  let cookie = login.headers.get('set-cookie').split(';')[0], csrf = (await login.json()).csrfToken;
  const settings = await (await send('/auth/settings', { cookie })).json();
  assert.equal(settings.googleAvailable, false); assert.equal(settings.googleEnabled, false);
  assert.equal(settings.localEnabled, true); assert.equal(settings.canDisableLocal, false);
  const saved = await send('/auth/settings', { method: 'PUT', cookie, csrf, body: { localEnabled: true, googleEnabled: false, currentPassword: PASSWORD } });
  assert.equal(saved.status, 200);
  const oldCookie = cookie;
  cookie = saved.headers.get('set-cookie').split(';')[0]; csrf = (await saved.json()).csrfToken;
  assert.notEqual(cookie, oldCookie);
  assert.equal((await send('/auth/session', { cookie: oldCookie })).status, 401);
  for (const [path, method] of [['/gh/contents/data/topics.json', 'PUT'], ['/editors', 'PUT'], ['/media/init', 'POST'], ['/publish', 'POST'], ['/me', 'PUT']]) {
    assert.equal((await send(path, { method, cookie, csrf, body: {} })).status, 503);
  }
  const rotated = await send('/auth/password', { method: 'POST', cookie, csrf, body: { currentPassword: PASSWORD, newPassword: REPLACEMENT } });
  assert.equal(rotated.status, 200);
  const rotatedCookie = rotated.headers.get('set-cookie').split(';')[0];
  assert.notEqual(rotatedCookie, cookie);
  assert.equal((await send('/auth/session', { cookie })).status, 401);
  assert.equal((await send('/me', { cookie: rotatedCookie })).status, 200);
  f.advance();
  assert.equal((await send('/auth/login', { method: 'POST', body: { username: 'administrator', password: PASSWORD } })).status, 401);
  assert.equal((await send('/auth/login', { method: 'POST', body: { username: 'administrator', password: REPLACEMENT } })).status, 200);
  const [[counts]] = await f.pool.query('SELECT (SELECT COUNT(*) FROM drafts) AS drafts, (SELECT COUNT(*) FROM media) AS media, (SELECT COUNT(*) FROM editors_kv) AS editors');
  assert.deepEqual(Object.fromEntries(Object.entries(counts).map(([name, value]) => [name, Number(value)])), { drafts: 0, media: 0, editors: 0 });
});

integration('local-only mode rejects forged Google enablement and last-local disable without changing settings or sessions', async (f) => {
  f.config.googleEnabled = false; f.env.GOOGLE_CLIENT_ID = '';
  assert.equal((await f.bootstrap(await f.arm())).status, 201);
  const session = await f.login(), beforeSettings = await f.store.getSettings();
  const [beforeSessions] = await f.pool.query('SELECT * FROM local_auth_sessions ORDER BY token_hash');
  for (const requested of [{ localEnabled: true, googleEnabled: true }, { localEnabled: false, googleEnabled: false }, { localEnabled: false, googleEnabled: true }]) {
    const rejected = await f.call('/auth/settings', { method: 'PUT', cookie: session.cookie, csrf: session.csrf,
      body: { ...requested, currentPassword: PASSWORD, googleAvailable: true, owner: true } });
    assert.equal(rejected.status, 409);
    assert.equal(rejected.headers.has('set-cookie'), false);
    assert.deepEqual(await f.store.getSettings(), beforeSettings);
    const [afterSessions] = await f.pool.query('SELECT * FROM local_auth_sessions ORDER BY token_hash');
    assert.deepEqual(afterSessions, beforeSessions);
    assert.equal((await f.call('/auth/session', { cookie: session.cookie })).status, 200);
  }
  let providerCalls = 0;
  const google = await f.call('/session', { method: 'POST', body: {}, next: async () => { providerCalls++; return Response.json({ unexpected: true }); } });
  assert.equal(google.status, 403); assert.equal(providerCalls, 0);
  const legacyBearer = await makeSession(OWNER_EMAIL, f.env, f.now());
  assert.equal((await f.call('/me', { bearer: legacyBearer })).status, 401);
  assert.equal((await f.call('/auth/settings', { bearer: legacyBearer })).status, 403);
  assert.deepEqual(await f.store.getSettings(), beforeSettings);
  const [afterSessions] = await f.pool.query('SELECT * FROM local_auth_sessions ORDER BY token_hash');
  assert.deepEqual(afterSessions, beforeSessions);
});
