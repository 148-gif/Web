// Node-only staged Google configuration. Proof never signs in or links an
// identity. All state transitions share the local authentication transaction.
import { randomToken, digestToken } from './local-auth-crypto.mjs';
import { createGoogleProofVerifier, GoogleProofError, validGoogleClientId } from './google-auth-proof.mjs';

const LIFETIME = 5 * 60_000;
const fail = (message, status = 409) => Object.assign(new Error(message), { status });
export const clearGooglePending = (g) => ({ ...g, pending_client_id: null, pending_nonce_hash: null,
  pending_session_hash: null, pending_user_id: null, pending_user_version: 0, pending_owner_hash: null,
  pending_issued_at: 0, pending_expires_at: 0, verified_until: 0 });

export function googleSetupView(g, auth, config, now) {
  return { origin: config.publicOrigin, clientId: g.pending_client_id || g.active_client_id || '',
    activeClientId: g.active_client_id || '', activeVersion: g.active_version, revision: g.revision,
    pending: Boolean(g.pending_client_id), verified: Boolean(g.verified_until > now && auth.method === 'local' &&
      g.pending_session_hash === digestToken(auth.token) && g.pending_user_id === auth.user.id && g.pending_user_version === auth.user.version),
    pendingExpiresAt: g.pending_expires_at, verifiedUntil: g.verified_until,
    configurable: auth.method === 'local', activationAllowed: config.googleEnabled };
}

export function createGoogleSetup({ store, config, clock, validUser, reauthenticate, admission, verifyProof = createGoogleProofVerifier({ clock }) }) {
  async function currentOwner(tx, auth) {
    const settings = await tx.getSettings(), user = await tx.getUserById(auth.user.id);
    const session = await tx.getSession(digestToken(auth.token));
    if (!settings.local_enabled || !settings.local_verified || !validUser(user) || user.role !== 'owner' ||
        user.version !== auth.user.version || user.password_hash !== auth.user.password_hash ||
        !session || session.user_id !== user.id || session.version !== user.version || session.expires_at <= clock() ||
        session.csrf_hash !== auth.session.csrf_hash) throw fail('יש להתחבר מחדש עם הסיסמה המקומית', 401);
    return { settings, user };
  }
  function pendingFor(g, auth, revision, verified = false) {
    return Number.isSafeInteger(revision) && revision === g.revision && g.pending_client_id &&
      g.pending_session_hash === digestToken(auth.token) && g.pending_user_id === auth.user.id &&
      g.pending_user_version === auth.user.version && g.pending_owner_hash === auth.user.owner_hash &&
      g.pending_expires_at > clock() && (verified ? !g.pending_nonce_hash && g.verified_until > clock() : g.pending_nonce_hash && g.verified_until === 0);
  }
  async function handle(path, request, env, auth, body) {
    if (auth?.method !== 'local' || !auth.actor.owner) throw fail('הגדרת Google דורשת כניסה מקומית של בעל הרשאה', 403);
    if (path === '/auth/google/prepare') {
      if (!validGoogleClientId(body.clientId)) throw fail('הזינו Client ID תקין של יישום אינטרנט ב־Google', 400);
      await reauthenticate(request, env, auth, body);
      const nonce = randomToken(), now = clock();
      return store.atomic(async (tx) => {
        await currentOwner(tx, auth);
        const g = await tx.getGoogleConfig();
        const next = { ...g, revision: g.revision + 1, pending_client_id: body.clientId,
          pending_nonce_hash: digestToken(nonce), pending_session_hash: digestToken(auth.token),
          pending_user_id: auth.user.id, pending_user_version: auth.user.version, pending_owner_hash: auth.user.owner_hash,
          pending_issued_at: now, pending_expires_at: now + LIFETIME, verified_until: 0 };
        await tx.saveGoogleConfig(next);
        return { clientId: next.pending_client_id, nonce, revision: next.revision, expiresAt: next.pending_expires_at };
      });
    }
    if (path === '/auth/google/verify') {
      await admission(request, env, `google-proof:${auth.user.username}`);
      const before = await store.getGoogleConfig();
      if (!pendingFor(before, auth, body.revision)) throw fail('בדיקת החיבור פגה או הוחלפה. התחילו בדיקה חדשה');
      // Google network/key verification is outside the transaction. Its result
      // has no authority until the actual session and candidate are rechecked.
      let proof;
      try { proof = await verifyProof(body.credential, { clientId: before.pending_client_id, nonceHash: before.pending_nonce_hash,
        issuedAt: before.pending_issued_at, expiresAt: before.pending_expires_at }); }
      catch (error) { if (error instanceof GoogleProofError) throw fail('לא ניתן לאמת את חשבון Google עבור ההגדרה הזאת', 401); throw error; }
      if (!proof || proof.ownerHash !== auth.user.owner_hash) throw fail('נדרשת התחברות לחשבון Google של בעל ההרשאה הקיים', 403);
      return store.atomic(async (tx) => {
        await currentOwner(tx, auth);
        const g = await tx.getGoogleConfig();
        if (!pendingFor(g, auth, body.revision) || g.pending_nonce_hash !== before.pending_nonce_hash || g.active_version !== before.active_version) throw fail('הגדרות החיבור השתנו. התחילו בדיקה חדשה');
        const next = { ...g, revision: g.revision + 1, pending_nonce_hash: null, verified_until: g.pending_expires_at };
        await tx.saveGoogleConfig(next);
        return { verified: true, clientId: next.pending_client_id, revision: next.revision, verifiedUntil: next.verified_until };
      });
    }
    if (path === '/auth/google/activate') {
      if (!config.googleEnabled) throw fail('מפעיל האחסון השאיר את כניסת Google כבויה', 403);
      await reauthenticate(request, env, auth, body);
      return store.atomic(async (tx) => {
        const { settings } = await currentOwner(tx, auth), g = await tx.getGoogleConfig();
        if (!pendingFor(g, auth, body.revision, true)) throw fail('יש להשלים בדיקת כניסה עדכנית לפני הפעלת Google');
        const next = clearGooglePending({ ...g, revision: g.revision + 1, active_version: g.active_version + 1, active_client_id: g.pending_client_id });
        await tx.saveGoogleConfig(next);
        // Proof changes configuration only. It cannot disable local access or
        // substitute for a later ordinary Google-owner login.
        await tx.saveSettings({ ...settings, local_enabled: true, google_enabled: true, google_verified_until: 0 });
        return { activated: true, clientId: next.active_client_id, googleRevision: next.active_version };
      });
    }
    throw fail('לא נמצא', 404);
  }
  return { handle };
}
