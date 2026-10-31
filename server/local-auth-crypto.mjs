// Node-only password and session primitives. Passwords never enter diagnostics.
// Fixed OWASP scrypt profile (32 MiB, p=3); stored records cannot choose costs.
import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const COST = Object.freeze({ N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 });
const PREFIX = 'scrypt$v1$32768$8$3$';
const RECORD = /^scrypt\$v1\$32768\$8\$3\$([A-Za-z0-9_-]{32})\$([A-Za-z0-9_-]{43})$/;
const DUMMY_SALT = Buffer.alloc(24, 0x5a);
const DUMMY_HASH = Buffer.alloc(32);
const INVALID_INPUT = 'invalid-password-input';
const MAX_ACTIVE = 2;
const MAX_QUEUED = 4;

export class LocalAuthBusyError extends Error {
  constructor() { super('Authentication is temporarily unavailable'); this.name = 'LocalAuthBusyError'; }
}

export function passwordAcceptable(password) {
  if (typeof password !== 'string' || password.length < 15 || password.length > 256 || !password.isWellFormed()) return false;
  const length = [...password].length;
  return length >= 15 && length <= 128 && Buffer.byteLength(password, 'utf8') <= 512;
}

export function normalizeUsername(value) {
  if (typeof value !== 'string' || value.length > 64 || !/^[A-Za-z0-9][A-Za-z0-9_.-]{2,63}$/.test(value)) return null;
  return value.toLowerCase();
}

const nativeDerive = (password, salt, bytes, options) => new Promise((resolve, reject) => {
  scrypt(password, salt, bytes, options, (error, result) => error ? reject(error) : resolve(result));
});

function recordParts(encoded) {
  if (typeof encoded !== 'string' || encoded.length > 256) return null;
  const match = RECORD.exec(encoded);
  if (!match) return null;
  const salt = Buffer.from(match[1], 'base64url'), hash = Buffer.from(match[2], 'base64url');
  if (salt.length !== 24 || hash.length !== 32 || salt.toString('base64url') !== match[1] || hash.toString('base64url') !== match[2]) return null;
  return { salt, hash };
}

// Injection is for deterministic queue/error tests. Production callers use the
// shared singleton below; costs and concurrency bounds are not configurable.
export function createPasswordHasher({ derive = nativeDerive } = {}) {
  if (typeof derive !== 'function') throw new TypeError('A password derivation function is required');
  let active = 0;
  const queue = [];
  const acquire = () => {
    if (active < MAX_ACTIVE) { active++; return Promise.resolve(); }
    if (queue.length >= MAX_QUEUED) return Promise.reject(new LocalAuthBusyError());
    return new Promise((resolve) => queue.push(resolve));
  };
  const release = () => {
    const next = queue.shift();
    if (next) next(); // Transfer this slot without opening a race for newcomers.
    else active--;
  };
  const calculate = async (password, salt) => {
    await acquire();
    try {
      const result = await derive(password, salt, 32, { ...COST });
      if (!Buffer.isBuffer(result) || result.length !== 32) throw new Error('Invalid password derivation result');
      return result;
    } finally { release(); }
  };
  return {
    async hashPassword(password) {
      if (!passwordAcceptable(password)) throw new TypeError('Password must contain15 to128 characters');
      const salt = randomBytes(24);
      const hash = await calculate(password, salt);
      return `${PREFIX}${salt.toString('base64url')}$${hash.toString('base64url')}`;
    },
    async verifyPassword(password, encoded) {
      const validInput = passwordAcceptable(password), parts = recordParts(encoded);
      // Missing accounts and corrupt/unknown-version records still consume the
      // same fixed-cost KDF. No unauthenticated value can increase work factors.
      const computed = await calculate(validInput ? password : INVALID_INPUT, parts?.salt || DUMMY_SALT);
      const matches = timingSafeEqual(computed, parts?.hash || DUMMY_HASH);
      return validInput && parts !== null && matches;
    },
  };
}

const sharedHasher = createPasswordHasher();
export const hashPassword = sharedHasher.hashPassword;
export const verifyPassword = sharedHasher.verifyPassword;

export const randomToken = () => randomBytes(32).toString('base64url');

export function digestToken(value) {
  if (typeof value !== 'string' || value.length > 512) throw new TypeError('Invalid token');
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function csrfToken(sessionToken, sessionSecret) {
  if (typeof sessionToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(sessionToken) ||
      typeof sessionSecret !== 'string' || Buffer.byteLength(sessionSecret) < 32) throw new TypeError('Invalid CSRF configuration');
  return createHmac('sha256', sessionSecret).update('heichal-local-csrf-v1\0').update(sessionToken).digest('base64url');
}

export function safeEqualStrings(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length > 512 || b.length > 512) return false;
  // Hash bounded inputs first, so timingSafeEqual always receives equal lengths.
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}
