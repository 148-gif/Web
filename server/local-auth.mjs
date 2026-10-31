// Node-only authentication. No password, role or Google identity comes from a
// browser claim. This module is never imported by the Cloudflare entry point.
import { randomBytes } from 'node:crypto';
import { readJsonBody, RequestBodyError } from '../cms-worker/request-guards.mjs';
import { loginLimit } from '../cms-worker/rate-limit.mjs';
import { readSession, who } from '../cms-worker/worker.mjs';
import { hashPassword, verifyPassword, passwordAcceptable, normalizeUsername, randomToken, digestToken, csrfToken, safeEqualStrings, LocalAuthBusyError } from './local-auth-crypto.mjs';
import { renderAuthSetup } from './auth-setup.mjs';

const COOKIE = '__Host-heichal_local';
const SESSION_MS = 8 * 3600_000;
const RECENT_MS = 15 * 60_000;
const AUTH_FAILURE = 'שם המשתמש או הסיסמה אינם תקינים';
const MUTATION = (method) => !['GET', 'HEAD', 'OPTIONS'].includes(method);
const own = (o) => o && typeof o === 'object' && !Array.isArray(o);
const cookieValue = (request) => {
  const matches = (request.headers.get('cookie') || '').split(';').map((s) => s.trim()).filter((s) => s.startsWith(COOKIE + '='));
  return matches.length === 1 && /^[A-Za-z0-9_-]{43}$/.test(matches[0].slice(COOKIE.length + 1)) ? matches[0].slice(COOKIE.length + 1) : null;
};
const setCookie = (token, clear = false) => `${COOKIE}=${clear ? '' : token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : SESSION_MS / 1000}`;
const fail = (message, status) => Object.assign(new Error(message), { status });
const actorOf = (user) => ({ email: `local:${user.id}`, name: user.display_name, shown: user.display_name, owner: user.role === 'owner', publisher: ['owner', 'publisher'].includes(user.role) });

