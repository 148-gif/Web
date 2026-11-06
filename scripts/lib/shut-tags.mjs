// Q&A tagged by hand with a holiday (data/shut-tags.json): the holiday's name is not in the question's title, but it is in the question
// and it is what the question is about. They join the holiday's pool in the seasonal band (seasonal.mjs) and its hub page (moadim.mjs),
// and get the holiday's label on their page and in the search. Keys are occasion ids of library.json.
import { read, shut, lib } from './core.mjs';

const validateShutTags = (t, ids, occasions) => {
  const bad = (m) => { throw new Error(`shut-tags.json: ${m}`); };
  if (!t || typeof t.tags !== 'object' || Array.isArray(t.tags)) bad('needs a "tags" object');
  for (const [o, list] of Object.entries(t.tags)) {
    if (!occasions.has(o)) bad(`"${o}" is not an occasion id of library.json`);
    if (!Array.isArray(list) || !list.every((x) => typeof x === 'string')) bad(`${o}: a list of question numbers (as text)`);
    if (new Set(list).size !== list.length) bad(`${o}: a question is listed twice`);
    for (const x of list) if (!ids.has(x)) bad(`${o}: question ${x} does not exist (or is hidden)`);
  }
};
const shutTags = read('shut-tags.json');
validateShutTags(shutTags, new Set(shut.map((x) => String(x.id))), new Set((lib.occasions || []).map((o) => o.id)));
const taggedFor = (occasion) => shutTags.tags[occasion] || [];
// the questions tagged for the occasions that send their hub to `hub` (data/moadim.json)
const taggedForHub = (hub) => new Set((lib.occasions || []).filter((o) => o.hub === hub).flatMap((o) => taggedFor(o.id)));

export { validateShutTags, shutTags, taggedFor, taggedForHub };
