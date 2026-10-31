// Real MySQL only: every test owns an isolated loopback database. Google proof
// cryptography has separate tests; these fixtures never contact an OAuth service.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import worker, { makeSession, readSession } from '../cms-worker/worker.mjs';
import { createLocalAuth } from '../server/local-auth.mjs';
import { GoogleProofError } from '../server/google-auth-proof.mjs';
import { digestToken, randomToken } from '../server/local-auth-crypto.mjs';
import { createMysqlAuthStore } from '../server/mysql-auth-store.mjs';
import { createMysqlDataStore } from '../server/mysql-store.mjs';
import { createMysqlKv } from '../server/mysql-kv.mjs';
import { createMysqlRateLimitStore } from '../server/mysql-rate-limit.mjs';
import { createInitializedMysqlPool } from '../server/mysql-pool.mjs';
import { initializeLocalAuthSchema } from '../scripts/setup-local-auth.mjs';
import { initializeGoogleAuthSchema } from '../scripts/setup-google-auth.mjs';
import { runtimeHandler } from '../server/runtime.mjs';
import { mysqlEnabled, withMysqlDatabase } from './helpers/mysql.mjs';

const ORIGIN = 'https://preview.example.test';
const OWNER_EMAIL = 'existing-owner@example.test';
const OWNER_HASH = digestToken(OWNER_EMAIL);
const OTHER_OWNER_EMAIL = 'another-owner@example.test';
const OTHER_OWNER_HASH = digestToken(OTHER_OWNER_EMAIL);
const PASSWORD = 'Google setup test password only 123!';
const REPLACEMENT = 'Replacement test password only 456!';
const CLIENT_A = '123456789012-testclientaaaaaaaa.apps.googleusercontent.com';
const CLIENT_B = '123456789012-testclientbbbbbbbb.apps.googleusercontent.com';
const ENDPOINTS = ['/auth/google/prepare', '/auth/google/verify', '/auth/google/activate'];
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
async function accepted(response, status = 200) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}
async function rejected(response) {
  assert(response.status >= 400 && response.status < 500, `Expected a client rejection, received ${response.status}: ${await response.clone().text()}`);
  assert.equal(response.headers.has('set-cookie'), false);
}

