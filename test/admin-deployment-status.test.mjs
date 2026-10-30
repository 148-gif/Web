import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deploymentSettings, parseDeploymentStatus, readDeploymentStatus, readBuildMarker, deploymentProgress } from '../site/admin/deployment-status.mjs';

const A = 'a'.repeat(40), B = 'b'.repeat(40), C = 'c'.repeat(40);
const pages = deploymentSettings();
const cpanel = deploymentSettings({ target: 'cpanel', workflow: 'cpanel-release.yml', statusPath: 'deployment.json' });
const snapshot = (state = 'live', commit = A, extra = {}) => ({ version: 1, target: 'cpanel', state, commit, updatedAt: '2026-10-30T12:00:00.000Z', ...extra });
const run = (extra = {}) => ({ id: 1, path: '.github/workflows/cpanel-release.yml', head_sha: A, status: 'completed', conclusion: 'success', ...extra });
const progress = (extra = {}) => deploymentProgress({ settings: cpanel, commit: A, savedCommits: [A], build: null, status: null, ...extra });

test('existing configuration defaults to Pages; cPanel requires explicit safe monitoring settings', () => {
  assert.deepEqual(pages, { target: 'pages', workflowPath: '.github/workflows/pages.yml', statusPath: null });
  assert.deepEqual(cpanel, { target: 'cpanel', workflowPath: '.github/workflows/cpanel-release.yml', statusPath: 'deployment.json' });
  for (const value of [null, {}, { target: 'unknown' }, { target: 'cpanel' },
    { target: 'cpanel', workflow: '../pages.yml', statusPath: 'deployment.json' },
    { target: 'cpanel', workflow: 'cpanel-release.yml', statusPath: 'https://other.example/status.json' },
    { target: 'cpanel', workflow: 'cpanel-release.yml', statusPath: '../deployment.json' },
    { target: 'cpanel', workflow: 'cpanel-release.yml', statusPath: 'deployment.json', secret: 'private' }]) {
    assert.throws(() => deploymentSettings(value), /^Error: Invalid deployment monitoring configuration$/);
  }
});

test('status accepts only the public contract and rejects errors, private paths and malformed identities', () => {
  const valid = snapshot('failed', A, { previousCommit: B });
  assert.deepEqual(parseDeploymentStatus(valid), valid);
  for (const invalid of [null, [], { ...valid, version: 2 }, { ...valid, target: 'pages' }, { ...valid, state: 'success' },
    { ...valid, commit: 'HEAD' }, { ...valid, previousCommit: 'main' },
    { ...valid, updatedAt: '2026-02-30T12:00:00.000Z' }, { ...valid, updatedAt: 'yesterday' },
    { ...valid, error: 'private database error' }, { ...valid, path: '/home/private/release' }]) {
    assert.equal(parseDeploymentStatus(invalid), null);
  }
});

test('status reader bounds streamed responses and rejects malformed UTF-8, JSON and failed responses', async () => {
  assert.deepEqual(await readDeploymentStatus(Response.json(snapshot())), snapshot());
  for (const response of [new Response('invalid'), new Response(new Uint8Array([255, 254])), Response.json(snapshot(), { status: 404 }), new Response(' '.repeat(2049))]) {
    assert.equal(await readDeploymentStatus(response), null);
  }
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(2049)); },
    cancel() { cancelled = true; },
  });
  assert.equal(await readDeploymentStatus(new Response(stream)), null);
  assert.equal(cancelled, true);
});

test('build marker reader accepts an exact commit SHA and rejects incomplete evidence', async () => {
  assert.deepEqual(await readBuildMarker(Response.json({ sha: A })), { sha: A });
  for (const value of [{}, { sha: 'main' }, { sha: A.slice(0, 7) }, null]) assert.equal(await readBuildMarker(Response.json(value)), null);
});

test('Pages continues to use the served marker without requiring a cPanel status file', () => {
  assert.deepEqual(progress({ settings: pages, build: { sha: A } }), { state: 'live', done: true });
  assert.equal(progress({ settings: pages }).state, 'wait');
  assert.equal(progress({ settings: pages, build: { sha: C } }).state, 'wait');
  assert.equal(progress({ settings: pages, build: { sha: B }, savedCommits: [A, B] }).state, 'live');
  assert.equal(progress({ settings: pages, commit: B, build: { sha: A }, savedCommits: [A, B] }).state, 'wait');
});

