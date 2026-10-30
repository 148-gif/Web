// Private Cron runner: fetch immutable build data, never execute downloaded code.
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, rm, lstat, realpath, readdir, statfs } from 'node:fs/promises';
import { hostname } from 'node:os';
import { isAbsolute, resolve, join, dirname, sep } from 'node:path';
import { inspectGithubRelease, downloadGithubRelease } from './github-release-source.mjs';
import { promoteCpanelRelease, rollbackCpanelRelease } from './cpanel-release.mjs';
import { inspectStaging } from './staging-smoke.mjs';

const sha = /^[a-f0-9]{40}$/, hash = /^[a-f0-9]{64}$/;
const inside = (a, b) => a === b || a.startsWith(b + sep);
const bad = () => { throw new Error('Invalid private publication configuration'); };
const configKeys = new Set(['version', 'enabled', 'repo', 'branch', 'siteOrigin', 'documentRoot', 'stateRoot', 'githubTokenFile', 'approvedHostConfigSha256', 'approvedRuntimeManifestSha256', 'probePaths']);

export function publicationConfiguration(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some((key) => !configKeys.has(key)) || value.version !== 1 || typeof value.enabled !== 'boolean') bad();
  if (value.repo !== '148-gif/Web' || value.branch !== 'claude/greeting-2i183o') bad();
  let site;
  try { site = new URL(value.siteOrigin); } catch { bad(); }
  if (site.origin !== value.siteOrigin || site.protocol !== 'https:' || site.username || site.password) bad();
  for (const name of ['documentRoot', 'stateRoot', 'githubTokenFile']) if (typeof value[name] !== 'string' || !isAbsolute(value[name]) || resolve(value[name]) !== value[name]) bad();
  if (inside(value.stateRoot, value.documentRoot) || inside(value.documentRoot, value.stateRoot) || inside(value.githubTokenFile, value.documentRoot) || inside(value.githubTokenFile, value.stateRoot)) bad();
  for (const name of ['approvedHostConfigSha256', 'approvedRuntimeManifestSha256']) if (value[name] !== null && !hash.test(value[name] || '')) bad();
  if (!Array.isArray(value.probePaths) || value.probePaths.length < 2 || value.probePaths.length > 16 || !value.probePaths.includes('/') || value.probePaths.some((path) => typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || /[\\?#\s]/.test(path) || path.split('/').includes('..'))) bad();
  return { ...value, probePaths: [...value.probePaths] };
}

async function canonical(path, directory, privateOnly = false) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1) || await realpath(path) !== path || (privateOnly && (info.mode & 0o077))) bad();
  return info;
}

export async function readPublicationConfiguration(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) bad();
  const info = await canonical(resolve(path), false, true);
  if (info.size > 32768) bad();
  const config = publicationConfiguration(JSON.parse(await readFile(path, 'utf8')));
  if (inside(resolve(path), config.documentRoot) || inside(resolve(path), config.stateRoot)) bad();
  return config;
}

export function runtimeManifestSha256(manifest) {
  if (!manifest || !Array.isArray(manifest.files)) throw new Error('Invalid release manifest');
  const files = manifest.files.filter((file) => typeof file.path === 'string' && file.path.startsWith('app/')).map(({ path, bytes, sha256 }) => {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || !hash.test(sha256) || !/^app\/[A-Za-z0-9_./-]+$/.test(path) || path.split('/').some((part) => !part || part === '..' || part === '.')) throw new Error('Invalid application manifest');
    return { path, bytes, sha256 };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (!files.length || new Set(files.map((file) => file.path)).size !== files.length) throw new Error('Invalid application manifest');
  return createHash('sha256').update(JSON.stringify(files)).digest('hex');
}

async function atomicJson(path, value, mode = 0o600) {
  const tmp = join(dirname(path), '.publication-' + randomUUID());
  try {
    await writeFile(tmp, JSON.stringify(value) + '\n', { flag: 'wx', mode });
    await rename(tmp, path);
  } finally { await rm(tmp, { force: true }); }
}

async function existingJson(path, maxBytes = 32768) {
  let info;
  try { info = await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) throw new Error('Invalid private publication state');
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function writePublicationStatus(documentRoot, state, commit, previousCommit) {
  if (!['waiting', 'building', 'staging', 'deploying', 'failed', 'live'].includes(state) || !sha.test(commit) || (previousCommit !== undefined && !sha.test(previousCommit))) throw new Error('Invalid public publication status');
  await canonical(documentRoot, true);
  const admin = join(documentRoot, 'admin');
  await canonical(admin, true);
  const statusPath = join(admin, 'deployment.json');
  await existingJson(statusPath);
  await atomicJson(statusPath, { version: 1, target: 'cpanel', state, commit, ...(previousCommit ? { previousCommit } : {}), updatedAt: new Date().toISOString() }, 0o644);
}

async function defaultProbe(config, commit) {
  const result = await inspectStaging({ origin: config.siteOrigin, paths: config.probePaths, checkRobots: true });
  if (!result.ok) throw new Error('Published site failed smoke checks');
  const response = await fetch(`${config.siteOrigin}/admin/build.json?t=${Date.now()}`, { redirect: 'error', signal: AbortSignal.timeout(15000), headers: { 'Cache-Control': 'no-cache' } });
  const noindex = response.headers.get('x-robots-tag') || '';
  if (!response.ok || !/\bnoindex\b/i.test(noindex) || !/\bnofollow\b/i.test(noindex)) throw new Error('Published marker unavailable');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Published marker unavailable');
  const chunks = []; let length = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      length += part.value.byteLength;
      if (length > 4096) throw new Error('Published marker is too large');
      chunks.push(Buffer.from(part.value));
    }
    const marker = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (marker.sha !== commit) throw new Error('Published marker does not match release');
  } finally { await reader.cancel().catch(() => {}); }
}

