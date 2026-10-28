// Prepares one photo for the site (a tool you run by hand; the build itself needs no image library):
//   node scripts/prepare-image.mjs <source file> <id> [--fx 50 --fy 40] [--crop left,top,width,height]
// Writes data/img/<id>/<width>.webp for each standard width up to the source's own, plus the face-centred 3:4 thumbnails
// t360.webp and t720.webp, and prints the numbers for data/images.json. Rules: .claude/skills/images/SKILL.md.
import sharp from 'sharp';
import { mkdirSync, rmSync } from 'node:fs';

export const WIDTHS = [480, 800, 1200, 1600], THUMBS = [360, 720];
const args = process.argv.slice(2), flag = (n) => { const i = args.indexOf(`--${n}`); return i < 0 ? null : args.splice(i, 2)[1]; };
const fx = Number(flag('fx') ?? 50), fy = Number(flag('fy') ?? 40), crop = flag('crop');
const [src, id] = args;
if (!src || !/^[a-z0-9-]+$/.test(id || '')) { console.error('usage: node scripts/prepare-image.mjs <file> <id (a-z, 0-9, -)> [--fx 50 --fy 40] [--crop l,t,w,h]'); process.exit(1); }

let img = sharp(src).rotate(); // rotate() applies the camera's orientation; EXIF (including location) is dropped on output
if (crop) { const [left, top, width, height] = crop.split(',').map(Number); img = sharp(await img.toBuffer()).extract({ left, top, width, height }); }
const base = sharp(await img.resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).toBuffer());
const { width: W, height: H } = await base.metadata();
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
console.log(JSON.stringify({ id, w: W, h: H, fx, fy }));
