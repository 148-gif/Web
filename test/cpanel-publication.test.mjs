import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, symlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { publicationConfiguration, readPublicationConfiguration, runtimeManifestSha256, runCpanelPublication, rollbackCpanelPublication, writePublicationStatus } from '../server/cpanel-publication.mjs';
import { CPANEL_MAINTENANCE_RULES } from '../server/cpanel-release.mjs';
import { publicationCli } from '../scripts/publish-cpanel.mjs';

const commit = 'a'.repeat(40), other = 'b'.repeat(40);
const manifest = { files: [{ path: 'app/server/start.mjs', bytes: 3, sha256: 'c'.repeat(64) }] };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cpanel-job-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const documentRoot = join(root, 'public'), stateRoot = join(root, 'private-state'), token = join(root, 'token');
  await mkdir(join(documentRoot, 'admin'), { recursive: true }); await mkdir(stateRoot, { mode: 0o700 });
  await writeFile(token, 'synthetic-test-token', { mode: 0o600 });
  const config = { version: 1, enabled: true, repo: '148-gif/Web', branch: 'claude/greeting-2i183o', siteOrigin: 'https://preview.example', documentRoot, stateRoot, githubTokenFile: token, approvedHostConfigSha256: 'd'.repeat(64), approvedRuntimeManifestSha256: runtimeManifestSha256(manifest), probePaths: ['/', '/style.css'] };
  const calls = [], release = { state: 'ready', commit, runId: 1, artifact: { digest: 'sha256:' + 'e'.repeat(64) } };
  const dependencies = {
    inspect: async () => release,
    download: async ({ destination, token: supplied }) => {
      assert.equal(supplied, 'synthetic-test-token'); calls.push('download');
      await mkdir(destination, { mode: 0o700 }); await writeFile(join(destination, 'manifest.json'), JSON.stringify(manifest));
      return { candidateRoot: destination, commit };
    },
    promote: async (options) => { calls.push(options.apply ? 'apply' : 'plan'); if (options.apply) await options.probe(); return { releaseId: 'release-test' }; },
    probe: async (_config, sha) => { calls.push('probe'); assert.equal(sha, commit); },
    status: async (_root, state, sha) => { calls.push(state); assert.equal(sha, commit); },
  };
  return { root, config, calls, dependencies, release };
}

test('dry-run validates candidate and reports runtime hash without public writes or promotion', async (t) => {
  const f = await fixture(t);
  const result = await runCpanelPublication({ config: f.config, dependencies: f.dependencies });
  assert.equal(result.state, 'dry-run'); assert.equal(result.runtimeMatches, true);
  assert.deepEqual(f.calls, ['download', 'plan']);
  await assert.rejects(access(join(f.config.documentRoot, 'admin/deployment.json')));
  await assert.rejects(access(join(f.config.stateRoot, 'publication.json')));
});

test('successful apply rechecks source before promotion and probes before reporting live', async (t) => {
  const f = await fixture(t); let inspections = 0;
  f.dependencies.inspect = async () => { inspections++; return f.release; };
  const result = await runCpanelPublication({ config: f.config, apply: true, dependencies: f.dependencies });
  assert.equal(result.state, 'live'); assert.equal(inspections, 2);
  assert.deepEqual(f.calls, ['staging', 'download', 'deploying', 'apply', 'probe', 'live']);
  const saved = JSON.parse(await readFile(join(f.config.stateRoot, 'publication.json')));
  assert.equal(saved.commit, commit); assert.equal(saved.state, 'live');
});

test('source advance between download and promotion never applies the stale artifact', async (t) => {
  const f = await fixture(t); let inspections = 0;
  f.dependencies.inspect = async () => ++inspections === 1 ? f.release : { ...f.release, commit: other };
  const result = await runCpanelPublication({ config: f.config, apply: true, dependencies: f.dependencies });
  assert.equal(result.state, 'superseded'); assert.deepEqual(f.calls, ['staging', 'download']);
});

test('runtime changes block static promotion and require an explicit retry', async (t) => {
  const f = await fixture(t); f.config.approvedRuntimeManifestSha256 = 'f'.repeat(64);
  await assert.rejects(runCpanelPublication({ config: f.config, apply: true, dependencies: f.dependencies }), /publication failed/);
  assert.ok(!f.calls.includes('apply')); assert.equal(f.calls.at(-1), 'failed');
  f.calls.length = 0;
  const retry = await runCpanelPublication({ config: f.config, apply: true, dependencies: f.dependencies });
  assert.equal(retry.state, 'blocked'); assert.deepEqual(f.calls, []);
});

