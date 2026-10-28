// Editor login server (Cloudflare Worker) for /admin/: signs editors in with Google (the editor's own button gets an access
// token, checked here with Google; an ID token is still accepted) and saves their edits to GitHub.
// The GitHub key lives only here, as a secret; editors never see it. Only allowed emails may edit,
// only files under data/ can be changed, and only on BRANCH. Setup and deploy: cms-worker/README.md.
//
// Who may edit: the site owners (OWNERS) and the editors the owners add from the editor itself (/admin/ → ניהול עורכים),
// kept in the EDITORS KV store so their emails are not published in this (public) repository.
//
// Settings (wrangler.toml, deployed by .github/workflows/cms-worker.yml):
//   GOOGLE_CLIENT_ID  the OAuth client ID from Google Cloud
//   OWNERS            SHA-256 (hex) of each owner's lower-case email, comma separated: owners can add and remove editors
//   ALLOWED_ORIGIN    the site's origin, e.g. https://148-gif.github.io
//   REPO, BRANCH      e.g. 148-gif/Web and claude/greeting-2i183o
//   EDITORS           KV binding holding the editors list (key "editors": JSON array of emails)
//   GITHUB_TOKEN      secret: fine-grained token, this repo only, Contents read/write and Actions read
//   SESSION_SECRET    optional secret; by default sessions are signed with a key derived from GITHUB_TOKEN,
//                     so replacing either one signs everyone out

const SESSION_HOURS = 12;
const enc = new TextEncoder();
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
const norm = (e) => String(e || '').trim().toLowerCase();
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const sha256 = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');
const isOwner = async (env, email) => String(env.OWNERS || '').split(',').map((h) => h.trim()).filter(Boolean).includes(await sha256(norm(email)));
const editors = async (env) => { try { return JSON.parse((await env.EDITORS.get('editors')) || '[]'); } catch { return []; } };
const allowed = async (env, email) => (await isOwner(env, email)) || (await editors(env)).includes(norm(email));

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
  const head = JSON.parse(new TextDecoder().decode(unb64url(h)));
  if (head.alg !== 'RS256') throw new Error('bad alg');
  let jwk = (await googleKeys()).find((k) => k.kid === head.kid);
  if (!jwk) jwk = (await googleKeys(true)).find((k) => k.kid === head.kid);
  if (!jwk) throw new Error('unknown key');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  if (!(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, unb64url(s), enc.encode(`${h}.${p}`)))) throw new Error('bad signature');
  const c = JSON.parse(new TextDecoder().decode(unb64url(p)));
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
  const s = JSON.parse(new TextDecoder().decode(unb64url(body)));
  // Re-checked on every request, so removing an editor takes effect at once.
  return s.exp > now && (await allowed(env, s.email)) ? s.email : null;
}

// ---- what an editor may ask GitHub for ----
// Returns the GitHub API path, or null when the request is not allowed.
function route(method, path) {
  if (method === 'GET' && path === '') return '';
  if (method === 'GET' && path === 'actions/runs') return path;
  const m = /^contents\/(data(?:\/[\w.-]+)*)$/.exec(path);
  if (!m || m[1].split('/').some((x) => x === '..' || x === '.')) return null;
  if (method === 'GET') return path;
  // Writes: one JSON file under data/, never the Q&A archive.
  if ((method === 'PUT' || method === 'DELETE') && /\.json$/.test(m[1]) && m[1] !== 'data/shut.json') return path;
  return null;
}

const json = (o, status, cors) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors } });

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
    if (!(await allowed(env, email))) return json({ message: `לחשבון ${email} אין הרשאת עריכה. בקשו מבעל האתר להוסיף אתכם.` }, 403, cors);
    return json({ token: await makeSession(email, env), email, owner: await isOwner(env, email) }, 200, cors);
  }

  const email = await readSession((req.headers.get('Authorization') || '').replace(/^Bearer /, ''), env);
  if (!email) return json({ message: 'צריך להתחבר מחדש' }, 401, cors);

  // Editors list: owners only. GET lists, PUT {email} adds, DELETE {email} removes.
  if (url.pathname === '/editors') {
    if (!(await isOwner(env, email))) return json({ message: 'רק בעל האתר יכול לנהל עורכים' }, 403, cors);
    let list = await editors(env);
    if (req.method === 'PUT' || req.method === 'DELETE') {
      const e = norm((await req.json()).email);
      if (!EMAIL.test(e)) return json({ message: 'כתובת מייל לא תקינה' }, 400, cors);
      list = req.method === 'PUT' ? [...new Set([...list, e])].sort() : list.filter((x) => x !== e);
      await env.EDITORS.put('editors', JSON.stringify(list));
    } else if (req.method !== 'GET') return json({ message: 'not allowed' }, 405, cors);
    return json({ editors: list }, 200, cors);
  }

  if (!url.pathname.startsWith('/gh')) return json({ message: 'not found' }, 404, cors);
  const path = route(req.method, url.pathname.replace(/^\/gh\/?/, ''));
  if (path === null) return json({ message: 'פעולה לא מורשית' }, 403, cors);

  let q = new URLSearchParams(url.search);
  if (path.startsWith('contents/')) q.set('ref', env.BRANCH);
  if (path === 'actions/runs') { const sha = q.get('head_sha') || ''; if (!/^[0-9a-f]{40}$/.test(sha)) return json({ message: 'bad sha' }, 400, cors); q = new URLSearchParams({ head_sha: sha }); }
  let body;
  if (req.method === 'PUT' || req.method === 'DELETE') {
    const b = await req.json();
    // Always the publishing branch, and the commit records who made the edit.
    body = JSON.stringify({ ...b, branch: env.BRANCH, message: `${String(b.message || 'עריכת תוכן').slice(0, 200)}\n\nנערך על ידי: ${email}` });
    q.delete('ref');
  }
  const qs = q.toString();
  const r = await fetch(`https://api.github.com/repos/${env.REPO}${path ? '/' + path : ''}${qs ? '?' + qs : ''}`, {
    method: req.method, body,
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'heichal-cms' },
  });
  return new Response(r.body, { status: r.status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors } });
}

export default {
  fetch: (req, env) => handle(req, env).catch(() => {
    const origin = req.headers.get('Origin');
    return json({ message: 'שגיאה בשרת העריכה' }, 500, origin === env.ALLOWED_ORIGIN ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {});
  }),
};
export { route, verifyGoogle, verifyAccessToken, makeSession, readSession, allowed, isOwner, sha256, handle };
