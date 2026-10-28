// Unit tests for the editor login server (cms-worker/worker.mjs): who may sign in, and what an editor may change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toSlug, slugFor, route, verifyGoogle, verifyAccessToken, makeSession, readSession, handle, sha256, blobSha } from '../cms-worker/worker.mjs';
import { makeD1 } from './helpers/d1.mjs';
import { makeGithub } from './helpers/fake-github.mjs';

// a@gmail.com owns the site; b@gmail.com is an editor the owner added (kept in the KV store).
const kv = (init) => { const m = new Map(Object.entries(init)); return { get: async (k) => m.get(k) ?? null, put: async (k, v) => { m.set(k, v); } }; };
const env = { GOOGLE_CLIENT_ID: 'cid', OWNERS: `${await sha256('a@gmail.com')}, ${await sha256('x@y.z')}`, EDITORS: kv({ editors: '["b@gmail.com"]' }), DB: makeD1(), ALLOWED_ORIGIN: 'https://site.example', REPO: 'o/r', BRANCH: 'live', GITHUB_TOKEN: 'ghp' };
const b64url = (s) => Buffer.from(s).toString('base64url');

// A Google-like signing key, served as Google's key set by a stubbed fetch.
const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', publicKey)), kid: 'k1' };
const idToken = async (claims, kid = 'k1') => {
  const h = b64url(JSON.stringify({ alg: 'RS256', kid })), p = b64url(JSON.stringify(claims));
  return `${h}.${p}.${Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(`${h}.${p}`))).toString('base64url')}`;
};
const good = { iss: 'https://accounts.google.com', aud: 'cid', exp: Date.now() / 1000 + 600, email: 'a@gmail.com', email_verified: true };
let github = await makeGithub({ repo: 'o/r', branch: 'live', files: { 'data/pages/x.json': '{"a":1}\n' } });
let tokeninfo = { status: 200, body: { aud: 'cid', email: 'a@gmail.com', email_verified: 'true', expires_in: '3000' } };
globalThis.fetch = async (u, opt = {}) => {
  if (String(u).startsWith('https://oauth2.googleapis.com/tokeninfo?access_token=')) return new Response(JSON.stringify(tokeninfo.body), { status: tokeninfo.status });
  if (String(u).startsWith('https://www.googleapis.com/')) return new Response(JSON.stringify({ keys: [jwk] }));
  const r = await github.fetch(u, opt);
  if (r) return r;
  throw new Error(`unexpected fetch ${u}`);
};

