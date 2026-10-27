// Titles load first so results appear at once; full-text shards fill in as they arrive.
const me = new URL(document.currentScript.src), root = me.pathname.replace(/[^/]*$/, ''), v = me.search;
const input = document.getElementById('q'), out = document.getElementById('results'), count = document.getElementById('count');
const strip = (s) => s.replace(/[֑-ׇ]/g, '').replace(/[^\p{L}\p{N}\s]/gu, ' ');
const get = (f) => fetch(`${root}idx/${f}.json${v}`).then((r) => r.json());
let items = null, shards = 0, total = 0, timer;
const run = () => {
  const terms = strip(input.value).trim().split(/\s+/).filter(Boolean);
  out.textContent = ''; count.textContent = '';
  if (!terms.length) return;
  if (!items) { count.textContent = 'טוען…'; return; }
  const hits = items.filter((r) => terms.every((t) => r.s.includes(t)));
  const more = shards < total ? ' · ממשיך לחפש בתוך התשובות…' : '';
  count.textContent = (hits.length ? `נמצאו ${hits.length} תוצאות${hits.length > 50 ? ' (מוצגות 50 הראשונות)' : ''}` : shards < total ? 'מחפש…' : 'לא נמצאו תוצאות') + (hits.length ? more : '');
  const frag = document.createDocumentFragment();
  for (const r of hits.slice(0, 50)) {
    const a = document.createElement('a'); a.className = 'card qcard'; a.href = `${root}${r.id}/`;
    const h = document.createElement('h3'); h.textContent = r.title; a.append(h); frag.append(a);
  }
  out.append(frag);
};
input.value = new URLSearchParams(location.search).get('q') || '';
input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 120); });
if (input.value) count.textContent = 'טוען…';
get('titles').then((d) => {
  items = d.t.map(([id, title]) => ({ id, title, s: strip(title) }));
  total = d.n; run();
  for (let k = 0; k < d.n; k++) get(k).then((w) => {
    w.forEach((txt, i) => { const r = items[k * d.size + i]; r.s += ' ' + txt; });
    shards++; if (input.value.trim()) run();
  }).catch(() => { shards++; });
}).catch(() => { count.textContent = 'החיפוש לא נטען. בדקו את החיבור ורעננו את העמוד.'; });
