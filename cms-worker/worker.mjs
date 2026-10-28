// Editor server (Cloudflare Worker) for /admin/: signs editors in with Google, keeps their unpublished work as drafts, and
// publishes it to GitHub when an editor with the right to publish decides to. Setup and deploy: cms-worker/README.md.
//
// - Sign-in: the editor's own Google button gets an access token, checked here with Google (an ID token is still accepted).
// - Drafts: every save goes to the DRAFTS table in D1 (the "DB" binding), never to GitHub. Reading a file gives its draft if
//   it has one, so editors see their own work; the live site does not change until someone publishes.
// - Publishing: /publish takes the chosen drafts and commits them to BRANCH in one commit (the site's deploy follows by itself).
//   Only owners and editors marked as publishers may do it; the browser cannot write to BRANCH any other way.
// - History: every publish is a commit on BRANCH, so earlier versions of a file can be listed and brought back as a draft.
// - Log: who saved, published, discarded or restored what, and when, is kept in D1 (the LOG table); emails stay there, while
//   the public commit messages only carry the editors' display names (the repository is public).
// - The GitHub key lives only here, as a secret; only files under data/ can be changed.
//
// Settings (wrangler.toml, deployed by .github/workflows/cms-worker.yml):
//   GOOGLE_CLIENT_ID  the OAuth client ID from Google Cloud
//   OWNERS            SHA-256 (hex) of each owner's lower-case email, comma separated: owners can publish and manage editors
//   ALLOWED_ORIGIN    the site's origin, e.g. https://148-gif.github.io
//   REPO, BRANCH      e.g. 148-gif/Web and claude/greeting-2i183o
//   EDITORS           KV binding: the people the owners added ("people": [{ email, name, publisher }]) and the owners' names
//   DB                D1 binding: drafts and the activity log
//   GITHUB_TOKEN      secret: fine-grained token, this repo only, Contents read/write and Actions read
//   SESSION_SECRET    optional secret; by default sessions are signed with a key derived from GITHUB_TOKEN,
//                     so replacing either one signs everyone out

const SESSION_HOURS = 12;
const enc = new TextEncoder();
const dec = new TextDecoder();
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
// Text <-> standard base64, as GitHub's contents API uses (UTF-8).
const toB64 = (text) => { const b = enc.encode(text); let r = ''; for (let i = 0; i < b.length; i += 0x8000) r += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(r); };
const fromB64 = (s) => dec.decode(Uint8Array.from(atob(String(s).replace(/\s/g, '')), (c) => c.charCodeAt(0)));
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const norm = (e) => String(e || '').trim().toLowerCase();
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const sha256 = async (s) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
// The id Git gives a file's content, so a draft and the published file are compared the way GitHub would.
const blobSha = async (text) => {
  const body = enc.encode(text), head = enc.encode(`blob ${body.length}\0`), all = new Uint8Array(head.length + body.length);
  all.set(head); all.set(body, head.length);
  return hex(await crypto.subtle.digest('SHA-1', all));
};
const cleanName = (n) => String(n || '').replace(/[\p{Cc}<>]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);

// The files an editor may change: JSON under data/, never the Q&A archive itself (its edits live in data/shut-edits/).
const PATH_OK = (p) => typeof p === 'string' && /^data\/(pages\/|shut-edits\/)?[\w-]+\.json$/.test(p) && p !== 'data/shut.json';
const MAX_FILE = 2e6;

