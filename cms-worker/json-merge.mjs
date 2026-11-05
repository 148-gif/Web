// Three-way merge of JSON files: base (what the editor started from), live (what is published now), mine (the draft).
// A field only one side changed is taken from that side; a field both sides changed differently is a conflict and the whole
// merge fails (null), so a person must decide. Nothing here guesses: when in doubt it reports a conflict.
//
// Arrays of objects that all have a unique string `id` are merged by id (two people adding different items both keep them);
// every other array is taken whole from the one side that changed it.

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const CONFLICT = Symbol('conflict');
const MISSING = Symbol('missing');
const eq = (a, b) => (a === MISSING || b === MISSING ? a === b : same(a, b));

const byIdList = (arr) => Array.isArray(arr) && arr.every((x) => isObj(x) && typeof x.id === 'string')
  && new Set(arr.map((x) => x.id)).size === arr.length;

function mergeValue(base, live, mine) {
  if (eq(live, mine)) return live; // the same change on both sides, or none
  if (eq(base, live)) return mine; // only I changed it
  if (eq(base, mine)) return live; // only the live site changed it
  if (isObj(base) && isObj(live) && isObj(mine)) return mergeObject(base, live, mine);
  if (byIdList(base) && byIdList(live) && byIdList(mine)) return mergeById(base, live, mine);
  return CONFLICT; // both changed it differently, or one removed what the other changed
}

function mergeObject(base, live, mine) {
  const out = {};
  // Key order: the live file's order first, then keys only my draft has, so the file stays tidy.
  for (const k of new Set([...Object.keys(live), ...Object.keys(mine), ...Object.keys(base)])) {
    const r = mergeValue(k in base ? base[k] : MISSING, k in live ? live[k] : MISSING, k in mine ? mine[k] : MISSING);
    if (r === CONFLICT) return CONFLICT;
    if (r !== MISSING) out[k] = r;
  }
  return out;
}

function mergeById(base, live, mine) {
  const idx = (arr) => new Map(arr.map((x) => [x.id, x]));
  const B = idx(base), L = idx(live), M = idx(mine);
  const kept = new Map();
  for (const id of new Set([...B.keys(), ...L.keys(), ...M.keys()])) {
    const r = mergeValue(B.has(id) ? B.get(id) : MISSING, L.has(id) ? L.get(id) : MISSING, M.has(id) ? M.get(id) : MISSING);
    if (r === CONFLICT) return CONFLICT;
    if (r !== MISSING) kept.set(id, r);
  }
  // Order: if only one side reordered the items both still have, that order wins; if both did, differently, it is a conflict.
  const common = base.map((x) => x.id).filter((id) => kept.has(id) && L.has(id) && M.has(id));
  const rank = (arr) => arr.map((x) => x.id).filter((id) => common.includes(id)).join('\u0000');
  const rb = common.join('\u0000'), rl = rank(live), rm = rank(mine);
  if (rl !== rb && rm !== rb && rl !== rm) return CONFLICT;
  const lead = rm !== rb && rl === rb ? mine : live;
  const order = [];
  for (const arr of [lead, lead === live ? mine : live, base]) for (const x of arr) if (kept.has(x.id) && !order.includes(x.id)) order.push(x.id);
  return order.map((id) => kept.get(id));
}

// Returns the merged text, or null when the three versions cannot be merged without a decision from a person.
export function mergeJsonText(baseText, liveText, mineText) {
  let base, live, mine;
  try { base = JSON.parse(baseText); live = JSON.parse(liveText); mine = JSON.parse(mineText); } catch { return null; }
  if (!isObj(base) || !isObj(live) || !isObj(mine)) return null;
  const merged = mergeObject(base, live, mine);
  if (merged === CONFLICT) return null;
  const m = /^\n?( +)"/m.exec(liveText);
  return JSON.stringify(merged, null, m ? m[1].length : undefined) + '\n';
}
