import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createMysqlAuthStore } from '../server/mysql-auth-store.mjs';
import { normalizeLocalInvitation } from '../server/mysql-local-invitations-store.mjs';
import { createInitializedMysqlPool } from '../server/mysql-pool.mjs';
import { initializeLocalAuthSchema } from '../scripts/setup-local-auth.mjs';
import { initializeGoogleAuthSchema } from '../scripts/setup-google-auth.mjs';
import { initializeLocalInvitationsSchema, LocalInvitationsSetupError } from '../scripts/setup-local-invitations.mjs';
import { mysqlEnabled, withMysqlDatabase } from './helpers/mysql.mjs';

// Pre-install/opt-out CI must not resolve the optional MySQL driver.
const { createPool } = mysqlEnabled ? await import('mysql2/promise') : {};
const initialized = (pool) => createInitializedMysqlPool(pool);
const integration = (name, fn) => test(name, { skip: !mysqlEnabled }, () => withMysqlDatabase(fn));
const issuer = { id: 'a'.repeat(32), username: 'existing-owner', display_name: 'מנהל קיים', password_hash: 'test-only-noncredential-hash', owner_hash: 'b'.repeat(64), role: 'owner', version: 1, disabled: false };
const invitee = { ...issuer, id: 'c'.repeat(32), username: 'new-owner', display_name: 'מנהל נוסף', owner_hash: 'd'.repeat(64) };
const invitation = (changes = {}) => ({ owner_hash: invitee.owner_hash, token_hash: 'e'.repeat(64), issuer_id: issuer.id, issuer_version: 1, expires_at: 1794000000000, consumed: false, ...changes });
const session = { token_hash: 'f'.repeat(64), csrf_hash: '0'.repeat(64), user_id: issuer.id, version: issuer.version, expires_at: 1794000000000 };

async function setupBase(pool, database) {
  const plan = await initializeLocalAuthSchema(null);
  await initializeLocalAuthSchema(initialized(pool), { apply: true, targetDatabase: database, expectedSchemaSha256: plan.schemaSha256 });
  return createMysqlAuthStore(initialized(pool));
}
async function setupInvitations(pool, database) {
  const plan = await initializeLocalInvitationsSchema(null);
  await initializeLocalInvitationsSchema(initialized(pool), { apply: true, targetDatabase: database, expectedSchemaSha256: plan.schemaSha256 });
  return createMysqlAuthStore(initialized(pool), { localInvitations: true });
}
async function snapshotExisting(pool) {
  const result = {};
  for (const table of ['local_auth_settings', 'local_auth_users', 'local_auth_sessions', 'google_auth_config', 'log', 'editors_kv', 'cms_locks']) {
    const [rows] = await pool.query(`SELECT * FROM ${table} ORDER BY 1`);
    result[table] = rows;
  }
  return result;
}

test('Local invitation rows normalize exact private fields and reject unsafe or extra state', () => {
  assert.deepEqual(normalizeLocalInvitation(invitation({ issuer_version: '1', expires_at: '1794000000000', consumed: '0' })), invitation());
  for (const changes of [{ owner_hash: 'A'.repeat(64) }, { token_hash: 'secret' }, { issuer_id: 'a'.repeat(31) }, { issuer_version: 0 }, { issuer_version: Number.MAX_SAFE_INTEGER + 1 }, { expires_at: -0 }, { expires_at: '01' }, { expires_at: Infinity }, { consumed: 2 }, { consumed: 'false' }, { password: 'must-not-be-stored' }, { email: 'must-not-be-stored' }, { raw_token: 'must-not-be-stored' }]) {
    assert.throws(() => normalizeLocalInvitation(invitation(changes)), /Invalid local invitation state/);
  }
  for (const value of [null, [], {}, { ...invitation(), [Symbol('extra')]: 1 }]) assert.throws(() => normalizeLocalInvitation(value), /Invalid local invitation state/);
  const missing = invitation(); delete missing.token_hash;
  assert.throws(() => normalizeLocalInvitation(missing), /Invalid local invitation state/);
});

