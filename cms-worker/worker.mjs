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
import { boundedStream, readJsonBody, RequestBodyError } from './request-guards.mjs';
import { loginLimit, writeLimit } from './rate-limit.mjs';
import { getDataStore } from './data-store.mjs';

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
// Only absent/null records use a legacy default. Failed reads and malformed
// stored JSON must remain server errors, never restore obsolete permissions.
const kvJson = async (env, key, fallback) => JSON.parse((await env.EDITORS.get(key)) ?? 'null') ?? fallback;
// "people" is the current list; "editors" (a list of emails) is how it was kept before roles existed.
async function people(env) {
  const list = await kvJson(env, 'people', null);
  if (list !== null) {
    if (!Array.isArray(list)) throw new Error('Invalid editor membership data');
    return list;
  }
  const legacy = await kvJson(env, 'editors', []);
  if (!Array.isArray(legacy)) throw new Error('Invalid legacy membership data');
  return legacy.map((email) => ({ email, name: '', publisher: false }));
}
// Node's KV adapter can lock a JSON value across its read/modify/write cycle.
// Cloudflare KV keeps the existing get/put behavior, without claiming atomicity.
async function updateKvJson(env, key, fallback, change) {
  if (typeof env.EDITORS.update === 'function') {
    const raw = await env.EDITORS.update(key, (current) => JSON.stringify(change(current === null ? fallback : JSON.parse(current) ?? fallback)));
    return JSON.parse(raw);
  }
  const next = change(await kvJson(env, key, fallback));
  await env.EDITORS.put(key, JSON.stringify(next));
  return next;
}
async function updatePeople(env, change) {
  // Read legacy data before taking a lock: the updater must not obtain another
  // connection, and an existing people row always wins over the fallback.
  const fallback = await people(env);
  return updateKvJson(env, 'people', fallback, change);
}
// Everything about an email that matters here: may it edit, may it publish, and what is it called in public.
async function who(env, email) {
  const e = norm(email), owner = await isOwner(env, e), hash = await sha256(e);
  const person = (await people(env)).find((p) => p.email === e);
  if (!owner && !person) return null;
  // This optional display name grants no permissions: the owner hash was
  // already verified. Preserve its cosmetic fallback only on this read path.
  const names = owner ? await kvJson(env, 'owner-names', {}).catch(() => ({})) : null;
  const name = owner ? names[hash] || '' : person.name || '';
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
const MAX_SESSION_LENGTH = 2048;
const hmacKey = async (env) => {
  const configured = (value) => typeof value === 'string' && value.trim().length > 0;
  let secret;
  if (configured(env.SESSION_SECRET)) secret = env.SESSION_SECRET;
  else if (configured(env.GITHUB_TOKEN)) secret = `session:${await sha256(env.GITHUB_TOKEN)}`;
  else throw new Error('Session signing is not configured');
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
};
async function makeSession(email, env, now = Date.now()) {
  if (typeof email !== 'string' || email.length > 254 || !EMAIL.test(email) || email !== norm(email)) throw new Error('Invalid session identity');
  if (!Number.isFinite(now)) throw new Error('Invalid session time');
  const body = b64url(enc.encode(JSON.stringify({ email, exp: Math.floor(now / 1000) + SESSION_HOURS * 3600 })));
  return `${body}.${b64url(await crypto.subtle.sign('HMAC', await hmacKey(env), enc.encode(body)))}`;
}
async function readSession(token, env, now = Date.now() / 1000) {
  if (typeof token !== 'string' || token.length > MAX_SESSION_LENGTH || !Number.isFinite(now)) return null;
  const parts = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!parts) return null;
  const [, body, sig] = parts;
  let s, signature;
  // Only malformed caller input is caught here. Signing/configuration and membership failures still propagate.
  try {
    const bytes = unb64url(body);
    signature = unb64url(sig);
    if (b64url(bytes) !== body || b64url(signature) !== sig) return null;
    s = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch { return null; }
  if (!s || typeof s !== 'object' || Array.isArray(s) || typeof s.email !== 'string' || s.email.length > 254 || !EMAIL.test(s.email) || s.email !== norm(s.email) || !Number.isSafeInteger(s.exp) || s.exp <= now) return null;
  if (!(await crypto.subtle.verify('HMAC', await hmacKey(env), signature, enc.encode(body)))) return null;
  // Re-checked on every request, so removing an editor takes effect at once.
  return (await allowed(env, s.email)) ? s.email : null;
}

// ---- storage: native D1 in Workers, typed MySQL operations in Node ----
const schema = (env) => getDataStore(env).ensureSchema();
const logEntry = (env, me, action, path, summary, sha) => getDataStore(env).appendLog({
  ts: Date.now(), email: me ? me.email : null, name: me ? me.shown : null, action,
  path: path || null, summary: summary ? String(summary).slice(0, 500) : null, sha: sha || null,
});
const draftRow = (env, path) => getDataStore(env).getDraft(path);

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
  const limit = (value, fallback) => {
    if (value === undefined) return fallback;
    if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value.trim()))) return null;
    const n = Number(value);
    return Number.isSafeInteger(n) && n > 0 && n <= 10000 ? n : null;
  };
  const day = new Date().toISOString().slice(0, 10), perUser = limit(env.TRANSLATE_PER_USER, 100), perDay = limit(env.TRANSLATE_PER_DAY, 300);
  // Explicit invalid settings disable model calls; they must not silently grant
  // default spending. Each configured daily ceiling is a positive integer <=10,000.
  if (perUser === null || perDay === null) return false;
  // Both budgets and the increment belong to one atomic storage operation.
  return getDataStore(env).consumeAiQuota({ day, email, perUser, perDay });
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
  // R2 deletion can fail after its exclusive claim. Count that reservation until
  // storage is actually deleted and its row removed, including retries.
  const rows = await getDataStore(env).mediaUsage();
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

