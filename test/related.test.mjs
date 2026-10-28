// Tests for the "related questions" ranking (scripts/lib/related.mjs) and the settings file of the link audit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokens, relatedMap } from '../scripts/lib/related.mjs';
import { validateAuditConfig } from '../scripts/lib/linkaudit.mjs';

const item = (id, title, a = '') => ({ id, title, q: [title], a: [a] });

test('tokens() drops vowel marks, quotes and a one-letter prefix of long words', () => {
  assert.deepEqual(tokens('הַשְּׁמִיטָה'), ['שמיטה']);
  assert.deepEqual(tokens('בשנת השמיטה'), ['בשנת', 'שמיטה']);
  assert.deepEqual(tokens('רבינו נחמן (תשע"ה) a'), ['רבינו', 'נחמן', 'תשעה']);
});

test('relatedMap() links questions on the same subject and is deterministic', () => {
  const items = [
    item('1', 'קניית פירות וירקות בשנת השמיטה', 'יבול נוכרי בשמיטה'),
    item('2', 'איסור אכילת פירות שמיטה', 'פירות שביעית וקדושת שביעית'),
    item('3', 'מה דין שמיטה בירקות', 'ירקות בשנת השמיטה'),
    item('4', 'עצה לשלום בית ולזוגיות', 'שלום בית דורש סבלנות'),
    item('5', 'איך משפרים שלום בית', 'שלום בית וזוגיות'),
    item('6', 'שאלה אחרת לגמרי על תפילה בהתבודדות', 'התבודדות'),
  ];
  const r = relatedMap(items, { maxDf: 1, min: 0.05 });
  assert.ok(r.get('1').includes('3'));
  assert.deepEqual(r.get('4'), ['5']);
  assert.deepEqual(r.get('6'), []);
  assert.deepEqual([...relatedMap(items, { maxDf: 1, min: 0.05 })], [...r]);
  assert.ok(![...r.entries()].some(([id, list]) => list.includes(id)), 'an item is never related to itself');
  assert.equal(relatedMap(items, { count: 1, maxDf: 1, min: 0.05 }).get('1').length, 1);
});

test('validateAuditConfig() accepts the editor\'s shape and refuses a broken one', () => {
  const ok = { ignore: [{ code: 'orphan', path: '/x/' }], ignorePairs: [['/a/', '/b/']], aliases: { '/b/': ['שם נוסף'] }, related: { count: 3, exclude: ['12', 'h1'] } };
  assert.equal(validateAuditConfig(ok), ok);
  assert.deepEqual(validateAuditConfig({}), {});
  for (const bad of [[], { ignore: [{ code: 'x' }] }, { ignorePairs: [['/a/']] }, { ignorePairs: [['a', '/b/']] }, { aliases: { '/b/': ['אב'] } }, { aliases: { b: ['שם נוסף'] } }, { related: { count: 9 } }, { related: { count: 1.5 } }, { related: { exclude: [{}] } }]) {
    assert.throws(() => validateAuditConfig(bad), /link-audit\.json/);
  }
});
