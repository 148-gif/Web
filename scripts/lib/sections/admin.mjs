// Data for the editor (/admin/). Q&A: a light list to search in, and the full entries in chunks, so the editor never has to
// load the whole of shut.json (built from the merged data, edits included). Pages: a light list of every page.
import { copyFileSync, mkdirSync } from 'node:fs';
import { write, all, cmsPages, images, IMG_DIR } from '../core.mjs';

const CHUNK = 100;
write('admin/shut/index.json', JSON.stringify(all.map((x, i) => [x.id, x.kind, x.title, x.date || '', Math.floor(i / CHUNK)])));
for (let i = 0; i * CHUNK < all.length; i++) write(`admin/shut/${i}.json`, JSON.stringify(all.slice(i * CHUNK, (i + 1) * CHUNK)));

// The pages made in the editor, as a light list [slug, topic, title, category], so the editor opens a topic with one request.
write('admin/pages/index.json', JSON.stringify(cmsPages.map((p) => [p.slug, p.topic, p.title, p.category || ''])));

// Which commit this build is: the editor polls it after a save, to tell when the change is really on the site.
write('admin/build.json', JSON.stringify({ sha: process.env.GITHUB_SHA || '' }));

// The photo library for the editor's chooser: every photo in the registry, with a small picture for the approved ones (only those can be placed in a page).
mkdirSync('dist/admin/photos', { recursive: true });
write('admin/photos/index.json', JSON.stringify(images.map((x) => ({ id: x.id, alt: x.alt, caption: x.caption, rights: x.rights, thumb: x.rights === 'approved' }))));
for (const x of images.filter((i) => i.rights === 'approved')) copyFileSync(new URL(`${x.id}/t360.webp`, IMG_DIR), `dist/admin/photos/${x.id}.webp`);