const integration = (name, fn) => test(name, { skip: !mysqlEnabled }, () => withMysqlDatabase(async ({ pool: raw, database }) => {
  const pool = createInitializedMysqlPool(raw);
  for (const initialize of [initializeLocalAuthSchema, initializeGoogleAuthSchema]) {
    const plan = await initialize(null);
    await initialize(pool, { apply: true, targetDatabase: database, expectedSchemaSha256: plan.schemaSha256 });
  }
  const store = createMysqlAuthStore(pool, { googleSetup: true });
  let now = Date.now();
  const env = {
    OWNERS: `${OWNER_HASH},${OTHER_OWNER_HASH}`, SESSION_SECRET: randomBytes(48).toString('hex'), ALLOWED_ORIGIN: ORIGIN,
    // A configured legacy ID must not activate or override the managed setting.
    GOOGLE_CLIENT_ID: '123456789012-legacyfixtureonly.apps.googleusercontent.com', GITHUB_TOKEN: 'unused-test-provider-placeholder',
    DATA_STORE: createMysqlDataStore(pool), EDITORS: createMysqlKv(pool), RATE_LIMIT_STORE: createMysqlRateLimitStore(pool), CLIENT_IP: () => '127.0.0.1',
  };
  const config = { env, publicOrigin: ORIGIN, apiBasePath: '/cms-api', localAuthEnabled: true, googleSetupEnabled: true,
    googleEnabled: true, staging: true, readOnly: true, publishEnabled: false };
  const proofs = new Map(), proofCalls = [];
  const verifyFixture = async (credential, options) => {
    const proof = proofs.get(credential);
    if (!proof || proof.clientId !== options.clientId || proof.nonceHash !== options.nonceHash) throw new GoogleProofError();
    return proof.claims;
  };
  let verifier = verifyFixture;
  const googleProofVerifier = async (credential, options) => {
    proofCalls.push({ credential, options });
    return verifier(credential, options);
  };
  const service = createLocalAuth({ store, config, clock: () => now, googleProofVerifier });
  const call = (path, { method = 'GET', body, cookie, csrf, bearer, origin = ORIGIN, next = worker.fetch, handler } = {}) => {
    const headers = new Headers();
    if (origin !== null) headers.set('Origin', origin);
    if (cookie) headers.set('Cookie', cookie);
    if (csrf) headers.set('X-CSRF-Token', csrf);
    if (bearer) headers.set('Authorization', `Bearer ${bearer}`);
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    const request = new Request(ORIGIN + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return handler ? handler(request, env) : service.handle(request, env, next);
  };
  const advance = (milliseconds = 60_000) => { now += milliseconds; };
  const login = async (password = PASSWORD, username = 'administrator') => {
    const response = await call('/auth/login', { method: 'POST', body: { username, password } });
    const body = await accepted(response);
    return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: body.csrfToken, body };
  };
  const ownerSession = async () => {
    const code = randomToken();
    await store.atomic(async (tx) => tx.saveSettings({ ...await tx.getSettings(), bootstrap_hash: digestToken(code), bootstrap_expires: now + 900_000, bootstrap_owner_hash: OWNER_HASH }));
    await accepted(await call('/auth/bootstrap', { method: 'POST', body: { code, username: 'administrator', displayName: 'מנהל בדיקות', password: PASSWORD } }), 201);
    return login();
  };
  const mutation = (path, session, body, extra = {}) => call(path, { method: 'POST', cookie: session.cookie, csrf: session.csrf, body, ...extra });
  const prepare = async (session, clientId = CLIENT_A, extra = {}) => {
    advance(); // Each deliberate password check gets a fresh account-limit window.
    return accepted(await mutation('/auth/google/prepare', session, { clientId, currentPassword: PASSWORD }, extra));
  };
  const proof = (prepared, claims = {}) => {
    const credential = randomToken();
    proofs.set(credential, { clientId: prepared.clientId, nonceHash: digestToken(prepared.nonce),
      claims: { email: OWNER_EMAIL, ownerHash: OWNER_HASH, subject: 'test-owner-google-subject', ...claims } });
    return credential;
  };
  const verify = async (session, prepared, extra = {}) => accepted(await mutation('/auth/google/verify', session, { credential: proof(prepared), revision: prepared.revision }, extra));
  const activate = async (session, verified, extra = {}) => accepted(await mutation('/auth/google/activate', session, { revision: verified.revision, currentPassword: PASSWORD }, extra));
  const activateClient = async (session, clientId = CLIENT_A) => activate(session, await verify(session, await prepare(session, clientId)));
  const snapshot = async () => ({ settings: await store.getSettings(), google: await store.getGoogleConfig(),
    sessions: (await pool.query('SELECT * FROM local_auth_sessions ORDER BY token_hash'))[0],
    users: (await pool.query('SELECT * FROM local_auth_users ORDER BY id'))[0] });
  const providerSession = async (extra = {}) => {
    let delegatedEnv;
    const response = await call('/session', { method: 'POST', body: { credential: 'provider-fixture-only' }, next: async (_request, activeEnv) => {
      delegatedEnv = activeEnv;
      return Response.json({ token: await makeSession(OWNER_EMAIL, activeEnv, now), email: OWNER_EMAIL, owner: true, publisher: true, name: 'Existing owner' });
    }, ...extra });
    return { ...await accepted(response), delegatedEnv };
  };
  await fn({ pool, store, env, config, service, call, mutation, login, ownerSession, prepare, proof, verify, activate, activateClient, snapshot,
    providerSession, proofCalls, verifyFixture, googleProofVerifier, setVerifier: (value) => { verifier = value; }, advance, now: () => now });
}));

