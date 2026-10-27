// Titles load first so results appear at once; the full-text shards are fetched on the first search and fill in as they arrive.
const me = new URL(document.currentScript.src), root = me.pathname.replace(/[^/]*$/, ''), v = me.search;
const input = document.getElementById('q'), out = document.getElementById('results'), count = document.getElementById('count');
const strip = (s) => s.replace(/[֑-ׇ]/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ');
const get = (f) => fetch(`${root}idx/${f}.json${v}`).then((r) => r.json());
let items = null, shards = 0, failed = 0, total = 0, size = 0, loading = false, timer;
const run = () => {
  const terms = strip(input.value).trim().split(/\s+/).filter(Boolean);
  out.textContent = ''; count.textContent = '';
  if (!terms.length) return;
  if (!items) { count.textContent = 'טוען…'; out.innerHTML = '<div class="card skel" aria-hidden="true"><i></i><i></i></div>'.repeat(6); return; }
  const hits = items.filter((r) => terms.every((t) => r.s.includes(t)));
  const more = shards < total ? ' · ממשיך לחפש בתוך התשובות…' : '';
  // A shard that failed to load means the answers' text was only partly searched: say so instead of "no results".
  const partial = failed ? ' · חלק מהחיפוש לא נטען, ולכן ייתכן שיש עוד תוצאות. בדקו את החיבור ורעננו את העמוד.' : '';
  count.textContent = (hits.length ? `נמצאו ${hits.length} תוצאות${hits.length > 50 ? ' (מוצגות 50 הראשונות)' : ''}` : shards < total ? 'מחפש…' : 'לא נמצאו תוצאות') + (hits.length ? more : '') + partial;
  const frag = document.createDocumentFragment();
  for (const r of hits.slice(0, 50)) {
    const a = document.createElement('a'); a.className = 'card qcard'; a.href = `${root}${r.id}/`;
    const h = document.createElement('h3'); h.textContent = r.title; a.append(h); frag.append(a);
  }
  out.append(frag);
};
input.value = new URLSearchParams(location.search).get('q') || '';
const loadText = () => {
  if (loading || !items || !input.value.trim()) return;
  loading = true;
  for (let k = 0; k < total; k++) get(k).then((w) => {
    w.forEach((txt, i) => { const r = items[k * size + i]; r.s += ' ' + txt; });
    shards++; if (input.value.trim()) run();
  }).catch(() => { shards++; failed++; if (input.value.trim()) run(); });
};
input.addEventListener('input', () => { loadText(); clearTimeout(timer); timer = setTimeout(run, 120); });
if (input.value) run();
get('titles').then((d) => {
  items = d.t.map(([id, title]) => ({ id, title, s: strip(title) }));
  total = d.n; size = d.size; run(); loadText();
}).catch(() => { count.textContent = 'החיפוש לא נטען. בדקו את החיבור ורעננו את העמוד.'; });