// ---- who is who ----
const isOwner = async (env, email) => String(env.OWNERS || '').split(',').map((h) => h.trim()).filter(Boolean).includes(await sha256(norm(email)));
const kvJson = async (env, key, fallback) => { try { return JSON.parse((await env.EDITORS.get(key)) || 'null') ?? fallback; } catch { return fallback; } };
// "people" is the current list; "editors" (a list of emails) is how it was kept before roles existed.
async function people(env) {
  const list = await kvJson(env, 'people', null);
  if (list) return list;
  return (await kvJson(env, 'editors', [])).map((email) => ({ email, name: '', publisher: false }));
}
const savePeople = (env, list) => env.EDITORS.put('people', JSON.stringify(list));
// Everything about an email that matters here: may it edit, may it publish, and what is it called in public.
async function who(env, email) {
  const e = norm(email), owner = await isOwner(env, e), hash = await sha256(e);
  const person = (await people(env)).find((p) => p.email === e);
  if (!owner && !person) return null;
  const name = owner ? (await kvJson(env, 'owner-names', {}))[hash] || '' : person.name || '';
  return { email: e, owner, publisher: owner || !!person.publisher, name, shown: name || `משתמש ${hash.slice(0, 4)}` };
}
const allowed = async (env, email) => !!(await who(env, email));

// ---- Google sign-in: verify the ID token (RS256) against Google's published keys ----
let jwks = null, jwksAt = 0;
async function googleKeys(force) {
  if (!jwks || force || Date.now() - jwksAt > 3600e3) {
    jwks = (await (await fetch('https://www.googleapis.com/oauth2/v3/certs')).json()).keys;
    jwksAt = Date.now();
  }
  return jwks;
}
async function verifyGoogle(idToken, env, now = Date.now() / 1000) {
  const [h, p, s] = String(idToken).split('.');
  if (!s) throw new Error('bad token');
  const head = JSON.parse(dec.decode(unb64url(h)));
  if (head.alg !== 'RS256') throw new Error('bad alg');
  let jwk = (await googleKeys()).find((k) => k.kid === head.kid);
  if (!jwk) jwk = (await googleKeys(true)).find((k) => k.kid === head.kid);
  if (!jwk) throw new Error('unknown key');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  if (!(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, unb64url(s), enc.encode(`${h}.${p}`)))) throw new Error('bad signature');
  const c = JSON.parse(dec.decode(unb64url(p)));
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(c.iss)) throw new Error('bad issuer');
  if (c.aud !== env.GOOGLE_CLIENT_ID) throw new Error('bad audience');
  if (!(c.exp > now)) throw new Error('expired');
  if (c.email_verified !== true) throw new Error('email not verified');
  return c.email;
}

// The editor's own sign-in button gets an access token for the account's email (scope "openid email"), not an ID token.
// Google confirms it: who it was issued to (our client ID, so a token meant for another app is refused), and the verified email.
async function verifyAccessToken(accessToken, env) {
  const r = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(String(accessToken))}`);
  if (!r.ok) throw new Error('bad token');
  const c = await r.json();
  if (c.aud !== env.GOOGLE_CLIENT_ID) throw new Error('bad audience');
  if (!(Number(c.expires_in) > 0)) throw new Error('expired');
  if (String(c.email_verified) !== 'true' || !c.email) throw new Error('email not verified');
  return c.email;
}

// ---- our own session: {email, exp}, signed (see SESSION_SECRET above) ----
const hmacKey = async (env) => crypto.subtle.importKey('raw', enc.encode(env.SESSION_SECRET || `session:${await sha256(String(env.GITHUB_TOKEN))}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
async function makeSession(email, env, now = Date.now()) {
  const body = b64url(enc.encode(JSON.stringify({ email, exp: Math.floor(now / 1000) + SESSION_HOURS * 3600 })));
  return `${body}.${b64url(await crypto.subtle.sign('HMAC', await hmacKey(env), enc.encode(body)))}`;
}
async function readSession(token, env, now = Date.now() / 1000) {
  const [body, sig] = String(token || '').split('.');
  if (!sig || !(await crypto.subtle.verify('HMAC', await hmacKey(env), unb64url(sig), enc.encode(body)))) return null;
  const s = JSON.parse(dec.decode(unb64url(body)));
  // Re-checked on every request, so removing an editor takes effect at once.
  return s.exp > now && (await allowed(env, s.email)) ? s.email : null;
}