integration('Invitation addon is optional, fails closed without its table and retries readiness only after explicit setup', async ({ pool, database }) => {
  const base = await setupBase(pool, database);
  assert.equal((await base.ensureSchema()).schemaVerified, true);
  assert.equal(base.getInvitationByHash, undefined); assert.equal(base.getUserByOwnerHash, undefined);
  await base.atomic((tx) => { assert.equal(tx.getInvitationByHash, undefined); assert.equal(tx.saveInvitation, undefined); });
  const addon = createMysqlAuthStore(initialized(pool), { localInvitations: true });
  await assert.rejects(addon.ensureSchema(), /required local invitation table/);
  const [tables] = await pool.query("SHOW TABLES LIKE 'local_auth_invitations'"); assert.equal(tables.length, 0);
  await setupInvitations(pool, database);
  assert.equal((await addon.ensureSchema()).localInvitationsSchemaVerified, true);
  assert.equal(await addon.getInvitationByHash(invitation().token_hash), null);
  assert.equal(await addon.getUserByOwnerHash(invitee.owner_hash), null);
});

integration('Invitation setup adds only an empty table and preserves existing bootstrap, auth, Google, content and locks', async ({ pool, database }) => {
  const base = await setupBase(pool, database);
  const googlePlan = await initializeGoogleAuthSchema(null);
  await initializeGoogleAuthSchema(initialized(pool), { apply: true, targetDatabase: database, expectedSchemaSha256: googlePlan.schemaSha256 });
  await base.atomic(async (tx) => {
    await tx.insertUser(issuer); await tx.insertSession(session);
    await tx.saveSettings({ ...await tx.getSettings(), local_enabled: true, local_verified: true, bootstrap_consumed: true });
  });
  await pool.execute('INSERT INTO log (ts, action, summary) VALUES (?, ?, ?)', [1700000000000, 'existing', 'נשמר']);
  await pool.execute('INSERT INTO editors_kv (`key`, value) VALUES (?, ?)', ['people', '[]']);
  const before = await snapshotExisting(pool), [beforeTables] = await pool.query('SHOW TABLES');
  const store = await setupInvitations(pool, database);
  assert.equal((await store.ensureSchema()).localInvitationsSchemaVerified, true);
  assert.deepEqual(await snapshotExisting(pool), before);
  const [afterTables] = await pool.query('SHOW TABLES'); assert.equal(afterTables.length, beforeTables.length + 1);
  assert.equal((await createMysqlAuthStore(initialized(pool), { googleSetup: true, localInvitations: true }).ensureSchema()).googleSchemaVerified, true);
  assert.deepEqual(await store.getUserByOwnerHash(issuer.owner_hash), issuer);
  await assert.rejects(setupInvitations(pool, database), /already exists/);
  assert.deepEqual(await snapshotExisting(pool), before);
});

integration('Invitation replacement invalidates its old token; consumption is monotonic and tokens cannot cross owner slots', async ({ pool, database }) => {
  await setupBase(pool, database); const store = await setupInvitations(pool, database);
  await store.atomic((tx) => tx.saveInvitation(invitation()));
  assert.deepEqual(await store.getInvitationByHash(invitation().token_hash), invitation());
  for (const changes of [{ expires_at: 1794000000001 }, { issuer_version: 2 }, { issuer_id: '1'.repeat(32) }]) await assert.rejects(store.atomic((tx) => tx.saveInvitation(invitation(changes))), /Invalid local invitation state/);
  const rotated = invitation({ token_hash: '2'.repeat(64), expires_at: 1794000000001, issuer_version: 2 });
  await store.atomic((tx) => tx.saveInvitation(rotated));
  assert.equal(await store.getInvitationByHash(invitation().token_hash), null);
  assert.deepEqual(await store.getInvitationByHash(rotated.token_hash), rotated);
  await assert.rejects(store.atomic((tx) => tx.saveInvitation({ ...rotated, owner_hash: '3'.repeat(64) })));
  await store.atomic((tx) => tx.saveInvitation(invitation({ owner_hash: '3'.repeat(64), token_hash: '4'.repeat(64) })));
  await assert.rejects(store.atomic((tx) => tx.saveInvitation({ ...rotated, owner_hash: '3'.repeat(64) })));
  assert.deepEqual(await store.getInvitationByHash(rotated.token_hash), rotated);
  await store.atomic((tx) => tx.saveInvitation({ ...rotated, consumed: true }));
  await assert.rejects(store.atomic((tx) => tx.saveInvitation(rotated)), /Invalid local invitation state/);
  await assert.rejects(store.atomic((tx) => tx.saveInvitation(invitation())), /Invalid local invitation state/);
  assert.equal((await store.getInvitationByHash(rotated.token_hash)).consumed, true);
  await assert.rejects(store.atomic((tx) => tx.saveInvitation(invitation({ owner_hash: '5'.repeat(64), token_hash: '6'.repeat(64), consumed: true }))), /Invalid local invitation state/);
});

