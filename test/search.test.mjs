// The search page's matching and ranking (HS in site/search.js, run here in a vm as the build does).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ctx = {}; vm.runInNewContext(readFileSync(new URL('../site/search.js', import.meta.url), 'utf8'), ctx);
const HS = ctx.HSearch, T = HS.tokens;
const q = (t, w, typing) => HS.quality(HS.norm(t), HS.norm(w), typing);
// score from a title and a text given as words (the page gets the text's places from the word index instead)
const score = (Q, title, text, min, some) => HS.score(Q, title, HS.where(Q.terms, text, Q.typing), min, some);

test('norm: no nikud, finals as regular letters, gershayim joined, maqaf splits', () => {
  assert.equal(HS.norm('שָׁלוֹם'), 'שלומ');
  assert.equal(HS.norm('מוהרא״ש'), 'מוהראש');
  assert.equal(HS.norm('ראש־השנה'), 'ראש השנה');
  assert.equal(HS.norm('"בת עין", ועוד!'), 'בת עינ ועוד');
});

test('whole words, not strings: a short word is not found inside another', () => {
  assert.equal(q('בת', 'בעת'), 0);
  assert.equal(q('בת', 'בתחלתו'), 0);
  assert.equal(q('בת', 'שבת'), 0);
  assert.equal(q('שלום', 'בתשלום'), 0);
  assert.equal(q('שם', 'משתוקק'), 0);
  assert.equal(q('אור', 'אורח'), 0);
});

test('Hebrew prefixes and endings still count, below the exact word', () => {
  assert.equal(q('בית', 'בית'), 4);
  assert.equal(q('בית', 'ובבית'), 3);
  assert.equal(q('בת', 'הבת'), 3);
  assert.equal(q('בית', 'ביתו'), 2);
  assert.equal(q('שלום', 'שלומו'), 2);
  assert.equal(q('תפילה', 'תפילות'), 2);
  assert.equal(q('תפילה', 'בתפילת'), 2);
  assert.equal(q('עין', 'עינא'), 0);
  // the start of a word only while it is being typed
  assert.equal(q('התבו', 'התבודדות'), 0);
  assert.equal(q('התבו', 'התבודדות', true), 1);
});

test('parse: words, quoted phrases, and whether the last word is still being typed', () => {
  const p = HS.parse('"בת עין" ישוב');
  assert.deepEqual([...p.terms], ['בת', 'עינ', 'ישוב']);
  assert.deepEqual(Array.from(p.phrases, (x) => [...x]), [['בת', 'עינ']]);
  assert.equal(p.typing, true);
  assert.equal(HS.parse('שלום ').typing, false);
  assert.equal(HS.parse('מוהרא״ש').phrases.length, 0);
});

test('score: every word is needed; the phrase ranks above words side by side, which rank above words far apart', () => {
  const Q = HS.parse('שלום בית ');
  assert.equal(score(Q, T('שלום לכולם'), []), null);
  assert.equal(score(Q, T('בגלל פיגור בתשלום בעל הבית'), []), null);
  const phrase = score(Q, T('יש לנו בעיות בשלום בית'), []).s;
  const near = score(Q, T('איך מביאים שלום אל הבית'), []).s;
  const far = score(Q, T('שלום בין כלה וחמותה שגרות יחד באותו מקום בבית'), []).s;
  const inText = score(Q, T('בעיות בזוגיות'), T('צריך לעבוד על שלום בית כל יום')).s;
  const textFar = score(Q, T('שאלה'), T('שלום ' + 'מילה '.repeat(30) + 'בית')).s;
  assert.ok(phrase > near && near > far, `${phrase} > ${near} > ${far}`);
  assert.ok(inText > far, 'the phrase in the answer beats the words scattered in the title');
  assert.ok(far > textFar);
});

test('score: a quoted phrase must appear word after word', () => {
  const Q = HS.parse('"בת עין"');
  assert.ok(score(Q, T('ביקור ביישוב בת עין'), []));
  assert.equal(score(Q, T('בת זוג שמוצאת חן בעיניו'), []), null);
});

test('score: the fallback lets some words be missing', () => {
  const Q = HS.parse('שלום ירקרק ');
  assert.equal(score(Q, T('שלום בית'), []), null);
  assert.ok(score(Q, T('שלום בית'), [], 2, true));
});

test('marks: which title words to highlight', () => {
  assert.deepEqual([...HS.marks(HS.parse('שלום בית '), T('יש לנו בעיות בשלום הבית'))], [false, false, false, true, true]);
});

test('snip: where to cut around the closest match, with the matched words flagged', () => {
  const sn = HS.snip(HS.parse('בת עין '), T('א ב ג ד ה ו ז בת עין אישון העין ח ט י כ ל מ נ ס ע פ צ'), 2, 8);
  assert.equal(sn.from, 2); assert.equal(sn.to, 10);
  assert.deepEqual([...sn.flags], [false, false, false, false, false, true, true, false]);
  assert.equal(HS.snip(HS.parse('שלום '), T('אין כאן')), null);
});

import { wordIndex, varints, forms } from '../scripts/lib/search-index.mjs';

test('word index: varints read back, and a term finds its forms (prefixes, endings) in the one file of its first letters', () => {
  assert.deepEqual(Array.from(HS.decode(varints([0, 2, 5, 3, 40, 1, 1000000])), (x) => [x[0], [...x[1]]]), [[0, [5, 8]], [40, [1000000]]]);
  const docs = [T('יש לנו שלום בית'), T('ובבית שלנו ביתו'), T('הבית של שבת'), T('הוא אמר')];
  const { shards, split } = wordIndex(docs);
  const find = (t, typing) => {
    const file = shards.get(HS.shardKey(t, split)) || {}, out = {};
    for (const [w, p] of Object.entries(file)) if (HS.quality(t, w, typing)) for (const [d, ps] of HS.decode(p)) out[d] = [...(out[d] || []), ...ps];
    return out;
  };
  assert.deepEqual(find('בית'), { 0: [3], 1: [0, 2], 2: [0] });
  assert.deepEqual(find('בת'), {}); // not inside "שבת"
  assert.deepEqual(find('שבת'), { 2: [2] });
  assert.deepEqual(find('שלו', true), { 0: [2] }); // "שלום", by an ending; not "שלנו"
  assert.deepEqual(find('שב', true), { 2: [2] }); // being typed: the start of "שבת"
  assert.ok(!forms('הוא').has('וא') || !shards.get('וא')?.['הוא'], 'filed under a bare form only when it is a word');
});

test('word index: a large file is split by the third letter, and a term still finds its words', () => {
  const docs = Array.from({ length: 300 }, (_, i) => T(`שלום שלוש שלט ${i % 2 ? 'שלומו' : 'של'}`));
  const { shards, split } = wordIndex(docs, 500);
  assert.ok(split.includes('של'));
  assert.equal(HS.shardKey('שלומ', split), 'שלו');
  assert.ok(shards.get('שלו')['שלומו'] && shards.get('של')['של'] && !shards.get('של')['שלומ']);
});

test('a word being typed is not taken for a whole word with a loose ending', () => {
  assert.equal(q('התבו', 'התבות'), 0);
  assert.equal(q('התבו', 'התבודדות', true), 1);
  assert.equal(q('תפילה', 'תפילתו'), 2);
});
