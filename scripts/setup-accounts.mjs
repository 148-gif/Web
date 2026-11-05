// Explicit migration only. Startup and HTTP handlers never execute DDL.
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { digestToken } from '../server/local-auth-crypto.mjs';
import { managedEmail } from '../server/account-roles.mjs';
import { verifyAccountsSchema } from '../server/mysql-accounts-store.mjs';
export async function initializeAccountsSchema(pool,{backupPath,legacyOwnerEmail}={}) {
 if(!backupPath||!backupPath.startsWith('/'))throw Error('An explicit private backup directory is required');
 const ready=await verifyAccountsSchema(pool);
 const [checks]=await pool.execute("SELECT tc.CONSTRAINT_NAME AS name,cc.CHECK_CLAUSE AS clause FROM information_schema.TABLE_CONSTRAINTS tc JOIN information_schema.CHECK_CONSTRAINTS cc ON cc.CONSTRAINT_SCHEMA=tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME=tc.CONSTRAINT_NAME WHERE tc.TABLE_SCHEMA=DATABASE() AND tc.TABLE_NAME='local_auth_users' AND tc.CONSTRAINT_TYPE='CHECK'");
 const role=checks.filter(r=>/\brole\b/.test(r.clause));if(role.length!==1||!/^\w+$/.test(role[0].name))throw Error('Role constraint requires inspection');
 if(ready&&role[0].clause.includes('administrator'))return {alreadyInstalled:true};
 await mkdir(backupPath,{mode:0o700,recursive:false});
 const saved={version:1,created:new Date().toISOString(),tables:{},checks};
 for(const name of ['local_auth_settings','local_auth_users','local_auth_sessions']){
  const [rows]=await pool.execute('SELECT * FROM '+name);saved.tables[name]=rows;
 }
 await writeFile(join(backupPath,'local-auth-before.json'),JSON.stringify(saved),{mode:0o600,flag:'wx'});
 if(!ready){
  const sql=await readFile(new URL('../server/mysql-accounts-schema.sql',import.meta.url),'utf8');
  for(const statement of sql.replace(/^--.*$/gm,'').split(';').map(s=>s.trim()).filter(Boolean))await pool.execute(statement);
 }
 await pool.execute('ALTER TABLE local_auth_users DROP CHECK '+role[0].name+", ADD CONSTRAINT local_account_role CHECK (role IN ('owner','administrator','editor','publisher','author','contributor','subscriber'))");
 if(legacyOwnerEmail){
  const email=managedEmail(legacyOwnerEmail);if(!email)throw Error('Invalid owner email');
  await pool.execute('INSERT INTO local_account_profiles (user_id,email,verified) SELECT id,?,1 FROM local_auth_users WHERE owner_hash=? AND role=?',[email,digestToken(email),'owner']);
 }
 await verifyAccountsSchema(pool);
 return {installed:true,existingUsersPreserved:true};
}
async function main(){
 const {readRuntimeEnvironmentFile}=await import('../server/runtime-env.mjs'),{runtimeConfiguration}=await import('../server/runtime.mjs'),{createInitializedMysqlPool}=await import('../server/mysql-pool.mjs');
 const values=await readRuntimeEnvironmentFile({filePath:process.env.CMS_ENV_FILE,applicationRoot:process.env.CMS_APP_ROOT}),config=runtimeConfiguration(values);
 const {createPool}=await import('mysql2/promise'),pool=createInitializedMysqlPool(createPool(config.mysql));
 try{console.log(JSON.stringify(await initializeAccountsSchema(pool,{backupPath:process.env.CMS_ACCOUNT_BACKUP,legacyOwnerEmail:process.env.CMS_ACCOUNT_OWNER_EMAIL})));}finally{await pool.end();}
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)await main();