integration('Invitation consumption and user insertion roll back together, preserving the existing owner and session', async ({ pool, database }) => {
  const base = await setupBase(pool, database); const store = await setupInvitations(pool, database);
  await base.atomic(async (tx) => { await tx.insertUser(issuer); await tx.insertSession(session); });
  await store.atomic((tx) => tx.saveInvitation(invitation()));
  await assert.rejects(store.atomic(async (tx) => {
    await tx.insertUser(invitee); await tx.saveInvitation({ ...await tx.getInvitationByHash(invitation().token_hash), consumed: true });
    throw new Error('deliberate rollback');
  }), /deliberate rollback/);
  assert.equal(await store.getUserByOwnerHash(invitee.owner_hash), null);
  assert.equal((await store.getInvitationByHash(invitation().token_hash)).consumed, false);
  assert.deepEqual(await store.getUserByOwnerHash(issuer.owner_hash), issuer); assert.deepEqual(await store.getSession(session.token_hash), session);
  await store.atomic(async (tx) => { await tx.insertUser(invitee); await tx.saveInvitation({ ...await tx.getInvitationByHash(invitation().token_hash), consumed: true }); });
  assert.deepEqual(await store.getUserByOwnerHash(invitee.owner_hash), invitee);
  assert.equal((await store.getInvitationByHash(invitation().token_hash)).consumed, true);
});

integration('Independent pools serialize invitation acceptance so only one new user wins', async ({ pool, config, database }) => {
  await setupBase(pool, database); const first = await setupInvitations(pool, database), otherPool = createPool(config);
  const second = createMysqlAuthStore(initialized(otherPool), { localInvitations: true });
  try {
    await first.atomic((tx) => tx.saveInvitation(invitation()));
    const outcomes = await Promise.allSettled([first, second].map((store, index) => store.atomic(async (tx) => {
      const pending = await tx.getInvitationByHash(invitation().token_hash);
      if (!pending || pending.consumed || await tx.getUserByOwnerHash(pending.owner_hash)) throw new Error('Already consumed');
      await delay(10);
      await tx.insertUser({ ...invitee, id: String(index + 1).repeat(32), username: `new-owner-${index}` });
      await tx.saveInvitation({ ...pending, consumed: true });
    })));
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 1);
    assert.equal(await first.countUsers(), 1); assert.equal((await first.getInvitationByHash(invitation().token_hash)).consumed, true);
  } finally { await otherPool.end(); }
});

integration('Invitation transactions serialize with base credential changes and Google configuration across pools', async ({ pool, config, database }) => {
  await setupBase(pool, database); const first = await setupInvitations(pool, database), googlePlan = await initializeGoogleAuthSchema(null);
  await initializeGoogleAuthSchema(initialized(pool), { apply: true, targetDatabase: database, expectedSchemaSha256: googlePlan.schemaSha256 });
  const otherPool = createPool(config), base = createMysqlAuthStore(initialized(otherPool)), google = createMysqlAuthStore(initialized(otherPool), { googleSetup: true, localInvitations: true });
  let active = 0, maximum = 0;
  try {
    await first.atomic(async (tx) => { await tx.insertUser(issuer); await tx.insertSession(session); await tx.saveInvitation(invitation()); });
    await Promise.all(Array.from({ length: 12 }, (_, i) => [first, base, google][i % 3].atomic(async () => {
      active++; maximum = Math.max(maximum, active); try { await delay(5); } finally { active--; }
    })));
    assert.equal(maximum, 1);
    // Logout alone leaves the durable pending invitation. Handler rechecks live
    // issuer version/disabled/owner authorization at consumption, not its session.
    await base.atomic((tx) => tx.deleteSession(session.token_hash));
    assert.deepEqual(await first.getInvitationByHash(invitation().token_hash), invitation());
    await base.atomic((tx) => tx.saveUser({ ...issuer, version: 2, disabled: true }));
    assert.equal((await first.getUserById(issuer.id)).version, 2);
    assert.equal((await first.getUserByOwnerHash(issuer.owner_hash)).disabled, true);
    assert.equal((await first.getInvitationByHash(invitation().token_hash)).issuer_version, 1);
  } finally { await otherPool.end(); }
});