integration('managed Google starts inactive and only exposes the active client in public options', async (f) => {
  const options = await accepted(await f.call('/auth/options'));
  assert.equal(options.googleManaged, true); assert.equal(options.googleEnabled, false); assert.equal(options.googleClientId, '');
  assert.equal(options.googleRevision, (await f.store.getGoogleConfig()).active_version);
  let providerCalls = 0;
  await rejected(await f.call('/session', { method: 'POST', body: {}, next: async () => { providerCalls++; return Response.json({}); } }));
  assert.equal(providerCalls, 0);
  const session = await f.ownerSession(), before = await f.snapshot();
  const settings = await accepted(await f.call('/auth/settings', { cookie: session.cookie }));
  assert.equal(typeof settings.googleSetup, 'object'); assert(settings.googleSetup);
  assert.equal(settings.googleEnabled, false); assert.equal(settings.localEnabled, true);
  await rejected(await f.call('/auth/settings', { method: 'PUT', ...session,
    body: { localEnabled: true, googleEnabled: true, currentPassword: PASSWORD } }));
  assert.deepEqual(await f.snapshot(), before);
  const legacy = await makeSession(OWNER_EMAIL, f.env, f.now());
  assert.equal((await f.call('/me', { bearer: legacy })).status, 401);
});

integration('Google setup requires a local owner, current Origin and matching CSRF at every endpoint', async (f) => {
  const owner = await f.ownerSession();
  await f.store.atomic(async (tx) => tx.insertUser({ ...await tx.getUserByUsername('administrator'), id: randomBytes(16).toString('hex'), username: 'editor', role: 'editor' }));
  const editor = await f.login(PASSWORD, 'editor'), before = await f.snapshot();
  for (const path of ENDPOINTS) {
    const body = { clientId: CLIENT_A, currentPassword: PASSWORD, credential: 'untrusted', revision: 1, owner: true, role: 'owner' };
    for (const identity of [{}, editor, { cookie: owner.cookie }, { ...owner, csrf: 'incorrect-csrf' }, { ...owner, origin: null }, { ...owner, origin: 'https://foreign.example.test' }]) {
      await rejected(await f.call(path, { method: 'POST', ...identity, body }));
    }
  }
  assert.equal(f.proofCalls.length, 0); assert.deepEqual(await f.snapshot(), before);
  await f.activateClient(owner);
  const google = await f.providerSession(), active = await f.snapshot();
  for (const path of ENDPOINTS) await rejected(await f.call(path, { method: 'POST', bearer: google.token,
    body: { clientId: CLIENT_B, currentPassword: PASSWORD, credential: 'untrusted', revision: active.google.revision } }));
  assert.deepEqual(await f.snapshot(), active);
});

