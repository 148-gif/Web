// Times of the year (data/moadim.json, scripts/lib/moadim.mjs) and the parts of שיחות מוהרא״ש that the holidays point to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { validateMoadim, moadim, qaFor } from '../scripts/lib/moadim.mjs';

const read = (f) => JSON.parse(readFileSync(new URL(`../data/${f}`, import.meta.url), 'utf8'));
const lib = read('library.json');

test('validateMoadim() checks ids, book ranges, books and links', () => {
  const books = [{ slug: 'a', text: 'x' }, { slug: 'b' }], sizes = new Map([['a', 10]]);
  const ok = { items: [{ id: 'purim', title: 'פורים', short: 'פורים', lead: 'x', chapters: [['a', 1, 10]], books: ['b'], links: [['/uman/', 'אומן']] }] };
  const w = (f) => { const c = structuredClone(ok); f(c.items[0], c); return () => validateMoadim(c, books, sizes); };
  assert.doesNotThrow(() => validateMoadim(ok, books, sizes));
  assert.throws(w((x) => { x.id = '../x'; }), /bad id/);
  assert.throws(w((x, c) => { c.items.push({ ...x }); }), /duplicate/);
  assert.throws(w((x) => { x.chapters = [['b', 1, 2]]; }), /not a book read on the site/);
  assert.throws(w((x) => { x.chapters = [['a', 5, 11]]; }), /outside the book/);
  assert.throws(w((x) => { x.chapters = [['a', 5, 4]]; }), /outside the book/);
  assert.throws(w((x) => { x.books = ['zz']; }), /unknown book/);
  assert.throws(w((x) => { x.links = [['https://example.com/', 'x']]; }), /site path/);
  assert.throws(w((x) => { x.chapters = []; x.books = []; }), /nothing to show/);
});

test('the holidays\' questions match whole words, not parts of other words', () => {
  const purim = moadim.items.find((m) => m.id === 'purim');
  for (const q of qaFor(purim)) assert.doesNotMatch(q.title, /^(?!.*פורים).*(הכיפורים|ספורים)/);
});

test('שיחות מוהרא״ש: the parts cover every talk once, in order, and each holiday range is one part', () => {
  const bk = lib.books.find((b) => b.slug === 'sichot-moharash'), tx = read(bk.text);
  let next = 1;
  for (const [, , [from, to]] of bk.parts) { assert.equal(from, next); next = to + 1; }
  assert.equal(next - 1, tx.sections.length);
  for (const m of moadim.items) for (const [s, f, t] of m.chapters || []) if (s === bk.slug) assert.ok(bk.parts.some(([, , [a]]) => a === f) && bk.parts.some(([, , [, b]]) => b === t), `${m.id}: ${f}–${t} should begin and end with a part`);
  // every talk has its own address, and every printed booklet is a file on the site under a topic that is listed
  const ids = tx.sections.map((x) => String(x.id ?? x.n));
  assert.equal(new Set(ids).size, ids.length);
  for (const b of tx.booklets || []) {
    assert.ok(existsSync(new URL(`../site${b.pdf}`, import.meta.url)), b.pdf);
    assert.ok((tx.bookletTopics || []).includes(b.part), b.part);
  }
  // no leftovers of the source site in the text
  assert.doesNotMatch(JSON.stringify(tx), /ברסלב סיטי|breslevcity|» כל המידע/);
});
