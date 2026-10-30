import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle, makeSession } from '../cms-worker/worker.mjs';
import { makeD1 } from './helpers/d1.mjs';
import { makeGithub } from './helpers/fake-github.mjs';

const page = 'data/pages/example.json';
const other = 'data/pages/other.json';
const text = (value) => `${JSON.stringify({ title: value, blocks: [] })}\n`;
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

// Model D1's per-request statement budget and per-statement parameter ceiling.
// The budget starts after fixture setup; statements inside batch still count.
function budgetedD1(db) {
  let maximum = null, queries = 0, largestBinding = 0;
  const execute = async (statement, method) => {
    if (maximum !== null && ++queries > maximum) throw new Error('D1 statement budget exceeded');
    return statement[method]();
  };
  const wrap = (statement) => ({
    bind: (...args) => {
      assert.ok(args.length <= 100, `D1 permits at most 100 bound parameters, received ${args.length}`);
      if (maximum !== null) largestBinding = Math.max(largestBinding, args.length);
      return wrap(statement.bind(...args));
    },
    first: () => execute(statement, 'first'),
    all: () => execute(statement, 'all'),
    run: () => execute(statement, 'run'),
  });
  return {
    db: { prepare: (sql) => wrap(db.prepare(sql)), batch: (statements) => db.batch(statements) },
    start: (limit) => { maximum = limit; queries = 0; largestBinding = 0; },
    stop: () => { maximum = null; },
    get queries() { return queries; },
    get largestBinding() { return largestBinding; },
  };
}

