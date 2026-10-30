import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, lstat, rm, symlink, link, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CPANEL_MAINTENANCE_RULES, promoteCpanelRelease, rollbackCpanelRelease } from '../server/cpanel-release.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const sha = (letter) => letter.repeat(40);
const exists = async (path) => { try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
async function write(root, path, bytes, mode = 0o600) { await mkdir(dirname(join(root, path)), { recursive: true, mode: 0o700 }); await writeFile(join(root, path), bytes, { mode }); await chmod(join(root, path), mode); }
async function candidate(root, commit, extra = {}, changes = {}) {
  const files = {
    'public/index.html': `<html><head></head><body>${commit}</body></html>`,
    'public/admin/build.json': JSON.stringify({ sha: commit }),
    'public/style.css': `/* ${commit} */`,
    'public/.htaccess': '# Generated artifact rules are deliberately not installed\n',
    'app/server/start.mjs': '/* PRIVATE APP MUST NOT BE COPIED */',
    ...extra,
  };
  await mkdir(root, { mode: 0o700 });
  for (const [path, bytes] of Object.entries(files)) await write(root, path, bytes);
  const manifest = {
    format: 'heichal-cpanel-release', version: 1, commit, branch: 'claude/greeting-2i183o', siteOrigin: 'https://site.example', siteBase: '', staging: true,
    secretsIncluded: false, databaseIncluded: false, apacheBaselineSha256: digest(''),
    files: Object.entries(files).map(([path, bytes]) => ({ path, bytes: Buffer.byteLength(bytes), sha256: digest(bytes) })), ...changes,
  };
  await write(root, 'manifest.json', JSON.stringify(manifest));
  return manifest;
}
async function world(t, options = {}) {
  const base = await mkdtemp(join(tmpdir(), 'cpanel-release-test-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const documentRoot = join(base, 'public'), stateRoot = join(base, 'private-state'), candidateRoot = join(base, 'candidate');
  await mkdir(documentRoot, { mode: 0o755 }); await mkdir(stateRoot, { mode: 0o700 });
  const htaccess = `${CPANEL_MAINTENANCE_RULES}\n# Existing hosting directives\nHeader always set X-Robots-Tag "noindex, nofollow"\n`;
  await write(documentRoot, '.htaccess', htaccess, 0o644);
  await write(documentRoot, 'admin/.htaccess', 'Existing admin protection', 0o644);
  await write(documentRoot, 'admin/deployment.json', '{"status":"deploying"}', 0o644);
  await write(documentRoot, '.well-known/acme-challenge/token', 'host certificate challenge', 0o644);
  await write(documentRoot, 'cgi-bin/foreign.txt', 'host executable area', 0o644);
  await write(documentRoot, 'php.ini', 'host PHP configuration', 0o644);
  await write(documentRoot, '.user.ini', 'host user configuration', 0o644);
  await candidate(candidateRoot, sha('a'), options.files, options.manifest);
  return {
    base, htaccess, documentRoot, stateRoot, candidateRoot,
    options: { documentRoot, stateRoot, candidateRoot, expectedCommit: sha('a'), expectedSiteOrigin: 'https://site.example', approvedHostConfigSha256: digest(htaccess) },
  };
}

test('release dry-run fully validates without writing locks, maintenance or public files', async (t) => {
  const w = await world(t), result = await promoteCpanelRelease(w.options);
  assert.equal(result.dryRun, true); assert.equal(result.applied, false); assert.equal(result.changed, 3);
  assert.deepEqual(await readdir(w.stateRoot), []);
  assert.equal(await exists(join(w.documentRoot, 'index.html')), false);
  assert.equal(await exists(join(w.documentRoot, '.cpanel-maintenance')), false);
  assert.equal(await readFile(join(w.documentRoot, '.htaccess'), 'utf8'), w.htaccess);
});

test('promotion verifies the marker, serves complete files to its probe and preserves host paths', async (t) => {
  const w = await world(t); let probed = false;
  const result = await promoteCpanelRelease({ ...w.options, apply: true, async probe(value) {
    probed = true; assert.equal(value.commit, sha('a'));
    assert.equal(await exists(join(w.documentRoot, '.cpanel-maintenance')), false);
    assert.equal(JSON.parse(await readFile(join(w.documentRoot, 'admin/build.json'), 'utf8')).sha, sha('a'));
    assert.match(await readFile(join(w.documentRoot, 'style.css'), 'utf8'), /aaaaaaaa/);
    return true;
  } });
  assert.equal(probed, true); assert.equal(result.applied, true);
  assert.equal(await readFile(join(w.documentRoot, '.htaccess'), 'utf8'), w.htaccess);
  assert.equal(await readFile(join(w.documentRoot, 'admin/.htaccess'), 'utf8'), 'Existing admin protection');
  assert.equal(await readFile(join(w.documentRoot, 'admin/deployment.json'), 'utf8'), '{"status":"deploying"}');
  assert.equal(await readFile(join(w.documentRoot, '.well-known/acme-challenge/token'), 'utf8'), 'host certificate challenge');
  assert.equal(await exists(join(w.documentRoot, 'app')), false); assert.equal(await exists(join(w.documentRoot, 'server')), false);
  assert.equal((await lstat(join(w.documentRoot, 'index.html'))).mode & 0o777, 0o644);
  assert.equal(await exists(join(w.stateRoot, 'lock')), false); assert.equal(await exists(join(w.stateRoot, 'pending.json')), false);
  const state = JSON.parse(await readFile(join(w.stateRoot, 'current.json'), 'utf8'));
  assert.equal(state.releaseId, result.releaseId); assert.equal(state.files.length, 3);
});

test('initial existing files require adoption and rollback restores bytes and original permissions', async (t) => {
  const w = await world(t); await write(w.documentRoot, 'index.html', 'Original hosting home', 0o640);
  await assert.rejects(promoteCpanelRelease({ ...w.options, apply: true }), /baseline adoption/);
  assert.deepEqual(await readdir(w.stateRoot), []);
  const result = await promoteCpanelRelease({ ...w.options, apply: true, adoptExisting: true });
  const preview = await rollbackCpanelRelease({ ...w.options, releaseId: result.releaseId });
  assert.equal(preview.applied, false); assert.equal(preview.commit, null);
  await rollbackCpanelRelease({ ...w.options, releaseId: result.releaseId, apply: true });
  assert.equal(await readFile(join(w.documentRoot, 'index.html'), 'utf8'), 'Original hosting home');
  assert.equal((await lstat(join(w.documentRoot, 'index.html'))).mode & 0o777, 0o640);
  assert.equal(await exists(join(w.documentRoot, 'style.css')), false);
  assert.equal(await exists(join(w.documentRoot, 'admin/build.json')), false);
  assert.equal(await exists(join(w.stateRoot, 'current.json')), false);
  assert.equal(await readFile(join(w.documentRoot, 'admin/.htaccess'), 'utf8'), 'Existing admin protection');
});

test('subsequent release deletes only previously tracked files and rollback restores the prior release', async (t) => {
  const w = await world(t), first = await promoteCpanelRelease({ ...w.options, apply: true });
  await write(w.documentRoot, 'foreign-upload.txt', 'foreign persistent upload', 0o644);
  const nextRoot = join(w.base, 'next'); await candidate(nextRoot, sha('b'), { 'public/new.js': 'new code' });
  await rm(join(nextRoot, 'public/style.css'));
  const manifest = JSON.parse(await readFile(join(nextRoot, 'manifest.json'), 'utf8'));
  manifest.files = manifest.files.filter((entry) => entry.path !== 'public/style.css');
  await write(nextRoot, 'manifest.json', JSON.stringify(manifest));
  const second = await promoteCpanelRelease({ ...w.options, candidateRoot: nextRoot, expectedCommit: sha('b'), apply: true });
  assert.equal(second.removed, 1); assert.equal(await exists(join(w.documentRoot, 'style.css')), false);
  assert.equal(await readFile(join(w.documentRoot, 'foreign-upload.txt'), 'utf8'), 'foreign persistent upload');
  await assert.rejects(rollbackCpanelRelease({ ...w.options, releaseId: first.releaseId, apply: true }), /currently deployed/);
  await rollbackCpanelRelease({ ...w.options, releaseId: second.releaseId, apply: true });
  assert.equal(JSON.parse(await readFile(join(w.documentRoot, 'admin/build.json'), 'utf8')).sha, sha('a'));
  assert.match(await readFile(join(w.documentRoot, 'style.css'), 'utf8'), /aaaaaaaa/);
  assert.equal(await exists(join(w.documentRoot, 'new.js')), false);
  assert.equal(await readFile(join(w.documentRoot, 'foreign-upload.txt'), 'utf8'), 'foreign persistent upload');
});

for (const [name, change, pattern] of [
  ['changed bytes', async (w) => write(w.candidateRoot, 'public/index.html', 'tampered'), /checksum/],
  ['unlisted file', async (w) => write(w.candidateRoot, 'public/unlisted.txt', 'not in manifest'), /unlisted/],
  ['secret file', async (w) => write(w.candidateRoot, 'app/.env', 'fake secret'), /prohibited/],
  ['symbolic link', async (w) => { await rm(join(w.candidateRoot, 'public/index.html')); await symlink(join(w.documentRoot, '.htaccess'), join(w.candidateRoot, 'public/index.html')); }, /prohibited/],
  ['hard link', async (w) => { await rm(join(w.candidateRoot, 'public/index.html')); await link(join(w.documentRoot, '.htaccess'), join(w.candidateRoot, 'public/index.html')); }, /regular file/],
  ['target mismatch', async (w) => { w.options.expectedSiteOrigin = 'https://another.example'; }, /approved target/],
]) {
  test(`release rejects ${name} before public writes`, async (t) => {
    const w = await world(t); await change(w);
    await assert.rejects(promoteCpanelRelease({ ...w.options, apply: true }), pattern);
    assert.equal(await exists(join(w.documentRoot, 'index.html')), false);
    assert.deepEqual(await readdir(w.stateRoot), []);
  });
}

for (const path of ['admin/deployment.json', 'admin/.htaccess', '.well-known/hijack', 'cgi-bin/run.cgi', 'php.ini', '.user.ini', '.cpanel-maintenance', 'index.php']) {
  test(`artifact cannot replace protected host path ${path}`, async (t) => {
    const w = await world(t, { files: { [`public/${path}`]: 'hostile artifact content' } });
    await assert.rejects(promoteCpanelRelease({ ...w.options, apply: true }), /protected public path/);
    assert.deepEqual(await readdir(w.stateRoot), []);
  });
}

test('public symlink parents and Apache configuration drift stop promotion', async (t) => {
  const w = await world(t, { files: { 'public/photos/picture.txt': 'new bytes' } }), outside = join(w.base, 'outside');
  await mkdir(outside); await symlink(outside, join(w.documentRoot, 'photos'));
  await assert.rejects(promoteCpanelRelease({ ...w.options, apply: true }), /real directories/);
  assert.deepEqual(await readdir(outside), []);
  await rm(join(w.documentRoot, 'photos'));
  await write(w.documentRoot, '.htaccess', w.htaccess + '# changed\n');
  await assert.rejects(promoteCpanelRelease({ ...w.options, apply: true }), /Apache configuration/);
  await write(w.documentRoot, '.htaccess', '# no maintenance rules\n');
  await assert.rejects(promoteCpanelRelease({ ...w.options, approvedHostConfigSha256: digest('# no maintenance rules\n'), apply: true }), /maintenance rules/);
});

test('failed live probe automatically rolls back and clears maintenance only after restoration', async (t) => {
  const w = await world(t); await write(w.documentRoot, 'index.html', 'Baseline home', 0o644);
  await assert.rejects(promoteCpanelRelease({ ...w.options, apply: true, adoptExisting: true, probe: async () => false }), /probe failed/);
  assert.equal(await readFile(join(w.documentRoot, 'index.html'), 'utf8'), 'Baseline home');
  for (const path of ['.cpanel-maintenance', 'admin/build.json', 'style.css']) assert.equal(await exists(join(w.documentRoot, path)), false);
  for (const path of ['lock', 'pending.json', 'current.json']) assert.equal(await exists(join(w.stateRoot, path)), false);
});

test('rollback probe exception keeps maintenance and requires explicit recovery', async (t) => {
  const w = await world(t), result = await promoteCpanelRelease({ ...w.options, apply: true });
  await assert.rejects(rollbackCpanelRelease({ ...w.options, releaseId: result.releaseId, apply: true, probe: async () => { throw new Error('probe unavailable'); } }), /maintenance remains enabled/);
  assert.equal((await readFile(join(w.documentRoot, '.cpanel-maintenance'), 'utf8')).trim(), result.releaseId);
  await assert.rejects(promoteCpanelRelease({ ...w.options, apply: true }), /explicit recovery/);
  await rollbackCpanelRelease({ ...w.options, releaseId: result.releaseId, apply: true, recover: true });
  assert.equal(await exists(join(w.documentRoot, '.cpanel-maintenance')), false);
  assert.equal(await exists(join(w.stateRoot, 'lock')), false);
});

test('concurrent promotion and recovery cannot take a live release lock', async (t) => {
  const w = await world(t); let entered, release;
  const started = new Promise((resolve) => { entered = resolve; }), gate = new Promise((resolve) => { release = resolve; });
  const running = promoteCpanelRelease({ ...w.options, apply: true, probe: async () => { entered(); await gate; } });
  await started;
  try {
    await assert.rejects(promoteCpanelRelease({ ...w.options, apply: true }), /explicit recovery/);
    const unfinished = JSON.parse(await readFile(join(w.stateRoot, 'pending.json'), 'utf8'));
    await assert.rejects(rollbackCpanelRelease({ ...w.options, releaseId: unfinished.releaseId, recover: true, apply: true }), /recovered safely/);
  } finally { release(); await running; }
});

test('foreign edits during probe are preserved and leave recovery state instead of blind rollback', async (t) => {
  const w = await world(t); await write(w.documentRoot, 'index.html', 'Original', 0o644);
  await assert.rejects(promoteCpanelRelease({ ...w.options, apply: true, adoptExisting: true, probe: async () => { await write(w.documentRoot, 'index.html', 'Foreign new edit', 0o644); return false; } }), /explicit recovery/);
  assert.equal(await readFile(join(w.documentRoot, 'index.html'), 'utf8'), 'Foreign new edit');
  assert.equal(await exists(join(w.documentRoot, '.cpanel-maintenance')), true);
  const { releaseId } = JSON.parse(await readFile(join(w.stateRoot, 'pending.json'), 'utf8'));
  // An operator resolves the conflicting tracked file, then requests recovery.
  await write(w.documentRoot, 'index.html', 'Original', 0o644);
  await rollbackCpanelRelease({ ...w.options, releaseId, apply: true, recover: true });
  assert.equal(await readFile(join(w.documentRoot, 'index.html'), 'utf8'), 'Original');
});

test('a killed promotion leaves a durable journal and maintenance for explicit recovery', async (t) => {
  const w = await world(t), module = new URL('../server/cpanel-release.mjs', import.meta.url).href;
  const code = `import {watch} from 'node:fs'; import {promoteCpanelRelease} from ${JSON.stringify(module)}; const options=${JSON.stringify({ ...w.options, apply: true })}; const watcher=watch(options.documentRoot,(_kind,name)=>{if(name==='.cpanel-maintenance')process.kill(process.pid,'SIGKILL');}); await promoteCpanelRelease(options); watcher.close();`;
  await assert.rejects(promisify(execFile)(process.execPath, ['--input-type=module', '-e', code]), (error) => error.signal === 'SIGKILL');
  const { releaseId } = JSON.parse(await readFile(join(w.stateRoot, 'pending.json'), 'utf8'));
  assert.equal(await exists(join(w.documentRoot, '.cpanel-maintenance')), true);
  await assert.rejects(promoteCpanelRelease({ ...w.options, apply: true }), /explicit recovery/);
  await rollbackCpanelRelease({ ...w.options, releaseId, apply: true, recover: true });
  assert.equal(await exists(join(w.documentRoot, '.cpanel-maintenance')), false);
  assert.equal(await exists(join(w.stateRoot, 'lock')), false);
  assert.equal(await exists(join(w.documentRoot, 'index.html')), false);
});

test('corrupt backups and traversal in a journal are rejected before rollback changes files', async (t) => {
  const w = await world(t); await write(w.documentRoot, 'index.html', 'Original', 0o644);
  const result = await promoteCpanelRelease({ ...w.options, apply: true, adoptExisting: true });
  const journalPath = `releases/${result.releaseId}/journal.json`, original = await readFile(join(w.stateRoot, journalPath), 'utf8');
  const journal = JSON.parse(original), index = journal.operations.findIndex((op) => op.before);
  await write(w.stateRoot, `releases/${result.releaseId}/backup/${index}`, 'corrupt backup');
  await assert.rejects(rollbackCpanelRelease({ ...w.options, releaseId: result.releaseId, apply: true }), /backup checksum/);
  journal.operations[0].path = '../foreign.txt'; await write(w.stateRoot, journalPath, JSON.stringify(journal));
  await assert.rejects(rollbackCpanelRelease({ ...w.options, releaseId: result.releaseId, apply: true }), /journal checksum/);
  assert.match(await readFile(join(w.documentRoot, 'index.html'), 'utf8'), /aaaaaaaa/);
  assert.equal(await exists(join(w.documentRoot, '.cpanel-maintenance')), false);
});