// ---- D1: drafts and the log ----
const ready = new WeakMap();
const schema = (env) => {
  if (!ready.has(env.DB)) {
    ready.set(env.DB, env.DB.batch([
      // One row per file with unpublished work. content is null for a file deleted in the draft; base_sha is the published
      // version the work started from (null for a new file), which is how a later change on the live site is noticed.
      env.DB.prepare('CREATE TABLE IF NOT EXISTS drafts (path TEXT PRIMARY KEY, content TEXT, deleted INTEGER NOT NULL DEFAULT 0, base_sha TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, email TEXT NOT NULL, name TEXT NOT NULL)'),
      env.DB.prepare('CREATE TABLE IF NOT EXISTS log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, email TEXT, name TEXT, action TEXT NOT NULL, path TEXT, summary TEXT, sha TEXT)'),
      env.DB.prepare('CREATE INDEX IF NOT EXISTS log_ts ON log (ts)'),
    ]).catch((e) => { ready.delete(env.DB); throw e; }));
  }
  return ready.get(env.DB);
};
const logEntry = (env, me, action, path, summary, sha) => env.DB.prepare('INSERT INTO log (ts, email, name, action, path, summary, sha) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(Date.now(), me ? me.email : null, me ? me.shown : null, action, path || null, summary ? String(summary).slice(0, 500) : null, sha || null).run();
const draftRow = (env, path) => env.DB.prepare('SELECT * FROM drafts WHERE path = ?').bind(path).first();
const marks = (n) => Array.from({ length: n }, () => '?').join(',');

// ---- GitHub ----
const GH = 'https://api.github.com/repos/';
async function gh(env, path, { method = 'GET', body, allow404 } = {}) {
  const r = await fetch(`${GH}${env.REPO}${path ? '/' + path : ''}`, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'heichal-cms', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
  });
  if (allow404 && r.status === 404) return null;
  const text = await r.text();
  let j = null; try { j = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!r.ok) { const e = new Error(`GitHub ${r.status}`); e.status = r.status; e.body = j; throw e; }
  return j;
}
const at = (env, path, ref) => `contents/${path}?ref=${encodeURIComponent(ref || env.BRANCH)}`;
// The id of a file as published (null if the live site does not have it).
const publishedSha = async (env, path) => { const j = await gh(env, at(env, path), { allow404: true }); return j && !Array.isArray(j) ? j.sha : null; };

// ---- what an editor may ask GitHub for (reads only; writes go through drafts and /publish) ----
// Returns the GitHub API path, or null when the request is not allowed.
function route(method, path) {
  if (method !== 'GET') return null;
  if (path === '') return '';
  if (path === 'actions/runs') return path;
  const m = /^contents\/(data(?:\/[\w.-]+)*)$/.exec(path);
  return m && !m[1].split('/').some((x) => x === '..' || x === '.') ? path : null;
}

// ---- web addresses: an English slug for a Hebrew title, by meaning (not by sound) ----
// Fixed terms of the site come first (a name like Breslov must not be "translated"); anything else goes to Workers AI.
const GLOSSARY = {
  'ברסלב': 'breslov', 'רבי נחמן': 'rabbi-nachman', 'אומן': 'uman', 'יבנאל': 'yavniel', 'מוהרא״ש': 'moharash', 'מוהרא"ש': 'moharash', 'התיקון הכללי': 'tikkun-haklali',
  'ספרייה': 'library', 'ספריה': 'library', 'שו״ת': 'shut', 'שו"ת': 'shut', 'הלכה': 'halacha', 'תפילה': 'prayer', 'תפילות': 'prayers', 'שיעורים': 'lessons', 'מתכונים': 'recipes', 'חברים': 'friends',
};
const STOP = new Set(['the', 'a', 'an', 'of']);
function toSlug(english) {
  const words = String(english || '').toLowerCase().replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  const kept = words.filter((w) => !STOP.has(w));
  return (kept.length ? kept : words).join('-').slice(0, 40).replace(/-+$/, '');
}
async function slugFor(env, text) {
  const t = String(text || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  if (!t) return { slug: null };
  if (GLOSSARY[t]) return { slug: GLOSSARY[t], english: GLOSSARY[t], source: 'glossary' };
  if (!env.AI) return { slug: null };
  try {
    const out = await env.AI.run('@cf/meta/m2m100-1.2b', { text: t, source_lang: 'he', target_lang: 'en' });
    const slug = toSlug(out && out.translated_text);
    return slug ? { slug, english: out.translated_text, source: 'ai' } : { slug: null };
  } catch { return { slug: null }; }
}

const json = (o, status, cors) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors } });
const fail = (message, status, extra) => Object.assign(new Error(message), { status, extra });
const bodyOf = async (req) => { try { return (await req.json()) || {}; } catch { return {}; } };
const label = (row) => (row.deleted ? 'נמחק' : row.base_sha ? 'שונה' : 'חדש');