async function world(t) {
  const db = makeD1();
  const budget = budgetedD1(db);
  t.after(() => db.raw.close());
  const github = await makeGithub({ files: { [page]: text('Published'), 'data/topics.json': '[]\n' } });
  let pause = null;
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (pause && pause.matches(new URL(url), options)) {
      const stopped = pause;
      stopped.remaining--;
      if (!stopped.remaining) { pause = null; stopped.entered.resolve(); }
      await stopped.release.promise;
    }
    const response = await github.fetch(url, options);
    if (!response) throw new Error(`Unexpected network request: ${url}`);
    return response;
  });
  const env = {
    ALLOWED_ORIGIN: 'https://site.example', REPO: 'o/r', BRANCH: 'live',
    GITHUB_TOKEN: 'test-github-token', SESSION_SECRET: 'test-session-secret', DB: budget.db,
    EDITORS: { get: async (key) => key === 'people' ? JSON.stringify([{ email: 'publisher@example.com', name: 'Publisher', publisher: true }]) : null },
  };
  const token = await makeSession('publisher@example.com', env);
  const api = async (method, path, body) => {
    const response = await handle(new Request(`https://worker.example${path}`, {
      method, headers: { Origin: env.ALLOWED_ORIGIN, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), env);
    return { status: response.status, body: await response.json() };
  };
  const requestSave = (path, value, sha) => api('PUT', `/gh/contents/${path}`, { content: Buffer.from(text(value)).toString('base64'), sha });
  const save = async (path, value, sha) => {
    const result = await requestSave(path, value, sha);
    assert.equal(result.status, 200);
    return result.body.content.sha;
  };
  const pauseRequests = (matches, count = 1) => {
    pause = { matches, remaining: count, entered: deferred(), release: deferred() };
    const gate = pause;
    t.after(() => gate.release.resolve());
    return { entered: gate.entered.promise, release: gate.release.resolve };
  };
  const pauseNextBlob = () => pauseRequests((url, options) => options.method === 'POST' && url.pathname === '/repos/o/r/git/blobs');
  const pauseContentReads = (path, count = 2) => pauseRequests((url, options) => (options.method || 'GET') === 'GET' && url.pathname === `/repos/o/r/contents/${path}` && url.searchParams.get('ref') === 'live', count);
  const pauseRefUpdate = () => pauseRequests((url, options) => options.method === 'PATCH' && url.pathname === '/repos/o/r/git/refs/heads/live');
  const draft = (path) => db.raw.prepare('SELECT * FROM drafts WHERE path = ?').get(path);
  return { api, requestSave, save, github, pauseNextBlob, pauseContentReads, pauseRefUpdate, draft, budget };
}

for (const existingDraft of [false, true]) {
  test(`simultaneous saves from the same ${existingDraft ? 'draft' : 'published file'} accept exactly one writer`, { timeout: 5000 }, async (t) => {
    const w = await world(t), published = await w.api('GET', `/gh/contents/${page}`);
    const expected = existingDraft ? await w.save(page, 'Shared draft', published.body.sha) : published.body.sha;
    const gate = w.pauseContentReads(page);
    const requests = ['First edit', 'Second edit'].map((value) => w.requestSave(page, value, expected));
    try { await gate.entered; } finally { gate.release(); }
    const results = await Promise.all(requests);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.equal(w.draft(page)?.content, text(results[0].status === 200 ? 'First edit' : 'Second edit'));
    assert.equal(w.github.read(page), text('Published'));
  });
}

test('same-content saves in the same millisecond still compare against one exact revision', { timeout: 5000 }, async (t) => {
  const w = await world(t), published = await w.api('GET', `/gh/contents/${page}`);
  const expected = await w.save(page, 'Shared draft', published.body.sha);
  const before = w.draft(page);
  t.mock.method(Date, 'now', () => before.updated_at);
  const gate = w.pauseContentReads(page);
  const requests = [w.requestSave(page, 'Shared draft', expected), w.requestSave(page, 'Shared draft', expected)];
  try { await gate.entered; } finally { gate.release(); }
  assert.deepEqual((await Promise.all(requests)).map((r) => r.status).sort(), [200, 409]);
  assert.ok(w.draft(page).updated_at > before.updated_at);
});

for (const initiallyPublished of [false, true]) {
  test(`a simultaneous save and deletion of a ${initiallyPublished ? 'published' : 'new'} file cannot both replace its draft`, { timeout: 5000 }, async (t) => {
    const w = await world(t), path = initiallyPublished ? page : other;
    const published = await w.api('GET', `/gh/contents/${path}`);
    const expected = await w.save(path, 'Shared draft', published.status === 200 ? published.body.sha : null);
    const gate = w.pauseContentReads(path);
    const saving = w.requestSave(path, 'Kept by the writer', expected);
    const deleting = w.api('DELETE', `/gh/contents/${path}`, { sha: expected });
    try { await gate.entered; } finally { gate.release(); }
    const [saved, deleted] = await Promise.all([saving, deleting]);
    assert.deepEqual([saved.status, deleted.status].sort(), [200, 409]);
    if (saved.status === 200) assert.equal(w.draft(path)?.content, text('Kept by the writer'));
    else if (initiallyPublished) assert.equal(w.draft(path)?.deleted, 1);
    else assert.equal(w.draft(path), undefined);
  });
}

test('returning to published content cannot clear a concurrently saved draft', { timeout: 5000 }, async (t) => {
  const w = await world(t), published = await w.api('GET', `/gh/contents/${page}`);
  const expected = await w.save(page, 'Shared draft', published.body.sha);
  const gate = w.pauseContentReads(page);
  const requests = [w.requestSave(page, 'Published', expected), w.requestSave(page, 'New edit', expected)];
  try { await gate.entered; } finally { gate.release(); }
  const [reverted, saved] = await Promise.all(requests);
  assert.deepEqual([reverted.status, saved.status].sort(), [200, 409]);
  if (saved.status === 200) assert.equal(w.draft(page)?.content, text('New edit'));
  else assert.equal(w.draft(page), undefined);
});

test('publication commits its snapshot without erasing a newer same-path save', { timeout: 5000 }, async (t) => {
  const w = await world(t);
  const published = await w.api('GET', `/gh/contents/${page}`);
  const snapshotSha = await w.save(page, 'Snapshot being published', published.body.sha);
  await w.save(other, 'Unchanged selected draft', null);
  const gate = w.pauseNextBlob();
  const publishing = w.api('POST', '/publish', { paths: [page, other] });
  try {
    await gate.entered;
    await w.save(page, 'Newer unsent work', snapshotSha);
  } finally {
    gate.release();
  }
  const result = await publishing;
  assert.equal(result.status, 200);
  assert.equal(w.github.read(page), text('Snapshot being published'));
  assert.equal(w.github.read(other), text('Unchanged selected draft'));
  assert.equal(w.draft(page)?.content, text('Newer unsent work'), 'only the published revision may be cleared');
  assert.equal(w.draft(other), undefined, 'unchanged selected drafts still clear normally');
  const latest = await w.api('GET', `/gh/contents/${page}`);
  assert.equal(latest.body.draft, true);
  assert.equal(Buffer.from(latest.body.content, 'base64').toString(), text('Newer unsent work'));
});

test('publication preserves a deletion saved after its snapshot was read', { timeout: 5000 }, async (t) => {
  const w = await world(t);
  const published = await w.api('GET', `/gh/contents/${page}`);
  const snapshotSha = await w.save(page, 'Snapshot being published', published.body.sha);
  const gate = w.pauseNextBlob();
  const publishing = w.api('POST', '/publish', { paths: [page] });
  try {
    await gate.entered;
    assert.equal((await w.api('DELETE', `/gh/contents/${page}`, { sha: snapshotSha })).status, 200);
  } finally {
    gate.release();
  }
  assert.equal((await publishing).status, 200);
  assert.equal(w.github.read(page), text('Snapshot being published'));
  assert.equal(w.draft(page)?.deleted, 1, 'the newer deletion must remain pending');
  assert.equal((await w.api('GET', `/gh/contents/${page}`)).status, 404);
  const pending = await w.api('GET', '/changes');
  assert.equal(pending.body.changes.find((change) => change.path === page)?.status, 'removed');
});

test('publication clears selected drafts that have not changed since its snapshot', async (t) => {
  const w = await world(t);
  const published = await w.api('GET', `/gh/contents/${page}`);
  await w.save(page, 'Ready to publish', published.body.sha);
  const result = await w.api('POST', '/publish', { paths: [page] });
  assert.equal(result.status, 200);
  assert.equal(w.github.read(page), text('Ready to publish'));
  assert.equal(w.draft(page), undefined);
  assert.deepEqual((await w.api('GET', '/changes')).body.changes, []);
});

test('publishing 25 drafts stays within D1 limits and preserves edits in later cleanup groups', { timeout: 5000 }, async (t) => {
  const w = await world(t);
  const paths = Array.from({ length: 25 }, (_, i) => `data/pages/batch-${String(i).padStart(2, '0')}.json`);
  const snapshots = new Map();
  for (const path of paths) snapshots.set(path, await w.save(path, `Snapshot ${path}`, null));
  const changed = [paths[12], paths[24]];
  const gate = w.pauseNextBlob();
  w.budget.start(50);
  const publishing = w.api('POST', '/publish', { paths });
  try {
    await gate.entered;
    for (const path of changed) await w.save(path, `Newer ${path}`, snapshots.get(path));
  } finally {
    gate.release();
  }
  const result = await publishing;
  const used = w.budget.queries, largestBinding = w.budget.largestBinding;
  w.budget.stop();
  assert.equal(result.status, 200);
  assert.ok(used > 0 && used <= 50, `publication and overlapping saves used ${used} statements`);
  assert.ok(largestBinding > 0 && largestBinding <= 100);
  assert.deepEqual(new Set(result.body.published), new Set(paths));
  for (const path of paths) {
    assert.equal(w.github.read(path), text(`Snapshot ${path}`));
    if (changed.includes(path)) assert.equal(w.draft(path)?.content, text(`Newer ${path}`));
    else assert.equal(w.draft(path), undefined, `${path} must clear after publication`);
  }
  assert.deepEqual(new Set((await w.api('GET', '/changes')).body.changes.map((change) => change.path)), new Set(changed));
});

for (const forced of [false, true]) {
  test(`a same-file remote edit during publication retry ${forced ? 'requires and honors explicit force' : 'is preserved as a conflict'}`, { timeout: 5000 }, async (t) => {
    const w = await world(t), published = await w.api('GET', `/gh/contents/${page}`);
    await w.save(page, 'Chosen draft', published.body.sha);
    const gate = w.pauseRefUpdate();
    const publishing = w.api('POST', '/publish', { paths: [page], force: forced ? [page] : [] });
    let remoteHead;
    try {
      await gate.entered;
      remoteHead = await w.github.commit({ [page]: text('Remote edit') });
    } finally {
      gate.release();
    }
    const result = await publishing;
    if (forced) {
      assert.equal(result.status, 200);
      assert.equal(w.github.read(page), text('Chosen draft'));
      assert.equal(w.draft(page), undefined);
    } else {
      assert.equal(result.status, 409);
      assert.deepEqual(result.body.conflicts, [page]);
      assert.equal(w.github.head, remoteHead);
      assert.equal(w.github.read(page), text('Remote edit'));
      assert.equal(w.draft(page)?.content, text('Chosen draft'));
    }
  });
}

test('an unrelated remote edit survives a successful publication retry', { timeout: 5000 }, async (t) => {
  const w = await world(t), published = await w.api('GET', `/gh/contents/${page}`);
  await w.save(page, 'Chosen draft', published.body.sha);
  const gate = w.pauseRefUpdate();
  const publishing = w.api('POST', '/publish', { paths: [page] });
  try {
    await gate.entered;
    await w.github.commit({ [other]: text('Unrelated remote edit') });
  } finally {
    gate.release();
  }
  const result = await publishing;
  assert.equal(result.status, 200);
  assert.equal(w.github.read(page), text('Chosen draft'));
  assert.equal(w.github.read(other), text('Unrelated remote edit'));
  assert.equal(w.draft(page), undefined);
  assert.equal(w.github.log.filter((entry) => entry === 'PATCH git/refs/heads/live').length, 2);
});

test('a remote edit while creating a blob is checked against the originally captured head', { timeout: 5000 }, async (t) => {
  const w = await world(t), published = await w.api('GET', `/gh/contents/${page}`);
  await w.save(page, 'Chosen draft', published.body.sha);
  const gate = w.pauseNextBlob();
  const publishing = w.api('POST', '/publish', { paths: [page] });
  try {
    await gate.entered;
    await w.github.commit({ [page]: text('Remote edit before tree creation') });
  } finally {
    gate.release();
  }
  assert.equal((await publishing).status, 409);
  assert.equal(w.github.read(page), text('Remote edit before tree creation'));
  assert.equal(w.draft(page)?.content, text('Chosen draft'));
});

test('publication retry rechecks referenced media on the new immutable head', { timeout: 5000 }, async (t) => {
  const w = await world(t), mediaPath = 'site/media/report.pdf';
  await w.github.commit({ [mediaPath]: '%PDF-test' });
  const published = await w.api('GET', `/gh/contents/${page}`);
  const content = `${JSON.stringify({ title: 'Document', blocks: [{ type: 'file', src: '/media/report.pdf', title: 'Report' }] })}\n`;
  assert.equal((await w.api('PUT', `/gh/contents/${page}`, { content: Buffer.from(content).toString('base64'), sha: published.body.sha })).status, 200);
  const gate = w.pauseRefUpdate();
  const publishing = w.api('POST', '/publish', { paths: [page] });
  try {
    await gate.entered;
    await w.github.commit({ [mediaPath]: null });
  } finally {
    gate.release();
  }
  assert.equal((await publishing).status, 400);
  assert.equal(w.github.read(page), text('Published'));
  assert.equal(w.draft(page)?.content, content);
});
