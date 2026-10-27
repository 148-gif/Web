// Data for the editor's Q&A screen (/admin/): a light list to search in, and the full entries in chunks,
// so the editor never has to load the whole of shut.json. Built from the merged data, edits included.
import { write, all } from '../core.mjs';

const CHUNK = 100;
write('admin/shut/index.json', JSON.stringify(all.map((x, i) => [x.id, x.kind, x.title, x.date || '', Math.floor(i / CHUNK)])));
for (let i = 0; i * CHUNK < all.length; i++) write(`admin/shut/${i}.json`, JSON.stringify(all.slice(i * CHUNK, (i + 1) * CHUNK)));
