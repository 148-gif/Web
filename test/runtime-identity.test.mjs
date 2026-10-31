import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { readRuntimeIdentity, runtimeIdentityDocument, RuntimeIdentityError, RUNTIME_IDENTITY_FILE } from '../server/runtime-identity.mjs';
import { runtimeManifestSha256 } from '../server/cpanel-publication.mjs';

const sha = 'a'.repeat(40), digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'runtime-identity-')), applicationRoot = join(base, 'app');
  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(applicationRoot, { mode: 0o700 });
  const content = { 'server/start.mjs': 'export {};\n', 'server/runtime.mjs': 'export const ready = true;\n',
    'package.json': '{"type":"module"}\n', 'package-lock.json': '{"lockfileVersion":3}\n', 'passenger.cjs': 'require("node:process");\n',
    'cms-worker/worker.mjs': 'export default {};\n', 'site/admin/image-rules.mjs': 'export {};\n',
    'scripts/setup-google-auth.mjs': 'export {};\n', 'scripts/setup-local-invitations.mjs': 'export {};\n' };
  const files = [];
  for (const [path, text] of Object.entries(content)) {
    await mkdir(dirname(join(applicationRoot, path)), { recursive: true, mode: 0o700 });
    await writeFile(join(applicationRoot, path), text, { mode: 0o600 });
    files.push({ path, bytes: Buffer.byteLength(text), sha256: digest(text) });
  }
  const document = runtimeIdentityDocument({ commit: sha, files });
  const identityFile = join(applicationRoot, RUNTIME_IDENTITY_FILE);
  const save = async (value = document) => writeFile(identityFile, JSON.stringify(value) + '\n', { mode: 0o600 });
  await save();
  return { base, applicationRoot, document, files, identityFile, save };
}
const rejected = (fn) => assert.rejects(fn, (error) => {
  assert.ok(error instanceof RuntimeIdentityError);
  assert.equal(error.message, 'Installed runtime identity could not be verified');
  assert.equal(error.cause, undefined);
  return true;
});

test('installed identity derives the global runtime manifest digest from actual source bytes and self entry', async (t) => {
  const f = await fixture(t), identityBytes = await readFile(f.identityFile);
  const result = await readRuntimeIdentity({ applicationRoot: f.applicationRoot });
  const expected = runtimeManifestSha256({ files: [...f.files.map((entry) => ({ ...entry, path: 'app/' + entry.path })),
    { path: 'app/' + RUNTIME_IDENTITY_FILE, bytes: identityBytes.length, sha256: digest(identityBytes) }] });
  assert.deepEqual(result, { commit: sha, runtimeManifestSha256: expected, verified: true });
  assert.equal(Object.isFrozen(result), true);
  assert.deepEqual(Object.keys(result).sort(), ['commit', 'runtimeManifestSha256', 'verified']);
});

test('optional mode tolerates only an absent identity, never a present invalid identity or missing app root', async (t) => {
  const f = await fixture(t);
  await rm(f.identityFile);
  assert.equal(await readRuntimeIdentity({ applicationRoot: f.applicationRoot, required: false }), null);
  await rejected(() => readRuntimeIdentity({ applicationRoot: f.applicationRoot }));
  await writeFile(f.identityFile, 'private-fixture-not-json');
  await rejected(() => readRuntimeIdentity({ applicationRoot: f.applicationRoot, required: false }));
  await rejected(() => readRuntimeIdentity({ applicationRoot: join(f.base, 'absent'), required: false }));
  await rejected(() => readRuntimeIdentity({ applicationRoot: f.applicationRoot, required: 'false' }));
});

test('tampered same-size contents, missing files and incorrect declared lengths cannot attest a release', async (t) => {
  for (const mutate of [
    async (f) => writeFile(join(f.applicationRoot, 'server/start.mjs'), 'export XX;\n'),
    async (f) => rm(join(f.applicationRoot, 'package-lock.json')),
    async (f) => { f.document.files[0].bytes++; await f.save(); },
  ]) {
    const f = await fixture(t); await mutate(f);
    await rejected(() => readRuntimeIdentity({ applicationRoot: f.applicationRoot }));
  }
});

test('manifest schema rejects duplicate, unsafe, undeclared-host and self-referential paths before reading them', async (t) => {
  const badPaths = ['../secret', '/private-fixture-secret', 'server/../start.mjs', 'server\\runtime.mjs',
    '.env', 'node_modules/provider.mjs', 'tmp/runtime.mjs', 'app-release.json', 'scripts/arbitrary-secret.mjs'];
  for (const path of badPaths) {
    const f = await fixture(t);
    f.document.files.push({ path, bytes: 0, sha256: digest('') }); await f.save();
    await rejected(() => readRuntimeIdentity({ applicationRoot: f.applicationRoot }));
  }
  const f = await fixture(t); f.document.files.push({ ...f.document.files[0] }); await f.save();
  await rejected(() => readRuntimeIdentity({ applicationRoot: f.applicationRoot }));
});

