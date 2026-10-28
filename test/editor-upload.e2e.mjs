// Uploading a new photo in the editor, in a real browser against the real editor server code: the checks that refuse a bad photo, the files
// and entry a good one produces, who may approve it, and that what the editor made passes the build's own checks.
// node test/editor-upload.e2e.mjs   (after: node scripts/build.mjs; needs Playwright, and the repository's own dev dependency sharp)
import sharp from 'sharp';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorld, reporter } from './helpers/editor-world.mjs';
import { handle } from '../cms-worker/worker.mjs';
import { validateImages, images as registered } from '../scripts/lib/core.mjs';

const w = await startWorld(), t = reporter(), dir = mkdtempSync(join(tmpdir(), 'up-'));
// The largest file of a registered photo is the whole photo: its width is the width in the registry.
const master = (id) => new URL(`../data/img/${id}/${registered.find((x) => x.id === id).w}.webp`, import.meta.url).pathname;
// New JPEGs made from the repository's own photos: mirrored (a different picture to the eye), or damaged in the one way each test needs.
const make = async (name, id, f) => { const p = join(dir, name); await f(sharp(master(id))).jpeg({ quality: 90 }).toFile(p); return p; };
const files = {
  fresh: await make('fresh.jpg', 'candle-writing', (s) => s.flop()),
  dup: await make('dup.jpg', 'armchair', (s) => s.resize({ width: 1002 })),
  bar: await make('bar.jpg', 'candle-writing', (s) => s.flop().extend({ bottom: 160, background: '#000' })),
  narrow: await make('narrow.jpg', 'candle-writing', (s) => s.flop().resize({ width: 600 })),
  turned: await make('turned.jpg', 'black-hat', (s) => s.flop().withMetadata({ orientation: 6 })),
  people: await make('people.jpg', 'hand-on-forehead', (s) => s.flop()),
  loose: await make('loose.jpg', 'bookshelf', (s) => s.flop()),
};
const ownerTok = w.tokens.owner, call = async (method, path, body) => { const r = await handle(new Request(`https://x.test${path}`, { method, headers: { Authorization: `Bearer ${ownerTok}`, Origin: w.origin }, body: body && JSON.stringify(body) }), w.env); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const rows = (sql, ...a) => w.env.DB.prepare(sql).bind(...a).all().then((r) => r.results);

const ed = await w.open('editor');
await ed.go('#/file/images.json', 'details.item');
t.ok(await ed.page.getByRole('button', { name: 'העלאת תמונה חדשה' }).count() === 1, 'the library has an upload button');
await ed.page.locator('details.item').first().locator('summary').click();
t.ok(await ed.page.locator('details.item').first().getByLabel('אישור פרסום').isDisabled(), 'an editor cannot change a photo\'s approval');

const open = async (page) => { await page.getByRole('button', { name: 'העלאת תמונה חדשה' }).click(); await page.waitForSelector('dialog input[type=file]', { state: 'attached' }); };
const choose = async (page, file) => { await page.locator('dialog input[type=file]').setInputFiles(file); await page.waitForTimeout(1500); return page.locator('dialog .err').innerText(); };
await open(ed.page);
let msg = await choose(ed.page, files.dup); t.ok(/כבר בספרייה \(armchair\)/.test(msg), `a photo already there: refused (${msg})`);
msg = await choose(ed.page, files.bar); t.ok(/פס או מסגרת בקצה התמונה \(למטה\)/.test(msg), `a strip along the bottom: refused (${msg})`);
msg = await choose(ed.page, files.narrow); t.ok(/צרה מדי: 600/.test(msg), `too narrow: refused (${msg})`);
t.ok((await rows("SELECT id FROM media WHERE kind = 'photo'")).length === 0, 'nothing was sent for the refused photos');

// A good photo, with a rotation in its EXIF: the editor stores it the way it is shown.
msg = await choose(ed.page, files.turned);
t.ok(msg === 'חסר תיאור לקוראי מסך (alt). לתמונה שרק מקשטת סמנו decorative' || /alt|תיאור/.test(msg), `a good photo is accepted and asks for its details first (${msg})`);
const d = ed.page.locator('dialog');
t.ok(await d.locator('.focal img').count() === 1 && await d.locator('canvas, .phrow').count() > 0, 'the focal point and the small picture are shown');
await d.locator('.focal img').click({ position: { x: 60, y: 50 } });
await d.getByLabel(/תיאור לקוראי מסך/).fill('תמונה של הרב'); msg = await d.locator('.err').innerText(); t.ok(/לא מתחיל/.test(msg), `"a photo of": refused (${msg})`);
await d.getByLabel(/תיאור לקוראי מסך/).fill('הרב בכובע שחור, מדבר');
await d.getByLabel(/צלם או בעלים/).fill('לא ידוע');
msg = await d.locator('.err').innerText(); t.ok(/אנשים נוספים/.test(msg), `people in the photo must be stated (${msg})`);
await d.getByLabel('אנשים נוספים בתמונה').selectOption('none');
await d.getByLabel(/מזהה באנגלית/).fill('armchair'); msg = await d.locator('.err').innerText(); t.ok(/כבר יש תמונה עם המזהה/.test(msg), `an id already taken (${msg})`);
await d.getByLabel(/מזהה באנגלית/).fill('turned-hat');
t.ok(await d.getByRole('button', { name: 'העלאה' }).isEnabled(), 'the upload button opens when everything is in order');
await d.getByRole('button', { name: 'העלאה' }).click();
await ed.page.waitForSelector('dialog', { state: 'detached', timeout: 30000 });
await ed.page.waitForTimeout(500);
const staged = await rows("SELECT key, size, status FROM media WHERE kind = 'photo' ORDER BY key");
const list = staged.map((r) => r.key.replace('data/img/turned-hat/', ''));
t.ok(staged.length === 5 && staged.every((r) => r.status === 'staged'), `its five files wait to be published: 480, 800, 1200, t360, t720 (${list.join(', ')})`);
const draft = JSON.parse((await rows("SELECT content FROM drafts WHERE path = 'data/images.json'"))[0].content), entry = draft.find((x) => x.id === 'turned-hat');
t.ok(entry && entry.rights === 'pending' && entry.consent === '' && entry.w < entry.h && /^[0-9a-f]{16}$/.test(entry.dh), `the entry is saved as not yet approved, turned upright (${entry && entry.w}x${entry && entry.h})`);
t.ok(entry.fx !== 50 || entry.fy !== 40, `the focal point the editor clicked is kept (${entry.fx},${entry.fy})`);
t.ok(ed.problems.length === 0, `no script errors ${JSON.stringify(ed.problems)}`);

// The owner approves it; an editor could not.
const own = await w.open('owner');
await own.go('#/file/images.json', 'details.item');
const item = own.page.locator('details.item', { hasText: 'turned-hat' }).first();
t.ok(await own.page.locator('details.item', { hasText: 'ממתינה לאישור' }).count() >= 1, 'the library marks the photo as waiting for approval');
await item.locator('summary').click();
await item.getByLabel('אישור פרסום').selectOption('approved');
await own.page.locator('#savebtn').click(); await own.page.waitForTimeout(800);
const approved = JSON.parse((await rows("SELECT content FROM drafts WHERE path = 'data/images.json'"))[0].content).find((x) => x.id === 'turned-hat');
t.ok(approved.rights === 'approved', 'the owner approved it');

// Published together, and what the editor made passes the build\'s own file checks.
const early = await call('POST', '/publish', { paths: ['data/images.json'] });
t.ok(early.status === 400 && /עוד לא פורסם/.test(early.body.message), `the entry alone is refused (${early.body.message})`);
// From the editor's own screen: only the entry is chosen, and the files of the photo come along by themselves.
await own.go('#/changes', 'ul.chg');
t.ok(await own.page.locator('ul.chg .tag', { hasText: 'תמונה' }).count() === 5, 'the changes list shows the photo\'s five files as photo files');
await own.page.getByLabel('בחירת הכול').uncheck(); await own.page.getByLabel('תמונות', { exact: true }).check();
await own.page.locator('#dopub').click(); await own.page.waitForSelector('#confirmpub');
t.ok(await own.page.locator('dialog ul.chg li').count() === 6, 'publishing the entry takes its five files with it');
await own.page.locator('#confirmpub').click(); await own.page.waitForSelector('dialog', { state: 'detached', timeout: 20000 });
const pub = { status: w.github.readBytes('data/img/turned-hat/1200.webp') ? 200 : 500 };
t.ok(pub.status === 200, 'entry and files are published together, from the editor');
const out = join(dir, 'live'); mkdirSync(join(out, 'turned-hat'), { recursive: true });
for (const r of staged) writeFileSync(join(out, 'turned-hat', r.key.split('/').pop()), w.github.readBytes(r.key));
const live = JSON.parse(w.github.read('data/images.json'));
let verdict = 'ok'; try { validateImages(live.filter((x) => x.id === 'turned-hat'), new URL(`file://${out}/`)); } catch (e) { verdict = e.message; }
t.ok(verdict === 'ok', `the files the editor made pass the build's own checks (${verdict})`);
t.ok(live.length === registered.length + 1, 'the live registry has the new photo');

// The general media library does not take photos: a photo chosen there goes to the form that asks about it, and cannot be sent as a loose file.
const med = await w.open('editor');
await med.go('#/media', 'text=העלאת קבצים');
t.ok(!(await med.page.locator('#mfile').getAttribute('accept')).includes('.jpg'), 'the media library does not offer photos to choose');
t.ok(await med.page.getByRole('button', { name: /העלאת תמונה/ }).count() === 1, 'the media library has a button for photos');
await med.page.locator('#mfile').setInputFiles(files.loose); await med.page.waitForTimeout(2000);
t.ok(await med.page.locator('dialog').getByLabel(/תיאור לקוראי מסך/).count() === 1, 'a photo chosen in the media library opens the form with the questions');
t.ok((await rows("SELECT id FROM media WHERE kind = 'image'")).length === 0, 'and nothing was sent as a loose file');
const raw = await call('POST', '/media/init', { name: 'IMG-20261029-WA0008.jpg', size: 1000 });
t.ok(raw.status === 400 && /ספריית התמונות/.test(raw.body.message), `the server refuses a photo as a loose file (${raw.body.message})`);
await med.page.keyboard.press('Escape');

// Children or other people: the owner must write down who agreed.
const ed2 = await w.open('editor');
await ed2.go('#/file/images.json', 'details.item'); await open(ed2.page);
await choose(ed2.page, files.people);
const d2 = ed2.page.locator('dialog');
await d2.getByLabel(/תיאור לקוראי מסך/).fill('הרב בשטריימל, ידו על מצחו'); await d2.getByLabel(/צלם או בעלים/).fill('לא ידוע'); await d2.getByLabel('אנשים נוספים בתמונה').selectOption('children'); await d2.getByLabel(/מזהה באנגלית/).fill('with-children');
await d2.getByRole('button', { name: 'העלאה' }).click(); await ed2.page.waitForSelector('dialog', { state: 'detached', timeout: 30000 });
const kid = JSON.parse((await rows("SELECT content FROM drafts WHERE path = 'data/images.json'"))[0].content).find((x) => x.id === 'with-children');
t.ok(kid && kid.rights === 'pending' && kid.consent === '' && /בעל האתר/.test(kid.check), `a photo with children waits for the owner's written approval (${kid && kid.check})`);
const current = await call('GET', '/gh/contents/data/images.json'), asList = JSON.parse(Buffer.from(current.body.content, 'base64').toString());
const approve = (consent) => call('PUT', '/gh/contents/data/images.json', { message: 'x', sha: current.body.sha, content: Buffer.from(JSON.stringify(asList.map((x) => (x.id === 'with-children' ? { ...x, rights: 'approved', consent } : x)))).toString('base64') });
const no = await approve(''); t.ok(no.status === 400 && /מי אישר/.test(no.body.message), `approving a photo with children and no written approval is refused (${no.status} ${no.body.message})`);
t.ok((await approve('בעל האתר, אוקטובר 2026')).status === 200, 'with the owner\'s written approval it is accepted');

await w.close();
process.exit(t.done() ? 1 : 0);
