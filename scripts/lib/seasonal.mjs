// Seasonal reading suggestion: a month before a holiday, the library and the home page offer the books of the next one.
// The dates are not typed in: they are the Hebrew dates of site/zmanim/ (made by scripts/gen-zmanim.mjs from the Onot app's own
// calendar), so a holiday's day is found by its Hebrew date ("כ״ה בכסלו"). The build writes the windows into the page, and
// site/app.js shows the one that holds today's date (a static page cannot know the day). Past the last day of site/zmanim/ nothing is shown.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { esc, lib, shut, gist } from './core.mjs';
import { ICON, icon } from './layout.mjs';
import { bookCard } from './parts.mjs';
import { figure } from './images.mjs';

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


// Questions and answers of the Q&A (data/shut.json) that are about an occasion: the occasion's name (one of its `terms` in library.json) must be
// a word of the question itself, its title, with up to two prefix letters allowed ("בפורים", "שבט״ו" but not "ספורים"); a letter that only mentions the holiday
// does not count. Answers long enough to be worth reading score higher, so the best come first. Deterministic: ties go to the lower id.
const plain = (t) => String(t).replace(/[\u0591-\u05C7]/g, '').replace(/["'`׳״]/g, '');
const termRe = (t) => new RegExp(`(?<![\\p{L}])[והבכלמש]{0,2}${plain(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}])`, 'u');
const pickShut = (items, terms, n = 60) => {
  const res = terms.map(termRe);
  return items.map((x) => {
    if (!res.some((r) => r.test(plain(x.title)))) return null;
    const len = (x.a || []).join(' ').length, a = plain((x.a || []).join(' '));
    return { x, score: 3 + (res.some((r) => r.test(a)) ? 1 : 0) + (len >= 300 && len <= 3500 ? 2 : 0) };
  }).filter(Boolean).sort((a, b) => b.score - a.score || Number(a.x.id) - Number(b.x.id)).slice(0, n).map((r) => r.x);
};

// The pool of an occasion, as rows [id, question, the opening of the answer, minutes to read]: written to season/<id>.json, and the page
// fetches only the pool of the occasion it shows. site/app.js picks three at random, unread ones first (it remembers which were read).
const POOL = 60;
const seasonPools = () => Object.fromEntries((lib.occasions || []).map((o) => [o.id, pickShut(shut, o.terms || [], POOL).map((x) => {
  const text = gist(x.a), cut = text.length > 190 ? `${text.slice(0, 190).replace(/\s+\S*$/, '')}…` : text;
  return [String(x.id), x.title, cut, Math.max(1, Math.round(x.a.join(' ').split(/\s+/).length / 180))];
})]).filter(([, rows]) => rows.length >= 3));
const pools = new Map(Object.entries(seasonPools()));
const qa = (o) => (pools.has(o.id) ? `<div data-qa hidden><h3 class="subh qh">שאלות ותשובות לקריאה</h3><div class="grid qreads" data-pool="/season/${o.id}.json?v=${createHash('sha256').update(JSON.stringify(pools.get(o.id))).digest('hex').slice(0, 10)}"></div><p class="ctarow"><a class="btn ghost" href="/search/?q=${encodeURIComponent(o.terms[0])}">עוד שאלות ותשובות על ${esc(o.title)} ←</a></p></div>` : '');

// The hidden block of the page: for every occasion that has a window, its colour, picture, books and questions; and the windows.
// site/app.js unhides the one whose window holds today's date.
const seasonHtml = () => {
  const runs = seasonWindows(lib.occasions || [], zmanimDays());
  if (!runs.length) return '';
  const items = lib.occasions.filter((o) => runs.some((r) => r[0] === o.id)).map((o) => {
    if (o.icon && !ICON[o.icon]) throw new Error(`library.json: occasion "${o.id}" has an unknown icon "${o.icon}"`);
    return `<section class="band season ac-${o.accent || 'gold'}" data-oc="${o.id}" hidden><div class="wrap">${o.image ? figure(o.image, { size: 'full' }).replace('class="fig fig-full', 'class="fig season-fig') : ''}${o.icon ? `<span class="season-ico">${icon(o.icon, 'ico lg')}</span>` : ''}<h2 class="sh"><span data-b>לקראת ${esc(o.title)}</span><span data-d hidden>${esc(o.title)}</span></h2><p class="shsub"><b data-when></b> · ספרים לקריאה ולהורדה</p><div class="grid featured">${o.books.map((slug) => bookCard(lib.books.find((b) => b.slug === slug), ' feat')).join('')}</div>${qa(o)}</div></section>`;
  });
  return `<div id="season" data-season="${esc(JSON.stringify(runs))}" data-unfiltered hidden>${items.join('')}</div>`;
};

export { pickShut, seasonPools, zmanimDays, instances, seasonWindows, seasonHtml, addDays, LEAD };
