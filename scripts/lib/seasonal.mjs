// Seasonal reading suggestion: a month before a holiday, the library and the home page offer the books of the next one.
// The dates are not typed in: they are the Hebrew dates of site/zmanim/ (made by scripts/gen-zmanim.mjs from the Onot app's own
// calendar), so a holiday's day is found by its Hebrew date ("כ״ה בכסלו"). The build writes the windows into the page, and
// site/app.js shows the one that holds today's date (a static page cannot know the day). Past the last day of site/zmanim/ nothing is shown.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { esc, lib, shut, gist, read, nik } from './core.mjs';
import { moadim } from './moadim.mjs';
import { taggedFor } from './shut-tags.mjs';
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
// `tagged`: question numbers chosen by hand (data/shut-tags.json) that count as naming the holiday although their title does not.
const pickShut = (items, terms, n = 60, tagged = []) => {
  const res = terms.map(termRe), hand = new Set(tagged.map(String));
  return items.map((x) => {
    if (!hand.has(String(x.id)) && !res.some((r) => r.test(plain(x.title)))) return null;
    const len = (x.a || []).join(' ').length, a = plain((x.a || []).join(' '));
    return { x, score: 3 + (res.some((r) => r.test(a)) ? 1 : 0) + (len >= 300 && len <= 3500 ? 2 : 0) };
  }).filter(Boolean).sort((a, b) => b.score - a.score || Number(a.x.id) - Number(b.x.id)).slice(0, n).map((r) => r.x);
};

// The pool of an occasion, as rows [id, question, the opening of the answer, minutes to read]: written to season/<id>.json, and the page
// fetches only the pool of the occasion it shows. site/app.js picks three at random, unread ones first (it remembers which were read).
const POOL = 60;
const seasonPools = () => Object.fromEntries((lib.occasions || []).map((o) => [o.id, pickShut(shut, o.terms || [], POOL, taggedFor(o.id)).map((x) => {
  const text = gist(x.a), cut = text.length > 190 ? `${text.slice(0, 190).replace(/\s+\S*$/, '')}…` : text;
  return [String(x.id), x.title, cut, Math.max(1, Math.round(x.a.join(' ').split(/\s+/).length / 180))];
})]).filter(([, rows]) => rows.length >= 3));
const pools = new Map(Object.entries(seasonPools()));
// The holiday labels of a question (on its page and in the search): every occasion whose pool holds it, named by the occasion and leading
// to its hub page (or to the search, with no hub). Map question number -> [[label, href]].
const shutLabels = () => {
  const out = new Map();
  for (const o of lib.occasions || []) for (const [id] of pools.get(o.id) || []) {
    if (!out.has(id)) out.set(id, []);
    out.get(id).push([o.title, o.hub ? `/moadim/${o.hub}/` : `/search/?q=${encodeURIComponent(o.terms[0])}`]);
  }
  return out;
};
const qa = (o) => (pools.has(o.id) ? `<div data-qa hidden><h3 class="subh qh">${icon('chat', 'ico')}שאלות ותשובות לקריאה</h3><div class="grid qreads" data-pool="/season/${o.id}.json?v=${createHash('sha256').update(JSON.stringify(pools.get(o.id))).digest('hex').slice(0, 10)}"></div></div>` : '');

