import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import worker, { handle, makeSession, readSession } from '../cms-worker/worker.mjs';

const EMAIL = 'editor@example.test';
const SECRET = 'local-test-signing-key';
const NOW = 1700000000;
const origin = 'https://site.example';
const signText = (text, secret = SECRET) => {
  const body = Buffer.from(text).toString('base64url');
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
};
const sign = (claims, secret) => signText(JSON.stringify(claims), secret);
const envFor = (patch = {}) => {
  const state = { membershipReads: 0, databaseCalls: 0 };
  const env = {
    SESSION_SECRET: SECRET, GOOGLE_CLIENT_ID: 'test-client', ALLOWED_ORIGIN: origin, OWNERS: '',
    EDITORS: { get: async (key) => {
      state.membershipReads++;
      return key === 'people' ? JSON.stringify([{ email: EMAIL, name: 'Editor', publisher: true }]) : null;
    } },
    DB: {
      prepare: () => {
        state.databaseCalls++;
        const statement = { bind: () => statement, first: async () => ({ n: 1 }), all: async () => ({ results: [] }), run: async () => ({ success: true }) };
        return statement;
      },
      batch: async () => [],
    },
    ...patch,
  };
  return { env, state };
};
const req = (path, token, opt = {}) => new Request(`https://worker.example${path}`, {
  ...opt, headers: { Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(opt.headers || {}) },
});
const privateHeaders = (response) => {
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
};

test('session signing refuses absent, empty and non-string secrets rather than deriving a predictable key', async () => {
  const valid = sign({ email: EMAIL, exp: NOW + 60 });
  for (const patch of [
    { SESSION_SECRET: undefined, GITHUB_TOKEN: undefined },
    { SESSION_SECRET: '', GITHUB_TOKEN: '' },
    { SESSION_SECRET: ' \n ', GITHUB_TOKEN: '  ' },
    { SESSION_SECRET: 123, GITHUB_TOKEN: {} },
  ]) {
    const { env, state } = envFor(patch);
    await assert.rejects(makeSession(EMAIL, env, NOW * 1000), /Session signing is not configured/);
    await assert.rejects(readSession(valid, env, NOW), /Session signing is not configured/);
    assert.equal(state.membershipReads, 0);
    assert.equal(state.databaseCalls, 0);
  }
});

test('valid sessions retain the existing dedicated-key and GitHub-token fallback formats', async () => {
  const { env } = envFor();
  const claims = { email: EMAIL, exp: NOW + 12 * 3600 };
  assert.equal(await makeSession(EMAIL, env, NOW * 1000), sign(claims));
  assert.equal(await readSession(sign(claims), env, NOW), EMAIL);

  const githubToken = 'local-test-github-token';
  const fallbackSecret = `session:${createHash('sha256').update(githubToken).digest('hex')}`;
  const fallback = envFor({ SESSION_SECRET: undefined, GITHUB_TOKEN: githubToken }).env;
  assert.equal(await makeSession(EMAIL, fallback, NOW * 1000), sign(claims, fallbackSecret));
  assert.equal(await readSession(sign(claims, fallbackSecret), fallback, NOW), EMAIL);
  assert.equal(await readSession(sign(claims), { ...env, GITHUB_TOKEN: 'changed-but-dedicated-key-remains' }, NOW), EMAIL);
  assert.equal(await readSession(sign(claims), { ...env, SESSION_SECRET: 'rotated-test-key' }, NOW), null);
});

