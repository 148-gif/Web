import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateRawSync, crc32 } from 'node:zlib';
import { mkdtemp, rm, readFile, stat, readdir, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectGithubRelease, downloadGithubRelease, GithubReleaseError } from '../server/github-release-source.mjs';

const REPO = '148-gif/Web', BRANCH = 'claude/greeting-2i183o', COMMIT = 'a'.repeat(40), TOKEN = 'test-token-not-a-real-secret';
const repository = () => ({ id: 1434346789, full_name: REPO, default_branch: BRANCH });
const workflow = () => ({ id: 44, path: '.github/workflows/cpanel-release.yml', state: 'active' });
const run = (extra = {}) => ({ id: 55, workflow_id: 44, path: '.github/workflows/cpanel-release.yml', head_sha: COMMIT, head_branch: BRANCH,
  event: 'push', status: 'completed', conclusion: 'success', repository: repository(), head_repository: repository(), head_commit: { id: COMMIT }, ...extra });
const artifact = (extra = {}) => ({ id: 66, name: `cpanel-${COMMIT}`, size_in_bytes: 100, expired: false, digest: `sha256:${'b'.repeat(64)}`,
  workflow_run: { id: 55, repository_id: 1434346789, head_repository_id: 1434346789, head_branch: BRANCH, head_sha: COMMIT }, ...extra });
const json = (value, options) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' }, ...options });
function provider({ repo = repository(), head = COMMIT, workflowValue = workflow(), runs = [run()], artifacts = [artifact()], responses = {}, observe = () => {} } = {}) {
  return async (url, options) => {
    observe(url, options);
    assert.equal(new URL(url).origin, 'https://api.github.com');
    assert.equal(options.redirect, 'manual'); assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
    const path = new URL(url).pathname;
    if (responses[path]) return responses[path]();
    if (path === `/repos/${REPO}`) return json(repo);
    if (path.includes('/git/ref/')) return json({ ref: `refs/heads/${BRANCH}`, object: { type: 'commit', sha: head } });
    if (path.endsWith('/cpanel-release.yml')) return workflowValue ? json(workflowValue) : new Response(null, { status: 404 });
    if (path.endsWith('/runs')) return json({ total_count: runs.length, workflow_runs: runs });
    if (path.endsWith('/artifacts')) return json({ total_count: artifacts.length, artifacts });
    throw new Error('Unexpected test request');
  };
}
const inspect = (options = {}) => inspectGithubRelease({ repo: REPO, branch: BRANCH, token: TOKEN, fetchImpl: provider(), ...options });

test('selects only the newest successful release for the current default-branch head with complete lineage', async () => {
  const observed = [];
  const release = await inspect({ fetchImpl: provider({ runs: [run({ id: 54 }), run(), run({ id: 56, event: 'pull_request', status: 'in_progress', conclusion: null })],
    observe: (url) => observed.push(url) }) });
  assert.equal(release.state, 'ready'); assert.equal(release.commit, COMMIT); assert.equal(release.runId, 55);
  assert.equal(release.repo, REPO); assert.equal(release.branch, BRANCH); assert.equal(release.artifact.id, 66);
  assert.equal(Object.isFrozen(release), true); assert.equal(Object.isFrozen(release.artifact), true);
  const query = new URL(observed.find((url) => new URL(url).pathname.endsWith('/runs'))).searchParams;
  assert.equal(query.get('head_sha'), COMMIT); assert.equal(query.get('branch'), BRANCH);
});

test('does not use an older commit, PR event, fork, different workflow or branch when current head has no valid release', async () => {
  const invalid = [run({ head_sha: 'c'.repeat(40) }), run({ event: 'pull_request' }), run({ head_repository: { ...repository(), id: 999 } }),
    run({ repository: { ...repository(), full_name: 'other/repo' } }), run({ head_branch: 'other' }), run({ path: '.github/workflows/pages.yml' }), run({ workflow_id: 77 })];
  const release = await inspect({ fetchImpl: provider({ runs: invalid }) });
  assert.equal(release.state, 'waiting'); assert.equal(release.reason, 'run-pending'); assert.equal(release.commit, COMMIT);
  assert.equal((await inspect({ fetchImpl: provider({ repo: { ...repository(), default_branch: 'new-default' } }) })).reason, 'repository-mismatch');
});

