// Copy only an operator-verified, immutable production dependency inventory.
// The native installer authenticates both release manifests, the donor receipt,
// package versions and provider links. There is no npm or network fallback here.
import { createHash } from 'node:crypto';
import { constants as F, promises as fs } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

const fail = () => { throw new Error('Verified dependency reuse refused'); };
const sha = value => createHash('sha256').update(value).digest('hex');
const digest = /^[a-f0-9]{64}$/, commitId = /^[a-f0-9]{40}$/;
const policy = '5185/npm-ci/production/omit-dev/ignore-scripts/no-audit/no-fund';
const mib = 1024 * 1024;
const modeOf = stat => Number(stat.mode & 0o7777n);
const safeMode = mode => Number.isSafeInteger(mode) && mode >= 0 && mode <= 0o777 && !(mode & 0o022);
const uid = () => BigInt(process.getuid());
const exact = (value, keys) => value && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const inside = (path, root) => path === root || path.startsWith(root + sep);
const sameFile = (a, b) => ['dev','ino','uid','gid','mode','nlink','size','mtimeNs','ctimeNs'].every(key => a[key] === b[key]);
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Release-specific venv and modules paths are validated by the native toolchain
// validator for each release. Only their version suffix can be compared directly.
export function sameInstallInputs(oldPackage, oldLock, nextPackage, nextLock, oldTools, nextTools) {
  const fields = ['version','nodeRealPath','nodeSha256','npmRealPath','npmSha256','nodeVersion','npmVersion'];
  return oldPackage.equals(nextPackage) && oldLock.equals(nextLock) && fields.every(key => oldTools[key] === nextTools[key]) &&
    oldTools.virtualenvRoot.split('/').at(-1) === nextTools.virtualenvRoot.split('/').at(-1);
}

function checkRecords(records, dependencies, blockSize) {
  if (!Array.isArray(records) || !records.length || records.length > 30001 || !Number.isSafeInteger(blockSize) || blockSize < 1 || blockSize > 1024 * 1024) fail();
  const unit = Math.max(4096, blockSize), dirs = new Set(records.filter(r => r?.type === 'directory').map(r => r.path)), paths = new Set();
  let logical = 0, allocated = 0;
  for (const r of records) {
    if (!r || !safeMode(r.mode) || typeof r.path !== 'string' || paths.has(r.path)) fail();
    if (r.path !== '.' && (!/^[a-zA-Z0-9_@.+/-]+$/.test(r.path) || r.path.length > 4096 || r.path.split('/').some(p => !p || p === '.' || p === '..') || !dirs.has(dirname(r.path)))) fail();
    paths.add(r.path);
    if (r.type === 'directory' && exact(r, ['path','type','mode'])) dirs.add(r.path);
    else if (r.type === 'file' && r.path !== '.' && exact(r, ['path','type','mode','bytes','sha256']) && digest.test(r.sha256) && Number.isSafeInteger(r.bytes) && r.bytes >= 0 && r.bytes <= 8 * mib) {
      logical += r.bytes; allocated += unit * Math.ceil(r.bytes / unit);
    } else fail();
  }
  if (!dirs.has('.') || logical > 512 * mib || dependencies.bytes !== logical || dependencies.inodes !== records.length - 1 || dependencies.treeSha256 !== sha(JSON.stringify(records))) fail();
  // Charge full dense allocation (including sparse sources), directory blocks,
  // entry/metadata overhead, the runtime source ceiling and small private receipts.
  return { bytes: 65 * mib + allocated + 2 * unit * records.length, inodes: 1024 + records.length };
}

// The original v1 dependency receipt omits install flags. Only the measured
// first f2 installation may use this exception without a separate policy file.
const firstNativeCommit = 'f2e03e0cc624fc08c66ecab1ab20915fab3b42aa';
const firstNativeReceipt = '31339f614056e057b7f92236c89d27acea0208dea230c458e7e6d4cc9e8bb401';

export function dependencyInstallPolicy(receipt, packageBytes, lockBytes) {
  return { version: 1, policy, commit: receipt.commit, runtimeManifestSha256: receipt.runtimeManifestSha256,
    toolchainSha256: receipt.toolchainSha256, packageSha256: sha(packageBytes), lockSha256: sha(lockBytes),
    dependencyReceiptSha256: sha(JSON.stringify(receipt) + '\n') };
}

export function matchesInstallPolicy(measured, receipt, packageBytes, lockBytes) {
  const expected = dependencyInstallPolicy(receipt, packageBytes, lockBytes);
  if (measured === undefined) return receipt.commit === firstNativeCommit && expected.dependencyReceiptSha256 === firstNativeReceipt;
  return sameJson(measured, expected);
}