// ---- drafts: read ----
async function readDraftOrPublished(env, path) {
  const row = await draftRow(env, path);
  if (row) {
    if (row.deleted) return { status: 404, json: { message: 'Not Found' } };
    return { status: 200, json: { type: 'file', path, name: path.split('/').pop(), sha: await blobSha(row.content), content: toB64(row.content), draft: true } };
  }
  const j = await gh(env, at(env, path), { allow404: true });
  return j ? { status: 200, json: j } : { status: 404, json: { message: 'Not Found' } };
}
// A folder: what the live site has, with the drafts laid over it (new files added, deleted ones left out, changed ones marked).
async function listDir(env, dir) {
  const live = (await gh(env, at(env, dir), { allow404: true })) || [];
  const rows = (await env.DB.prepare('SELECT path, deleted, content FROM drafts WHERE path LIKE ?').bind(`${dir}/%`).all()).results.filter((r) => !r.path.slice(dir.length + 1).includes('/'));
  const byName = new Map((Array.isArray(live) ? live : []).map((x) => [x.name, x]));
  for (const r of rows) {
    const name = r.path.split('/').pop();
    if (r.deleted) byName.delete(name);
    else byName.set(name, { ...(byName.get(name) || { type: 'file', name, path: r.path }), sha: await blobSha(r.content), draft: true });
  }
  return [...byName.values()];
}

// ---- drafts: write ----
// Saves a file as a draft. expected is the id the editor last saw (null when it is making a new file): if the file has moved
// on since, someone else saved it meanwhile and the editor is told, instead of overwriting their work.
async function saveDraft(env, me, path, text, expected, { auto, restore, summary } = {}) {
  if (!PATH_OK(path)) throw fail('הקובץ הזה לא ניתן לעריכה', 403);
  if (typeof text !== 'string' || text.length > MAX_FILE) throw fail('הקובץ גדול מדי', 413);
  try { JSON.parse(text); } catch { throw fail('הקובץ אינו JSON תקין', 400); }
  const row = await draftRow(env, path), pub = await publishedSha(env, path);
  const current = row ? (row.deleted ? null : await blobSha(row.content)) : pub;
  if (!restore && (expected || null) !== (current || null)) throw fail('מישהו אחר שמר את הקובץ הזה בינתיים. טענו אותו מחדש ונסו שוב.', 409);
  const sha = await blobSha(text);
  if (pub && sha === pub) await env.DB.prepare('DELETE FROM drafts WHERE path = ?').bind(path).run(); // back to what is published
  else {
    const now = Date.now();
    await env.DB.prepare('INSERT INTO drafts (path, content, deleted, base_sha, created_at, updated_at, email, name) VALUES (?, ?, 0, ?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET content = excluded.content, deleted = 0, updated_at = excluded.updated_at, email = excluded.email, name = excluded.name')
      .bind(path, text, row ? row.base_sha : pub, row ? row.created_at : now, now, me.email, me.shown).run();
  }
  if (restore) await logEntry(env, me, 'restore', path, summary);
  else if (!auto) await logEntry(env, me, 'save', path, summary);
  return { content: { sha, path }, draft: true };
}
async function deleteDraft(env, me, path, expected, summary) {
  if (!PATH_OK(path)) throw fail('הקובץ הזה לא ניתן למחיקה', 403);
  const row = await draftRow(env, path), pub = await publishedSha(env, path);
  const current = row ? (row.deleted ? null : await blobSha(row.content)) : pub;
  if ((expected || null) !== (current || null)) throw fail('מישהו אחר שמר את הקובץ הזה בינתיים. טענו אותו מחדש ונסו שוב.', 409);
  if (!pub) await env.DB.prepare('DELETE FROM drafts WHERE path = ?').bind(path).run(); // it was never published: nothing to remember
  else {
    const now = Date.now();
    await env.DB.prepare('INSERT INTO drafts (path, content, deleted, base_sha, created_at, updated_at, email, name) VALUES (?, NULL, 1, ?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET content = NULL, deleted = 1, updated_at = excluded.updated_at, email = excluded.email, name = excluded.name')
      .bind(path, row ? row.base_sha : pub, row ? row.created_at : now, now, me.email, me.shown).run();
  }
  await logEntry(env, me, 'delete', path, summary);
  return { content: null, draft: true };
}

