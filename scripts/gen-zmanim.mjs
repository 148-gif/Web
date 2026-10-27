// Makes site/zmanim.json (the daily zmanim of Yavne'el) by running the calculation engine of the "Onot" app
// (עונות) as it is, so the times on this site always match the app's.
// Usage: node scripts/gen-zmanim.mjs <folder of the app, with js/ and index.html>
// The folder can be the app's source, or a copy of the published app (index.html lists the script files).
// Covers the range of the Luchot Chai tables inside the app; to extend it, add the next year to the app and run this again.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';

const root = process.argv[2];
if (!root) throw new Error('Usage: node scripts/gen-zmanim.mjs <app folder>');

// Only the calculation files; screens, storage and the DOM are not needed.
const files = ['js/config.js', 'js/core/storage.js', 'js/data/yavneel-tables.js', 'js/place.js', 'js/core/dates.js',
  'js/core/state.js', 'js/zmanim/hebrew-calendar.js', 'js/zmanim/engine.js', 'js/zmanim/format.js'];
const ctx = { console, Date, Intl, Math, JSON, Map, Set, setTimeout, setInterval: () => 0, navigator: {},
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, document: { addEventListener() {}, getElementById: () => null } };
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(files.map((f) => readFileSync(join(root, f), 'utf8')).join('\n;\n'), ctx);
const run = (code) => vm.runInContext(code, ctx);
run('initializeModel()');

// Columns, in the order shown on the page. A day without a zman (candle lighting on a weekday) leaves it empty.
const cols = ['עלות השחר', 'הנץ החמה', 'סוף ק"ש (מג"א)', 'סוף ק"ש (גר"א)', 'תפילה (גר"א)', 'חצות היום', 'מנחה גדולה',
  'מנחה קטנה', 'פלג המנחה', 'הדלקת נרות', 'שקיעת החמה', 'צאת הכוכבים', 'צאת השבת', 'רבינו תם'];

const [first, last] = run(`[CHAI_TABLE_YEARS[0].sunset[0].startGreg, (() => { const y = CHAI_TABLE_YEARS.at(-1).sunset.at(-1); const [a, b, c] = y.startGreg.split('-').map(Number); return toDateKey(new Date(Date.UTC(a, b - 1, c + y.times.length - 1, 12))); })()]`);
const days = {};
for (let key = first; key <= last; key = run(`addDaysToKey('${key}', 1)`)) {
  const r = run(`computeZmanim(keyToDate('${key}'))`);
  if (r.unavailable) continue;
  const byName = Object.fromEntries(r.items.map((it) => [it.shortName, run('fmtItem')(it)]));
  const dow = run(`getHebrewCalendarParts(keyToDate('${key}')).dow`);
  const parasha = dow >= 5 && r.parashaInfo ? r.parashaInfo.fullTitle : '';
  days[key] = [run(`formatHebrewDayMonthOnly(keyToDate('${key}'))`), parasha, ...cols.map((c) => byName[c] || '')];
}
writeFileSync(new URL('../site/zmanim.json', import.meta.url), JSON.stringify({ cols, days }));
console.log(`${Object.keys(days).length} days, ${first} to ${last}`);
