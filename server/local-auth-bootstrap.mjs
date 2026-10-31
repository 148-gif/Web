// Private host operation, never an HTTP handler. A capability is deliberately
// armed only after the optional auth tables exist and an owner binding is known.
import { constants } from 'node:fs';
import { lstat, open, realpath, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, parse, resolve, sep } from 'node:path';
import { digestToken, randomToken } from './local-auth-crypto.mjs';

const HASH = /^[a-f0-9]{64}$/;
export class LocalAuthBootstrapError extends Error {
  constructor(code, message) { super(message); this.name = 'LocalAuthBootstrapError'; this.code = code; }
}
const fail = (code, message) => { throw new LocalAuthBootstrapError(code, message); };
const inside = (child, parent) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

function ownerBinding(owners, requested) {
  const list = typeof owners === 'string' ? owners.split(',').map((value) => value.trim()) : owners;
  if (!Array.isArray(list) || !list.length || list.some((value) => typeof value !== 'string' || !HASH.test(value))) fail('invalid-owner', 'Existing configured owner identifiers are required');
  const unique = [...new Set(list)];
  if (requested === undefined && unique.length === 1) return unique[0];
  if (typeof requested !== 'string' || !HASH.test(requested) || !unique.includes(requested)) fail('invalid-owner', 'Select one existing configured owner identifier');
  return requested;
}

async function canonicalDirectory(path, privateAncestors = false) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0') || resolve(path) !== path) fail('invalid-path', 'An existing canonical absolute directory is required');
  const ancestry = [];
  for (let current = path;; current = dirname(current)) {
    ancestry.unshift(current);
    if (current === parse(current).root) break;
  }
  for (const current of ancestry) {
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) fail('invalid-path', 'Symlink or non-directory path components are not permitted');
    // Sticky system temporary directories are safe parents of an owned0700
    // fixture/private directory; ordinary writable ancestors are not.
    const trustedSticky = (info.mode & 0o1000) && (info.uid === 0 || (typeof process.getuid === 'function' && info.uid === process.getuid()));
    if (privateAncestors && (info.mode & 0o022) && !trustedSticky) fail('invalid-path', 'Private capability ancestors must not be writable by other users');
  }
  if (await realpath(path) !== path) fail('invalid-path', 'Directory path must be canonical without symlinks');
  return lstat(path);
}

async function privateDestination(codeFile, publicRoot) {
  if (typeof codeFile !== 'string' || !isAbsolute(codeFile) || codeFile.includes('\0') || resolve(codeFile) !== codeFile) fail('invalid-path', 'A new absolute private code-file path is required');
  await canonicalDirectory(publicRoot);
  if (inside(codeFile, publicRoot)) fail('public-path', 'The bootstrap code must remain outside the public document root');
  const parent = dirname(codeFile), info = await canonicalDirectory(parent, true);
  if ((info.mode & 0o777) !== 0o700 || (typeof process.getuid === 'function' && info.uid !== process.getuid())) fail('private-parent', 'The capability parent must be owned by this account with mode0700');
  return { parent, info };
}

export async function armLocalAuth({ store, owners, ownerHash, codeFile, publicRoot, now = Date.now(), minutes = 15 } = {}) {
  const owner = ownerBinding(owners, ownerHash);
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 30 || !Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(now + minutes * 60000)) fail('invalid-expiry', 'Bootstrap expiry must be between1 and30 minutes');
  if (!store || typeof store.ensureSchema !== 'function' || typeof store.atomic !== 'function') fail('invalid-store', 'Explicit local authentication storage is required');
  const destination = await privateDestination(codeFile, publicRoot);
  await store.ensureSchema();
  const expires = now + minutes * 60000;
  let created = null, handle = null;
  const sameParent = async () => {
    const parent = await canonicalDirectory(destination.parent, true);
    if (parent.dev !== destination.info.dev || parent.ino !== destination.info.ino || (parent.mode & 0o777) !== 0o700) fail('changed-path', 'Private destination changed during bootstrap arming');
  };
  try {
    await store.atomic(async (tx) => {
      const settings = await tx.getSettings();
      if (settings.bootstrap_consumed || await tx.countUsers() !== 0) fail('already-initialized', 'Local administrator bootstrap was already consumed');
      if (settings.bootstrap_hash !== null && settings.bootstrap_expires > now) fail('already-armed', 'An unexpired bootstrap capability is already armed');
      await sameParent();
      // O_EXCL also rejects existing symlinks. Never overwrite a capability or
      // another file, including during an explicit re-arm after expiry.
      handle = await open(codeFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      created = await handle.stat();
      if (!created.isFile() || created.nlink !== 1) fail('invalid-file', 'The private capability must be a new regular file');
      await handle.chmod(0o600);
      await sameParent();
      const code = randomToken();
      await handle.writeFile(code + '\n', 'utf8');
      await handle.sync();
      await handle.close(); handle = null;
      const directory = await open(destination.parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await directory.sync(); } finally { await directory.close(); }
      await sameParent();
      await tx.saveSettings({ ...settings, bootstrap_hash: digestToken(code), bootstrap_expires: expires, bootstrap_owner_hash: owner });
    });
    return { armed: true, codeFile, expiresAt: new Date(expires).toISOString(), ownerHash: owner, capabilityPrinted: false, passwordCreated: false };
  } catch (error) {
    if (handle) { try { await handle.close(); } catch { /* Preserve the original failure. */ } }
    if (created) {
      try {
        await sameParent();
        const current = await lstat(codeFile);
        if (current.isFile() && current.dev === created.dev && current.ino === created.ino) await unlink(codeFile);
      } catch { /* Never follow an altered path or remove a replacement file. */ }
    }
    if (error instanceof LocalAuthBootstrapError) throw error;
    // Driver/file errors may contain private configuration. No cause is copied.
    fail('arming-failed', 'Private bootstrap arming did not complete; inspect private configuration before retrying');
  }
}
