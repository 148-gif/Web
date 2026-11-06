// Seasonal reading suggestion: a month before a holiday, the library and the home page offer the books of the next one.
// The dates are not typed in: they are the Hebrew dates of site/zmanim/ (made by scripts/gen-zmanim.mjs from the Onot app's own
// calendar), so a holiday's day is found by its Hebrew date ("כ״ה בכסלו"). The build writes the windows into the page, and
// site/app.js shows the one that holds today's date (a static page cannot know the day). Past the last day of site/zmanim/ nothing is shown.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { esc, lib } from './core.mjs';
import { bookCard } from './parts.mjs';

const ZDIR = new URL('../../site/zmanim/', import.meta.url);
const LEAD = 30; // days before the holiday that its books are offered
const GEM = { א: 1, ב: 2, ג: 3, ד: 4, ה: 5, ו: 6, ז: 7, ח: 8, ט: 9, י: 10, כ: 20, ל: 30, מ: 40, נ: 50, ס: 60, ע: 70, פ: 80, צ: 90, ק: 100, ר: 200, ש: 300, ת: 400 };
const gematria = (s) => [...s].reduce((a, ch) => a + (GEM[ch] || 0), 0);
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);

// [[iso date, Hebrew date ("כ״ה בכסלו"), parasha]] of every day in site/zmanim/, in order
const zmanimDays = () => {
  if (!existsSync(ZDIR)) return [];
  const all = {};
  for (const f of readdirSync(ZDIR).filter((x) => /^\d{4}-\d\d-\d\d\.json$/.test(x))) Object.assign(all, JSON.parse(readFileSync(new URL(f, ZDIR), 'utf8')).days);
  return Object.keys(all).sort().map((k) => [k, all[k][0], all[k][1]]);
};

// Every time each occasion happens in `days`: { id, start, to, dated }. A holiday is found by its Hebrew day and month; a season
// named by two parashot ("שובבים") runs from the Shabbat of the first to the Shabbat of the second.
const instances = (occasions, days) => {
  const out = [];
  const shabbatOf = (name) => {
    const dates = days.filter(([, , p]) => (p || '').startsWith(`שבת פרשת ${name}`)).map(([k]) => k);
    return dates.filter((k, i) => i === dates.length - 1 || addDays(k, 1) !== dates[i + 1]); // the last day of each run (Friday and Shabbat share the label)
  };
  for (const o of occasions) {
    if (o.parasha) {
      const ends = shabbatOf(o.parasha[1]);
      for (const start of shabbatOf(o.parasha[0])) { const to = ends.find((e) => e > start); if (to) out.push({ id: o.id, start, to, dated: false }); }
    } else {
      const months = [].concat(o.month);
      for (const [k, h] of days) {
        const m = /^(\S+) ב(.+)$/.exec(h || '');
        if (m && gematria(m[1]) === o.day && months.includes(m[2])) out.push({ id: o.id, start: k, to: addDays(k, o.length - 1), dated: true });
      }
    }
  }
  return out;
};

// One suggestion for each day, as runs [id, from, start, to]: the holiday in progress, else the nearest one coming within LEAD days,
// else a season in progress (a long season never hides a holiday that is near). `start` is where the countdown aims.
const seasonWindows = (occasions, days, lead = LEAD) => {
  const inst = instances(occasions, days).map((x) => ({ ...x, from: addDays(x.start, -lead) }));
  const runs = [];
  for (const [day] of days) {
    const here = inst.filter((x) => x.from <= day && day <= x.to);
    const pick = here.filter((x) => x.dated && x.start <= day)[0]
      || here.filter((x) => x.start >= day).sort((a, b) => (a.start < b.start ? -1 : 1))[0]
      || here.filter((x) => x.start <= day)[0];
    if (!pick) continue;
    const last = runs.at(-1);
    if (last && last[0] === pick.id && last[2] === pick.start && addDays(last[3], 1) === day) last[3] = day;
    else runs.push([pick.id, day, pick.start, day]);
  }
  return runs;
};

// The hidden block of the page: the books of every occasion that has a window, and the windows. site/app.js unhides the right one.
const seasonHtml = () => {
  const runs = seasonWindows(lib.occasions || [], zmanimDays());
  if (!runs.length) return '';
  const items = lib.occasions.filter((o) => runs.some((r) => r[0] === o.id)).map((o) => `<div data-oc="${o.id}" hidden><h2 class="sh"><span data-b>לקראת ${esc(o.title)}</span><span data-d hidden>${esc(o.title)}</span></h2><p class="shsub"><b data-when></b> · ספרים לקריאה ולהורדה</p><div class="grid featured">${o.books.map((slug) => bookCard(lib.books.find((b) => b.slug === slug), ' feat')).join('')}</div></div>`);
  return `<section class="band season" data-season="${esc(JSON.stringify(runs))}" data-unfiltered hidden><div class="wrap">${items.join('')}</div></section>`;
};

export { zmanimDays, instances, seasonWindows, seasonHtml, addDays, LEAD };
