// Node-only, explicit owner invitations. Codes carry no role or email claim.
// The original bootstrap and every existing account remain untouched.
import { randomBytes } from 'node:crypto';
import { hashPassword, verifyPassword, passwordAcceptable, normalizeUsername, randomToken, digestToken, csrfToken, safeEqualStrings } from './local-auth-crypto.mjs';

const TTL = 15 * 60_000;
const CODE = /^[A-Za-z0-9_-]{43}$/;
const FAILURE = 'ההזמנה אינה תקפה או שלא ניתן להשלים את יצירת החשבון';
const fail = (message = FAILURE, status = 403) => Object.assign(new Error(message), { status });
const nameOf = (value) => typeof value === 'string' ? value.trim() : '';
const inputErrors = new WeakMap();

// Shared setup/invitation syntax checks disclose only the caller's own fields.
// A private map prevents arbitrary driver errors from adding response fields.
export function validateLocalCredentialInput(body) {
  const username = normalizeUsername(body.username), displayName = nameOf(body.displayName), errors = {};
  if (!username) errors.username = 'שם המשתמש צריך להכיל 3–64 תווים באנגלית: אותיות, ספרות, נקודה, קו תחתון או מקף. אין להשתמש בכתובת דוא״ל.';
  if (!displayName || !displayName.isWellFormed() || [...displayName].length > 40 || /[\p{Cc}<>]/u.test(displayName)) errors.displayName = 'שם התצוגה צריך להכיל 1–40 תווים, ללא סימני < > או תווי בקרה.';
  if (!passwordAcceptable(body.password)) errors.password = 'הסיסמה צריכה להכיל 15–128 תווים, עד 512 בתים.';
  if (Object.keys(errors).length) {
    const error = fail('בדקו את השדות המסומנים ונסו שוב.', 400);
    inputErrors.set(error, Object.freeze(errors)); throw error;
  }
  return { username, displayName };
}
export const localCredentialErrorFields = (error) => inputErrors.get(error);

export function createLocalInvitations({ store, config, clock = Date.now, admission, passwords = { hashPassword, verifyPassword } }) {
  const allowed = (hash) => String(config.env.OWNERS || '').split(',').map((s) => s.trim()).includes(hash);
  const owner = (user) => user && !user.disabled && user.role === 'owner' && allowed(user.owner_hash);
  const ready = (settings) => settings.local_enabled && settings.local_verified && settings.bootstrap_consumed;
  const origin = (request) => {
    if (request.headers.get('origin') !== config.publicOrigin || config.env.ALLOWED_ORIGIN !== config.publicOrigin) throw fail();
  };
  const validInvitation = (row) => row && !row.consumed && row.expires_at > clock() && allowed(row.owner_hash);
  const issuerMatches = (user, invitation) => owner(user) && user.version === invitation.issuer_version;
  async function creationAuthority(tx, request, authenticated) {
    const settings = await tx.getSettings(), user = await tx.getUserById(authenticated.user.id);
    const tokenHash = digestToken(authenticated.token), session = await tx.getSession(tokenHash);
    const supplied = request.headers.get('x-csrf-token') || '';
    if (!ready(settings) || !owner(user) || user.version !== authenticated.user.version || user.password_hash !== authenticated.user.password_hash ||
        !session || session.token_hash !== tokenHash || session.user_id !== user.id || session.version !== user.version || session.expires_at <= clock() ||
        session.csrf_hash !== authenticated.session.csrf_hash || supplied.length > 128 ||
        !safeEqualStrings(session.csrf_hash, digestToken(supplied)) ||
        !safeEqualStrings(session.csrf_hash, digestToken(csrfToken(authenticated.token, config.env.SESSION_SECRET)))) {
      throw fail('יש להתחבר מחדש עם הסיסמה המקומית', 401);
    }
    return user;
  }
  return {
    async create(request, env, authenticated, body) {
      origin(request);
      if (authenticated?.method !== 'local' || !owner(authenticated.user)) throw fail('רק בעל הרשאה מקומית יכול ליצור הזמנה', 403);
      await admission(request, env, authenticated.user.username);
      if (!(await passwords.verifyPassword(body.currentPassword, authenticated.user.password_hash))) throw fail('שם המשתמש או הסיסמה אינם תקינים', 401);
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      if (!email || email.length > 254 || !email.isWellFormed() || /[\p{Cc}<>]/u.test(email) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail('לא ניתן ליצור הזמנה לחשבון הזה');
      const ownerHash = digestToken(email), code = randomToken();
      const expiresAt = await store.atomic(async (tx) => {
        const user = await creationAuthority(tx, request, authenticated);
        if (!allowed(ownerHash) || await tx.getUserByOwnerHash(ownerHash)) throw fail('לא ניתן ליצור הזמנה לחשבון הזה');
        const expires = clock() + TTL;
        await tx.saveInvitation({ owner_hash: ownerHash, token_hash: digestToken(code), issuer_id: user.id, issuer_version: user.version, expires_at: expires, consumed: false });
        return expires;
      });
      return { code, expiresAt, setupUrl: `${config.publicOrigin}${config.apiBasePath}/auth/invitation` };
    },
    async accept(request, env, body) {
      origin(request);
      const account = normalizeUsername(body.username);
      // Both per-source and per-account admission share the bounded login row.
      // Random attacker input cannot create an unlimited set of database rows.
      await admission(request, env, `invitation:${account || 'invalid'}`);
      const { username, displayName } = validateLocalCredentialInput(body);
      if (typeof body.code !== 'string' || !CODE.test(body.code)) throw fail();
      const tokenHash = digestToken(body.code), invitation = await store.getInvitationByHash(tokenHash);
      if (!ready(await store.getSettings()) || !validInvitation(invitation) || invitation.token_hash !== tokenHash ||
          !issuerMatches(await store.getUserById(invitation.issuer_id), invitation) ||
          await store.getUserByOwnerHash(invitation.owner_hash) || await store.getUserByUsername(username)) throw fail();
      const passwordHash = await passwords.hashPassword(body.password);
      await store.atomic(async (tx) => {
        const fresh = await tx.getInvitationByHash(tokenHash);
        if (!ready(await tx.getSettings()) || !validInvitation(fresh) || fresh.token_hash !== tokenHash ||
            fresh.owner_hash !== invitation.owner_hash || fresh.issuer_id !== invitation.issuer_id || fresh.issuer_version !== invitation.issuer_version || fresh.expires_at !== invitation.expires_at ||
            !issuerMatches(await tx.getUserById(fresh.issuer_id), fresh) ||
            await tx.getUserByOwnerHash(fresh.owner_hash) || await tx.getUserByUsername(username)) throw fail();
        await tx.insertUser({ id: randomBytes(16).toString('hex'), username, display_name: displayName, password_hash: passwordHash,
          owner_hash: fresh.owner_hash, role: 'owner', version: 1, disabled: false });
        await tx.saveInvitation({ ...fresh, consumed: true });
      });
      return { created: true };
    },
  };
}
