// The search page's word index (an inverted index, as static-site search engines build it): for every word of the text,
// the entries it appears in and where, split into small files by the first letters of the word, so a search downloads
// only the files of the words typed (a few KB each) and never the whole text.
// A word is filed under each form it can be searched by: itself and itself without a Hebrew prefix ("ובבית" also under
// "בית"), so a term finds all its forms in the one file named by its own first letters. The page (site/search.js) decides
// which words of the file match a term, by HS.quality, exactly as before.
// A file that grows past `limit` bytes is split by the third letter; forms of two letters stay in the parent file.
const PRE = /^[והבכלמש]{1,3}$/;
export const forms = (w) => { const f = new Set([w]); for (let k = 1; k <= 3 && k < w.length - 1; k++) if (PRE.test(w.slice(0, k))) f.add(w.slice(k)); return f; };



// docs: one array of words per entry. Returns { shards: Map key -> { word: postings }, split: [keys split by a third letter] }.
// postings: the numbers [doc gap, count, first position, position gaps…] per entry the word is in (gaps keep the numbers
// small), written as a string of varints, as search engines store them: 5 bits a character, the upper half of the
// alphabet meaning "more follows". About half the size of the same numbers as JSON.
export const ALPHA = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_';
export const varints = (nums) => nums.map((n) => { let s = ALPHA[n & 31]; n >>>= 5; while (n) { s = ALPHA[32 + (n & 31)] + s; n >>>= 5; } return s; }).join('');
// A word's positions in one entry are kept up to `cap` (enough to rank by phrase and closeness; very common words like
// "את" or "כל" would otherwise fill most of the index).
export function wordIndex(docs, limit = 64000, cap = 8) {
  const post = new Map();
  docs.forEach((ws, d) => ws.forEach((w, p) => {
    let m = post.get(w); if (!m) post.set(w, (m = new Map()));
    let a = m.get(d); if (!a) m.set(d, (a = [])); if (a.length < cap) a.push(p);
  }));
  const enc = new Map();
  for (const [w, m] of post) {
    const out = []; let last = 0;
    for (const [d, ps] of m) { out.push(d - last, ps.length, ...ps.map((p, i) => (i ? p - ps[i - 1] : p))); last = d; }
    enc.set(w, varints(out));
  }
  const byKey = new Map(); // key -> Map word -> its forms filed there
  const add = (key, w) => { let s = byKey.get(key); if (!s) byKey.set(key, (s = new Set())); s.add(w); };
  // filed under a form without its prefix only when that form is a word of the text itself ("הוא" is not filed under "וא")
  const fs = new Map([...post.keys()].map((w) => [w, new Set([...forms(w)].filter((x) => x === w || post.has(x)))]));
  for (const [w, f] of fs) for (const x of f) add(x.slice(0, 2), w);
  const size = (ws) => ws.reduce((n, w) => n + w.length * 2 + 6 + enc.get(w).length + 2, 2);
  const shards = new Map(), split = [];
  for (const [key, ws] of byKey) {
    const list = [...ws];
    if (key.length < 2 || size(list) <= limit) { shards.set(key, list); continue; }
    split.push(key);
    const parent = [];
    for (const w of list) {
      const longer = [...fs.get(w)].filter((x) => x.slice(0, 2) === key && x.length > 2), two = fs.get(w).has(key);
      if (two) parent.push(w);
      for (const x of new Set(longer.map((x) => x.slice(0, 3)))) { if (!shards.has(x)) shards.set(x, []); shards.get(x).push(w); }
    }
    shards.set(key, parent);
  }
  const out = new Map();
  for (const [key, ws] of shards) out.set(key, Object.fromEntries(ws.map((w) => [w, enc.get(w)])));
  return { shards: out, split: split.sort() };
}
