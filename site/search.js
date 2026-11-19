// Search page (index built by scripts/lib/sections/search.mjs). Three kinds of files, so a search waits for little:
// - the titles, in 8 parts (about 250KB compressed), fetched once the page is idle or a search box is focused;
// - the word index (idx/w/…, scripts/lib/search-index.mjs): for each word, the entries whose full text holds it, and
//   where. A search fetches only the files of the words typed (a few KB to a few dozen KB each), never the whole text;
// - for a snippet, the result's own page, fetched only when its card nears the screen, after the results are shown.
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
  const SUF = ['ו', 'ה', 'י', 'ך', 'כ', 'ם', 'מ', 'ן', 'נ', 'ים', 'ות', 'יו', 'יה', 'נו', 'כמ', 'הם', 'הן', 'הנ', 'יכ', 'ינו', 'יהם', 'יהמ'];
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
  // The terms in this order, one right after the other (hits: per term, its [position, quality] list).
  const inOrder = (hits, min) => {
    if (!hits.length || hits.some((h) => !h.length)) return false;
    const at = hits.map((h) => new Set(h.filter(([, q]) => q >= min).map(([i]) => i)));
    for (const p of at[0]) if (at.every((s, k) => s.has(p + k))) return true;
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
  // Score one entry: its title words, and where each term is in its text (px, per term [position, quality], from the word
  // index; where() gives the same from a list of words). null if a term is missing; min is the lowest quality that counts.
  // `some` (the fallback when nothing has every word) lets terms be missing and counts how many are there.
  const score = (Q, title, px, min = 2, some = false) => {
    const { terms, phrases, typing } = Q, n = terms.length;
    const pt = where(terms, title, typing);
    const qt = pt.map((h) => best(h, min)), qx = px.map((h) => best(h, min));
    const found = terms.map((t, i) => Math.max(qt[i], qx[i]) > 0).filter(Boolean).length;
    if (some ? !found : found < n) return null;
    const pick = (hs, seq) => seq.map((t) => hs[terms.indexOf(t)] || []);
    for (const p of phrases) if (!inOrder(pick(pt, p), 3) && !inOrder(pick(px, p), 3)) return null;
    const allTitle = qt.every(Boolean);
    // How close the words are counts more than where they are: the exact phrase in the title, then the phrase in the
    // text or the words side by side in the title, and so on down to words scattered far apart.
    let s = qt.reduce((a, q, i) => a + Math.max(q * 1.5, qx[i]), 0) + found * 20;
    if (n > 1) {
      const keep = (hs) => hs.filter(([, q]) => q >= min), m3 = Math.max(min, 3);
      const st = allTitle ? span(pt.map(keep)) : Infinity, sx = qx.every(Boolean) ? span(px.map(keep)) : Infinity;
      if (inOrder(pt, m3)) s += 100;
      else if (inOrder(px, m3)) s += 70;
      else if (st <= n + 2) s += 70;
      else if (sx <= n + 2) s += 45;
      else if (allTitle) s += 40;
      else if (sx <= n + 12) s += 15;
    } else if (allTitle) s += 40;
    return { s, title: allTitle };
  };
  // Which words of a title to highlight: the indexes of its words that match a term.
  const marks = (Q, title, min = 2) => title.map((w) => Q.terms.some((t, ti) => quality(t, w, Q.typing && ti === Q.terms.length - 1) >= min));
  // Where to cut a snippet from a text (its words, normalized): around the closest match of the terms, `size` words.
  // Returns { from, to, flags } (flags: which of those words matched), or null if no term is in the text.
  const snip = (Q, text, min = 2, size = 18) => {
    const pos = where(Q.terms, text, Q.typing).map((hs) => hs.filter(([, q]) => q >= min)).filter((hs) => hs.length);
    if (!pos.length) return null;
    const at = { i: pos[0][0][0] }; span(pos, at);
    const from = Math.max(0, at.i - 5), to = Math.min(text.length, from + size);
    return { from, to, flags: marks(Q, text.slice(from, to), min) };
  };
  // The word index (scripts/lib/search-index.mjs): its file for a term, and its postings read back to [[entry, [positions]]].
  const shardKey = (t, split) => (t.length > 2 && split.includes(t.slice(0, 2)) ? t.slice(0, 3) : t.slice(0, 2));
  const keyFile = (key) => [...key].map((c) => c.codePointAt(0).toString(36)).join('-');
  const A = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_', AV = Object.fromEntries([...A].map((c, i) => [c, i]));
  const decode = (str) => {
    const nums = []; let n = 0;
    for (const c of str) { const v = AV[c]; n = n * 32 + (v & 31); if (v < 32) { nums.push(n); n = 0; } }
    const out = []; let d = 0;
    for (let i = 0; i < nums.length;) {
      d += nums[i]; const k = nums[i + 1], ps = new Array(k);
      for (let j = 0; j < k; j++) ps[j] = j ? ps[j - 1] + nums[i + 2 + j] : nums[i + 2];
      out.push([d, ps]); i += 2 + k;
    }
    return out;
  };
  // A quick test before scoring: every term (or its stem) appears somewhere in the joined words.
  const maybe = (Q, joined) => Q.terms.every((t) => joined.includes(t.length >= 4 && t.endsWith('ה') ? t.slice(0, -1) : t));
  return { norm, tokens, quality, parse, score, marks, span, maybe, snip, where, shardKey, keyFile, decode };
})();

