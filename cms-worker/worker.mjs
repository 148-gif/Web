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
// - Media: images, video, audio and documents are uploaded in pieces. Small files wait in D1 (MEDIA_CHUNKS) as pending changes and are
//   committed to site/media/ at publish, like drafts; large files and video go to R2 (the "MEDIA" binding) when it exists. The free
//   allowance of each place is counted (MEDIA table) and a file that would overflow it is refused with the reason.
// - The GitHub key lives only here, as a secret; only files under data/ and site/media/ can be changed.
//
// Settings (wrangler.toml, deployed by .github/workflows/cms-worker.yml):
//   GOOGLE_CLIENT_ID  the OAuth client ID from Google Cloud
//   OWNERS            SHA-256 (hex) of each owner's lower-case email, comma separated: owners can publish and manage editors
//   ALLOWED_ORIGIN    the site's origin, e.g. https://148-gif.github.io
//   REPO, BRANCH      e.g. 148-gif/Web and claude/greeting-2i183o
//   EDITORS           KV binding: the people the owners added ("people": [{ email, name, publisher }]) and the owners' names
//   DB                D1 binding: drafts, pending media and the activity log
//   MEDIA             optional R2 binding for large media; MEDIA_PUBLIC_URL (e.g. https://pub-xxx.r2.dev) serves it directly,
//                     otherwise this worker serves /m/<file>
//   MEDIA_GH_FILE_MB (8), MEDIA_GH_TOTAL_MB (250), MEDIA_R2_FILE_MB (90), MEDIA_R2_TOTAL_GB (9): size and quota limits
//   GITHUB_TOKEN      secret: fine-grained token, this repo only, Contents read/write and Actions read
//   SESSION_SECRET    optional secret; by default sessions are signed with a key derived from GITHUB_TOKEN,
//                     so replacing either one signs everyone out

// The photo rules are the build's own and the editor's (one file, no file access), so what the editor refuses, this server refuses too.
import { imageProblems, blockProblems, ownerOnlyChanges, registryShapeChanges, photoFiles, budgetFor } from '../site/admin/image-rules.mjs';

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
const PAGE_FILE = /^data\/pages\/[\w-]+\.json$/;
// A photo's files live with its registry entry (see data/images.json): data/img/<id>/<width>.webp and t<width>.webp.
const PHOTO_FILE = /^data\/img\/([a-z0-9-]+)\/(\d{3,4}|t\d{3})\.webp$/;
const MEDIA_OK = (p) => typeof p === 'string' && (/^site\/media\/[a-z0-9][\w.-]{0,100}$/.test(p) || PHOTO_FILE.test(p));
const PUB_OK = (p) => PATH_OK(p) || MEDIA_OK(p);

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
      // Translations asked of Workers AI per day and editor, so its cost has a ceiling whatever the plan.
      // Uploaded media. store: "github" (committed to site/media/ at publish) or "r2". status: uploading, staged (github, waiting for
      // publish), published, removing (github, will be deleted at publish). key: the repo path (github) or the object name (r2).
      env.DB.prepare('CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, store TEXT NOT NULL, key TEXT NOT NULL, status TEXT NOT NULL, email TEXT NOT NULL, by_name TEXT NOT NULL, created_at INTEGER NOT NULL)'),
      env.DB.prepare('CREATE TABLE IF NOT EXISTS media_chunks (id TEXT NOT NULL, n INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (id, n))'),
      env.DB.prepare('CREATE TABLE IF NOT EXISTS ai_usage (day TEXT NOT NULL, email TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, email))'),
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