async function expireMediaReservations(env) {
  await getDataStore(env).expireMedia(Date.now() - 36e5);
}

async function reserveMedia(env, me, item, lim) {
  return getDataStore(env).reserveMedia({ item, actor: { email: me.email, name: me.shown }, now: Date.now(), limits: lim });
}

async function reservationFailure(env, kind, size, lim) {
  const pick = chooseStore(kind === 'photo' ? 'image' : kind, size, lim, await mediaUsage(env));
  return fail(pick.error || (kind === 'photo' ? 'אין מקום לתמונה' : 'המכסה השתנתה בזמן ההעלאה. נסו שוב.'), 413);
}

// A photo's file, staged like any media but kept under data/img/<id>/ so that it is published with the photo's registry entry.
async function photoInit(env, me, b) {
  const id = String(b.photo.id || ''), file = String(b.photo.file || ''), size = Number(b.size), key = `data/img/${id}/${file}`;
  if (!PHOTO_FILE.test(key)) throw fail('שם קובץ תמונה לא תקין', 400);
  if (!Number.isInteger(size) || size < 1 || size > budgetFor(file)) throw fail(`הקובץ ${file} גדול מדי (עד ${Math.round(budgetFor(file) / 1000)}KB). כווצו את התמונה.`, 413);
  await expireMediaReservations(env);
  if (await getDataStore(env).hasActiveMediaKey(key) || await publishedSha(env, key)) throw fail('תמונה בשם הזה כבר קיימת או ממתינה לפרסום', 409);
  const mid = hex(crypto.getRandomValues(new Uint8Array(4))), lim = limits(env);
  const reserved = await reserveMedia(env, me, { id: mid, name: `${id}/${file}`, kind: 'photo', mime: 'image/webp', size, githubKey: key, r2Key: key }, lim);
  if (!reserved) {
    if (await getDataStore(env).hasActiveMediaKey(key)) throw fail('תמונה בשם הזה כבר קיימת או ממתינה לפרסום', 409);
    throw await reservationFailure(env, 'photo', size, lim);
  }
  return { ...reserved, chunk: CHUNK_B64 };
}
async function mediaInit(env, me, b) {
  if (b.photo) return photoInit(env, me, b);
  const name = String(b.name || '').trim().slice(0, 120), ext = (/\.([A-Za-z0-9]{1,5})$/.exec(name) || [])[1]?.toLowerCase(), size = Number(b.size);
  const kind = ext && kindOfExt(ext);
  if (!kind) throw fail('סוג הקובץ לא נתמך. אפשר: תמונות (jpg, png, webp, gif, avif), סרטונים (mp4, webm), שמע (mp3, m4a, wav, ogg) ומסמכים (pdf, docx, xlsx, pptx, txt, epub).', 400);
  if (!Number.isInteger(size) || size < 1) throw fail('הקובץ ריק', 400);
  await expireMediaReservations(env);
  const id = hex(crypto.getRandomValues(new Uint8Array(4))), file = `${id}-${mediaSlug(name)}.${ext}`, lim = limits(env);
  const reserved = await reserveMedia(env, me, { id, name, kind, mime: EXT[kind][ext], size, githubKey: `site/media/${file}`, r2Key: file }, lim);
  if (!reserved) throw await reservationFailure(env, kind, size, lim);
  return { ...reserved, chunk: CHUNK_B64 };
}
const uploading = async (env, me, id) => {
  const row = await getDataStore(env).getMedia(String(id));
  if (!row || row.status !== 'uploading' || row.email !== me.email) throw fail('ההעלאה לא נמצאה. התחילו מחדש.', 404);
  return row;
};
// Each index owns one fixed byte range in the declared file. Validate that range
// before storing anything, including retries and the padding of the final piece.
function validChunk(size, n, data) {
  const bytesPerChunk = CHUNK_B64 / 4 * 3;
  if (!Number.isSafeInteger(size) || size < 1 || !Number.isSafeInteger(n) || n < 0 || n >= Math.ceil(size / bytesPerChunk) || typeof data !== 'string') return false;
  const bytes = Math.min(bytesPerChunk, size - n * bytesPerChunk);
  if (data.length !== 4 * Math.ceil(bytes / 3) || !/^[A-Za-z0-9+/]+={0,2}$/.test(data) || b64Bytes(data) !== bytes) return false;
  try { return btoa(atob(data)) === data; } catch { return false; }
}
async function mediaChunk(env, me, b) {
  const row = await uploading(env, me, b.id), n = Number(b.n), data = b.data;
  if (row.store !== 'github' || !validChunk(row.size, n, data)) throw fail('חלק לא תקין', 400);
  if (n === 0) {
    const ext = row.key.split('.').pop();
    if (!sniff(ext, Uint8Array.from(atob(data.slice(0, 24)), (c) => c.charCodeAt(0)))) { await dropUploading(env, row); throw fail('תוכן הקובץ לא מתאים לסוג שלו', 400); }
  }
  // Check the upload state in the write itself. A delayed request cannot add
  // orphan chunks after cancellation or change a file already being published.
  // Identical retries are safe; replacing an accepted piece requires a new upload.
  const written = await getDataStore(env).writeMediaChunk({ id: row.id, n, data, email: me.email });
  if (!written) throw fail('ההעלאה השתנתה בינתיים. התחילו אותה מחדש.', 409);
  return { ok: true };
}
async function dropUploading(env, row) {
  await getDataStore(env).dropUploading(row.id);
}
async function mediaDone(env, me, b) {
  const row = await uploading(env, me, b.id);
  if (row.store !== 'github') throw fail('לא שייך להעלאה הזאת', 400);
  const parts = await getDataStore(env).getUploadChunks(row.id);
  const whole = parts.length && parts.every((p, i) => p.n === i && validChunk(row.size, p.n, p.data));
  if (!whole || parts.reduce((a, p) => a + b64Bytes(p.data), 0) !== row.size) { await dropUploading(env, row); throw fail('ההעלאה לא הושלמה כראוי. נסו שוב.', 400); }
  const completed = await getDataStore(env).finishGithubUpload(row.id, me.email);
  if (!completed) throw fail('ההעלאה השתנתה בינתיים. התחילו אותה מחדש.', 409);
  await logEntry(env, me, 'media-upload', row.key, `${row.name} · ${row.size} בתים · ממתין לפרסום`);
  return { item: mediaView(env, { ...row, status: 'staged' }, '') };
}
// R2 needs a stream with a known length on Workers. Keep its FixedLengthStream
// metadata while checking each incoming chunk before R2 can consume it. Other
// runtimes can use the same backpressure/cancellation path via TransformStream.
async function streamToR2(bucket, row, body) {
  const guarded = boundedStream(body, { maxBytes: row.size, expectedBytes: row.size });
  const bridge = typeof globalThis.FixedLengthStream === 'function' ? new globalThis.FixedLengthStream(row.size) : new TransformStream();
  const abort = new AbortController();
  let validationError;
  const stop = (error) => {
    if (!abort.signal.aborted) abort.abort(error);
    // Once put rejects its reader has finished. Cancelling the readable also
    // releases a pending transform write; aborting pipeTo alone can wait on it.
    if (!bridge.readable.locked) void bridge.readable.cancel(error).catch(() => {});
  };
  const pipe = guarded.pipeTo(bridge.writable, { signal: abort.signal }).catch((error) => {
    if (error instanceof RequestBodyError) validationError = error;
    throw error;
  });
  const put = Promise.resolve().then(() => bucket.put(row.key, bridge.readable, {
    httpMetadata: { contentType: row.mime, cacheControl: 'public, max-age=31536000, immutable' },
  })).catch((error) => { stop(error); throw error; });
  try { await Promise.all([pipe, put]); }
  catch (error) {
    stop(error);
    await Promise.allSettled([pipe, put]);
    // If cancelling the bridge already errored its writer, pipeTo may finish
    // without forwarding the abort to its source. Its lock is now released.
    if (!guarded.locked) void guarded.cancel(error).catch(() => {});
    // R2 may wrap a stream failure; return the actual client size/shape error.
    throw validationError || error;
  }
}

