// Explicit one-time migration. Run privately with the active CMS_ENV_FILE.
// Existing users and credentials are preserved; rollback files stay private.
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readRuntimeEnvironmentFile } from '../server/runtime-env.mjs';
import { runtimeConfiguration } from '../server/runtime.mjs';
import { createInitializedMysqlPool } from '../server/mysql-pool.mjs';
import { createMysqlAuthStore } from '../server/mysql-auth-store.mjs';
import { verifyAccountsSchema } from '../server/mysql-accounts-store.mjs';
const envFile=process.env.CMS_ENV_FILE,backup=process.env.CMS_ACCOUNT_BACKUP;
if(!envFile||!backup||!backup.startsWith('/home/yoterber/heichal-cms/'))throw Error('Explicit private environment and backup path required');
const values=await readRuntimeEnvironmentFile({filePath:envFile,applicationRoot:process.env.CMS_APP_ROOT}),config=runtimeConfiguration(values);
const {createPool}=await import('mysql2/promise');const pool=createInitializedMysqlPool(createPool(config.mysql));
try {
 const ready=await verifyAccountsSchema(pool);
 if(ready){console.log(JSON.stringify({alreadyInstalled:true}));process.exitCode=0;}
 else{
  await mkdir(backup,{mode:0o700,recursive:false});
  const saved={version:1,created:new Date().toISOString(),tables:{}};
  for(const name of ['local_auth_settings','local_auth_users','local_auth_sessions']){
   const [rows]=await pool.execute('SELECT * FROM '+name);saved.tables[name]=rows;
  }
  const [checks]=await pool.execute("SELECT tc.CONSTRAINT_NAME AS name,cc.CHECK_CLAUSE AS clause FROM information_schema.TABLE_CONSTRAINTS tc JOIN information_schema.CHECK_CONSTRAINTS cc ON cc.CONSTRAINT_SCHEMA=tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME=tc.CONSTRAINT_NAME WHERE tc.TABLE_SCHEMA=DATABASE() AND tc.TABLE_NAME='local_auth_users' AND tc.CONSTRAINT_TYPE='CHECK'");
  const role=checks.filter(r=>/\brole\b/.test(r.clause));if(role.length!==1||!/^\w+$/.test(role[0].name))throw Error('Role constraint requires inspection');
  saved.checks=checks;await writeFile(join(backup,'local-auth-before.json'),JSON.stringify(saved),{mode:0o600,flag:'wx'});
  const sql=await readFile(new URL('../server/mysql-accounts-schema.sql',import.meta.url),'utf8');
  for(const statement of sql.replace(/^--.*$/gm,'').split(';').map(s=>s.trim()).filter(Boolean))await pool.execute(statement);
  await pool.execute('ALTER TABLE local_auth_users DROP CHECK '+role[0].name+", ADD CONSTRAINT local_account_role CHECK (role IN ('owner','administrator','editor','publisher','author','contributor','subscriber'))");
  const email='148148v@gmail.com',hash=createHash('sha256').update(email).digest('hex');
  await pool.execute('INSERT INTO local_account_profiles (user_id,email,verified) SELECT id,?,1 FROM local_auth_users WHERE owner_hash=? AND role=?',[email,hash,'owner']);
  await createMysqlAuthStore(pool).ensureSchema();
  console.log(JSON.stringify({installed:true,existingUsersPreserved:true}));
 }
}finally{await pool.end();}
