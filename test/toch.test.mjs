import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseToch, tochIndex, hebYear, TOCH_PLACES } from '../scripts/lib/toch.mjs';
import { readFileSync } from 'node:fs';

const k = (slug, title, group = 'tn-bereshit') => ({ slug, title, group, pages: 1, size: '1KB' });

test('hebYear reads a written year', () => {
  assert.equal(hebYear('תשס״ה'), 5765);
  assert.equal(hebYear('תש״ן'), 5750);
  assert.equal(hebYear('תשמ״ז'), 5747);
});

test('parseToch reads place, year, language and a second leaflet', () => {
  const a = parseToch(k('toch-noach-5765', 'תוך הנחל, פרשת נח תשס״ה'));
  assert.deepEqual([a.place, a.year, a.yearHe, a.lang, a.part], ['noach', 5765, 'תשס״ה', 'he', 1]);
  const b = parseToch(k('toch-vaiera-5767-english2', 'תוך הנחל באנגלית, פרשת וירא תשס״ז2'));
  assert.deepEqual([b.place, b.year, b.lang, b.part], ['vayera', 5767, 'en', 2]);
  assert.equal(parseToch(k('x-5766', 'תוך הנחל, פרשת ויקהל פקודי תשס״ו')).place, 'vayakhel-pekudei');
  assert.equal(parseToch(k('toch-moadim-maoz-tzur', 'תוך הנחל, מעוז צור', 'tn-moadim')).year, null);
});

test('parseToch refuses what it cannot place', () => {
  assert.throws(() => parseToch(k('a-5765', 'תוך הנחל, פרשת לא קיימת תשס״ה')), /unknown parasha/);
  assert.throws(() => parseToch(k('a-5765', 'תוך הנחל בצרפתית, פרשת נח תשס״ה')), /unknown language/);
  assert.throws(() => parseToch(k('a', 'תוך הנחל, פרשת נח תשס״ה')), /slug/);
  assert.throws(() => parseToch(k('a-5766', 'תוך הנחל, פרשת נח תשס״ה')), /title says/);
  assert.throws(() => parseToch(k('a-5766', 'משהו אחר')), /not "תוך הנחל/);
});

test('tochIndex sorts by Torah order, years oldest first, and a year from Rosh Hashana', () => {
  const t = tochIndex([
    k('toch-noach-5766', 'תוך הנחל, פרשת נח תשס״ו'), k('toch-noach-5759', 'תוך הנחל, פרשת נח תשנ״ט'),
    k('toch-noach-5766-english', 'תוך הנחל באנגלית, פרשת נח תשס״ו'), k('toch-bereshit-5766', 'תוך הנחל, פרשת בראשית תשס״ו'),
    k('toch-haazinu-5766', 'תוך הנחל, פרשת האזינו תשס״ו', 'tn-devarim'), k('other', 'שלום בביתך', 'shalom'),
  ]);
  assert.deepEqual(t.places.map((p) => p.id), ['bereshit', 'noach', 'haazinu']);
  assert.deepEqual(t.places[1].he.map((x) => x.year), [5759, 5766]);
  assert.equal(t.places[1].tr.length, 1);
  assert.deepEqual(t.years.find((y) => y.year === 5766).he.map((x) => x.place), ['haazinu', 'bereshit', 'noach']);
});

test('every leaflet of data/kuntresim.json has a place', () => {
  const kt = JSON.parse(readFileSync(new URL('../data/kuntresim.json', import.meta.url)));
  const t = tochIndex(kt.items);
  assert.equal(t.all.length, kt.items.filter((x) => x.group.startsWith('tn-')).length);
  assert.equal(new Set(TOCH_PLACES.map((p) => p.id)).size, TOCH_PLACES.length);
});
