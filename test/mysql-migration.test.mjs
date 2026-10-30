import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { planMigration, MigrationValidationError } from '../server/migration.mjs';

const SHA = 'a'.repeat(40);
const snapshot = () => ({
  format: 'heichal-cms-snapshot', version: 1,
  tables: { drafts: [], log: [], media: [], media_chunks: [], ai_usage: [] }, kv: {},
});
const draft = (extra = {}) => ({
  path: 'data/pages/example.json', content: '{"title":"שלום"}\n', deleted: 0,
  base_sha: SHA, created_at: 1700000000000, updated_at: 1700000000001,
  email: 'editor@example.com', name: 'יעקב', ...extra,
});
const media = (extra = {}) => ({
  id: 'abc12345', name: 'קובץ.txt', kind: 'doc', mime: 'text/plain; charset=utf-8', size: 5,
  store: 'github', key: 'site/media/abc12345-file.txt', status: 'staged',
  email: 'editor@example.com', by_name: 'יעקב', created_at: 1700000000000, ...extra,
});
const log = (extra = {}) => ({ id: 1, ts: 1700000000000, email: null, name: null, action: 'save', path: null, summary: null, sha: null, ...extra });
const operations = (plan) => plan.batches.flatMap((b) => b.operations);
const invalid = (input, code, path) => assert.throws(() => planMigration(input), (error) => {
  assert.ok(error instanceof MigrationValidationError);
  assert.equal(error.errors[0].code, code);
  if (path) assert.equal(error.errors[0].path, path);
  return true;
});

test('requires explicit version and every source table; does not silently omit unknown data', () => {
  const empty = planMigration(snapshot());
  assert.equal(empty.readyToImport, true);
  assert.equal(empty.target, 'mysql-8.4-or-newer');
  assert.deepEqual(empty.counts, { drafts: 0, log: 0, media: 0, media_chunks: 0, ai_usage: 0, editors_kv: 0 });
  assert.deepEqual(empty.batches, []);
  assert.deepEqual(empty.resetTables, ['request_limits']);
  for (const table of Object.keys(snapshot().tables)) {
    const s = snapshot(); delete s.tables[table]; invalid(s, 'missing-field', `tables.${table}`);
  }
  const s = snapshot(); s.version = 2; invalid(s, 'version');
  s.version = 1; s.tables.unrecognized = []; invalid(s, 'unknown-field');
  delete s.tables.unrecognized; s.tables.drafts = null; invalid(s, 'table-shape');
  s.tables.drafts = []; delete s.kv; invalid(s, 'missing-field', 'snapshot.kv');
});

test('preserves Unicode, normalization, capitalization, whitespace and SQL-looking values exactly', () => {
  const s = snapshot();
  const values = ['{"text":"שלום 😀 é é"}\n', '{ "text": "A" } ', '{"text":"a"}', '{"text":"א  "}'];
  s.tables.drafts = values.map((content, i) => draft({ path: `data/pages/${i === 0 ? 'A' : i === 1 ? 'a' : `item-${i}`}.json`, content, name: i === 0 ? 'שם ' : 'שם' }));
  const sqlText = "Robert'); DROP TABLE drafts; --";
  s.tables.log.push(log({ summary: sqlText }));
  s.kv.people = ' [ { "email": "editor@example.com", "name": "שם ", "publisher": false } ]\n';
  s.kv.editors = '["legacy@example.com"]';
  s.kv['owner-names'] = `{ "${'b'.repeat(64)}" : "בעלים 😀" }`;
  const before = JSON.stringify(s), plan = planMigration(s);
  assert.equal(JSON.stringify(s), before, 'planner must not mutate the snapshot');
  assert.equal(plan.readyToImport, true);
  const ops = operations(plan);
  assert.deepEqual(ops.filter((o) => o.table === 'drafts').map((o) => o.values[1]), values);
  assert.equal(ops.find((o) => o.table === 'drafts').values[7], 'שם ');
  assert.equal(ops.find((o) => o.table === 'log').values[6], sqlText);
  for (const op of ops) assert.equal(op.sql.includes(sqlText), false);
  assert.deepEqual(Object.fromEntries(ops.filter((o) => o.table === 'editors_kv').map((o) => o.values)), s.kv);
  // The portable operation artifact survives JSON serialization without number/text changes.
  assert.deepEqual(JSON.parse(JSON.stringify(ops)), ops);
});