test('distinguishes pending, failed and absent workflow or artifact without returning response text', async () => {
  assert.equal((await inspect({ fetchImpl: provider({ runs: [run({ status: 'queued', conclusion: null })] }) })).state, 'waiting');
  assert.equal((await inspect({ fetchImpl: provider({ runs: [run({ conclusion: 'failure' })] }) })).reason, 'workflow-failed');
  assert.equal((await inspect({ fetchImpl: provider({ workflowValue: null }) })).reason, 'workflow-unavailable');
  assert.equal((await inspect({ fetchImpl: provider({ artifacts: [artifact({ expired: true })] }) })).reason, 'artifact-pending');
  const result = await inspect({ fetchImpl: async () => new Response('private failure body', { status: 403 }) });
  assert.equal(result.reason, 'github-access-denied'); assert.equal(JSON.stringify(result).includes('private failure body'), false);
});

test('newer pending or failed runs and reruns block older successful artifacts for the same commit', async () => {
  const newer = await inspect({ fetchImpl: provider({ runs: [run(), run({ id: 56, status: 'queued', conclusion: null })] }) });
  assert.equal(newer.state, 'waiting'); assert.equal(newer.reason, 'run-pending');
  const failed = await inspect({ fetchImpl: provider({ runs: [run(), run({ id: 56, conclusion: 'failure' })] }) });
  assert.equal(failed.state, 'failed'); assert.equal(failed.runId, 56);
  const rerun = await inspect({ fetchImpl: provider({ runs: [run({ run_attempt: 1 }), run({ run_attempt: 2, status: 'in_progress', conclusion: null })] }) });
  assert.equal(rerun.state, 'waiting');
});

test('requires a single nonexpired SHA256 artifact with matching run lineage and bounded complete listings', async () => {
  for (const value of [artifact({ digest: null }), artifact({ size_in_bytes: 512 * 1024 * 1024 + 1 }), artifact({ workflow_run: { ...artifact().workflow_run, head_sha: 'c'.repeat(40) } }),
    artifact({ workflow_run: { ...artifact().workflow_run, repository_id: 1 } })]) {
    assert.equal((await inspect({ fetchImpl: provider({ artifacts: [value] }) })).state, 'failed');
  }
  assert.equal((await inspect({ fetchImpl: provider({ artifacts: [artifact(), artifact({ id: 67 })] }) })).reason, 'ambiguous-artifact');
  const responses = { [`/repos/${REPO}/actions/workflows/cpanel-release.yml/runs`]: () => json({ total_count: 101, workflow_runs: [run()] }) };
  assert.equal((await inspect({ fetchImpl: provider({ responses }) })).reason, 'run-list-incomplete');
});

test('metadata response size and cancellation are bounded even when an injected fetch body ignores its signal', async () => {
  let cancelled = false;
  const oversized = () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); }, cancel() { cancelled = true; } }));
  const report = await inspect({ fetchImpl: async () => oversized() });
  assert.equal(report.reason, 'response-size'); assert.equal(cancelled, true);
  const controller = new AbortController();
  const pending = inspect({ signal: controller.signal, fetchImpl: async () => new Response(new ReadableStream({})) });
  setTimeout(() => controller.abort(), 5);
  assert.equal((await pending).reason, 'request-aborted');
  const transportController = new AbortController();
  const transport = inspect({ signal: transportController.signal, fetchImpl: () => new Promise(() => {}) });
  setTimeout(() => transportController.abort(), 5);
  assert.equal((await transport).reason, 'request-aborted');
});

test('metadata accepts fetch-decoded gzip bodies without comparing decoded length to compressed Content-Length', async () => {
  const responses = { [`/repos/${REPO}`]: () => new Response(JSON.stringify(repository()), { headers: { 'content-encoding': 'gzip', 'content-length': '12' } }) };
  assert.equal((await inspect({ fetchImpl: provider({ responses }) })).state, 'ready');
});