test('route() lets editors read data files and run lists only; writes never go to GitHub directly', () => {
  assert.equal(route('GET', ''), '');
  assert.equal(route('GET', 'contents/data'), 'contents/data');
  assert.equal(route('GET', 'actions/runs'), 'actions/runs');
  for (const [m, p] of [['PUT', 'contents/data/pages/x.json'], ['DELETE', 'contents/data/pages/x.json'], ['POST', 'contents/data/x.json'], ['GET', 'contents/site/app.js'], ['GET', 'contents/data/../scripts/build.mjs'], ['GET', 'collaborators']]) {
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
  assert.equal(await readSession(s, { ...env, EDITORS: kv({ people: '[]' }) }), null);
  assert.equal(await readSession(b64url(JSON.stringify({ email: 'a@gmail.com', exp: 9e9 })) + '.' + s.split('.')[1], env), null);
  assert.equal(await readSession('', env), null);
});

const req = (path, opt = {}) => new Request(`https://w.example${path}`, { ...opt, headers: { Origin: env.ALLOWED_ORIGIN, ...(opt.headers || {}) } });

test('verifyAccessToken() trusts only a live token Google issued to this app, with a verified email', async () => {
  tokeninfo = { status: 200, body: { aud: 'cid', email: 'a@gmail.com', email_verified: 'true', expires_in: '3000' } };
  assert.equal(await verifyAccessToken('tok', env), 'a@gmail.com');
  for (const [status, patch] of [[400, {}], [200, { aud: 'someone-else' }], [200, { expires_in: '0' }], [200, { email_verified: 'false' }], [200, { email: undefined }]]) {
    tokeninfo = { status, body: { aud: 'cid', email: 'a@gmail.com', email_verified: 'true', expires_in: '3000', ...patch } };
    await assert.rejects(verifyAccessToken('tok', env), undefined, JSON.stringify([status, patch]));
  }
  tokeninfo = { status: 200, body: { aud: 'cid', email: 'a@gmail.com', email_verified: 'true', expires_in: '3000' } };
});

test('handle(): sign-in with an access token, and an editor who is not on the list is refused', async () => {
  const login = async (email) => {
    tokeninfo = { status: 200, body: { aud: 'cid', email, email_verified: 'true', expires_in: '3000' } };
    return handle(req('/session', { method: 'POST', body: JSON.stringify({ access_token: 'tok' }) }), env);
  };
  const ok = await login('a@gmail.com');
  assert.equal(ok.status, 200);
  const j = await ok.json();
  assert.equal(j.email, 'a@gmail.com');
  assert.equal(j.owner, true);
  assert.equal((await login('stranger@gmail.com')).status, 403);
  tokeninfo = { status: 400, body: {} };
  assert.equal((await handle(req('/session', { method: 'POST', body: JSON.stringify({ access_token: 'bad' }) }), env)).status, 401);
});

// ---- drafts, publishing, roles ----
const world = async () => {
  github = await makeGithub({ repo: 'o/r', branch: 'live', files: { 'data/pages/x.json': '{"a":1}\n', 'data/topics.json': '[]\n' } });
  const e = { ...env, DB: makeD1(), EDITORS: kv({ people: JSON.stringify([{ email: 'b@gmail.com', name: 'בני', publisher: false }, { email: 'p@gmail.com', name: 'פנחס', publisher: true }]), 'owner-names': JSON.stringify({ [await sha256('a@gmail.com')]: 'אהרן' }) }) };
  const login = async (email) => {
    tokeninfo = { status: 200, body: { aud: 'cid', email, email_verified: 'true', expires_in: '3000' } };
    const r = await handle(req('/session', { method: 'POST', body: JSON.stringify({ access_token: 't' }) }), e);
    return r.status === 200 ? { ...(await r.json()), status: 200 } : { status: r.status };
  };
  const as = (tok) => async (method, path, body) => {
    const r = await handle(req(path, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { Authorization: `Bearer ${tok}` } }), e);
    return { status: r.status, body: await r.json() };
  };
  const owner = await login('a@gmail.com'), editor = await login('b@gmail.com'), publisher = await login('p@gmail.com'); // one by one: the stubbed tokeninfo is shared
  return { e, login, owner: as(owner.token), editor: as(editor.token), publisher: as(publisher.token), info: { owner, editor, publisher } };
};
const put = (api, path, obj, sha, extra = {}) => api('PUT', `/gh/contents/${path}`, { message: 'שמירה', content: Buffer.from(JSON.stringify(obj) + '\n').toString('base64'), sha, ...extra });

test('sign-in tells each person their role and shown name', async () => {
  const w = await world();
  assert.deepEqual([w.info.owner.owner, w.info.owner.publisher, w.info.owner.name], [true, true, 'אהרן']);
  assert.deepEqual([w.info.editor.owner, w.info.editor.publisher, w.info.editor.name], [false, false, 'בני']);
  assert.equal((await w.login('stranger@gmail.com')).status, 403);
});

test('a save is a draft: GitHub is not written, the saver sees it, the live file stays', async () => {
  const w = await world();
  const cur = (await w.editor('GET', '/gh/contents/data/pages/x.json')).body;
  const before = github.log.length;
  const r = await put(w.editor, 'data/pages/x.json', { a: 2 }, cur.sha);
  assert.equal(r.status, 200);
  assert.equal(r.body.draft, true);
  assert.ok(!github.log.slice(before).some((l) => /^(PUT|POST|PATCH)/.test(l)));
  assert.equal(github.read('data/pages/x.json'), '{"a":1}\n');
  const read = (await w.owner('GET', '/gh/contents/data/pages/x.json')).body;
  assert.equal(JSON.parse(Buffer.from(read.content, 'base64')).a, 2);
  assert.equal((await w.owner('GET', '/gh/contents/data/pages/x.json?src=published')).body.sha, cur.sha);
  const list = (await w.owner('GET', '/gh/contents/data/pages')).body;
  assert.equal(list.find((f) => f.name === 'x.json').draft, true);
  const ch = (await w.owner('GET', '/changes')).body.changes;
  assert.deepEqual(ch.map((c) => [c.path, c.status, c.name]), [['data/pages/x.json', 'modified', 'בני']]);
});