// The text of a file as published (null if the live site does not have it).
const publishedText = async (env, path) => { const j = await gh(env, at(env, path), { allow404: true }); return j && !Array.isArray(j) ? fromB64(j.content) : null; };

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
// May this editor use the model now? Counts the call when it is allowed. Limits: TRANSLATE_PER_USER (100) and TRANSLATE_PER_DAY (300) a day.
async function aiQuota(env, email) {
  const day = new Date().toISOString().slice(0, 10), perUser = Number(env.TRANSLATE_PER_USER) || 100, perDay = Number(env.TRANSLATE_PER_DAY) || 300;
  const mine = (await env.DB.prepare('SELECT n FROM ai_usage WHERE day = ? AND email = ?').bind(day, email).first()) || { n: 0 };
  const all = (await env.DB.prepare('SELECT COALESCE(SUM(n), 0) AS n FROM ai_usage WHERE day = ?').bind(day).first()).n;
  if (mine.n >= perUser || all >= perDay) return false;
  await env.DB.prepare('INSERT INTO ai_usage (day, email, n) VALUES (?, ?, 1) ON CONFLICT(day, email) DO UPDATE SET n = n + 1').bind(day, email).run();
  return true;
}
async function slugFor(env, text, quota) {
  const t = String(text || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  if (!t) return { slug: null };
  if (GLOSSARY[t]) return { slug: GLOSSARY[t], english: GLOSSARY[t], source: 'glossary' };
  if (!env.AI) return { slug: null };
  if (quota && !(await quota())) return { slug: null, limited: true };
  try {
    const out = await env.AI.run('@cf/meta/m2m100-1.2b', { text: t, source_lang: 'he', target_lang: 'en' });
    const slug = toSlug(out && out.translated_text);
    return slug ? { slug, english: out.translated_text, source: 'ai' } : { slug: null };
  } catch { return { slug: null }; }
}

// ---- media ----
const EXT = {
  image: { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif' },
  video: { mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime' },
  audio: { mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', ogg: 'audio/ogg', aac: 'audio/aac' },
  doc: { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', txt: 'text/plain; charset=utf-8', epub: 'application/epub+zip' },
};
const kindOfExt = (ext) => Object.keys(EXT).find((k) => ext in EXT[k]) || null;
const CHUNK_B64 = 524288; // base64 characters per piece: 393216 bytes, a multiple of 3, so the pieces join into one base64 text
const b64Bytes = (t) => (t.length * 3) / 4 - (t.endsWith('==') ? 2 : t.endsWith('=') ? 1 : 0);
// The first bytes of a file must look like what its extension says (a renamed page or script is refused).
function sniff(ext, b) {
  const at = (i, ...xs) => xs.every((x, j) => b[i + j] === x), txt = (i, t) => [...t].every((c, j) => b[i + j] === c.charCodeAt(0));
  switch (ext) {
    case 'jpg': case 'jpeg': return at(0, 0xff, 0xd8, 0xff);
    case 'png': return at(0, 0x89, 0x50, 0x4e, 0x47);
    case 'gif': return txt(0, 'GIF8');
    case 'webp': return txt(0, 'RIFF') && txt(8, 'WEBP');
    case 'avif': case 'mp4': case 'm4a': case 'mov': return txt(4, 'ftyp');
    case 'webm': return at(0, 0x1a, 0x45, 0xdf, 0xa3);
    case 'mp3': return txt(0, 'ID3') || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0);
    case 'aac': return b[0] === 0xff && (b[1] & 0xf0) === 0xf0;
    case 'wav': return txt(0, 'RIFF') && txt(8, 'WAVE');
    case 'ogg': return txt(0, 'OggS');
    case 'pdf': return txt(0, '%PDF');
    case 'docx': case 'xlsx': case 'pptx': case 'epub': return at(0, 0x50, 0x4b, 0x03, 0x04);
    case 'txt': return ![...b].includes(0);
    default: return false;
  }
}
const mb = (n) => n * 1048576;
const limits = (env) => ({
  ghFile: mb(Number(env.MEDIA_GH_FILE_MB) || 8), ghTotal: mb(Number(env.MEDIA_GH_TOTAL_MB) || 250),
  r2File: mb(Number(env.MEDIA_R2_FILE_MB) || 90), r2Total: mb((Number(env.MEDIA_R2_TOTAL_GB) || 9) * 1024), r2: !!env.MEDIA,
});
async function mediaUsage(env) {
  const rows = (await env.DB.prepare("SELECT store, COALESCE(SUM(size), 0) AS n, COUNT(*) AS c FROM media WHERE status != 'removing' GROUP BY store").all()).results;
  const get = (st) => rows.find((r) => r.store === st) || { n: 0, c: 0 };
  return { github: get('github').n, r2: get('r2').n, githubCount: get('github').c, r2Count: get('r2').c };
}
// Where does a file go? Small files that are not video go to the repository (free, versioned); the rest to R2 when it is set up.
function chooseStore(kind, size, lim, used) {
  if (kind !== 'video' && size <= lim.ghFile && used.github + size <= lim.ghTotal) return { store: 'github' };
  if (lim.r2) {
    if (size > lim.r2File) return { error: `הקובץ גדול מדי (עד ${Math.floor(lim.r2File / 1048576)}MB). כווצו אותו, או לגבי סרטון ארוך קשרו לסרטון ב־YouTube.` };
    if (used.r2 + size > lim.r2Total) return { error: 'המכסה החינמית של אחסון הקבצים הגדולים התמלאה. מחקו קבצים שלא בשימוש בספריית המדיה.' };
    return { store: 'r2' };
  }
  if (kind === 'video' || size > lim.ghFile) return { error: `${kind === 'video' ? 'סרטונים' : `קבצים גדולים מ־${Math.floor(lim.ghFile / 1048576)}MB`} נשמרים באחסון הקבצים הגדולים (R2), והוא עוד לא הופעל. כווצו את הקובץ, או קשרו לסרטון ב־YouTube.` };
  return { error: 'המכסה החינמית של אחסון הקבצים במאגר התמלאה. מחקו קבצים שלא בשימוש בספריית המדיה.' };
}
const mediaSlug = (name) => String(name).replace(/\.[^.]*$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'file';
const mediaUrl = (env, row, origin) => (row.store === 'github' ? `/media/${row.key.replace(/^site\/media\//, '')}` : `${(env.MEDIA_PUBLIC_URL || `${origin}/m`).replace(/\/$/, '')}/${row.key}`);
const mediaView = (env, r, origin) => ({ id: r.id, name: r.name, kind: r.kind, mime: r.mime, size: r.size, store: r.store, key: r.key, status: r.status, by: r.by_name, ts: r.created_at, url: mediaUrl(env, r, origin) });

// A photo's file, staged like any media but kept under data/img/<id>/ so that it is published with the photo's registry entry.
async function photoInit(env, me, b) {
  const id = String(b.photo.id || ''), file = String(b.photo.file || ''), size = Number(b.size), key = `data/img/${id}/${file}`;
  if (!PHOTO_FILE.test(key)) throw fail('שם קובץ תמונה לא תקין', 400);
  if (!Number.isInteger(size) || size < 1 || size > budgetFor(file)) throw fail(`הקובץ ${file} גדול מדי (עד ${Math.round(budgetFor(file) / 1000)}KB). כווצו את התמונה.`, 413);
  await env.DB.prepare("DELETE FROM media_chunks WHERE id IN (SELECT id FROM media WHERE status = 'uploading' AND created_at < ?)").bind(Date.now() - 36e5).run();
  await env.DB.prepare("DELETE FROM media WHERE status = 'uploading' AND created_at < ?").bind(Date.now() - 36e5).run();
  if (await env.DB.prepare("SELECT 1 AS x FROM media WHERE key = ? AND status != 'removing'").bind(key).first() || await publishedSha(env, key)) throw fail('תמונה בשם הזה כבר קיימת או ממתינה לפרסום', 409);
  const pick = chooseStore('image', size, limits(env), await mediaUsage(env));
  if (pick.store !== 'github') throw fail(pick.error || 'אין מקום לתמונה', 413);
  const mid = hex(crypto.getRandomValues(new Uint8Array(4)));
  await env.DB.prepare("INSERT INTO media (id, name, kind, mime, size, store, key, status, email, by_name, created_at) VALUES (?, ?, 'photo', 'image/webp', ?, 'github', ?, 'uploading', ?, ?, ?)").bind(mid, `${id}/${file}`, size, key, me.email, me.shown, Date.now()).run();
  return { id: mid, store: 'github', chunk: CHUNK_B64 };
}
async function mediaInit(env, me, b) {
  if (b.photo) return photoInit(env, me, b);
  const name = String(b.name || '').trim().slice(0, 120), ext = (/\.([A-Za-z0-9]{1,5})$/.exec(name) || [])[1]?.toLowerCase(), size = Number(b.size);
  const kind = ext && kindOfExt(ext);
  if (!kind) throw fail('סוג הקובץ לא נתמך. אפשר: תמונות (jpg, png, webp, gif, avif), סרטונים (mp4, webm), שמע (mp3, m4a, wav, ogg) ומסמכים (pdf, docx, xlsx, pptx, txt, epub).', 400);
  // A photo has rules (a description, a credit, who is in it, the owner's approval) that a loose file cannot carry.
  if (kind === 'image') throw fail('תמונות מעלים דרך ספריית התמונות (תפריט ״תמונות״), שם שואלים על התיאור, הקרדיט והאנשים בתמונה.', 400);
  if (!Number.isInteger(size) || size < 1) throw fail('הקובץ ריק', 400);
  await env.DB.prepare("DELETE FROM media_chunks WHERE id IN (SELECT id FROM media WHERE status = 'uploading' AND created_at < ?)").bind(Date.now() - 36e5).run();
  await env.DB.prepare("DELETE FROM media WHERE status = 'uploading' AND created_at < ?").bind(Date.now() - 36e5).run();
  const pick = chooseStore(kind, size, limits(env), await mediaUsage(env));
  if (pick.error) throw fail(pick.error, 413);
  const id = hex(crypto.getRandomValues(new Uint8Array(4))), file = `${id}-${mediaSlug(name)}.${ext}`, key = pick.store === 'github' ? `site/media/${file}` : file;
  await env.DB.prepare("INSERT INTO media (id, name, kind, mime, size, store, key, status, email, by_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'uploading', ?, ?, ?)").bind(id, name, kind, EXT[kind][ext], size, pick.store, key, me.email, me.shown, Date.now()).run();
  return { id, store: pick.store, chunk: CHUNK_B64 };
}
const uploading = async (env, me, id) => {
  const row = await env.DB.prepare('SELECT * FROM media WHERE id = ?').bind(String(id)).first();
  if (!row || row.status !== 'uploading' || row.email !== me.email) throw fail('ההעלאה לא נמצאה. התחילו מחדש.', 404);
  return row;
};
async function mediaChunk(env, me, b) {
  const row = await uploading(env, me, b.id), n = Number(b.n), data = b.data;
  if (row.store !== 'github' || !Number.isInteger(n) || n < 0 || typeof data !== 'string' || !data.length || data.length > CHUNK_B64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw fail('חלק לא תקין', 400);
  if (n === 0) {
    const ext = row.key.split('.').pop();
    if (!sniff(ext, Uint8Array.from(atob(data.slice(0, 24)), (c) => c.charCodeAt(0)))) { await mediaDrop(env, row); throw fail('תוכן הקובץ לא מתאים לסוג שלו', 400); }
  }
  await env.DB.prepare('INSERT INTO media_chunks (id, n, data) VALUES (?, ?, ?) ON CONFLICT(id, n) DO UPDATE SET data = excluded.data').bind(row.id, n, data).run();
  return { ok: true };
}
async function mediaDone(env, me, b) {
  const row = await uploading(env, me, b.id);
  if (row.store !== 'github') throw fail('לא שייך להעלאה הזאת', 400);
  const parts = (await env.DB.prepare('SELECT n, LENGTH(data) AS len, data FROM media_chunks WHERE id = ? ORDER BY n').bind(row.id).all()).results;
  const whole = parts.length && parts.every((p, i) => p.n === i && (i === parts.length - 1 ? p.data.length % 4 === 0 : p.len === CHUNK_B64));
  if (!whole || parts.reduce((a, p) => a + b64Bytes(p.data), 0) !== row.size) { await mediaDrop(env, row); throw fail('ההעלאה לא הושלמה כראוי. נסו שוב.', 400); }
  await env.DB.prepare("UPDATE media SET status = 'staged' WHERE id = ?").bind(row.id).run();
  await logEntry(env, me, 'media-upload', row.key, `${row.name} · ${row.size} בתים · ממתין לפרסום`);
  return { item: mediaView(env, { ...row, status: 'staged' }, '') };
}
// Large files go straight to R2 as one stream (and are live at once: they are only reachable by a link a page holds).
async function mediaR2(env, me, id, body) {
  const row = await uploading(env, me, id);
  if (row.store !== 'r2' || !env.MEDIA || !body) throw fail('אחסון הקבצים הגדולים לא זמין', 400);
  await env.MEDIA.put(row.key, body, { httpMetadata: { contentType: row.mime, cacheControl: 'public, max-age=31536000, immutable' } });
  const head = await env.MEDIA.head(row.key), first = head && head.size ? await env.MEDIA.get(row.key, { range: { offset: 0, length: 16 } }) : null;
  const ok = head && head.size === row.size && first && sniff(row.key.split('.').pop(), new Uint8Array(await first.arrayBuffer()));
  if (!ok) { await env.MEDIA.delete(row.key); await mediaDrop(env, row); throw fail('ההעלאה לא הושלמה כראוי, או שהתוכן לא מתאים לסוג הקובץ', 400); }
  await env.DB.prepare("UPDATE media SET status = 'published' WHERE id = ?").bind(row.id).run();
  await logEntry(env, me, 'media-upload', row.key, `${row.name} · ${row.size} בתים`);
  return { item: mediaView(env, { ...row, status: 'published' }, '') };
}
async function mediaDrop(env, row) {
  await env.DB.prepare('DELETE FROM media_chunks WHERE id = ?').bind(row.id).run();
  await env.DB.prepare('DELETE FROM media WHERE id = ?').bind(row.id).run();
}
async function mediaList(env, origin) {
  const lim = limits(env), used = await mediaUsage(env);
  // A photo's files belong to the photo library, not to the list of loose files.
  const rows = (await env.DB.prepare("SELECT * FROM media WHERE status != 'uploading' AND kind != 'photo' ORDER BY created_at DESC").all()).results;
  return { items: rows.map((r) => mediaView(env, r, origin)), quota: { github: { used: used.github, max: lim.ghTotal, fileMax: lim.ghFile }, r2: { enabled: lim.r2, used: used.r2, max: lim.r2Total, fileMax: lim.r2File } } };
}
async function mediaRemove(env, me, id) {
  const row = await env.DB.prepare('SELECT * FROM media WHERE id = ?').bind(String(id)).first();
  if (!row) throw fail('הקובץ לא נמצא', 404);
  if (row.status !== 'staged' && !me.publisher) throw fail('רק מפרסם יכול למחוק קובץ שכבר באתר', 403);
  if (row.status === 'staged' && row.email !== me.email && !me.publisher) throw fail('אפשר למחוק רק קובץ שהעליתם בעצמכם', 403);
  if (row.store === 'r2') { if (env.MEDIA) await env.MEDIA.delete(row.key); await mediaDrop(env, row); }
  else if (row.status === 'published') await env.DB.prepare("UPDATE media SET status = 'removing', email = ?, by_name = ?, created_at = ? WHERE id = ?").bind(me.email, me.shown, Date.now(), row.id).run();
  else await mediaDrop(env, row);
  await logEntry(env, me, 'media-delete', row.key, row.name);
  return { ok: true, pending: row.store === 'github' && row.status === 'published' };
}
// Public: R2 files served by this worker when MEDIA_PUBLIC_URL is not set (with Range, for video and audio).
async function serveMedia(env, req, file) {
  if (!env.MEDIA || !/^[a-z0-9][\w.-]{0,100}$/.test(file)) return new Response('not found', { status: 404 });
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('Range') || ''), head = await env.MEDIA.head(file);
  if (!head) return new Response('not found', { status: 404 });
  let range;
  if (m && (m[1] || m[2])) { const start = m[1] ? Number(m[1]) : Math.max(0, head.size - Number(m[2])), end = m[1] && m[2] ? Math.min(Number(m[2]), head.size - 1) : head.size - 1; if (start > end || start >= head.size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${head.size}` } }); range = { offset: start, length: end - start + 1 }; }
  const obj = await env.MEDIA.get(file, range ? { range } : undefined);
  const h = { 'Content-Type': (head.httpMetadata && head.httpMetadata.contentType) || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff', 'Content-Length': String(range ? range.length : head.size) };
  if (range) h['Content-Range'] = `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`;
  return new Response(req.method === 'HEAD' ? null : obj.body, { status: range ? 206 : 200, headers: h });
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

// ---- photos: the rules, on the server ----
// The editor checks these as people type, but a browser can be bypassed, and a bad file that reaches the live branch stops the site from
// building. So the server checks them too, with the same code: when a file is saved, and again when it is published.
const REGISTRY = 'data/images.json';
const registryNow = async (env, rows) => {
  const mine = (rows || []).find((r) => r.path === REGISTRY && !r.deleted);
  try { return JSON.parse(mine ? mine.content : (await publishedText(env, REGISTRY)) || '[]'); } catch { return []; }
};
async function photoRulesOnSave(env, me, path, text, draftText) {
  const data = JSON.parse(text);
  if (path === REGISTRY) {
    if (!Array.isArray(data)) throw fail('רשימת התמונות חייבת להיות רשימה', 400);
    const bad = data.flatMap((im) => imageProblems(im).map((m) => `תמונה ״${im.id}״: ${m}`));
    if (bad.length) throw fail(bad[0], 400);
    const before = JSON.parse(draftText || (await publishedText(env, REGISTRY)) || '[]');
    const shape = registryShapeChanges(before, data);
    if (shape.length) throw fail(shape[0], 400);
    const owner = ownerOnlyChanges(before, data);
    if (owner.length && !me.owner) throw fail(owner[0], 403);
    return;
  }
  if (PAGE_FILE.test(path)) {
    const blocks = Array.isArray(data.blocks) ? data.blocks : [];
    for (const b of blocks) if (b && b.type === 'image' && !b.id) throw fail('בלוק תמונה צריך לבחור תמונה מספריית התמונות (לא קובץ או קישור)', 400);
    const bad = blockProblems(blocks);
    if (bad.length) throw fail(bad[0], 400);
  }
}
// Before publishing: every photo a page shows is in the registry and approved, and every file of a new photo is live or goes out with it.
async function photoPreflight(env, rows, together) {
  const reg = await registryNow(env, rows), live = JSON.parse((await publishedText(env, REGISTRY)) || '[]');
  const has = async (key) => together.has(key) || !!(await publishedSha(env, key));
  const regRow = rows.find((r) => r.path === REGISTRY && !r.deleted);
  if (regRow) {
    for (const im of reg) {
      const bad = imageProblems(im);
      if (bad.length) throw fail(`תמונה ״${im.id}״: ${bad[0]}`, 400);
      if (live.some((x) => x.id === im.id)) continue;
      for (const f of photoFiles(im)) if (!(await has(`data/img/${im.id}/${f}`))) throw fail(`התמונה ״${im.id}״ חדשה והקובץ ${f} שלה עוד לא פורסם. סמנו גם את קבצי התמונה לפרסום.`, 400);
    }
  }
  for (const r of rows.filter((x) => !x.deleted && PAGE_FILE.test(x.path))) {
    let page = {}; try { page = JSON.parse(r.content); } catch { /* checked when saved */ }
    for (const b of page.blocks || []) {
      const ids = b.type === 'image' ? [b.id] : b.type === 'gallery' && Array.isArray(b.ids) ? b.ids : [];
      for (const id of ids) {
        const im = reg.find((x) => x.id === id), where = `הדף ״${cleanName(page.title)}״`;
        if (!im) throw fail(`${where} משתמש בתמונה שאינה בספרייה: ${id}`, 400);
        if (im.rights !== 'approved') throw fail(`${where} משתמש בתמונה שעוד לא אושרה לפרסום: ${id}`, 400);
        if (!(await has(`data/img/${id}/${im.w}.webp`))) throw fail(`${where} משתמש בתמונה שהקבצים שלה עוד לא באתר: ${id}`, 400);
      }
    }
  }
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
  await photoRulesOnSave(env, me, path, text, row && !row.deleted ? row.content : null);
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
  // Media waiting in D1 to be committed (or to be removed) is a pending change too.
  const media = (await env.DB.prepare("SELECT * FROM media WHERE store = 'github' AND status IN ('staged', 'removing') ORDER BY created_at DESC").all()).results;
  for (const r of media) out.push({ path: r.key, status: r.status === 'staged' ? 'added' : 'removed', name: r.by_name, ts: r.created_at, created: r.created_at, sha: null, base: null, media: true, size: r.size, title: r.name, kind: r.kind });
  return out;
}

// Publishing: the chosen drafts become one commit on BRANCH. A file the live site changed since the draft began is a conflict,
// and nothing is published until the editor says what to do with it (force: publish mine anyway).
async function publish(env, me, paths, force, note) {
  const dpaths = paths.filter(PATH_OK), mpaths = paths.filter(MEDIA_OK);
  const rows = dpaths.length ? (await env.DB.prepare(`SELECT * FROM drafts WHERE path IN (${marks(dpaths.length)})`).bind(...dpaths).all()).results : [];
  const media = mpaths.length ? (await env.DB.prepare(`SELECT * FROM media WHERE store = 'github' AND status IN ('staged', 'removing') AND key IN (${marks(mpaths.length)})`).bind(...mpaths).all()).results : [];
  if (!rows.length && !media.length) throw fail('אין שינויים לפרסם', 400);
  // A page must not point at a file that is neither live nor published together with it: the build would fail.
  const together = new Set(media.filter((m) => m.status === 'staged').map((m) => m.key));
  for (const r of rows.filter((x) => !x.deleted && PAGE_FILE.test(x.path))) {
    let blocks = []; try { blocks = JSON.parse(r.content).blocks || []; } catch { /* checked when saved */ }
    for (const b of blocks) {
      const m = /^\/media\/([a-z0-9][\w.-]*)$/.exec(String(b && b.src || ''));
      if (m && !together.has(`site/media/${m[1]}`) && !(await publishedSha(env, `site/media/${m[1]}`))) throw fail(`הדף ״${cleanName(JSON.parse(r.content).title)}״ משתמש בקובץ שעוד לא פורסם: ${m[1]}. סמנו גם אותו לפרסום.`, 400);
    }
  }
  await photoPreflight(env, rows, together);
  const pubs = new Map(await Promise.all(rows.map(async (r) => [r.path, await publishedSha(env, r.path)])));
  const shas = new Map(await Promise.all(rows.map(async (r) => [r.path, r.deleted ? null : await blobSha(r.content)])));
  const conflicts = rows.filter((r) => pubs.get(r.path) !== (r.base_sha || null) && pubs.get(r.path) !== shas.get(r.path) && !force.includes(r.path)).map((r) => r.path);
  if (conflicts.length) throw fail('חלק מהקבצים שונו גם באתר החי מאז שהתחלתם לערוך אותם', 409, { conflicts });
  const blobs = new Map();
  for (const r of rows) if (!r.deleted && pubs.get(r.path) !== shas.get(r.path)) blobs.set(r.path, (await gh(env, 'git/blobs', { method: 'POST', body: { content: toB64(r.content), encoding: 'base64' } })).sha);
  const entries = rows.filter((r) => (r.deleted ? pubs.get(r.path) : blobs.has(r.path))).map((r) => ({ path: r.path, mode: '100644', type: 'blob', sha: r.deleted ? null : blobs.get(r.path) }));
  for (const m of media) {
    if (m.status === 'staged') {
      const parts = (await env.DB.prepare('SELECT data FROM media_chunks WHERE id = ? ORDER BY n').bind(m.id).all()).results;
      entries.push({ path: m.key, mode: '100644', type: 'blob', sha: (await gh(env, 'git/blobs', { method: 'POST', body: { content: parts.map((p) => p.data).join(''), encoding: 'base64' } })).sha });
    } else if (await publishedSha(env, m.key)) entries.push({ path: m.key, mode: '100644', type: 'blob', sha: null });
  }
  const editors = [...new Set([...rows.map((r) => r.name), ...media.map((m) => m.by_name)])];
  const lines = [...rows.map((r) => `- ${label(r)}: ${r.path}`), ...media.map((m) => `- ${m.status === 'staged' ? 'קובץ חדש' : 'קובץ נמחק'}: ${m.key}`)];
  const total = rows.length + media.length;
  const subject = `פרסום: ${cleanName(note) || `${total} שינויים`}`;
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
  if (rows.length) await env.DB.prepare(`DELETE FROM drafts WHERE path IN (${marks(rows.length)})`).bind(...rows.map((r) => r.path)).run();
  for (const m of media) {
    await env.DB.prepare('DELETE FROM media_chunks WHERE id = ?').bind(m.id).run();
    if (m.status === 'staged') await env.DB.prepare("UPDATE media SET status = 'published' WHERE id = ?").bind(m.id).run();
    else await env.DB.prepare('DELETE FROM media WHERE id = ?').bind(m.id).run();
  }
  for (const r of rows) await logEntry(env, me, 'publish', r.path, `${label(r)} · נערך על ידי ${r.name}`, sha);
  for (const m of media) await logEntry(env, me, 'publish', m.key, `${m.status === 'staged' ? 'קובץ חדש' : 'קובץ נמחק'} · ${m.name}`, sha);
  await logEntry(env, me, 'publish-all', null, cleanName(note) || `${total} שינויים`, sha);
  return { sha, published: [...rows.map((r) => r.path), ...media.map((m) => m.key)] };
}

async function discard(env, me, paths) {
  const dpaths = paths.filter(PATH_OK), mpaths = paths.filter(MEDIA_OK);
  const rows = dpaths.length ? (await env.DB.prepare(`SELECT * FROM drafts WHERE path IN (${marks(dpaths.length)})`).bind(...dpaths).all()).results : [];
  const media = mpaths.length ? (await env.DB.prepare(`SELECT * FROM media WHERE store = 'github' AND status IN ('staged', 'removing') AND key IN (${marks(mpaths.length)})`).bind(...mpaths).all()).results : [];
  // An editor may drop only their own work; a publisher may drop anyone's.
  if ((rows.some((r) => r.email !== me.email) || media.some((m) => m.email !== me.email)) && !me.publisher) throw fail('אפשר לבטל רק שינויים שביצעתם בעצמכם', 403);
  if (rows.length) await env.DB.prepare(`DELETE FROM drafts WHERE path IN (${marks(rows.length)})`).bind(...rows.map((r) => r.path)).run();
  for (const m of media) {
    if (m.status === 'staged') await mediaDrop(env, m);
    else await env.DB.prepare("UPDATE media SET status = 'published' WHERE id = ?").bind(m.id).run(); // the removal is cancelled
  }
  for (const r of rows) await logEntry(env, me, 'discard', r.path, `${label(r)} · נערך על ידי ${r.name}`);
  for (const m of media) await logEntry(env, me, 'discard', m.key, m.name);
  return { discarded: [...rows.map((r) => r.path), ...media.map((m) => m.key)] };
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

  if (p === '/translate' && req.method === 'POST') return json(await slugFor(env, (await bodyOf(req)).text, () => aiQuota(env, me.email)), 200, cors);
  if (p === '/media' && req.method === 'GET') return json(await mediaList(env, url.origin), 200, cors);
  if (p === '/media/init' && req.method === 'POST') return json(await mediaInit(env, me, await bodyOf(req)), 200, cors);
  if (p === '/media/chunk' && req.method === 'POST') return json(await mediaChunk(env, me, await bodyOf(req)), 200, cors);
  if (p === '/media/done' && req.method === 'POST') return json(await mediaDone(env, me, await bodyOf(req)), 200, cors);
  if (p === '/media/r2' && req.method === 'PUT') return json(await mediaR2(env, me, q.get('id'), req.body), 200, cors);
  let mm;
  if ((mm = /^\/media\/([0-9a-f]{8})$/.exec(p)) && req.method === 'DELETE') return json(await mediaRemove(env, me, mm[1]), 200, cors);
  // A waiting file, as base64 pieces, so the editor can show it before it is published.
  if ((mm = /^\/media\/([0-9a-f]{8})\/chunk$/.exec(p)) && req.method === 'GET') {
    const row = await env.DB.prepare("SELECT 1 AS x FROM media WHERE id = ? AND status = 'staged'").bind(mm[1]).first(), c = row && await env.DB.prepare('SELECT data FROM media_chunks WHERE id = ? AND n = ?').bind(mm[1], Number(q.get('n')) || 0).first();
    return c ? json({ data: c.data }, 200, cors) : json({ message: 'לא נמצא' }, 404, cors);
  }
  if (p === '/changes' && req.method === 'GET') return json({ changes: await changes(env, q.get('check') === '1') }, 200, cors);
  if (p === '/history' && req.method === 'GET') return json({ history: await history(env, q.get('path')) }, 200, cors);
  if (p === '/log' && req.method === 'GET') {
    if (!me.publisher) return json({ message: 'היומן פתוח למפרסמים ולבעלי האתר' }, 403, cors);
    const limit = Math.min(200, Math.max(1, Number(q.get('limit')) || 50)), before = Number(q.get('before')) || 0;
    const rows = (await env.DB.prepare(`SELECT id, ts, email, name, action, path, summary, sha FROM log ${before ? 'WHERE id < ?' : ''} ORDER BY id DESC LIMIT ?`).bind(...(before ? [before, limit] : [limit])).all()).results;
    return json({ log: rows.map((r) => (me.owner ? r : { ...r, email: null })) }, 200, cors);
  }
  if (req.method === 'POST' && ['/publish', '/discard', '/restore'].includes(p)) {
    const b = await bodyOf(req), paths = Array.isArray(b.paths) ? [...new Set(b.paths.filter((x) => PUB_OK(x)))] : [];
    if (p === '/publish') {
      if (!me.publisher) return json({ message: 'אין לכם הרשאה לפרסם. בקשו מבעל האתר לסמן אתכם כמפרסמים.' }, 403, cors);
      return json(await publish(env, me, paths, Array.isArray(b.force) ? b.force : [], b.note), 200, cors);
    }
    if (p === '/discard') return json(await discard(env, me, b.all ? [...(await env.DB.prepare('SELECT path FROM drafts').all()).results.map((r) => r.path), ...(await env.DB.prepare("SELECT key FROM media WHERE store = 'github' AND status IN ('staged', 'removing')").all()).results.map((r) => r.key)] : paths), 200, cors);
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
  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname.startsWith('/m/')) return serveMedia(env, req, url.pathname.slice(3));
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
export { MEDIA_OK, chooseStore, sniff, toSlug, slugFor, route, PATH_OK, blobSha, verifyGoogle, verifyAccessToken, makeSession, readSession, allowed, who, isOwner, sha256, handle };