// ---- changes waiting to be published ----
async function changes(env, check) {
  const rows = (await env.DB.prepare('SELECT * FROM drafts ORDER BY updated_at DESC').all()).results;
  const out = [];
  for (const r of rows) {
    const sha = r.deleted ? null : await blobSha(r.content);
    const item = { path: r.path, status: r.deleted ? 'removed' : r.base_sha ? 'modified' : 'added', name: r.name, ts: r.updated_at, created: r.created_at, sha, base: r.base_sha };
    if (check) { item.published = await publishedSha(env, r.path); item.conflict = item.published !== (r.base_sha || null) && item.published !== sha; }
    out.push(item);
  }
  return out;
}

// Publishing: the chosen drafts become one commit on BRANCH. A file the live site changed since the draft began is a conflict,
// and nothing is published until the editor says what to do with it (force: publish mine anyway).
async function publish(env, me, paths, force, note) {
  const rows = paths.length ? (await env.DB.prepare(`SELECT * FROM drafts WHERE path IN (${marks(paths.length)})`).bind(...paths).all()).results : [];
  if (!rows.length) throw fail('אין שינויים לפרסם', 400);
  const pubs = new Map(await Promise.all(rows.map(async (r) => [r.path, await publishedSha(env, r.path)])));
  const shas = new Map(await Promise.all(rows.map(async (r) => [r.path, r.deleted ? null : await blobSha(r.content)])));
  const conflicts = rows.filter((r) => pubs.get(r.path) !== (r.base_sha || null) && pubs.get(r.path) !== shas.get(r.path) && !force.includes(r.path)).map((r) => r.path);
  if (conflicts.length) throw fail('חלק מהקבצים שונו גם באתר החי מאז שהתחלתם לערוך אותם', 409, { conflicts });
  const blobs = new Map();
  for (const r of rows) if (!r.deleted && pubs.get(r.path) !== shas.get(r.path)) blobs.set(r.path, (await gh(env, 'git/blobs', { method: 'POST', body: { content: toB64(r.content), encoding: 'base64' } })).sha);
  const entries = rows.filter((r) => (r.deleted ? pubs.get(r.path) : blobs.has(r.path))).map((r) => ({ path: r.path, mode: '100644', type: 'blob', sha: r.deleted ? null : blobs.get(r.path) }));
  const editors = [...new Set(rows.map((r) => r.name))];
  const lines = rows.map((r) => `- ${label(r)}: ${r.path}`);
  const subject = `פרסום: ${cleanName(note) || `${rows.length} שינויים`}`;
  let sha = null;
  if (entries.length) {
    for (let attempt = 0; ; attempt++) {
      const head = (await gh(env, `git/ref/heads/${env.BRANCH}`)).object.sha;
      const tree = (await gh(env, `git/commits/${head}`)).tree.sha;
      const next = await gh(env, 'git/trees', { method: 'POST', body: { base_tree: tree, tree: entries } });
      const commit = await gh(env, 'git/commits', { method: 'POST', body: { message: `${subject}\n\n${lines.join('\n')}\n\nפורסם על ידי: ${me.shown}\nנערך על ידי: ${editors.join(', ')}`, tree: next.sha, parents: [head], author: { name: me.shown, email: 'editor@heichal.invalid', date: new Date().toISOString() } } });
      try { await gh(env, `git/refs/heads/${env.BRANCH}`, { method: 'PATCH', body: { sha: commit.sha, force: false } }); sha = commit.sha; break; }
      catch (e) { if (e.status !== 422 || attempt >= 2) throw e; } // the branch moved meanwhile: build again on the new head
    }
  }
  await env.DB.prepare(`DELETE FROM drafts WHERE path IN (${marks(paths.length)})`).bind(...rows.map((r) => r.path)).run();
  for (const r of rows) await logEntry(env, me, 'publish', r.path, `${label(r)} · נערך על ידי ${r.name}`, sha);
  await logEntry(env, me, 'publish-all', null, cleanName(note) || `${rows.length} שינויים`, sha);
  return { sha, published: rows.map((r) => r.path) };
}