export function dependencyReuseProof({ sourceCommit, targetCommit, runtimeManifestSha256, sourceTools, targetTools, oldPackage, oldLock, nextPackage, nextLock, receipt, installed, installedPolicy, dependencies, records, blockSize }) {
  if (!commitId.test(sourceCommit) || !commitId.test(targetCommit) || sourceCommit === targetCommit || !digest.test(runtimeManifestSha256)) fail();
  const sourceReceipt = { version: 1, commit: sourceCommit, runtimeManifestSha256, toolchainSha256: sha(JSON.stringify(sourceTools)), ...dependencies };
  const completion = { version: 1, commit: sourceCommit, runtimeManifestSha256, packages: dependencies.packages };
  if (!sameJson(sourceReceipt, receipt) || !sameJson(completion, installed)) fail();
  const allocation = checkRecords(records, dependencies, blockSize);
  if (!sameInstallInputs(oldPackage, oldLock, nextPackage, nextLock, sourceTools, targetTools) || !matchesInstallPolicy(installedPolicy, receipt, oldPackage, oldLock)) return null;
  return { version: 1, policy, platform: process.platform, architecture: process.arch, sourceCommit, targetCommit,
    packageSha256: sha(nextPackage), lockSha256: sha(nextLock), sourceReceiptSha256: sha(JSON.stringify(receipt) + '\n'),
    targetToolchainSha256: sha(JSON.stringify(targetTools)), ...dependencies, allocation };
}

async function directory(path) {
  const stat = await fs.lstat(path, { bigint: true });
  if (!isAbsolute(path) || resolve(path) !== path || await fs.realpath(path) !== path || !stat.isDirectory() || stat.uid !== uid() || !safeMode(modeOf(stat))) fail();
  return stat;
}
async function syncDirectory(path) {
  const h = await fs.open(path, F.O_RDONLY | F.O_DIRECTORY | F.O_NOFOLLOW);
  try { await h.sync(); } finally { await h.close(); }
}
async function copyFile(source, destination, record, device) {
  const before = await fs.lstat(source, { bigint: true });
  if (!before.isFile() || before.uid !== uid() || before.nlink !== 1n || before.dev !== device || modeOf(before) !== record.mode || before.size !== BigInt(record.bytes) || await fs.realpath(source) !== source) fail();
  const input = await fs.open(source, F.O_RDONLY | F.O_NOFOLLOW | F.O_NONBLOCK);
  let data;
  try {
    if (!sameFile(before, await input.stat({ bigint: true }))) fail();
    data = Buffer.alloc(record.bytes);
    for (let at = 0; at < data.length;) {
      const read = await input.read(data, at, data.length - at, at);
      if (!read.bytesRead) fail(); at += read.bytesRead;
    }
    if (sha(data) !== record.sha256 || !sameFile(before, await input.stat({ bigint: true })) || !sameFile(before, await fs.lstat(source, { bigint: true }))) fail();
  } finally { await input.close(); }
  const output = await fs.open(destination, F.O_WRONLY | F.O_CREAT | F.O_EXCL | F.O_NOFOLLOW, 0o600);
  try { await output.writeFile(data); await output.chmod(record.mode); await output.sync(); } finally { await output.close(); }
}

// Caller already holds deployment/admission locks, admitted proof.allocation,
// and owns a fresh private workspace. It verifies the finished tree with the
// native installer, then seals a NEW target receipt and renames on this device.
export async function copyVerifiedDependencies(source, destination, records, proof, blockSize) {
  if (!sameJson(checkRecords(records, proof, blockSize), proof.allocation) || proof.policy !== policy || inside(source, destination) || inside(destination, source)) fail();
  const src = await directory(source), parent = await directory(dirname(destination));
  if (!isAbsolute(destination) || resolve(destination) !== destination || src.dev !== parent.dev || modeOf(parent) !== 0o700) fail();
  const directories = [];
  // Native tree-hash sort is lexical ('.bin' follows '.', but '+pkg' can sort
  // before '.'). Create directories in depth order without changing the hash.
  const ordered = [...records].sort((a, b) => (a.path === '.' ? 0 : a.path.split('/').length) - (b.path === '.' ? 0 : b.path.split('/').length));
  for (const r of ordered) {
    const from = r.path === '.' ? source : join(source, r.path), to = r.path === '.' ? destination : join(destination, r.path);
    if ((await directory(dirname(to))).dev !== parent.dev) fail();
    if (r.type === 'directory') {
      const info = await directory(from);
      if (info.dev !== src.dev || modeOf(info) !== r.mode) fail();
      await fs.mkdir(to, { mode: 0o700 }); directories.push([to, r.mode, await directory(to)]);
    } else await copyFile(from, to, r, src.dev);
  }
  for (const [path, mode, created] of directories.reverse()) {
    const handle = await fs.open(path, F.O_RDONLY | F.O_DIRECTORY | F.O_NOFOLLOW);
    try {
      const now = await handle.stat({ bigint: true });
      if (now.dev !== created.dev || now.ino !== created.ino || now.uid !== uid() || await fs.realpath(path) !== path) fail();
      await handle.chmod(mode); await handle.sync();
    } finally { await handle.close(); }
  }
  await syncDirectory(dirname(destination));
}
