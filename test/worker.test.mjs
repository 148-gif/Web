// Unit tests for the editor login server (cms-worker/worker.mjs): who may sign in, and what an editor may change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { route, verifyGoogle, makeSession, readSession, handle, sha256 } from '../cms-worker/worker.mjs';

// a@gmail.com owns the site; b@gmail.com is an editor the owner added (kept in the KV store).
const kv = (init) => { const m = new Map(Object.entries(init)); return { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } }; };
const env = { GOOGLE_CLIENT_ID: 'cid', OWNERS: `${await sha256('a@gmail.com')}, ${await sha256('x@y.z')}`, EDITORS: kv({ editors: '["b@gmail.com"]' }), ALLOWED_ORIGIN: 'https://site.example', REPO: 'o/r', BRANCH: 'live', GITHUB_TOKEN: 'ghp' };
const b64url = (s) => Buffer.from(s).toString('base64url');

// A Google-like signing key, served as Google's key set by a stubbed fetch.
const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', publicKey)), kid: 'k1' };
const idToken = async (claims, kid = 'k1') => {
  const h = b64url(JSON.stringify({ alg: 'RS256', kid })), p = b64url(JSON.stringify(claims));
  return `${h}.${p}.${Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(`${h}.${p}`))).toString('base64url')}`;
};
const good = { iss: 'https://accounts.google.com', aud: 'cid', exp: Date.now() / 1000 + 600, email: 'a@gmail.com', email_verified: true };
const calls = [];
globalThis.fetch = async (u, opt = {}) => {
  if (String(u).startsWith('https://www.googleapis.com/')) return new Response(JSON.stringify({ keys: [jwk] }));
  calls.push({ u: String(u), ...opt });
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
};

test('route() lets editors read and write data files only', () => {
  assert.equal(route('GET', ''), '');
  assert.equal(route('GET', 'contents/data'), 'contents/data');
  assert.equal(route('PUT', 'contents/data/pages/x.json'), 'contents/data/pages/x.json');
  assert.equal(route('DELETE', 'contents/data/pages/x.json'), 'contents/data/pages/x.json');
  assert.equal(route('GET', 'actions/runs'), 'actions/runs');
  assert.equal(route('PUT', 'contents/data/shut-edits/12.json'), 'contents/data/shut-edits/12.json'); // one Q&A entry, never shut.json itself
  for (const [m, p] of [['PUT', 'contents/site/app.js'], ['PUT', 'contents/.github/workflows/pages.yml'], ['PUT', 'contents/data/../scripts/build.mjs'], ['PUT', 'contents/data/shut.json'], ['PUT', 'contents/data'], ['DELETE', ''], ['POST', 'contents/data/x.json'], ['GET', 'contents/scripts/build.mjs'], ['GET', 'collaborators']]) {
    assert.equal(route(m, p), null, `${m} ${p}`);
  }
});

test('verifyGoogle() accepts only a valid, verified token for this app', async () => {
  assert.equal(await verifyGoogle(await idToken(good), env), 'a@gmail.com');
  for (const bad of [{ aud: 'other' }, { iss: 'evil.example' }, { exp: Date.now() / 1000 - 1 }, { email_verified: false }]) {
    await assert.rejects(verifyGoogle(await idToken({ ...good, ...bad }), env), undefined, JSON.stringify(bad));
  }
  const t = await idToken(good);
  const forged = t.split('.').slice(0, 1).concat(b64url(JSON.stringify({ ...good, email: 'evil@gmail.com' })), t.split('.')[2]).join('.');
  await assert.rejects(verifyGoogle(forged, env), /signature/);
  await assert.rejects(verifyGoogle(await idToken(good, 'nope'), env), /unknown key/);
});