integration('Google preparation validates credentials and stores only a session-bound nonce digest', async (f) => {
  const session = await f.ownerSession(), before = await f.snapshot();
  for (const body of [
    { clientId: CLIENT_A, currentPassword: REPLACEMENT },
    { clientId: 'https://accounts.google.com/client-id', currentPassword: PASSWORD },
    { clientId: `${CLIENT_A}.evil.test`, currentPassword: PASSWORD },
  ]) {
    f.advance();
    await rejected(await f.mutation('/auth/google/prepare', session, body));
    assert.deepEqual(await f.snapshot(), before);
  }
  const prepared = await f.prepare(session), stored = await f.store.getGoogleConfig();
  assert.equal(prepared.clientId, CLIENT_A); assert.match(prepared.nonce, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(prepared.revision, stored.revision); assert(prepared.revision > before.google.revision);
  assert(prepared.expiresAt > f.now()); assert.equal(prepared.expiresAt, stored.pending_expires_at);
  assert.equal(stored.pending_nonce_hash, digestToken(prepared.nonce));
  assert.equal(stored.pending_session_hash, digestToken(session.cookie.split('=')[1]));
  assert.equal(stored.pending_user_id, before.users[0].id); assert.equal(stored.pending_user_version, 1); assert.equal(stored.pending_owner_hash, OWNER_HASH);
  assert.equal(stored.active_client_id, null); assert.equal(stored.active_version, before.google.active_version);
  const publicOptions = await accepted(await f.call('/auth/options'));
  assert.equal(publicOptions.googleClientId, ''); assert.equal(publicOptions.googleEnabled, false);
  const settings = await accepted(await f.call('/auth/settings', { cookie: session.cookie }));
  for (const privateValue of [prepared.nonce, PASSWORD, stored.pending_nonce_hash, stored.pending_session_hash]) assert.equal(JSON.stringify(settings).includes(privateValue), false);
  await rejected(await f.mutation('/auth/google/activate', session, { revision: prepared.revision, currentPassword: PASSWORD }));
  assert.deepEqual(await f.store.getGoogleConfig(), stored);
});

integration('Google proof must match this local owner even when another verified Google owner is allowed', async (f) => {
  const session = await f.ownerSession(), prepared = await f.prepare(session), before = await f.snapshot();
  for (const claims of [
    { email: 'editor@example.test', ownerHash: digestToken('editor@example.test') },
    { email: OTHER_OWNER_EMAIL, ownerHash: OTHER_OWNER_HASH },
  ]) {
    const credential = f.proof(prepared, claims);
    await rejected(await f.mutation('/auth/google/verify', session, { credential, revision: prepared.revision }));
    assert.deepEqual(await f.snapshot(), before);
  }
  const verified = await f.verify(session, prepared), call = f.proofCalls.at(-1), stored = await f.store.getGoogleConfig();
  assert.equal(call.options.clientId, CLIENT_A); assert.equal(call.options.nonceHash, digestToken(prepared.nonce));
  assert.equal(call.options.issuedAt, before.google.pending_issued_at); assert.equal(call.options.expiresAt, prepared.expiresAt);
  assert.equal(verified.verified, true); assert.equal(verified.clientId, CLIENT_A); assert(verified.revision > prepared.revision);
  assert(verified.verifiedUntil > f.now()); assert(verified.verifiedUntil <= prepared.expiresAt);
  assert.equal(stored.pending_nonce_hash, null); assert.equal(stored.verified_until, verified.verifiedUntil);
  assert.equal(stored.active_client_id, null);
  await rejected(await f.mutation('/auth/google/verify', session, { credential: call.credential, revision: prepared.revision }));
  await rejected(await f.mutation('/auth/google/verify', session, { credential: call.credential, revision: verified.revision }));
  assert.deepEqual(await f.store.getGoogleConfig(), stored);
});

integration('Google proof and activation cannot cross sessions or survive a replacement preparation', async (f) => {
  const first = await f.ownerSession(), second = await f.login();
  const prepared = await f.prepare(first), credential = f.proof(prepared), before = await f.snapshot();
  await rejected(await f.mutation('/auth/google/verify', second, { credential, revision: prepared.revision }));
  assert.deepEqual(await f.snapshot(), before);
  const replacement = await f.prepare(second, CLIENT_B), replaced = await f.snapshot();
  await rejected(await f.mutation('/auth/google/verify', first, { credential, revision: prepared.revision }));
  await rejected(await f.mutation('/auth/google/verify', second, { credential, revision: replacement.revision }));
  assert.deepEqual(await f.snapshot(), replaced);
  const verified = await f.verify(second, replacement), verifiedState = await f.snapshot();
  await rejected(await f.mutation('/auth/google/activate', first, { revision: verified.revision, currentPassword: PASSWORD }));
  assert.deepEqual(await f.snapshot(), verifiedState);
  const activated = await f.activate(second, verified);
  assert.equal(activated.clientId, CLIENT_B);
});

integration('expired Google challenges and verified proofs cannot activate a login method', async (f) => {
  const session = await f.ownerSession(), prepared = await f.prepare(session);
  f.advance(prepared.expiresAt - f.now() + 1);
  const expiredChallenge = await f.snapshot();
  await rejected(await f.mutation('/auth/google/verify', session, { credential: f.proof(prepared), revision: prepared.revision }));
  assert.deepEqual(await f.snapshot(), expiredChallenge);
  const next = await f.prepare(session), verified = await f.verify(session, next);
  f.advance(verified.verifiedUntil - f.now() + 1);
  const expiredProof = await f.snapshot();
  await rejected(await f.mutation('/auth/google/activate', session, { revision: verified.revision, currentPassword: PASSWORD }));
  assert.deepEqual(await f.snapshot(), expiredProof);
});

integration('Google activation consumes one proof atomically and preserves the local identity and content', async (f) => {
  await f.env.EDITORS.put('owner-names', JSON.stringify({ [OWNER_HASH]: 'בעלים קיים' }));
  await f.env.EDITORS.put('people', JSON.stringify([{ email: 'editor@example.test', name: 'Existing editor', publisher: false }]));
  const ownerConfiguration = f.env.OWNERS;
  const identityData = [await f.env.EDITORS.get('owner-names'), await f.env.EDITORS.get('people')];
  const session = await f.ownerSession(), users = (await f.snapshot()).users;
  const verified = await f.verify(session, await f.prepare(session));
  const results = await Promise.all([1, 2].map(() => f.mutation('/auth/google/activate', session, { revision: verified.revision, currentPassword: PASSWORD })));
  assert.equal(results.filter((response) => response.status === 200).length, 1);
  for (const response of results.filter((value) => value.status !== 200)) await rejected(response);
  const activated = await results.find((response) => response.status === 200).json(), after = await f.snapshot();
  assert.equal(activated.activated, true); assert.equal(activated.clientId, CLIENT_A); assert.equal(activated.googleRevision, after.google.active_version);
  assert.equal(after.google.active_client_id, CLIENT_A); assert.equal(after.google.pending_client_id, null);
  assert.equal(after.google.pending_nonce_hash, null); assert.equal(after.google.verified_until, 0);
  assert.equal(after.settings.local_enabled, true); assert.equal(after.settings.local_verified, true); assert.equal(after.settings.google_enabled, true);
  assert.deepEqual(after.users, users); assert.equal(f.env.OWNERS, ownerConfiguration);
  assert.deepEqual([await f.env.EDITORS.get('owner-names'), await f.env.EDITORS.get('people')], identityData);
  assert.equal((await f.call('/auth/session', { cookie: session.cookie })).status, 200);
  await rejected(await f.mutation('/auth/google/activate', session, { revision: verified.revision, currentPassword: PASSWORD }));
  assert.deepEqual(await f.snapshot(), after);
  const [[counts]] = await f.pool.query('SELECT (SELECT COUNT(*) FROM drafts) AS drafts, (SELECT COUNT(*) FROM media) AS media');
  assert.deepEqual(Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, Number(value)])), { drafts: 0, media: 0 });
});

