// Pull a reviewed Actions artifact into a new private candidate directory.
// This module never changes the live site, runs package scripts, or logs secrets.
import { createHash } from 'node:crypto';
import { mkdir, realpath, stat, open, rm, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, basename, resolve, join, isAbsolute } from 'node:path';
import { inflateRawSync, crc32 } from 'node:zlib';

const REPO = '148-gif/Web';
// Verified from the repository metadata; a reused owner/name must not silently
// point the deployment process at a different repository identity.
const REPOSITORY_ID = 1434346789;
const WORKFLOW = '.github/workflows/cpanel-release.yml';
const API = 'https://api.github.com';
const MAX_METADATA = 2 * 1024 * 1024;
const MAX_ARCHIVE = 512 * 1024 * 1024;
const MAX_EXPANDED = 1024 * 1024 * 1024;
const MAX_FILE = 128 * 1024 * 1024;
const MAX_ENTRIES = 20000;
const SHA = /^[0-9a-f]{40}$/;
const HASH = /^sha256:[0-9a-f]{64}$/;
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const fail = (code) => { throw new GithubReleaseError(code); };

export class GithubReleaseError extends Error {
  constructor(code) { super(`GitHub release rejected: ${code}`); this.name = 'GithubReleaseError'; this.code = code; }
}

function configuration(repo, branch, token, fetchImpl) {
  if (repo !== REPO || typeof branch !== 'string' || !branch || branch.length > 255 || /\s/.test(branch) || ['\\', '?', '*', '[', ']', '~', '^', ':', '@'].some((part) => branch.includes(part)) || branch.includes('..') || branch.includes('//') || branch.startsWith('/') || branch.endsWith('/')) fail('configuration');
  if (typeof token !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(token) || typeof fetchImpl !== 'function') fail('configuration');
}

function scopedSignal(signal, milliseconds) {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(milliseconds)]) : AbortSignal.timeout(milliseconds);
}

