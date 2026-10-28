// Data for the editor (/admin/). Q&A: a light list to search in, and the full entries in chunks, so the editor never has to
// load the whole of shut.json (built from the merged data, edits included). Pages: a light list of every page.
import { write, all, cmsPages } from '../core.mjs';

const CHUNK = 100;
write('admin/shut/index.json', JSON.stringify(all.map((x, i) => [x.id, x.kind, x.title, x.date || '', Math.floor(i / CHUNK)])));
for (let i = 0; i * CHUNK < all.length; i++) write(`admin/shut/${i}.json`, JSON.stringify(all.slice(i * CHUNK, (i + 1) * CHUNK)));

// The pages made in the editor, as a light list [slug, topic, title, category], so the editor opens a topic with one request.
write('admin/pages/index.json', JSON.stringify(cmsPages.map((p) => [p.slug, p.topic, p.title, p.category || ''])));

// Which commit this build is: the editor polls it after a save, to tell when the change is really on the site.
write('admin/build.json', JSON.stringify({ sha: process.env.GITHUB_SHA || '' }));
