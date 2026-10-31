// Real HTTP/auth boundaries with an isolated MySQL database, never hosting data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalAuth } from '../server/local-auth.mjs';
import { renderAuthInvitation } from '../server/auth-invitation.mjs';
import { hashPassword, verifyPassword, digestToken, randomToken, csrfToken } from '../server/local-auth-crypto.mjs';
import { createMysqlAuthStore } from '../server/mysql-auth-store.mjs';
import { createInitializedMysqlPool } from '../server/mysql-pool.mjs';
import { createMysqlRateLimitStore } from '../server/mysql-rate-limit.mjs';
import { initializeLocalAuthSchema } from '../scripts/setup-local-auth.mjs';
import { initializeLocalInvitationsSchema } from '../scripts/setup-local-invitations.mjs';
import { runtimeHandler } from '../server/runtime.mjs';
import { mysqlEnabled, withMysqlDatabase } from './helpers/mysql.mjs';
import { makeSession } from '../cms-worker/worker.mjs';

const ORIGIN = 'https://invitation.example.test';
const OWNER = digestToken('initial-owner@example.test'), TARGET = digestToken('second-owner@example.test'), THIRD = digestToken('third-owner@example.test');
const PASSWORD = 'Isolated original-owner fixture password 123!';
const NEW_PASSWORD = 'A distinct recipient password with more than sixty four characters: 123!';
let initialHash;
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const integration = (name, run) => test(name, { skip: !mysqlEnabled }, () => withMysqlDatabase(async ({ pool: raw, database }) => {
  const pool = createInitializedMysqlPool(raw);
  for (const initialize of [initializeLocalAuthSchema, initializeLocalInvitationsSchema]) {
    const plan = await initialize(null);
    await initialize(pool, { apply: true, targetDatabase: database, expectedSchemaSha256: plan.schemaSha256 });
  }
  const store = createMysqlAuthStore(pool, { localInvitations: true }); await store.ensureSchema();
  const user = { id: '1'.repeat(32), username: 'original-owner', display_name: 'מנהל מקורי', password_hash: await (initialHash ||= hashPassword(PASSWORD)), owner_hash: OWNER, role: 'owner', version: 1, disabled: false };
  let now = Date.now(), nextCalls = 0;
  const env = { OWNERS: [OWNER, TARGET, THIRD].join(','), SESSION_SECRET: 'isolated-invitation-session-fixture-32-bytes', ALLOWED_ORIGIN: ORIGIN,
    RATE_LIMIT_STORE: createMysqlRateLimitStore(pool), CLIENT_IP: () => '127.0.0.1' };
  const config = { env, publicOrigin: ORIGIN, apiBasePath: '/cms-api', localAuthEnabled: true, localInvitationsEnabled: true, googleEnabled: false, staging: true, readOnly: true, publishEnabled: false };
  const token = randomToken(), csrf = csrfToken(token, env.SESSION_SECRET), cookie = `__Host-heichal_local=${token}`;
  await store.atomic(async (tx) => {
    await tx.insertUser(user);
    await tx.saveSettings({ ...await tx.getSettings(), local_enabled: true, local_verified: true, bootstrap_consumed: true });
    await tx.insertSession({ token_hash: digestToken(token), csrf_hash: digestToken(csrf), user_id: user.id, version: user.version, expires_at: now + 8 * 3600_000 });
  });
  let service;
  const resetService = (extra = {}) => { service = createLocalAuth({ store, config, clock: () => now, ...extra }); };
  resetService();
  const next = () => { nextCalls++; return Response.json({ unexpected: true }); };
  const call = (path, { method = 'GET', body, origin = ORIGIN, cookie: suppliedCookie, csrf: suppliedCsrf, rawBody, contentType = 'application/json' } = {}) => {
    const headers = { ...(origin === null ? {} : { Origin: origin }), ...(suppliedCookie ? { Cookie: suppliedCookie } : {}), ...(suppliedCsrf ? { 'X-CSRF-Token': suppliedCsrf } : {}) };
    if (body !== undefined || rawBody !== undefined) headers['Content-Type'] = contentType;
    const request = new Request(ORIGIN + path, { method, headers, ...(rawBody !== undefined ? { body: rawBody } : body === undefined ? {} : { body: JSON.stringify(body) }) });
    return runtimeHandler(config, (request, currentEnv) => service.handle(request, currentEnv, next))(request, env);
  };
  const create = (email = 'second-owner@example.test', extra = {}) => call('/auth/invitations', { method: 'POST', cookie, csrf, body: { email, currentPassword: PASSWORD }, ...extra });
  const invite = async (email) => { const response = await create(email); assert.equal(response.status, 201, await response.clone().text()); return response.json(); };
  const accept = (code, extra = {}) => call('/auth/invitations/accept', { method: 'POST', body: { code, username: 'recipient', displayName: 'מנהל נוסף', password: NEW_PASSWORD }, ...extra });
  const logout = () => call('/auth/logout', { method: 'POST', cookie, csrf, body: {} });
  await run({ pool, store, env, config, user, token, cookie, csrf, call, create, invite, accept, logout, resetService, now: () => now, advance: (ms = 60000) => { now += ms; }, nextCalls: () => nextCalls });
}));

