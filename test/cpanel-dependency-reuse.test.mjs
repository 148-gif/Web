import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyVerifiedDependencies, dependencyReuseProof, dependencyInstallPolicy, matchesInstallPolicy } from '../scripts/cpanel-dependency-reuse.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const oldSha = 'a'.repeat(40), nextSha = 'b'.repeat(40), runtimeHash = 'c'.repeat(64);
const tools = commit => ({ version: 1, virtualenvRoot: '/venv/' + commit + '/24', nodeRealPath: '/bin/node', nodeSha256: 'a'.repeat(64), npmRealPath: '/bin/npm-cli.js', npmSha256: 'b'.repeat(64), nodeVersion: '24.22.2', npmVersion: '11.19.1' });
async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'verified-dependencies-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'), workspace = join(root, 'stage'), destination = join(workspace, 'node_modules');
  await fs.mkdir(source, { mode: 0o750 }); await fs.chmod(source, 0o750);
  await fs.mkdir(join(source, 'pkg'), { mode: 0o755 }); await fs.chmod(join(source, 'pkg'), 0o755);
  await fs.mkdir(workspace, { mode: 0o700 });
  const bytes = Buffer.from('module.exports = 42;\n');
  await fs.writeFile(join(source, 'pkg/index.js'), bytes); await fs.chmod(join(source, 'pkg/index.js'), 0o640);
  const records = [{ path: '.', type: 'directory', mode: 0o750 }, { path: 'pkg', type: 'directory', mode: 0o755 },
    { path: 'pkg/index.js', type: 'file', mode: 0o640, bytes: bytes.length, sha256: hash(bytes) }];
  const sourceTools = tools(oldSha), targetTools = tools(nextSha);
  const dependencies = { packages: 1, bytes: bytes.length, inodes: 2, treeSha256: hash(JSON.stringify(records)) };
  const args = { sourceCommit: oldSha, targetCommit: nextSha, runtimeManifestSha256: runtimeHash, sourceTools, targetTools,
    oldPackage: Buffer.from('{"dependencies":{"pkg":"1.0.0"}}'), nextPackage: Buffer.from('{"dependencies":{"pkg":"1.0.0"}}'),
    oldLock: Buffer.from('exact locked bytes'), nextLock: Buffer.from('exact locked bytes'),
    receipt: { version: 1, commit: oldSha, runtimeManifestSha256: runtimeHash, toolchainSha256: hash(JSON.stringify(sourceTools)), ...dependencies },
    installed: { version: 1, commit: oldSha, runtimeManifestSha256: runtimeHash, packages: 1 }, dependencies, records, blockSize: 4096 };
  args.installedPolicy = dependencyInstallPolicy(args.receipt, args.oldPackage, args.oldLock);
  return { source, destination, bytes, records, args };
}

test('a matching prior receipt admits a bounded independent copy with exact file and directory modes', async t => {
  const f = await fixture(t), grant = dependencyReuseProof(f.args);
  assert.equal(grant.sourceCommit, oldSha); assert.equal(grant.targetCommit, nextSha);
  assert(grant.allocation.bytes >= 64 * 1024 ** 2 + 4096); assert(grant.allocation.inodes >= f.records.length);
  await copyVerifiedDependencies(f.source, f.destination, f.records, grant, 4096);
  for (const r of f.records) {
    const old = await fs.lstat(join(f.source, r.path)), copied = await fs.lstat(join(f.destination, r.path));
    assert.equal(copied.mode & 0o777, old.mode & 0o777); assert.notEqual(copied.ino, old.ino);
  }
  assert.deepEqual(await fs.readFile(join(f.destination, 'pkg/index.js')), f.bytes);
  await assert.rejects(copyVerifiedDependencies(f.source, f.destination, f.records, grant, 4096));
  await fs.writeFile(join(f.destination, 'pkg/index.js'), 'candidate only');
  assert.deepEqual(await fs.readFile(join(f.source, 'pkg/index.js')), f.bytes);
});

test('package, lock, tool bytes, version and provider venv mismatches decline reuse', async t => {
  const f = await fixture(t);
  for (const diff of [{ nextPackage: Buffer.from('other package') }, { nextLock: Buffer.from('other lock') },
    ...Object.entries({ nodeVersion: '24.23.0', npmVersion: '11.20.0', nodeSha256: '0'.repeat(64), npmSha256: '1'.repeat(64), virtualenvRoot: '/next/24.22.2' }).map(([k,v]) => ({ targetTools: { ...f.args.targetTools, [k]: v } }))]) {
    assert.equal(dependencyReuseProof({ ...f.args, ...diff }), null);
  }
  await assert.rejects(fs.lstat(f.destination), { code: 'ENOENT' });
});