// Large files go straight to R2 as one stream (and are live at once: they are only reachable by a link a page holds).
async function mediaR2(env, me, id, body) {
  const row = await getDataStore(env).getMedia(String(id));
  if (!row || row.email !== me.email) throw fail('ההעלאה לא נמצאה. התחילו מחדש.', 404);
  if (row.status === 'receiving') throw fail('ההעלאה כבר מתבצעת. המתינו לסיומה.', 409);
  if (row.status !== 'uploading') throw fail('ההעלאה לא נמצאה. התחילו מחדש.', 404);
  if (row.store !== 'r2' || !env.MEDIA || !body) throw fail('אחסון הקבצים הגדולים לא זמין', 400);
  const claimed = await getDataStore(env).claimR2Upload(row.id, me.email);
  if (!claimed) throw fail('ההעלאה כבר השתנתה. רעננו ונסו שוב.', 409);
  try {
    await streamToR2(env.MEDIA, row, body);
    const head = await env.MEDIA.head(row.key), first = head && head.size ? await env.MEDIA.get(row.key, { range: { offset: 0, length: 16 } }) : null;
    const ok = head && head.size === row.size && first && sniff(row.key.split('.').pop(), new Uint8Array(await first.arrayBuffer()));
    if (!ok) throw new RequestBodyError('ההעלאה לא הושלמה כראוי, או שהתוכן לא מתאים לסוג הקובץ', 400);
    const completed = await getDataStore(env).finishR2Upload(row.id);
    if (!completed) throw new Error('The upload reservation changed before completion');
  } catch (error) {
    // Keep the exclusive reservation until partial/invalid storage is removed.
    // If deletion fails or the Worker stops, receiving remains reserved; recovery
    // requires checking/deleting the object before resetting that row, never age alone.
    try { await env.MEDIA.delete(row.key); }
    catch (cause) { throw new Error('The failed upload could not be removed safely', { cause }); }
    await getDataStore(env).resetR2Upload(row.id);
    throw error;
  }
  await logEntry(env, me, 'media-upload', row.key, `${row.name} · ${row.size} בתים`);
  return { item: mediaView(env, { ...row, status: 'published' }, '') };
}
async function mediaDrop(env, row) {
  await getDataStore(env).dropMedia(row.id);
}
async function mediaList(env, origin) {
  const lim = limits(env), used = await mediaUsage(env);
  // A photo's files belong to the photo library, not to the list of loose files.
  const rows = await getDataStore(env).listMedia();
  return { items: rows.map((r) => mediaView(env, r, origin)), quota: { github: { used: used.github, max: lim.ghTotal, fileMax: lim.ghFile }, r2: { enabled: lim.r2, used: used.r2, max: lim.r2Total, fileMax: lim.r2File } } };
}
async function mediaRemove(env, me, id) {
  const row = await getDataStore(env).getMedia(String(id));
  if (!row) throw fail('הקובץ לא נמצא', 404);
  if (row.status === 'receiving') throw fail('ההעלאה עדיין מתבצעת. המתינו לסיומה לפני המחיקה.', 409);
  if (row.status !== 'staged' && !me.publisher) throw fail('רק מפרסם יכול למחוק קובץ שכבר באתר', 403);
  if (row.status === 'staged' && row.email !== me.email && !me.publisher) throw fail('אפשר למחוק רק קובץ שהעליתם בעצמכם', 403);
  if (row.store === 'r2') {
    if (!env.MEDIA) throw fail('אחסון הקבצים הגדולים לא זמין כרגע. נסו שוב מאוחר יותר.', 503);
    const claimed = await getDataStore(env).claimMediaRemoval(row.id, row.status);
    if (!claimed) throw fail('ההעלאה כבר השתנתה. רעננו ונסו שוב.', 409);
    await env.MEDIA.delete(row.key);
    await mediaDrop(env, row);
  }
  else if (row.status === 'published') await getDataStore(env).markGithubRemoval(row.id, { email: me.email, name: me.shown }, Date.now());
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
  const h = { 'Content-Type': (head.httpMetadata && head.httpMetadata.contentType) || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff', 'Content-Length': String(range ? range.length : head.size) };
  if (range) h['Content-Range'] = `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`;
  if (req.method === 'HEAD') return new Response(null, { status: range ? 206 : 200, headers: h });
  const obj = await env.MEDIA.get(file, range ? { range } : undefined);
  if (!obj) return new Response('not found', { status: 404 });
  return new Response(obj.body, { status: range ? 206 : 200, headers: h });
}

const json = (o, status, cors) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...cors } });
const fail = (message, status, extra) => Object.assign(new Error(message), { status, extra });
// MAX_FILE counts UTF-16 code units. Preserve valid non-ASCII files: their UTF-8
// base64 envelope can use four bytes per code unit, plus a small metadata budget.
const bodyOf = (req) => {
  const path = new URL(req.url).pathname;
  const maxBytes = path === '/media/chunk' ? CHUNK_B64 + 16384
    : path.startsWith('/gh/contents/data/') && req.method === 'PUT' ? MAX_FILE * 4 + 65536
      : 1048576;
  return readJsonBody(req, { maxBytes });
};
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
  const rows = (await getDataStore(env).listDraftChildren(dir)).filter((r) => !r.path.slice(dir.length + 1).includes('/'));
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
// Match the complete captured row atomically, preserving concurrent edits.
const draftConflict = () => fail('מישהו אחר שמר את הקובץ הזה בינתיים. טענו אותו מחדש ונסו שוב.', 409);
async function clearDraftSnapshot(env, path, row) {
  if (!(await getDataStore(env).clearDraftSnapshot(path, row))) throw draftConflict();
}
async function writeDraftSnapshot(env, me, path, content, deleted, pub, row) {
  // Strictly advance even when two requests share a millisecond and content.
  const now = Math.max(Date.now(), row ? row.updated_at + 1 : 0);
  const next = { path, content, deleted, base_sha: row ? row.base_sha : pub,
    created_at: row ? row.created_at : now, updated_at: now, email: me.email, name: me.shown };
  if (!(await getDataStore(env).writeDraftSnapshot(next, row))) throw draftConflict();
}