// From the holiday's hub (data/moadim.json, /moadim/<id>/, named by the occasion's `hub`): up to two of Moharash's talks on it and one
// general letter of its month, as reading cards. The hub's sections are [book slug, from, to] by section number.
// A kuntres of data/kuntresim.json named by the occasion (its PDF in site/books/kuntresim/), shown with the books
const kt = read('kuntresim.json');
const kuntresCard = (o, slug) => {
  const k = kt.items.find((x) => x.slug === slug);
  if (!k) throw new Error(`library.json: occasion "${o.id}" names an unknown kuntres "${slug}" (data/kuntresim.json)`);
  return `<a class="card book feat" href="/books/kuntresim/${k.slug}.pdf">${icon('book', 'ico lg')}<h3>${esc(k.title)}</h3><p>קונטרס של מוהרא״ש</p><span class="btags"><span class="btag">PDF</span><span class="bpg">${k.pages} עמודים</span></span><span class="go">קריאה והורדה ←</span></a>`;
};
const hubOf = (o) => {
  if (!o.hub) return null;
  const m = moadim.items.find((x) => x.id === o.hub);
  if (!m) throw new Error(`library.json: occasion "${o.id}" names an unknown hub "${o.hub}" (data/moadim.json)`);
  return m;
};
const texts = new Map();
const sectionsOf = (m, slug) => (m.chapters || []).filter(([x]) => x === slug).flatMap(([x, f, t]) => {
  const b = lib.books.find((y) => y.slug === x);
  if (!texts.has(x)) texts.set(x, read(b.text));
  return texts.get(x).sections.slice(f - 1, t);
});
const opening = (paras, n = 170) => {
  const p = nik(paras.find((x) => x.length > 60 && !/^שלום וברכה/.test(x)) || paras[0] || '');
  return p.length > n ? `${p.slice(0, n).replace(/\s+\S*$/, '')}…` : p;
};
const minutes = (paras) => Math.max(1, Math.round(paras.join(' ').split(/\s+/).length / 180));
const readCard = (href, kick, title, text, meta) => `<a class="card qread lread" href="${href}"><span class="qkick">${esc(kick)}</span><h3>${esc(title)}</h3>${text ? `<p>${esc(text)}</p>` : ''}<span class="qmeta"><span>${esc(meta)}</span><span class="go">לקריאה ←</span></span></a>`;
const readings = (o) => {
  const m = hubOf(o);
  if (!m) return '';
  const talks = sectionsOf(m, 'sichot-moharash').slice(0, 2).map((x) => readCard(`/library/sichot-moharash/${x.n}/`, 'משיחות מוהרא״ש', nik(x.title), opening(x.paras), `קריאה של ${minutes(x.paras) === 1 ? 'דקה' : `${minutes(x.paras)} דקות`}`));
  const letters = sectionsOf(m, 'asher-banachal-michtavim-klaliim').slice(0, 3 - talks.length).map((x) => readCard(`/library/asher-banachal-michtavim-klaliim/${x.n}/`, 'מכתב כללי של מוהרא״ש', opening(x.paras, 80), '', nik(x.title)));
  const cards = [...talks, ...letters];
  return cards.length ? `<h3 class="subh qh">${icon('book', 'ico')}מתוך הספרים</h3><div class="grid qreads">${cards.join('')}</div>` : '';
};
// The way on: the hub with everything the site has on the holiday, and the search for more questions
const more = (o) => {
  const m = hubOf(o);
  return `<p class="ctarow season-more">${m ? `<a class="btn" href="/moadim/${m.id}/">כל מה שיש באתר על ${esc(m.short)} ←</a>` : ''}${pools.has(o.id) ? `<a class="btn ghost" href="/search/?q=${encodeURIComponent(o.terms[0])}">עוד שאלות ותשובות על ${esc(o.title)}</a>` : ''}</p>`;
};

// The hidden block of the page: for every occasion that has a window, its colour, picture, books and questions; and the windows.
// site/app.js unhides the one whose window holds today's date.
const seasonHtml = () => {
  const runs = seasonWindows(lib.occasions || [], zmanimDays());
  if (!runs.length) return '';
  const items = lib.occasions.filter((o) => runs.some((r) => r[0] === o.id)).map((o) => {
    if (o.icon && !ICON[o.icon]) throw new Error(`library.json: occasion "${o.id}" has an unknown icon "${o.icon}"`);
    // The top of the band, bento style: the title and the days left laid over the holiday's photo (its caption and credit stay under it),
    // or over a velvet panel when it has none; beside it, the books as a compact list.
    const head = `<div class="season-tt">${o.icon ? `<span class="season-ico">${icon(o.icon, 'ico lg')}</span>` : ''}<h2 class="sh"><span data-b>לקראת ${esc(o.title)}</span><span data-d hidden>${esc(o.title)}</span></h2><p class="shsub"><b data-when></b><span>ספרים, שיחות ושאלות ותשובות לקריאה</span></p></div>`;
    const hero = o.image
      ? figure(o.image, { size: 'full' }).replace('class="fig fig-full', 'class="fig season-fig').replace(/<img[^>]*>/, (img) => `<div class="season-shot">${img}${head}</div>`)
      : `<div class="season-plain">${head}</div>`;
    const books = o.books.length || (o.kuntresim || []).length ? `<div class="season-books"><h3 class="subh qh">${icon('books', 'ico')}ספרים לקראת ${esc(o.title)}</h3><div class="grid featured">${o.books.map((slug) => bookCard(lib.books.find((b) => b.slug === slug), ' feat')).join('')}${(o.kuntresim || []).map((k) => kuntresCard(o, k)).join('')}</div></div>` : '';
    return `<section class="band season ac-${o.accent || 'gold'}" data-oc="${o.id}" hidden><div class="wrap"><div class="season-top${books ? '' : ' solo'}"><div class="season-hero">${hero}</div>${books}</div>${readings(o)}${qa(o)}${more(o)}</div></section>`;
  });
  return `<div id="season" data-season="${esc(JSON.stringify(runs))}" data-unfiltered hidden>${items.join('')}</div>`;
};

export { pickShut, seasonPools, shutLabels, zmanimDays, instances, seasonWindows, seasonHtml, addDays, LEAD };
