// Search page. The index comes in parts (built by scripts/lib/sections/search.mjs), each with a titles file and a full-text file.
// Matching is by whole words, as search engines do, not by strings: "בת" finds "בת", "הבת", "ובת", never "בעת" or "בתחלתו".
// Hebrew prefixes (ו ה ב כ ל מ ש) and common endings (ביתו, תפילות) still count, but rank below the exact word.
// Results are ranked by how close the words are (the exact phrase, then side by side, then anywhere), the title above the text. The pure part (HS) is shared with the build and the tests (they run this file in a vm).
const HS = (() => {
  const FIN = { 'ך': 'כ', 'ם': 'מ', 'ן': 'נ', 'ף': 'פ', 'ץ': 'צ' };
  // Nikud and cantillation off; a maqaf separates words; quote marks inside a word (מוהרא״ש, ר׳) join it; finals become regular letters.
  const norm = (s) => String(s).replace(/־/g, ' ').replace(/[֑-ׇ]/g, '').replace(/(\p{L})["'״׳`]+(?=\p{L})/gu, '$1')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').toLowerCase().replace(/[ךםןףץ]/g, (c) => FIN[c]).trim();
  const tokens = (s) => { const n = norm(s); return n ? n.split(' ') : []; };
  const PRE = /^[והבכלמש]{1,3}$/, PRE2 = /^[והבל]$/; // a two-letter word takes only a short prefix: "שבת" is not ש+"בת"
  const SUF = ['ו', 'ה', 'י', 'ך', 'כ', 'ם', 'מ', 'ן', 'נ', 'ים', 'ות', 'יו', 'יה', 'נו', 'כמ', 'הם', 'הן', 'הנ', 'יכ', 'ינו', 'יהם', 'יהמ', 'ת', 'תו', 'תי', 'תה', 'תנו'];
  // How well a typed term matches a word of the text: 4 the same word, 3 with a prefix, 2 with an ending, 1 the start of
  // a word (only for the word still being typed, and only when nothing else is found), 0 not at all.
  const quality = (t, w, typing) => {
    if (w === t) return 4;
    if (t.length < 2) return 0;
    if (w.length > t.length && w.endsWith(t) && (t.length === 2 ? PRE2 : PRE).test(w.slice(0, w.length - t.length))) return 3;
    if (t.length >= 3) {
      const stems = [t]; if (t.length >= 4 && t.endsWith('ה')) stems.push(t.slice(0, -1) + 'ת', t.slice(0, -1) + 'ות');
      for (const s of stems) {
        const i = w.indexOf(s); if (i < 0 || (i > 0 && !PRE.test(w.slice(0, i)))) continue;
        const rest = w.slice(i + s.length);
        if ((rest === '' && s !== t) || SUF.includes(rest)) return 2;
      }
    }
    if (typing && w.length > t.length) { const i = w.indexOf(t); if (i === 0 || (i > 0 && i <= 3 && PRE.test(w.slice(0, i)))) return 1; }
    return 0;
  };
  // The query: its words, and the phrases written in quotes ("בת עין"), which must appear just so, word after word.
  const parse = (q) => {
    const phrases = [], rest = String(q).replace(/(^|[^\p{L}])["״“”]([^"״“”]+)["״“”](?=$|[^\p{L}])/gu, (m, b, p) => { const ts = tokens(p); if (ts.length) phrases.push(ts); return ' ' + p + ' '; });
    const terms = [...new Set(tokens(rest))];
    return { terms, phrases, typing: !/[\s"״“”]$/.test(String(q)) && terms.length > 0 };
  };
  // Where in a list of words each term matches, and how well.
  const where = (terms, words, typing) => terms.map((t, ti) => {
    const hits = [], last = typing && ti === terms.length - 1;
    for (let i = 0; i < words.length; i++) { const q = quality(t, words[i], last); if (q) hits.push([i, q]); }
    return hits;
  });
  const best = (hits, min) => hits.reduce((m, [, q]) => (q >= min && q > m ? q : m), 0);
  // The terms in this order, one right after the other.
  const inOrder = (seq, words, min) => {
    if (!seq.length || seq.length > words.length) return false;
    for (let i = 0; i + seq.length <= words.length; i++) if (seq.every((t, k) => quality(t, words[i + k]) >= min)) return true;
    return false;
  };
  // The smallest stretch of words that holds every term (a span of n is the terms side by side); `at` is where it starts.
  const span = (pos, at) => {
    const all = pos.flatMap((hs, ti) => hs.map(([i]) => [i, ti])).sort((a, b) => a[0] - b[0]), need = pos.length, have = new Map();
    let lo = 0, bestSpan = Infinity;
    for (let hi = 0; hi < all.length; hi++) {
      have.set(all[hi][1], (have.get(all[hi][1]) || 0) + 1);
      while (have.size === need) {
        const w = all[hi][0] - all[lo][0] + 1; if (w < bestSpan) { bestSpan = w; if (at) at.i = all[lo][0]; }
        const t = all[lo][1], c = have.get(t) - 1; if (c) have.set(t, c); else have.delete(t); lo++;
      }
    }
    return bestSpan;
  };
  // Score one entry (title words, text words). null if a term is missing; min is the lowest match quality that counts.
  // `some` (the fallback when nothing has every word) lets terms be missing and counts how many are there.
  const score = (Q, title, text, min = 2, some = false) => {
    const { terms, phrases, typing } = Q, n = terms.length;
    const pt = where(terms, title, typing), px = where(terms, text, typing);
    const qt = pt.map((h) => best(h, min)), qx = px.map((h) => best(h, min));
    const found = terms.map((t, i) => Math.max(qt[i], qx[i]) > 0).filter(Boolean).length;
    if (some ? !found : found < n) return null;
    for (const p of phrases) if (!inOrder(p, title, 3) && !inOrder(p, text, 3)) return null;
    const allTitle = qt.every(Boolean);
    // How close the words are counts more than where they are: the exact phrase in the title, then the phrase in the
    // text or the words side by side in the title, and so on down to words scattered far apart.
    let s = qt.reduce((a, q, i) => a + Math.max(q * 1.5, qx[i]), 0) + found * 20;
    if (n > 1) {
      const keep = (hs) => hs.filter(([, q]) => q >= min), m3 = Math.max(min, 3);
      const st = allTitle ? span(pt.map(keep)) : Infinity, sx = qx.every(Boolean) ? span(px.map(keep)) : Infinity;
      if (inOrder(terms, title, m3)) s += 100;
      else if (inOrder(terms, text, m3)) s += 70;
      else if (st <= n + 2) s += 70;
      else if (sx <= n + 2) s += 45;
      else if (allTitle) s += 40;
      else if (sx <= n + 12) s += 15;
    } else if (allTitle) s += 40;
    return { s, title: allTitle };
  };
  // Which words of a title to highlight: the indexes of its words that match a term.
  const marks = (Q, title, min = 2) => title.map((w) => Q.terms.some((t, ti) => quality(t, w, Q.typing && ti === Q.terms.length - 1) >= min));
  // A few words of the text around the closest match, for a result whose title does not hold every word: [words, flags].
  // The index keeps no final letters, so the last letter of each word gets its final form back for display.
  const UNFIN = { 'כ': 'ך', 'מ': 'ם', 'נ': 'ן', 'פ': 'ף', 'צ': 'ץ' };
  const snip = (Q, text, min = 2, size = 16) => {
    const pos = where(Q.terms, text, Q.typing).map((hs) => hs.filter(([, q]) => q >= min)).filter((hs) => hs.length);
    if (!pos.length) return null;
    const at = { i: pos[0][0][0] }; span(pos, at);
    const from = Math.max(0, at.i - 4), words = text.slice(from, from + size);
    return [words.map((w) => (w.length > 1 && UNFIN[w.at(-1)] ? w.slice(0, -1) + UNFIN[w.at(-1)] : w)), marks(Q, words, min), from > 0, from + size < text.length];
  };
  // A quick test before scoring: every term (or its stem) appears somewhere in the joined words.
  const maybe = (Q, joined) => Q.terms.every((t) => joined.includes(t.length >= 4 && t.endsWith('ה') ? t.slice(0, -1) : t));
  return { norm, tokens, quality, parse, score, marks, span, maybe, snip };
})();

if (typeof document === 'undefined') globalThis.HSearch = HS;
else {
const me = new URL(document.currentScript.src), root = me.pathname.replace(/[^/]*$/, ''), v = '?v='+encodeURIComponent(document.getElementById('results').dataset.version || me.search);
const input = document.getElementById('q'), out = document.getElementById('results'), count = document.getElementById('count');
const start = document.getElementById('sstart'); // what the page offers before anything is typed
const N = Number(out.dataset.parts), SIZE = Number(out.dataset.size), PAGE = 50;
const get = (f, priority = 'auto') => fetch(`${root}idx/${f}.json${v}`, { priority }).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
const items = []; // by index position: { id, title, lab, tw: title words, xw: text words }
const titlesDone = new Array(N).fill(false), textAsked = new Array(N).fill(false), textDone = new Array(N).fill(false);
let failed = 0, asked = false, wantText = false, timer, limit = PAGE, lastQ = '';
const more = document.createElement('button'); more.type = 'button'; more.className = 'btn ghost smore'; more.hidden = true; more.textContent = 'עוד תוצאות';
out.after(more);
more.addEventListener('click', () => { limit += PAGE; run(); });
// A title with the matched words in <mark> (text nodes only, never HTML from the index).
const titleNodes = (title, flags) => {
  const frag = document.createDocumentFragment(); let k = 0, last = 0;
  for (const m of title.matchAll(/[\p{L}\p{M}\p{N}"'״׳־]+/gu)) {
    const words = HS.tokens(m[0]); if (!words.length) continue;
    const hit = words.some((_, j) => flags[k + j]); k += words.length;
    if (!hit) continue;
    frag.append(title.slice(last, m.index)); const b = document.createElement('mark'); b.textContent = m[0]; frag.append(b); last = m.index + m[0].length;
  }
  frag.append(title.slice(last));
  return frag;
};
// Results already on screen are kept as they are; only what changed below them is replaced.
const render = (list, Q, min) => {
  let p = 0;
  while (p < out.children.length && p < list.length && out.children[p].dataset.id === list[p].r.id && out.children[p].dataset.q === lastQ) p++;
  while (out.children.length > p) out.lastChild.remove();
  const frag = document.createDocumentFragment();
  for (const { r } of list.slice(p)) {
    const a = document.createElement('a'); a.className = 'card qcard'; a.href = `${root}${r.id}/`; a.dataset.id = r.id; a.dataset.q = lastQ;
    const h = document.createElement('h3'); h.append(titleNodes(r.title, HS.marks(Q, r.tw, min))); a.append(h);
    // a holiday label (seasonal.mjs): the holiday this question is about
    // the words in the answer, when the title alone does not explain the result
    const sn = HS.marks(Q, r.tw, min).filter(Boolean).length < Q.terms.length && HS.snip(Q, r.xw, min);
    if (sn) {
      const p = document.createElement('p'); p.className = 'ssnip'; p.append(sn[2] ? '… ' : '');
      sn[0].forEach((w, i) => { if (i) p.append(' '); if (sn[1][i]) { const b = document.createElement('mark'); b.textContent = w; p.append(b); } else p.append(w); });
      if (sn[3]) p.append(' …');
      a.append(p);
    }
    if (r.lab) { const l = document.createElement('span'); l.className = 'qtag'; l.textContent = r.lab; a.append(l); }
    frag.append(a);
  }
  out.append(frag);
};
const rank = (Q, min, some) => {
  const hits = [];
  for (let i = 0; i < items.length; i++) {
    const r = items[i]; if (!r || (!some && !HS.maybe(Q, r.j))) continue;
    const sc = HS.score(Q, r.tw, r.xw, min, some); if (sc) hits.push({ r, i, s: sc.s, t: sc.title });
  }
  // by score; equal scores keep the order of the index
  return hits.sort((a, b) => (b.s - a.s) || (a.i - b.i));
};
const run = () => {
  const raw = input.value, Q = HS.parse(raw);
  if (start) start.hidden = Q.terms.length > 0;
  const key = Q.terms.join(' ') + '|' + Q.phrases.map((p) => p.join(' ')).join('|');
  if (key !== lastQ) { lastQ = key; limit = PAGE; }
  try { const u = new URL(location.href); if (raw.trim()) u.searchParams.set('q', raw.trim()); else u.searchParams.delete('q'); history.replaceState(history.state, '', u); } catch { /* not allowed here: the address just stays */ }
  if (!Q.terms.length) { out.textContent = ''; count.textContent = ''; more.hidden = true; return; }
  // Results are ranked over the whole index, so they wait for every title part (about 200KB, fetched together).
  if (!titlesDone.every(Boolean)) { count.textContent = 'טוען…'; if (!out.querySelector('.qcard')) out.innerHTML = '<div class="card skel" aria-hidden="true"><i></i><i></i></div>'.repeat(6); more.hidden = true; return; }
  const done = textDone.every(Boolean);
  // Whole words first. Nothing? The last word may still be being typed: then the start of a word counts. Still nothing,
  // once the search is complete: entries with only some of the words, said so plainly (as the big search engines do).
  let hits = rank(Q, 2, false), min = 2, note = '';
  if (!hits.length && Q.typing) { hits = rank(Q, 1, false); min = 1; }
  if (!hits.length && done && Q.terms.length > 1 && !Q.phrases.length) { hits = rank(Q, 2, true); note = 'לא נמצאו תוצאות שיש בהן את כל המילים. אלה תוצאות עם חלק מהן'; }
  const partial = failed ? ' · חלק מהחיפוש לא נטען, ולכן ייתכן שיש עוד תוצאות. בדקו את החיבור ורעננו את העמוד.' : '';
  count.textContent = (note ? note + ' · ' : '') + (hits.length ? `נמצאו ${hits.length.toLocaleString('he-IL')} תוצאות${done ? '' : ' · ממשיך לחפש…'}` : done ? 'לא נמצאו תוצאות' : 'מחפש…') + partial;
  render(hits.slice(0, limit), Q, min);
  more.hidden = hits.length <= limit;
};
const refresh = () => { if (input.value.trim()) run(); };
const loadText = (k) => {
  if (textAsked[k]) return; textAsked[k] = true;
  get(k).then((w) => { w.forEach((txt, i) => { const r = items[k * SIZE + i]; if (r) { r.xw = txt ? txt.split(' ') : []; r.j += ' ' + txt; } }); })
    .catch(() => { failed++; })
    .finally(() => { textDone[k] = true; refresh(); });
};
const wantFullText = () => { wantText = true; for (let k = 0; k < N; k++) if (titlesDone[k]) loadText(k); };
// Titles load once the page is on screen and the browser is idle, so they never compete with the first paint.
// A query in the address, or typing before then, fetches them at once. A part's full text follows its titles.
const loadPart = (k, priority) => get(`t${k}`, priority)
  .then((t) => { t.forEach(([id, title, lab], i) => { const tw = HS.tokens(lab ? `${title} ${lab}` : title); items[k * SIZE + i] = { id, title, lab, tw, xw: [], j: tw.join(' ') }; }); })
  .catch(() => { failed++; textAsked[k] = textDone[k] = true; }) // no titles, so nothing to add text to
  .finally(() => {
    titlesDone[k] = true;
    if (titlesDone.every(Boolean) && !items.some(Boolean)) count.textContent = 'החיפוש לא נטען. בדקו את החיבור ורעננו את העמוד.';
    else refresh();
  });
const loadTitles = (priority) => {
  if (asked) return; asked = true;
  for (let k = 0; k < N; k++) loadPart(k, priority === 'high' ? 'high' : 'low').then(() => { if (wantText) loadText(k); });
};
// The page is on screen once the head script marks it ready (stylesheet and, on a first visit, fonts in; see layout.mjs).
const whenShown = (fn) => {
  const html = document.documentElement, idle = window.requestIdleCallback || ((f) => setTimeout(f, 200));
  const go = () => idle(fn, { timeout: 2000 });
  const afterLoad = () => (document.readyState === 'complete' ? go() : addEventListener('load', go, { once: true }));
  if (html.classList.contains('ready')) return afterLoad();
  const mo = new MutationObserver(() => { if (html.classList.contains('ready')) { mo.disconnect(); afterLoad(); } });
  mo.observe(html, { attributes: true, attributeFilter: ['class'] });
};
input.value = new URLSearchParams(location.search).get('q') || '';
input.addEventListener('input', () => { loadTitles('high'); wantFullText(); clearTimeout(timer); timer = setTimeout(run, 120); });
if (input.value) { run(); loadTitles('high'); wantFullText(); }
else whenShown(() => loadTitles('low'));
}
