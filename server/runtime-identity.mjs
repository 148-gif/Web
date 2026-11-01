// Installed-code identity, verified once during startup after schema readiness.
// This is evidence of the packaged bytes, not a substitute for the private
// deployer's verification of the trusted GitHub artifact and dependency install.
import { constants } from 'node:fs';
import { open, lstat, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, resolve, parse, join, sep } from 'node:path';

export const RUNTIME_IDENTITY_FILE = 'app-release.json';
const FORMAT = 'heichal-runtime-identity', MAX_IDENTITY = 256 * 1024;
const MAX_FILES = 256, MAX_FILE = 8 * 1024 * 1024, MAX_TOTAL = 64 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/, COMMIT = /^[a-f0-9]{40}$/;
const REQUIRED = ['package.json', 'package-lock.json', 'passenger.cjs', 'server/start.mjs', 'server/runtime.mjs'];
// CloudLinux creates these after packaging. They are explicitly outside the
// code identity; npm ci and the deployer separately verify the dependency tree
// and installation configuration. None can be declared as a runtime source.
const HOST_ENTRIES = new Set(['node_modules', 'tmp', 'logs', 'stderr.log', '.npmrc']);
const ROOT_FILES = new Set(['package.json', 'package-lock.json', 'passenger.cjs']);
const SCRIPT_FILES = new Set(['check-cpanel-readiness.mjs', 'prepare-mysql-migration.mjs', 'import-mysql-migration.mjs',
  'smoke-cpanel.mjs', 'publish-cpanel.mjs', 'setup-local-auth.mjs', 'arm-local-auth.mjs', 'setup-google-auth.mjs', 'setup-local-invitations.mjs']);
const sourcePath = (path) => typeof path === 'string' && (ROOT_FILES.has(path) ||
  /^server\/[A-Za-z0-9_-]+\.(?:mjs|sql)$/.test(path) || /^cms-worker\/[A-Za-z0-9_-]+\.mjs$/.test(path) ||
  path === 'site/admin/image-rules.mjs' || path.startsWith('scripts/') && SCRIPT_FILES.has(path.slice(8)));
const digest = (value) => createHash('sha256').update(value).digest('hex');
const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));

export class RuntimeIdentityError extends Error {
  constructor() { super('Installed runtime identity could not be verified'); this.name = 'RuntimeIdentityError'; }
}
const invalid = () => { throw new RuntimeIdentityError(); };
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.nlink === b.nlink &&
  a.mode === b.mode && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

function validateIdentity(value) {
  if (!keys(value, ['format', 'version', 'commit', 'files']) || value.format !== FORMAT || value.version !== 1 ||
      !COMMIT.test(value.commit || '') || !Array.isArray(value.files) || !value.files.length || value.files.length > MAX_FILES) invalid();
  let total = 0;
  const seen = new Set();
  for (const file of value.files) {
    if (!keys(file, ['path', 'bytes', 'sha256']) || !sourcePath(file.path) || seen.has(file.path) ||
        !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > MAX_FILE || !HASH.test(file.sha256 || '')) invalid();
    total += file.bytes; if (total > MAX_TOTAL) invalid();
    seen.add(file.path);
  }
  if (REQUIRED.some((path) => !seen.has(path))) invalid();
  return value;
}

// The packager invokes this only with its canonical Git commit and the exact
// files just copied into the new app directory. The identity excludes itself;
// the final global manifest includes it, avoiding a circular digest.
export function runtimeIdentityDocument({ commit, files }) {
  return validateIdentity({ format: FORMAT, version: 1, commit,
    files: files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) });
}

async function directoryChain(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) invalid();
  const chain = []; let current = parse(path).root;
  for (const part of path.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    const info = await lstat(current, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink()) invalid();
    chain.push({ path: current, dev: info.dev, ino: info.ino });
  }
  return chain;
}

async function verifyDirectories(chain) {
  for (const entry of chain) {
    const info = await lstat(entry.path, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== entry.dev || info.ino !== entry.ino) invalid();
  }
}

