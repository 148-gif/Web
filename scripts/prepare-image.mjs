// Prepares one photo for the site (a tool you run by hand; the build itself needs no image library):
//   node scripts/prepare-image.mjs <source file> <id> [--fx 50 --fy 40] [--crop left,top,width,height] [--force]
// Writes data/img/<id>/<width>.webp for each standard width up to the source's own, plus the face-centred 3:4 thumbnails
// t360.webp and t720.webp, and adds an unfinished entry (rights "pending") to data/images.json for you to complete.
// It refuses, unless --force: a photo that is too narrow, one that looks like a photo already on the site, and one with a bar
// or border along an edge (a screenshot's black strip, an app icon's corner). The checks are the editor's too (site/admin/image-rules.mjs).
// With --sign-only it only writes the visual signature (dh) of photos that have none yet. Rules: .claude/skills/images/SKILL.md.
import sharp from 'sharp';
import { mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { IMG_LIMITS, IMG_THUMBS, imgWidths, dhash, lookalike, flatBar } from '../site/admin/image-rules.mjs';

const args = process.argv.slice(2), flag = (n) => { const i = args.indexOf(`--${n}`); return i < 0 ? null : args.splice(i, 2)[1]; };
const take = (n) => { const i = args.indexOf(`--${n}`); if (i < 0) return false; args.splice(i, 1); return true; };
const force = take('force'), signOnly = take('sign-only');
const reg = JSON.parse(readFileSync('data/images.json', 'utf8'));
const save = () => writeFileSync('data/images.json', JSON.stringify(reg, null, 2) + '\n');

// The same picture the editor looks at: at most 512px on a side, one grey byte per pixel.
const signature = async (input) => {
  const { data, info } = await sharp(input).rotate().resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true }).greyscale().raw().toBuffer({ resolveWithObject: true });
  return { dh: dhash(data, info.width, info.height), grey: data, w: info.width, h: info.height };
};
const biggest = (id) => `data/img/${id}/${readdirSync(`data/img/${id}`).filter((f) => /^\d+\.webp$/.test(f)).sort((a, b) => parseInt(b) - parseInt(a))[0]}`;

if (signOnly) {
  for (const im of reg) if (!im.dh) { im.dh = (await signature(biggest(im.id))).dh; console.log(`${im.id}: ${im.dh}`); }
  save(); process.exit(0);
}

const fx = Number(flag('fx') ?? 50), fy = Number(flag('fy') ?? 40), crop = flag('crop');
const [src, id] = args;
if (!src || !/^[a-z0-9-]+$/.test(id || '')) { console.error('usage: node scripts/prepare-image.mjs <file> <id (a-z, 0-9, -)> [--fx 50 --fy 40] [--crop l,t,w,h] [--force]'); process.exit(1); }

let img = sharp(src).rotate(); // rotate() applies the camera's orientation; EXIF (including location) is dropped on output
if (crop) { const [left, top, width, height] = crop.split(',').map(Number); img = sharp(await img.toBuffer()).extract({ left, top, width, height }); }
const base = sharp(await img.resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).toBuffer());
const { width: W, height: H } = await base.metadata();
const refuse = (msg) => { if (!force) { console.error(`refused: ${msg} (use --force to add it anyway)`); process.exit(1); } console.warn(`warning: ${msg}`); };
if (W < IMG_LIMITS.minWidth) refuse(`the photo is ${W}px wide, under the ${IMG_LIMITS.minWidth}px minimum`);

const mine = await signature(await base.clone().toBuffer());
const twin = lookalike(mine.dh, reg, id);
if (twin) refuse(`looks like "${twin.id}", already on the site (the same photo or the same moment)`);
const bar = flatBar(mine.grey, mine.w, mine.h);
if (bar) refuse(`the ${bar.side} edge has a flat bar (a screenshot's strip or a border); crop it with --crop`);

const dir = `data/img/${id}`;
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
for (const w of imgWidths({ w: W })) await base.clone().resize({ width: w }).webp({ quality: 80, effort: 6 }).toFile(`${dir}/${w}.webp`);
// Thumbnails are cut around the face (fx, fy in percent), so a wide photo is not cropped to its middle.
for (const tw of IMG_THUMBS.filter((t) => t <= W)) {
  const th = Math.round((tw * 4) / 3), scale = Math.max(tw / W, th / H), sw = Math.round(W * scale), sh = Math.round(H * scale);
  const left = Math.min(sw - tw, Math.max(0, Math.round((sw * fx) / 100 - tw / 2))), top = Math.min(sh - th, Math.max(0, Math.round((sh * fy) / 100 - th / 2)));
  await base.clone().resize(sw, sh).extract({ left, top, width: tw, height: th }).webp({ quality: 78, effort: 6 }).toFile(`${dir}/t${tw}.webp`);
}
// The entry is unfinished on purpose: the site refuses a photo shown with no description, credit or approval.
const entry = { id, w: W, h: H, alt: '', caption: '', credit: '', year: '', fx, fy, dh: mine.dh, rights: 'pending', others: '', consent: '', check: '', note: '', tags: [] };
const at = reg.findIndex((x) => x.id === id);
if (at < 0) reg.push(entry); else Object.assign(reg[at], { w: W, h: H, fx, fy, dh: mine.dh });
save();
console.log(JSON.stringify({ id, w: W, h: H, fx, fy, dh: mine.dh }));
console.log(at < 0 ? `added "${id}" to data/images.json: fill in alt, credit and others, then the owner sets rights to approved` : `updated the sizes of "${id}" in data/images.json`);