function zip(entries, { trailer = Buffer.alloc(0) } = {}) {
  const local = [], central = []; let offset = 0;
  for (const item of entries) {
    const raw = Buffer.from(item.name), localName = Buffer.from(item.localName || item.name), data = Buffer.from(item.data || '');
    const method = item.method ?? 8, compressed = item.compressed || (method === 8 ? deflateRawSync(data) : data);
    const flags = item.flags ?? (0x800 | (item.descriptor ? 8 : 0)), crc = item.crc ?? crc32(data), size = item.size ?? data.length;
    const extra = item.extra || Buffer.alloc(0), header = Buffer.alloc(30), descriptor = item.descriptor ? Buffer.alloc(16) : Buffer.alloc(0);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(item.needed ?? 20, 4); header.writeUInt16LE(flags, 6); header.writeUInt16LE(method, 8);
    if (!item.descriptor) { header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(size, 22); }
    header.writeUInt16LE(localName.length, 26); header.writeUInt16LE(extra.length, 28);
    if (item.descriptor) { descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(crc, 4); descriptor.writeUInt32LE(compressed.length, 8); descriptor.writeUInt32LE(size, 12); }
    const record = Buffer.concat([header, localName, extra, compressed, descriptor]); local.push(record);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(0x0314, 4); directory.writeUInt16LE(item.needed ?? 20, 6);
    directory.writeUInt16LE(flags, 8); directory.writeUInt16LE(method, 10); directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(compressed.length, 20); directory.writeUInt32LE(size, 24);
    directory.writeUInt16LE(raw.length, 28); directory.writeUInt16LE(extra.length, 30);
    directory.writeUInt32LE(item.attributes ?? (((item.name.endsWith('/') ? 0o40700 : 0o100600) << 16) >>> 0), 38); directory.writeUInt32LE(item.offset ?? offset, 42);
    central.push(Buffer.concat([directory, raw, extra])); offset += record.length;
  }
  const body = Buffer.concat(local), directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, directory, end, trailer]);
}
const packageEntries = () => [
  { name: 'manifest.json', data: JSON.stringify({ format: 'heichal-cpanel-release', version: 1, commit: COMMIT, branch: BRANCH }), descriptor: true },
  { name: 'app/server/start.mjs', data: '// test package only\n', method: 0 },
  { name: 'public/index.html', data: '<html dir="rtl">שלום 😀</html>' },
  { name: 'public/.htaccess', data: '# test header config\n' },
];
function ready(bytes) {
  return { state: 'ready', repo: REPO, branch: BRANCH, commit: COMMIT, runId: 55,
    artifact: { id: 66, name: `cpanel-${COMMIT}`, size: bytes.length, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, runId: 55 } };
}
async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'cms-github-source-')); t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, destination: join(directory, 'candidate') };
}
function archiveProvider(bytes, { location = 'https://productionresultssa0.blob.core.windows.net/artifact?sig=do-not-log', observe = () => {} } = {}) {
  return async (url, options) => {
    observe(url, options);
    if (new URL(url).origin === 'https://api.github.com') return new Response(null, { status: 302, headers: { location } });
    return new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
  };
}
async function rejectedArchive(t, entries, code, zipOptions) {
  const { directory, destination } = await temporary(t), bytes = zip(entries, zipOptions);
  await assert.rejects(downloadGithubRelease({ release: ready(bytes), destination, token: TOKEN, fetchImpl: archiveProvider(bytes) }), (error) => error instanceof GithubReleaseError && (!code || error.code === code));
  assert.deepEqual(await readdir(directory), []);
}

