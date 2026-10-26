const input = document.getElementById('q'), out = document.getElementById('results'), count = document.getElementById('count');
const strip = (s) => s.replace(/[֑-ׇ]/g, '');
// index: [id, title, text]; fast = first 600 chars (loads quickly), full = whole text (loads in background)
let index = null, full = null, timer, failed = false;
const run = () => {
  const terms = strip(input.value).trim().split(/\s+/).filter(Boolean);
  out.textContent = ''; count.textContent = '';
  if (!terms.length) return;
  if (failed) { count.textContent = 'טעינת החיפוש נכשלה. רעננו את הדף ונסו שוב.'; return; }
  if (!index) { count.textContent = 'טוען את החיפוש…'; return; }
  const text = (i) => (full ? full[i] : index[i][2]);
  const hits = [];
  index.forEach((r, i) => {
    if (!terms.every((t) => text(i).includes(t))) return;
    const title = strip(r[1]);
    hits.push([terms.every((t) => title.includes(t)) ? 0 : 1, i]);
  });
  hits.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  count.textContent = hits.length ? `נמצאו ${hits.length} תוצאות${hits.length > 50 ? ' (מוצגות 50 הראשונות)' : ''}${full ? '' : ' · ממשיך לחפש בטקסט המלא…'}` : full ? 'לא נמצאו תוצאות' : 'לא נמצאו תוצאות עדיין · ממשיך לחפש בטקסט המלא…';
  for (const [, i] of hits.slice(0, 50)) {
    const [id, title] = index[i];
    const a = document.createElement('a'); a.className = 'card qcard'; a.href = `/shut/${id}/`;
    const h = document.createElement('h3'); h.textContent = title; a.append(h); out.append(a);
  }
};
const load = (url) => fetch(url).then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
input.value = new URLSearchParams(location.search).get('q') || '';
input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 150); });
run();
load('/search-index.json').then((d) => { index = d; run(); return load('/search-full.json'); })
  .then((d) => { full = d; run(); })
  .catch(() => { if (!index) { failed = true; run(); } });
