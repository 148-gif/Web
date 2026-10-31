import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { CompactSign, SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import { createGoogleProofVerifier, GoogleProofError, googleSessionEnvironment, validGoogleClientId } from '../server/google-auth-proof.mjs';
import { makeSession, readSession } from '../cms-worker/worker.mjs';

const NOW = 1800000000000;
const CLIENT_A = '123456789012-abcdefghijklmnopqrstuvwxyz123456.apps.googleusercontent.com';
const CLIENT_B = '987654321012-abcdefghijklmnopqrstuvwxyz654321.apps.googleusercontent.com';
const ORIGIN = 'https://site.example';
const EMAIL = 'owner@example.test';
const ROOT_SECRET = 'test-only-root-session-secret-at-least-32-bytes';
const nonce = Buffer.alloc(32, 0x5a).toString('base64url');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const challenge = { clientId: CLIENT_A, nonceHash: hash(nonce), issuedAt: NOW - 30000, expiresAt: NOW + 300000 };
const claims = { iss: 'https://accounts.google.com', aud: CLIENT_A, sub: '1234567890', iat: NOW / 1000, exp: NOW / 1000 + 3600, nonce, email: EMAIL, email_verified: true };
const signing = await generateKeyPair('RS256');
const otherSigning = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(signing.publicKey), kid: 'fixture-google-key', alg: 'RS256', use: 'sig' };
const keySet = createLocalJWKSet({ keys: [jwk] });
const verify = createGoogleProofVerifier({ keySet, clock: () => NOW });
const sign = (patch = {}, head = {}, key = signing.privateKey) => new SignJWT({ ...claims, ...patch })
  .setProtectedHeader({ alg: 'RS256', kid: jwk.kid, ...head }).sign(key);
const genericFailure = (error) => {
  assert.ok(error instanceof GoogleProofError);
  assert.equal(error.message, 'Google identity could not be verified');
  assert.equal(error.cause, undefined);
  return true;
};
const reject = async (credential, context = challenge, verifier = verify) => assert.rejects(verifier(await credential, context), genericFailure);

test('real RSA Google proofs normalize the verified email and hash only that identity', async () => {
  for (const issuer of ['https://accounts.google.com', 'accounts.google.com']) {
    assert.deepEqual(await verify(await sign({ iss: issuer, azp: CLIENT_A, email: 'Owner@Example.Test', ownerHash: hash('attacker@example.test') }), challenge), {
      email: EMAIL, ownerHash: hash(EMAIL), subject: claims.sub,
    });
  }
});

test('Google proofs require a matching RSA signature, supported algorithm and known key', async () => {
  await reject(sign({}, {}, otherSigning.privateKey));
  await reject(sign({}, { kid: 'unknown-google-key' }));
  const hmac = await new SignJWT(claims).setProtectedHeader({ alg: 'HS256', kid: jwk.kid }).sign(Buffer.alloc(32, 1));
  await reject(hmac);
  const valid = await sign(), pieces = valid.split('.');
  const tamperedHead = Buffer.from(JSON.stringify({ alg: 'RS256', kid: jwk.kid, jku: 'https://attacker.invalid/keys' })).toString('base64url');
  await reject(`${tamperedHead}.${pieces[1]}.${pieces[2]}`);
  const tamperedBody = Buffer.from(JSON.stringify({ ...claims, email: 'attacker@example.test' })).toString('base64url');
  await reject(`${pieces[0]}.${tamperedBody}.${pieces[2]}`);
});

test('Google issuer, audience and authorized-party claims are exact and unambiguous', async () => {
  for (const patch of [
    { iss: 'https://accounts.google.com/' }, { iss: 'https://attacker.invalid' }, { iss: null },
    { aud: CLIENT_B }, { aud: [CLIENT_A] }, { aud: [CLIENT_A, CLIENT_B] }, { aud: null },
    { azp: CLIENT_B }, { azp: '' }, { azp: null }, { azp: [CLIENT_A] },
  ]) await reject(sign(patch));
});

