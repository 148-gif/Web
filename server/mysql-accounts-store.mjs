import { queryRows, withTransaction } from './mysql-core.mjs';
const ID = /^[a-f0-9]{32}$/, HASH = /^[a-f0-9]{64}$/;
const check = (s, re) => { if (typeof s !== 'string' || !re.test(s)) throw Error('Invalid account identifier'); return s; };
export async function verifyAccountsSchema(pool) {
 const rows = await queryRows(pool, "SELECT TABLE_NAME AS name, ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('local_account_profiles','local_account_tokens','local_account_mail','local_content_owners')");
 if (!rows.length) return false;
 if (rows.length !== 4 || rows.some(r => r.engine !== 'InnoDB')) throw Error('Incomplete account schema');
 // Fixed projections also verify that every required column exists.
 await pool.execute('SELECT user_id,email,verified FROM local_account_profiles LIMIT 0');
 await pool.execute('SELECT token_hash,user_id,purpose,version,expires_at FROM local_account_tokens LIMIT 0');
 await pool.execute('SELECT id,payload,attempts,available_at,lease_until,sent_at,created_at FROM local_account_mail LIMIT 0');
 await pool.execute('SELECT path,user_id FROM local_content_owners LIMIT 0');
 return true;
}
export function accountMethods(c, guard = () => {}) {
 return {
  async listAccounts() { guard(); return queryRows(c, 'SELECT u.id,u.username,u.display_name,u.role,u.version,u.disabled,p.email,p.verified FROM local_auth_users u LEFT JOIN local_account_profiles p ON p.user_id=u.id ORDER BY u.username LIMIT 1000'); },
  async getAccountProfile(id) { guard(); return (await queryRows(c, 'SELECT user_id,email,verified FROM local_account_profiles WHERE user_id=?', [check(id,ID)]))[0] || null; },
  async getAccountByEmail(email) { guard(); return (await queryRows(c, 'SELECT user_id FROM local_account_profiles WHERE email=?', [email]))[0] || null; },
  async saveAccountProfile(id,email,verified) { guard(); if (await this.getAccountProfile(id)) await c.execute('UPDATE local_account_profiles SET email=?,verified=? WHERE user_id=?',[email,Number(verified),check(id,ID)]); else await c.execute('INSERT INTO local_account_profiles (user_id,email,verified) VALUES (?,?,?)',[check(id,ID),email,Number(verified)]); },
  async getAccountToken(hash) { guard(); return (await queryRows(c, 'SELECT token_hash,user_id,purpose,version,expires_at FROM local_account_tokens WHERE token_hash=?', [check(hash,HASH)]))[0] || null; },
  async deleteAccountTokens(id,purpose) { guard(); await c.execute('DELETE FROM local_account_tokens WHERE user_id=? AND purpose=?', [check(id,ID),purpose]); },
  async insertAccountToken(t) { guard(); await c.execute('INSERT INTO local_account_tokens (token_hash,user_id,purpose,version,expires_at) VALUES (?,?,?,?,?)', [check(t.hash,HASH),check(t.userId,ID),t.purpose,t.version,t.expires]); },
  async enqueueAccountMail(m) { guard(); await c.execute('INSERT INTO local_account_mail (id,payload,available_at,created_at) VALUES (?,?,?,?)',[check(m.id,ID),m.payload,m.now,m.now]); },
  async contentOwner(path) { guard(); return (await queryRows(c, 'SELECT user_id FROM local_content_owners WHERE path=?',[path]))[0]?.user_id || null; },
  async claimContent(path,id) { guard(); await c.execute('INSERT INTO local_content_owners (path,user_id) VALUES (?,?)',[path,check(id,ID)]); }
 };
}
export function createMailQueue(pool) {
 return {
  async claim(now) { return withTransaction(pool, async c => {
   const r=(await queryRows(c,'SELECT id,payload,attempts,created_at FROM local_account_mail WHERE sent_at=0 AND available_at<=? AND lease_until<=? AND attempts<8 ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED',[now,now]))[0];
   if (!r) return null;
   await c.execute('UPDATE local_account_mail SET lease_until=?,attempts=attempts+1 WHERE id=?',[now+120000,r.id]); return r;
  }); },
  async done(id,now) { await pool.execute('UPDATE local_account_mail SET sent_at=?,payload=?,lease_until=0 WHERE id=?',[now,'',id]); },
  async retry(id,now,attempt) { await pool.execute('UPDATE local_account_mail SET available_at=?,lease_until=0 WHERE id=?',[now+Math.min(3600000,30000*2**attempt),id]); },
  async prune(now) { await pool.execute('DELETE FROM local_account_mail WHERE sent_at>0 AND sent_at<?',[now-7*86400000]); await pool.execute('DELETE FROM local_account_tokens WHERE expires_at<?',[now]); }
 };
}
