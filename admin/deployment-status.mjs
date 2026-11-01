// Public deployment evidence only. Workflow success is not proof that a cPanel
// release is live: the promoter's status and the served build marker must agree.
const SHA = /^[a-f0-9]{40}$/;
const STATES = new Set(['waiting', 'building', 'staging', 'deploying', 'failed', 'live']);
const STATUS_KEYS = new Set(['version', 'target', 'state', 'commit', 'previousCommit', 'updatedAt']);
const MAX_BYTES = 2048;
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);

export function deploymentSettings(value) {
  if (value === undefined || (object(value) && value.target === 'pages' && Object.keys(value).length === 1)) {
    return { target: 'pages', workflowPath: '.github/workflows/pages.yml', statusPath: null };
  }
  if (!object(value) || value.target !== 'cpanel' ||
      Object.keys(value).some((key) => !['target', 'workflow', 'statusPath'].includes(key)) ||
      typeof value.workflow !== 'string' || !/^[a-zA-Z0-9_-]+\.ya?ml$/.test(value.workflow) ||
      value.statusPath !== 'deployment.json') throw new Error('Invalid deployment monitoring configuration');
  return { target: 'cpanel', workflowPath: '.github/workflows/' + value.workflow, statusPath: value.statusPath };
}

export function parseDeploymentStatus(value) {
  if (!object(value) || Object.keys(value).some((key) => !STATUS_KEYS.has(key)) ||
      value.version !== 1 || value.target !== 'cpanel' || !STATES.has(value.state) ||
      typeof value.commit !== 'string' || !SHA.test(value.commit) ||
      (value.previousCommit !== undefined && (typeof value.previousCommit !== 'string' || !SHA.test(value.previousCommit))) ||
      typeof value.updatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.updatedAt)) return null;
  const time = Date.parse(value.updatedAt);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value.updatedAt) return null;
  return { version: 1, target: 'cpanel', state: value.state, commit: value.commit,
    ...(value.previousCommit === undefined ? {} : { previousCommit: value.previousCommit }), updatedAt: value.updatedAt };
}

async function smallJson(response) {
  if (!response?.ok || !response.body) return null;
  if (Number(response.headers.get('content-length')) > MAX_BYTES) { await response.body.cancel().catch(() => {}); return null; }
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) { await reader.cancel(); return null; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch { return null; }
  finally { reader.releaseLock(); }
}

export async function readDeploymentStatus(response) { return parseDeploymentStatus(await smallJson(response)); }
export async function readBuildMarker(response) {
  const value = await smallJson(response);
  return object(value) && typeof value.sha === 'string' && SHA.test(value.sha) ? { sha: value.sha } : null;
}

function selectedRun(runs, settings, commit) {
  if (!Array.isArray(runs)) return null;
  return runs.slice(0, 100).filter((run) => object(run) && run.path === settings.workflowPath && run.head_sha === commit)
    .sort((a, b) => (Number(b.id) || 0) - (Number(a.id) || 0) || (Number(b.run_attempt) || 0) - (Number(a.run_attempt) || 0))[0] || null;
}

export function deploymentProgress({ settings, commit, savedCommits = [], build, status, runs = [] }) {
  const targetIndex = savedCommits.indexOf(commit);
  const servedIndex = build ? savedCommits.indexOf(build.sha) : -1;
  const covered = typeof commit === 'string' && SHA.test(commit) && targetIndex >= 0 && servedIndex >= targetIndex;
  const run = selectedRun(runs, settings, commit);
  const snapshot = settings.target === 'cpanel' ? parseDeploymentStatus(status) : null;
  const matching = snapshot && snapshot.commit === commit;
  if (covered && (settings.target === 'pages' || (snapshot?.state === 'live' && snapshot.commit === build.sha))) {
    return { state: 'live', done: true };
  }
  if ((matching && snapshot.state === 'failed') || (run?.status === 'completed' && ['failure', 'timed_out', 'action_required'].includes(run.conclusion))) {
    return { state: 'bad', done: true };
  }
  if (run?.status === 'completed' && run.conclusion === 'cancelled' && savedCommits.at(-1) !== commit) {
    return { state: 'wait', done: true, superseded: true };
  }
  if (settings.target === 'cpanel') {
    if (matching) {
      // A live status with a stale/missing marker is not yet a verified release.
      return { state: snapshot.state === 'live' ? 'unknown' : snapshot.state === 'waiting' ? 'wait' : snapshot.state, done: false };
    }
    if (run?.status === 'in_progress') return { state: 'run', done: false };
    if (run?.status === 'completed') return { state: 'unknown', done: false };
    return { state: 'wait', done: false };
  }
  return { state: run && ['in_progress', 'completed'].includes(run.status) ? 'run' : 'wait', done: false };
}