async function discard(env, me, paths) {
  const rows = paths.length ? (await env.DB.prepare(`SELECT * FROM drafts WHERE path IN (${marks(paths.length)})`).bind(...paths).all()).results : [];
  // An editor may drop only their own work; a publisher may drop anyone's.
  if (rows.some((r) => r.email !== me.email) && !me.publisher) throw fail('אפשר לבטל רק שינויים שביצעתם בעצמכם', 403);
  if (rows.length) await env.DB.prepare(`DELETE FROM drafts WHERE path IN (${marks(rows.length)})`).bind(...rows.map((r) => r.path)).run();
  for (const r of rows) await logEntry(env, me, 'discard', r.path, `${label(r)} · נערך על ידי ${r.name}`);
  return { discarded: rows.map((r) => r.path) };
}

// Earlier versions of a file: the commits on BRANCH that touched it. The name is the one the publish wrote into the message.
async function history(env, path) {
  if (!PATH_OK(path)) throw fail('הקובץ הזה אינו ברשימה', 403);
  const list = (await gh(env, `commits?sha=${encodeURIComponent(env.BRANCH)}&path=${encodeURIComponent(path)}&per_page=20`)) || [];
  return list.map((c) => {
    const msg = String(c.commit.message || ''), by = /^פורסם על ידי: (.+)$/m.exec(msg) || /^נערך על ידי: (.+)$/m.exec(msg);
    return { sha: c.sha, date: c.commit.author.date, message: msg.split('\n')[0], name: by ? by[1] : c.commit.author.name || '' };
  });
}
async function restore(env, me, path, sha) {
  if (!PATH_OK(path)) throw fail('הקובץ הזה אינו ברשימה', 403);
  if (!/^[0-9a-f]{40}$/.test(String(sha))) throw fail('גרסה לא תקינה', 400);
  const j = await gh(env, at(env, path, sha), { allow404: true });
  if (!j || Array.isArray(j)) throw fail('בגרסה הזאת הקובץ לא היה קיים', 404);
  return saveDraft(env, me, path, fromB64(j.content), null, { restore: true, summary: `שחזור גרסה ${String(sha).slice(0, 7)}` });
}