test('only data JSON files may be saved, and bad JSON is refused', async () => {
  const w = await world();
  assert.equal((await put(w.owner, 'site/app.json', {}, null)).status, 403);
  assert.equal((await put(w.owner, 'data/shut.json', {}, null)).status, 403);
  assert.equal((await w.owner('PUT', '/gh/contents/data/pages/y.json', { content: Buffer.from('{oops').toString('base64') })).status, 400);
});

test('a second editor saving over a changed file gets 409 and the work is kept', async () => {
  const w = await world();
  const cur = (await w.editor('GET', '/gh/contents/data/pages/x.json')).body;
  assert.equal((await put(w.editor, 'data/pages/x.json', { a: 2 }, cur.sha)).status, 200);
  const clash = await put(w.publisher, 'data/pages/x.json', { a: 3 }, cur.sha); // still holds the old id
  assert.equal(clash.status, 409);
  assert.equal(JSON.parse(Buffer.from((await w.owner('GET', '/gh/contents/data/pages/x.json')).body.content, 'base64')).a, 2);
});

test('saving the published content again removes the draft; new files and deletions are drafts too', async () => {
  const w = await world();
  const cur = (await w.owner('GET', '/gh/contents/data/pages/x.json')).body;
  const r = await put(w.owner, 'data/pages/x.json', { a: 2 }, cur.sha);
  const back = await w.owner('PUT', '/gh/contents/data/pages/x.json', { content: cur.content, sha: r.body.content.sha });
  assert.equal(back.status, 200);
  assert.deepEqual((await w.owner('GET', '/changes')).body.changes, []);
  assert.equal((await put(w.owner, 'data/pages/new.json', { n: 1 }, null)).status, 200);
  assert.equal((await w.owner('DELETE', '/gh/contents/data/pages/x.json', { sha: cur.sha, message: 'מחיקה' })).status, 200);
  const ch = (await w.owner('GET', '/changes')).body.changes;
  assert.deepEqual(ch.map((c) => [c.path, c.status]).sort(), [['data/pages/new.json', 'added'], ['data/pages/x.json', 'removed']]);
  assert.equal((await w.owner('GET', '/gh/contents/data/pages/x.json')).status, 404);
  assert.deepEqual((await w.owner('GET', '/gh/contents/data/pages')).body.map((f) => f.name), ['new.json']);
});

test('publishing: only publishers, one commit with display names only, drafts cleared', async () => {
  const w = await world();
  const cur = (await w.editor('GET', '/gh/contents/data/pages/x.json')).body;
  await put(w.editor, 'data/pages/x.json', { a: 2 }, cur.sha);
  await put(w.editor, 'data/pages/new.json', { n: 1 }, null);
  assert.equal((await w.editor('POST', '/publish', { paths: ['data/pages/x.json'] })).status, 403);
  const n0 = github.commits().length;
  const r = await w.publisher('POST', '/publish', { paths: ['data/pages/x.json', 'data/pages/new.json'], note: 'עדכון הדף' });
  assert.equal(r.status, 200);
  assert.equal(github.commits().length, n0 + 1);
  assert.equal(github.read('data/pages/x.json'), '{"a":2}\n');
  assert.equal(github.read('data/pages/new.json'), '{"n":1}\n');
  const c = github.commits().find((x) => x.sha === github.head);
  assert.match(c.message, /^פרסום: עדכון הדף/);
  assert.match(c.message, /פורסם על ידי: פנחס/);
  assert.match(c.message, /נערך על ידי: בני/);
  assert.ok(!/@/.test(c.message + JSON.stringify(c.author)) || /heichal\.invalid/.test(c.author.email));
  assert.ok(!c.message.includes('gmail'));
  assert.deepEqual((await w.owner('GET', '/changes')).body.changes, []);
});

test('publishing a subset leaves the rest as drafts; an unknown path publishes nothing', async () => {
  const w = await world();
  await put(w.owner, 'data/pages/a.json', { a: 1 }, null);
  await put(w.owner, 'data/pages/b.json', { b: 1 }, null);
  assert.equal((await w.owner('POST', '/publish', { paths: ['data/pages/zzz.json'] })).status, 400);
  assert.equal((await w.owner('POST', '/publish', { paths: ['data/pages/a.json'] })).status, 200);
  assert.equal(github.read('data/pages/b.json'), null);
  assert.deepEqual((await w.owner('GET', '/changes')).body.changes.map((c) => c.path), ['data/pages/b.json']);
});