export function createLocalAuth({ store, config, clock = Date.now }) {
  const owners = new Set(config.env.OWNERS.split(',').map((s) => s.trim()));
  const validUser = (user) => user && !user.disabled && owners.has(user.owner_hash) && ['owner', 'editor', 'publisher'].includes(user.role);
  const headers = (request) => ({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...(config.staging ? { 'X-Robots-Tag': 'noindex, nofollow' } : {}), ...(request.headers.get('origin') === config.env.ALLOWED_ORIGIN ? { 'Access-Control-Allow-Origin': config.env.ALLOWED_ORIGIN, Vary: 'Origin' } : {}) });
  const json = (request, body, status = 200, cookie) => Response.json(body, { status, headers: { ...headers(request), ...(cookie ? { 'Set-Cookie': cookie } : {}) } });
  const bodyOf = async (request) => {
    const b = await readJsonBody(request, { maxBytes: 4096, allowEmpty: false });
    if (!own(b)) throw fail('גוף הבקשה אינו תקין', 400);
    return b;
  };
  const enabled = (settings) => ({ localEnabled: settings.local_enabled, googleEnabled: config.googleEnabled && settings.google_enabled });
  const recentGoogle = (token) => {
    try { const p = JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString('utf8')); return Number.isSafeInteger(p.exp) && p.exp * 1000 - 12 * 3600_000 <= clock() && p.exp * 1000 - 12 * 3600_000 > clock() - RECENT_MS; }
    catch { return false; }
  };
  async function admission(request, env, account) {
    const first = await loginLimit(request, env, clock());
    const now = clock(), windowStart = Math.floor(now / 60000) * 60000;
    // The existing login row holds a bounded subject map. Unknown usernames
    // never create unbounded account rows. Domains separate IP/account keys.
    const second = first.allowed && await env.RATE_LIMIT_STORE({ scope: 'login', windowStart, limit: 120, subject: digestToken(`local-account:${account}`), subjectLimit: 5 });
    if (!second) throw fail('יותר מדי ניסיונות. המתינו מעט ונסו שוב.', 429);
  }
  async function current(request, env, settings) {
    const token = cookieValue(request), bearer = (request.headers.get('authorization') || '').replace(/^Bearer /, '');
    if (token && bearer) return null;
    if (token && settings.local_enabled) {
      const session = await store.getSession(digestToken(token));
      if (!session || session.expires_at <= clock()) return null;
      if (!safeEqualStrings(digestToken(csrfToken(token, config.env.SESSION_SECRET)), session.csrf_hash)) return null;
      const user = await store.getUserById(session.user_id);
      if (!validUser(user) || user.version !== session.version) return null;
      return { method: 'local', actor: actorOf(user), user, session, token };
    }
    if (bearer && enabled(settings).googleEnabled) {
      const email = await readSession(bearer, env);
      const actor = email ? await who(env, email) : null;
      if (actor) return { method: 'google', actor, bearer };
    }
    return null;
  }
  function requireCsrf(request, session) {
    if (session?.method !== 'local') return;
    const supplied = request.headers.get('x-csrf-token') || '';
    if (supplied.length > 128 || !safeEqualStrings(digestToken(supplied), session.session.csrf_hash)) throw fail('הבקשה לא אושרה. רעננו את הדף.', 403);
  }
  const sessionBody = (user, token) => ({ user: actorOf(user), method: 'local', csrfToken: csrfToken(token, config.env.SESSION_SECRET) });
  async function issue(tx, user, previousToken) {
    const token = randomToken();
    if (previousToken) await tx.deleteSession(digestToken(previousToken));
    await tx.pruneSessions(user.id, clock());
    await tx.insertSession({ token_hash: digestToken(token), csrf_hash: digestToken(csrfToken(token, config.env.SESSION_SECRET)), user_id: user.id, version: user.version, expires_at: clock() + SESSION_MS });
    return token;
  }
  async function reauthenticate(request, env, authenticated, body) {
    if (!authenticated?.actor.owner) throw fail('רק בעל הרשאה יכול לנהל את הגדרות ההתחברות', 403);
    if (authenticated.method === 'google') {
      if (!recentGoogle(authenticated.bearer)) throw fail('יש להתחבר שוב באמצעות Google לפני שינוי הגדרות ההתחברות', 409);
    } else {
      await admission(request, env, authenticated.user.username);
      if (!(await verifyPassword(body.currentPassword, authenticated.user.password_hash))) throw fail(AUTH_FAILURE, 401);
    }
  }
  const viewSettings = (s, auth) => ({ ...enabled(s), googleAvailable: config.googleEnabled, method: auth.method, ...(auth.user ? { username: auth.user.username } : {}), canDisableGoogle: s.local_enabled && s.local_verified && auth.method === 'local', canDisableLocal: config.googleEnabled && s.google_enabled && s.google_verified_until > clock() && auth.method === 'google' && recentGoogle(auth.bearer) });

  async function handle(request, env, next) {
    const path = new URL(request.url).pathname, method = request.method;
    try {
      // Published media remains public for direct PDF/image navigations. This
      // delegates only the pre-existing read route, never an auth/write route.
      if (['GET', 'HEAD'].includes(method) && path.startsWith('/m/')) return next(request, env);
      if (method === 'OPTIONS' && !path.startsWith('/auth/')) return next(request, env);
      // Setup navigation is the only HTML route; no key in URL or third-party
      // resources. Serving its form alone never grants bootstrap authority.
      const settings = await store.getSettings();
      if (path === '/auth/setup' && method === 'GET') {
        if (settings.bootstrap_consumed || !settings.bootstrap_hash || settings.bootstrap_expires <= clock()) return json(request, { message: 'לא נמצא' }, 404);
        const nonce = randomBytes(18).toString('base64url');
        return new Response(renderAuthSetup({ apiBasePath: config.apiBasePath, nonce }), { headers: { ...headers(request), 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex, nofollow', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'` } });
      }
      if (request.headers.get('origin') !== config.env.ALLOWED_ORIGIN || config.publicOrigin !== config.env.ALLOWED_ORIGIN) return json(request, { message: 'origin not allowed' }, 403);
      if (path.startsWith('/auth/') && method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...headers(request), 'Access-Control-Allow-Methods': 'GET, POST, PUT', 'Access-Control-Allow-Headers': 'Content-Type, X-CSRF-Token, Authorization' } });
      if (path === '/auth/options' && method === 'GET') return json(request, { ...enabled(settings), settingsAvailable: true, readOnly: config.readOnly, publishEnabled: config.publishEnabled });
      if (path === '/auth/bootstrap' && method === 'POST') {
        const body = await bodyOf(request);
        await admission(request, env, 'bootstrap');
        const permitted = (s) => !s.bootstrap_consumed && s.bootstrap_hash && s.bootstrap_expires > clock() && owners.has(s.bootstrap_owner_hash) && typeof body.code === 'string' && body.code.length === 43 && safeEqualStrings(digestToken(body.code), s.bootstrap_hash);
        if (!permitted(settings)) throw fail('ההגדרה הראשונית אינה זמינה או שקוד ההפעלה אינו תקין', 403);
        const username = normalizeUsername(body.username), name = typeof body.displayName === 'string' ? body.displayName.trim() : '';
        if (!username || !passwordAcceptable(body.password) || !name || [...name].length > 40 || /[\p{Cc}<>]/u.test(name)) throw fail('בדקו את שם המשתמש, השם המוצג והסיסמה. הסיסמה צריכה להכיל 15–128 תווים.', 400);
        const passwordHash = await hashPassword(body.password);
        await store.atomic(async (tx) => {
          const s = await tx.getSettings();
          if (!permitted(s) || await tx.countUsers()) throw fail('ההגדרה הראשונית אינה זמינה או שקוד ההפעלה אינו תקין', 403);
          await tx.insertUser({ id: randomBytes(16).toString('hex'), username, display_name: name, password_hash: passwordHash, owner_hash: s.bootstrap_owner_hash, role: 'owner', version: 1, disabled: false });
          await tx.saveSettings({ ...s, local_enabled: true, local_verified: false, bootstrap_consumed: true, bootstrap_hash: null, bootstrap_expires: 0, bootstrap_owner_hash: null });
        });
        return json(request, { created: true }, 201);
      }
      if (path === '/auth/login' && method === 'POST') {
        const body = await bodyOf(request), username = normalizeUsername(body.username);
        await admission(request, env, username || 'invalid');
        const user = username ? await store.getUserByUsername(username) : null;
        const ok = await verifyPassword(body.password, user?.password_hash);
        if (!ok || !settings.local_enabled || !validUser(user)) throw fail(AUTH_FAILURE, 401);
        const token = await store.atomic(async (tx) => {
          const s = await tx.getSettings(), fresh = await tx.getUserById(user.id);
          if (!s.local_enabled || !validUser(fresh) || fresh.version !== user.version || fresh.password_hash !== user.password_hash) throw fail(AUTH_FAILURE, 401);
          await tx.saveSettings({ ...s, local_verified: true });
          return issue(tx, fresh, cookieValue(request));
        });
        return json(request, sessionBody(user, token), 200, setCookie(token));
      }
      const authenticated = await current(request, env, settings);
      if (path === '/auth/session' && method === 'GET') return authenticated?.method === 'local' ? json(request, sessionBody(authenticated.user, authenticated.token)) : json(request, { message: 'צריך להתחבר מחדש' }, 401);
      if (MUTATION(method)) requireCsrf(request, authenticated);
      if (path === '/auth/logout' && method === 'POST') {
        if (authenticated?.method === 'local') await store.atomic((tx) => tx.deleteSession(digestToken(authenticated.token)));
        return json(request, { loggedOut: true }, 200, setCookie('', true));
      }
      if (path === '/auth/settings' && ['GET', 'PUT'].includes(method)) {
        if (!authenticated?.actor.owner) return json(request, { message: 'רק בעל הרשאה יכול לנהל את הגדרות ההתחברות' }, 403);
        if (method === 'GET') return json(request, viewSettings(settings, authenticated));
        const body = await bodyOf(request);
        if (typeof body.localEnabled !== 'boolean' || typeof body.googleEnabled !== 'boolean') throw fail('הגדרות התחברות אינן תקינות', 400);
        await reauthenticate(request, env, authenticated, body);
        const result = await store.atomic(async (tx) => {
          const s = await tx.getSettings();
          if (authenticated.method === 'local') {
            const user = await tx.getUserById(authenticated.user.id);
            if (!validUser(user) || user.version !== authenticated.user.version || user.password_hash !== authenticated.user.password_hash || !s.local_enabled) throw fail('יש להתחבר מחדש', 401);
          } else if (!s.google_enabled || !config.googleEnabled) throw fail('יש להתחבר מחדש', 401);
          if ((!body.localEnabled && !body.googleEnabled) || (body.googleEnabled && !config.googleEnabled) || (body.localEnabled && (!s.bootstrap_consumed || !await tx.countUsers()))) throw fail('צריך להשאיר דרך התחברות זמינה', 409);
          if (s.google_enabled && !body.googleEnabled && !(body.localEnabled && s.local_verified && authenticated.method === 'local')) throw fail('יש לאמת כניסה מקומית לפני ביטול Google', 409);
          if (s.local_enabled && !body.localEnabled && !(body.googleEnabled && s.google_verified_until > clock() && authenticated.method === 'google' && recentGoogle(authenticated.bearer))) throw fail('יש לאמת כניסת בעל הרשאה דרך Google לפני ביטול הכניסה המקומית', 409);
          const updated = { ...s, local_enabled: body.localEnabled, google_enabled: body.googleEnabled };
          await tx.saveSettings(updated);
          if (!updated.local_enabled) await tx.deleteAllSessions();
          const token = authenticated.method === 'local' && updated.local_enabled ? await issue(tx, authenticated.user, authenticated.token) : null;
          return { updated, token };
        });
        return json(request, { ...viewSettings(result.updated, authenticated), ...(result.token ? sessionBody(authenticated.user, result.token) : {}) }, 200, result.token ? setCookie(result.token) : undefined);
      }
      if (path === '/auth/password' && method === 'POST') {
        if (authenticated?.method !== 'local' || !authenticated.actor.owner) throw fail('נדרשת כניסה מקומית של בעל הרשאה', 403);
        const body = await bodyOf(request);
        await reauthenticate(request, env, authenticated, body);
        if (!passwordAcceptable(body.newPassword)) throw fail('הסיסמה צריכה להכיל 15–128 תווים', 400);
        const passwordHash = await hashPassword(body.newPassword);
        let changed;
        const token = await store.atomic(async (tx) => {
          const s = await tx.getSettings(), user = await tx.getUserById(authenticated.user.id);
          if (!s.local_enabled || !validUser(user) || user.version !== authenticated.user.version || user.password_hash !== authenticated.user.password_hash) throw fail('יש להתחבר מחדש', 401);
          changed = { ...user, password_hash: passwordHash, version: user.version + 1 };
          await tx.saveUser(changed); await tx.deleteUserSessions(user.id);
          return issue(tx, changed);
        });
        return json(request, sessionBody(changed, token), 200, setCookie(token));
      }
      if (path.startsWith('/auth/')) return json(request, { message: 'לא נמצא' }, 404);
      if (path === '/session' && method === 'POST') {
        if (!enabled(settings).googleEnabled) return json(request, { message: 'שיטת ההתחברות אינה זמינה' }, 403);
        const response = await next(request, env);
        if (response.status !== 200) return response;
        const data = await response.clone().json();
        await store.atomic(async (tx) => {
          const s = await tx.getSettings();
          if (!s.google_enabled) throw fail('שיטת ההתחברות אינה זמינה', 403);
          if (data.owner === true) await tx.saveSettings({ ...s, google_verified_until: clock() + RECENT_MS });
          const old = cookieValue(request); if (old) await tx.deleteSession(digestToken(old));
        });
        const h = new Headers(response.headers); h.set('Set-Cookie', setCookie('', true));
        return new Response(response.body, { status: response.status, headers: h });
      }
      if (!authenticated && (cookieValue(request) || request.headers.has('authorization'))) return json(request, { message: 'צריך להתחבר מחדש' }, 401);
      if (authenticated?.method === 'local') {
        // The HTTP bridge intentionally inherits server bindings and defines
        // CLIENT_IP non-enumerably. Preserve that chain instead of spreading it.
        const localEnv = Object.assign(Object.create(env), { LOCAL_PRINCIPAL: async () => authenticated.actor, LOCAL_UPDATE_NAME: async (name) => store.atomic(async (tx) => {
          const s = await tx.getSettings(), user = await tx.getUserById(authenticated.user.id);
          if (!s.local_enabled || !validUser(user) || user.version !== authenticated.user.version) throw fail('יש להתחבר מחדש', 401);
          await tx.saveUser({ ...user, display_name: name });
        }) });
        return next(request, localEnv);
      }
      return next(request, env);
    } catch (error) {
      if (error instanceof RequestBodyError) return json(request, { message: error.message }, error.status);
      if (error instanceof LocalAuthBusyError) return json(request, { message: 'יותר מדי ניסיונות. המתינו מעט ונסו שוב.' }, 429);
      if (Number.isInteger(error.status) && error.status >= 400 && error.status < 500) return json(request, { message: error.message }, error.status);
      return json(request, { message: 'שגיאה בשרת ההתחברות' }, 500);
    }
  }
  return { handle };
}