test('malformed, oversized and ambiguous bearer tokens are unauthenticated before membership or database work', async () => {
  const valid = sign({ email: EMAIL, exp: NOW + 60 });
  const [body, signature] = valid.split('.');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const noncanonicalSignature = signature.slice(0, -1) + alphabet[alphabet.indexOf(signature.at(-1)) + 1];
  const { env, state } = envFor();
  for (const token of [
    undefined, null, 123, {}, '', 'x.!', 'missing-signature', `${valid}.extra`, `${valid}.`,
    `.${signature}`, `${body}.${signature}=`, `${body}.${signature.slice(1)}`, `${body}.${noncanonicalSignature}`,
    `${'a'.repeat(4096)}.${signature}`, signText('{broken json'), signText('null'), signText('[]'),
  ]) assert.equal(await readSession(token, env, NOW), null);
  assert.equal(state.membershipReads, 0);
  assert.equal(state.databaseCalls, 0);

  const response = await worker.fetch(req('/me', 'x.!'), env);
  assert.equal(response.status, 401);
  privateHeaders(response);
  assert.equal(state.databaseCalls, 0);
});

test('signed sessions still require a valid identity and finite integer expiry', async () => {
  const { env, state } = envFor();
  const good = { email: EMAIL, exp: NOW + 60 };
  for (const patch of [
    { email: null }, { email: 42 }, { email: '' }, { email: 'not-an-email' },
    { email: ` ${EMAIL}` }, { email: 'EDITOR@example.test' }, { email: `${'a'.repeat(250)}@example.test` },
    { exp: String(NOW + 60) }, { exp: null }, { exp: NOW }, { exp: NOW - 1 },
    { exp: NOW + 0.5 }, { exp: Number.MAX_SAFE_INTEGER + 1 },
  ]) assert.equal(await readSession(sign({ ...good, ...patch }), env, NOW), null);
  assert.equal(state.membershipReads, 0);
  assert.equal(state.databaseCalls, 0);
  await assert.rejects(makeSession('not-an-email', env), /Invalid session identity/);
  await assert.rejects(makeSession(EMAIL, env, NaN), /Invalid session time/);
});

test('membership is rechecked and database failures remain server errors', async () => {
  const { env } = envFor();
  const token = await makeSession(EMAIL, env);
  assert.equal(await readSession(token, env), EMAIL);
  assert.equal(await readSession(token, { ...env, EDITORS: { get: async () => '[]' } }), null);

  const broken = { ...env, DB: { prepare: () => ({}), batch: async () => { throw new Error('test database unavailable'); } } };
  await assert.rejects(handle(req('/me', token), broken), /test database unavailable/);
  const response = await worker.fetch(req('/me', token), broken);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { message: 'שגיאה בשרת העריכה' });
  privateHeaders(response);
});

test('login and private JSON responses forbid caching without changing public media caching', async (t) => {
  const { env } = envFor();
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.ok(String(url).startsWith('https://oauth2.googleapis.com/tokeninfo?access_token='));
    return Response.json({ aud: env.GOOGLE_CLIENT_ID, email: EMAIL, email_verified: 'true', expires_in: '3000' });
  });
  const login = await handle(req('/session', null, { method: 'POST', body: JSON.stringify({ access_token: 'local-test-access-token' }) }), env);
  assert.equal(login.status, 200);
  privateHeaders(login);
  const { token } = await login.json();
  for (const path of ['/me', '/changes', '/log']) {
    const response = await handle(req(path, token), env);
    assert.equal(response.status, 200);
    privateHeaders(response);
  }
  const unconfigured = { ...env, SESSION_SECRET: undefined, GITHUB_TOKEN: undefined };
  const response = await worker.fetch(req('/me', token), unconfigured);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { message: 'שגיאה בשרת העריכה' });
  privateHeaders(response);

  const media = { ...env, MEDIA: {
    head: async () => ({ size: 4, httpMetadata: { contentType: 'video/mp4' } }),
    get: async () => ({ body: new Uint8Array([1, 2, 3, 4]) }),
  } };
  const publicResponse = await handle(new Request('https://worker.example/m/test.mp4'), media);
  assert.equal(publicResponse.status, 200);
  assert.equal(publicResponse.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');
  assert.equal(publicResponse.headers.get('X-Content-Type-Options'), 'nosniff');
});