test('cPanel workflow success and an uploaded build marker cannot prematurely report a live release', () => {
  for (const input of [
    { runs: [run()] },
    { build: { sha: A }, runs: [run()] },
    { build: { sha: A } },
    { build: { sha: A }, status: snapshot('live', B) },
    { build: { sha: B }, status: snapshot() },
    { status: snapshot() },
    { build: { sha: A }, status: snapshot('staging') },
    { build: { sha: A }, status: snapshot('deploying') },
  ]) assert.notEqual(progress(input).state, 'live');
  assert.deepEqual(progress({ build: { sha: A }, status: snapshot() }), { state: 'live', done: true });
});

test('cPanel status phases are shown only for the requested commit', () => {
  for (const [state, expected] of [['waiting', 'wait'], ['building', 'building'], ['staging', 'staging'], ['deploying', 'deploying'], ['live', 'unknown']]) {
    assert.deepEqual(progress({ status: snapshot(state) }), { state: expected, done: false });
    assert.equal(progress({ status: snapshot(state, B) }).state, 'wait');
  }
});

test('a later commit saved by this session covers earlier saves only when both cPanel markers agree', () => {
  const input = { savedCommits: [A, B], build: { sha: B } };
  assert.deepEqual(progress({ ...input, status: snapshot('live', B) }), { state: 'live', done: true });
  assert.notEqual(progress({ ...input, status: snapshot('live', A) }).state, 'live');
  assert.notEqual(progress({ ...input, status: snapshot('deploying', B) }).state, 'live');
  assert.notEqual(progress({ ...input, savedCommits: [A] , status: snapshot('live', B) }).state, 'live');
});

test('workflow identity uses the exact configured path and commit, never a Pages-like name', () => {
  const failed = { status: 'completed', conclusion: 'failure' };
  for (const wrong of [
    run({ ...failed, path: '.github/workflows/pages.yml', name: 'Deploy to Pages' }),
    run({ ...failed, path: '.github/workflows/not-cpanel-release.yml' }),
    run({ ...failed, path: '.github/workflows/cpanel-release.yml@main' }),
    run({ ...failed, head_sha: B }),
  ]) assert.deepEqual(progress({ runs: [wrong] }), { state: 'wait', done: false });
  assert.deepEqual(progress({ runs: [run({ ...failed, name: 'An unrelated display name' })] }), { state: 'bad', done: true });
  assert.equal(progress({ settings: pages, runs: [run({ ...failed, path: '.github/workflows/pages.yml', name: 'Site build' })] }).state, 'bad');
});

test('current failures are reported without inferring which release the host currently serves', () => {
  for (const build of [null, { sha: A }, { sha: B }, { sha: C }]) {
    assert.deepEqual(progress({ build, status: snapshot('failed', A, { previousCommit: B }) }), { state: 'bad', done: true });
  }
  assert.equal(progress({ status: snapshot('failed', B) }).state, 'wait');
  assert.equal(progress({ runs: [run({ conclusion: 'timed_out' })] }).state, 'bad');
});

test('newer attempts supersede an older workflow failure and cancellation does not claim a live release', () => {
  const old = run({ id: 2, conclusion: 'failure' }), current = run({ id: 3, status: 'in_progress', conclusion: null });
  assert.deepEqual(progress({ runs: [old, current] }), { state: 'run', done: false });
  assert.equal(progress({ runs: [run({ run_attempt: 1, conclusion: 'failure' }), run({ run_attempt: 2, status: 'in_progress', conclusion: null })] }).state, 'run');
  assert.deepEqual(progress({ runs: [run({ conclusion: 'cancelled' })] }), { state: 'unknown', done: false });
  assert.deepEqual(progress({ savedCommits: [A, B], runs: [run({ conclusion: 'cancelled' })] }), { state: 'wait', done: true, superseded: true });
});
