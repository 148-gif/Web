import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeJsonText } from '../cms-worker/json-merge.mjs';

const j = JSON.stringify;
const m = (b, l, d) => { const r = mergeJsonText(j(b), j(l), j(d)); return r === null ? null : JSON.parse(r); };

test('fields changed on different sides are both kept', () => {
  assert.deepEqual(m({ a: 1, b: 1 }, { a: 2, b: 1 }, { a: 1, b: 3 }), { a: 2, b: 3 });
});
test('the same field changed differently is a conflict; the same change twice is not', () => {
  assert.equal(m({ a: 1 }, { a: 2 }, { a: 3 }), null);
  assert.deepEqual(m({ a: 1 }, { a: 2 }, { a: 2 }), { a: 2 });
});
test('a field removed by one side and changed by the other is a conflict', () => {
  assert.equal(m({ a: 1, b: 1 }, { b: 1 }, { a: 2, b: 1 }), null);
  assert.deepEqual(m({ a: 1, b: 1 }, { b: 1 }, { a: 1, b: 1 }), { b: 1 });
});
test('items with ids merge by id: additions on both sides survive, edits to different items survive', () => {
  const base = { l: [{ id: 'x', t: 1 }, { id: 'y', t: 1 }] };
  const live = { l: [{ id: 'x', t: 2 }, { id: 'y', t: 1 }, { id: 'p' }] };
  const mine = { l: [{ id: 'x', t: 1 }, { id: 'y', t: 5 }, { id: 'q' }] };
  assert.deepEqual(m(base, live, mine).l.map((x) => [x.id, x.t]).sort(), [['p', undefined], ['q', undefined], ['x', 2], ['y', 5]]);
});
test('deleting an item the other side edited is a conflict', () => {
  assert.equal(m({ l: [{ id: 'x', t: 1 }] }, { l: [] }, { l: [{ id: 'x', t: 2 }] }), null);
});
test('both reordering differently is a conflict; one reordering wins', () => {
  const base = { l: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] };
  const abc = base.l, cba = [{ id: 'c' }, { id: 'b' }, { id: 'a' }], bac = [{ id: 'b' }, { id: 'a' }, { id: 'c' }];
  assert.equal(m(base, { l: cba }, { l: bac }), null);
  assert.deepEqual(m(base, { l: abc }, { l: cba }).l.map((x) => x.id), ['c', 'b', 'a']);
});
test('arrays without ids are taken whole from the side that changed them, or conflict', () => {
  assert.deepEqual(m({ t: [1, 2] }, { t: [1, 2] }, { t: [1, 2, 3] }), { t: [1, 2, 3] });
  assert.equal(m({ t: [1] }, { t: [2] }, { t: [3] }), null);
});
test('keeps the live file indentation and a final newline; bad JSON gives null', () => {
  assert.equal(mergeJsonText('{"a":1}', '{\n    "a": 2\n}\n', '{"a":1,"b":1}'), '{\n    "a": 2,\n    "b": 1\n}\n');
  assert.equal(mergeJsonText('{', '{}', '{}'), null);
});