if (typeof document === 'undefined') globalThis.HSearch = HS;
else {
const me = new URL(document.currentScript.src), root = me.pathname.replace(/[^/]*$/, ''), v = '?v='+encodeURIComponent(document.getElementById('results').dataset.version || me.search);
const input = document.getElementById('q'), out = document.getElementById('results'), count = document.getElementById('count');
const start = document.getElementById('sstart'); // what the page offers before anything is typed
const N = Number(out.dataset.parts), SIZE = Number(out.dataset.size), SPLIT = (out.dataset.split || '').split(' ').filter(Boolean), PAGE = 50;
const get = (f, priority = 'auto') => fetch(`${root}idx/${f}.json${v}`, { priority }).then((r) => { if (r.status === 404) return {}; if (!r.ok) throw new Error(r.status); return r.json(); });
const items = []; // by index position: { id, title, lab, tw: title words, tj: the same joined }
const titlesDone = new Array(N).fill(false);
const shards = new Map(), decoded = new Map(); // key -> promise of its file; word -> its postings read back
let failed = 0, asked = false, timer, limit = PAGE, lastQ = '', runs = 0;
const more = document.createElement('button'); more.type = 'button'; more.className = 'btn ghost smore'; more.hidden = true; more.textContent = 'עוד תוצאות';
out.after(more);
more.addEventListener('click', () => { limit += PAGE; run(); });
const shard = (key) => {
  if (!shards.has(key)) shards.set(key, get(`w/${HS.keyFile(key)}`, 'high').catch(() => { failed++; shards.delete(key); return {}; }));
  return shards.get(key);
};
const postings = (w, p) => { let d = decoded.get(w); if (!d) decoded.set(w, (d = HS.decode(p))); return d; };
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
// Under a result whose title does not hold every word: the sentence of the answer where they are, so it is clear why it
// came up (as search engines show). The result's own page is fetched once its card nears the screen (the browser keeps
// it, so opening the result is then instant); its paragraphs are cut into words and the snippet is taken around the match.
const pages = new Map();
const pageWords = (href) => {
  if (!pages.has(href)) pages.set(href, fetch(href, { priority: 'low' }).then((r) => (r.ok ? r.text() : '')).then((html) => {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const text = [...doc.querySelectorAll('article.qa .sheet p')].map((p) => p.textContent).join(' ').replace(/[֑-ֽֿ-ׇ]/g, '');
    // norm: the words as the search reads them; of: for each, which written word it came from ("ראש־השנה" gives two)
    const orig = [], norm = [], of = [];
    for (const m of text.matchAll(/[\p{L}\p{N}"'״׳־]+/gu)) { const ts = HS.tokens(m[0]); if (ts.length) orig.push(m[0]); for (const t of ts) { norm.push(t); of.push(orig.length - 1); } }
    return { orig, norm, of };
  }).catch(() => ({ orig: [], norm: [], of: [] })));
  return pages.get(href);
};
const needSnip = new Map(); // card -> [Q, min]
const fillSnip = (a) => {
  const [Q, min] = needSnip.get(a) || []; needSnip.delete(a); if (!Q) return;
  pageWords(a.href).then(({ orig, norm, of }) => {
    const sn = a.isConnected && HS.snip(Q, norm, min);
    if (!sn) return;
    const p = document.createElement('p'); p.className = 'ssnip'; p.append(sn.from > 0 ? '… ' : '');
    for (let j = sn.from; j < sn.to; j++) {
      const w = of[j], hit = sn.flags[j - sn.from];
      if (j > sn.from && w === of[j - 1]) { if (hit && p.lastChild.nodeType === 3) { const b = document.createElement('mark'); b.textContent = p.lastChild.textContent; p.lastChild.replaceWith(b); } continue; }
      if (j > sn.from) p.append(' ');
      if (hit) { const b = document.createElement('mark'); b.textContent = orig[w]; p.append(b); } else p.append(orig[w]);
    }
    if (sn.to < norm.length) p.append(' …');
    a.querySelector('h3').after(p);
  });
};
const seen = 'IntersectionObserver' in window ? new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { seen.unobserve(e.target); fillSnip(e.target); } }), { rootMargin: '300px 0px' }) : null;
const addSnip = (a, Q, min) => { needSnip.set(a, [Q, min]); if (seen) seen.observe(a); else fillSnip(a); };
// Results already on screen are kept as they are; only what changed below them is replaced.
const render = (list, Q, min) => {
  let p = 0;
  while (p < out.children.length && p < list.length && out.children[p].dataset.id === list[p].r.id && out.children[p].dataset.q === lastQ) p++;
  while (out.children.length > p) { const c = out.lastChild; needSnip.delete(c); if (seen) seen.unobserve(c); c.remove(); }
  const frag = document.createDocumentFragment();
  for (const { r } of list.slice(p)) {
    const a = document.createElement('a'); a.className = 'card qcard'; a.href = `${root}${r.id}/`; a.dataset.id = r.id; a.dataset.q = lastQ;
    const flags = HS.marks(Q, r.tw, min), h = document.createElement('h3'); h.append(titleNodes(r.title, flags)); a.append(h);
    // a holiday label (seasonal.mjs): the holiday this question is about
    if (r.lab) { const l = document.createElement('span'); l.className = 'qtag'; l.textContent = r.lab; a.append(l); }
    if (flags.filter(Boolean).length < Q.terms.length) addSnip(a, Q, min);
    frag.append(a);
  }
  out.append(frag);
};
// Where each term is in the text of each entry: per term, Map entry -> [[position, quality]].
const textHits = (Q, files) => Q.terms.map((t, ti) => {
  const m = new Map(), last = Q.typing && ti === Q.terms.length - 1;
  for (const [w, p] of Object.entries(files[ti])) {
    const q = HS.quality(t, w, last); if (!q) continue;
    for (const [d, ps] of postings(w, p)) { let a = m.get(d); if (!a) m.set(d, (a = [])); for (const x of ps) a.push([x, q]); }
  }
  return m;
});
const rank = (Q, tx, min, some) => {
  // the entries that may hold the words: those whose text holds one, and those whose title may
  const cand = new Set();
  for (const m of tx) for (const d of m.keys()) cand.add(d);
  for (let i = 0; i < items.length; i++) if (items[i] && Q.terms.some((t) => items[i].tj.includes(t.length >= 4 && t.endsWith('ה') ? t.slice(0, -1) : t))) cand.add(i);
  const hits = [];
  for (const i of cand) {
    const r = items[i]; if (!r) continue;
    const sc = HS.score(Q, r.tw, tx.map((m) => m.get(i) || []), min, some); if (sc) hits.push({ r, i, s: sc.s });
  }
  return hits.sort((a, b) => (b.s - a.s) || (a.i - b.i)); // equal scores keep the order of the index
};
const run = async () => {
  const raw = input.value, Q = HS.parse(raw), my = ++runs;
  if (start) start.hidden = Q.terms.length > 0;
  const key = Q.terms.join(' ') + '|' + Q.phrases.map((p) => p.join(' ')).join('|');
  if (key !== lastQ) { lastQ = key; limit = PAGE; }
  try { const u = new URL(location.href); if (raw.trim()) u.searchParams.set('q', raw.trim()); else u.searchParams.delete('q'); history.replaceState(history.state, '', u); } catch { /* not allowed here: the address just stays */ }
  if (!Q.terms.length) { out.textContent = ''; count.textContent = ''; more.hidden = true; return; }
  const files = Promise.all(Q.terms.map((t) => shard(HS.shardKey(t, SPLIT)))); // at once, alongside the titles
  if (!titlesDone.every(Boolean) || !out.querySelector('.qcard')) {
    count.textContent = 'מחפש…'; more.hidden = true;
    if (!out.querySelector('.qcard')) out.innerHTML = '<div class="card skel" aria-hidden="true"><i></i><i></i></div>'.repeat(6);
  }
  const fl = await files;
  if (my !== runs || !titlesDone.every(Boolean)) return; // a newer search, or the titles are still coming (they run it again)
  const tx = textHits(Q, fl);
  // Whole words first. Nothing? The last word may still be being typed: then the start of a word counts. Still nothing:
  // entries with only some of the words, said so plainly (as the big search engines do).
  let hits = rank(Q, tx, 2, false), min = 2, note = '';
  if (!hits.length && Q.typing) { hits = rank(Q, tx, 1, false); min = 1; }
  if (!hits.length && Q.terms.length > 1 && !Q.phrases.length) { hits = rank(Q, tx, 2, true); note = 'לא נמצאו תוצאות שיש בהן את כל המילים. אלה תוצאות עם חלק מהן'; }
  const partial = failed ? ' · חלק מהחיפוש לא נטען, ולכן ייתכן שיש עוד תוצאות. בדקו את החיבור ורעננו את העמוד.' : '';
  count.textContent = (note ? note + ' · ' : '') + (hits.length ? `נמצאו ${hits.length.toLocaleString('he-IL')} תוצאות` : 'לא נמצאו תוצאות') + partial;
  render(hits.slice(0, limit), Q, min);
  more.hidden = hits.length <= limit;
};
const refresh = () => { if (input.value.trim()) run(); };
// Titles load once the page is on screen and the browser is idle, so they never compete with the first paint.
// A query in the address, or typing before then, fetches them at once.
const loadPart = (k, priority) => get(`t${k}`, priority)
  .then((t) => { t.forEach(([id, title, lab], i) => { const tw = HS.tokens(lab ? `${title} ${lab}` : title); items[k * SIZE + i] = { id, title, lab, tw, tj: tw.join(' ') }; }); })
  .catch(() => { failed++; })
  .finally(() => {
    titlesDone[k] = true;
    if (!titlesDone.every(Boolean)) return;
    if (!items.some(Boolean)) count.textContent = 'החיפוש לא נטען. בדקו את החיבור ורעננו את העמוד.';
    else refresh();
  });
const loadTitles = (priority) => {
  if (asked) return; asked = true;
  for (let k = 0; k < N; k++) loadPart(k, priority);
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
// Typing: the titles at once, and the word files of what is typed so far after a short pause (fewer requests mid-word).
input.addEventListener('input', () => { loadTitles('high'); clearTimeout(timer); timer = setTimeout(run, 150); });
input.addEventListener('focus', () => loadTitles('high'), { once: true });
if (input.value) { loadTitles('high'); run(); }
else whenShown(() => loadTitles('low'));
}
