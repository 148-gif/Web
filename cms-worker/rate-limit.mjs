// Fixed-window admission. Login clients share one bounded map, so denied
// requests neither consume the global allowance nor create one row per IP.
const WINDOW_MS = 60000;
const ready = new WeakMap();
const enc = new TextEncoder();
const hash = async (text) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');

function setting(env, name, fallback, maximum) {
  const value = env[name];
  if (value === undefined) return fallback;
  const number = typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < 1 || number > maximum) throw new Error(`Invalid ${name} configuration`);
  return number;
}

function windowAt(now) {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid rate-limit time');
  const windowStart = Math.floor(now / WINDOW_MS) * WINDOW_MS;
  return { windowStart, retryAfter: Math.max(1, Math.ceil((windowStart + WINDOW_MS - now) / 1000)) };
}

async function clientAddress(request, env) {
  let value;
  if (env.CLIENT_IP !== undefined) {
    if (typeof env.CLIENT_IP !== 'function') throw new Error('Invalid CLIENT_IP configuration');
    value = await env.CLIENT_IP(request);
  } else if (request.cf && typeof request.cf === 'object') {
    value = request.headers.get('CF-Connecting-IP');
  }
  if (value === undefined || value === null || value === '') return 'unknown';
  if (typeof value !== 'string' || value.length > 128) throw new Error('Invalid trusted client address');
  return value.trim().toLowerCase() || 'unknown';
}

async function schema(db) {
  if (!db || typeof db.prepare !== 'function') throw new Error('Rate-limit storage is unavailable');
  if (!ready.has(db)) {
    const creating = Promise.resolve().then(() => db.prepare("CREATE TABLE IF NOT EXISTS request_limits (scope TEXT PRIMARY KEY, window_start INTEGER NOT NULL, n INTEGER NOT NULL, clients TEXT NOT NULL DEFAULT '{}')").run())
      .catch((error) => { ready.delete(db); throw error; });
    ready.set(db, creating);
  }
  await ready.get(db);
}

async function consumeD1(db, admission) {
  await schema(db);
  const { scope, windowStart, limit, subject, subjectLimit } = admission;
  let row;
  if (subject) {
    // The path contains only our SHA-256 hexadecimal digest, never caller text.
    const path = `$."${subject}"`;
    row = await db.prepare(`INSERT INTO request_limits (scope, window_start, n, clients) VALUES (?, ?, 1, ?)
      ON CONFLICT(scope) DO UPDATE SET
        window_start = excluded.window_start,
        n = CASE WHEN request_limits.window_start = excluded.window_start THEN request_limits.n + 1 ELSE 1 END,
        clients = CASE WHEN request_limits.window_start = excluded.window_start
          THEN json_set(request_limits.clients, ?, COALESCE(json_extract(request_limits.clients, ?), 0) + 1)
          ELSE excluded.clients END
      WHERE request_limits.window_start < excluded.window_start OR
        (request_limits.window_start = excluded.window_start AND request_limits.n < ?
          AND COALESCE(json_extract(request_limits.clients, ?), 0) < ?)
      RETURNING n`).bind(scope, windowStart, JSON.stringify({ [subject]: 1 }), path, path, limit, path, subjectLimit).first();
  } else {
    row = await db.prepare(`INSERT INTO request_limits (scope, window_start, n, clients) VALUES (?, ?, 1, '{}')
      ON CONFLICT(scope) DO UPDATE SET
        window_start = excluded.window_start,
        n = CASE WHEN request_limits.window_start = excluded.window_start THEN request_limits.n + 1 ELSE 1 END,
        clients = '{}'
      WHERE request_limits.window_start < excluded.window_start OR
        (request_limits.window_start = excluded.window_start AND request_limits.n < ?)
      RETURNING n`).bind(scope, windowStart, limit).first();
  }
  if (row === null) return false;
  if (!row || typeof row !== 'object' || !Number.isSafeInteger(row.n) || row.n < 1 || row.n > limit) throw new Error('Invalid rate-limit storage result');
  return true;
}

async function admit(env, admission, retryAfter) {
  // A future store must perform the same conditional admission atomically and
  // return a boolean. A rejected or malformed store result must fail closed.
  const store = env.RATE_LIMIT_STORE;
  if (store !== undefined && typeof store !== 'function') throw new Error('Invalid RATE_LIMIT_STORE configuration');
  const allowed = store ? await store(admission) : await consumeD1(env.DB, admission);
  if (typeof allowed !== 'boolean') throw new Error('Invalid rate-limit storage result');
  return { allowed, retryAfter };
}

export async function loginLimit(request, env, now = Date.now()) {
  const { windowStart, retryAfter } = windowAt(now);
  const limit = setting(env, 'RATE_LOGIN_PER_MINUTE', 120, 1000);
  const subjectLimit = setting(env, 'RATE_LOGIN_PER_CLIENT', 10, 1000);
  const subject = await hash(`ip:${await clientAddress(request, env)}`);
  return admit(env, { scope: 'login', windowStart, limit, subject, subjectLimit }, retryAfter);
}

export async function writeLimit(env, email, now = Date.now()) {
  const { windowStart, retryAfter } = windowAt(now);
  if (typeof email !== 'string' || !email || email !== email.trim().toLowerCase()) throw new Error('Invalid rate-limit identity');
  const limit = setting(env, 'RATE_WRITE_PER_MINUTE', 300, 5000);
  return admit(env, { scope: `write:${await hash(email)}`, windowStart, limit, subject: null, subjectLimit: null }, retryAfter);
}
