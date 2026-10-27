// Daily zmanim of Yavne'el: shows today's times (Israel time) and lets you move between days.
// The times come from zmanim.json, made by scripts/gen-zmanim.mjs.
{
const me = new URL(document.currentScript.src);
const box = document.getElementById('zmanim');
const dayKey = (d) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
const shift = (key, n) => { const [y, m, d] = key.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n, 12)).toISOString().slice(0, 10); };
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

fetch(new URL(`zmanim.json${me.search}`, me)).then((r) => r.json()).then(({ cols, days }) => {
  const keys = Object.keys(days), min = keys[0], max = keys[keys.length - 1];
  const today = dayKey(new Date());
  let key = today < min ? min : today > max ? max : today;
  const title = box.querySelector('.zday'), sub = box.querySelector('.zsub'), list = box.querySelector('.zlist');
  const prev = box.querySelector('.zprev'), next = box.querySelector('.znext'), now = box.querySelector('.ztoday'), pick = box.querySelector('.zpick');
  pick.min = min; pick.max = max;
  const draw = () => {
    const [heb, parasha, ...times] = days[key];
    title.textContent = heb;
    sub.textContent = [new Date(`${key}T12:00:00Z`).toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }), parasha].filter(Boolean).join(' · ');
    list.replaceChildren(...cols.flatMap((c, i) => {
      if (!times[i]) return [];
      const row = el('div'), t = el('bdi', '', times[i]);
      t.dir = 'ltr';
      row.append(el('dt', '', c), el('dd')); row.lastChild.append(t);
      return [row];
    }));
    prev.disabled = key <= min; next.disabled = key >= max; now.hidden = key === today || today < min || today > max;
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
