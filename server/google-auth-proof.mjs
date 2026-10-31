// Node-only Google identity proofs and isolated managed-Google session keys.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const CLIENT_ID = /^[0-9]{6,32}-[A-Za-z0-9_-]{10,160}\.apps\.googleusercontent\.com$/;
const HASH = /^[a-f0-9]{64}$/;
const NONCE = /^[A-Za-z0-9_-]{43}$/;
const JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const CLOCK_SKEW_SECONDS = 60;
const SESSION_PURPOSE = 'heichal-managed-google-session-v1\0';

export class GoogleProofError extends Error {
  constructor() { super('Google identity could not be verified'); this.name = 'GoogleProofError'; }
}

export const validGoogleClientId = (value) => typeof value === 'string' && value.length <= 255 && CLIENT_ID.test(value);
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
const fail = () => { throw new GoogleProofError(); };

function validChallenge(value, now) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    validGoogleClientId(value.clientId) && typeof value.nonceHash === 'string' && HASH.test(value.nonceHash) &&
    positiveInteger(value.issuedAt) && positiveInteger(value.expiresAt) &&
    value.issuedAt <= now && value.expiresAt > value.issuedAt && value.expiresAt > now;
}

// The resolver is injectable for offline signed-fixture tests. Production keys
// always come from this fixed URL; JWT header URLs never select a key source.
export function createGoogleProofVerifier({ keySet, clock = Date.now } = {}) {
  if (typeof clock !== 'function' || (keySet !== undefined && typeof keySet !== 'function')) throw new TypeError('Invalid Google proof verifier configuration');
  const keys = keySet || createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'), {
    timeoutDuration: 5000, cooldownDuration: 30000, cacheMaxAge: 3600000,
  });
  return async function verify(credential, challenge) {
    try {
      const startedAt = clock();
      if (!positiveInteger(startedAt) || !Number.isFinite(new Date(startedAt).getTime()) || !validChallenge(challenge, startedAt) ||
          typeof credential !== 'string' || credential.length > 8192 || !JWT.test(credential)) fail();
      const { payload } = await jwtVerify(credential, keys, {
        algorithms: ['RS256'], issuer: ['accounts.google.com', 'https://accounts.google.com'],
        audience: challenge.clientId, clockTolerance: CLOCK_SKEW_SECONDS, currentDate: new Date(startedAt),
        requiredClaims: ['iss', 'aud', 'sub', 'iat', 'exp', 'nonce', 'email', 'email_verified'],
      });
      // Recheck after possible key retrieval so an expired challenge or proof
      // cannot become usable merely because verification began before expiry.
      const now = clock();
      if (!positiveInteger(now) || !validChallenge(challenge, now) ||
          payload.aud !== challenge.clientId || (payload.azp !== undefined && payload.azp !== challenge.clientId) ||
          !positiveInteger(payload.exp) || !positiveInteger(payload.iat) || payload.exp <= now / 1000 || payload.exp <= payload.iat ||
          payload.iat < challenge.issuedAt / 1000 - CLOCK_SKEW_SECONDS || payload.iat > now / 1000 + CLOCK_SKEW_SECONDS ||
          payload.email_verified !== true || typeof payload.sub !== 'string' || !payload.sub.trim() || payload.sub.length > 255 ||
          typeof payload.nonce !== 'string' || !NONCE.test(payload.nonce) ||
          Buffer.from(payload.nonce, 'base64url').toString('base64url') !== payload.nonce) fail();
      const nonceHash = createHash('sha256').update(payload.nonce, 'utf8').digest();
      if (!timingSafeEqual(nonceHash, Buffer.from(challenge.nonceHash, 'hex'))) fail();
      if (typeof payload.email !== 'string' || payload.email.length > 254) fail();
      const email = payload.email.toLowerCase();
      if (!EMAIL.test(email) || email.slice(0, email.indexOf('@')).length > 64 || email.startsWith('.') || email.includes('..') || email.includes('.@')) fail();
      return { email, ownerHash: createHash('sha256').update(email, 'utf8').digest('hex'), subject: payload.sub };
    } catch {
      // Do not expose the credential, claims, resolver errors or upstream body.
      throw new GoogleProofError();
    }
  };
}

function validOrigin(value) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const parsed = new URL(value);
    return parsed.origin === value && (parsed.protocol === 'https:' ||
      (parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)));
  } catch { return false; }
}

export function googleSessionEnvironment(env, { clientId, activeVersion, origin } = {}) {
  if (!env || typeof env !== 'object' || Array.isArray(env) || typeof env.SESSION_SECRET !== 'string' ||
      Buffer.byteLength(env.SESSION_SECRET, 'utf8') < 32 || !env.SESSION_SECRET.trim() ||
      !validGoogleClientId(clientId) || !positiveInteger(activeVersion) || !validOrigin(origin)) {
    throw new TypeError('Invalid managed Google session configuration');
  }
  const derived = createHmac('sha256', env.SESSION_SECRET).update(SESSION_PURPOSE)
    .update(JSON.stringify([origin, clientId, activeVersion]), 'utf8').digest('hex');
  // Preserve request-local, non-enumerable CLIENT_IP and all shared bindings.
  return Object.assign(Object.create(env), { GOOGLE_CLIENT_ID: clientId, SESSION_SECRET: derived });
}
