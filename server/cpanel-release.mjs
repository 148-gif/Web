// Static releases only. The application owner must control these directory
// trees and coordinate every writer with this lock. No app files, dependencies,
// database rows, host configuration or untracked hosting files are deployed.
// Individual replacements are atomic; the whole tree is not. Apache serves503
// while a release mutates files, and a crash leaves maintenance enabled.
import { constants } from 'node:fs';
import { lstat, realpath, readdir, open, mkdir, rename, unlink, rmdir } from 'node:fs/promises';
import { dirname, join, resolve, sep, isAbsolute, parse } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

export const CPANEL_MAINTENANCE_RULES = '# BEGIN HEICHAL RELEASE MAINTENANCE\nRewriteEngine On\nRewriteCond %{DOCUMENT_ROOT}/.cpanel-maintenance -f\nRewriteRule ^ - [R=503,L]\n# END HEICHAL RELEASE MAINTENANCE';
const MARKER = 'admin/build.json', FLAG = '.cpanel-maintenance';
const MAX_FILES = 30000, MAX_FILE = 128 * 1024 * 1024, MAX_TOTAL = 2 * 1024 ** 3, MAX_JSON = 16 * 1024 * 1024;
const HASH = /^[0-9a-f]{64}$/, COMMIT = /^[0-9a-f]{40}$/, ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const activeLocks = new Set();
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const journalDigest = (journal) => hash(JSON.stringify({ ...journal, phase: undefined }));
const inside = (a, b) => a === b || a.startsWith(b + sep);
const fail = (message) => { throw new Error(message); };
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const safePath = (value) => typeof value === 'string' && value.isWellFormed() && value && Buffer.byteLength(value) <= 4096 && !value.includes('\\') && !/[\p{Cc}]/u.test(value) && !value.split('/').some((part) => !part || part === '.' || part === '..' || Buffer.byteLength(part) > 255);
const secretPath = (path) => path.split('/').some((part) => ['.git', 'node_modules', '.env'].includes(part) || part.startsWith('.env.') || /\.(?:key|pem|p12|pfx)$/i.test(part));
const protectedPath = (path) => ['.htaccess', FLAG, '.well-known', 'cgi-bin', 'php.ini', '.user.ini', 'admin/.htaccess', 'admin/deployment.json'].some((item) => path === item || path.startsWith(item + '/')) || path.split('/').includes('.htaccess');
const publicPath = (path) => safePath(path) && !secretPath(path) && !protectedPath(path) && !/^(?:app|server|cms-worker)\//.test(path) && !/\.(?:php\d*|phtml|phar|cgi|pl|sh)$/i.test(path);
const originOf = (value) => {
  let url; try { url = new URL(value); } catch { fail('An explicit HTTPS site origin is required'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) fail('An explicit HTTPS site origin is required');
  return url.origin;
};
const baseOf = (value) => {
  if (value === '') return value;
  if (typeof value !== 'string' || !/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/.test(value)) fail('Invalid site base');
  return value;
};
const same = (a, b) => a === null ? b === null : b !== null && a.bytes === b.bytes && a.sha256 === b.sha256 && (a.mode === undefined || b.mode === undefined || a.mode === b.mode);
const entryValid = (entry, withMode = false) => object(entry) && publicPath(entry.path) && Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 && entry.bytes <= MAX_FILE && HASH.test(entry.sha256 || '') && (!withMode || Number.isInteger(entry.mode) && entry.mode >= 0 && entry.mode <= 0o777);

async function canonicalDirectory(path, privateOnly = false) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) fail('Directories must use explicit canonical absolute paths');
  let current = parse(path).root;
  for (const part of path.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) fail('Directory paths must not contain symbolic links');
  }
  const info = await lstat(path);
  if (await realpath(path) !== path || privateOnly && (info.mode & 0o077)) fail('Private directories must be canonical with mode0700');
  return info;
}

async function parents(root, relative, create = false) {
  if (!safePath(relative)) fail('Unsafe relative file path');
  let current = root;
  for (const part of relative.split('/').slice(0, -1)) {
    const next = join(current, part);
    let info;
    try { info = await lstat(next); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!create) return false;
      await mkdir(next, { mode: 0o755 }); await syncDirectory(current); info = await lstat(next);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) fail('File parents must be real directories');
    current = next;
  }
  return true;
}

