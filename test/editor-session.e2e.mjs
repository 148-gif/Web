// Session boundaries in a real browser, with all server/storage work confined to startWorld's in-memory fakes.
// CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium node test/editor-session.e2e.mjs (after building dist/)
import assert from 'node:assert/strict';
import { startWorld } from './helpers/editor-world.mjs';
import { handle } from '../cms-worker/worker.mjs';

const w = await startWorld();
const WORKER = 'https://cms-test.workers.dev';
const cors = { 'Access-Control-Allow-Origin': w.origin, 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE' };
const json = (route, body, status = 200) => route.fulfill({ status, headers: cors, json: body });
const navigate = async (page, hash, selector) => {
  await page.evaluate((h) => { location.hash = h; }, hash);
  await page.waitForSelector(selector, { state: 'attached' });
};
// The Google library and token exchange are local fixtures. No real account, key, or identity provider is contacted.
async function loginFixtures(page) {
  let who = 'editor';
  await page.route('https://accounts.google.com/gsi/client', (r) => r.fulfill({ contentType: 'text/javascript', body:
    'window.google={accounts:{oauth2:{initTokenClient:function(o){return {requestAccessToken:function(){o.callback({access_token:"local-fixture"});}};}}}};' }));
  await page.route(`${WORKER}/session`, (r) => r.request().method() === 'OPTIONS'
    ? r.fulfill({ status: 204, headers: cors })
    : json(r, { token: w.tokens[who], email: who === 'publisher' ? 'pub@gmail.com' : 'editor@gmail.com', owner: false }));
  await page.route(`${WORKER}/me`, (r) => r.request().method() === 'PUT'
    ? json(r, { message: 'session expired' }, 401) : r.fallback());
  return async (next = 'editor') => { who = next; await page.locator('#gsign').click(); await page.waitForSelector('#app:not([hidden])'); };
}
async function expire(page) {
  await page.locator('#rename').click();
  await page.locator('dialog input').fill('שם בדיקה');
  await page.locator('dialog button[type=submit]').click();
  await page.waitForSelector('#login:not([hidden])');
  await page.waitForSelector('#gsign:not([disabled])');
}

try {
  const ed = await w.open('editor'), page = ed.page;
  const relogin = await loginFixtures(page);
  // Freeze the browser clock before reloading so neither the 2-second recovery debounce nor 60-second poll can fire early.
  const now = new Date();
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now);
  await page.reload();
  await page.waitForSelector('#app:not([hidden])');
  await navigate(page, '#/file/uman.json', '#main input[type=text]');
  const title = page.getByLabel('כותרת', { exact: true }).first();
  const publishedTitle = await title.inputValue(), typed = 'שינוי פרטי שטרם נשמר';
  await title.fill(typed);
  assert.equal(await page.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith('cms-draft:'))), false);
  const calls = [];
  page.on('request', (r) => { if (r.url().startsWith(WORKER) && r.method() !== 'OPTIONS') calls.push(r.url()); });
  await expire(page);
  const state = await page.evaluate(() => ({
    main: document.querySelector('#main').textContent, nav: document.querySelector('#nav').textContent,
    who: document.querySelector('#who').textContent, dialogs: document.querySelectorAll('dialog').length,
    token: localStorage.getItem('cms-token') || sessionStorage.getItem('cms-token'),
    drafts: Object.entries(localStorage).filter(([k]) => k.startsWith('cms-draft:')).map(([k, v]) => [k, JSON.parse(v)]),
    focused: document.activeElement.id,
  }));
  assert.equal(state.main + state.nav + state.who, '');
  assert.equal(state.dialogs, 0);
  assert.equal(state.token, null);
  assert.equal(state.drafts.length, 1);
  assert.match(state.drafts[0][0], /editor%40gmail\.com/);
  assert.equal(state.drafts[0][1].data.title, typed);
  assert.ok(['gsign', 'lerr'].includes(state.focused));
  const stoppedAt = calls.length;
  await page.clock.runFor(120000);
  assert.equal(calls.length, stoppedAt, 'expired sessions must not continue polling, translating, or autosaving');
  assert.equal((await w.env.DB.prepare('SELECT path FROM drafts').all()).results.length, 0);
  console.log('PASS expiry clears private UI and credentials, preserves the last keystroke locally, and stops timers');

  let recoveryPrompt = '';
  page.once('dialog', async (d) => { recoveryPrompt = d.message(); await d.accept(); });
  await relogin();
  await page.waitForSelector('#main input[type=text]');
  assert.match(recoveryPrompt, /לשחזר/);
  assert.equal(await title.inputValue(), typed);
  await expire(page);
  let otherAccountPrompt = false;
  const rejectPrompt = async (d) => { otherAccountPrompt = true; await d.dismiss(); };
  page.on('dialog', rejectPrompt);
  await relogin('publisher');
  await page.waitForSelector('#main input[type=text]');
  assert.equal(otherAccountPrompt, false);
  assert.equal(await title.inputValue(), publishedTitle);
  assert.equal(await page.locator('#who').textContent(), 'מפרסם');
  page.off('dialog', rejectPrompt);
  await page.locator('#out').click();
  await page.waitForSelector('#login:not([hidden])');
  assert.equal(await page.locator('#main').textContent(), '');
  assert.equal(await page.locator('dialog').count(), 0);
  assert.deepEqual(ed.problems, []);
  console.log('PASS same-account recovery survives re-login; another account cannot see or restore that draft; explicit logout also clears UI');
  await page.context().close();

  const stale = await w.open('editor'), sp = stale.page;
  const loginAgain = await loginFixtures(sp);
  let release, arrived, first = true;
  const held = new Promise((r) => { release = r; }), received = new Promise((r) => { arrived = r; });
  let aborted = false;
  sp.on('requestfailed', (r) => { if (r.url().includes('/contents/data/uman.json')) aborted = true; });
  await sp.route(`${WORKER}/gh/contents/data/uman.json*`, async (r) => {
    if (!first) return r.fallback();
    first = false; arrived(); await held;
    await json(r, { sha: 'old-sha', content: Buffer.from(JSON.stringify({ title: 'STALE PRIVATE RESPONSE', lead: 'old account' })).toString('base64') }).catch(() => {});
  });
  await sp.evaluate(() => { location.hash = '#/file/uman.json'; });
  await received;
  await expire(sp);
  await loginAgain('publisher');
  await sp.waitForSelector('#main input[type=text]');
  release();
  await sp.waitForTimeout(150);
  assert.equal(aborted, true);
  assert.equal(await sp.getByLabel('כותרת', { exact: true }).first().inputValue(), publishedTitle);
  assert.equal(await sp.locator('#who').textContent(), 'מפרסם');
  assert.equal(await sp.locator('dialog').count(), 0);
  assert.deepEqual(stale.problems, []);
  console.log('PASS an in-flight response is aborted and cannot repopulate the next account’s editor');
  await sp.context().close();

  const up = await w.open('editor'), upage = up.page;
  await loginFixtures(upage);
  await navigate(upage, '#/media', '#mfile');
  let initCalls = 0, uploadStarted, releaseUpload, abortedUpload = false;
  const started = new Promise((r) => { uploadStarted = r; }), waitUpload = new Promise((r) => { releaseUpload = r; });
  await upage.route(`${WORKER}/media/init`, (r) => { initCalls++; return json(r, { id: 'local-upload', store: 'r2' }); });
  await upage.route(`${WORKER}/media/r2?*`, async (r) => { uploadStarted(); await waitUpload; await json(r, { item: {} }).catch(() => {}); });
  upage.on('requestfailed', (r) => { if (r.url().includes('/media/r2?')) abortedUpload = true; });
  await upage.locator('#mfile').setInputFiles([
    { name: 'first.mp4', mimeType: 'video/mp4', buffer: Buffer.from('local fake video one') },
    { name: 'second.mp4', mimeType: 'video/mp4', buffer: Buffer.from('local fake video two') },
  ]);
  await started;
  await expire(upage);
  releaseUpload();
  await upage.waitForTimeout(150);
  assert.equal(abortedUpload, true);
  assert.equal(initCalls, 1, 'the next queued file must not begin after expiry');
  assert.equal(await upage.locator('#main').textContent(), '');
  assert.deepEqual(up.problems, []);
  console.log('PASS expiry aborts the active R2 upload and stops the rest of the queued files');
  await upage.context().close();

  const question = await w.open('editor'), qp = question.page;
  const questionLogin = await loginFixtures(qp);
  const qnow = new Date();
  await qp.clock.install({ time: qnow }); await qp.clock.pauseAt(qnow);
  await qp.reload(); await qp.waitForSelector('#app:not([hidden])');
  await navigate(qp, '#/shut/new', '#main .bigtitle');
  await qp.locator('#main .bigtitle').fill('הגרסה הראשונה של השאלה');
  await qp.locator('#main .col textarea').nth(1).fill('תשובה ראשונה לבדיקה');
  let savedOnServer, releaseSave, savePath;
  const saved = new Promise((r) => { savedOnServer = r; }), saveWait = new Promise((r) => { releaseSave = r; });
  await qp.route(`${WORKER}/gh/contents/data/shut-edits/*`, async (r) => {
    const req = r.request();
    if (req.method() !== 'PUT' || !req.postDataJSON().auto) return r.fallback();
    savePath = new URL(req.url()).pathname.replace('/gh/contents/', '');
    const result = await handle(new Request(req.url(), { method: req.method(), headers: { ...req.headers(), origin: w.origin }, body: req.postData() }), w.env);
    const body = await result.text(); savedOnServer(); await saveWait;
    await r.fulfill({ status: result.status, headers: { ...Object.fromEntries(result.headers), ...cors }, body });
  });
  await qp.clock.runFor(30001); await saved;
  const latestQuestion = 'טקסט חדש שנכתב בזמן השמירה';
  await qp.locator('#main .bigtitle').fill(latestQuestion);
  await qp.clock.runFor(2001); // newer local copy exists while the original save is still in flight
  releaseSave();
  await qp.waitForFunction(() => /^#\/shut\/\d+$/.test(location.hash));
  const numericHash = new URL(qp.url()).hash;
  let questionCopies = await qp.evaluate(() => Object.entries(localStorage).filter(([k]) => k.startsWith('cms-draft:')).map(([k, v]) => [k, JSON.parse(v)]));
  assert.equal(questionCopies.length, 1);
  assert.ok(questionCopies[0][0].endsWith(savePath));
  assert.equal(questionCopies[0][1].data.title, latestQuestion);
  assert.equal(await qp.locator('#savestate').textContent(), 'יש שינויים שלא נשמרו');
  await expire(qp);
  qp.once('dialog', (d) => d.accept());
  await questionLogin(); await qp.waitForSelector('#main .bigtitle');
  assert.equal(new URL(qp.url()).hash, numericHash);
  assert.equal(await qp.locator('#main .bigtitle').inputValue(), latestQuestion);
  await qp.locator('#savebtn').click();
  await qp.waitForFunction(() => document.querySelector('#savestate')?.textContent === 'נשמר כטיוטה, עוד לא פורסם');
  const questionRows = (await w.env.DB.prepare("SELECT path, content FROM drafts WHERE path LIKE 'data/shut-edits/%'").all()).results;
  assert.equal(questionRows.length, 1, 'recovery must update the autosaved question, not allocate a second question');
  assert.equal(questionRows[0].path, savePath);
  assert.equal(JSON.parse(questionRows[0].content).title, latestQuestion);
  assert.deepEqual(question.problems, []);
  console.log('PASS new-question autosave preserves newer typing and recovery updates the same numeric question without duplication');
  await qp.locator('#main .bigtitle').fill('טיוטה מקומית לפני הסתרת השאלה');
  await qp.clock.runFor(2001);
  qp.once('dialog', (d) => d.accept());
  await qp.getByRole('button', { name: 'הסתרה מהאתר', exact: true }).click();
  await qp.waitForFunction(() => location.hash === '#/shut');
  assert.equal(await qp.evaluate((suffix) => Object.keys(localStorage).some((k) => k.startsWith('cms-draft:') && k.endsWith(suffix)), savePath), false);
  await qp.clock.runFor(60001);
  assert.equal(JSON.parse((await w.env.DB.prepare('SELECT content FROM drafts WHERE path = ?').bind(savePath).first()).content).deleted, true);
  let hiddenRecovery = false;
  qp.on('dialog', async (d) => { hiddenRecovery = true; await d.dismiss(); });
  await navigate(qp, numericHash, '#main section.card');
  assert.equal(await qp.getByRole('heading', { name: 'השאלה הזאת מוסתרת מהאתר' }).count(), 1);
  assert.equal(hiddenRecovery, false);
  assert.deepEqual(question.problems, []);
  console.log('PASS hiding a question clears its old local recovery and debounce so it cannot be resurrected');
  await qp.context().close();

  for (const [label, hash, selector, path] of [
    ['content file', '#/file/uman.json', '#main input[type=text]', 'data/uman.json'],
    ['page', '#/page/chy', '#main .bigtitle', 'data/pages/chy.json'],
  ]) {
    const manual = await w.open('editor'), p = manual.page, tick = new Date();
    await p.clock.install({ time: tick }); await p.clock.pauseAt(tick);
    await p.reload(); await p.waitForSelector('#app:not([hidden])');
    await navigate(p, hash, selector);
    const input = label === 'page' ? p.locator('#main .bigtitle') : p.getByLabel('כותרת', { exact: true }).first();
    let submitted, releaseManual, once = true;
    const sent = new Promise((r) => { submitted = r; }), manualWait = new Promise((r) => { releaseManual = r; });
    await p.route(`${WORKER}/gh/contents/${path}`, async (r) => {
      const req = r.request();
      if (req.method() !== 'PUT' || !once) return r.fallback();
      once = false;
      const result = await handle(new Request(req.url(), { method: 'PUT', headers: { ...req.headers(), origin: w.origin }, body: req.postData() }), w.env);
      const body = await result.text(); submitted(); await manualWait;
      await r.fulfill({ status: result.status, headers: { ...Object.fromEntries(result.headers), ...cors }, body });
    });
    const sentTitle = 'הטקסט שנשלח לשמירה', newerTitle = 'הטקסט החדש שנכתב בזמן ההמתנה';
    await input.fill(sentTitle); await p.locator('#savebtn').click(); await sent;
    await input.fill(newerTitle); await p.clock.runFor(2001);
    releaseManual();
    await p.waitForFunction(() => !document.querySelector('#savebtn').disabled && document.querySelector('#savestate').textContent === 'יש שינויים שלא נשמרו');
    assert.equal(await input.inputValue(), newerTitle);
    const dbTitle = async () => JSON.parse((await w.env.DB.prepare('SELECT content FROM drafts WHERE path = ?').bind(path).first()).content).title;
    assert.equal(await dbTitle(), sentTitle);
    const retained = await p.evaluate((suffix) => Object.entries(localStorage).filter(([k]) => k.startsWith('cms-draft:') && k.endsWith(suffix)).map(([, v]) => JSON.parse(v)), path);
    assert.equal(retained.length, 1); assert.equal(retained[0].data.title, newerTitle);
    await p.clock.runFor(30001);
    await p.waitForFunction(() => document.querySelector('#savestate').textContent === 'נשמר כטיוטה, עוד לא פורסם');
    assert.equal(await dbTitle(), newerTitle, 'newer typing must still be eligible for the next automatic save');
    assert.deepEqual(manual.problems, []);
    console.log(`PASS ${label} manual save retains in-flight edits as dirty recovery data and the next autosave saves them`);
    await p.context().close();
  }

  const media = await w.open('editor'), mp = media.page;
  await loginFixtures(mp);
  await mp.route(`${WORKER}/media`, (r) => json(r, { quota: null, items: [{ id: 'fixture', name: 'PRIVATE FILE', url: '/media/private.txt', store: 'github', kind: 'doc', size: 8, status: 'staged', by: 'עורך' }] }));
  await navigate(mp, '#/media', '.mcard');
  await mp.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => new Promise((resolve, reject) => { window.rejectClipboard = reject; }) } }); });
  await mp.getByRole('button', { name: 'העתקת קישור', exact: true }).click();
  let lookupStarted, releaseLookup, deletes = 0;
  const looking = new Promise((r) => { lookupStarted = r; }), lookupWait = new Promise((r) => { releaseLookup = r; });
  await mp.route(`${WORKER}/gh/contents/data/pages*`, async (r) => { lookupStarted(); await lookupWait; await json(r, []).catch(() => {}); });
  mp.on('request', (r) => { if (r.method() === 'DELETE') deletes++; });
  const latePrompts = [];
  mp.on('dialog', async (d) => { latePrompts.push(d.message()); await d.dismiss(); });
  await mp.getByRole('button', { name: 'מחיקה', exact: true }).click(); await looking;
  await expire(mp);
  releaseLookup(); await mp.evaluate(() => window.rejectClipboard(new Error('fixture clipboard denial')));
  await mp.waitForTimeout(150);
  assert.deepEqual(latePrompts, [], 'a canceled lookup or clipboard failure must not expose private text in a later native dialog');
  assert.equal(deletes, 0);
  assert.deepEqual(media.problems, []);
  console.log('PASS canceled media lookup and delayed clipboard denial cannot reopen private prompts or delete files');
  await mp.context().close();
} finally { await w.close(); }