test('invitation form has explicit POST, a script-disabled submit and no secret URL channel', () => {
  const html = renderAuthInvitation({ apiBasePath: '/cms-api', nonce: 'a'.repeat(24) });
  assert.match(html, /<html lang="he" dir="rtl">/);
  assert.match(html, /<form id="invitation-form" method="post" action="\/cms-api\/auth\/invitations\/accept">/);
  assert.match(html, /id="invitation-submit" type="submit" disabled/);
  assert(html.indexOf("form.addEventListener('submit'") < html.indexOf('submit.disabled = false;'));
  assert.match(html, /event.preventDefault\(\)/);
  assert.match(html, /credentials: 'same-origin', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer'/);
  assert.match(html, /name="password" type="password" autocomplete="new-password"/);
  assert(!/https?:\/\/|URLSearchParams|location\.|localStorage|sessionStorage|<script[^>]+src=/.test(html));
  assert.throws(() => renderAuthInvitation({ apiBasePath: '/cms-api?code=secret', nonce: 'a'.repeat(24) }));
  assert.throws(() => renderAuthInvitation({ apiBasePath: '/cms-api', nonce: '" unsafe' }));
});

test('invitations are disabled by default without touching optional store methods', async () => {
  const config = { env: { OWNERS: OWNER, ALLOWED_ORIGIN: ORIGIN }, publicOrigin: ORIGIN };
  const auth = createLocalAuth({ store: new Proxy({}, { get() { assert.fail('No optional store access while disabled'); } }), config });
  for (const [path, method] of [['/auth/invitation', 'GET'], ['/auth/invitations', 'POST'], ['/auth/invitations/accept', 'POST']]) {
    const response = await auth.handle(new Request(ORIGIN + path, { method }), config.env, () => assert.fail('No Worker delegation'));
    assert.equal(response.status, 404); assert.equal(response.headers.get('cache-control'), 'no-store');
  }
});

integration('invitation creates only an allowlisted owner, survives issuer logout and preserves bootstrap and first owner', async (f) => {
  const settingsBefore = await f.store.getSettings(), userBefore = await f.store.getUserById(f.user.id);
  const response = await f.create('  SECOND-OWNER@EXAMPLE.TEST  '), invitation = await response.json();
  assert.equal(response.status, 201); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow'); assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('set-cookie'), null); assert.match(invitation.code, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(invitation.expiresAt, f.now() + 900000); assert.equal(invitation.setupUrl, ORIGIN + '/cms-api/auth/invitation');
  const persisted = await f.store.getInvitationByHash(digestToken(invitation.code));
  assert.equal(persisted.owner_hash, TARGET); assert(!JSON.stringify(persisted).includes(invitation.code));
  assert.equal((await f.logout()).status, 200);
  const accepted = await f.accept(invitation.code, { body: { code: invitation.code, username: 'Recipient', displayName: 'מנהל נוסף', password: NEW_PASSWORD, role: 'editor', owner_hash: OWNER, email: 'someone-else@example.test' } });
  assert.equal(accepted.status, 201, await accepted.clone().text()); assert.deepEqual(await accepted.json(), { created: true });
  assert.equal(accepted.headers.get('set-cookie'), null); assert.equal(accepted.headers.get('cache-control'), 'no-store');
  const recipient = await f.store.getUserByUsername('recipient');
  assert.equal(recipient.role, 'owner'); assert.equal(recipient.owner_hash, TARGET); assert.equal(recipient.version, 1); assert.equal(recipient.disabled, false);
  assert(await verifyPassword(NEW_PASSWORD, recipient.password_hash)); assert(!recipient.password_hash.includes(NEW_PASSWORD));
  assert.deepEqual(await f.store.getSettings(), settingsBefore); assert.deepEqual(await f.store.getUserById(f.user.id), userBefore);
  const [[sessions]] = await f.pool.execute('SELECT COUNT(*) AS n FROM local_auth_sessions'); assert.equal(Number(sessions.n), 0);
  assert.equal((await f.accept(invitation.code)).status, 403); assert.equal((await f.call('/auth/setup', { origin: null })).status, 404);
  const login = await f.call('/auth/login', { method: 'POST', body: { username: 'recipient', password: NEW_PASSWORD } });
  assert.equal(login.status, 200); const logged = await login.json();
  assert.equal(logged.user.email, `local:${recipient.id}`); assert.equal(logged.user.owner, true);
  assert.match(login.headers.get('set-cookie'), /Secure; HttpOnly; SameSite=Strict/);
});

integration('invitation navigation is private by headers and native POST never becomes a credential GET', async (f) => {
  const page = await f.call('/auth/invitation', { origin: null });
  assert.equal(page.status, 200); assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer'); assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.match(page.headers.get('content-security-policy'), /form-action 'none'/); assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
  const html = await page.text(); assert(!html.includes(f.token)); assert(!html.includes(PASSWORD));
  const native = await f.call('/auth/invitations/accept', { method: 'POST', rawBody: 'code=private-fixture&password=private-fixture', contentType: 'application/x-www-form-urlencoded' });
  assert.equal(native.status, 400); assert.equal(native.headers.get('location'), null); assert(!(await native.text()).includes('private-fixture'));
});

integration('invitation creation requires local owner, exact Origin, CSRF and current password without revealing target membership', async (f) => {
  for (const extra of [{ origin: null }, { origin: 'https://foreign.example.test' }, { csrf: undefined }, { csrf: 'wrong' }, { cookie: undefined }]) {
    assert.equal((await f.create(undefined, extra)).status, 403);
  }
  assert.equal((await f.create(undefined, { body: { email: 'second-owner@example.test', currentPassword: 'wrong-password' } })).status, 401);
  const unknown = await f.create('unknown@example.test'), duplicate = await f.create('initial-owner@example.test');
  assert.equal(unknown.status, 403); assert.equal(duplicate.status, 403); assert.deepEqual(await unknown.json(), await duplicate.json());
  const settings = await f.call('/auth/settings', { cookie: f.cookie }); assert.equal((await settings.json()).invitationsAvailable, true);
  await f.pool.execute("UPDATE local_auth_users SET role = 'publisher' WHERE id = ?", [f.user.id]);
  assert.equal((await f.create()).status, 403);
  const [[count]] = await f.pool.execute('SELECT COUNT(*) AS n FROM local_auth_invitations'); assert.equal(Number(count.n), 0);
});

integration('Google owner authentication alone cannot issue a local owner invitation', async (f) => {
  f.config.googleEnabled = true; f.env.GOOGLE_CLIENT_ID = 'isolated-invitation-google-fixture'; f.env.EDITORS = { get: async () => null };
  const bearer = await makeSession('initial-owner@example.test', f.env);
  const auth = createLocalAuth({ store: f.store, config: f.config, clock: f.now });
  const headers = { Origin: ORIGIN, Authorization: 'Bearer ' + bearer, 'Content-Type': 'application/json' };
  const settings = await auth.handle(new Request(ORIGIN + '/auth/settings', { headers }), f.env, () => assert.fail('No delegation'));
  assert.equal(settings.status, 200); assert.equal((await settings.json()).invitationsAvailable, false);
  const response = await auth.handle(new Request(ORIGIN + '/auth/invitations', { method: 'POST', headers, body: JSON.stringify({ email: 'second-owner@example.test', currentPassword: PASSWORD }) }), f.env, () => assert.fail('No delegation'));
  assert.equal(response.status, 403);
});

integration('credential syntax errors disclose only fixed field guidance regardless of private invitation/bootstrap state', async (f) => {
  const invitation = await f.invite(), body = { username: 'email@instead.of.username', displayName: '<unsafe>', password: 'short' };
  const expected = { message: 'בדקו את השדות המסומנים ונסו שוב.', fieldErrors: {
    username: 'שם המשתמש צריך להכיל 3–64 תווים באנגלית: אותיות, ספרות, נקודה, קו תחתון או מקף. אין להשתמש בכתובת דוא״ל.',
    displayName: 'שם התצוגה צריך להכיל 1–40 תווים, ללא סימני < > או תווי בקרה.',
    password: 'הסיסמה צריכה להכיל 15–128 תווים, עד 512 בתים.',
  } };
  for (const [path, code] of [['/auth/invitations/accept', invitation.code], ['/auth/invitations/accept', randomToken()], ['/auth/bootstrap', randomToken()]]) {
    const response = await f.call(path, { method: 'POST', body: { ...body, code } });
    assert.equal(response.status, 400); assert.deepEqual(await response.json(), expected);
  }
  assert.equal(await f.store.countUsers(), 1); assert.equal((await f.store.getInvitationByHash(digestToken(invitation.code))).consumed, false);
  const atomic = f.store.atomic;
  f.store.atomic = () => { throw Object.assign(new Error('generic fixture failure'), { status: 400, fieldErrors: { password: 'must-not-leak-private-driver-details' } }); };
  const response = await f.create(); assert.equal(response.status, 400); assert.equal((await response.json()).fieldErrors, undefined);
  f.store.atomic = atomic;
});

for (const reason of ['logout', 'expiry', 'password-version', 'disabled', 'owner-removed']) {
  integration(`creation rechecks live authority after password verification: ${reason}`, async (f) => {
    const entered = deferred(), release = deferred();
    f.resetService({ invitationPasswordHasher: { hashPassword, async verifyPassword(...args) { const ok = await verifyPassword(...args); entered.resolve(); await release.promise; return ok; } } });
    const pending = f.create(); await entered.promise;
    try {
      if (reason === 'logout') assert.equal((await f.logout()).status, 200);
      if (reason === 'expiry') f.advance(8 * 3600_000);
      if (reason === 'password-version') await f.store.atomic(async (tx) => tx.saveUser({ ...await tx.getUserById(f.user.id), version: 2, password_hash: await hashPassword(NEW_PASSWORD) }));
      if (reason === 'disabled') await f.store.atomic(async (tx) => tx.saveUser({ ...await tx.getUserById(f.user.id), version: 2, disabled: true }));
      if (reason === 'owner-removed') f.env.OWNERS = TARGET;
    } finally { release.resolve(); }
    assert.equal((await pending).status, 401);
    const [[count]] = await f.pool.execute('SELECT COUNT(*) AS n FROM local_auth_invitations'); assert.equal(Number(count.n), 0);
  });
}

integration('two concurrent acceptances consume exactly one invitation and neither authenticates automatically', async (f) => {
  const invitation = await f.invite();
  const attempts = await Promise.all(['recipient-a', 'recipient-b'].map((username) => f.accept(invitation.code, { body: { code: invitation.code, username, displayName: 'מנהל', password: NEW_PASSWORD } })));
  assert.deepEqual(attempts.map((r) => r.status).sort(), [201, 403]); assert(attempts.every((r) => !r.headers.has('set-cookie')));
  assert.equal(await f.store.countUsers(), 2); assert.equal((await f.store.getInvitationByHash(digestToken(invitation.code))).consumed, true);
  assert.equal((await f.store.getSettings()).bootstrap_consumed, true);
});

integration('invitations for different owners cannot race into the same username', async (f) => {
  const a = await f.invite(), b = await f.invite('third-owner@example.test');
  const attempts = await Promise.all([f.accept(a.code), f.accept(b.code)]);
  assert.deepEqual(attempts.map((r) => r.status).sort(), [201, 403]); assert.equal(await f.store.countUsers(), 2);
  const invitations = await Promise.all([a, b].map((i) => f.store.getInvitationByHash(digestToken(i.code))));
  assert.equal(invitations.filter((i) => i.consumed).length, 1);
});

for (const reason of ['expiry', 'replacement', 'issuer-version', 'issuer-disabled', 'issuer-owner-removed', 'target-owner-removed', 'local-disabled', 'local-unverified']) {
  integration(`acceptance rechecks private authority after password hashing: ${reason}`, async (f) => {
    const invitation = await f.invite(), entered = deferred(), release = deferred();
    f.resetService({ invitationPasswordHasher: { verifyPassword, async hashPassword(...args) { entered.resolve(); await release.promise; return hashPassword(...args); } } });
    const pending = f.accept(invitation.code); await entered.promise;
    try {
      if (reason === 'expiry') f.advance(900000);
      if (reason === 'replacement') await f.invite();
      if (reason === 'issuer-version') await f.store.atomic(async (tx) => tx.saveUser({ ...await tx.getUserById(f.user.id), version: 2, password_hash: await hashPassword(NEW_PASSWORD) }));
      if (reason === 'issuer-disabled') await f.store.atomic(async (tx) => tx.saveUser({ ...await tx.getUserById(f.user.id), version: 2, disabled: true }));
      if (reason === 'issuer-owner-removed') f.env.OWNERS = TARGET;
      if (reason === 'target-owner-removed') f.env.OWNERS = OWNER;
      if (reason === 'local-disabled') await f.store.atomic(async (tx) => tx.saveSettings({ ...await tx.getSettings(), local_enabled: false }));
      if (reason === 'local-unverified') await f.store.atomic(async (tx) => tx.saveSettings({ ...await tx.getSettings(), local_verified: false }));
    } finally { release.resolve(); }
    assert.equal((await pending).status, 403); assert.equal(await f.store.countUsers(), 1);
  });
}

integration('acceptance is generic, exact-origin and atomically bounded before password hashing', async (f) => {
  const invitation = await f.invite();
  for (const origin of [null, 'https://foreign.example.test']) assert.equal((await f.accept(invitation.code, { origin })).status, 403);
  const invalid = await f.accept(randomToken()), duplicate = await f.accept(invitation.code, { body: { code: invitation.code, username: 'original-owner', displayName: 'מנהל', password: NEW_PASSWORD } });
  assert.equal(invalid.status, 403); assert.equal(duplicate.status, 403); assert.deepEqual(await invalid.json(), await duplicate.json());
  f.advance(); let hashes = 0;
  f.resetService({ invitationPasswordHasher: { verifyPassword, async hashPassword(...args) { hashes++; return hashPassword(...args); } } });
  const rejected = await Promise.all(Array.from({ length: 8 }, () => f.accept(randomToken())));
  assert.equal(rejected.filter((r) => r.status === 403).length, 5); assert.equal(rejected.filter((r) => r.status === 429).length, 3); assert.equal(hashes, 0);
  const [[row]] = await f.pool.execute("SELECT COUNT(*) AS n FROM request_limits WHERE scope = 'login'"); assert.equal(Number(row.n), 1);
});

integration('acceptance rolls back inserted user if invitation consumption fails, without exposing driver details', async (f) => {
  const invitation = await f.invite(), atomic = f.store.atomic;
  f.store.atomic = (fn) => atomic((tx) => fn({ ...tx, saveInvitation: () => { throw new Error('private-driver-details-and-password'); } }));
  const response = await f.accept(invitation.code);
  assert.equal(response.status, 500); assert(!(await response.text()).includes('private-driver'));
  assert.equal(await f.store.countUsers(), 1); assert.equal((await f.store.getInvitationByHash(digestToken(invitation.code))).consumed, false);
});

integration('read-only auth exceptions never enable content, publication or arbitrary invitation endpoints', async (f) => {
  const invitation = await f.invite(); assert.equal((await f.accept(invitation.code)).status, 201);
  for (const [path, method] of [['/publish', 'POST'], ['/editors', 'PUT'], ['/gh/contents/data/topics.json', 'PUT'], ['/auth/invitations/accept/extra', 'POST'], ['/auth/invitations', 'DELETE']]) {
    assert.equal((await f.call(path, { method, body: {}, cookie: f.cookie, csrf: f.csrf })).status, 503);
  }
  assert.equal(f.nextCalls(), 0);
  const [[drafts]] = await f.pool.execute('SELECT COUNT(*) AS n FROM drafts'); assert.equal(Number(drafts.n), 0);
  assert.equal(f.config.readOnly, true); assert.equal(f.config.publishEnabled, false);
});