async function regular(root, relative, { optional = false, privateOnly = false } = {}) {
  if (!await parents(root, relative)) { if (optional) return null; fail('Required file is missing'); }
  let file;
  try { file = await open(join(root, relative), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || privateOnly && (info.mode & 0o077)) fail('Expected an unlinked regular file with safe permissions');
    return { file, info };
  } catch (error) { await file.close(); throw error; }
}

async function readBytes(root, relative, maximum = MAX_JSON, options = {}) {
  const opened = await regular(root, relative, options);
  if (!opened) return null;
  const { file, info } = opened;
  try {
    if (info.size > maximum) fail('File exceeds its size budget');
    const buffer = Buffer.alloc(Math.min(info.size + 1, maximum + 1));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > info.size || (await file.stat()).size !== info.size) fail('File changed while being read');
    return buffer.subarray(0, offset);
  } finally { await file.close(); }
}

async function jsonFile(root, relative, options) {
  const bytes = await readBytes(root, relative, MAX_JSON, options);
  if (bytes === null) return null;
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail('Invalid release state JSON'); }
}

async function fileInfo(root, relative, optional = true) {
  const opened = await regular(root, relative, { optional });
  if (!opened) return null;
  const { file, info } = opened, digest = createHash('sha256');
  let bytes = 0;
  try {
    if (info.size > MAX_FILE) fail('File exceeds its size budget');
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      bytes += chunk.length; if (bytes > MAX_FILE) fail('File exceeds its size budget'); digest.update(chunk);
    }
    if (bytes !== info.size || (await file.stat()).size !== info.size) fail('File changed during hashing');
    return { bytes, sha256: digest.digest('hex'), mode: info.mode & 0o777 };
  } finally { await file.close(); }
}

