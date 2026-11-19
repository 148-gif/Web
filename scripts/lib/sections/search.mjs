import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { BUILD, nik, write, read, shut, letters, halacha, isHidden, lib } from '../core.mjs';
import { icon, phead, layout, sr } from '../layout.mjs';
import { chips } from '../parts.mjs';
import { bookChapters } from './library.mjs';
import { shutLabels } from '../seasonal.mjs';
import { wordIndex } from '../search-index.mjs';

// Search
// Search index: titles in parts (idx/t0.json…) and the word index of the full text (idx/w/…); how the page uses them
// (and where its snippets come from) is described at the top of site/search.js.
// Full text: all of each entry (question and answer, without the title, which is its own field), its words and where they
// are, normalized by the same function the page uses (HS in site/search.js, loaded here in a vm), so the page can rank an
// exact phrase and words close together above words scattered far apart.
// Each entry carries its own path (shut/12, letters/5602), so results can point to any section.
const SHARDS = 8;
const ctx = {}; vm.runInNewContext(readFileSync(new URL('../../../site/search.js', import.meta.url), 'utf8'), ctx);
const HS = ctx.HSearch;
// nikud off (the maqaf kept: it separates words)
const words = (t) => HS.tokens(t.replace(/[\u0591-\u05BD\u05BF-\u05C7]/g, ''));
const body = (x) => x.q.join(' ') + ' ' + x.a.join(' ');
const indexed = [...shut.map((x) => ['shut', x]), ...(isHidden('/letters/') ? [] : letters.map((x) => ['letters', x])), ...halacha.map((x) => ['halacha', x]),
  ...Object.entries(bookChapters).flatMap(([slug, chs]) => chs.map((c) => [`library/${slug}`, { id: c.id, title: `${lib.books.find((b) => b.slug === slug).title}: ${nik(c.title)}`, q: [], a: c.paras.map(nik) }]))];
const shardSize = Math.ceil(indexed.length / SHARDS);
const part = (k) => indexed.slice(k * shardSize, (k + 1) * shardSize);
// The search page carries the split in data attributes; other pages read it from meta.json to warm the index (app.js).
// A question with a holiday label (seasonal.mjs) carries it as a third field: shown on the result, and searched as part of the title
const labels = shutLabels(), lab = (b, x) => (b === 'shut' && labels.has(String(x.id)) ? [labels.get(String(x.id)).map(([t]) => t).join(' · ')] : []);
const searchVersion = createHash('sha256').update(JSON.stringify(['w1', indexed, [...labels]])).digest('hex').slice(0,16);
// The word index (search-index.mjs): what a search downloads, a few small files for the words typed.
// Must come before the page below, which carries the split keys.
const W = wordIndex(indexed.map(([, x]) => words(body(x))));
for (const [key, obj] of W.shards) write(`idx/w/${HS.keyFile(key)}.json`, JSON.stringify(obj));
write('idx/meta.json', JSON.stringify({ n: SHARDS, size: shardSize, version: searchVersion, split: W.split }));
for (let k = 0; k < SHARDS; k++) write(`idx/t${k}.json`, JSON.stringify(part(k).map(([b, x]) => [`${b}/${x.id}`, x.title, ...lab(b, x)])));
// The index is not preloaded: it would compete with the styles and fonts that the first paint waits for.
// search.js fetches the titles after the page loads (at once when there is a query) and, per search, only the word files of the terms typed.
// Before anything is typed the page is not left empty: places to browse instead of searching, and how the search works.
// search.js hides this block as soon as there is a query, and brings it back when the field is cleared.
const moadimN = read('moadim.json').items.length;
const browse = [
  ['/shut/', 'chat', 'שו״ת ברסלב', `${shut.length.toLocaleString('he-IL')} שאלות ותשובות של מוהרא״ש`],
  ['/library/', 'books', 'הספרייה', `${lib.books.length} ספרים של מוהרא״ש, לקריאה ולהורדה`],
  ['/moadim/', 'calendar', 'זמני השנה', `${moadimN} מועדים: שיחות, ספרים ושאלות לכל חג`],
  ['/moharash/', 'crown', 'מוהרא״ש', 'הצדיק מיבנאל: תולדות, דרכו ותורתו'],
].filter(([h]) => !isHidden(h));
const tips = [['כמה מילים יחד', 'יימצאו תוצאות שיש בהן את כל המילים, והביטוי המדויק ראשון'], ['ביטוי מדויק', 'במירכאות, למשל "בת עין"'], ['בלי ניקוד', 'הניקוד שבטקסט לא מפריע לחיפוש'], ['קודם בכותרת', 'אחר כך גם מתוך גוף התשובות והספרים']];
const startHtml = `<div id="sstart" class="sstart"><section aria-labelledby="sb-h"><h2 id="sb-h" class="sth">או לעיין לפי מדור</h2><ul class="browse">${browse.map(([h, ic, t, d]) => `<li><a href="${h}">${icon(ic, 'ico')}<span><b>${t}</b><small>${d}</small></span>${icon('arrow', 'ico sm arr')}</a></li>`).join('')}</ul></section><section class="stips" aria-labelledby="st-h"><h2 id="st-h" class="sth">איך מחפשים</h2><ul>${tips.map(([b, t]) => `<li>${icon('check', 'ico sm')}<span><b>${b}</b> · ${t}</span></li>`).join('')}</ul></section></div>`;
write('search/index.html', layout('חיפוש', `${sr('תוצאות החיפוש')}${startHtml}<p id="count" class="small count" aria-live="polite"></p><div id="results" class="grid" data-parts="${SHARDS}" data-size="${shardSize}" data-split="${W.split.join(' ')}" data-version="${searchVersion}"></div><script src="/search.js?v=${BUILD}" defer></script>`, { path: '/search/', index: false, desc: 'חיפוש מהיר בכל אלפי השאלות והתשובות של שו״ת ברסלב ובספרי הצדיק שבספרייה.', head: phead(isHidden('/letters/') ? 'בכל אלפי השאלות' : 'בכל אלפי השאלות והמכתבים', 'חיפוש באתר', '', `<label class="slabel" for="q">מילה או ביטוי לחיפוש</label><div class="hsearch">${icon('search', 'ico sm')}<input id="q" type="search" placeholder="הקלידו מילה או ביטוי…" autofocus></div><p class="chiphead">חיפושים נפוצים</p><div class="chips">${chips}</div>`) }));

export { indexed };