test('downloads verified store/deflate/data-descriptor ZIP into new private files without forwarding API token', async (t) => {
  const bytes = zip([{ name: 'app/', data: '' }, { name: 'public/', data: '' }, ...packageEntries()]), { destination } = await temporary(t), requests = [];
  const result = await downloadGithubRelease({ release: ready(bytes), destination, token: TOKEN, fetchImpl: archiveProvider(bytes, { observe: (url, options) => requests.push({ url, headers: options.headers, redirect: options.redirect }) }) });
  assert.deepEqual(result, { candidateRoot: destination, commit: COMMIT });
  assert.equal(requests.length, 2); assert.equal(requests[0].headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(requests[1].headers.Authorization, undefined); assert.equal(requests[1].redirect, 'manual');
  assert.equal((await stat(destination)).mode & 0o777, 0o700);
  assert.equal((await stat(join(destination, 'public/index.html'))).mode & 0o777, 0o600);
  assert.equal(await readFile(join(destination, 'public/index.html'), 'utf8'), '<html dir="rtl">שלום 😀</html>');
  assert.equal(await readFile(join(destination, 'public/.htaccess'), 'utf8'), '# test header config\n');
});

test('archive hash and announced size must match before any extraction', async (t) => {
  const bytes = zip(packageEntries()), { directory, destination } = await temporary(t);
  const release = ready(bytes); release.artifact.digest = `sha256:${'c'.repeat(64)}`;
  await assert.rejects(downloadGithubRelease({ release, destination, token: TOKEN, fetchImpl: archiveProvider(bytes) }), { code: 'archive-digest' });
  const wrongLength = ready(bytes); wrongLength.artifact.size--;
  await assert.rejects(downloadGithubRelease({ release: wrongLength, destination, token: TOKEN, fetchImpl: archiveProvider(bytes) }), { code: 'response-size' });
  assert.deepEqual(await readdir(directory), []);
});

test('redirects reject arbitrary origins, deceptive suffixes, credentials, insecure protocols and redirect loops', async (t) => {
  const bytes = zip(packageEntries()), { directory, destination } = await temporary(t);
  for (const location of ['https://evil.example/archive.zip', 'https://blob.core.windows.net.evil.example/archive',
    'http://productionresultssa0.blob.core.windows.net/archive', 'https://user:pass@objects.githubusercontent.com/archive',
    'https://objects.githubusercontent.com:8443/archive', 'https://api.github.com/repos/other/repo/actions/artifacts/66/zip']) {
    let calls = 0;
    await assert.rejects(downloadGithubRelease({ release: ready(bytes), destination, token: TOKEN,
      fetchImpl: archiveProvider(bytes, { location, observe: () => calls++ }) }), { code: 'download-redirect' });
    assert.equal(calls, 1);
  }
  let calls = 0;
  await assert.rejects(downloadGithubRelease({ release: ready(bytes), destination, token: TOKEN, fetchImpl: async (url) => { calls++; return new Response(null, { status: 302, headers: { location: url } }); } }), { code: 'download-redirect' });
  assert.equal(calls, 4); assert.deepEqual(await readdir(directory), []);
});

test('ZIP rejects traversal, absolute/backslash paths and hidden secret paths', async (t) => {
  for (const name of ['../outside', '/absolute', 'public/../outside', 'public\\outside', 'app/.env', 'app/.git/config', 'public/.htaccess/child', 'unknown-root/file']) {
    await rejectedArchive(t, [...packageEntries(), { name, data: 'private' }]);
  }
});

test('ZIP rejects duplicate, case or Unicode-normalization collisions and files used as directories', async (t) => {
  for (const entries of [
    [{ name: 'public/index.html', data: 'duplicate' }],
    [{ name: 'public/INDEX.html', data: 'case collision' }],
    [{ name: 'Public/other.html', data: 'parent case collision' }],
    [{ name: 'public/é.txt', data: 'one' }, { name: 'public/é.txt', data: 'two' }],
    [{ name: 'app/server', data: 'not a directory' }],
  ]) await rejectedArchive(t, [...packageEntries(), ...entries]);
});

test('ZIP rejects symlinks, devices, encryption, ZIP64 and unsupported compression', async (t) => {
  for (const extra of [
    { attributes: (0o120777 << 16) >>> 0 }, { attributes: (0o020600 << 16) >>> 0 },
    { flags: 0x801 }, { needed: 45 }, { method: 12 }, { extra: Buffer.from([1, 0, 0, 0]) },
  ]) await rejectedArchive(t, [...packageEntries(), { name: 'app/untrusted', data: 'target', ...extra }]);
});

test('ZIP rejects mismatched local headers, overlapping entries, trailing junk, CRC corruption and excess inflation', async (t) => {
  const malformed = [
    { localName: 'app/other-path' }, { offset: 0 }, { crc: 1 }, { size: 1, data: 'much longer than declared' },
    { compressed: Buffer.concat([deflateRawSync(Buffer.from('data')), Buffer.from('trailing')]), data: 'data' },
    { size: 128 * 1024 * 1024 + 1 },
  ];
  for (const extra of malformed) await rejectedArchive(t, [...packageEntries(), { name: 'app/untrusted', data: 'data', ...extra }]);
  await rejectedArchive(t, packageEntries(), 'zip-directory', { trailer: Buffer.from('unexpected') });
  const oversizedTotal = Array.from({ length: 9 }, (_, index) => ({ name: `app/large-${index}`, data: '', size: 128 * 1024 * 1024 }));
  await rejectedArchive(t, [...packageEntries(), ...oversizedTotal], 'zip-expanded-size');
});

test('existing destinations remain intact and manifest lineage mismatches remove only the new candidate', async (t) => {
  const bytes = zip(packageEntries()), { destination } = await temporary(t);
  await mkdir(destination); await writeFile(join(destination, 'existing'), 'keep');
  await assert.rejects(downloadGithubRelease({ release: ready(bytes), destination, token: TOKEN, fetchImpl: archiveProvider(bytes) }));
  assert.equal(await readFile(join(destination, 'existing'), 'utf8'), 'keep');
  const entries = packageEntries(); entries[0].data = JSON.stringify({ format: 'heichal-cpanel-release', version: 1, commit: 'c'.repeat(40), branch: BRANCH });
  await rejectedArchive(t, entries, 'manifest-lineage');
});
