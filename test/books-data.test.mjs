// Every book with a text file (data/books/*.json listed in data/library.json): each [x] marker in the text has exactly one note, and no note is without its marker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const lib = JSON.parse(readFileSync(new URL('../data/library.json', import.meta.url), 'utf8'));
for (const bk of lib.books.filter((b) => b.text)) {
  test(`book ${bk.slug}: notes match their markers`, () => {
    const tx = JSON.parse(readFileSync(new URL(`../data/${bk.text}`, import.meta.url), 'utf8'));
    const chapters = [{ label: 'הקדמה', ...tx.intro }, ...tx.sections];
    const bad = [];
    for (const c of chapters) {
      if (c.index) continue;
      const labels = c.notes.map(([l]) => l).sort();
      const marks = [...c.paras.join(' ').matchAll(/\[([^\]\s]{1,4})\]/g)].map((m) => m[1]).filter((l) => labels.includes(l) || /^[א-ת]$/.test(l)).sort();
      if (JSON.stringify(labels) !== JSON.stringify(marks)) bad.push(c.label);
    }
    assert.deepEqual(bad, []);
  });
  test(`book ${bk.slug}: section numbers are sequential and every part range is inside the book`, () => {
    const tx = JSON.parse(readFileSync(new URL(`../data/${bk.text}`, import.meta.url), 'utf8'));
    tx.sections.forEach((s, i) => assert.equal(s.n, i + 1));
    for (const [, , [from, to]] of bk.parts || []) assert.ok(from >= 1 && to <= tx.sections.length && from <= to);
  });
}