test('proof expiry is strict and issued-at must fall within the challenge freshness window', async () => {
  for (const patch of [
    { exp: NOW / 1000 }, { exp: NOW / 1000 - 1 }, { exp: '1800003600' }, { exp: null },
    { exp: NOW / 1000 + 0.5 }, { exp: Number.MAX_SAFE_INTEGER + 1 },
    { iat: NOW / 1000 + 61 }, { iat: challenge.issuedAt / 1000 - 61 },
    { iat: NOW / 1000 + 0.5 }, { iat: '1800000000' }, { iat: null }, { iat: 0 },
    { iat: NOW / 1000 + 60, exp: NOW / 1000 + 60 }, { nbf: NOW / 1000 + 61 },
  ]) await reject(sign(patch));
  await verify(await sign({ iat: challenge.issuedAt / 1000 - 60 }), challenge);
  await verify(await sign({ iat: NOW / 1000 + 60 }), challenge);
});

test('missing required proof claims and unexpected payload structures fail closed', async () => {
  for (const key of ['iss', 'aud', 'sub', 'iat', 'exp', 'nonce', 'email', 'email_verified']) await reject(sign({ [key]: undefined }));
  for (const payload of ['null', '[]', '"not-a-claims-object"', '{broken']) {
    const token = await new CompactSign(Buffer.from(payload)).setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).sign(signing.privateKey);
    await reject(token);
  }
});

test('only a bounded verified email and subject can become an owner identity', async () => {
  for (const patch of [
    { email_verified: false }, { email_verified: 'true' }, { email_verified: 1 },
    { email: null }, { email: ['owner@example.test'] }, { email: '' }, { email: 'not-an-email' },
    { email: ` ${EMAIL}` }, { email: `${EMAIL}\n` }, { email: 'owner@example.test\u0000' },
    { email: 'owner..name@example.test' }, { email: '.owner@example.test' }, { email: 'owner.@example.test' },
    { email: `owner@${'a'.repeat(240)}.example.test` }, { email: `${'a'.repeat(65)}@example.test` },
    { email: 'owner@-example.test' }, { email: 'owner@example-.test' },
    { sub: null }, { sub: 123 }, { sub: '' }, { sub: '   ' }, { sub: 's'.repeat(256) },
  ]) await reject(sign(patch));
});

test('a signed token must carry the exact fresh nonce represented by the stored hash', async () => {
  for (const value of [null, 123, '', 'a'.repeat(42), 'a'.repeat(44), 'a'.repeat(42) + '!', Buffer.alloc(32, 1).toString('base64url')]) {
    await reject(sign({ nonce: value }));
  }
  const noncanonical = nonce.slice(0, -1) + 'p';
  await reject(sign({ nonce: noncanonical }), { ...challenge, nonceHash: hash(noncanonical) });
  await reject(sign(), { ...challenge, nonceHash: hash('different-nonce') });
});

test('malformed, missing, expired and future challenges fail before any key lookup', async () => {
  let keyReads = 0;
  const countedVerify = createGoogleProofVerifier({ keySet: async (...args) => { keyReads++; return keySet(...args); }, clock: () => NOW });
  const token = await sign();
  for (const context of [
    undefined, null, [], {}, { ...challenge, clientId: 'not-a-google-client' }, { ...challenge, nonceHash: 'A'.repeat(64) },
    { ...challenge, nonceHash: null }, { ...challenge, issuedAt: '1800000000000' }, { ...challenge, issuedAt: NOW + 1 },
    { ...challenge, issuedAt: 0 }, { ...challenge, expiresAt: NOW }, { ...challenge, expiresAt: NOW - 1 },
    { ...challenge, expiresAt: challenge.issuedAt }, { ...challenge, expiresAt: Number.MAX_SAFE_INTEGER + 1 },
  ]) await assert.rejects(countedVerify(token, context), genericFailure);
  assert.equal(keyReads, 0);
});

test('a challenge or credential that expires during key retrieval is rejected', async () => {
  let time = NOW;
  const slowVerify = createGoogleProofVerifier({ clock: () => time, keySet: async (...args) => { time += 2000; return keySet(...args); } });
  await reject(sign(), { ...challenge, expiresAt: NOW + 1000 }, slowVerify);
  time = NOW;
  await reject(sign({ exp: NOW / 1000 + 1 }), challenge, slowVerify);
});

