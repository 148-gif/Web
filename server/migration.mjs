// Pure migration preparation: no filesystem, network, connection, or execution.
// Callers must treat snapshots AND returned SQL values as private editor data.
// A plan is not proof that a live D1 export was consistent or that MySQL accepted
// it. Only an importer with a verified, empty target may replay these operations.
const FORMAT = 'heichal-cms-snapshot';
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const MEDIUMTEXT_BYTES = 16777215;
const CHUNK_BYTES = 393216;
const COLUMNS = Object.freeze({
  drafts: ['path', 'content', 'deleted', 'base_sha', 'created_at', 'updated_at', 'email', 'name'],
  log: ['id', 'ts', 'email', 'name', 'action', 'path', 'summary', 'sha'],
  media: ['id', 'name', 'kind', 'mime', 'size', 'store', 'key', 'status', 'email', 'by_name', 'created_at'],
  media_chunks: ['id', 'n', 'data'],
  ai_usage: ['day', 'email', 'n'],
  editors_kv: ['key', 'value'],
});
const TABLES = Object.keys(COLUMNS).filter((t) => t !== 'editors_kv');
const KV_KEYS = ['people', 'editors', 'owner-names'];
// Every identifier comes from the fixed catalog above, never from the snapshot.
const INSERTS = Object.fromEntries(Object.entries(COLUMNS).map(([table, columns]) => [table,
  `INSERT INTO \`${table}\` (${columns.map((c) => `\`${c}\``).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
]));
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const own = (v, k) => Object.hasOwn(v, k);
const utf8Bytes = (v) => new TextEncoder().encode(v).length;
const sha = (v) => typeof v === 'string' && /^[0-9a-f]{40}$/.test(v);
const draftPath = (v) => /^data\/(pages\/|shut-edits\/)?[\w-]+\.json$/.test(v) && v !== 'data/shut.json';
const photoKey = (v) => /^data\/img\/[a-z0-9-]+\/(\d{3,4}|t\d{3})\.webp$/.test(v);
const mediaFile = (v) => /^[a-z0-9][\w.-]{0,100}$/.test(v);

