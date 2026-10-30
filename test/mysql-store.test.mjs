import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRow, safeInteger, withTransaction } from '../server/mysql-core.mjs';

test('MySQL numeric conversion preserves exact IDs and rejects precision loss', () => {
  assert.equal(safeInteger('9007199254740991'), Number.MAX_SAFE_INTEGER);
  for (const value of ['9007199254740992', 9007199254740992, '-1', -1, -0, '', null, '1.0', '01', NaN, Infinity]) assert.throws(() => safeInteger(value), RangeError);
  assert.deepEqual(normalizeRow({ id: 'abcdef12', size: '12', n: '0', content: '123' }), { id: 'abcdef12', size: 12, n: 0, content: '123' });
  assert.deepEqual(normalizeRow({ id: '12' }, ['id']), { id: 12 });
});

test('transaction rollback is awaited and callback is not retried', async () => {
  const calls = [], fail = new Error('deliberate failure');
  const connection = {
    async query(sql) { calls.push(sql); }, async beginTransaction() { calls.push('begin'); },
    async commit() { calls.push('commit'); }, async rollback() { calls.push('rollback'); },
    release() { calls.push('release'); }, destroy() { calls.push('destroy'); },
  };
  await assert.rejects(withTransaction({ getConnection: async () => connection }, async () => { calls.push('work'); throw fail; }), (error) => error === fail);
  assert.deepEqual(calls, ['SET TRANSACTION ISOLATION LEVEL READ COMMITTED', 'begin', 'work', 'rollback', 'release']);
});

test('a failed rollback destroys the session instead of returning it to the pool', async () => {
  let released = false, destroyed = false;
  const connection = {
    async query() {}, async beginTransaction() {}, async rollback() { throw new Error('connection lost'); },
    release() { released = true; }, destroy() { destroyed = true; },
  };
  await assert.rejects(withTransaction({ getConnection: async () => connection }, async () => { throw new Error('original error'); }), /original error/);
  assert.equal(released, false); assert.equal(destroyed, true);
});