test('publishing a deleted file removes it from the branch', async () => {
  const w = await world();
  const cur = (await w.owner('GET', '/gh/contents/data/pages/x.json')).body;
  await w.owner('DELETE', '/gh/contents/data/pages/x.json', { sha: cur.sha });
  assert.equal((await w.owner('POST', '/publish', { paths: ['data/pages/x.json'] })).status, 200);
  assert.equal(github.read('data/pages/x.json'), null);
});

test('a file changed on the live branch meanwhile is a conflict until the publisher forces it', async () => {
  const w = await world();
  const cur = (await w.owner('GET', '/gh/contents/data/pages/x.json')).body;
  await put(w.owner, 'data/pages/x.json', { a: 2 }, cur.sha);
  await github.commit({ 'data/pages/x.json': '{"a":9}\n' });
  assert.equal((await w.owner('GET', '/changes?check=1')).body.changes[0].conflict, true);
  const r = await w.owner('POST', '/publish', { paths: ['data/pages/x.json'] });
  assert.equal(r.status, 409);
  assert.deepEqual(r.body.conflicts, ['data/pages/x.json']);
  assert.equal(github.read('data/pages/x.json'), '{"a":9}\n');
  assert.equal((await w.owner('POST', '/publish', { paths: ['data/pages/x.json'], force: ['data/pages/x.json'] })).status, 200);
  assert.equal(github.read('data/pages/x.json'), '{"a":2}\n');
});

test('discard: editors drop only their own work, publishers anyone\'s', async () => {
  const w = await world();
  await put(w.editor, 'data/pages/a.json', { a: 1 }, null);
  await put(w.publisher, 'data/pages/b.json', { b: 1 }, null);
  assert.equal((await w.editor('POST', '/discard', { paths: ['data/pages/b.json'] })).status, 403);
  assert.equal((await w.editor('POST', '/discard', { paths: ['data/pages/a.json'] })).status, 200);
  assert.equal((await w.owner('POST', '/discard', { all: true })).status, 200);
  assert.deepEqual((await w.owner('GET', '/changes')).body.changes, []);
});

test('history lists earlier versions and restore brings one back as a draft', async () => {
  const w = await world();
  const old = github.head;
  await github.commit({ 'data/pages/x.json': '{"a":5}\n' }, 'פרסום: שינוי\n\nפורסם על ידי: פנחס');
  const h = (await w.editor('GET', '/history?path=data/pages/x.json')).body.history;
  assert.equal(h.length, 2);
  assert.equal(h[0].name, 'פנחס');
  const r = await w.editor('POST', '/restore', { path: 'data/pages/x.json', sha: old });
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(Buffer.from((await w.editor('GET', '/gh/contents/data/pages/x.json')).body.content, 'base64')).a, 1);
  assert.equal(github.read('data/pages/x.json'), '{"a":5}\n');
  assert.equal((await w.editor('POST', '/restore', { path: 'data/pages/x.json', sha: 'nothex' })).status, 400);
  assert.equal((await w.editor('GET', '/history?path=site/app.js')).status, 403);
});

test('the log records who did what; emails are for owners only, editors cannot read it', async () => {
  const w = await world();
  await put(w.editor, 'data/pages/a.json', { a: 1 }, null);
  await w.publisher('POST', '/publish', { paths: ['data/pages/a.json'] });
  assert.equal((await w.editor('GET', '/log')).status, 403);
  const pub = (await w.publisher('GET', '/log')).body.log;
  assert.ok(pub.some((x) => x.action === 'save' && x.name === 'בני'));
  assert.ok(pub.some((x) => x.action === 'publish' && x.name === 'פנחס'));
  assert.ok(pub.every((x) => x.email === null));
  assert.ok((await w.owner('GET', '/log')).body.log.some((x) => x.email === 'b@gmail.com'));
});

test('autosaves are not logged; names are set with /me', async () => {
  const w = await world();
  await put(w.editor, 'data/pages/a.json', { a: 1 }, null, { auto: true });
  assert.ok(!(await w.owner('GET', '/log')).body.log.some((x) => x.action === 'save'));
  assert.equal((await w.editor('PUT', '/me', { name: '   ' })).status, 400);
  assert.equal((await w.editor('PUT', '/me', { name: 'בנימין' })).body.name, 'בנימין');
  assert.equal((await w.editor('GET', '/me')).body.name, 'בנימין');
  assert.equal((await w.owner('PUT', '/me', { name: 'אהרן כהן' })).body.name, 'אהרן כהן');
});