test('sessions expire, cannot be forged, and end when the email is removed', async () => {
  const s = await makeSession('b@gmail.com', env);
  assert.equal(await readSession(s, env), 'b@gmail.com');
  assert.equal(await readSession(s, env, Date.now() / 1000 + 13 * 3600), null);
  assert.equal(await readSession(s, { ...env, SESSION_SECRET: 'other' }), null);
  assert.equal(await readSession(s, { ...env, GITHUB_TOKEN: 'replaced' }), null);
  assert.equal(await readSession(s, { ...env, EDITORS: kv({ editors: '[]' }) }), null);
  assert.equal(await readSession(b64url(JSON.stringify({ email: 'a@gmail.com', exp: 9e9 })) + '.' + s.split('.')[1], env), null);
  assert.equal(await readSession('', env), null);
});

const req = (path, opt = {}) => new Request(`https://w.example${path}`, { ...opt, headers: { Origin: env.ALLOWED_ORIGIN, ...(opt.headers || {}) } });

test('handle(): sign-in, allow-list and the proxied save', async () => {
  assert.equal((await handle(req('/gh', { headers: { Origin: 'https://evil.example' } }), env)).status, 403);
  let r = await handle(req('/session', { method: 'POST', body: JSON.stringify({ credential: await idToken({ ...good, email: 'stranger@gmail.com' }) }) }), env);
  assert.equal(r.status, 403);
  r = await handle(req('/session', { method: 'POST', body: JSON.stringify({ credential: await idToken(good) }) }), env);
  assert.equal(r.status, 200);
  const { token } = await r.json();
  assert.equal((await handle(req('/gh'), env)).status, 401);
  assert.equal((await handle(req('/gh/contents/site/app.js', { method: 'PUT', body: '{}', headers: { Authorization: `Bearer ${token}` } }), env)).status, 403);
  r = await handle(req('/gh/contents/data/pages/x.json', { method: 'PUT', body: JSON.stringify({ message: 'דף חדש', content: 'e30=', branch: 'main' }), headers: { Authorization: `Bearer ${token}` } }), env);
  assert.equal(r.status, 200);
  const c = calls.at(-1), body = JSON.parse(c.body);
  assert.equal(c.u, 'https://api.github.com/repos/o/r/contents/data/pages/x.json');
  assert.equal(c.headers.Authorization, 'Bearer ghp');
  assert.equal(body.branch, 'live'); // never the branch the browser asked for
  assert.match(body.message, /נערך על ידי: a@gmail\.com$/);
  await handle(req('/gh/contents/data?ref=main', { headers: { Authorization: `Bearer ${token}` } }), env);
  assert.equal(calls.at(-1).u, 'https://api.github.com/repos/o/r/contents/data?ref=live');
});

test('handle(): only owners manage editors, and a new editor can then sign in', async () => {
  const e = { ...env, EDITORS: kv({ editors: '["b@gmail.com"]' }) };
  const login = async (email) => handle(req('/session', { method: 'POST', body: JSON.stringify({ credential: await idToken({ ...good, email }) }) }), e);
  const owner = await (await login('A@gmail.com')).json();
  assert.equal(owner.owner, true);
  const editor = await (await login('b@gmail.com')).json();
  assert.equal(editor.owner, false);
  const call = (tok, method, body) => handle(req('/editors', { method, body: body && JSON.stringify(body), headers: { Authorization: `Bearer ${tok}` } }), e);
  assert.equal((await call(editor.token, 'GET')).status, 403);
  assert.equal((await call(editor.token, 'PUT', { email: 'c@gmail.com' })).status, 403);
  assert.equal((await login('c@gmail.com')).status, 403);
  assert.equal((await call(owner.token, 'PUT', { email: 'not an email' })).status, 400);
  assert.deepEqual((await (await call(owner.token, 'PUT', { email: ' C@Gmail.com ' })).json()).editors, ['b@gmail.com', 'c@gmail.com']);
  assert.equal((await login('c@gmail.com')).status, 200);
  assert.deepEqual((await (await call(owner.token, 'DELETE', { email: 'b@gmail.com' })).json()).editors, ['c@gmail.com']);
  assert.equal((await handle(req('/gh', { headers: { Authorization: `Bearer ${editor.token}` } }), e)).status, 401); // removed: signed out at once
});
