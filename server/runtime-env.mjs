// Optional private runtime configuration. This is deliberately not a shell or
// general dotenv loader: whole-line comments and KEY=raw / KEY="JSON string"
// are supported, with no interpolation, multiline values or inline comments.
// Secrets stay in the returned record; callers must never log that record.
import { constants, promises as fs } from 'node:fs';
import { isAbsolute, resolve, dirname, join, parse, sep } from 'node:path';

export const RUNTIME_ENV_KEYS = Object.freeze([
  'ALLOWED_ORIGIN', 'BRANCH', 'CLOUDFLARE_AI_ACCOUNT_ID', 'CLOUDFLARE_AI_API_TOKEN',
  'CMS_AI_PROVIDER', 'CMS_API_BASE_PATH', 'CMS_APP_ROOT', 'CMS_BIND_HOST', 'CMS_DEPLOYMENT_CANDIDATE',
  'CMS_GOOGLE_AUTH_ENABLED', 'CMS_GOOGLE_SETUP_ENABLED', 'CMS_LOCAL_AUTH_ENABLED', 'CMS_LOCAL_INVITATIONS_ENABLED',
  'CMS_LOCAL_DEVELOPMENT', 'CMS_MEDIA_ROOT', 'CMS_PUBLIC_ORIGIN', 'CMS_PUBLIC_ROOT',
  'CMS_PUBLISH_ENABLED', 'CMS_READ_ONLY', 'CMS_STAGING', 'CMS_TRUSTED_PROXY_IPS',
  'GITHUB_TOKEN', 'GOOGLE_CLIENT_ID', 'MEDIA_GH_FILE_MB', 'MEDIA_GH_TOTAL_MB',
  'MEDIA_R2_FILE_MB', 'MEDIA_R2_TOTAL_GB', 'MYSQL_CONNECTION_LIMIT', 'MYSQL_DATABASE',
  'MYSQL_HOST', 'MYSQL_PASSWORD', 'MYSQL_PORT', 'MYSQL_SSL', 'MYSQL_SSL_CA',
  'MYSQL_USER', 'OWNERS', 'RATE_LOGIN_PER_CLIENT', 'RATE_LOGIN_PER_MINUTE',
  'RATE_WRITE_PER_MINUTE', 'REPO', 'SESSION_SECRET', 'TRANSLATE_PER_DAY', 'TRANSLATE_PER_USER',
]);
const allowed = new Set(RUNTIME_ENV_KEYS);
const MAX_BYTES = 64 * 1024, MAX_VALUE_BYTES = 8192;
const control = /[\p{Cc}\u2028\u2029]/u;
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const inside = (a, b) => a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);

export class RuntimeEnvError extends Error {
  constructor() { super('Invalid private runtime environment configuration'); this.name = 'RuntimeEnvError'; }
}
const fail = () => { throw new RuntimeEnvError(); };
const validValue = (value) => typeof value === 'string' && value.isWellFormed() &&
  !control.test(value) && Buffer.byteLength(value, 'utf8') <= MAX_VALUE_BYTES;
const canonicalPath = (value) => typeof value === 'string' && value && !control.test(value) &&
  isAbsolute(value) && resolve(value) === value;

