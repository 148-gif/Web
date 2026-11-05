// One focused real-MySQL regression for direct creation, roles and mail tokens.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withMysqlDatabase,mysqlEnabled } from './helpers/mysql.mjs';
import { initializeLocalAuthSchema } from '../scripts/setup-local-auth.mjs';
import { initializeAccountsSchema } from '../scripts/setup-accounts.mjs';
import { createInitializedMysqlPool } from '../server/mysql-pool.mjs';
import { createMysqlAuthStore } from '../server/mysql-auth-store.mjs';
import { createLocalAuth } from '../server/local-auth.mjs';
import { hashPassword,digestToken,randomToken,csrfToken,verifyPassword } from '../server/local-auth-crypto.mjs';
import { openMail } from '../server/account-mail.mjs';
test('direct users have server roles; recovery is one-use and revokes old sessions',{skip:!mysqlEnabled},()=>withMysqlDatabase(async({pool:raw,database})=>{
 const pool=createInitializedMysqlPool(raw),temp=await mkdtemp(join(tmpdir(),'heichal-accounts-'));
 try{
  const plan=await initializeLocalAuthSchema(null);await initializeLocalAuthSchema(pool,{apply:true,targetDatabase:database,expectedSchemaSha256:plan.schemaSha256});
  await initializeAccountsSchema(pool,{backupPath:join(temp,'backup')});
  const store=createMysqlAuthStore(pool);await store.ensureSchema();assert.equal(store.accountsAvailable,true);
  const owner={id:'1'.repeat(32),username:'owner',display_name:'מנהל',password_hash:await hashPassword('12345678'),owner_hash:digestToken('owner@example.test'),role:'owner',version:1,disabled:false};
  const origin='https://accounts.example.test',env={OWNERS:[owner.owner_hash,digestToken('correct-owner@example.test')].join(','),SESSION_SECRET:'x'.repeat(32),ALLOWED_ORIGIN:origin,RATE_LIMIT_STORE:async()=>true};
  const config={env,publicOrigin:origin,apiBasePath:'/cms-api',googleEnabled:false,localAuthEnabled:true,staging:true};
  const token=randomToken(),csrf=csrfToken(token,env.SESSION_SECRET),cookie='__Host-heichal_local='+token;
  await store.atomic(async tx=>{await tx.insertUser(owner);await tx.saveSettings({...await tx.getSettings(),local_enabled:true,local_verified:true,bootstrap_consumed:true});await tx.insertSession({token_hash:digestToken(token),csrf_hash:digestToken(csrf),user_id:owner.id,version:1,expires_at:Date.now()+3600000});});
  const auth=createLocalAuth({store,config,accountsEnabled:true});
  async function call(path,body,session=cookie,extra={}){return auth.handle(new Request(origin+path,{method:body===undefined?'GET':'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:session,'X-CSRF-Token':csrf,...extra},...(body===undefined?{}:{body:JSON.stringify(body)})}),env,()=>Response.json({unexpected:true}));}
  let result=await call('/auth/users',{action:'create',username:'subscriber',displayName:'משתמש',email:'reader@example.test',role:'subscriber',password:'abcdefgh'});assert.equal(result.status,200,await result.clone().text());
  const user=await store.getUserByUsername('subscriber');assert.equal(user.role,'subscriber');assert(await verifyPassword('abcdefgh',user.password_hash));
  const [[mail]]=await pool.execute('SELECT payload FROM local_account_mail');const text=openMail(mail.payload,env.SESSION_SECRET).text;const match=/#(verify):([A-Za-z0-9_-]{43})/.exec(text);assert(match);
  const verified=await call('/auth/account',{purpose:match[1],token:match[2]},'');assert.equal(verified.status,200);
  assert.equal((await call('/auth/account',{purpose:match[1],token:match[2]},'')).status,400);
  const ownToken=randomToken(),ownCsrf=csrfToken(ownToken,env.SESSION_SECRET);
  await store.atomic(tx=>tx.insertSession({token_hash:digestToken(ownToken),csrf_hash:digestToken(ownCsrf),user_id:user.id,version:1,expires_at:Date.now()+3600000}));
  assert.equal((await call('/auth/users',undefined,'__Host-heichal_local='+ownToken)).status,403);
  assert.equal((await call('/gh/contents/data/site.json',undefined,'__Host-heichal_local='+ownToken)).status,403);
  assert.equal((await call('/auth/users',{action:'update',id:owner.id,role:'subscriber',disabled:true})).status,409);
  await call('/auth/recover',{email:'reader@example.test'},'');
  const [mails]=await pool.execute('SELECT payload FROM local_account_mail');const reset=mails.map(m=>openMail(m.payload,env.SESSION_SECRET).text).map(t=>/#password:([A-Za-z0-9_-]{43})/.exec(t)).find(Boolean);assert(reset);
  const changed=await call('/auth/account',{purpose:'password',token:reset[1],password:'87654321',confirmation:'87654321'},'');assert.equal(changed.status,200);
  assert.equal((await call('/auth/session',undefined,'__Host-heichal_local='+ownToken)).status,401);
  const beforeEdit=await store.getUserById(user.id);
  const edited=await call('/auth/users',{action:'update',id:user.id,username:user.username,displayName:'שם מתוקן',email:'updated-reader@example.test',role:'editor',disabled:false,password:''});
  assert.equal(edited.status,200,await edited.clone().text());const afterEdit=await store.getUserById(user.id);
  assert.equal(afterEdit.display_name,'שם מתוקן');assert.equal(afterEdit.role,'editor');assert.equal(afterEdit.password_hash,beforeEdit.password_hash);
  assert.equal((await store.getAccountProfile(user.id)).email,'updated-reader@example.test');
  const ownerBefore=await store.getUserById(owner.id);
  const ownEdit=await call('/auth/users',{action:'update',id:owner.id,username:owner.username,displayName:'הבעלים הנכון',email:'correct-owner@example.test',role:'owner',disabled:false,password:''});
  assert.equal(ownEdit.status,200,await ownEdit.clone().text());const rotated=await ownEdit.json();
  assert.equal(rotated.method,'local');assert.equal(rotated.user.name,'הבעלים הנכון');assert(ownEdit.headers.get('set-cookie'));
  const ownerAfter=await store.getUserById(owner.id);assert.equal(ownerAfter.password_hash,ownerBefore.password_hash);assert.equal(ownerAfter.owner_hash,digestToken('correct-owner@example.test'));
  assert.equal((await call('/auth/session')).status,401,'old owner cookie is revoked after identity correction');
  const newCookie=ownEdit.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('/auth/session',undefined,newCookie,{'X-CSRF-Token':rotated.csrfToken})).status,200);

 }finally{await rm(temp,{recursive:true,force:true});}
}));