integration('Google activation rechecks local verification and the current local password', async (f) => {
  const session = await f.ownerSession(), verified = await f.verify(session, await f.prepare(session));
  const before = await f.snapshot();
  await rejected(await f.mutation('/auth/google/activate', session, { revision: verified.revision, currentPassword: REPLACEMENT }));
  assert.deepEqual(await f.snapshot(), before);
  await f.store.atomic(async (tx) => tx.saveSettings({ ...await tx.getSettings(), local_verified: false }));
  const unverified = await f.snapshot();
  await rejected(await f.mutation('/auth/google/activate', session, { revision: verified.revision, currentPassword: PASSWORD }));
  assert.deepEqual(await f.snapshot(), unverified);
});

integration('pending Google replacement preserves the active client and existing managed sessions', async (f) => {
  const session = await f.ownerSession(), activated = await f.activateClient(session), google = await f.providerSession();
  assert.equal(google.delegatedEnv.GOOGLE_CLIENT_ID, CLIENT_A);
  assert.notEqual(google.delegatedEnv.SESSION_SECRET, f.env.SESSION_SECRET);
  assert.equal(google.delegatedEnv.CLIENT_IP(), '127.0.0.1');
  assert.equal(await readSession(google.token, f.env), null, 'managed tokens do not authenticate directly in the legacy Worker');
  assert.equal((await f.call('/me', { bearer: google.token })).status, 200);
  const legacy = await makeSession(OWNER_EMAIL, f.env, f.now());
  assert.equal((await f.call('/me', { bearer: legacy })).status, 401);
  const prepared = await f.prepare(session, CLIENT_B), pendingOptions = await accepted(await f.call('/auth/options'));
  assert.equal(pendingOptions.googleEnabled, true); assert.equal(pendingOptions.googleClientId, CLIENT_A); assert.equal(pendingOptions.googleRevision, activated.googleRevision);
  const verified = await f.verify(session, prepared);
  assert.equal((await f.call('/me', { bearer: google.token })).status, 200);
  assert.equal((await f.providerSession()).delegatedEnv.GOOGLE_CLIENT_ID, CLIENT_A);
  await f.activate(session, verified);
  assert.equal((await f.call('/me', { bearer: google.token })).status, 401);
  assert.equal((await f.providerSession()).delegatedEnv.GOOGLE_CLIENT_ID, CLIENT_B);
});