export class MigrationValidationError extends Error {
  constructor(code, path, message) {
    super(`Invalid migration snapshot at ${path}: ${message}`);
    this.name = 'MigrationValidationError';
    this.errors = [{ code, path, message }];
  }
}
const reject = (code, path, message) => { throw new MigrationValidationError(code, path, message); };
function shape(value, required, optional, path) {
  if (!object(value)) reject('shape', path, 'expected an object');
  for (const key of required) if (!own(value, key)) reject('missing-field', `${path}.${key}`, 'required field is missing');
  if (Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))) reject('unknown-field', path, 'unknown field; no source columns may be silently discarded');
}
function text(value, path, { nullable = false, min = 0, max = MEDIUMTEXT_BYTES } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || !value.isWellFormed()) reject('text', path, 'expected well-formed Unicode text');
  // Worker character limits also count UTF-16 units. Avoid allocating a second
  // multi-million-element array just to validate a large preserved draft.
  if (value.length < min || value.length > max || utf8Bytes(value) > MEDIUMTEXT_BYTES) reject('text-size', path, 'text exceeds the target column bounds');
}
function integer(value, path, min = 0) {
  if (!Number.isSafeInteger(value) || value < min || Object.is(value, -0)) reject('integer', path, 'expected an exact, nonnegative JavaScript safe integer');
}
function email(value, path, nullable = false) {
  text(value, path, { nullable, max: 254, min: 1 });
  if (nullable && value === null) return;
  if (value !== value.trim().toLowerCase() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) reject('email', path, 'expected a normalized email address');
}
function enumeration(value, allowed, path) {
  if (!allowed.includes(value)) reject('enum', path, 'unsupported value');
}
function unique(seen, key, path) {
  if (seen.has(key)) reject('duplicate-key', path, 'duplicate primary or storage key');
  seen.add(key);
}
function parseJson(value, path) {
  try { return JSON.parse(value); }
  catch { reject('json', path, 'invalid JSON text'); }
}
function hash(value, path, nullable = true) {
  if (!(nullable && value === null) && !sha(value)) reject('sha', path, 'expected a lowercase Git SHA-1 or permitted null');
}
function validateRow(table, row, at) {
  shape(row, COLUMNS[table], [], at);
  if (table === 'drafts') {
    text(row.path, `${at}.path`, { max: 768, min: 1 });
    if (!draftPath(row.path)) reject('draft-path', `${at}.path`, 'path is outside the editable content set');
    enumeration(row.deleted, [0, 1], `${at}.deleted`);
    hash(row.base_sha, `${at}.base_sha`);
    text(row.content, `${at}.content`, { nullable: true });
    if (row.deleted ? row.content !== null || row.base_sha === null : row.content === null) reject('draft-state', at, 'deleted drafts require null content and a published base; other drafts require content');
    if (row.content !== null) {
      if (row.content.length > 2e6) reject('draft-size', `${at}.content`, 'draft exceeds the current worker content limit');
      parseJson(row.content, `${at}.content`);
    }
    integer(row.created_at, `${at}.created_at`); integer(row.updated_at, `${at}.updated_at`);
    if (row.updated_at < row.created_at) reject('draft-time', at, 'updated_at precedes created_at');
    email(row.email, `${at}.email`); text(row.name, `${at}.name`, { max: 40 });
  } else if (table === 'log') {
    integer(row.id, `${at}.id`, 1); integer(row.ts, `${at}.ts`);
    email(row.email, `${at}.email`, true); text(row.name, `${at}.name`, { nullable: true, max: 40 });
    text(row.action, `${at}.action`, { min: 1, max: 80 });
    text(row.path, `${at}.path`, { nullable: true }); text(row.summary, `${at}.summary`, { nullable: true });
    hash(row.sha, `${at}.sha`);
  } else if (table === 'media') {
    text(row.id, `${at}.id`, { min: 1, max: 128 });
    if (!/^[A-Za-z0-9_-]+$/.test(row.id)) reject('media-id', `${at}.id`, 'unsupported media reservation identifier');
    text(row.name, `${at}.name`, { min: 1 });
    enumeration(row.kind, ['photo', 'image', 'video', 'audio', 'doc'], `${at}.kind`);
    text(row.mime, `${at}.mime`, { min: 1, max: 100 });
    if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+(?:; charset=utf-8)?$/.test(row.mime)) reject('mime', `${at}.mime`, 'invalid media type or unsupported parameters');
    integer(row.size, `${at}.size`, 1);
    enumeration(row.store, ['github', 'r2'], `${at}.store`);
    text(row.key, `${at}.key`, { min: 1, max: 768 });
    const validKey = row.store === 'r2' ? mediaFile(row.key) : row.kind === 'photo' ? photoKey(row.key) : row.key.startsWith('site/media/') && mediaFile(row.key.slice(11));
    if (!validKey) reject('media-key', `${at}.key`, 'key does not match its media storage/type');
    enumeration(row.status, ['uploading', 'receiving', 'staged', 'published', 'removing'], `${at}.status`);
    if ((row.kind === 'photo' && row.store !== 'github') || (row.status === 'receiving' && row.store !== 'r2') || (row.status === 'staged' && row.store !== 'github')) reject('media-state', at, 'media storage and state are incompatible');
    email(row.email, `${at}.email`); text(row.by_name, `${at}.by_name`, { max: 40 }); integer(row.created_at, `${at}.created_at`);
  } else if (table === 'media_chunks') {
    text(row.id, `${at}.id`, { min: 1, max: 128 }); integer(row.n, `${at}.n`);
    text(row.data, `${at}.data`, { min: 1, max: CHUNK_BYTES / 3 * 4 });
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(row.data) || row.data.length % 4 !== 0 || Buffer.from(row.data, 'base64').toString('base64') !== row.data) reject('chunk-base64', `${at}.data`, 'chunk must be canonical base64');
  } else if (table === 'ai_usage') {
    text(row.day, `${at}.day`, { min: 10, max: 10 });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.day) || !Number.isFinite(Date.parse(`${row.day}T00:00:00Z`)) || new Date(`${row.day}T00:00:00Z`).toISOString().slice(0, 10) !== row.day) reject('day', `${at}.day`, 'expected a real UTC calendar day');
    email(row.email, `${at}.email`); integer(row.n, `${at}.n`);
  }
}
function validateKv(kv) {
  shape(kv, [], KV_KEYS, 'kv');
  for (const key of KV_KEYS.filter((k) => own(kv, k))) {
    const at = `kv.${key}`;
    text(kv[key], at); const value = parseJson(kv[key], at), seen = new Set();
    if (key === 'people' || key === 'editors') {
      if (!Array.isArray(value)) reject('kv-shape', at, 'expected a JSON array');
      value.forEach((person, i) => {
        const item = `${at}[${i}]`;
        if (key === 'people') {
          shape(person, ['email', 'name', 'publisher'], [], item);
          email(person.email, `${item}.email`); text(person.name, `${item}.name`, { max: 40 });
          if (typeof person.publisher !== 'boolean') reject('kv-role', `${item}.publisher`, 'expected an explicit boolean role');
          unique(seen, person.email, item);
        } else { email(person, item); unique(seen, person, item); }
      });
    } else {
      if (!object(value)) reject('kv-shape', at, 'expected a JSON object');
      for (const [owner, name] of Object.entries(value)) {
        if (!/^[0-9a-f]{64}$/.test(owner)) reject('kv-owner', at, 'owner-name keys must be SHA-256 hashes');
        text(name, at, { max: 40 });
      }
    }
  }
}