// Saves a file as a draft. expected is the id the editor last saw (null when it is making a new file): if the file has moved
// on since, someone else saved it meanwhile and the editor is told, instead of overwriting their work.
async function saveDraft(env, me, path, text, expected, { auto, restore, summary } = {}) {
  if (!PATH_OK(path)) throw fail('הקובץ הזה לא ניתן לעריכה', 403);
  if (typeof text !== 'string' || text.length > MAX_FILE) throw fail('הקובץ גדול מדי', 413);
  try { JSON.parse(text); } catch { throw fail('הקובץ אינו JSON תקין', 400); }
  const row = await draftRow(env, path), pub = await publishedSha(env, path);
  const current = row ? (row.deleted ? null : await blobSha(row.content)) : pub;
  if (!restore && (expected || null) !== (current || null)) throw draftConflict();
  await photoRulesOnSave(env, me, path, text, row && !row.deleted ? row.content : null);
  const sha = await blobSha(text);
  if (pub && sha === pub) await clearDraftSnapshot(env, path, row); // back to what is published
  else await writeDraftSnapshot(env, me, path, text, 0, pub, row);
  if (restore) await logEntry(env, me, 'restore', path, summary);
  else if (!auto) await logEntry(env, me, 'save', path, summary);
  return { content: { sha, path }, draft: true };
}
async function deleteDraft(env, me, path, expected, summary) {
  if (!PATH_OK(path)) throw fail('הקובץ הזה לא ניתן למחיקה', 403);
  const row = await draftRow(env, path), pub = await publishedSha(env, path);
  const current = row ? (row.deleted ? null : await blobSha(row.content)) : pub;
  if ((expected || null) !== (current || null)) throw draftConflict();
  if (!pub) await clearDraftSnapshot(env, path, row); // it was never published: nothing to remember
  else await writeDraftSnapshot(env, me, path, null, 1, pub, row);
  await logEntry(env, me, 'delete', path, summary);
  return { content: null, draft: true };
}