async function main(req, env, url, cors) {
  const email = await readSession((req.headers.get('Authorization') || '').replace(/^Bearer /, ''), env);
  if (!email) return json({ message: 'צריך להתחבר מחדש' }, 401, cors);
  const me = await who(env, email), p = url.pathname, q = url.searchParams;
  await schema(env);

  if (p === '/me') {
    if (req.method === 'PUT') {
      const name = cleanName((await bodyOf(req)).name);
      if (!name) return json({ message: 'כתבו שם' }, 400, cors);
      if (me.owner) { const names = await kvJson(env, 'owner-names', {}); names[await sha256(me.email)] = name; await env.EDITORS.put('owner-names', JSON.stringify(names)); }
      else await savePeople(env, (await people(env)).map((x) => (x.email === me.email ? { ...x, name } : x)));
      await logEntry(env, me, 'name', null, name);
      return json({ email: me.email, name, owner: me.owner, publisher: me.publisher }, 200, cors);
    }
    return json({ email: me.email, name: me.name, owner: me.owner, publisher: me.publisher }, 200, cors);
  }

  // The people who may edit: owners only. PUT { email, name, publisher } adds or updates, DELETE { email } removes.
  if (p === '/editors') {
    if (!me.owner) return json({ message: 'רק בעל האתר יכול לנהל עורכים' }, 403, cors);
    let list = await people(env);
    if (req.method === 'PUT' || req.method === 'DELETE') {
      const b = await bodyOf(req), e = norm(b.email);
      if (!EMAIL.test(e)) return json({ message: 'כתובת מייל לא תקינה' }, 400, cors);
      if (req.method === 'PUT') {
        const old = list.find((x) => x.email === e), name = cleanName(b.name === undefined && old ? old.name : b.name);
        list = [...list.filter((x) => x.email !== e), { email: e, name, publisher: b.publisher === undefined && old ? !!old.publisher : !!b.publisher }].sort((a, b2) => a.email.localeCompare(b2.email));
        await logEntry(env, me, old ? 'editor-update' : 'editor-add', null, `${name || 'ללא שם'}${b.publisher ? ' · מפרסם' : ''}`);
      } else {
        list = list.filter((x) => x.email !== e);
        await logEntry(env, me, 'editor-remove', null, e.replace(/^(.).*@/, '$1…@'));
      }
      await savePeople(env, list);
    } else if (req.method !== 'GET') return json({ message: 'not allowed' }, 405, cors);
    return json({ editors: list }, 200, cors);
  }

  if (p === '/translate' && req.method === 'POST') return json(await slugFor(env, (await bodyOf(req)).text), 200, cors);
  if (p === '/changes' && req.method === 'GET') return json({ changes: await changes(env, q.get('check') === '1') }, 200, cors);
  if (p === '/history' && req.method === 'GET') return json({ history: await history(env, q.get('path')) }, 200, cors);
  if (p === '/log' && req.method === 'GET') {
    if (!me.publisher) return json({ message: 'היומן פתוח למפרסמים ולבעלי האתר' }, 403, cors);
    const limit = Math.min(200, Math.max(1, Number(q.get('limit')) || 50)), before = Number(q.get('before')) || 0;
    const rows = (await env.DB.prepare(`SELECT id, ts, email, name, action, path, summary, sha FROM log ${before ? 'WHERE id < ?' : ''} ORDER BY id DESC LIMIT ?`).bind(...(before ? [before, limit] : [limit])).all()).results;
    return json({ log: rows.map((r) => (me.owner ? r : { ...r, email: null })) }, 200, cors);
  }
  if (req.method === 'POST' && ['/publish', '/discard', '/restore'].includes(p)) {
    const b = await bodyOf(req), paths = Array.isArray(b.paths) ? [...new Set(b.paths.filter((x) => PATH_OK(x)))] : [];
    if (p === '/publish') {
      if (!me.publisher) return json({ message: 'אין לכם הרשאה לפרסם. בקשו מבעל האתר לסמן אתכם כמפרסמים.' }, 403, cors);
      return json(await publish(env, me, paths, Array.isArray(b.force) ? b.force : [], b.note), 200, cors);
    }
    if (p === '/discard') return json(await discard(env, me, b.all ? (await env.DB.prepare('SELECT path FROM drafts').all()).results.map((r) => r.path) : paths), 200, cors);
    return json(await restore(env, me, b.path, b.sha), 200, cors);
  }

  if (!p.startsWith('/gh')) return json({ message: 'not found' }, 404, cors);
  const rest = p.replace(/^\/gh\/?/, '');
  // Writing a file saves a draft; it never reaches GitHub.
  const file = /^contents\/(data\/[\w/-]+\.json)$/.exec(rest);
  if (file && req.method === 'PUT') { const b = await bodyOf(req); return json(await saveDraft(env, me, file[1], b.content === undefined ? undefined : fromB64(b.content), b.sha, { auto: !!b.auto, summary: String(b.message || '').slice(0, 200) }), 200, cors); }
  if (file && req.method === 'DELETE') { const b = await bodyOf(req); return json(await deleteDraft(env, me, file[1], b.sha, String(b.message || '').slice(0, 200)), 200, cors); }
  const path = route(req.method, rest);
  if (path === null) return json({ message: 'פעולה לא מורשית' }, 403, cors);
  if (path.startsWith('contents/')) {
    const target = path.slice('contents/'.length);
    if (q.get('src') === 'published' || !/^data(\/|$)/.test(target)) { const j = await gh(env, at(env, target, q.get('ref') && /^[0-9a-f]{40}$/.test(q.get('ref')) ? q.get('ref') : undefined), { allow404: true }); return json(j || { message: 'Not Found' }, j ? 200 : 404, cors); }
    if (PATH_OK(target)) { const r = await readDraftOrPublished(env, target); return json(r.json, r.status, cors); }
    return json(await listDir(env, target), 200, cors);
  }
  let g = new URLSearchParams();
  if (path === 'actions/runs') { const sha = q.get('head_sha') || ''; if (!/^[0-9a-f]{40}$/.test(sha)) return json({ message: 'bad sha' }, 400, cors); g = new URLSearchParams({ head_sha: sha }); }
  return json(await gh(env, `${path}${g.toString() ? '?' + g : ''}`), 200, cors);
}

