// "Related questions": for each item, the few others closest to it in wording (TF-IDF cosine over title, question and answer).
// Pure and deterministic (ties break by position), so the same data always gives the same links.

const NIQQUD = /[֑-ׇ]/g;
const PREFIX = /^[והבכלמש]/;

// Words of a text, without vowel marks and quotes, with a one-letter prefix (ה, ו, ב, כ, ל, מ, ש) cut off long words.
export function tokens(text) {
  return String(text).replace(NIQQUD, '').replace(/["'׳״]/g, '').toLowerCase().split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 2).map((w) => (w.length >= 5 && PREFIX.test(w) ? w.slice(1) : w)).filter((w) => w.length >= 3);
}

// items: [{ id, title, q: [text], a: [text] }]. Returns Map(id -> [id, ...]) with at most `count` neighbours, each scoring at least `min`.
export function relatedMap(items, { count = 4, min = 0.12, maxDf = 0.03, terms = 20 } = {}) {
  const n = items.length;
  const docs = items.map((x) => {
    const tf = new Map();
    const add = (text, w) => { for (const t of tokens(text)) tf.set(t, (tf.get(t) || 0) + w); };
    add(x.title, 3); add((x.q || []).join(' '), 2); add((x.a || []).join(' '), 1);
    return tf;
  });
  const df = new Map();
  for (const tf of docs) for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
  const keep = (t) => df.get(t) >= 2 && df.get(t) <= maxDf * n;
  const vecs = docs.map((tf) => {
    const v = [...tf].filter(([t]) => keep(t)).map(([t, f]) => [t, (1 + Math.log(f)) * Math.log(n / df.get(t))])
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, terms);
    const norm = Math.sqrt(v.reduce((s, [, w]) => s + w * w, 0)) || 1;
    return new Map(v.map(([t, w]) => [t, w / norm]));
  });
  const post = new Map();
  vecs.forEach((v, i) => { for (const [t, w] of v) { if (!post.has(t)) post.set(t, []); post.get(t).push([i, w]); } });
  const out = new Map();
  vecs.forEach((v, i) => {
    const score = new Map();
    for (const [t, w] of v) for (const [j, wj] of post.get(t)) if (j !== i) score.set(j, (score.get(j) || 0) + w * wj);
    const best = [...score].filter(([, s]) => s >= min).sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, count);
    out.set(items[i].id, best.map(([j]) => items[j].id));
  });
  return out;
}