export function planMigration(snapshot, { maxBatchBytes = 8 * 1024 * 1024, maxRowsPerBatch = 100 } = {}) {
  integer(maxBatchBytes, 'options.maxBatchBytes', 1); integer(maxRowsPerBatch, 'options.maxRowsPerBatch', 1);
  shape(snapshot, ['format', 'version', 'tables', 'kv'], ['git'], 'snapshot');
  if (snapshot.format !== FORMAT || snapshot.version !== 1) reject('version', 'snapshot', 'unsupported snapshot format or version');
  shape(snapshot.tables, TABLES, [], 'tables');
  const counts = {}, blockers = [], rows = {}, primary = {
    drafts: (r) => r.path, log: (r) => r.id, media: (r) => r.id,
    media_chunks: (r) => JSON.stringify([r.id, r.n]), ai_usage: (r) => JSON.stringify([r.day, r.email]),
  };
  for (const table of TABLES) {
    if (!Array.isArray(snapshot.tables[table])) reject('table-shape', `tables.${table}`, 'required table must be an explicit array');
    const seen = new Set(); rows[table] = snapshot.tables[table]; counts[table] = rows[table].length;
    rows[table].forEach((row, i) => { const at = `tables.${table}[${i}]`; validateRow(table, row, at); unique(seen, primary[table](row), at); });
  }
  validateKv(snapshot.kv);
  rows.editors_kv = KV_KEYS.filter((key) => own(snapshot.kv, key)).map((key) => ({ key, value: snapshot.kv[key] }));
  counts.editors_kv = rows.editors_kv.length;
  const media = new Map(rows.media.map((r) => [r.id, r])), chunks = new Map(), storageKeys = new Set(), totals = new Map();
  const addTotal = (key, value, at) => {
    const total = totals.get(key) || 0;
    if (value > MAX_SAFE - total) reject('aggregate-overflow', at, 'aggregate exceeds exact JavaScript integer bounds');
    totals.set(key, total + value);
  };
  rows.ai_usage.forEach((row, i) => addTotal(`day:${row.day}`, row.n, `tables.ai_usage[${i}]`));
  rows.media_chunks.forEach((row, i) => {
    const at = `tables.media_chunks[${i}]`, parent = media.get(row.id);
    if (!parent) reject('orphan-chunk', at, 'chunk has no media reservation');
    if (parent.store !== 'github' || !['uploading', 'staged'].includes(parent.status)) reject('chunk-state', at, 'chunks require an uploading or staged GitHub reservation');
    const expected = Math.min(CHUNK_BYTES, parent.size - row.n * CHUNK_BYTES);
    if (row.n >= Math.ceil(parent.size / CHUNK_BYTES) || Buffer.from(row.data, 'base64').length !== expected) reject('chunk-size', at, 'chunk index or decoded length disagrees with its reservation');
    if (!chunks.has(row.id)) chunks.set(row.id, []);
    chunks.get(row.id).push(row);
  });
  rows.media.forEach((row, i) => {
    const at = `tables.media[${i}]`;
    unique(storageKeys, JSON.stringify([row.store, row.key]), at);
    if (row.store === 'r2' || row.status !== 'removing') addTotal(`media:${row.store}`, row.size, at);
    if (['uploading', 'receiving', 'removing'].includes(row.status)) blockers.push({ code: `media-${row.status}`, path: at, message: 'Resolve or explicitly reconcile this active media operation in the source before taking a new snapshot. Its data is retained in this plan.' });
    if (row.status === 'staged' && (chunks.get(row.id) || []).length !== Math.ceil(row.size / CHUNK_BYTES)) reject('incomplete-staged-media', at, 'staged GitHub media is missing chunks');
  });
  let git = null;
  if (own(snapshot, 'git')) {
    shape(snapshot.git, ['repo', 'branch', 'commit'], [], 'git');
    text(snapshot.git.repo, 'git.repo', { min: 3, max: 200 }); text(snapshot.git.branch, 'git.branch', { min: 1, max: 768 });
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(snapshot.git.repo)) reject('git-repo', 'git.repo', 'expected owner/repository');
    hash(snapshot.git.commit, 'git.commit', false); git = { ...snapshot.git };
  }
  const batches = []; let batch = { estimatedBytes: 0, operations: [] };
  const flush = () => { if (batch.operations.length) batches.push(batch); batch = { estimatedBytes: 0, operations: [] }; };
  for (const table of Object.keys(COLUMNS)) {
    rows[table].forEach((row, i) => {
      const operation = { table, sql: INSERTS[table], values: COLUMNS[table].map((c) => row[c]) };
      // Conservative JSON transfer estimate, not a MySQL packet-size guarantee.
      const bytes = utf8Bytes(JSON.stringify(operation)) + 128;
      if (batch.operations.length && (batch.estimatedBytes + bytes > maxBatchBytes || batch.operations.length >= maxRowsPerBatch)) flush();
      if (bytes > maxBatchBytes) blockers.push({ code: 'row-over-batch-budget', path: `tables.${table}[${i}]`, message: 'One preserved row exceeds the configured byte budget; verify server packet limits and choose an explicit larger budget.' });
      batch.operations.push(operation); batch.estimatedBytes += bytes;
    });
  }
  flush();
  if (rows.log.some((row) => row.id === MAX_SAFE)) blockers.push({ code: 'log-id-exhausted', path: 'tables.log', message: 'The next activity-log ID would exceed the JavaScript safe-integer limit.' });
  if (rows.drafts.some((row) => row.updated_at === MAX_SAFE)) blockers.push({ code: 'draft-time-exhausted', path: 'tables.drafts', message: 'The next draft revision would exceed the JavaScript safe-integer limit.' });
  return {
    format: 'heichal-cms-migration-plan', version: 1, target: 'mysql-8.4-or-newer', readyToImport: blockers.length === 0,
    counts, blockers, batches,
    resetTables: ['request_limits'],
    preconditions: [
      'Take a complete, consistent D1/KV snapshot with source writes paused; this validator cannot establish export consistency.',
      'Verify MySQL 8.4+, the reviewed schema, utf8mb4_0900_bin NO_PAD semantics, packet limits, and an empty target.',
      'Replay the parameterized row operations in one transaction; batches bound transfer size, not commit boundaries. Roll back the entire import on failure.',
      'Read back every column and compare exact values, primary keys, counts, and hashes before cutover. Check the next log AUTO_INCREMENT value.',
      'Transient request_limits is explicitly initialized empty; this format cannot discard an existing limiter export.',
      'Verify the external Git revision, object bytes and metadata, public URLs, backups, and rollback plan independently before deployment.',
    ],
    externalDependencies: {
      git: { manifest: git, verified: false, message: 'Published JSON, photo files, small media, and revision history remain in Git; they are not database rows.' },
      objects: rows.media.filter((row) => row.store === 'r2').map((row) => ({ key: row.key, size: row.size, mime: row.mime, status: row.status, verified: false })),
    },
  };
}
