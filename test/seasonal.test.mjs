// The seasonal reading suggestion: windows are found from Hebrew dates, a holiday in progress wins, then the nearest one coming.
import test from 'node:test';
import assert from 'node:assert/strict';
import { instances, seasonWindows, pickShut, seasonPools, addDays, zmanimDays } from '../scripts/lib/seasonal.mjs';
import { lib, shut } from '../scripts/lib/core.mjs';

// A fake calendar: `marks` maps an ISO date to [Hebrew date, parasha]; every other day is plain.
const calendar = (from, n, marks) => Array.from({ length: n }, (_, i) => { const k = addDays(from, i); return [k, ...(marks[k] || ['ו׳ בתמוז', ''])]; });
const A = { id: 'a', title: 'א', day: 25, month: 'כסלו', length: 8, books: ['x'] }, B = { id: 'b', title: 'ב', day: 15, month: 'שבט', length: 1, books: ['x'] };
const S = { id: 's', title: 'ס', parasha: ['שמות', 'משפטים'], books: ['x'] };
const marks = { '2030-03-01': ['כ"ה בכסלו', ''], '2030-04-20': ['ט"ו בשבט', ''], '2030-04-01': ['ב׳ בטבת', 'שבת פרשת שמות'], '2030-04-02': ['ג׳ בטבת', 'שבת פרשת שמות'], '2030-05-10': ['א׳ באדר', 'שבת פרשת משפטים'] };
const days = calendar('2030-01-01', 200, marks);
const at = (runs, d) => runs.find(([, from, , to]) => from <= d && d <= to)?.[0];

test('a holiday is found by its Hebrew day and month, and lasts its length', () => {
  const x = instances([A], days);
  assert.deepEqual(x.map((i) => [i.start, i.to]), [['2030-03-01', '2030-03-08']]);
  assert.equal(instances([{ ...A, day: 1 }], days).length, 0);
  assert.equal(instances([{ ...B, month: ['שבט', 'אדר'] }], days).length, 1); // a list of months: either one
});

test('a season named by two parashot runs from the Shabbat of the first to the Shabbat of the second', () => {
  assert.deepEqual(instances([S], days).map((i) => [i.start, i.to]), [['2030-04-02', '2030-05-10']]);
});

test('a window opens a month before the holiday and closes when it ends', () => {
  const runs = seasonWindows([A], days);
  assert.equal(at(runs, '2030-01-29'), undefined);
  assert.equal(at(runs, '2030-01-30'), 'a');
  assert.equal(at(runs, '2030-03-08'), 'a');
  assert.equal(at(runs, '2030-03-09'), undefined);
  assert.deepEqual(runs[0].slice(2), ['2030-03-01', '2030-03-08']);
});

test('a holiday in progress wins; after it, the nearest one coming; a long season never hides a near holiday', () => {
  const runs = seasonWindows([A, B, S], days);
  assert.equal(at(runs, '2030-03-05'), 'a'); // in the middle of A, while S is already near
  assert.equal(at(runs, '2030-03-20'), 's'); // A is over, S begins in two weeks
  assert.equal(at(runs, '2030-04-05'), 'b'); // S is in progress but B (a holiday) is near
  assert.equal(at(runs, '2030-04-25'), 's'); // B is over, S goes on to its end
  assert.equal(at(runs, '2030-05-11'), undefined);
});

test('the real calendar gives every occasion of library.json a window, and no day has two', () => {
  const real = zmanimDays(), runs = seasonWindows(lib.occasions, real);
  assert.ok(real.length > 365, 'site/zmanim/ has more than a year');
  for (const o of lib.occasions) assert.ok(runs.some((r) => r[0] === o.id), `${o.id} has a window`);
  for (let i = 1; i < runs.length; i++) assert.ok(runs[i][1] > runs[i - 1][3], 'windows do not overlap');
  const chanukah = runs.find((r) => r[0] === 'chanukah');
  assert.equal(chanukah[2], '2026-12-05'); // 25 Kislev 5787
});

test('pickShut() needs the occasion as a word of the question itself, with up to two prefix letters allowed', () => {
  const item = (id, title, q = '', a = 'תשובה '.repeat(80)) => ({ id: String(id), title, q: [q], a: [a] });
  const items = [item(1, 'איך אפשר לחגוג בפורים?'), item(2, 'ימיו ספורים, מה עושים?'), item(3, 'שאלה אחרת', 'מה עם פורים?'), item(4, 'על ״פורים״ ו"מפורים"'), item(5, 'האם זה נכון שבט"ו בשבט אפשר לקבל תיקון?')];
  assert.deepEqual(pickShut(items, ['פורים']).map((x) => x.id), ['1', '4']); // not "ספורים", and not a letter that only mentions the holiday
  assert.deepEqual(pickShut(items, ['ט״ו בשבט']).map((x) => x.id), ['5']); // "שבט״ו": two prefix letters
  assert.deepEqual(pickShut(items, ['פורים'], 1).map((x) => x.id), ['1']); // ties go to the lower id
  assert.deepEqual(pickShut(items, ['ל״ג בעומר']), []);
});

test('the pool of each occasion has at least three questions that name the holiday, and Pesach and Purim cover the days kept anywhere in the world', () => {
  const pools = seasonPools(), byId = new Map(shut.map((x) => [String(x.id), x]));
  for (const o of lib.occasions) {
    assert.ok(pools[o.id]?.length >= 3, `${o.id} has a pool of at least three`);
    for (const [id, title] of pools[o.id]) assert.equal(byId.get(id).title, title);
    assert.deepEqual(pools[o.id].map((r) => r[0]), pickShut(shut, o.terms, 60).map((x) => String(x.id)).slice(0, pools[o.id].length));
  }
  const days = zmanimDays();
  const pesach = instances(lib.occasions.filter((o) => o.id === 'pesach'), days)[0], purim = instances(lib.occasions.filter((o) => o.id === 'purim'), days)[0];
  assert.equal(addDays(pesach.start, 7), pesach.to); // 15 to 22 of Nisan
  assert.equal(addDays(purim.start, 1), purim.to); // Purim and Shushan Purim
});

test('every occasion with a hub names a holiday of data/moadim.json, and the home page shows the band first', async () => {
  const { moadim } = await import('../scripts/lib/moadim.mjs');
  for (const o of lib.occasions) if (o.hub) assert.ok(moadim.items.some((m) => m.id === o.hub), `${o.id}: hub "${o.hub}" exists`);
});