integration('Invitation schema verification rejects column, index and enforced-check drift without repair', async ({ pool, database }) => {
  await setupBase(pool, database); await setupInvitations(pool, database);
  const verify = () => createMysqlAuthStore(initialized(pool), { localInvitations: true }).ensureSchema();
  for (const [alter, restore, message] of [
    ['ALTER TABLE local_auth_invitations ADD raw_token TEXT NULL', 'ALTER TABLE local_auth_invitations DROP COLUMN raw_token', /columns/],
    ['ALTER TABLE local_auth_invitations MODIFY issuer_id CHAR(32) COLLATE utf8mb4_general_ci NOT NULL', 'ALTER TABLE local_auth_invitations MODIFY issuer_id CHAR(32) COLLATE utf8mb4_0900_bin NOT NULL', /columns/],
    ['ALTER TABLE local_auth_invitations DROP INDEX local_auth_invitation_token', 'ALTER TABLE local_auth_invitations ADD UNIQUE KEY local_auth_invitation_token (token_hash)', /indexes/],
    ['ALTER TABLE local_auth_invitations ALTER CHECK local_auth_invitation_consumed NOT ENFORCED', 'ALTER TABLE local_auth_invitations ALTER CHECK local_auth_invitation_consumed ENFORCED', /constraints/],
    ['ALTER TABLE local_auth_invitations DROP CHECK local_auth_invitation_version', 'ALTER TABLE local_auth_invitations ADD CONSTRAINT local_auth_invitation_version CHECK (issuer_version BETWEEN 1 AND 9007199254740991)', /constraints/],
  ]) { await pool.query(alter); await assert.rejects(verify(), message); await pool.query(restore); assert.equal((await verify()).localInvitationsSchemaVerified, true); }
  await pool.query('ALTER TABLE local_auth_invitations DROP CHECK local_auth_invitation_expiry');
  await pool.query('ALTER TABLE local_auth_invitations ADD CONSTRAINT local_auth_invitation_expiry CHECK (expires_at >= 0)');
  await assert.rejects(verify(), /constraints/);
});

integration('Invitation SQL checks enforce safe versions, expiry and boolean state', async ({ pool, database }) => {
  await setupBase(pool, database); const store = await setupInvitations(pool, database);
  await store.atomic((tx) => tx.saveInvitation(invitation()));
  for (const [field, value] of [['issuer_version', 0], ['issuer_version', Number.MAX_SAFE_INTEGER + 1], ['expires_at', 0], ['expires_at', -1], ['expires_at', Number.MAX_SAFE_INTEGER + 1], ['consumed', 2]]) await assert.rejects(pool.execute(`UPDATE local_auth_invitations SET ${field} = ?`, [value]));
  assert.deepEqual(await store.getInvitationByHash(invitation().token_hash), invitation());
});

integration('Invitation reads reject ambiguous existing owner identities and malformed persisted rows', async ({ pool, database }) => {
  await setupBase(pool, database); const store = await setupInvitations(pool, database);
  await store.atomic(async (tx) => { await tx.insertUser(issuer); await tx.insertUser({ ...issuer, id: invitee.id, username: invitee.username }); await tx.saveInvitation(invitation()); });
  await assert.rejects(store.getUserByOwnerHash(issuer.owner_hash), /Invalid local authentication state/);
  await assert.rejects(store.atomic((tx) => tx.getUserByOwnerHash(issuer.owner_hash)), /Invalid local authentication state/);
  await pool.execute('UPDATE local_auth_invitations SET issuer_id = ?', ['invalid']);
  await assert.rejects(store.getInvitationByHash(invitation().token_hash), /Invalid local invitation state/);
  await assert.rejects(store.getInvitationByHash("' OR 1=1"), /Invalid local invitation state/);
});

integration('Invitation transaction methods cannot be used after commit or rollback', async ({ pool, database }) => {
  await setupBase(pool, database); const store = await setupInvitations(pool, database); let escaped;
  await store.atomic((tx) => { escaped = tx; });
  for (const call of [() => escaped.getInvitationByHash(invitation().token_hash), () => escaped.getUserByOwnerHash(invitee.owner_hash), () => escaped.saveInvitation(invitation())]) await assert.rejects(call(), /transaction has ended/);
  await assert.rejects(store.atomic((tx) => { escaped = tx; throw new Error('rollback'); }), /rollback/);
  await assert.rejects(escaped.saveInvitation(invitation()), /transaction has ended/);
  assert.equal(await store.getInvitationByHash(invitation().token_hash), null);
});