async function syncDirectory(path) { const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY); try { await file.sync(); } finally { await file.close(); } }
async function moveFile(sourceRoot, from, targetRoot, to) {
  await rename(join(sourceRoot, from), join(targetRoot, to));
  await syncDirectory(dirname(join(targetRoot, to)));
  const sourceParent = dirname(join(sourceRoot, from));
  if (sourceParent !== dirname(join(targetRoot, to))) await syncDirectory(sourceParent);
}
async function writeAll(file, bytes) { let at = 0; while (at < bytes.length) { const result = await file.write(bytes, at); if (!result.bytesWritten) fail('Could not write release state'); at += result.bytesWritten; } }
async function durableFile(root, relative, bytes, { replace = false, mode = 0o600 } = {}) {
  await parents(root, relative, true);
  const temporary = replace ? `${relative}.${randomUUID()}.tmp` : relative;
  const file = await open(join(root, temporary), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try { await writeAll(file, Buffer.from(bytes)); await file.sync(); } finally { await file.close(); }
  if (replace) await rename(join(root, temporary), join(root, relative));
  await syncDirectory(dirname(join(root, relative)));
}
const writeJson = (root, relative, value, replace = false) => durableFile(root, relative, JSON.stringify(value) + '\n', { replace });
async function removeFile(root, relative, optional = false) {
  const found = await regular(root, relative, { optional });
  if (!found) return;
  await found.file.close(); await unlink(join(root, relative)); await syncDirectory(dirname(join(root, relative)));
}

async function copyVerified(source, relative, target, destination, expected, mode) {
  const opened = await regular(source, relative);
  await parents(target, destination, true);
  const output = await open(join(target, destination), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  const digest = createHash('sha256'); let bytes = 0;
  try {
    for await (const chunk of opened.file.createReadStream({ autoClose: false })) {
      bytes += chunk.length; if (bytes > MAX_FILE) fail('File exceeds its size budget');
      digest.update(chunk); await writeAll(output, chunk);
    }
    if (bytes !== expected.bytes || digest.digest('hex') !== expected.sha256) fail('Release bytes changed during preparation');
    await output.chmod(mode); await output.sync();
  } finally { await opened.file.close(); await output.close(); }
  await syncDirectory(dirname(join(target, destination)));
}

async function walkFiles(root) {
  const result = [];
  async function walk(relative = '') {
    for (const item of await readdir(join(root, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${item.name}` : item.name;
      if (!safePath(path) || secretPath(path) || item.isSymbolicLink()) fail('Artifact contains a prohibited path');
      if (item.isDirectory()) await walk(path);
      else if (item.isFile()) { result.push(path); if (result.length > MAX_FILES) fail('Artifact contains too many files'); }
      else fail('Artifact contains a special file');
    }
  }
  await walk(); return result.sort();
}

function manifestFiles(manifest, expected) {
  if (!object(manifest) || manifest.format !== 'heichal-cpanel-release' || manifest.version !== 1 || manifest.commit !== expected.commit || manifest.branch !== expected.branch || manifest.siteOrigin !== expected.siteOrigin || manifest.siteBase !== expected.siteBase || typeof manifest.staging !== 'boolean' || manifest.secretsIncluded !== false || manifest.databaseIncluded !== false || !HASH.test(manifest.apacheBaselineSha256 || '') || !Array.isArray(manifest.files) || manifest.files.length > MAX_FILES) fail('Release manifest does not match the approved target');
  const seen = new Set(); let total = 0;
  const files = [];
  for (const entry of manifest.files) {
    if (!object(entry) || !safePath(entry.path) || secretPath(entry.path) || !/^(?:public|app)\//.test(entry.path) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > MAX_FILE || !HASH.test(entry.sha256 || '') || seen.has(entry.path)) fail('Invalid release manifest file');
    seen.add(entry.path); total += entry.bytes; if (total > MAX_TOTAL) fail('Release exceeds its total size budget');
    if (entry.path.startsWith('public/')) {
      const path = entry.path.slice(7);
      if (path === '.htaccess') continue; // Hash-validated input, never host configuration.
      if (!publicPath(path)) fail('Release attempts to replace a protected public path');
      files.push({ path, bytes: entry.bytes, sha256: entry.sha256, mode: 0o644 });
    }
  }
  if (!files.some((entry) => entry.path === MARKER) || !files.some((entry) => entry.path === 'index.html')) fail('Release lacks its public index or commit marker');
  return files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
}

async function artifact(candidateRoot, expected) {
  await canonicalDirectory(candidateRoot, true);
  const bytes = await readBytes(candidateRoot, 'manifest.json'), manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  const files = manifestFiles(manifest, expected), paths = (await walkFiles(candidateRoot)).filter((path) => path !== 'manifest.json');
  if (paths.join('\n') !== manifest.files.map((entry) => entry.path).sort().join('\n')) fail('Release contains missing or unlisted files');
  for (const entry of manifest.files) if (!same(entry, await fileInfo(candidateRoot, entry.path, false))) fail('Release checksum mismatch');
  const marker = await jsonFile(candidateRoot, `public/${MARKER}`);
  if (marker?.sha !== expected.commit) fail('Release commit marker mismatch');
  return { manifest, bytes, files, sha256: hash(bytes) };
}

async function roots(documentRoot, stateRoot, candidateRoot) {
  const document = await canonicalDirectory(documentRoot), state = await canonicalDirectory(stateRoot, true);
  if (inside(stateRoot, documentRoot) || inside(documentRoot, stateRoot) || candidateRoot && (inside(stateRoot, candidateRoot) || inside(candidateRoot, stateRoot) || inside(candidateRoot, documentRoot) || inside(documentRoot, candidateRoot))) fail('Release, state and public trees must be separate');
  if (document.dev !== state.dev) fail('Private release state must share the public filesystem');
}

async function hostConfig(documentRoot, approvedHash) {
  if (!HASH.test(approvedHash || '')) fail('An approved live Apache configuration hash is required');
  const bytes = await readBytes(documentRoot, '.htaccess', 1024 * 1024);
  if (hash(bytes) !== approvedHash || !bytes.toString('utf8').includes(CPANEL_MAINTENANCE_RULES)) fail('Live Apache configuration is unapproved or lacks the maintenance rules');
}

function stateShape(value, documentRoot) {
  if (!object(value) || value.format !== 'heichal-cpanel-deployment' || value.version !== 1 || value.documentRoot !== documentRoot || !ID.test(value.releaseId || '') || !COMMIT.test(value.commit || '') || typeof value.branch !== 'string' || !value.branch || !HASH.test(value.manifestSha256 || '') || !Array.isArray(value.files) || value.files.length > MAX_FILES || value.files.some((entry) => !entryValid(entry, true)) || new Set(value.files.map((entry) => entry.path)).size !== value.files.length) fail('Invalid previous deployment state');
  originOf(value.siteOrigin); baseOf(value.siteBase);
}

async function validateState(value, stateRoot, documentRoot) {
  if (value === null) return null;
  stateShape(value, documentRoot);
  const bytes = await readBytes(stateRoot, `releases/${value.releaseId}/manifest.json`, MAX_JSON, { privateOnly: true });
  if (hash(bytes) !== value.manifestSha256) fail('Previous deployment manifest is corrupt');
  const expected = { commit: value.commit, branch: value.branch, siteOrigin: value.siteOrigin, siteBase: value.siteBase };
  const files = manifestFiles(JSON.parse(bytes.toString('utf8')), expected);
  if (JSON.stringify(files) !== JSON.stringify(value.files)) fail('Previous tracked files differ from their verified manifest');
  return value;
}
const readState = async (stateRoot, documentRoot) => validateState(await jsonFile(stateRoot, 'current.json', { optional: true, privateOnly: true }), stateRoot, documentRoot);

async function pending(stateRoot) { return jsonFile(stateRoot, 'pending.json', { optional: true, privateOnly: true }); }
async function assertIdle(stateRoot, documentRoot) {
  if (await pending(stateRoot)) fail('An incomplete release requires explicit recovery');
  try { await lstat(join(stateRoot, 'lock')); fail('A release lock already exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (await fileInfo(documentRoot, FLAG)) fail('An existing maintenance flag must be reconciled explicitly');
}

async function acquireLock(stateRoot, releaseId, recover = false) {
  if (recover) {
    const owner = await jsonFile(stateRoot, 'lock/owner.json', { privateOnly: true });
    if (!object(owner) || owner.releaseId !== releaseId || owner.host !== hostname() || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || activeLocks.has(stateRoot)) fail('The release lock cannot be recovered safely');
    let alive = false;
    if (owner.pid !== process.pid) { try { process.kill(owner.pid, 0); alive = true; } catch (error) { if (error.code !== 'ESRCH') alive = true; } }
    if (alive) fail('The release lock owner is still running');
    await removeFile(stateRoot, 'lock/owner.json'); await rmdir(join(stateRoot, 'lock')); await syncDirectory(stateRoot);
  }
  try { await mkdir(join(stateRoot, 'lock'), { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') fail('A release lock already exists'); throw error; }
  activeLocks.add(stateRoot);
  await writeJson(stateRoot, 'lock/owner.json', { releaseId, pid: process.pid, host: hostname() });
}
async function releaseLock(stateRoot) {
  await removeFile(stateRoot, 'lock/owner.json'); await rmdir(join(stateRoot, 'lock')); await syncDirectory(stateRoot); activeLocks.delete(stateRoot);
}

async function maintenance(documentRoot, releaseId, enabled, stateRoot) {
  const bytes = await readBytes(documentRoot, FLAG, 256, { optional: true });
  if (bytes !== null && bytes.toString('utf8') !== releaseId + '\n') fail('A foreign maintenance flag must not be changed');
  if (enabled && bytes === null) {
    // Prepare the ownership bytes privately, so a crash can never leave an
    // empty public flag that cannot be distinguished from a foreign marker.
    const temporary = `releases/${releaseId}/maintenance/${randomUUID()}`;
    await durableFile(stateRoot, temporary, releaseId + '\n');
    await moveFile(stateRoot, temporary, documentRoot, FLAG);
  }
  if (!enabled && bytes !== null) await removeFile(documentRoot, FLAG);
}

async function planFiles(documentRoot, previous, next, adoptExisting) {
  const before = new Map((previous?.files || []).map((entry) => [entry.path, entry])), after = new Map(next.files.map((entry) => [entry.path, entry]));
  const operations = [];
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const current = await fileInfo(documentRoot, path), old = before.get(path), target = after.get(path) || null;
    if (old && !same(old, current)) fail('A previously tracked public file has changed');
    if (!old && current && !adoptExisting) fail('Existing public files require explicit baseline adoption');
    if (!same(target, current)) operations.push({ path, before: current, after: target && { bytes: target.bytes, sha256: target.sha256, mode: 0o644 } });
  }
  // The served commit must be the final replacement even if it sorts earlier.
  return operations.sort((a, b) => (a.path === MARKER) - (b.path === MARKER));
}

async function verifyTree(documentRoot, files) {
  for (const entry of files) if (!same(entry, await fileInfo(documentRoot, entry.path))) fail('Public files do not match the verified release');
}

async function updateJournal(stateRoot, journal, phase) {
  journal.phase = phase;
  await writeJson(stateRoot, `releases/${journal.releaseId}/journal.json`, journal, true);
}

async function readJournal(stateRoot, documentRoot, releaseId) {
  if (!ID.test(releaseId || '')) fail('An exact release ID is required');
  const journal = await jsonFile(stateRoot, `releases/${releaseId}/journal.json`, { privateOnly: true });
  if (!object(journal) || journal.format !== 'heichal-cpanel-journal' || journal.version !== 1 || journal.releaseId !== releaseId || journal.documentRoot !== documentRoot || !['prepared', 'applying', 'committed', 'rolling_back', 'rolled_back'].includes(journal.phase) || !HASH.test(journal.approvedHostConfigSha256 || '') || !Array.isArray(journal.operations) || journal.operations.length > MAX_FILES * 2) fail('Invalid recovery journal');
  const checksum = await readBytes(stateRoot, `releases/${releaseId}/plan.sha256`, 65, { privateOnly: true });
  if (checksum.toString('utf8') !== journalDigest(journal) + '\n') fail('Recovery journal checksum mismatch');
  await validateState(journal.afterState, stateRoot, documentRoot); await validateState(journal.beforeState, stateRoot, documentRoot);
  if (journal.afterState.releaseId !== releaseId) fail('Recovery release identity mismatch');
  const before = new Map((journal.beforeState?.files || []).map((entry) => [entry.path, entry])), after = new Map(journal.afterState.files.map((entry) => [entry.path, entry])), seen = new Set();
  for (const [index, operation] of journal.operations.entries()) {
    if (!object(operation) || !publicPath(operation.path) || seen.has(operation.path) || ![operation.before, operation.after].every((entry) => entry === null || entryValid({ ...entry, path: operation.path }, true))) fail('Unsafe recovery operation');
    seen.add(operation.path);
    if (operation.after === null ? !before.has(operation.path) || after.has(operation.path) : !same(operation.after, after.get(operation.path) || null)) fail('Recovery operation differs from verified manifests');
    if (before.has(operation.path) && !same(operation.before, before.get(operation.path))) fail('Recovery baseline differs from previous deployment');
    if (operation.before && !same({ bytes: operation.before.bytes, sha256: operation.before.sha256 }, await fileInfo(stateRoot, `releases/${releaseId}/backup/${index}`, false))) fail('Recovery backup checksum mismatch');
  }
  return journal;
}

async function restoreJournal(stateRoot, documentRoot, journal, probe) {
  await hostConfig(documentRoot, journal.approvedHostConfigSha256);
  await updateJournal(stateRoot, journal, 'rolling_back'); await maintenance(documentRoot, journal.releaseId, true, stateRoot);
  const operations = journal.operations.map((operation, index) => ({ ...operation, index })).reverse().sort((a, b) => (a.path === MARKER) - (b.path === MARKER));
  for (const operation of operations) {
    const current = await fileInfo(documentRoot, operation.path);
    if (same(operation.before, current)) continue;
    if (!same(operation.after, current)) fail('A public file changed after deployment; recovery stopped');
    if (operation.before === null) await removeFile(documentRoot, operation.path, true);
    else {
      const temporary = `releases/${journal.releaseId}/restore/${randomUUID()}`;
      await copyVerified(stateRoot, `releases/${journal.releaseId}/backup/${operation.index}`, stateRoot, temporary, operation.before, operation.before.mode);
      await parents(documentRoot, operation.path, true);
      await moveFile(stateRoot, temporary, documentRoot, operation.path);
    }
  }
  if (journal.beforeState) await verifyTree(documentRoot, journal.beforeState.files);
  if (journal.beforeState) await writeJson(stateRoot, 'current.json', journal.beforeState, true); else await removeFile(stateRoot, 'current.json', true);
  await maintenance(documentRoot, journal.releaseId, false, stateRoot);
  if (probe) {
    try {
      if (await probe({ documentRoot, commit: journal.beforeState?.commit || null, releaseId: journal.beforeState?.releaseId || null }) === false) fail('Rollback probe failed');
      for (const operation of journal.operations) if (!same(operation.before, await fileInfo(documentRoot, operation.path))) fail('Restored public files changed during the probe');
    }
    catch { await maintenance(documentRoot, journal.releaseId, true, stateRoot); fail('Rollback probe failed; maintenance remains enabled'); }
  }
  await updateJournal(stateRoot, journal, 'rolled_back'); await removeFile(stateRoot, 'pending.json', true);
}

export async function promoteCpanelRelease({ candidateRoot, documentRoot, stateRoot, expectedCommit, expectedBranch = 'claude/greeting-2i183o', expectedSiteOrigin, expectedSiteBase = '', approvedHostConfigSha256, apply = false, adoptExisting = false, probe } = {}) {
  if (!COMMIT.test(expectedCommit || '') || typeof expectedBranch !== 'string' || !expectedBranch || typeof apply !== 'boolean' || typeof adoptExisting !== 'boolean' || probe !== undefined && typeof probe !== 'function') fail('Invalid release arguments');
  const expected = { commit: expectedCommit, branch: expectedBranch, siteOrigin: originOf(expectedSiteOrigin), siteBase: baseOf(expectedSiteBase) };
  await roots(documentRoot, stateRoot, candidateRoot); await assertIdle(stateRoot, documentRoot); await hostConfig(documentRoot, approvedHostConfigSha256);
  const candidate = await artifact(candidateRoot, expected), previous = await readState(stateRoot, documentRoot);
  if (previous && (previous.siteOrigin !== expected.siteOrigin || previous.siteBase !== expected.siteBase || previous.branch !== expected.branch)) fail('Previous deployment belongs to another target');
  const operations = await planFiles(documentRoot, previous, candidate, adoptExisting);
  const summary = { commit: expected.commit, previousCommit: previous?.commit || null, changed: operations.filter((op) => op.after).length, removed: operations.filter((op) => !op.after).length, publicFiles: candidate.files.length, hostConfigurationPreserved: true, appModified: false, databaseModified: false };
  if (!apply) return { ...summary, applied: false, dryRun: true };
  const releaseId = randomUUID(); await acquireLock(stateRoot, releaseId);
  let journal, wrotePending = false, preserveLock = false;
  try {
    if (await pending(stateRoot)) fail('An incomplete release requires explicit recovery');
    const latest = await readState(stateRoot, documentRoot);
    if (JSON.stringify(latest) !== JSON.stringify(previous)) fail('Deployment state changed while the release was prepared');
    await hostConfig(documentRoot, approvedHostConfigSha256);
    await mkdir(join(stateRoot, 'releases'), { mode: 0o700 }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
    await canonicalDirectory(join(stateRoot, 'releases'), true); await syncDirectory(stateRoot);
    await mkdir(join(stateRoot, 'releases', releaseId), { mode: 0o700 }); await syncDirectory(join(stateRoot, 'releases'));
    for (const [index, operation] of operations.entries()) {
      if (operation.before) await copyVerified(documentRoot, operation.path, stateRoot, `releases/${releaseId}/backup/${index}`, operation.before, 0o600);
      if (operation.after) await copyVerified(candidateRoot, `public/${operation.path}`, stateRoot, `releases/${releaseId}/stage/${index}`, operation.after, 0o644);
    }
    await durableFile(stateRoot, `releases/${releaseId}/manifest.json`, candidate.bytes);
    const afterState = { format: 'heichal-cpanel-deployment', version: 1, documentRoot, releaseId, ...expected, manifestSha256: candidate.sha256, files: candidate.files };
    journal = { format: 'heichal-cpanel-journal', version: 1, releaseId, documentRoot, phase: 'prepared', approvedHostConfigSha256, beforeState: previous, afterState, operations };
    await writeJson(stateRoot, `releases/${releaseId}/journal.json`, journal);
    await durableFile(stateRoot, `releases/${releaseId}/plan.sha256`, journalDigest(journal) + '\n');
    await writeJson(stateRoot, 'pending.json', { releaseId }); wrotePending = true;
    await updateJournal(stateRoot, journal, 'applying'); await maintenance(documentRoot, releaseId, true, stateRoot);
    for (const [index, operation] of operations.entries()) {
      if (!same(operation.before, await fileInfo(documentRoot, operation.path))) fail('A public file changed before replacement');
      if (operation.after) {
        await parents(documentRoot, operation.path, true);
        await moveFile(stateRoot, `releases/${releaseId}/stage/${index}`, documentRoot, operation.path);
      } else await removeFile(documentRoot, operation.path);
    }
    await verifyTree(documentRoot, candidate.files); await hostConfig(documentRoot, approvedHostConfigSha256);
    await maintenance(documentRoot, releaseId, false, stateRoot);
    if (probe && await probe({ documentRoot, commit: expected.commit, releaseId, siteOrigin: expected.siteOrigin }) === false) fail('Release probe failed');
    await verifyTree(documentRoot, candidate.files); await hostConfig(documentRoot, approvedHostConfigSha256);
    await writeJson(stateRoot, 'current.json', afterState, true); await updateJournal(stateRoot, journal, 'committed'); await removeFile(stateRoot, 'pending.json'); wrotePending = false;
    return { ...summary, applied: true, dryRun: false, releaseId, rollbackAvailable: true };
  } catch (error) {
    if (wrotePending) {
      try { await restoreJournal(stateRoot, documentRoot, journal); wrotePending = false; }
      catch { preserveLock = true; fail('Release failed; maintenance and recovery state require explicit recovery'); }
    }
    throw error;
  } finally {
    if (preserveLock) activeLocks.delete(stateRoot); else await releaseLock(stateRoot);
  }
}

export async function rollbackCpanelRelease({ documentRoot, stateRoot, releaseId, apply = false, recover = false, probe } = {}) {
  if (typeof apply !== 'boolean' || typeof recover !== 'boolean' || probe !== undefined && typeof probe !== 'function') fail('Invalid rollback arguments');
  await roots(documentRoot, stateRoot);
  const journal = await readJournal(stateRoot, documentRoot, releaseId), current = await readState(stateRoot, documentRoot), unfinished = await pending(stateRoot);
  if (unfinished && (!recover || unfinished.releaseId !== releaseId)) fail('The incomplete release requires explicit recovery of its exact ID');
  if (!unfinished && current?.releaseId !== releaseId) fail('Only the currently deployed release can be rolled back');
  if (!unfinished && journal.phase !== 'committed') fail('Release journal is not committed');
  await hostConfig(documentRoot, journal.approvedHostConfigSha256);
  const summary = { releaseId, commit: journal.beforeState?.commit || null, previousCommit: journal.afterState.commit, appModified: false, databaseModified: false };
  if (!apply) return { ...summary, applied: false, dryRun: true };
  let lockExists = false;
  try { await lstat(join(stateRoot, 'lock')); lockExists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!unfinished && !(recover && lockExists)) await assertIdle(stateRoot, documentRoot);
  await acquireLock(stateRoot, releaseId, Boolean(unfinished || recover && lockExists));
  let completed = false;
  try {
    if (!unfinished) await writeJson(stateRoot, 'pending.json', { releaseId });
    await restoreJournal(stateRoot, documentRoot, journal, probe); completed = true;
    return { ...summary, applied: true, dryRun: false, rolledBack: true };
  } finally {
    if (completed) await releaseLock(stateRoot); else activeLocks.delete(stateRoot);
  }
}
