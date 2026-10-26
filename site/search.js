const input = document.getElementById('q'), out = document.getElementById('results'), count = document.getElementById('count');
const strip = (s) => s.replace(/[֑-ׇ]/g, '');
let index = null, timer;
const run = () => {
  const terms = strip(input.value).trim().split(/\s+/).filter(Boolean);
  out.textContent = ''; count.textContent = '';
  if (!terms.length || !index) return;
  const hits = index.filter((r) => terms.every((t) => r[2].includes(t)));
  count.textContent = hits.length ? `נמצאו ${hits.length} תוצאות${hits.length > 50 ? ' (מוצגות 50 הראשונות)' : ''}` : 'לא נמצאו תוצאות';
  for (const [id, title] of hits.slice(0, 50)) {
    const a = document.createElement('a'); a.className = 'card'; a.href = `/shut/${id}/`;
    const h = document.createElement('h3'); h.textContent = title; a.append(h); out.append(a);
  }
};
input.value = new URLSearchParams(location.search).get('q') || '';
input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 150); });
fetch('/search-index.json').then((r) => r.json()).then((d) => { index = d; run(); });
