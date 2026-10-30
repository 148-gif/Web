// Named storage operations shared by the Worker and Node runtimes. The D1
// implementation keeps its native SQL; a Node adapter implements these same
// operations with MySQL transactions, never by rewriting arbitrary SQL strings.
const stores = new WeakMap();
const marks = (n) => Array.from({ length: n }, () => '?').join(',');
const DRAFT_MATCH = '(path = ? AND content IS ? AND deleted = ? AND base_sha IS ? AND created_at = ? AND updated_at = ? AND email = ? AND name = ?)';
const draftValues = (r) => [r.path, r.content, r.deleted, r.base_sha, r.created_at, r.updated_at, r.email, r.name];

export function getDataStore(env) {
  if (env.DATA_STORE !== undefined) {
    if (!env.DATA_STORE || typeof env.DATA_STORE.ensureSchema !== 'function') throw new TypeError('Invalid data store');
    return env.DATA_STORE;
  }
  if (!stores.has(env.DB)) stores.set(env.DB, createD1DataStore(env.DB));
  return stores.get(env.DB);
}

export function createD1DataStore(db) {
  let ready;
  const statement = (sql, values) => values.length ? db.prepare(sql).bind(...values) : db.prepare(sql);
  const all = async (sql, values = []) => (await statement(sql, values).all()).results;
  const first = (sql, values = []) => statement(sql, values).first();
  const run = (sql, values = []) => statement(sql, values).run();
  return {
    ensureSchema() {
      if (!ready) ready = db.batch([
        db.prepare('CREATE TABLE IF NOT EXISTS drafts (path TEXT PRIMARY KEY, content TEXT, deleted INTEGER NOT NULL DEFAULT 0, base_sha TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, email TEXT NOT NULL, name TEXT NOT NULL)'),
        db.prepare('CREATE TABLE IF NOT EXISTS log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, email TEXT, name TEXT, action TEXT NOT NULL, path TEXT, summary TEXT, sha TEXT)'),
        db.prepare('CREATE INDEX IF NOT EXISTS log_ts ON log (ts)'),
        db.prepare('CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, store TEXT NOT NULL, key TEXT NOT NULL, status TEXT NOT NULL, email TEXT NOT NULL, by_name TEXT NOT NULL, created_at INTEGER NOT NULL)'),
        db.prepare('CREATE TABLE IF NOT EXISTS media_chunks (id TEXT NOT NULL, n INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (id, n))'),
        db.prepare('CREATE TABLE IF NOT EXISTS ai_usage (day TEXT NOT NULL, email TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, email))'),
      ]).catch((error) => { ready = undefined; throw error; });
      return ready;
    },
    appendLog(row) {
      return run('INSERT INTO log (ts, email, name, action, path, summary, sha) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [row.ts, row.email, row.name, row.action, row.path, row.summary, row.sha]);
    },
    getDraft: (path) => first('SELECT * FROM drafts WHERE path = ?', [path]),
    async consumeAiQuota({ day, email, perUser, perDay }) {
      return !!(await first(`INSERT INTO ai_usage (day, email, n)
    SELECT ?, ?, 1
    WHERE COALESCE((SELECT n FROM ai_usage WHERE day = ? AND email = ?), 0) < ?
      AND (SELECT COALESCE(SUM(n), 0) FROM ai_usage WHERE day = ?) < ?
    ON CONFLICT(day, email) DO UPDATE SET n = ai_usage.n + 1 RETURNING n`,
      [day, email, day, email, perUser, day, perDay]));
    },
    mediaUsage: () => all("SELECT store, COALESCE(SUM(size), 0) AS n, COUNT(*) AS c FROM media WHERE status != 'removing' OR store = 'r2' GROUP BY store"),
    expireMedia(before) {
      // The batch is one transaction. Receiving/removing rows may still own an
      // object and cannot be released merely because they are old.
      return db.batch([
        db.prepare("DELETE FROM media_chunks WHERE id IN (SELECT id FROM media WHERE status = 'uploading' AND created_at < ?)").bind(before),
        db.prepare("DELETE FROM media WHERE status = 'uploading' AND created_at < ?").bind(before),
      ]);
    },
    reserveMedia({ item, actor, now, limits: lim }) {
      return first(`WITH requested AS (
    SELECT ? AS id, ? AS name, ? AS kind, ? AS mime, ? AS size,
      ? AS github_key, ? AS r2_key, ? AS email, ? AS by_name, ? AS created_at
  ), usage AS (
    SELECT COALESCE(SUM(CASE WHEN store = 'github' AND status != 'removing' THEN size ELSE 0 END), 0) AS github,
      COALESCE(SUM(CASE WHEN store = 'r2' THEN size ELSE 0 END), 0) AS r2 FROM media
  ), choice AS (
    SELECT requested.*, CASE
      WHEN ? AND size <= ? AND size <= ? - github THEN 'github'
      WHEN ? AND size <= ? AND size <= ? - r2 THEN 'r2'
      END AS selected FROM requested CROSS JOIN usage
  ) INSERT INTO media (id, name, kind, mime, size, store, key, status, email, by_name, created_at)
    SELECT id, name, kind, mime, size, selected,
      CASE WHEN selected = 'github' THEN github_key ELSE r2_key END,
      'uploading', email, by_name, created_at FROM choice
    WHERE selected IS NOT NULL AND (? = 0 OR NOT EXISTS (
      SELECT 1 FROM media WHERE key = choice.github_key AND status != 'removing'
    )) RETURNING id, store`,
      [item.id, item.name, item.kind, item.mime, item.size, item.githubKey, item.r2Key, actor.email, actor.name, now,
        item.kind !== 'video' ? 1 : 0, lim.ghFile, lim.ghTotal,
        lim.r2 && item.kind !== 'photo' ? 1 : 0, lim.r2File, lim.r2Total, item.kind === 'photo' ? 1 : 0]);
    },
    hasActiveMediaKey: async (key) => !!(await first("SELECT 1 AS x FROM media WHERE key = ? AND status != 'removing'", [key])),
    getMedia: (id) => first('SELECT * FROM media WHERE id = ?', [id]),
    async writeMediaChunk({ id, n, data, email }) {
      return !!(await first("INSERT INTO media_chunks (id, n, data) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM media WHERE id = ? AND status = 'uploading' AND email = ? AND store = 'github') ON CONFLICT(id, n) DO UPDATE SET data = excluded.data WHERE media_chunks.data = excluded.data RETURNING id", [id, n, data, id, email]));
    },
    async dropUploading(id) {
      // Late chunks require this row, so remove the reservation first.
      const removed = await first("DELETE FROM media WHERE id = ? AND status = 'uploading' RETURNING id", [id]);
      if (removed) await run('DELETE FROM media_chunks WHERE id = ?', [id]);
    },
    getUploadChunks: (id) => all('SELECT n, LENGTH(data) AS len, data FROM media_chunks WHERE id = ? ORDER BY n', [id]),
    finishGithubUpload: async (id, email) => !!(await first("UPDATE media SET status = 'staged' WHERE id = ? AND status = 'uploading' AND email = ? RETURNING id", [id, email])),
    claimR2Upload: async (id, email) => !!(await first("UPDATE media SET status = 'receiving' WHERE id = ? AND status = 'uploading' AND email = ? AND store = 'r2' RETURNING id", [id, email])),
    finishR2Upload: async (id) => !!(await first("UPDATE media SET status = 'published' WHERE id = ? AND status = 'receiving' RETURNING id", [id])),
    resetR2Upload: (id) => run("UPDATE media SET status = 'uploading' WHERE id = ? AND status = 'receiving'", [id]),
    dropMedia: (id) => db.batch([
      db.prepare('DELETE FROM media_chunks WHERE id = ?').bind(id),
      db.prepare('DELETE FROM media WHERE id = ?').bind(id),
    ]),
    listMedia: () => all("SELECT * FROM media WHERE status IN ('staged', 'published', 'removing') AND kind != 'photo' ORDER BY created_at DESC"),
    claimMediaRemoval: async (id, status) => !!(await first("UPDATE media SET status = 'removing' WHERE id = ? AND status = ? RETURNING id", [id, status])),
    markGithubRemoval: (id, actor, now) => run("UPDATE media SET status = 'removing', email = ?, by_name = ?, created_at = ? WHERE id = ?", [actor.email, actor.name, now, id]),
    listDraftChildren: (dir) => all('SELECT path, deleted, content FROM drafts WHERE path LIKE ?', [`${dir}/%`]),
    async clearDraftSnapshot(path, expected) {
      return !!(await (expected
        ? first(`DELETE FROM drafts WHERE ${DRAFT_MATCH} RETURNING path`, draftValues(expected))
        : first('SELECT 1 AS unchanged WHERE NOT EXISTS (SELECT 1 FROM drafts WHERE path = ?)', [path])));
    },
    async writeDraftSnapshot(next, expected) {
      return !!(await (expected
        ? first(`UPDATE drafts SET content = ?, deleted = ?, updated_at = ?, email = ?, name = ? WHERE ${DRAFT_MATCH} RETURNING path`,
          [next.content, next.deleted, next.updated_at, next.email, next.name, ...draftValues(expected)])
        : first('INSERT INTO drafts (path, content, deleted, base_sha, created_at, updated_at, email, name) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(path) DO NOTHING RETURNING path', draftValues(next))));
    },
    listDrafts: () => all('SELECT * FROM drafts ORDER BY updated_at DESC'),
    getDrafts: (paths) => paths.length ? all(`SELECT * FROM drafts WHERE path IN (${marks(paths.length)})`, paths) : Promise.resolve([]),
    listPendingMedia: (keys) => keys === undefined
      ? all("SELECT * FROM media WHERE store = 'github' AND status IN ('staged', 'removing') ORDER BY created_at DESC")
      : keys.length ? all(`SELECT * FROM media WHERE store = 'github' AND status IN ('staged', 'removing') AND key IN (${marks(keys.length)})`, keys) : Promise.resolve([]),
    getPublishChunks: (id) => all('SELECT data FROM media_chunks WHERE id = ? ORDER BY n', [id]),
    async cleanupPublishedDrafts(rows) {
      const cleanup = [];
      // Twelve complete snapshots use 96 of D1's 100 bound parameters.
      for (let i = 0; i < rows.length; i += 12) {
        const group = rows.slice(i, i + 12);
        cleanup.push(db.prepare(`DELETE FROM drafts WHERE ${group.map(() => DRAFT_MATCH).join(' OR ')}`).bind(...group.flatMap(draftValues)));
      }
      if (cleanup.length) await db.batch(cleanup);
    },
    async finishPublishedMedia(row) {
      await run('DELETE FROM media_chunks WHERE id = ?', [row.id]);
      if (row.status === 'staged') await run("UPDATE media SET status = 'published' WHERE id = ?", [row.id]);
      else await run('DELETE FROM media WHERE id = ?', [row.id]);
    },
    discardDrafts: (paths) => paths.length ? run(`DELETE FROM drafts WHERE path IN (${marks(paths.length)})`, paths) : Promise.resolve(),
    restorePublishedMedia: (id) => run("UPDATE media SET status = 'published' WHERE id = ?", [id]),
    async getStagedChunk(id, n) {
      const row = await first("SELECT 1 AS x FROM media WHERE id = ? AND status = 'staged'", [id]);
      return row ? first('SELECT data FROM media_chunks WHERE id = ? AND n = ?', [id, n]) : null;
    },
    listLog: ({ before, limit }) => all(`SELECT id, ts, email, name, action, path, summary, sha FROM log ${before ? 'WHERE id < ?' : ''} ORDER BY id DESC LIMIT ?`, before ? [before, limit] : [limit]),
    listDraftPaths: async () => (await all('SELECT path FROM drafts')).map((row) => row.path),
    listPendingMediaKeys: async () => (await all("SELECT key FROM media WHERE store = 'github' AND status IN ('staged', 'removing')")).map((row) => row.key),
  };
}