test('rejects malformed Unicode rather than silently replacing bytes during import', () => {
  const s = snapshot(); s.tables.drafts = [draft({ name: '\ud800' })]; invalid(s, 'text');
  s.tables.drafts = [draft({ content: '{"x":"\udfff"}' })]; invalid(s, 'text');
});

test('accepts deletion and addition snapshots without rewriting null and empty values', () => {
  const s = snapshot();
  s.tables.drafts = [draft({ content: null, deleted: 1 }), draft({ path: 'data/pages/new.json', base_sha: null, content: '{}', name: '' })];
  const ops = operations(planMigration(s));
  assert.deepEqual(ops[0].values.slice(1, 4), [null, 1, SHA]);
  assert.equal(ops[1].values[3], null); assert.equal(ops[1].values[7], '');
  s.tables.drafts[0].base_sha = null; invalid(s, 'draft-state');
  s.tables.drafts[0] = draft({ content: null }); invalid(s, 'draft-state');
  s.tables.drafts[0] = draft({ deleted: 1 }); invalid(s, 'draft-state');
  s.tables.drafts[0] = draft({ content: '{broken}' }); invalid(s, 'json');
  s.tables.drafts[0] = draft({ path: 'data/shut.json' }); invalid(s, 'draft-path');
});

test('rejects duplicate primary keys and ambiguous storage keys', () => {
  for (const [table, row] of [
    ['drafts', draft()], ['log', log()], ['media', media({ status: 'uploading' })],
    ['ai_usage', { day: '2026-10-30', email: 'editor@example.com', n: 2 }],
    ['media_chunks', { id: 'abc12345', n: 0, data: Buffer.from('hello').toString('base64') }],
  ]) {
    const s = snapshot(); s.tables[table] = [row, { ...row }]; invalid(s, 'duplicate-key');
  }
  const s = snapshot(); s.tables.media = [media({ status: 'uploading' }), media({ id: 'other', status: 'uploading' })]; invalid(s, 'duplicate-key');
});

test('safe integer and time validation prevents numeric coercion and overflow', () => {
  for (const value of [Number.MAX_SAFE_INTEGER + 1, 1.5, -1, -0, '1700000000000', NaN, Infinity]) {
    const s = snapshot(); s.tables.drafts = [draft({ updated_at: value })]; invalid(s, 'integer');
  }
  const s = snapshot(); s.tables.drafts = [draft({ updated_at: 0 })]; invalid(s, 'draft-time');
  s.tables.drafts = [draft({ updated_at: Number.MAX_SAFE_INTEGER })];
  assert.equal(operations(planMigration(s))[0].values[5], Number.MAX_SAFE_INTEGER);
  assert.ok(planMigration(s).blockers.some((b) => b.code === 'draft-time-exhausted'));
  s.tables.log = [log({ id: Number.MAX_SAFE_INTEGER })];
  assert.equal(planMigration(s).readyToImport, false);
  assert.ok(planMigration(s).blockers.some((b) => b.code === 'log-id-exhausted'));
});

test('aggregate quota values also remain exact rather than overflowing safe integers', () => {
  const s = snapshot();
  s.tables.ai_usage = [{ day: '2026-10-30', email: 'one@example.com', n: Number.MAX_SAFE_INTEGER }, { day: '2026-10-30', email: 'two@example.com', n: 1 }];
  invalid(s, 'aggregate-overflow');
  s.tables.ai_usage = [];
  s.tables.media = [media({ status: 'published', size: Number.MAX_SAFE_INTEGER }), media({ id: 'other', key: 'site/media/other.txt', status: 'published' })];
  invalid(s, 'aggregate-overflow');
});