function apiHeaders(token) {
  return { Accept: 'application/vnd.github+json', 'Accept-Encoding': 'identity', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' };
}

function cancelBody(response) {
  // Cancellation must not extend a response deadline if an injected stream's
  // underlying cancel callback never settles.
  try { void response.body?.cancel().catch(() => {}); } catch { /* Already closed or locked. */ }
}

async function fetchBounded(url, options, fetchImpl) {
  const signal = options.signal;
  if (signal.aborted) fail('request-aborted');
  let rejectAbort;
  const cancelled = new Promise((_resolve, reject) => { rejectAbort = reject; });
  const abort = () => rejectAbort(new GithubReleaseError('request-aborted'));
  signal.addEventListener('abort', abort, { once: true });
  const pending = Promise.resolve().then(() => fetchImpl(url, options));
  // If a custom transport ignores cancellation and returns later, do not retain
  // or consume its response after the request deadline.
  void pending.then((response) => { if (signal.aborted) cancelBody(response); }, () => {});
  try { return await Promise.race([pending, cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}

async function responseBytes(response, maximum, signal) {
  const length = response.headers.get('content-length');
  const encoded = ![null, '', 'identity'].includes(response.headers.get('content-encoding'));
  if (length !== null && (!/^(?:0|[1-9][0-9]*)$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > maximum)) {
    cancelBody(response); fail('response-size');
  }
  if (!response.body) { if (Number(length || 0)) fail('response-size'); return Buffer.alloc(0); }
  const reader = response.body.getReader(), chunks = [];
  let size = 0, completed = false, abortReject;
  const aborted = new Promise((_resolve, reject) => { abortReject = reject; });
  const abort = () => { abortReject(new GithubReleaseError('request-aborted')); void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) fail('request-aborted');
    while (true) {
      const part = await Promise.race([reader.read(), aborted]);
      if (signal.aborted) fail('request-aborted');
      if (part.done) break;
      if (!(part.value instanceof Uint8Array) || part.value.byteLength > maximum - size) fail('response-size');
      size += part.value.byteLength; chunks.push(Buffer.from(part.value));
    }
    // Native fetch decodes content encodings but retains the wire Content-Length.
    // The actual decoded stream is always bounded above, independently of it.
    if (!encoded && length !== null && size !== Number(length)) fail('response-size');
    completed = true;
    return Buffer.concat(chunks, size);
  } finally {
    signal.removeEventListener('abort', abort);
    if (!completed) void reader.cancel().catch(() => {});
    try { reader.releaseLock(); } catch { /* Pending cancellation releases the reader. */ }
  }
}

async function apiJson(path, token, fetchImpl, signal, { missing = false } = {}) {
  let response;
  try { response = await fetchBounded(API + path, { method: 'GET', headers: apiHeaders(token), redirect: 'manual', signal }, fetchImpl); }
  catch { fail(signal.aborted ? 'request-aborted' : 'github-unavailable'); }
  if (response.redirected) { cancelBody(response); fail('unexpected-api-redirect'); }
  if (missing && response.status === 404) { cancelBody(response); return null; }
  if (response.status !== 200) {
    cancelBody(response);
    fail([401, 403].includes(response.status) ? 'github-access-denied' : response.status === 429 ? 'github-rate-limited' : 'github-unavailable');
  }
  const bytes = await responseBytes(response, MAX_METADATA, signal);
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { fail('invalid-provider-response'); }
}

function sameRepository(repository) {
  return repository?.id === REPOSITORY_ID && repository.full_name === REPO;
}

function matchesRun(run, branch, commit, workflowId) {
  return positive(run?.id) && (run.run_attempt === undefined || positive(run.run_attempt)) && run.workflow_id === workflowId && run.path === WORKFLOW &&
    run.head_sha === commit && run.head_branch === branch && ['push', 'workflow_dispatch'].includes(run.event) &&
    sameRepository(run.repository) && sameRepository(run.head_repository) && (!run.head_commit || run.head_commit.id === commit);
}

function artifactMetadata(artifact, run, branch, commit) {
  if (!positive(artifact?.id) || artifact.name !== `cpanel-${commit}` || artifact.expired !== false ||
      !positive(artifact.size_in_bytes) || artifact.size_in_bytes > MAX_ARCHIVE || !HASH.test(artifact.digest || '')) fail('invalid-artifact');
  const lineage = artifact.workflow_run;
  if (lineage && (lineage.id !== run.id || lineage.head_sha !== commit || lineage.head_branch !== branch || lineage.repository_id !== REPOSITORY_ID || lineage.head_repository_id !== REPOSITORY_ID)) fail('artifact-lineage');
  return Object.freeze({ id: artifact.id, name: artifact.name, size: artifact.size_in_bytes, digest: artifact.digest, runId: run.id });
}

export async function inspectGithubRelease({ repo = REPO, branch, token, fetchImpl = fetch, signal } = {}) {
  let commit = null, runId = null, configured = false;
  try {
    configuration(repo, branch, token, fetchImpl);
    configured = true;
    const bounded = scopedSignal(signal, 30000), prefix = `/repos/${REPO}`;
    const repository = await apiJson(prefix, token, fetchImpl, bounded);
    if (!sameRepository(repository) || repository.default_branch !== branch || repository.archived === true) fail('repository-mismatch');
    const head = await apiJson(`${prefix}/git/ref/heads/${encodeURIComponent(branch)}`, token, fetchImpl, bounded);
    if (head.ref !== `refs/heads/${branch}` || head.object?.type !== 'commit' || !SHA.test(head.object.sha || '')) fail('invalid-head');
    commit = head.object.sha;
    const workflow = await apiJson(`${prefix}/actions/workflows/cpanel-release.yml`, token, fetchImpl, bounded, { missing: true });
    if (!workflow) return Object.freeze({ state: 'waiting', repo, branch, commit, reason: 'workflow-unavailable' });
    if (!positive(workflow.id) || workflow.path !== WORKFLOW || workflow.state !== 'active') fail('workflow-mismatch');
    const runs = await apiJson(`${prefix}/actions/workflows/cpanel-release.yml/runs?branch=${encodeURIComponent(branch)}&head_sha=${commit}&per_page=100`, token, fetchImpl, bounded);
    if (!Array.isArray(runs.workflow_runs) || !Number.isSafeInteger(runs.total_count) || runs.total_count < 0 || runs.total_count > 100 || runs.workflow_runs.length !== runs.total_count) fail('run-list-incomplete');
    // Ignore untrusted event types, forks, and different heads even if a provider
    // filter returned them. Never fall back to a successful older commit.
    const relevant = runs.workflow_runs.filter((run) => matchesRun(run, branch, commit, workflow.id))
      .sort((a, b) => b.id - a.id || (b.run_attempt || 1) - (a.run_attempt || 1));
    const run = relevant[0];
    if (!run || run.status !== 'completed') return Object.freeze({ state: 'waiting', repo, branch, commit, reason: 'run-pending' });
    if (run.conclusion !== 'success') return Object.freeze({ state: 'failed', repo, branch, commit, runId: run.id, reason: 'workflow-failed' });
    runId = run.id;
    const listed = await apiJson(`${prefix}/actions/runs/${runId}/artifacts?per_page=100`, token, fetchImpl, bounded);
    if (!Array.isArray(listed.artifacts) || !Number.isSafeInteger(listed.total_count) || listed.total_count < 0 || listed.total_count > 100 || listed.artifacts.length !== listed.total_count) fail('artifact-list-incomplete');
    const candidates = listed.artifacts.filter((artifact) => artifact.name === `cpanel-${commit}` && artifact.expired === false);
    if (!candidates.length) return Object.freeze({ state: 'waiting', repo, branch, commit, runId, reason: 'artifact-pending' });
    if (candidates.length !== 1) fail('ambiguous-artifact');
    const artifact = artifactMetadata(candidates[0], run, branch, commit);
    return Object.freeze({ state: 'ready', repo, branch, commit, runId, artifact });
  } catch (error) {
    return Object.freeze({ state: 'failed', repo: REPO, ...(configured ? { branch } : {}), commit, runId,
      reason: error instanceof GithubReleaseError ? error.code : 'invalid-provider-response' });
  }
}

function downloadUrl(value, initial) {
  let url;
  try { url = new URL(value); } catch { fail('download-redirect'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port) fail('download-redirect');
  // GitHub currently redirects Actions archives to signed Azure Blob or
  // githubusercontent URLs. Do not accept arbitrary redirects or CDN domains.
  // Official runner-network reference lists results-receiver.actions.
  // githubusercontent.com and *.blob.core.windows.net for artifact transfer:
  // https://docs.github.com/en/actions/reference/runners/self-hosted-runners
  const officialBlob = url.hostname.endsWith('.blob.core.windows.net') || url.hostname.endsWith('.githubusercontent.com');
  if (url.origin === API ? url.pathname !== initial.pathname || url.search !== initial.search : !officialBlob) fail('download-redirect');
  return url;
}

async function downloadArchive(artifact, token, fetchImpl, signal) {
  const initial = new URL(`${API}/repos/${REPO}/actions/artifacts/${artifact.id}/zip`);
  let url = initial;
  for (let hop = 0; hop <= 3; hop++) {
    let response;
    try { response = await fetchBounded(url.href, { method: 'GET', redirect: 'manual', signal,
      headers: url.origin === API ? apiHeaders(token) : { Accept: 'application/octet-stream', 'Accept-Encoding': 'identity' } }, fetchImpl); }
    catch { fail(signal.aborted ? 'request-aborted' : 'github-unavailable'); }
    if (response.redirected) { cancelBody(response); fail('unexpected-download-redirect'); }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location'); cancelBody(response);
      if (!location || hop === 3) fail('download-redirect');
      let destination;
      try { destination = new URL(location, url).href; } catch { fail('download-redirect'); }
      url = downloadUrl(destination, initial); continue;
    }
    if (response.status !== 200) { cancelBody(response); fail('download-unavailable'); }
    const bytes = await responseBytes(response, Math.min(artifact.size, MAX_ARCHIVE), signal);
    if (bytes.length !== artifact.size || `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== artifact.digest) fail('archive-digest');
    return bytes;
  }
  fail('download-redirect');
}

function extraFields(bytes) {
  for (let position = 0; position < bytes.length;) {
    if (position + 4 > bytes.length) fail('zip-extra');
    const kind = bytes.readUInt16LE(position), size = bytes.readUInt16LE(position + 2); position += 4;
    if (position + size > bytes.length || [0x0001, 0x0017, 0x0019, 0x9901, 0x7075].includes(kind)) fail('zip-extra');
    position += size;
  }
}

function archiveEntries(bytes) {
  let end = -1;
  for (let position = bytes.length - 22; position >= Math.max(0, bytes.length - 65557); position--) {
    if (bytes.readUInt32LE(position) === 0x06054b50 && position + 22 + bytes.readUInt16LE(position + 20) === bytes.length) { end = position; break; }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0) fail('zip-directory');
  const count = bytes.readUInt16LE(end + 10), directorySize = bytes.readUInt32LE(end + 12), directoryOffset = bytes.readUInt32LE(end + 16);
  if (!count || count > MAX_ENTRIES || count !== bytes.readUInt16LE(end + 8) || directoryOffset + directorySize !== end) fail('zip-directory');
  const entries = [], paths = new Map(), explicit = new Set();
  let cursor = directoryOffset, expanded = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) fail('zip-directory');
    const needed = bytes.readUInt16LE(cursor + 6), flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10);
    const crc = bytes.readUInt32LE(cursor + 16), compressed = bytes.readUInt32LE(cursor + 20), size = bytes.readUInt32LE(cursor + 24);
    const nameSize = bytes.readUInt16LE(cursor + 28), extraSize = bytes.readUInt16LE(cursor + 30), commentSize = bytes.readUInt16LE(cursor + 32);
    const disk = bytes.readUInt16LE(cursor + 34), attributes = bytes.readUInt32LE(cursor + 38), local = bytes.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameSize + extraSize + commentSize;
    if (next > end || !nameSize || needed > 20 || disk || ![0, 8].includes(method) || (flags & ~(method === 8 ? 0x080e : 0x0808)) || size > MAX_FILE || compressed > MAX_ARCHIVE) fail('zip-entry');
    const rawName = bytes.subarray(cursor + 46, cursor + 46 + nameSize);
    if (!(flags & 0x0800) && rawName.some((byte) => byte > 127)) fail('zip-encoding');
    let name;
    try { name = new TextDecoder('utf-8', { fatal: true }).decode(rawName); } catch { fail('zip-encoding'); }
    const directory = name.endsWith('/'); if (directory) name = name.slice(0, -1);
    // ASCII controls are deliberately rejected in archive paths.
    // eslint-disable-next-line no-control-regex
    if (!name || name.length > 2048 || /[\\:\x00-\x1f\x7f]/.test(name) || name.startsWith('/')) fail('zip-path');
    const parts = name.split('/');
    if (parts.some((part) => !part || part === '.' || part === '..' || part.startsWith('.')) && name !== 'public/.htaccess') fail('zip-path');
    if (!['app', 'public'].includes(parts[0]) && name !== 'manifest.json') fail('zip-layout');
    if ((name === 'manifest.json' && directory) || (parts.length === 1 && name !== 'manifest.json' && !directory)) fail('zip-layout');
    const mode = (attributes >>> 16) & 0xf000;
    if ((mode && mode !== (directory ? 0x4000 : 0x8000)) || (!directory && (attributes & 0x10)) || (directory && size)) fail('zip-file-type');
    for (let depth = 1; depth <= parts.length; depth++) {
      const path = parts.slice(0, depth).join('/'), folded = path.normalize('NFC').toLowerCase(), type = depth < parts.length || directory ? 'directory' : 'file';
      const prior = paths.get(folded);
      if (prior && (prior.path !== path || prior.type !== type)) fail('zip-path-collision');
      paths.set(folded, { path, type });
      if (depth === parts.length) { if (explicit.has(folded)) fail('zip-path-collision'); explicit.add(folded); }
    }
    extraFields(bytes.subarray(cursor + 46 + nameSize, cursor + 46 + nameSize + extraSize));
    if (local + 30 > directoryOffset || bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(local + 4) !== needed || bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method) fail('zip-local-header');
    const localNameSize = bytes.readUInt16LE(local + 26), localExtraSize = bytes.readUInt16LE(local + 28), dataStart = local + 30 + localNameSize + localExtraSize;
    if (dataStart > directoryOffset || localNameSize !== nameSize || !bytes.subarray(local + 30, local + 30 + localNameSize).equals(rawName)) fail('zip-local-header');
    extraFields(bytes.subarray(local + 30 + localNameSize, dataStart));
    let dataEnd = dataStart + compressed;
    if (dataEnd > directoryOffset) fail('zip-entry-size');
    const localValues = [bytes.readUInt32LE(local + 14), bytes.readUInt32LE(local + 18), bytes.readUInt32LE(local + 22)], expected = [crc, compressed, size];
    if (flags & 8) {
      if (localValues.some((value, i) => value !== 0 && value !== expected[i])) fail('zip-descriptor');
      const signed = dataEnd + 16 <= directoryOffset && bytes.readUInt32LE(dataEnd) === 0x08074b50 && expected.every((value, i) => bytes.readUInt32LE(dataEnd + 4 + i * 4) === value);
      const descriptor = signed ? dataEnd + 4 : dataEnd;
      if (descriptor + 12 > directoryOffset || expected.some((value, i) => bytes.readUInt32LE(descriptor + i * 4) !== value)) fail('zip-descriptor');
      dataEnd = descriptor + 12;
    } else if (localValues.some((value, i) => value !== expected[i])) fail('zip-entry-size');
    if (method === 0 && compressed !== size) fail('zip-entry-size');
    expanded += size; if (expanded > MAX_EXPANDED) fail('zip-expanded-size');
    entries.push({ name, directory, method, crc, size, compressed, local, dataStart, dataEnd }); cursor = next;
  }
  if (cursor !== end || !paths.has('manifest.json') || !paths.has('app') || !paths.has('public')) fail('zip-layout');
  let localEnd = 0;
  for (const entry of [...entries].sort((a, b) => a.local - b.local)) { if (entry.local !== localEnd) fail('zip-overlap'); localEnd = entry.dataEnd; }
  if (localEnd !== directoryOffset) fail('zip-overlap');
  if (entries.find((entry) => entry.name === 'manifest.json').size > MAX_METADATA) fail('manifest-size');
  return entries;
}

async function extractArchive(bytes, entries, destination, signal) {
  if (typeof destination !== 'string' || !isAbsolute(destination) || destination.includes('\0')) fail('destination');
  const requested = resolve(destination), parent = await realpath(dirname(requested));
  if (!(await stat(parent)).isDirectory() || requested === dirname(requested)) fail('destination');
  const root = join(parent, basename(requested));
  let created = false;
  try {
    await mkdir(root, { mode: 0o700 }); created = true;
    // Preserve the package's completion-marker convention even when ZIP entry
    // order places manifest.json before its referenced files.
    const ordered = [...entries.filter((entry) => entry.name !== 'manifest.json'), entries.find((entry) => entry.name === 'manifest.json')];
    for (const entry of ordered) {
      if (signal.aborted) fail('request-aborted');
      const path = join(root, entry.name);
      const compressed = bytes.subarray(entry.dataStart, entry.dataStart + entry.compressed);
      let data;
      if (entry.method === 0) data = compressed;
      else {
        let inflated;
        try { inflated = inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.size + 1), info: true }); }
        catch { fail('zip-compression'); }
        if (inflated.engine.bytesWritten !== entry.compressed) fail('zip-compression');
        data = inflated.buffer;
      }
      if (data.length !== entry.size || crc32(data) !== entry.crc) fail('zip-checksum');
      if (entry.directory) { await mkdir(path, { recursive: true, mode: 0o700 }); continue; }
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(data); } finally { await file.close(); }
    }
    return root;
  } catch (error) {
    if (created) await rm(root, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function downloadGithubRelease({ release, destination, token, fetchImpl = fetch, signal } = {}) {
  let root;
  try {
    configuration(release?.repo, release?.branch, token, fetchImpl);
    if (release.state !== 'ready' || !SHA.test(release.commit || '') || !positive(release.runId)) fail('release-metadata');
    const commit = release.commit, branch = release.branch;
    const artifact = artifactMetadata({ id: release.artifact?.id, name: release.artifact?.name, size_in_bytes: release.artifact?.size, digest: release.artifact?.digest, expired: false }, { id: release.runId }, branch, commit);
    if (release.artifact.runId !== release.runId) fail('release-metadata');
    const bounded = scopedSignal(signal, 300000), bytes = await downloadArchive(artifact, token, fetchImpl, bounded);
    const entries = archiveEntries(bytes);
    root = await extractArchive(bytes, entries, destination, bounded);
    let manifest;
    try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await readFile(join(root, 'manifest.json')))); }
    catch { fail('manifest-content'); }
    if (manifest?.format !== 'heichal-cpanel-release' || manifest.version !== 1 || manifest.commit !== commit || manifest.branch !== branch) fail('manifest-lineage');
    return { candidateRoot: root, commit };
  } catch (error) {
    if (root) await rm(root, { recursive: true, force: true }).catch(() => {});
    throw error instanceof GithubReleaseError ? error : new GithubReleaseError('release-download-failed');
  }
}
