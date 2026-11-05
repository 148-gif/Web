// Data for the editor (/admin/). Q&A: a light list to search in, and the full entries in chunks, so the editor never has to
// load the whole of shut.json (built from the merged data, edits included). Pages: a light list of every page.
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
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

// Admin-only fingerprints do not invalidate thousands of unchanged public reading pages.
const adminSource = new URL('../../../site/admin/', import.meta.url);
const adminNames = ['admin.js', 'admin.css', 'seo-ui.mjs', 'seo-model.mjs'];
const adminVersion = createHash('sha256').update(adminNames.map((name) => readFileSync(new URL(name, adminSource), 'utf8')).join('\n')).digest('hex').slice(0, 16);
write('admin/index.html', readFileSync(new URL('index.html', adminSource), 'utf8').replace('href="admin.css"', 'href="admin.css?v=' + adminVersion + '"').replace('src="admin.js"', 'src="admin.js?v=' + adminVersion + '"'));
write('admin/admin.js', readFileSync(new URL('admin.js', adminSource), 'utf8').replace('seo-ui.mjs?v=20261105-1', 'seo-ui.mjs?v=' + adminVersion));
write('admin/seo-ui.mjs', readFileSync(new URL('seo-ui.mjs', adminSource), 'utf8').replace("'./seo-model.mjs'", "'./seo-model.mjs?v=" + adminVersion + "'"));