integration('managed session epochs reject old tokens after A to B to A and after disablement', async (f) => {
  let session = await f.ownerSession();
  const first = await f.activateClient(session, CLIENT_A), a = await f.providerSession();
  const second = await f.activateClient(session, CLIENT_B), b = await f.providerSession();
  const third = await f.activateClient(session, CLIENT_A), finalA = await f.providerSession();
  assert(first.googleRevision < second.googleRevision); assert(second.googleRevision < third.googleRevision);
  for (const token of [a.token, b.token]) assert.equal((await f.call('/me', { bearer: token })).status, 401);
  assert.equal((await f.call('/me', { bearer: finalA.token })).status, 200);
  const alternateOrigin = 'https://another-preview.example.test';
  const alternateEnv = { ...f.env, ALLOWED_ORIGIN: alternateOrigin };
  const alternateService = createLocalAuth({ store: f.store, config: { ...f.config, env: alternateEnv, publicOrigin: alternateOrigin }, clock: f.now, googleProofVerifier: f.googleProofVerifier });
  assert.equal((await alternateService.handle(new Request(alternateOrigin + '/me', { headers: { Origin: alternateOrigin, Authorization: `Bearer ${finalA.token}` } }), alternateEnv, worker.fetch)).status, 401);
  const before = await f.snapshot();
  await rejected(await f.call('/auth/settings', { method: 'PUT', ...session, body: { localEnabled: true, googleEnabled: false, currentPassword: REPLACEMENT } }));
  assert.deepEqual(await f.snapshot(), before);
  f.advance();
  const disabled = await f.call('/auth/settings', { method: 'PUT', ...session, body: { localEnabled: true, googleEnabled: false, currentPassword: PASSWORD } });
  const settings = await accepted(disabled);
  session = { cookie: disabled.headers.get('set-cookie').split(';')[0], csrf: settings.csrfToken };
  assert.equal(settings.localEnabled, true); assert.equal(settings.googleEnabled, false);
  assert((await f.store.getGoogleConfig()).active_version > third.googleRevision);
  assert.equal((await f.call('/me', { bearer: finalA.token })).status, 401);
  const disabledOptions = await accepted(await f.call('/auth/options'));
  assert.equal(disabledOptions.googleEnabled, false); assert.equal(disabledOptions.googleClientId, '');
  const disabledState = await f.snapshot();
  await rejected(await f.call('/auth/settings', { method: 'PUT', ...session, body: { localEnabled: true, googleEnabled: true, currentPassword: PASSWORD } }));
  assert.deepEqual(await f.snapshot(), disabledState);
  await f.activateClient(session, CLIENT_A);
  for (const token of [a.token, b.token, finalA.token]) assert.equal((await f.call('/me', { bearer: token })).status, 401);
});