// ---- changes waiting to be published ----
async function changes(env, check) {
  const rows = await getDataStore(env).listDrafts();
  const out = [];
  for (const r of rows) {
    const sha = r.deleted ? null : await blobSha(r.content);
    const item = { path: r.path, status: r.deleted ? 'removed' : r.base_sha ? 'modified' : 'added', name: r.name, ts: r.updated_at, created: r.created_at, sha, base: r.base_sha };
    if (check) { item.published = await publishedSha(env, r.path); item.conflict = item.published !== (r.base_sha || null) && item.published !== sha; }
    out.push(item);
  }
  // Media waiting in D1 to be committed (or to be removed) is a pending change too.
  const media = await getDataStore(env).listPendingMedia();
  for (const r of media) out.push({ path: r.key, status: r.status === 'staged' ? 'added' : 'removed', name: r.by_name, ts: r.created_at, created: r.created_at, sha: null, base: null, media: true, size: r.size, title: r.name, kind: r.kind });
  return out;
}

// Publishing: the chosen drafts become one commit on BRANCH. A file the live site changed since the draft began is a conflict,
// and nothing is published until the editor says what to do with it (force: publish mine anyway).
async function publish(env, me, paths, force, note) {
  const dpaths = paths.filter(PATH_OK), mpaths = paths.filter(MEDIA_OK);
  const rows = await getDataStore(env).getDrafts(dpaths);
  const media = await getDataStore(env).listPendingMedia(mpaths);
  if (!rows.length && !media.length) throw fail('אין שינויים לפרסם', 400);
  const together = new Set(media.filter((m) => m.status === 'staged').map((m) => m.key));
  const shas = new Map(await Promise.all(rows.map(async (r) => [r.path, r.deleted ? null : await blobSha(r.content)])));
  const blobs = new Map(), mediaBlobs = new Map();
  const editors = [...new Set([...rows.map((r) => r.name), ...media.map((m) => m.by_name)])];
  const lines = [...rows.map((r) => `- ${label(r)}: ${r.path}`), ...media.map((m) => `- ${m.status === 'staged' ? 'קובץ חדש' : 'קובץ נמחק'}: ${m.key}`)];
  const total = rows.length + media.length;
  const subject = `פרסום: ${cleanName(note) || `${total} שינויים`}`;
  let sha = null;
  for (let attempt = 0; ; attempt++) {
    const head = (await gh(env, `git/ref/heads/${env.BRANCH}`)).object.sha;
    // Every read in this attempt uses the same immutable commit, including
    // photo/media dependencies. If the branch moves, validate again before retry.
    const live = { ...env, BRANCH: head };
    const pubs = new Map(await Promise.all(rows.map(async (r) => [r.path, await publishedSha(live, r.path)])));
    const conflicts = rows.filter((r) => pubs.get(r.path) !== (r.base_sha || null) && pubs.get(r.path) !== shas.get(r.path) && !force.includes(r.path)).map((r) => r.path);
    if (conflicts.length) throw fail('חלק מהקבצים שונו גם באתר החי מאז שהתחלתם לערוך אותם', 409, { conflicts });
    // A page's referenced media must be in this commit or in the selected uploads.
    for (const r of rows.filter((x) => !x.deleted && PAGE_FILE.test(x.path))) {
      let blocks = []; try { blocks = JSON.parse(r.content).blocks || []; } catch { /* checked when saved */ }
      for (const b of blocks) {
        const m = /^\/media\/([a-z0-9][\w.-]*)$/.exec(String(b && b.src || ''));
        if (m && !together.has(`site/media/${m[1]}`) && !(await publishedSha(live, `site/media/${m[1]}`))) throw fail(`הדף ״${cleanName(JSON.parse(r.content).title)}״ משתמש בקובץ שעוד לא פורסם: ${m[1]}. סמנו גם אותו לפרסום.`, 400);
      }
    }
    await photoPreflight(live, rows, together);
    for (const r of rows) if (!r.deleted && pubs.get(r.path) !== shas.get(r.path) && !blobs.has(r.path)) blobs.set(r.path, (await gh(env, 'git/blobs', { method: 'POST', body: { content: toB64(r.content), encoding: 'base64' } })).sha);
    const entries = rows.filter((r) => r.deleted ? pubs.get(r.path) : pubs.get(r.path) !== shas.get(r.path)).map((r) => ({ path: r.path, mode: '100644', type: 'blob', sha: r.deleted ? null : blobs.get(r.path) }));
    for (const m of media) {
      if (m.status === 'staged') {
        if (!mediaBlobs.has(m.id)) {
          const parts = await getDataStore(env).getPublishChunks(m.id);
          mediaBlobs.set(m.id, (await gh(env, 'git/blobs', { method: 'POST', body: { content: parts.map((p) => p.data).join(''), encoding: 'base64' } })).sha);
        }
        entries.push({ path: m.key, mode: '100644', type: 'blob', sha: mediaBlobs.get(m.id) });
      } else if (await publishedSha(live, m.key)) entries.push({ path: m.key, mode: '100644', type: 'blob', sha: null });
    }
    if (!entries.length) {
      if ((await gh(env, `git/ref/heads/${env.BRANCH}`)).object.sha === head) break;
      if (attempt >= 2) throw fail('ענף הפרסום השתנה בינתיים. נסו לפרסם שוב.', 409);
      continue;
    }
    const tree = (await gh(env, `git/commits/${head}`)).tree.sha;
    const next = await gh(env, 'git/trees', { method: 'POST', body: { base_tree: tree, tree: entries } });
    const commit = await gh(env, 'git/commits', { method: 'POST', body: { message: `${subject}\n\n${lines.join('\n')}\n\nפורסם על ידי: ${me.shown}\nנערך על ידי: ${editors.join(', ')}`, tree: next.sha, parents: [head], author: { name: me.shown, email: 'editor@heichal.invalid', date: new Date().toISOString() } } });
    try { await gh(env, `git/refs/heads/${env.BRANCH}`, { method: 'PATCH', body: { sha: commit.sha, force: false } }); sha = commit.sha; break; }
    catch (e) { if (e.status !== 422 || attempt >= 2) throw e; }
  }
  // Git requests above can overlap a new save. Clear only the exact captured row,
  // including its attribution, so a newer edit/deletion stays pending. Keep its
  // existing base SHA for explicit conflict review rather than silently rebasing it.
  await getDataStore(env).cleanupPublishedDrafts(rows);
  for (const m of media) await getDataStore(env).finishPublishedMedia(m);
  for (const r of rows) await logEntry(env, me, 'publish', r.path, `${label(r)} · נערך על ידי ${r.name}`, sha);
  for (const m of media) await logEntry(env, me, 'publish', m.key, `${m.status === 'staged' ? 'קובץ חדש' : 'קובץ נמחק'} · ${m.name}`, sha);
  await logEntry(env, me, 'publish-all', null, cleanName(note) || `${total} שינויים`, sha);
  return { sha, published: [...rows.map((r) => r.path), ...media.map((m) => m.key)] };
}