integration('Invitation setup requires base schemas and refuses partial preexisting storage', async ({ pool, database }) => {
  await assert.rejects(setupInvitations(pool, database), /setup failed/);
  let [tables] = await pool.query("SHOW TABLES LIKE 'local_auth_invitations'"); assert.equal(tables.length, 0);
  await setupBase(pool, database);
  await pool.query('CREATE TABLE local_auth_invitations (owner_hash CHAR(64) PRIMARY KEY)');
  await assert.rejects(setupInvitations(pool, database), /already exists/);
  const [columns] = await pool.query('SHOW COLUMNS FROM local_auth_invitations'); assert.equal(columns.length, 1);
  await pool.query('DROP TABLE local_auth_invitations'); await pool.query('DROP TABLE log');
  await assert.rejects(setupInvitations(pool, database), /setup failed/);
  [tables] = await pool.query("SHOW TABLES LIKE 'local_auth_invitations'"); assert.equal(tables.length, 0);
});

integration('Invitation setup reports uncertain DDL safely and never retries or deletes its table', async ({ pool, database }) => {
  await setupBase(pool, database); const wrapped = initialized(pool), plan = await initializeLocalInvitationsSchema(null); let creates = 0;
  const faultPool = { async getConnection() {
    const c = await wrapped.getConnection();
    return { execute: (...args) => c.execute(...args), async query(sql) { creates++; await c.query(sql); throw new Error('private-do-not-log'); }, release: () => c.release(), destroy: () => c.destroy() };
  } };
  await assert.rejects(initializeLocalInvitationsSchema(faultPool, { apply: true, targetDatabase: database, expectedSchemaSha256: plan.schemaSha256 }), (error) => {
    assert.ok(error instanceof LocalInvitationsSetupError); assert.equal(error.state.statementsCompleted, 0); assert.equal(error.state.partialSchemaPossible, true);
    assert.equal(error.state.schemaInitialized, false); assert.equal(JSON.stringify({ message: error.message, state: error.state }).includes('private-do-not-log'), false); return true;
  });
  assert.equal(creates, 1); await assert.rejects(setupInvitations(pool, database), /already exists/);
  const [[row]] = await pool.query('SELECT COUNT(*) AS n FROM local_auth_invitations'); assert.equal(Number(row.n), 0);
});

integration('Invitation setup and readiness complete with exactly one available pool connection', async ({ config, database }) => {
  const single = createPool({ ...config, connectionLimit: 1 });
  try {
    await setupBase(single, database); const store = await setupInvitations(single, database);
    assert.equal((await store.ensureSchema()).localInvitationsSchemaVerified, true);
    await store.atomic((tx) => tx.saveInvitation(invitation()));
    assert.deepEqual(await store.getInvitationByHash(invitation().token_hash), invitation());
  } finally { await single.end(); }
});

integration('Competing invitation setup attempts admit exactly one creator', async ({ pool, config, database }) => {
  await setupBase(pool, database); const other = createPool({ ...config, connectionLimit: 1 });
  try {
    const outcomes = await Promise.allSettled([setupInvitations(pool, database), setupInvitations(other, database)]);
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 1);
    const store = createMysqlAuthStore(initialized(other), { localInvitations: true });
    assert.equal((await store.ensureSchema()).localInvitationsSchemaVerified, true);
    await store.atomic((tx) => tx.saveInvitation(invitation()));
    assert.deepEqual(await store.getInvitationByHash(invitation().token_hash), invitation());
  } finally { await other.end(); }
});

integration('Invitation setup reports completed DDL with failed verification as partial and never repairs it automatically', async ({ pool, database }) => {
  await setupBase(pool, database); const wrapped = initialized(pool), plan = await initializeLocalInvitationsSchema(null); let created = false;
  const faultPool = { async getConnection() {
    const c = await wrapped.getConnection();
    return {
      async execute(sql, ...args) { if (created && sql.startsWith('SELECT VERSION()')) throw new Error('private-verification-failure'); return c.execute(sql, ...args); },
      async query(sql) { const result = await c.query(sql); created = true; return result; },
      release: () => c.release(), destroy: () => c.destroy(),
    };
  } };
  await assert.rejects(initializeLocalInvitationsSchema(faultPool, { apply: true, targetDatabase: database, expectedSchemaSha256: plan.schemaSha256 }), (error) => {
    assert.ok(error instanceof LocalInvitationsSetupError); assert.equal(error.state.statementsCompleted, 1); assert.equal(error.state.partialSchemaPossible, true);
    assert.equal(error.state.schemaInitialized, false); assert.equal(error.message.includes('private-verification-failure'), false); return true;
  });
  await assert.rejects(setupInvitations(pool, database), /already exists/);
  // Only independent read-only verification may establish readiness after the
  // operator investigates this explicitly reported partial attempt.
  assert.equal((await createMysqlAuthStore(initialized(pool), { localInvitations: true }).ensureSchema()).localInvitationsSchemaVerified, true);
});