for (const interruption of ['logout', 'password rotation', 'replacement configuration', 'challenge expiry']) {
  integration(`in-flight Google proof is rejected after ${interruption}`, async (f) => {
    const session = await f.ownerSession(), prepared = await f.prepare(session), credential = f.proof(prepared);
    const entered = deferred(), release = deferred();
    f.setVerifier(async (...args) => { entered.resolve(); await release.promise; return f.verifyFixture(...args); });
    const verifying = f.mutation('/auth/google/verify', session, { credential, revision: prepared.revision });
    await Promise.race([entered.promise, verifying.then((response) => { throw new Error(`Proof did not reach verifier: ${response.status}`); })]);
    try {
      if (interruption === 'logout') await accepted(await f.mutation('/auth/logout', session, {}));
      else if (interruption === 'password rotation') await accepted(await f.mutation('/auth/password', session, { currentPassword: PASSWORD, newPassword: REPLACEMENT }));
      else if (interruption === 'replacement configuration') await f.prepare(session, CLIENT_B);
      else f.advance(prepared.expiresAt - f.now() + 1);
      const interrupted = await f.snapshot();
      release.resolve();
      await rejected(await verifying);
      assert.deepEqual(await f.snapshot(), interrupted);
      assert.equal((await f.store.getGoogleConfig()).verified_until, 0);
      assert.equal((await f.call('/auth/options').then((response) => response.json())).googleEnabled, false);
    } finally { release.resolve(); await verifying; }
  });
}

integration('ordinary Google login rejects an activation change during provider verification without marking recent proof', async (f) => {
  const session = await f.ownerSession();
  await f.activateClient(session, CLIENT_A);
  const entered = deferred(), release = deferred();
  const signingIn = f.call('/session', { method: 'POST', body: { credential: 'provider-fixture-only' }, next: async (_request, activeEnv) => {
    assert.equal(activeEnv.GOOGLE_CLIENT_ID, CLIENT_A);
    const token = await makeSession(OWNER_EMAIL, activeEnv, f.now());
    entered.resolve(); await release.promise;
    return Response.json({ token, email: OWNER_EMAIL, owner: true, publisher: true, name: 'Existing owner' });
  } });
  await Promise.race([entered.promise, signingIn.then((response) => { throw new Error(`Login did not reach provider: ${response.status}`); })]);
  try {
    await f.activateClient(session, CLIENT_B);
    const replaced = await f.snapshot();
    assert.equal(replaced.settings.google_verified_until, 0);
    release.resolve();
    await rejected(await signingIn);
    assert.deepEqual(await f.snapshot(), replaced);
  } finally { release.resolve(); await signingIn; }
});

integration('read-only Node wrapper admits only the exact Google setup writes and leaves content untouched', async (f) => {
  const session = await f.ownerSession();
  const handler = runtimeHandler(f.config, (request, env) => f.service.handle(request, env, worker.fetch));
  const prepared = await f.prepare(session, CLIENT_A, { handler });
  const verified = await f.verify(session, prepared, { handler });
  const activated = await f.activate(session, verified, { handler });
  assert.equal(activated.activated, true);
  for (const [path, method] of [
    ['/auth/google/prepare/extra', 'POST'], ['/auth/google/verify/extra', 'POST'], ['/auth/google/activate/extra', 'POST'],
    ['/auth/google/prepare', 'PUT'], ['/auth/google/verify', 'DELETE'], ['/auth/google/activate', 'PUT'],
    ['/gh/contents/data/topics.json', 'PUT'], ['/editors', 'PUT'], ['/media/init', 'POST'], ['/publish', 'POST'],
  ]) {
    const response = await f.call(path, { method, ...session, body: {}, handler });
    assert.equal(response.status, 503); assert.equal(response.headers.get('cache-control'), 'no-store'); assert.match(response.headers.get('x-robots-tag'), /noindex/);
  }
  let disabledFeatureCalls = 0;
  const disabledFeatureHandler = runtimeHandler({ ...f.config, googleSetupEnabled: false }, async () => { disabledFeatureCalls++; return Response.json({}); });
  for (const path of ENDPOINTS) assert.equal((await f.call(path, { method: 'POST', ...session, body: {}, handler: disabledFeatureHandler })).status, 503);
  assert.equal(disabledFeatureCalls, 0);
  const [[counts]] = await f.pool.query('SELECT (SELECT COUNT(*) FROM drafts) AS drafts, (SELECT COUNT(*) FROM media) AS media, (SELECT COUNT(*) FROM editors_kv) AS editors');
  assert.deepEqual(Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, Number(value)])), { drafts: 0, media: 0, editors: 0 });
});
