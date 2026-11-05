import { test } from 'node:test';
import { mkdtemp,rm,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeMediaSchema } from '../server/mysql-media-schema.mjs';
import assert from 'node:assert/strict';
import { createMysqlKv } from '../server/mysql-kv.mjs';
import { mysqlEnabled, withMysqlDatabase } from './helpers/mysql.mjs';

const unavailable = () => { throw new Error('Database must not be reached'); };

test('MySQL KV validates keys, types and JSON before touching storage', async () => {
  const kv = createMysqlKv({ execute: unavailable, getConnection: unavailable });
  for (const key of ['', 'People', 'people ', 'session-secret', "people' OR 1=1"]) {
    await assert.rejects(kv.get(key), /Unsupported editor KV key/);
    await assert.rejects(kv.put(key, '[]'), /Unsupported editor KV key/);
    await assert.rejects(kv.update(key, () => '[]'), /Unsupported editor KV key/);
  }
  for (const value of [null, {}, [], '', '{broken', '"\ud800"']) await assert.rejects(kv.put('people', value), /Invalid editor KV/);
  await assert.rejects(kv.get('people', 'stream'), /Unsupported editor KV read type/);
  await assert.rejects(kv.update('people', '[]'), /updater is required/);
});

test('MySQL KV preserves original JSON bytes, Unicode and trailing whitespace', { skip: !mysqlEnabled }, async () => {
  await withMysqlDatabase(async ({ pool }) => {
    const kv = createMysqlKv(pool);
    assert.equal(await kv.get('people'), null);
    const value = ' [ { "email" : "editor@example.test", "name" : "שם 😀 é ", "publisher" : false } ]\n ';
    await kv.put('people', value);
    assert.equal(await kv.get('people'), value);
    assert.equal(await createMysqlKv(pool).get('people', { type: 'text' }), value);
    assert.deepEqual(await kv.get('people', 'json'), JSON.parse(value));
    const [rows] = await pool.query('SELECT `key`, value FROM editors_kv');
    assert.deepEqual(rows.map((row) => ({ ...row })), [{ key: 'people', value }]);
    await kv.put('people', '[]');
    assert.equal(await kv.get('people'), '[]');
  });
});

test('concurrent MySQL KV updates initialize once and retain every independent change', { skip: !mysqlEnabled }, async () => {
  await withMysqlDatabase(async ({ pool }) => {
    const kv = createMysqlKv(pool);
    let missing = 0;
    await Promise.all(Array.from({ length: 32 }, (_, i) => kv.update('people', (previous) => {
      if (previous === null) missing++;
      const people = previous === null ? [] : JSON.parse(previous);
      people.push({ email: `editor${i}@example.test`, name: `שם ${i}`, publisher: false });
      return JSON.stringify(people);
    })));
    assert.equal(missing, 1);
    const people = await kv.get('people', { type: 'json' });
    assert.equal(people.length, 32);
    assert.equal(new Set(people.map((person) => person.email)).size, 32);
    assert.ok(people.every((person) => person.publisher === false));
  });
});

test('MySQL KV update failures roll back creation and preserve existing exact text', { skip: !mysqlEnabled }, async () => {
  await withMysqlDatabase(async ({ pool }) => {
    const kv = createMysqlKv(pool);
    await assert.rejects(kv.update('people', () => { throw new Error('test rollback'); }), /test rollback/);
    assert.equal(await kv.get('people'), null, 'failed first update must not retain its null placeholder');
    await kv.put('people', ' []\n');
    await assert.rejects(kv.update('people', () => '{bad'), /Invalid editor KV JSON/);
    assert.equal(await kv.get('people'), ' []\n');
    await kv.put('owner-names', 'null');
    let previous;
    await kv.update('owner-names', (value) => { previous = value; return '{}'; });
    assert.equal(previous, 'null', 'an existing JSON null is not a missing key');
  });
});

test('atomic MySQL membership transforms do not resurrect a revoked editor', { skip: !mysqlEnabled }, async () => {
  await withMysqlDatabase(async ({ pool }) => {
    const kv = createMysqlKv(pool), email = 'editor@example.test';
    await kv.put('people', JSON.stringify([{ email, name: 'Before', publisher: true }]));
    await kv.update('people', () => '[]');
    await assert.rejects(kv.update('people', (previous) => {
      const people = JSON.parse(previous);
      if (!people.some((person) => person.email === email)) throw new Error('Membership revoked');
      return JSON.stringify(people.map((person) => person.email === email ? { ...person, name: 'After' } : person));
    }), /Membership revoked/);
    assert.equal(await kv.get('people'), '[]');
  });
});


test('transient media upload state persists through real MySQL and can be deleted without deleting membership', { skip: !mysqlEnabled }, async () => {
  await withMysqlDatabase(async ({ pool }) => {
    const backupPath = await mkdtemp(join(tmpdir(),'heichal-media-schema-'));
    try {
    const [checks] = await pool.execute("SELECT TABLE_NAME AS table_name,CONSTRAINT_NAME AS name FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=DATABASE() AND CONSTRAINT_TYPE='CHECK' AND TABLE_NAME IN ('media','editors_kv')");
    const [clauses] = await pool.execute("SELECT CONSTRAINT_NAME AS name,CHECK_CLAUSE AS clause FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE()");
    for (const [table,field,definition] of [['media','status',"status IN ('uploading','receiving','staged','published','removing')"],['editors_kv','key',"`key` IN ('people','editors','owner-names')"]]) {
      const found = checks.find(c => c.table_name === table && new RegExp('\\b' + field + '\\b').test(clauses.find(x => x.name === c.name).clause));
      assert.match(found.name,/^[A-Za-z0-9_]+$/);
      await pool.execute('ALTER TABLE ' + table + ' DROP CHECK `' + found.name + '`, ADD CONSTRAINT media_fixture_' + field + ' CHECK (' + definition + ')');
    }
    assert.equal((await initializeMediaSchema(pool,{backupPath})).installed,true);
    assert.equal((await initializeMediaSchema(pool,{backupPath})).alreadyInstalled,true);
    assert.equal(JSON.parse(await readFile(join(backupPath,'media-state-v2/before.json'),'utf8')).version,1);
    const kv = createMysqlKv(pool), key = 'media-upload:0123abcd';
    const state = { key:'0123abcd-file.pdf',size:94371841,email:'local:fixture',uploadId:'private-provider-upload-id',created:Date.now(),completing:false };
    await kv.put(key,JSON.stringify(state));
    assert.deepEqual(await createMysqlKv(pool).get(key,'json'),state);
    await kv.put('people','[]');
    await assert.rejects(kv.delete('people'),/transient media/);
    await kv.delete(key); assert.equal(await kv.get(key),null); assert.equal(await kv.get('people'),'[]');
    for (const invalid of ['media-upload:','media-upload:0123ABCD','media-upload:0123abcd-more']) await assert.rejects(kv.put(invalid,'{}'),/Unsupported editor KV key/);
    await pool.execute("INSERT INTO media (id,name,kind,mime,size,store,`key`,status,email,by_name,created_at) VALUES ('0123abcd','fixture','doc','application/pdf',94371841,'r2','0123abcd-file.pdf','finalizing','fixture@example.test','Fixture',0)");
    } finally { await rm(backupPath,{recursive:true,force:true}); }
  });
});