async function readRegular(root, path, limit, { optional = false, observed } = {}) {
  const parents = await directoryChain(join(root, ...path.split('/').slice(0, -1)));
  const filename = join(root, path);
  let file;
  try { file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(limit)) invalid();
    const bytes = Buffer.alloc(Number(before.size) + 1); let size = 0;
    while (size < bytes.length) {
      const result = await file.read(bytes, size, bytes.length - size, size);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    const after = await file.stat({ bigint: true });
    const pathname = await lstat(filename, { bigint: true });
    if (size !== Number(before.size) || !sameFile(before, after) || !sameFile(before, pathname) || pathname.isSymbolicLink()) invalid();
    await verifyDirectories(parents);
    if (observed) observed.push({ filename, info: after, parents });
    return bytes.subarray(0, size);
  } finally { await file.close(); }
}

// Selector creates this empty directory even when the site's documents live in
// CMS_PUBLIC_ROOT. It is not an additional source or static-file namespace.
async function verifyEmptyHostPublic(root) {
  const path = join(root, 'public');
  const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const before = await directory.stat({ bigint: true });
    if (!before.isDirectory() || typeof process.getuid !== 'function' ||
        before.uid !== BigInt(process.getuid()) || (before.mode & 0o7022n)) invalid();
    if ((await readdir(path)).length !== 0) invalid();
    const after = await directory.stat({ bigint: true }), named = await lstat(path, { bigint: true });
    if (!sameFile(before, after) || !sameFile(before, named) || named.isSymbolicLink() ||
        after.uid !== before.uid || named.uid !== before.uid) invalid();
  } finally { await directory.close(); }
}

async function verifyInventory(root, declared) {
  const found = new Set();
  async function walk(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!prefix && HOST_ENTRIES.has(entry.name)) continue;
      if (!prefix && entry.name === 'public') { await verifyEmptyHostPublic(root); continue; }
      const path = prefix + entry.name;
      if (entry.isSymbolicLink()) invalid();
      if (entry.isDirectory()) {
        if (!['server', 'cms-worker', 'scripts', 'site', 'site/admin'].includes(path)) invalid();
        await walk(join(directory, entry.name), path + '/');
      } else if (entry.isFile()) {
        if (path !== RUNTIME_IDENTITY_FILE && !declared.has(path)) invalid();
        found.add(path);
      } else invalid();
    }
  }
  await walk(root);
  if (found.size !== declared.size + 1 || !found.has(RUNTIME_IDENTITY_FILE) || [...declared].some((path) => !found.has(path))) invalid();
}

export async function readRuntimeIdentity({ applicationRoot, required = true } = {}) {
  try {
    if (typeof required !== 'boolean') invalid();
    if (typeof applicationRoot !== 'string' || applicationRoot === parse(applicationRoot).root) invalid();
    const roots = await directoryChain(applicationRoot);
    const observed = [];
    const bytes = await readRegular(applicationRoot, RUNTIME_IDENTITY_FILE, MAX_IDENTITY, { optional: !required, observed });
    if (bytes === null) return null;
    const document = validateIdentity(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    const declared = new Set(document.files.map((file) => file.path));
    await verifyInventory(applicationRoot, declared);
    for (const expected of document.files) {
      const actual = await readRegular(applicationRoot, expected.path, MAX_FILE, { observed });
      if (actual.length !== expected.bytes || digest(actual) !== expected.sha256) invalid();
    }
    // Revalidate the inventory and identity after file reads: replacement of a
    // manifest or source path while verification runs must not produce a proof.
    await verifyInventory(applicationRoot, declared);
    if (!bytes.equals(await readRegular(applicationRoot, RUNTIME_IDENTITY_FILE, MAX_IDENTITY))) invalid();
    for (const file of observed) {
      if (!sameFile(file.info, await lstat(file.filename, { bigint: true }))) invalid();
      await verifyDirectories(file.parents);
    }
    await verifyDirectories(roots);
    const entries = document.files.map(({ path, bytes, sha256 }) => ({ path: 'app/' + path, bytes, sha256 }));
    entries.push({ path: 'app/' + RUNTIME_IDENTITY_FILE, bytes: bytes.length, sha256: digest(bytes) });
    entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    return Object.freeze({ commit: document.commit, runtimeManifestSha256: digest(JSON.stringify(entries)), verified: true });
  } catch {
    // Filesystem errors and JSON contents are private. Do not retain their
    // cause, paths or potentially secret bytes in a public startup error.
    throw new RuntimeIdentityError();
  }
}