export async function runCpanelPublication({ config: input, apply = false, adoptExisting = false, retryFailed = false, dependencies = {} }) {
  const config = publicationConfiguration(input);
  if (apply && (!config.enabled || !config.approvedHostConfigSha256 || !config.approvedRuntimeManifestSha256)) throw new Error('Publication is disabled or its baselines have not been approved');
  await canonical(config.documentRoot, true);
  await canonical(config.stateRoot, true, true);
  const tokenInfo = await canonical(config.githubTokenFile, false, true);
  if (tokenInfo.size < 1 || tokenInfo.size > 4096) bad();
  const token = (await readFile(config.githubTokenFile, 'utf8')).trim();
  if (!token || /[^\x21-\x7e]/.test(token)) bad();
  const inspect = dependencies.inspect || inspectGithubRelease;
  const download = dependencies.download || downloadGithubRelease;
  const promote = dependencies.promote || promoteCpanelRelease;
  const probe = dependencies.probe || defaultProbe;
  const status = dependencies.status || writePublicationStatus;
  const lock = join(config.stateRoot, 'runner.lock');
  const lastPath = join(config.stateRoot, 'publication.json');
  let held = false, candidate, commit, previousCommit;
  try {
    if (apply) {
      await mkdir(lock, { mode: 0o700 }); held = true;
      await atomicJson(join(lock, 'owner.json'), { pid: process.pid, hostname: hostname(), startedAt: new Date().toISOString() });
    }
    const last = await existingJson(lastPath);
    if (last && (!['live', 'failed'].includes(last.state) || !sha.test(last.commit))) throw new Error('Invalid private publication state');
    if (last?.state === 'live') previousCommit = last.commit;
    const release = await inspect({ repo: config.repo, branch: config.branch, token });
    if (!release || !sha.test(release.commit) || !['ready', 'waiting', 'failed'].includes(release.state)) throw new Error('Invalid source release status');
    commit = release.commit;
    if (last?.state === 'live' && last.commit === commit) {
      const marker = await existingJson(join(config.documentRoot, 'admin/build.json'), 4096);
      const deployed = await existingJson(join(config.documentRoot, 'admin/deployment.json'), 2048);
      if (marker?.sha !== commit || deployed?.state !== 'live' || deployed?.commit !== commit) throw new Error('Live release state drifted; review before continuing');
      return { state: 'unchanged', commit, deploymentPerformed: false };
    }
    if (((last?.state === 'failed' && last.commit === commit) || last?.blockedCommit === commit) && !retryFailed) return { state: 'blocked', commit, reason: 'explicit-retry-required', deploymentPerformed: false };
    if (release.state !== 'ready') {
      if (apply) await status(config.documentRoot, release.state === 'failed' ? 'failed' : 'waiting', commit, previousCommit);
      return { state: release.state, commit, deploymentPerformed: false };
    }
    if (apply) {
      const releases = join(config.stateRoot, 'releases');
      try {
        await canonical(releases, true, true);
        if ((await readdir(releases)).length >= 5) throw new Error('Review and archive retained releases before another deployment');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const disk = await statfs(config.stateRoot, { bigint: true });
      // Host account quotas may be lower and must also be checked in cPanel.
      if (disk.bavail * disk.bsize < 2n * 1024n ** 3n) throw new Error('Insufficient free staging space');
    }
    if (apply) await status(config.documentRoot, 'staging', commit, previousCommit);
    // Candidate and journal trees must be separate: rollback must never depend
    // on the disposable download, and archive validation must not walk state.
    candidate = join(dirname(config.stateRoot), '.cpanel-candidate-' + commit + '-' + randomUUID());
    const downloaded = await download({ release, destination: candidate, token });
    if (downloaded.candidateRoot !== candidate || downloaded.commit !== commit) throw new Error('Downloaded release identity mismatch');
    const manifest = await existingJson(join(candidate, 'manifest.json'), 8 * 1024 * 1024);
    const runtimeHash = runtimeManifestSha256(manifest);
    if (!apply) {
      if (!config.approvedHostConfigSha256) {
        const hostFile = join(config.documentRoot, '.htaccess');
        const hostInfo = await canonical(hostFile, false);
        if (hostInfo.size > 1024 * 1024) throw new Error('Hosting configuration is too large');
        return { state: 'blocked', commit, reason: 'approve-host-configuration-before-full-dry-run', requiredHostConfigSha256: createHash('sha256').update(await readFile(hostFile)).digest('hex'), requiredRuntimeManifestSha256: runtimeHash, deploymentPerformed: false };
      }
      const plan = await promote({ candidateRoot: candidate, documentRoot: config.documentRoot, stateRoot: config.stateRoot, expectedCommit: commit, expectedBranch: config.branch, expectedSiteOrigin: config.siteOrigin, approvedHostConfigSha256: config.approvedHostConfigSha256, adoptExisting, apply: false });
      return { state: 'dry-run', commit, requiredRuntimeManifestSha256: runtimeHash, runtimeMatches: runtimeHash === config.approvedRuntimeManifestSha256, plan, deploymentPerformed: false };
    }
    if (runtimeHash !== config.approvedRuntimeManifestSha256) throw new Error('Application files changed; a separate reviewed runtime update is required');
    const fresh = await inspect({ repo: config.repo, branch: config.branch, token });
    if (fresh.state !== 'ready' || fresh.commit !== commit || fresh.runId !== release.runId || fresh.artifact?.digest !== release.artifact?.digest) return { state: 'superseded', commit, deploymentPerformed: false };
    await status(config.documentRoot, 'deploying', commit, previousCommit);
    const result = await promote({ candidateRoot: candidate, documentRoot: config.documentRoot, stateRoot: config.stateRoot, expectedCommit: commit, expectedBranch: config.branch, expectedSiteOrigin: config.siteOrigin, approvedHostConfigSha256: config.approvedHostConfigSha256, adoptExisting, apply: true, probe: () => probe(config, commit) });
    await status(config.documentRoot, 'live', commit, previousCommit);
    await atomicJson(lastPath, { state: 'live', commit, releaseId: result.releaseId, completedAt: new Date().toISOString() });
    return { state: 'live', commit, releaseId: result.releaseId, deploymentPerformed: true };
  } catch {
    if (held && commit) {
      await atomicJson(lastPath, { state: 'failed', commit, failedAt: new Date().toISOString() }).catch(() => {});
      await status(config.documentRoot, 'failed', commit, previousCommit).catch(() => {});
    }
    throw new Error('cPanel publication failed; review the private deployment state before retrying');
  } finally {
    try { if (candidate) await (dependencies.removeCandidate || rm)(candidate, { recursive: true, force: true }); }
    finally { if (held) await rm(lock, { recursive: true, force: true }); }
  }
}

// Recovery is an explicit one-off operation. An old lock is never discarded just
// because its timestamp looks stale; a live or foreign-host owner blocks it.
export async function rollbackCpanelPublication({ config: input, releaseId, apply = false, recover = false, dependencies = {} }) {
  const config = publicationConfiguration(input);
  await canonical(config.documentRoot, true);
  await canonical(config.stateRoot, true, true);
  if (apply && !config.enabled) throw new Error('Publication is disabled');
  const lock = join(config.stateRoot, 'runner.lock');
  let held = false;
  try {
    if (apply) {
      try { await mkdir(lock, { mode: 0o700 }); held = true; }
      catch (error) {
        if (error.code !== 'EEXIST' || !recover) throw error;
        await canonical(lock, true, true);
        const owner = await existingJson(join(lock, 'owner.json'));
        // eslint-disable-next-line preserve-caught-error -- Do not expose private filesystem errors through recovery errors.
        if (!owner || owner.hostname !== hostname() || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error('Runner lock requires manual investigation');
        let alive = true;
        try { process.kill(owner.pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
        // eslint-disable-next-line preserve-caught-error -- Recovery reports the lock condition without retaining filesystem details.
        if (alive) throw new Error('Runner lock owner is still active');
        await rm(lock, { recursive: true });
        await mkdir(lock, { mode: 0o700 }); held = true;
      }
      await atomicJson(join(lock, 'owner.json'), { pid: process.pid, hostname: hostname(), startedAt: new Date().toISOString() });
    }
    const result = await (dependencies.rollback || rollbackCpanelRelease)({ documentRoot: config.documentRoot, stateRoot: config.stateRoot, releaseId, apply, recover, probe: async () => {
      const restored = await existingJson(join(config.documentRoot, 'admin/build.json'), 4096);
      if (!sha.test(restored?.sha || '')) throw new Error('Restored release has no valid marker');
      await (dependencies.probe || defaultProbe)(config, restored.sha);
    } });
    if (apply) {
      const restored = await existingJson(join(config.documentRoot, 'admin/build.json'), 4096);
      if (!sha.test(restored?.sha || '') || !sha.test(result.previousCommit || '')) throw new Error('Restored release has no valid marker or journal identity');
      await (dependencies.status || writePublicationStatus)(config.documentRoot, 'live', restored.sha);
      await atomicJson(join(config.stateRoot, 'publication.json'), { state: 'live', commit: restored.sha, blockedCommit: result.previousCommit, rolledBackAt: new Date().toISOString() });
    }
    return result;
  } finally { if (held) await rm(lock, { recursive: true, force: true }); }
}