test('a partial installation, mismatched source receipt or corrupted record list is refused', async t => {
  const f = await fixture(t);
  for (const diff of [{ installed: {} }, { installed: { ...f.args.installed, commit: nextSha } },
    { receipt: { ...f.args.receipt, treeSha256: '0'.repeat(64) } }, { records: f.records.slice(0,2) }]) {
    assert.throws(() => dependencyReuseProof({ ...f.args, ...diff }));
  }
  const proof = dependencyReuseProof(f.args);
  await assert.rejects(copyVerifiedDependencies(f.source, f.destination, f.records, { ...proof, allocation: { bytes: 1, inodes: 1 } }, 4096));
  await assert.rejects(fs.lstat(f.destination), { code: 'ENOENT' });
});

for (const change of ['same size tamper', 'link', 'hardlink', 'writable mode']) {
  test('copy blocks source drift: ' + change, async t => {
    const f = await fixture(t), proof = dependencyReuseProof(f.args), sourceFile = join(f.source, 'pkg/index.js');
    if (change === 'same size tamper') await fs.writeFile(sourceFile, Buffer.alloc(f.bytes.length, 88));
    else if (change === 'link') { await fs.rename(sourceFile, sourceFile + '.moved'); await fs.symlink(sourceFile + '.moved', sourceFile); }
    else if (change === 'hardlink') await fs.link(sourceFile, sourceFile + '.alias');
    else await fs.chmod(sourceFile, 0o666);
    await assert.rejects(copyVerifiedDependencies(f.source, f.destination, f.records, proof, 4096));
    await assert.rejects(fs.lstat(join(f.destination, 'pkg/index.js')), { code: 'ENOENT' });
  });
}

test('only a complete matching install-policy receipt admits a new donor', async t => {
  const { args } = await fixture(t);
  assert.equal(args.installedPolicy.dependencyReceiptSha256, hash(JSON.stringify(args.receipt) + '\n'));
  for (const installedPolicy of [undefined, null, {}, { ...args.installedPolicy, policy: 'npm-ci/allow-scripts' },
    { ...args.installedPolicy, lockSha256: '0'.repeat(64) }, { ...args.installedPolicy, dependencyReceiptSha256: '0'.repeat(64) }]) {
    assert.equal(dependencyReuseProof({ ...args, installedPolicy }), null);
    assert.throws(() => dependencyReuseProof({ ...args, installedPolicy, receipt: { ...args.receipt, bytes: 0 } }));
    assert.throws(() => dependencyReuseProof({ ...args, installedPolicy, records: args.records.slice(0, 2) }));
  }
  assert.throws(() => dependencyReuseProof({ ...args, nextLock: Buffer.from('new lock'), records: args.records.slice(0, 2) }));
});

test('the legacy exception pins every byte of the one measured f2 receipt', () => {
  const receipt = { version: 1, commit: 'f2e03e0cc624fc08c66ecab1ab20915fab3b42aa', runtimeManifestSha256: 'a9c531d46164d810e32a2bb6f6d28348644c9e9b8ee80a3b092481cc4974c352',
    toolchainSha256: 'b53005f2e3f1ada7b7ee4b3a644b863d838ff4a0e37983c0e336ffa59ad71f85', packages: 13, bytes: 4440521, inodes: 533,
    treeSha256: '4fa89e215ad0de852dcc9cb56a20c0e2f727b6f0919457df5cb29992f60df2a2' };
  const pkg = Buffer.from('pinned package bytes'), lock = Buffer.from('pinned lock bytes');
  assert.equal(hash(JSON.stringify(receipt) + '\n'), '31339f614056e057b7f92236c89d27acea0208dea230c458e7e6d4cc9e8bb401');
  assert.equal(matchesInstallPolicy(undefined, receipt, pkg, lock), true);
  assert.equal(matchesInstallPolicy({}, receipt, pkg, lock), false);
  for (const change of [{ commit: nextSha }, { treeSha256: runtimeHash }, { inodes: 534 }, { runtimeManifestSha256: runtimeHash }, { toolchainSha256: runtimeHash }]) {
    assert.equal(matchesInstallPolicy(undefined, { ...receipt, ...change }, pkg, lock), false);
  }
});