test('failed probe never writes live status, and errors never reveal credentials', async (t) => {
  const f = await fixture(t);
  f.dependencies.probe = async () => { throw new Error('synthetic-test-token private error'); };
  await assert.rejects(runCpanelPublication({ config: f.config, apply: true, dependencies: f.dependencies }), (error) => !error.message.includes('synthetic-test-token') && /publication failed/.test(error.message));
  assert.ok(!f.calls.includes('live')); assert.equal(f.calls.at(-1), 'failed');
});

test('concurrent Cron invocation cannot download or disturb existing lock', async (t) => {
  const f = await fixture(t); const lock = join(f.config.stateRoot, 'runner.lock'); await mkdir(lock, { mode: 0o700 });
  await writeFile(join(lock, 'sentinel'), 'keep');
  await assert.rejects(runCpanelPublication({ config: f.config, apply: true, dependencies: f.dependencies }));
  assert.deepEqual(f.calls, []); assert.equal(await readFile(join(lock, 'sentinel'), 'utf8'), 'keep');
});

test('unchanged shortcut requires the live marker and public status to agree', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.config.stateRoot, 'publication.json'), JSON.stringify({ state: 'live', commit }));
  await writeFile(join(f.config.documentRoot, 'admin/build.json'), JSON.stringify({ sha: commit }));
  await writePublicationStatus(f.config.documentRoot, 'live', commit);
  assert.equal((await runCpanelPublication({ config: f.config, apply: true, dependencies: f.dependencies })).state, 'unchanged');
  assert.deepEqual(f.calls, []);
  await writeFile(join(f.config.documentRoot, 'admin/build.json'), JSON.stringify({ sha: other }));
  await assert.rejects(runCpanelPublication({ config: f.config, apply: true, dependencies: f.dependencies }));
});

test('private configuration and token permissions, path separation and enabled flag fail closed', async (t) => {
  const f = await fixture(t); const file = join(f.root, 'config.json');
  await writeFile(file, JSON.stringify(f.config), { mode: 0o600 });
  assert.deepEqual(await readPublicationConfiguration(file), f.config);
  await chmod(file, 0o644); await assert.rejects(readPublicationConfiguration(file));
  assert.throws(() => publicationConfiguration({ ...f.config, stateRoot: join(f.config.documentRoot, 'state') }));
  assert.throws(() => publicationConfiguration({ ...f.config, arbitrarySecret: 'not allowed' }));
  await assert.rejects(runCpanelPublication({ config: { ...f.config, enabled: false }, apply: true, dependencies: f.dependencies }));
  await chmod(f.config.githubTokenFile, 0o644);
  await assert.rejects(runCpanelPublication({ config: f.config, dependencies: f.dependencies }));
  assert.deepEqual(f.calls, []);
});

test('public status is bounded and sanitized and refuses a symlinked admin directory', async (t) => {
  const f = await fixture(t);
  await writePublicationStatus(f.config.documentRoot, 'deploying', commit, other);
  const status = JSON.parse(await readFile(join(f.config.documentRoot, 'admin/deployment.json')));
  assert.deepEqual(Object.keys(status).sort(), ['version', 'target', 'state', 'commit', 'previousCommit', 'updatedAt'].sort());
  await rm(join(f.config.documentRoot, 'admin'), { recursive: true });
  const external = join(f.root, 'external'); await mkdir(external); await symlink(external, join(f.config.documentRoot, 'admin'));
  await assert.rejects(writePublicationStatus(f.config.documentRoot, 'live', commit));
});

test('runtime baseline digest is stable across order and rejects duplicate paths', () => {
  const second = { path: 'app/package.json', bytes: 1, sha256: 'e'.repeat(64) };
  assert.equal(runtimeManifestSha256({ files: [...manifest.files, second] }), runtimeManifestSha256({ files: [second, ...manifest.files] }));
  assert.throws(() => runtimeManifestSha256({ files: [...manifest.files, ...manifest.files] }));
});

test('CLI rejects conflicting or unsupported switches before reading configuration', async () => {
  await assert.rejects(publicationCli(['--config', '/private/config', '--apply', '--dry-run']));
  await assert.rejects(publicationCli(['--config', '/private/config', '--recover']));
  await assert.rejects(publicationCli(['--config', '/private/config', '--rollback', 'r', '--adopt-existing']));
});

