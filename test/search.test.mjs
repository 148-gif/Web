// The search page's matching and ranking (HS in site/search.js, run here in a vm as the build does).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ctx = {}; vm.runInNewContext(readFileSync(new URL('../site/search.js', import.meta.url), 'utf8'), ctx);
const HS = ctx.HSearch, T = HS.tokens;
const q = (t, w, typing) => HS.quality(HS.norm(t), HS.norm(w), typing);

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
  assert.equal(HS.score(Q, T('שלום לכולם'), []), null);
  assert.equal(HS.score(Q, T('בגלל פיגור בתשלום בעל הבית'), []), null);
  const phrase = HS.score(Q, T('יש לנו בעיות בשלום בית'), []).s;
  const near = HS.score(Q, T('איך מביאים שלום אל הבית'), []).s;
  const far = HS.score(Q, T('שלום בין כלה וחמותה שגרות יחד באותו מקום בבית'), []).s;
  const inText = HS.score(Q, T('בעיות בזוגיות'), T('צריך לעבוד על שלום בית כל יום')).s;
  const textFar = HS.score(Q, T('שאלה'), T('שלום ' + 'מילה '.repeat(30) + 'בית')).s;
  assert.ok(phrase > near && near > far, `${phrase} > ${near} > ${far}`);
  assert.ok(inText > far, 'the phrase in the answer beats the words scattered in the title');
  assert.ok(far > textFar);
});

test('score: a quoted phrase must appear word after word', () => {
  const Q = HS.parse('"בת עין"');
  assert.ok(HS.score(Q, T('ביקור ביישוב בת עין'), []));
  assert.equal(HS.score(Q, T('בת זוג שמוצאת חן בעיניו'), []), null);
});

test('score: the fallback lets some words be missing', () => {
  const Q = HS.parse('שלום ירקרק ');
  assert.equal(HS.score(Q, T('שלום בית'), []), null);
  assert.ok(HS.score(Q, T('שלום בית'), [], 2, true));
});

test('marks: which title words to highlight', () => {
  assert.deepEqual([...HS.marks(HS.parse('שלום בית '), T('יש לנו בעיות בשלום הבית'))], [false, false, false, true, true]);
});

test('snip: words around the closest match, finals restored, with the matched ones flagged', () => {
  const [words, flags, before, after] = HS.snip(HS.parse('בת עין '), T('א ב ג ד ה ו בת עין אישון העין ז ח ט י כ ל מ נ ס ע פ צ'), 2, 6);
  assert.deepEqual([...words], ['ג', 'ד', 'ה', 'ו', 'בת', 'עין']);
  assert.deepEqual([...flags], [false, false, false, false, true, true]);
  assert.equal(before, true); assert.equal(after, true);
});