test('manifest requires an exact commit, required sources and bounded strict fields', async (t) => {
  for (const mutate of [
    (d) => { d.commit = 'HEAD'; },
    (d) => { d.commit = 'A'.repeat(40); },
    (d) => { d.version = 2; },
    (d) => { d.extra = 'private-fixture-secret'; },
    (d) => { d.files = d.files.filter((f) => f.path !== 'passenger.cjs'); },
    (d) => { d.files[0].extra = 'private-fixture-secret'; },
    (d) => { d.files[0].bytes = 8 * 1024 * 1024 + 1; },
    (d) => { d.files[0].sha256 = 'f'.repeat(63); },
    (d) => { d.files = Array.from({ length: 257 }, (_, i) => ({ path: `server/file-${i}.mjs`, bytes: 0, sha256: digest('') })); },
  ]) {
    const f = await fixture(t); mutate(f.document); await f.save();
    await rejected(() => readRuntimeIdentity({ applicationRoot: f.applicationRoot }));
  }
});

test('oversized and invalid UTF-8 identity data is bounded and never exposed in errors', async (t) => {
  const f = await fixture(t);
  await writeFile(f.identityFile, Buffer.alloc(256 * 1024 + 1, 97));
  await rejected(() => readRuntimeIdentity({ applicationRoot: f.applicationRoot }));
  await writeFile(f.identityFile, Buffer.from([0xc3, 0x28]));
  await rejected(() => readRuntimeIdentity({ applicationRoot: f.applicationRoot }));
});

test('symlinked app paths, source directories, source files and identity files are rejected', async (t) => {
  {
    const f = await fixture(t), alias = join(f.base, 'alias'); await symlink(f.applicationRoot, alias);
    await rejected(() => readRuntimeIdentity({ applicationRoot: alias }));
  }
  for (const path of ['server/start.mjs', RUNTIME_IDENTITY_FILE]) {
    const f = await fixture(t), original = join(f.applicationRoot, path), outside = join(f.base, 'private-fixture-secret');
    await writeFile(outside, await readFile(original)); await rm(original); await symlink(outside, original);
    await rejected(() => readRuntimeIdentity({ applicationRoot: f.applicationRoot }));
  }
  const f = await fixture(t), outside = join(f.base, 'private-source'); await mkdir(outside);
  for (const name of ['start.mjs', 'runtime.mjs']) await writeFile(join(outside, name), await readFile(join(f.applicationRoot, 'server', name)));
  await rm(join(f.applicationRoot, 'server'), { recursive: true }); await symlink(outside, join(f.applicationRoot, 'server'));
  await rejected(() => readRuntimeIdentity({ applicationRoot: f.applicationRoot }));
});

test('hardlinked source or identity files cannot attest mutable bytes shared elsewhere', async (t) => {
  for (const path of ['server/runtime.mjs', RUNTIME_IDENTITY_FILE]) {
    const f = await fixture(t); await link(join(f.applicationRoot, path), join(f.base, 'second-link'));
    await rejected(() => readRuntimeIdentity({ applicationRoot: f.applicationRoot }));
  }
});

test('undeclared source files and directories fail while explicit hosting installation entries stay outside the identity', async (t) => {
  const f = await fixture(t), before = await readRuntimeIdentity({ applicationRoot: f.applicationRoot });
  const dependencies = join(f.base, 'virtualenv-node-modules'); await mkdir(dependencies);
  await symlink(dependencies, join(f.applicationRoot, 'node_modules'));
  await mkdir(join(f.applicationRoot, 'tmp')); await writeFile(join(f.applicationRoot, 'tmp/restart.txt'), '');
  await writeFile(join(f.applicationRoot, '.npmrc'), 'ignore-scripts=true\nomit=dev\n');
  await writeFile(join(f.applicationRoot, 'stderr.log'), 'private-fixture-error');
  assert.deepEqual(await readRuntimeIdentity({ applicationRoot: f.applicationRoot }), before);
  await writeFile(join(f.applicationRoot, 'server/unreviewed.mjs'), 'export {};');
  await rejected(() => readRuntimeIdentity({ applicationRoot: f.applicationRoot }));
  await rm(join(f.applicationRoot, 'server/unreviewed.mjs')); await mkdir(join(f.applicationRoot, 'unexpected'));
  await rejected(() => readRuntimeIdentity({ applicationRoot: f.applicationRoot }));
});
