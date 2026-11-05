// Explicit, additive media-state migration. Runtime startup never executes DDL.
import { mkdir,writeFile,lstat } from 'node:fs/promises';
import { isAbsolute,join } from 'node:path';
const MEDIA_CHECK = "status IN ('uploading','receiving','finalizing','staged','published','removing')";
const KV_CHECK = "`key` IN ('people','editors','owner-names') OR (CHAR_LENGTH(`key`) = 21 AND `key` LIKE 'media-upload:________')";
export async function initializeMediaSchema(pool,{backupPath} = {}) {
  if (!isAbsolute(backupPath || '')) throw Error('An explicit private migration backup is required');
  const [checks] = await pool.execute("SELECT tc.TABLE_NAME AS table_name,tc.CONSTRAINT_NAME AS name,cc.CHECK_CLAUSE AS clause FROM information_schema.TABLE_CONSTRAINTS tc JOIN information_schema.CHECK_CONSTRAINTS cc ON cc.CONSTRAINT_SCHEMA=tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME=tc.CONSTRAINT_NAME WHERE tc.TABLE_SCHEMA=DATABASE() AND tc.TABLE_NAME IN ('media','editors_kv') AND tc.CONSTRAINT_TYPE='CHECK'");
  const find = (table,field) => {
    const rows = checks.filter(r => r.table_name === table && new RegExp('\\b' + field + '\\b','i').test(r.clause));
    if (rows.length !== 1 || !/^[A-Za-z0-9_]{1,64}$/.test(rows[0].name)) throw Error('Media constraints require inspection');
    return rows[0];
  };
  const media = find('media','status'), kv = find('editors_kv','key');
  const mediaReady = media.clause.includes('finalizing'), kvReady = kv.clause.includes('media-upload:');
  if (mediaReady && kvReady) return {alreadyInstalled:true};
  if (!['uploading','receiving','staged','published','removing'].every(v => media.clause.includes(v)) || !['people','editors','owner-names'].every(v => kv.clause.includes(v))) throw Error('Unknown media schema');
  const dir = join(backupPath,'media-state-v2');
  await mkdir(dir,{mode:0o700,recursive:true});
  const protectedDir = await lstat(dir);
  if (!protectedDir.isDirectory() || protectedDir.isSymbolicLink() || (protectedDir.mode & 0o077)) throw Error('Migration backup must be private');
  const saved = {version:1,created:new Date().toISOString(),checks,tables:{}};
  for (const table of ['media','media_chunks','editors_kv']) {
    const [rows] = await pool.execute('SELECT * FROM ' + table); saved.tables[table] = rows;
  }
  try { await writeFile(join(dir,'before.json'),JSON.stringify(saved),{mode:0o600,flag:'wx'}); }
  catch (error) { if (error.code !== 'EEXIST') throw error; const st = await lstat(join(dir,'before.json')); if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077)) throw new Error('Unsafe existing migration backup',{cause:error}); }
  // Each ALTER is atomic in MySQL. An interrupted migration can resume safely;
  // both expansions remain compatible with the prior application version.
  if (!mediaReady) await pool.execute('ALTER TABLE media DROP CHECK `' + media.name + '`, ADD CONSTRAINT heichal_media_status_v2 CHECK (' + MEDIA_CHECK + ')');
  if (!kvReady) await pool.execute('ALTER TABLE editors_kv DROP CHECK `' + kv.name + '`, ADD CONSTRAINT heichal_media_key_v2 CHECK (' + KV_CHECK + ')');
  return {installed:true,existingDataPreserved:true};
}
