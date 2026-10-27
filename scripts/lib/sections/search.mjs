import { BUILD, nik, write, shut, letters, halacha, isHidden, lib } from '../core.mjs';
import { icon, phead, layout, sr } from '../layout.mjs';
import { chips } from '../parts.mjs';
import { bookChapters } from './library.mjs';

// Search
// Search index, in parts (same split for both): titles (idx/t0.json…) for instant results, and the full text (idx/0.json…).
// Results are listed in index order, so the first part alone already gives the first results; later parts add more below.
// Full text: unique, punctuation-free words only: term matching is unchanged, the files are much smaller.
// Each entry carries its own path (shut/12, letters/5602), so results can point to any section.
const SHARDS = 8;
const words = (t, skip = new Set()) => [...new Set(nik(t).replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter((w) => w && !skip.has(w)))].join(' ');
const indexed = [...shut.map((x) => ['shut', x]), ...(isHidden('/letters/') ? [] : letters.map((x) => ['letters', x])), ...halacha.map((x) => ['halacha', x]),
  ...Object.entries(bookChapters).flatMap(([slug, chs]) => chs.map((c) => [`library/${slug}`, { id: c.id, title: `${lib.books.find((b) => b.slug === slug).title}: ${nik(c.title)}`, q: [], a: c.paras.map(nik) }]))];
const shardSize = Math.ceil(indexed.length / SHARDS);
const part = (k) => indexed.slice(k * shardSize, (k + 1) * shardSize);
// The search page carries the split in data attributes; other pages read it from meta.json to warm the index (app.js).
write('idx/meta.json', JSON.stringify({ n: SHARDS, size: shardSize }));
for (let k = 0; k < SHARDS; k++) write(`idx/t${k}.json`, JSON.stringify(part(k).map(([b, x]) => [`${b}/${x.id}`, x.title])));
for (let k = 0; k < SHARDS; k++) write(`idx/${k}.json`, JSON.stringify(part(k).map(([, x]) => words((x.title + ' ' + x.q.join(' ') + ' ' + x.a.join(' ')).slice(0, 600), new Set(words(x.title).split(' '))))));
// The index is not preloaded: it would compete with the styles and fonts that the first paint waits for.
// search.js fetches the titles after the page loads (at once when there is a query, first part first) and the full text (about 1.2MB) once there is something to search for.
write('search/index.html', layout('חיפוש', `${sr('תוצאות החיפוש')}<p id="count" class="small count" aria-live="polite"></p><div id="results" class="grid" data-parts="${SHARDS}" data-size="${shardSize}"></div><script src="/search.js?v=${BUILD}" defer></script>`, { path: '/search/', desc: 'חיפוש מהיר בכל אלפי השאלות והתשובות של שו״ת ברסלב ובספרי הצדיק שבספרייה.', head: phead(isHidden('/letters/') ? 'בכל אלפי השאלות' : 'בכל אלפי השאלות והמכתבים', 'חיפוש באתר', '', `<label class="slabel" for="q">מילה או ביטוי לחיפוש</label><div class="hsearch">${icon('search', 'ico sm')}<input id="q" type="search" placeholder="הקלידו מילה או ביטוי…" autofocus></div><div class="chips">${chips}</div>`) }));

export { indexed };
