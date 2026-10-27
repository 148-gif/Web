// Zmanim of Yavne'el from zmanim.json (made by scripts/gen-zmanim.mjs, Israel time):
//  - the daily zmanim box (#zmanim) with day-by-day navigation;
//  - the calculated time next to every prayer or mikveh time that is written relative to the sun (.zl, see parts.mjs).
{
const me = new URL(document.currentScript.src);
const dayKey = (d) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
const shift = (key, n) => { const [y, m, d] = key.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n, 12)).toISOString().slice(0, 10); };
const dowOf = (key) => new Date(`${key}T12:00:00Z`).getUTCDay();
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const hm = (sec) => { const m = Math.round(sec / 60); return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };

fetch(new URL(`zmanim.json${me.search}`, me)).then((r) => r.json()).then(({ cols, days }) => {
  const keys = Object.keys(days), min = keys[0], max = keys[keys.length - 1];
  const today = dayKey(new Date());
  const inRange = (k) => k >= min && k <= max;

  // Times next to prayer and mikveh hours. "fri" and "sat" are the coming Friday and Shabbat (the ones just past, when today is Shabbat).
  const dow = dowOf(today);
  const dayOf = { today, fri: shift(today, dow <= 5 ? 5 - dow : -1), sat: shift(today, 6 - dow) };
  const secOf = (spec) => {
    const [ref, off, day] = spec.split(':'), d = days[dayOf[day]];
    if (!d) return null;
    // Sunrise and sunset in whole minutes, rounded down as the daily box shows them, so every time on the page agrees.
    const base = ref === 'netz' ? Math.floor(d[2] / 60) * 60 : ref === 'shkia' ? Math.floor(d[3] / 60) * 60 : (() => { const [h, m] = d[4 + cols.indexOf('רבינו תם')].split(':'); return h * 3600 + m * 60; })();
    return base + off * 60;
  };
  let live = 0;
  document.querySelectorAll('.zl').forEach((b) => {
    const s = b.dataset.z ? secOf(b.dataset.z) : undefined, e = b.dataset.ze ? secOf(b.dataset.ze) : undefined;
    if (s === null || e === null) return;
    b.textContent = s === undefined ? `עד ${hm(e)}` : e === undefined ? hm(s) : `${hm(s)}–${hm(e)}`;
    live++;
  });
  document.querySelectorAll('.zlnote').forEach((n) => { n.hidden = !live; });

  // The strip of today's sunrise, sunset and evening zman (home page and Yavne'el page).
  const t = days[today];
  if (t) {
    const col = (name) => t[4 + cols.indexOf(name)];
    const third = dow === 5 ? ['הדלקת נרות', col('הדלקת נרות')] : dow === 6 ? ['צאת השבת', col('צאת השבת')] : ['צאת הכוכבים', col('צאת הכוכבים')];
    const vals = { netz: hm(Math.floor(t[2] / 60) * 60), shkia: hm(Math.floor(t[3] / 60) * 60), thirdname: third[0], third: third[1] };
    document.querySelectorAll('.zstrip').forEach((z) => {
      z.querySelectorAll('[data-zv]').forEach((e) => { e.textContent = vals[e.dataset.zv]; if (e.tagName === 'B') e.dir = 'ltr'; });
      z.querySelector('.zc').hidden = dow !== 5; z.querySelector('.zs').hidden = dow === 5;
      z.querySelector('.zdate').textContent = [new Date(`${today}T12:00:00Z`).toLocaleDateString('he-IL', { weekday: 'long', timeZone: 'UTC' }), t[0], t[1], 'לפי אופק יבנאל'].filter(Boolean).join(' · ');
      z.hidden = false;
    });
  }

  const box = document.getElementById('zmanim');
  if (!box) return;
  let key = today < min ? min : today > max ? max : today;
  const title = box.querySelector('.zday'), sub = box.querySelector('.zsub'), list = box.querySelector('.zlist');
  const prev = box.querySelector('.zprev'), next = box.querySelector('.znext'), now = box.querySelector('.ztoday'), pick = box.querySelector('.zpick');
  pick.min = min; pick.max = max;
  const draw = () => {
    const [heb, parasha, , , ...times] = days[key];
    title.textContent = heb;
    sub.textContent = [new Date(`${key}T12:00:00Z`).toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }), parasha].filter(Boolean).join(' · ');
    list.replaceChildren(...cols.flatMap((c, i) => {
      if (!times[i]) return [];
      const row = el('div', ['הנץ החמה', 'שקיעת החמה', 'הדלקת נרות', 'צאת השבת'].includes(c) ? 'key' : ''), t = el('bdi', '', times[i]);
      t.dir = 'ltr';
      row.append(el('dt', '', c), el('dd')); row.lastChild.append(t);
      return [row];
    }));
    prev.disabled = key <= min; next.disabled = key >= max; now.hidden = key === today || !inRange(today);
    pick.value = key;
  };
  prev.addEventListener('click', () => { key = shift(key, -1); draw(); });
  next.addEventListener('click', () => { key = shift(key, 1); draw(); });
  now.addEventListener('click', () => { key = today; draw(); });
  pick.addEventListener('change', () => { if (days[pick.value]) { key = pick.value; draw(); } });
  draw();
  box.hidden = false;
}).catch(() => {});
}
