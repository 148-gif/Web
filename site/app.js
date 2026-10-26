// Mobile menu, hide-on-scroll header, reading tools, campaign sticky CTA, search warm-up.
{
const me = new URL(document.currentScript.src);

// Start fetching the search index as soon as someone shows intent to search, so results are instant.
let warm = false;
const warmSearch = () => {
  if (warm) return; warm = true;
  const base = me.pathname.replace(/[^/]*$/, '');
  fetch(`${base}idx/titles.json${me.search}`).then((r) => r.json()).then((d) => { for (let k = 0; k < d.n; k++) fetch(`${base}idx/${k}.json${me.search}`); }).catch(() => {});
};
document.querySelectorAll('input[name=q]').forEach((el) => el.addEventListener('focus', warmSearch, { once: true }));
document.querySelectorAll('a[href*="/search/"]').forEach((el) => ['pointerenter', 'touchstart', 'focus'].forEach((ev) => el.addEventListener(ev, warmSearch, { once: true, passive: true })));
const hdr = document.querySelector('.top'), btn = document.querySelector('.mbtn');
const setMenu = (open) => { hdr.classList.toggle('open', open); btn.setAttribute('aria-expanded', open); document.body.classList.toggle('menu-open', open); };
btn.addEventListener('click', () => setMenu(!hdr.classList.contains('open')));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && hdr.classList.contains('open')) { setMenu(false); btn.focus(); } });
document.addEventListener('click', (e) => { if (hdr.classList.contains('open') && !hdr.contains(e.target)) setMenu(false); });

let lastY = scrollY, tick = false;
const bar = document.querySelector('.readbar i'), sheet = document.querySelector('.sheet');
const onScroll = () => {
  tick = false;
  const y = scrollY;
  if (!hdr.classList.contains('open')) hdr.classList.toggle('hide', y > 160 && y > lastY + 4 ? true : y < lastY - 4 ? false : hdr.classList.contains('hide'));
  lastY = y;
  if (bar && sheet) { const r = sheet.getBoundingClientRect(); bar.style.transform = `scaleX(${Math.min(1, Math.max(0, -r.top / (r.height - innerHeight * 0.6)))})`; }
};
addEventListener('scroll', () => { if (!tick) { tick = true; requestAnimationFrame(onScroll); } }, { passive: true });

const root = document.documentElement;
document.querySelectorAll('[data-fs]').forEach((b) => b.addEventListener('click', () => {
  const cur = parseFloat(getComputedStyle(root).getPropertyValue('--rs')) || 1;
  const v = Math.min(1.5, Math.max(0.85, Math.round((cur + 0.1 * b.dataset.fs) * 100) / 100));
  root.style.setProperty('--rs', v);
  try { localStorage.setItem('rs', v); } catch (e) {}
}));
document.querySelectorAll('[data-share]').forEach((b) => b.addEventListener('click', () => {
  const title = document.querySelector('h1').textContent, url = location.href;
  if (navigator.share) navigator.share({ title, url }).catch(() => {});
  else open(`https://wa.me/?text=${encodeURIComponent(title + '\n' + url)}`, '_blank', 'noopener');
}));

const stick = document.querySelector('.stickcta');
if (stick && 'IntersectionObserver' in window) {
  const seen = new Set();
  const io = new IntersectionObserver((es) => { es.forEach((e) => (e.isIntersecting ? seen.add(e.target) : seen.delete(e.target))); stick.classList.toggle('show', !seen.size); });
  document.querySelectorAll('.phero2 .btn, .final .btn, #donate').forEach((el) => io.observe(el));
} else if (stick) stick.classList.add('show');
}