async function discard(env, me, paths) {
  const dpaths = paths.filter(PATH_OK), mpaths = paths.filter(MEDIA_OK);
  const rows = await getDataStore(env).getDrafts(dpaths);
  const media = await getDataStore(env).listPendingMedia(mpaths);
  // An editor may drop only their own work; a publisher may drop anyone's.
  if ((rows.some((r) => r.email !== me.email) || media.some((m) => m.email !== me.email)) && !me.publisher) throw fail('אפשר לבטל רק שינויים שביצעתם בעצמכם', 403);
  if (rows.length) await getDataStore(env).discardDrafts(rows.map((r) => r.path));
  for (const m of media) {
    if (m.status === 'staged') await mediaDrop(env, m);
    else await getDataStore(env).restorePublishedMedia(m.id); // the removal is cancelled
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
  // Only the Node composition root can provide this function. HTTP headers,
  // request JSON and Worker string bindings cannot supply a local principal.
  const local = typeof env.LOCAL_PRINCIPAL === 'function' ? await env.LOCAL_PRINCIPAL(req) : null;
  if (local && (!/^local:[a-f0-9]{32}$/.test(local.email) || typeof local.owner !== 'boolean' || typeof local.publisher !== 'boolean')) throw new Error('Invalid local principal');
  const email = local ? local.email : await readSession((req.headers.get('Authorization') || '').replace(/^Bearer /, ''), env);
  if (!email) return json({ message: 'צריך להתחבר מחדש' }, 401, cors);
  const me = local || await who(env, email), p = url.pathname, q = url.searchParams;
  if (!me) return json({ message: 'צריך להתחבר מחדש' }, 401, cors);
  await schema(env);
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const admission = await writeLimit(env, email);
    if (!admission.allowed) return json({ message: 'יותר מדי פעולות ברצף. המתינו מעט ונסו שוב.' }, 429, { ...cors, 'Retry-After': String(admission.retryAfter) });
  }

  if (p === '/me') {
    if (req.method === 'PUT') {
      const name = cleanName((await bodyOf(req)).name);
      if (!name) return json({ message: 'כתבו שם' }, 400, cors);
      if (local) {
        if (typeof env.LOCAL_UPDATE_NAME !== 'function') throw new Error('Local name update unavailable');
        await env.LOCAL_UPDATE_NAME(name);
      } else if (me.owner) {
        const hash = await sha256(me.email);
        await updateKvJson(env, 'owner-names', {}, (names) => ({ ...names, [hash]: name }));
      } else await updatePeople(env, (list) => {
        if (!list.some((x) => x.email === me.email)) throw fail('צריך להתחבר מחדש', 401);
        return list.map((x) => (x.email === me.email ? { ...x, name } : x));
      });
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
        let action, summary;
        list = await updatePeople(env, (current) => {
          const old = current.find((x) => x.email === e), name = cleanName(b.name === undefined && old ? old.name : b.name);
          action = old ? 'editor-update' : 'editor-add';
          summary = `${name || 'ללא שם'}${b.publisher ? ' · מפרסם' : ''}`;
          return [...current.filter((x) => x.email !== e), { email: e, name, publisher: b.publisher === undefined && old ? !!old.publisher : !!b.publisher }].sort((a, b2) => a.email.localeCompare(b2.email));
        });
        await logEntry(env, me, action, null, summary);
      } else {
        list = await updatePeople(env, (current) => current.filter((x) => x.email !== e));
        await logEntry(env, me, 'editor-remove', null, e.replace(/^(.).*@/, '$1…@'));
      }
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
    const c = await getDataStore(env).getStagedChunk(mm[1], Number(q.get('n')) || 0);
    return c ? json({ data: c.data }, 200, cors) : json({ message: 'לא נמצא' }, 404, cors);
  }
  if (p === '/changes' && req.method === 'GET') return json({ changes: await changes(env, q.get('check') === '1') }, 200, cors);
  if (p === '/history' && req.method === 'GET') return json({ history: await history(env, q.get('path')) }, 200, cors);
  if (p === '/log' && req.method === 'GET') {
    if (!me.publisher) return json({ message: 'היומן פתוח למפרסמים ולבעלי האתר' }, 403, cors);
    const limit = Math.min(200, Math.max(1, Number(q.get('limit')) || 50)), before = Number(q.get('before')) || 0;
    const rows = await getDataStore(env).listLog({ before, limit });
    return json({ log: rows.map((r) => (me.owner ? r : { ...r, email: null })) }, 200, cors);
  }
  if (req.method === 'POST' && ['/publish', '/discard', '/restore'].includes(p)) {
    const b = await bodyOf(req), paths = Array.isArray(b.paths) ? [...new Set(b.paths.filter((x) => PUB_OK(x)))] : [];
    if (p === '/publish') {
      if (!me.publisher) return json({ message: 'אין לכם הרשאה לפרסם. בקשו מבעל האתר לסמן אתכם כמפרסמים.' }, 403, cors);
      return json(await publish(env, me, paths, Array.isArray(b.force) ? b.force : [], b.note), 200, cors);
    }
    if (p === '/discard') return json(await discard(env, me, b.all ? [...(await getDataStore(env).listDraftPaths()), ...(await getDataStore(env).listPendingMediaKeys())] : paths), 200, cors);
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
    let b, email;
    try { b = await readJsonBody(req, { maxBytes: 16384, allowEmpty: false }); }
    catch (error) {
      if (error instanceof RequestBodyError) return json({ message: error.message }, error.status, cors);
      throw error;
    }
    const admission = await loginLimit(req, env);
    if (!admission.allowed) return json({ message: 'יותר מדי ניסיונות התחברות. המתינו מעט ונסו שוב.' }, 429, { ...cors, 'Retry-After': String(admission.retryAfter) });
    try {
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