test('only owners manage editors, with names and the right to publish', async () => {
  const w = await world();
  assert.equal((await w.editor('GET', '/editors')).status, 403);
  assert.equal((await w.publisher('PUT', '/editors', { email: 'c@gmail.com' })).status, 403);
  assert.equal((await w.owner('PUT', '/editors', { email: 'not an email' })).status, 400);
  const r = await w.owner('PUT', '/editors', { email: ' C@Gmail.com ', name: 'יעקב', publisher: true });
  assert.deepEqual(r.body.editors.find((x) => x.email === 'c@gmail.com'), { email: 'c@gmail.com', name: 'יעקב', publisher: true });
  assert.equal((await w.login('c@gmail.com')).publisher, true);
  await w.owner('PUT', '/editors', { email: 'c@gmail.com', publisher: false });
  assert.deepEqual([(await w.login('c@gmail.com')).publisher, (await w.login('c@gmail.com')).name], [false, 'יעקב']);
  assert.ok(!(await w.owner('DELETE', '/editors', { email: 'b@gmail.com' })).body.editors.some((x) => x.email === 'b@gmail.com'));
  assert.equal((await w.editor('GET', '/changes')).status, 401);
});

test('an old list of editor emails still works, and blobSha matches git', async () => {
  const e = { ...env, DB: makeD1() };
  assert.equal((await handle(req('/session', { method: 'POST', body: JSON.stringify({ credential: await idToken({ ...good, email: 'b@gmail.com' }) }) }), e)).status, 200);
  assert.equal(await blobSha('hello\n'), 'ce013625030ba8dba906f756967f9e9ca394464a');
});

test('toSlug() makes a short address from English; slugFor() prefers the site glossary, then Workers AI, and fails soft', async () => {
  assert.equal(toSlug("The Rabbi's Prayer Times!"), 'rabbis-prayer-times');
  assert.equal(toSlug('of the'), 'of-the');
  assert.equal(toSlug('x'.repeat(60)).length, 40);
  let asked = null;
  const AI = { run: async (m, i) => { asked = i; return { translated_text: 'Friends of the Community' }; } };
  assert.equal((await slugFor({ AI }, 'ברסלב')).slug, 'breslov'); // glossary: never sent to the model
  assert.equal(asked, null);
  assert.equal((await slugFor({ AI }, ' חברי  הקהילה ')).slug, 'friends-community');
  assert.deepEqual([asked.source_lang, asked.target_lang, asked.text], ['he', 'en', 'חברי הקהילה']);
  assert.equal((await slugFor({ AI: { run: async () => { throw new Error('down'); } } }, 'דבר')).slug, null);
  assert.equal((await slugFor({}, 'דבר')).slug, null);
  assert.equal((await slugFor({ AI }, '   ')).slug, null);
});

test('POST /translate is for signed-in editors only', async () => {
  const w = await world();
  const e = { ...w.e, AI: { run: async () => ({ translated_text: 'Prayer times' }) } };
  const call = (tok) => handle(req('/translate', { method: 'POST', body: JSON.stringify({ text: 'זמני תפילה' }), headers: tok ? { Authorization: `Bearer ${tok}` } : {} }), e);
  assert.equal((await call(null)).status, 401);
  assert.equal((await (await call(w.info.editor.token)).json()).slug, 'prayer-times');
});

test('translation has a daily ceiling per editor and for the whole site; the glossary is free', async () => {
  const w = await world();
  let runs = 0;
  const e = { ...w.e, TRANSLATE_PER_USER: '2', TRANSLATE_PER_DAY: '3', AI: { run: async () => { runs++; return { translated_text: 'Word' }; } } };
  const ask = async (tok, text) => (await (await handle(req('/translate', { method: 'POST', body: JSON.stringify({ text }), headers: { Authorization: `Bearer ${tok}` } }), e)).json());
  const b = w.info.editor.token, p = w.info.publisher.token;
  assert.equal((await ask(b, 'ברסלב')).slug, 'breslov'); // glossary: not counted
  assert.equal((await ask(b, 'אחד')).slug, 'word');
  assert.equal((await ask(b, 'שניים')).slug, 'word');
  const over = await ask(b, 'שלושה');
  assert.deepEqual([over.slug, over.limited], [null, true]); // this editor is done for today
  assert.equal((await ask(p, 'ארבעה')).slug, 'word'); // third call of the site
  assert.equal((await ask(p, 'חמישה')).limited, true); // the site is done for today
  assert.equal(runs, 3);
});