test('malformed and oversized credentials do not trigger key resolution', async () => {
  let keyReads = 0;
  const countedVerify = createGoogleProofVerifier({ keySet: async (...args) => { keyReads++; return keySet(...args); }, clock: () => NOW });
  const token = await sign();
  for (const value of [undefined, null, false, 123, {}, [], '', 'no-token', 'a.b', 'a.b.c.d', `${token}=`, ` ${token}`, 'a'.repeat(8193)]) {
    await reject(value, challenge, countedVerify);
  }
  assert.equal(keyReads, 0);
  await reject('a.b.c', challenge, countedVerify);
});

test('the default verifier obtains keys only from the fixed Google URL and caches them', async (t) => {
  const urls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  const googleVerify = createGoogleProofVerifier({ clock: () => NOW });
  const token = await sign({}, { jku: 'https://attacker.invalid/keys', x5u: 'https://attacker.invalid/cert', jwk: { kty: 'oct', k: 'YWJj' } });
  await googleVerify(token, challenge);
  await googleVerify(token, challenge);
  assert.deepEqual(urls, ['https://www.googleapis.com/oauth2/v3/certs']);
});

test('resolver and invalid clock failures expose only the generic proof error', async () => {
  const token = await sign();
  const unavailable = createGoogleProofVerifier({ clock: () => NOW, keySet: async () => { throw new Error(`upstream private detail ${token}`); } });
  await reject(token, challenge, unavailable);
  for (const now of [NaN, Infinity, -1, 0, '1800000000000', Number.MAX_SAFE_INTEGER]) {
    await reject(token, challenge, createGoogleProofVerifier({ keySet, clock: () => now }));
  }
  assert.throws(() => createGoogleProofVerifier({ keySet: {} }), TypeError);
  assert.throws(() => createGoogleProofVerifier({ clock: NOW }), TypeError);
});

const environment = () => ({ SESSION_SECRET: ROOT_SECRET, GOOGLE_CLIENT_ID: CLIENT_A, ALLOWED_ORIGIN: ORIGIN, OWNERS: hash(EMAIL), EDITORS: { get: async () => null } });
const sessionContext = { clientId: CLIENT_A, activeVersion: 1, origin: ORIGIN };

test('managed Google session derivation is deterministic, purpose separated and preserves root bindings', () => {
  const env = environment(), managed = googleSessionEnvironment(env, sessionContext);
  const expected = createHmac('sha256', ROOT_SECRET).update('heichal-managed-google-session-v1\0')
    .update(JSON.stringify([ORIGIN, CLIENT_A, 1])).digest('hex');
  assert.equal(managed.SESSION_SECRET, expected);
  assert.equal(Object.getPrototypeOf(managed), env);
  assert.equal(managed.GOOGLE_CLIENT_ID, CLIENT_A);
  assert.equal(managed.EDITORS, env.EDITORS);
  assert.equal(env.SESSION_SECRET, ROOT_SECRET);
  assert.deepEqual(Object.keys(managed).sort(), ['GOOGLE_CLIENT_ID', 'SESSION_SECRET']);
  assert.equal(googleSessionEnvironment(env, sessionContext).SESSION_SECRET, expected);
  for (const patch of [{ clientId: CLIENT_B }, { activeVersion: 2 }, { origin: 'https://other.example' }]) {
    assert.notEqual(googleSessionEnvironment(env, { ...sessionContext, ...patch }).SESSION_SECRET, expected);
  }
  assert.notEqual(googleSessionEnvironment({ ...env, SESSION_SECRET: 'changed-root-secret-that-is-at-least-32-bytes' }, sessionContext).SESSION_SECRET, expected);
});