test('valid staged media preserves complete full/final chunks and photo keys', () => {
  const s = snapshot(), first = Buffer.alloc(393216, 65), final = Buffer.from('שלום');
  s.tables.media = [media({ size: first.length + final.length }), media({ id: 'photo', name: 'portrait/480.webp', kind: 'photo', mime: 'image/webp', size: 3, key: 'data/img/portrait/480.webp' })];
  s.tables.media_chunks = [
    { id: 'abc12345', n: 1, data: final.toString('base64') },
    { id: 'photo', n: 0, data: 'YWJj' },
    { id: 'abc12345', n: 0, data: first.toString('base64') },
  ];
  const plan = planMigration(s);
  assert.equal(plan.readyToImport, true);
  assert.deepEqual(operations(plan).filter((o) => o.table === 'media_chunks').map((o) => o.values), s.tables.media_chunks.map((r) => [r.id, r.n, r.data]));
  s.tables.media_chunks.pop(); invalid(s, 'incomplete-staged-media');
});

test('orphan, cross-storage, extra, malformed and truncated chunks fail closed', () => {
  const s = snapshot(); s.tables.media_chunks = [{ id: 'abc12345', n: 0, data: 'aGVsbG8=' }];
  invalid(s, 'orphan-chunk');
  s.tables.media = [media({ store: 'r2', status: 'published', key: 'file.txt' })]; invalid(s, 'chunk-state');
  s.tables.media = [media()]; s.tables.media_chunks[0].n = 1; invalid(s, 'chunk-size');
  s.tables.media_chunks[0].n = 0; s.tables.media_chunks[0].data = 'aGk='; invalid(s, 'chunk-size');
  s.tables.media_chunks[0].data = 'aGk'; invalid(s, 'chunk-base64');
  s.tables.media_chunks[0].data = 'aGm='; invalid(s, 'chunk-base64');
});

test('actual worker TXT content type keeps its charset parameter and rejects header injection', () => {
  const s = snapshot(); s.tables.media = [media({ status: 'published' })];
  const op = operations(planMigration(s))[0];
  assert.equal(op.values[3], 'text/plain; charset=utf-8');
  s.tables.media[0].mime = 'text/plain\r\nX-Untrusted: value'; invalid(s, 'mime');
  s.tables.media[0].mime = 'text/plain; charset=utf-8; unchecked=value'; invalid(s, 'mime');
});

test('active uploads, receiving and removing rows are retained but block import readiness', () => {
  const s = snapshot();
  s.tables.media = [media({ status: 'uploading' }), media({ id: 'receiving', store: 'r2', key: 'receiving.mp4', kind: 'video', mime: 'video/mp4', status: 'receiving' }), media({ id: 'removing', key: 'site/media/removing.txt', status: 'removing' })];
  s.tables.media_chunks = [{ id: 'abc12345', n: 0, data: 'aGVsbG8=' }];
  const plan = planMigration(s);
  assert.equal(plan.readyToImport, false);
  assert.deepEqual(plan.blockers.map((b) => b.code), ['media-uploading', 'media-receiving', 'media-removing']);
  assert.equal(plan.counts.media, 3); assert.equal(plan.counts.media_chunks, 1);
  assert.equal(operations(plan).filter((o) => o.table === 'media').length, 3);
  assert.equal(operations(plan).filter((o) => o.table === 'media_chunks').length, 1);
});