test('real promoter integrates with private download, status, marker and rollback', async (t) => {
  const f = await fixture(t), digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const htaccess = CPANEL_MAINTENANCE_RULES + '\nHeader always set X-Robots-Tag "noindex, nofollow"\n';
  await writeFile(join(f.config.documentRoot, '.htaccess'), htaccess);
  await writeFile(join(f.config.documentRoot, 'index.html'), 'previous page');
  await writeFile(join(f.config.documentRoot, 'admin/build.json'), JSON.stringify({ sha: other }));
  f.config.approvedHostConfigSha256 = digest(htaccess);
  const files = { 'public/index.html': 'new page', 'public/admin/build.json': JSON.stringify({ sha: commit }), 'public/style.css': 'body{}', 'public/.htaccess': '# artifact only', 'app/server/start.mjs': 'app' };
  const fullManifest = { format: 'heichal-cpanel-release', version: 1, commit, branch: f.config.branch, siteOrigin: f.config.siteOrigin, siteBase: '', staging: true, databaseIncluded: false, secretsIncluded: false, apacheBaselineSha256: digest(''), files: Object.entries(files).map(([path, value]) => ({ path, bytes: Buffer.byteLength(value), sha256: digest(value) })) };
  f.config.approvedRuntimeManifestSha256 = runtimeManifestSha256(fullManifest);
  f.dependencies.download = async ({ destination }) => {
    await mkdir(destination, { mode: 0o700 });
    for (const [path, value] of Object.entries(files)) { await mkdir(dirname(join(destination, path)), { recursive: true, mode: 0o700 }); await writeFile(join(destination, path), value, { mode: 0o600 }); }
    await writeFile(join(destination, 'manifest.json'), JSON.stringify(fullManifest), { mode: 0o600 });
    return { candidateRoot: destination, commit };
  };
  delete f.dependencies.promote; delete f.dependencies.status;
  const dry = await runCpanelPublication({ config: f.config, adoptExisting: true, dependencies: f.dependencies });
  assert.equal(dry.state, 'dry-run'); assert.equal(await readFile(join(f.config.documentRoot, 'index.html'), 'utf8'), 'previous page');
  const result = await runCpanelPublication({ config: f.config, apply: true, adoptExisting: true, dependencies: f.dependencies });
  assert.equal(result.state, 'live');
  assert.equal(await readFile(join(f.config.documentRoot, '.htaccess'), 'utf8'), htaccess);
  assert.equal(await readFile(join(f.config.documentRoot, 'index.html'), 'utf8'), 'new page');
  assert.equal(JSON.parse(await readFile(join(f.config.documentRoot, 'admin/deployment.json'))).commit, commit);
  await assert.rejects(access(join(f.config.documentRoot, '.cpanel-maintenance')));
  await rollbackCpanelPublication({ config: f.config, releaseId: result.releaseId, apply: true, dependencies: { probe: async (_config, restored) => assert.equal(restored, other) } });
  assert.equal(await readFile(join(f.config.documentRoot, 'index.html'), 'utf8'), 'previous page');
  const state = JSON.parse(await readFile(join(f.config.stateRoot, 'publication.json')));
  assert.equal(state.commit, other); assert.equal(state.blockedCommit, commit);
  assert.equal((await runCpanelPublication({ config: f.config, apply: true, dependencies: f.dependencies })).state, 'blocked');
});

test('recovery blocks the failed journal commit even when its marker was already restored', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.config.documentRoot, 'admin/build.json'), JSON.stringify({ sha: other }));
  await rollbackCpanelPublication({ config: f.config, releaseId: 'test', apply: true, recover: true, dependencies: { rollback: async () => ({ previousCommit: commit }), status: async () => {} } });
  const saved = JSON.parse(await readFile(join(f.config.stateRoot, 'publication.json')));
  assert.equal(saved.commit, other); assert.equal(saved.blockedCommit, commit);
});

test('candidate cleanup failure cannot strand the Cron runner lock', async (t) => {
  const f = await fixture(t);
  f.dependencies.removeCandidate = async (path) => { await rm(path, { recursive: true, force: true }); throw new Error('cleanup failure'); };
  await assert.rejects(runCpanelPublication({ config: f.config, apply: true, dependencies: f.dependencies }), /cleanup failure/);
  await assert.rejects(access(join(f.config.stateRoot, 'runner.lock')));
});
