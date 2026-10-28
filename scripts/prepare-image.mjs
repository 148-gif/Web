// Prepares one photo for the site (a tool you run by hand; the build itself needs no image library):
//   node scripts/prepare-image.mjs <source file> <id> [--fx 50 --fy 40] [--crop left,top,width,height] [--force]
// Writes data/img/<id>/<width>.webp for each standard width up to the source's own, plus the face-centred 3:4 thumbnails
// t360.webp and t720.webp, and adds an unfinished entry (rights "pending") to data/images.json for you to complete.
// It refuses, unless --force: a photo that is too narrow, one that looks like a photo already on the site, and one with a bar
// or border along an edge (a screenshot's black strip, an app icon's corner). Rules: .claude/skills/images/SKILL.md.
import sharp from 'sharp';
import { mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { IMG_LIMITS } from '../site/admin/image-rules.mjs';

export const WIDTHS = [480, 800, 1200, 1600], THUMBS = [360, 720];
const args = process.argv.slice(2), flag = (n) => { const i = args.indexOf(`--${n}`); return i < 0 ? null : args.splice(i, 2)[1]; };
const force = args.includes('--force') && args.splice(args.indexOf('--force'), 1);
const fx = Number(flag('fx') ?? 50), fy = Number(flag('fy') ?? 40), crop = flag('crop');
const [src, id] = args;
if (!src || !/^[a-z0-9-]+$/.test(id || '')) { console.error('usage: node scripts/prepare-image.mjs <file> <id (a-z, 0-9, -)> [--fx 50 --fy 40] [--crop l,t,w,h]'); process.exit(1); }

let img = sharp(src).rotate(); // rotate() applies the camera's orientation; EXIF (including location) is dropped on output
if (crop) { const [left, top, width, height] = crop.split(',').map(Number); img = sharp(await img.toBuffer()).extract({ left, top, width, height }); }
const base = sharp(await img.resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).toBuffer());
const { width: W, height: H } = await base.metadata();
const refuse = (msg) => { if (!force) { console.error(`refused: ${msg} (use --force to add it anyway)`); process.exit(1); } console.warn(`warning: ${msg}`); };
if (W < IMG_LIMITS.minWidth) refuse(`the photo is ${W}px wide, under the ${IMG_LIMITS.minWidth}px minimum`);

// A 9x8 grayscale thumbnail, compared pixel to its right neighbour: 64 bits that stay almost the same when a photo is resized or recompressed.
const dhash = async (input) => {
  const px = await sharp(input).rotate().greyscale().resize(9, 8, { fit: 'fill' }).raw().toBuffer();
  let bits = '';
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += px[y * 9 + x] < px[y * 9 + x + 1] ? '1' : '0';
  return bits;
};
const dist = (a, b) => [...a].filter((c, i) => c !== b[i]).length;
const mine = await dhash(await base.clone().toBuffer());
for (const other of readdirSync('data/img').filter((d) => d !== id)) {
  const big = readdirSync(`data/img/${other}`).filter((f) => /^\d+\.webp$/.test(f)).sort((a, b) => parseInt(b) - parseInt(a))[0];
  if (big && dist(mine, await dhash(`data/img/${other}/${big}`)) <= 6) refuse(`looks like "${other}", already on the site (the same photo or the same moment)`);
}

// A bar along an edge (a screenshot's black strip, a border): from the edge inward, a band of lines that are each nearly one flat grey,
// at least 8px deep and not more than a quarter of the photo, ending where the picture starts (the next line is quite different).
// A white studio background is flat too, but it goes on for much more than a quarter, so it is not taken for a bar.
const grey = await base.clone().greyscale().raw().toBuffer();
const line = (side, k) => {
  const n = side === 'top' || side === 'bottom' ? W : H, v = new Array(n);
  for (let i = 0; i < n; i++) v[i] = grey[side === 'top' ? k * W + i : side === 'bottom' ? (H - 1 - k) * W + i : side === 'left' ? i * W + k : i * W + (W - 1 - k)];
  const mean = v.reduce((a, c) => a + c, 0) / n;
  return { mean, sd: Math.sqrt(v.reduce((a, c) => a + (c - mean) ** 2, 0) / n) };
};
for (const side of ['top', 'bottom', 'left', 'right']) {
  const depth = Math.floor((side === 'top' || side === 'bottom' ? H : W) / 4), first = line(side, 0);
  let k = 0;
  while (k < depth && line(side, k).sd < 8 && Math.abs(line(side, k).mean - first.mean) < 20) k++;
  if (k >= 8 && k < depth && Math.abs(line(side, k).mean - first.mean) > 25) refuse(`the ${side} edge has a flat bar ${k}px deep (a screenshot's strip or a border); crop it with --crop`);
}

const dir = `data/img/${id}`;
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
const widths = [...WIDTHS.filter((w) => w < W), W];
for (const w of widths) await base.clone().resize({ width: w }).webp({ quality: 80, effort: 6 }).toFile(`${dir}/${w}.webp`);
// Thumbnails are cut around the face (fx, fy in percent), so a wide photo is not cropped to its middle.
for (const tw of THUMBS.filter((t) => t <= W)) {
  const th = Math.round((tw * 4) / 3), scale = Math.max(tw / W, th / H), sw = Math.round(W * scale), sh = Math.round(H * scale);
  const left = Math.min(sw - tw, Math.max(0, Math.round((sw * fx) / 100 - tw / 2))), top = Math.min(sh - th, Math.max(0, Math.round((sh * fy) / 100 - th / 2)));
  await base.clone().resize(sw, sh).extract({ left, top, width: tw, height: th }).webp({ quality: 78, effort: 6 }).toFile(`${dir}/t${tw}.webp`);
}
// The entry is unfinished on purpose: the site refuses a photo shown with no description, credit or approval.
const reg = JSON.parse(readFileSync('data/images.json', 'utf8'));
const entry = { id, w: W, h: H, alt: '', caption: '', credit: '', year: '', fx, fy, rights: 'pending', others: '', consent: '', check: '', note: '', tags: [] };
const at = reg.findIndex((x) => x.id === id);
if (at < 0) reg.push(entry); else Object.assign(reg[at], { w: W, h: H, fx, fy });
writeFileSync('data/images.json', JSON.stringify(reg, null, 2) + '\n');
console.log(JSON.stringify({ id, w: W, h: H, fx, fy }));
console.log(at < 0 ? `added "${id}" to data/images.json: fill in alt, credit and others, then set rights to approved` : `updated the sizes of "${id}" in data/images.json`);