async function handle(req, env) {
  const url = new URL(req.url), origin = req.headers.get('Origin') || '';
  const cors = origin === env.ALLOWED_ORIGIN ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {};
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...cors, 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Max-Age': '86400' } });
  if (!cors['Access-Control-Allow-Origin']) return json({ message: 'origin not allowed' }, 403, cors);

  if (url.pathname === '/session' && req.method === 'POST') {
    let email;
    try {
      const b = await req.json();
      email = b.access_token ? await verifyAccessToken(b.access_token, env) : await verifyGoogle(b.credential, env);
    } catch { return json({ message: 'ההתחברות עם Google נכשלה' }, 401, cors); }
    const me = await who(env, email);
    if (!me) return json({ message: `לחשבון ${email} אין הרשאת עריכה. בקשו מבעל האתר להוסיף אתכם.` }, 403, cors);
    await schema(env); await logEntry(env, me, 'login');
    return json({ token: await makeSession(me.email, env), email: me.email, owner: me.owner, publisher: me.publisher, name: me.name }, 200, cors);
  }
  try { return await main(req, env, url, cors); }
  catch (e) { if (e.status && e.status < 500) return json({ message: e.message, ...(e.extra || {}) }, e.status, cors); throw e; }
}

export default {
  fetch: (req, env) => handle(req, env).catch(() => {
    const origin = req.headers.get('Origin');
    return json({ message: 'שגיאה בשרת העריכה' }, 500, origin === env.ALLOWED_ORIGIN ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {});
  }),
};
export { toSlug, slugFor, route, PATH_OK, blobSha, verifyGoogle, verifyAccessToken, makeSession, readSession, allowed, who, isOwner, sha256, handle };