test('legacy and managed Google session domains reject each other and A-B-A activation revokes old sessions', async () => {
  const root = environment();
  const firstA = googleSessionEnvironment(root, sessionContext);
  const activeB = googleSessionEnvironment(root, { ...sessionContext, clientId: CLIENT_B, activeVersion: 2 });
  const secondA = googleSessionEnvironment(root, { ...sessionContext, activeVersion: 3 });
  const envs = [root, firstA, activeB, secondA];
  const tokens = await Promise.all(envs.map((env) => makeSession(EMAIL, env, NOW)));
  for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex++) {
    for (let envIndex = 0; envIndex < envs.length; envIndex++) {
      assert.equal(await readSession(tokens[tokenIndex], envs[envIndex], NOW / 1000), tokenIndex === envIndex ? EMAIL : null);
    }
  }
  assert.equal(await readSession(tokens[1], firstA, NOW / 1000 + 12 * 3600), null);
  assert.equal(root.SESSION_SECRET, ROOT_SECRET);
});

test('concurrent managed sessions retain their own non-enumerable request IP binding', async () => {
  const root = environment();
  const requests = Array.from({ length: 12 }, (_, index) => new Request(`${ORIGIN}/api/${index}`));
  const results = await Promise.all(requests.map(async (request, index) => {
    const requestEnv = Object.create(root);
    Object.defineProperty(requestEnv, 'CLIENT_IP', { value: (candidate) => candidate === request ? `192.0.2.${index + 1}` : null });
    const managed = googleSessionEnvironment(requestEnv, { ...sessionContext, clientId: index % 2 ? CLIENT_B : CLIENT_A, activeVersion: index + 1 });
    const token = await makeSession(EMAIL, managed, NOW);
    assert.equal(await readSession(token, managed, NOW / 1000), EMAIL);
    assert.equal(managed.CLIENT_IP(request), `192.0.2.${index + 1}`);
    assert.equal(managed.CLIENT_IP(requests[(index + 1) % requests.length]), null);
    assert.equal(Object.hasOwn(managed, 'CLIENT_IP'), false);
    assert.equal(requestEnv.SESSION_SECRET, ROOT_SECRET);
    return { managed, token };
  }));
  assert.equal(new Set(results.map(({ managed }) => managed.SESSION_SECRET)).size, requests.length);
  for (let index = 0; index < results.length; index++) {
    assert.equal(await readSession(results[index].token, results[(index + 1) % results.length].managed, NOW / 1000), null);
  }
  assert.equal(root.GOOGLE_CLIENT_ID, CLIENT_A);
  assert.equal(root.SESSION_SECRET, ROOT_SECRET);
  assert.equal(Object.hasOwn(root, 'CLIENT_IP'), false);
});

test('client IDs and managed session context cannot select malformed or absent signing material', () => {
  assert.equal(validGoogleClientId(CLIENT_A), true);
  for (const clientId of [undefined, null, {}, '', 'test-client', ` ${CLIENT_A}`, `${CLIENT_A}/`, CLIENT_A.toUpperCase(), '12345-abcdefghij.apps.googleusercontent.com']) {
    assert.equal(validGoogleClientId(clientId), false);
    assert.throws(() => googleSessionEnvironment(environment(), { ...sessionContext, clientId }), /Invalid managed Google session configuration/);
  }
  for (const activeVersion of [undefined, null, 0, -1, 1.5, '1', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => googleSessionEnvironment(environment(), { ...sessionContext, activeVersion }), TypeError);
  }
  for (const origin of [undefined, null, '', 'null', 'https://site.example/', 'https://user:password@site.example', 'https://site.example/path', 'http://site.example', 'https://site.example?query', 'https://site.example#hash']) {
    assert.throws(() => googleSessionEnvironment(environment(), { ...sessionContext, origin }), TypeError);
  }
  for (const env of [null, undefined, [], {}, { GITHUB_TOKEN: ROOT_SECRET }, { SESSION_SECRET: 'short' }, { SESSION_SECRET: 123 }, { SESSION_SECRET: ' '.repeat(32) }]) {
    assert.throws(() => googleSessionEnvironment(env, sessionContext), TypeError);
  }
  for (const origin of ['http://localhost:3000', 'http://127.0.0.1:8080', 'http://[::1]:3000']) {
    assert.match(googleSessionEnvironment(environment(), { ...sessionContext, origin }).SESSION_SECRET, /^[a-f0-9]{64}$/);
  }
});