export function parseRuntimeEnvironment(text) {
  try {
    if (typeof text !== 'string' || !text.isWellFormed() || text.startsWith('\ufeff') || Buffer.byteLength(text, 'utf8') > MAX_BYTES) fail();
    const out = Object.create(null);
    for (let line of text.split('\n')) {
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (control.test(line)) fail();
      if (!line.trim() || line.trimStart().startsWith('#')) continue;
      const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
      if (!match || !allowed.has(match[1]) || Object.hasOwn(out, match[1])) fail();
      const raw = match[2];
      // JSON quoting preserves spaces, #, = and backslashes without shell or
      // dotenv expansion. Raw # characters are literal, not inline comments.
      const value = raw.startsWith('"') ? JSON.parse(raw) : raw;
      if (!raw.startsWith('"') && /["']/.test(raw) || !validValue(value)) fail();
      out[match[1]] = value;
    }
    return out;
  } catch { fail(); }
}

export function renderRuntimeEnvironment(values) {
  try {
    if (!object(values)) fail();
    const keys = Object.keys(values).sort();
    if (keys.some((key) => !allowed.has(key) || !validValue(values[key]))) fail();
    const text = keys.map((key) => `${key}=${JSON.stringify(values[key])}\n`).join('');
    if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) fail();
    return text;
  } catch { fail(); }
}

const sameNode = (a, b) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid && a.gid === b.gid;
const sameFile = (a, b) => sameNode(a, b) && a.size === b.size && a.nlink === b.nlink &&
  a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

async function directoryChain(path) {
  if (!canonicalPath(path)) fail();
  const chain = [], root = parse(path).root;
  let current = root;
  for (const part of [null, ...path.slice(root.length).split(sep).filter(Boolean)]) {
    if (part !== null) current = join(current, part);
    const info = await fs.lstat(current, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink()) fail();
    chain.push({ path: current, info });
  }
  if (await fs.realpath(path) !== path) fail();
  return chain;
}

async function unchangedDirectories(chain) {
  for (const before of chain) {
    const after = await fs.lstat(before.path, { bigint: true });
    if (!after.isDirectory() || after.isSymbolicLink() || !sameNode(before.info, after)) fail();
  }
}

function privateFile(info, uid) {
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n ||
      (info.mode & 0o7777n) !== 0o600n || info.uid !== uid || info.size < 1n || info.size > BigInt(MAX_BYTES)) fail();
}

export async function readRuntimeEnvironmentFile({ filePath, applicationRoot } = {}) {
  let handle;
  try {
    if (!canonicalPath(filePath) || typeof applicationRoot !== 'string' || !isAbsolute(applicationRoot) || typeof process.getuid !== 'function') fail();
    const app = resolve(applicationRoot), parent = dirname(filePath), uid = BigInt(process.getuid());
    if (inside(filePath, app)) fail();
    const chain = await directoryChain(parent), appChain = await directoryChain(app);
    const parentInfo = chain.at(-1).info;
    if ((parentInfo.mode & 0o7777n) !== 0o700n || parentInfo.uid !== uid) fail();
    const before = await fs.lstat(filePath, { bigint: true }); privateFile(before, uid);
    handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = await handle.stat({ bigint: true }); privateFile(opened, uid);
    if (!sameFile(before, opened)) fail();
    const bytes = Buffer.alloc(Number(opened.size) + 1);
    let size = 0;
    while (size < bytes.length) {
      const result = await handle.read(bytes, size, Math.min(4096, bytes.length - size), size);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    const after = await handle.stat({ bigint: true }); privateFile(after, uid);
    if (size !== Number(opened.size) || !sameFile(opened, after) || !sameFile(after, await fs.lstat(filePath, { bigint: true }))) fail();
    const values = parseRuntimeEnvironment(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)));
    if (values.CMS_APP_ROOT !== app || !canonicalPath(values.CMS_PUBLIC_ROOT)) fail();
    const publicRoot = values.CMS_PUBLIC_ROOT;
    if (inside(filePath, publicRoot) || inside(app, publicRoot) || inside(publicRoot, app)) fail();
    const publicChain = await directoryChain(publicRoot);
    await unchangedDirectories(chain); await unchangedDirectories(appChain); await unchangedDirectories(publicChain);
    // Verify the named path still identifies the held descriptor after all
    // parsing/path checks. No path or underlying filesystem error is exposed.
    if (!sameFile(after, await handle.stat({ bigint: true })) || !sameFile(after, await fs.lstat(filePath, { bigint: true }))) fail();
    return values;
  } catch { fail(); }
  finally {
    if (handle) {
      try { await handle.close(); } catch { /* No private path or driver error in diagnostics. */ }
    }
  }
}

export async function loadRuntimeEnvironment({ inherited = process.env, applicationRoot } = {}) {
  try {
    if (!object(inherited)) fail();
    if (inherited.CMS_ENV_FILE === undefined) return inherited;
    const values = await readRuntimeEnvironmentFile({ filePath: inherited.CMS_ENV_FILE, applicationRoot });
    // File mode has one source of application settings. An omitted key must
    // not silently fall back to an old Selector auth/provider setting.
    for (const key of RUNTIME_ENV_KEYS) {
      if (inherited[key] !== undefined && (!Object.hasOwn(values, key) || inherited[key] !== values[key])) fail();
    }
    return { ...inherited, ...values };
  } catch { fail(); }
}