test('KV accepts only known shapes and keys, with exact legacy value retention', () => {
  const s = snapshot(); s.kv.editors = '[ "legacy@example.com" ]\n';
  assert.equal(operations(planMigration(s))[0].values[1], s.kv.editors);
  s.kv.secret = '"never silently import arbitrary keys"'; invalid(s, 'unknown-field');
  delete s.kv.secret; s.kv.people = '[{"email":"editor@example.com","name":"שם","publisher":"false"}]'; invalid(s, 'kv-role');
  s.kv.people = '[{"email":"editor@example.com","name":"שם","publisher":false},{"email":"editor@example.com","name":"אחר","publisher":true}]'; invalid(s, 'duplicate-key');
  delete s.kv.people; s.kv.editors = 'null'; invalid(s, 'kv-shape');
  s.kv.editors = '[]'; s.kv['owner-names'] = '{"plain-email@example.com":"שם"}'; invalid(s, 'kv-owner');
});

test('UTC day validation rejects impossible dates and unknown columns', () => {
  const s = snapshot(); s.tables.ai_usage = [{ day: '2024-02-29', email: 'editor@example.com', n: 4 }];
  assert.equal(planMigration(s).readyToImport, true);
  s.tables.ai_usage[0].day = '2025-02-29'; invalid(s, 'day');
  s.tables.ai_usage[0].day = '2024-02-29'; s.tables.ai_usage[0].extra = 'do not discard'; invalid(s, 'unknown-field');
});

test('byte/row budgets split transfer batches without changing values or commit policy', () => {
  const s = snapshot(); s.tables.drafts = Array.from({ length: 4 }, (_, i) => draft({ path: `data/pages/p${i}.json` }));
  const plan = planMigration(s, { maxRowsPerBatch: 2 });
  assert.deepEqual(plan.batches.map((b) => b.operations.length), [2, 2]);
  const budget = planMigration(s, { maxRowsPerBatch: 1 }).batches[0].estimatedBytes;
  const bytesPlan = planMigration(s, { maxBatchBytes: budget });
  assert.equal(bytesPlan.batches.length, 4);
  assert.ok(bytesPlan.batches.every((b) => b.estimatedBytes <= budget));
  const blocked = planMigration(s, { maxBatchBytes: 1 });
  assert.equal(blocked.readyToImport, false); assert.equal(operations(blocked).length, 4);
  assert.equal(blocked.blockers.filter((b) => b.code === 'row-over-batch-budget').length, 4);
  assert.ok(plan.preconditions.some((p) => p.includes('one transaction')));
});

test('Git contents and object bytes are external unverified dependencies, never implied imported', () => {
  const s = snapshot(); s.git = { repo: '148-gif/Web', branch: 'yaakov', commit: SHA };
  s.tables.media = [media({ store: 'r2', key: 'video.mp4', kind: 'video', mime: 'video/mp4', status: 'published' })];
  const plan = planMigration(s);
  assert.deepEqual(plan.externalDependencies.git.manifest, s.git);
  assert.equal(plan.externalDependencies.git.verified, false);
  assert.deepEqual(plan.externalDependencies.objects, [{ key: 'video.mp4', size: 5, mime: 'video/mp4', status: 'published', verified: false }]);
  assert.deepEqual(operations(plan).map((o) => o.table), ['media']);
  delete s.git; assert.equal(planMigration(s).externalDependencies.git.manifest, null);
});

test('schema is explicit MySQL 8.4 preparation; no permissive creation or destructive cleanup', () => {
  const sql = readFileSync(new URL('../server/mysql-schema.sql', import.meta.url), 'utf8');
  const executable = sql.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
  assert.equal((executable.match(/CREATE TABLE /g) || []).length, 8);
  assert.equal((executable.match(/COLLATE=utf8mb4_0900_bin/g) || []).length, 8);
  assert.doesNotMatch(executable, /IF NOT EXISTS|DROP TABLE|TRUNCATE|ON DELETE CASCADE|\bJSON\s+(?:NULL|NOT NULL)/);
  assert.match(executable, /scope VARCHAR\(80\)/);
  assert.match(executable, /clients MEDIUMTEXT/);
  assert.match(executable, /CREATE TABLE cms_locks/);
  assert.match(executable, /INSERT INTO cms_locks/);
  // This checks artifact intent only; it does not claim a MySQL engine ran it.
});
