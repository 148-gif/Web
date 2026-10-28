// Photos on pages: a figure with a responsive <img>, and a gallery that opens a lightbox (the script is in site/app.js).
// The photos come from data/images.json; their files are copied to dist/img/p/ only when a built page uses them (emitImages).
// Rules: .claude/skills/images/SKILL.md.
import { readFileSync, mkdirSync, cpSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { images, imgWidths, IMG_THUMBS, IMG_DIR, esc, escAttr } from './core.mjs';

const byId = new Map(images.map((im) => [im.id, im]));
const used = new Set();
const hashes = new Map();
// The content hash in ?v= lets the files be cached for a year (see _headers) and still reach everyone when a photo is replaced.
const src = (id, f) => {
  const k = `${id}/${f}`;
  if (!hashes.has(k)) hashes.set(k, createHash('sha256').update(readFileSync(new URL(k, IMG_DIR))).digest('hex').slice(0, 10));
  return `/img/p/${k}?v=${hashes.get(k)}`;
};
const get = (id) => { const im = byId.get(id); if (!im) throw new Error(`Images: unknown image "${id}"`); used.add(id); return im; };
const set = (id, ws, prefix = '') => ws.map((w) => `${src(id, `${prefix}${w}.webp`)} ${w}w`).join(', ');

// How wide the photo is shown decides the sizes the browser picks from: the width of the text column, or narrower. A tall photo is narrower still (fig-tall).
const SIZES = { side: '(min-width: 400px) 360px, 90vw', full: '(min-width: 800px) 720px, 100vw' };
const tall = (im) => im.h / im.w > 1.2;
const caption = (im) => (im.caption || im.credit || im.year ? `<figcaption>${im.caption ? esc(im.caption) : ''}${im.year ? ` <span class="fyear">${esc(im.year)}</span>` : ''}${im.credit ? `<span class="fcred">צילום: ${esc(im.credit)}</span>` : ''}</figcaption>` : '');

// lead: the photo at the top of a page is the one the visitor sees first, so it loads at once and with priority; every other photo waits until it is near.
const figure = (id, { size = 'full', lead = false } = {}) => {
  const im = get(id), ws = imgWidths(im);
  const w = ws.filter((x) => x <= 800).pop() || ws[0], h = Math.round((w * im.h) / im.w);
  return `<figure class="fig fig-${size}${tall(im) ? ' fig-tall' : ''}"><img src="${src(id, `${w}.webp`)}" srcset="${set(id, ws)}" sizes="${tall(im) ? SIZES.side : SIZES[size]}" width="${w}" height="${h}" alt="${escAttr(im.alt)}" ${lead ? 'fetchpriority="high"' : 'loading="lazy" decoding="async"'}>${caption(im)}</figure>`;
};

// Each thumbnail is a plain link to the big photo, so it still opens without the script; the script shows it in a dialog instead.
const gallery = (ids, label = 'גלריית תמונות') => `<ul class="gal" data-gallery aria-label="${escAttr(label)}">${ids.map((id) => {
  const im = get(id), ts = IMG_THUMBS.filter((t) => t <= im.w), ws = imgWidths(im), big = ws.filter((x) => x <= 1200).pop() || ws[0];
  const note = [im.caption, im.year, im.credit && `צילום: ${im.credit}`].filter(Boolean).join(' · ');
  return `<li><a href="${src(id, `${big}.webp`)}" data-w="${big}" data-h="${Math.round((big * im.h) / im.w)}"${note ? ` data-note="${escAttr(note)}"` : ''}><img src="${src(id, `t${ts[0]}.webp`)}" srcset="${set(id, ts, 't')}" sizes="(min-width: 800px) 200px, 45vw" width="${ts[0]}" height="${Math.round((ts[0] * 4) / 3)}" alt="${escAttr(im.alt)}" loading="lazy" decoding="async"></a></li>`;
}).join('')}</ul>`;

const emitImages = () => { for (const id of used) cpSync(new URL(`${id}/`, IMG_DIR), `dist/img/p/${id}`, { recursive: true }); if (!used.size) mkdirSync('dist/img/p', { recursive: true }); };
export { figure, gallery, emitImages };
