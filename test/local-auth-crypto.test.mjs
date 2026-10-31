import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPasswordHasher, hashPassword, verifyPassword, passwordAcceptable, normalizeUsername, randomToken, digestToken, csrfToken, safeEqualStrings, LocalAuthBusyError } from '../server/local-auth-crypto.mjs';

const PASSWORD = 'a valid password with spaces';
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('password policy counts Unicode codepoints and preserves spaces without normalization', () => {
  assert.equal(passwordAcceptable('a'.repeat(14)), false);
  assert.equal(passwordAcceptable('a'.repeat(15)), true);
  assert.equal(passwordAcceptable('א'.repeat(128)), true);
  assert.equal(passwordAcceptable('😀'.repeat(128)), true);
  assert.equal(passwordAcceptable('😀'.repeat(129)), false);
  assert.equal(passwordAcceptable('a'.repeat(129)), false);
  assert.equal(passwordAcceptable(' '.repeat(15)), true);
  assert.equal(passwordAcceptable('a'.repeat(15) + '\ud800'), false);
  for (const value of [null, undefined, {}, Buffer.from(PASSWORD), 123]) assert.equal(passwordAcceptable(value), false);
  assert.equal(normalizeUsername('Admin.Local-1'), 'admin.local-1');
  for (const value of [' admin', 'admin ', 'ab', 'a'.repeat(65), 'אדמין', 'Kadmin', 'admin@example.com', '<admin>', null]) assert.equal(normalizeUsername(value), null);
});

test('native scrypt creates random salts and authenticates exact UTF8 password bytes', async () => {
  const password = '  long Hebrew סיסמה with spaces  ';
  const a = await hashPassword(password), b = await hashPassword(password);
  assert.match(a, /^scrypt\$v1\$32768\$8\$3\$[A-Za-z0-9_-]{32}\$[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, b);
  assert.equal(await verifyPassword(password, a), true);
  assert.equal(await verifyPassword(password.trim(), a), false);
  assert.equal(await verifyPassword('wrong but long enough password', a), false);
  assert.equal(await verifyPassword(password, null), false);
  await assert.rejects(hashPassword('short'), /Password must contain/);
});

test('unknown and malformed records receive fixed-cost derivation without accepting attacker work factors', async () => {
  const calls = [];
  const hasher = createPasswordHasher({ derive: async (...args) => { calls.push(args); return Buffer.alloc(32); } });
  const cases = [null, undefined, '', 'scrypt$v1$999999999999999$8$3$salt$hash', 'x'.repeat(10000), 'scrypt$v99$32768$8$3$salt$hash'];
  for (const value of cases) assert.equal(await hasher.verifyPassword(PASSWORD, value), false);
  for (const value of ['', null, 'a'.repeat(10000)]) assert.equal(await hasher.verifyPassword(value, null), false);
  assert.equal(calls.length, cases.length + 3);
  for (const [password, salt, bytes, options] of calls) {
    assert.ok(password.length <= 128); assert.equal(salt.length, 24); assert.equal(bytes, 32);
    assert.deepEqual(options, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
  }
});

test('stored records require canonical base64url and exactly the supported profile', async () => {
  let work = 0;
  const hasher = createPasswordHasher({ derive: async () => { work++; return Buffer.alloc(32); } });
  const record = await hasher.hashPassword(PASSWORD);
  assert.equal(await hasher.verifyPassword(PASSWORD, record), true);
  assert.equal(await hasher.verifyPassword(PASSWORD, record.replace('$32768$', '$16384$')), false);
  assert.equal(await hasher.verifyPassword(PASSWORD, record.slice(0, -1) + 'B'), false, 'Noncanonical pad bits are rejected');
  assert.equal(await hasher.verifyPassword(PASSWORD, record + '='), false);
  assert.equal(work, 5, 'All invalid records still derived once');
});

test('KDF gate bounds two active and four queued operations, including unknown accounts', async () => {
  const pending = [], started = [];
  const hasher = createPasswordHasher({ derive: async (password) => {
    started.push(password); const gate = deferred(); pending.push(gate); return gate.promise;
  } });
  const jobs = Array.from({ length: 6 }, () => hasher.verifyPassword(PASSWORD, null));
  await tick(); assert.equal(started.length, 2);
  await assert.rejects(hasher.hashPassword(PASSWORD), LocalAuthBusyError);
  await assert.rejects(hasher.verifyPassword(PASSWORD, null), LocalAuthBusyError);
  pending[0].resolve(Buffer.alloc(32)); await jobs[0]; await tick(); assert.equal(started.length, 3);
  pending[1].resolve(Buffer.alloc(32)); await jobs[1]; await tick(); assert.equal(started.length, 4);
  pending[2].resolve(Buffer.alloc(32)); await jobs[2]; await tick(); assert.equal(started.length, 5);
  pending[3].resolve(Buffer.alloc(32)); await jobs[3]; await tick(); assert.equal(started.length, 6);
  pending[4].resolve(Buffer.alloc(32)); pending[5].resolve(Buffer.alloc(32));
  assert.deepEqual(await Promise.all(jobs), [false, false, false, false, false, false]);
});

test('KDF failure releases capacity and does not leave queued work blocked', async () => {
  const waits = [];
  const hasher = createPasswordHasher({ derive: () => { const gate = deferred(); waits.push(gate); return gate.promise; } });
  const a = hasher.verifyPassword(PASSWORD, null), b = hasher.verifyPassword(PASSWORD, null), c = hasher.verifyPassword(PASSWORD, null);
  const rejected = assert.rejects(a, /test derive failure/);
  await tick(); waits[0].reject(new Error('test derive failure')); await rejected; await tick();
  assert.equal(waits.length, 3);
  waits[1].resolve(Buffer.alloc(32)); waits[2].resolve(Buffer.alloc(32));
  assert.equal(await b, false); assert.equal(await c, false);
  const d = hasher.hashPassword(PASSWORD); await tick(); waits[3].resolve(Buffer.alloc(31));
  await assert.rejects(d, /Invalid password derivation result/);
  const e = hasher.verifyPassword(PASSWORD, null); await tick(); waits[4].resolve(Buffer.alloc(32)); assert.equal(await e, false);
});

test('tokens are random and CSRF is bound to both session and separately labelled secret', () => {
  const a = randomToken(), b = randomToken(), secret = 'fixture-only-session-secret-32bytes';
  assert.match(a, /^[A-Za-z0-9_-]{43}$/); assert.notEqual(a, b);
  assert.match(digestToken(a), /^[a-f0-9]{64}$/); assert.notEqual(digestToken(a), digestToken(b));
  const csrf = csrfToken(a, secret);
  assert.match(csrf, /^[A-Za-z0-9_-]{43}$/); assert.equal(csrf, csrfToken(a, secret));
  assert.notEqual(csrf, csrfToken(b, secret)); assert.notEqual(csrf, csrfToken(a, secret + 'x')); assert.notEqual(csrf, a);
  assert.equal(safeEqualStrings(csrf, csrf), true); assert.equal(safeEqualStrings(csrf, csrf + 'x'), false);
  assert.equal(safeEqualStrings(null, csrf), false); assert.equal(safeEqualStrings('a'.repeat(513), 'a'.repeat(513)), false);
  assert.throws(() => csrfToken(a, 'short'), /Invalid CSRF/);
  assert.throws(() => digestToken({}), /Invalid token/);
});
