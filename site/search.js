// Search page. The index comes in parts (built by scripts/lib/sections/search.mjs), each with a titles file and a full-text file.
// Results are listed in index order, so the first part alone already gives the first results: they show as soon as it
// arrives, and later parts only add results below. A part's full text is fetched once there is something to search for.
{
const me = new URL(document.currentScript.src), root = me.pathname.replace(/[^/]*$/, ''), v = me.search;
const input = document.getElementById('q'), out = document.getElementById('results'), count = document.getElementById('count');
const N = Number(out.dataset.parts), SIZE = Number(out.dataset.size);
const strip = (s) => s.replace(/[֑-ׇ]/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ');
const get = (f, priority = 'auto') => fetch(`${root}idx/${f}.json${v}`, { priority }).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
const items = []; // by index position, filled in as title parts arrive
const titlesDone = new Array(N).fill(false), textAsked = new Array(N).fill(false), textDone = new Array(N).fill(false);
let failed = 0, asked = false, wantText = false, timer;
// Title parts done from the first one on, in order: only these are searched, so a later part never pushes in above
// results already shown (the full text of a part can still add matches among them, as it arrives).
const readyParts = () => { let k = 0; while (k < N && titlesDone[k]) k++; return k; };
// Results already on screen are kept as they are; only what changed below them is replaced. Redrawing the whole list
// on every part would repaint the top results again and again (a late "largest paint", and a jumpy list).
const render = (list) => {
  let p = 0;
  while (p < out.children.length && p < list.length && out.children[p].dataset.id === list[p].id) p++;
  while (out.children.length > p) out.lastChild.remove();
  const frag = document.createDocumentFragment();
  for (const r of list.slice(p)) {
    const a = document.createElement('a'); a.className = 'card qcard'; a.href = `${root}${r.id}/`; a.dataset.id = r.id;
    const h = document.createElement('h3'); h.textContent = r.title; a.append(h); frag.append(a);
  }
  out.append(frag);
};
const run = () => {
  const terms = strip(input.value).trim().split(/\s+/).filter(Boolean);
  if (!terms.length) { out.textContent = ''; count.textContent = ''; return; }
  const parts = readyParts();
  if (!parts) { count.textContent = 'טוען…'; out.innerHTML = '<div class="card skel" aria-hidden="true"><i></i><i></i></div>'.repeat(6); return; }
  // The list only ever grows at its end, so results on screen never move. First the matches in the title, part by part
  // in order; then, once every title is in, the matches found only inside the answers, again part by part in order.
  const inTitle = [], inText = [];
  for (let i = 0; i < parts * SIZE; i++) { const r = items[i]; if (r && terms.every((t) => r.t.includes(t))) inTitle.push(r); }
  if (parts === N) {
    let textParts = 0; while (textParts < N && textDone[textParts]) textParts++;
    for (let i = 0; i < textParts * SIZE; i++) { const r = items[i]; if (r && !terms.every((t) => r.t.includes(t)) && terms.every((t) => r.s.includes(t))) inText.push(r); }
  }
  const hits = inTitle.concat(inText), done = parts === N && textDone.every(Boolean);
  // A part that failed to load means the search was incomplete: say so instead of a plain "no results".
  const partial = failed ? ' · חלק מהחיפוש לא נטען, ולכן ייתכן שיש עוד תוצאות. בדקו את החיבור ורעננו את העמוד.' : '';
  count.textContent = (hits.length ? `נמצאו ${hits.length} תוצאות${hits.length > 50 ? ' (מוצגות 50 הראשונות)' : ''}${done ? '' : ' · ממשיך לחפש…'}` : done ? 'לא נמצאו תוצאות' : 'מחפש…') + partial;
  render(hits.slice(0, 50));
};
const refresh = () => { if (input.value.trim()) run(); };
const loadText = (k) => {
  if (textAsked[k]) return; textAsked[k] = true;
  get(k).then((w) => { w.forEach((txt, i) => { const r = items[k * SIZE + i]; if (r) r.s += ' ' + txt; }); })
    .catch(() => { failed++; })
    .finally(() => { textDone[k] = true; refresh(); });
};
const wantFullText = () => { wantText = true; for (let k = 0; k < N; k++) if (titlesDone[k]) loadText(k); };
// Titles load once the page is on screen and the browser is idle, so they never compete with the first paint.
// A query in the address, or typing before then, fetches them at once. A part's full text follows its titles.
const loadPart = (k, priority) => get(`t${k}`, priority)
  .then((t) => { t.forEach(([id, title], i) => { const t = strip(title); items[k * SIZE + i] = { id, title, t, s: t }; }); })
  .catch(() => { failed++; textAsked[k] = textDone[k] = true; }) // no titles, so nothing to add text to
  .finally(() => {
    titlesDone[k] = true;
    if (readyParts() === N && !items.some(Boolean)) count.textContent = 'החיפוש לא נטען. בדקו את החיבור ורעננו את העמוד.';
    else refresh();
  });
const loadTitles = (priority) => {
  if (asked) return; asked = true;
  // All title parts at once (about 200KB together); the first at the requested priority, so its results come first.
  for (let k = 0; k < N; k++) loadPart(k, k ? (priority === 'high' ? 'auto' : 'low') : priority).then(() => { if (wantText) loadText(k); });
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
