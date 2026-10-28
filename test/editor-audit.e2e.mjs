// Opens every screen of the editor as each kind of person, on a desktop, a phone and in dark mode, and reports script errors,
// blocked requests, a page that scrolls sideways, and screens that show nothing: node test/editor-audit.e2e.mjs   (after: node scripts/build.mjs)
import { startWorld, reporter } from './helpers/editor-world.mjs';

const w = await startWorld(), t = reporter();
const SCREENS = [['#/', 'home'], ['#/pages', 'pages'], ['#/topic/matkonym', 'topic'], ['#/page/chy', 'page'], ['#/shut', 'shut'], ['#/media', 'media'], ['#/changes', 'changes'], ['#/log', 'log'], ['#/links', 'links'], ['#/editors', 'editors'],
  ['#/file/images.json', 'photos'], ['#/file/moharash.json', 'moharash'], ['#/file/site.json', 'site'], ['#/file/yeshiva.json', 'yeshiva']];
const VIEWS = [['desktop', { width: 1280, height: 900 }], ['phone', { width: 390, height: 800 }], ['dark', { width: 1280, height: 900, dark: true }]];
const shots = process.env.SHOTS;
for (const who of ['owner', 'editor']) {
  for (const [view, size] of VIEWS) {
    if (who === 'editor' && view !== 'desktop') continue;
    const { page, problems, go } = await w.open(who, size);
    for (const [hash, name] of SCREENS) {
      if (who === 'editor' && ['#/log', '#/editors'].includes(hash)) continue; // not for them: the editor falls back to the home screen
      problems.length = 0;
      await go(hash, '#app:not([hidden]) main, #app:not([hidden]) #view, #app:not([hidden])');
      await page.waitForTimeout(500);
      const info = await page.evaluate(() => ({ side: document.documentElement.scrollWidth > innerWidth + 1, text: (document.querySelector('main') || document.body).innerText.trim().length, err: (document.querySelector('#msg:not([hidden])') || {}).innerText || '' }));
      t.ok(!problems.length && !info.side && info.text > 20 && !/שגיאה|לא הצלחנו/.test(info.err), `${who}/${view} ${name}${problems.length ? ' ' + JSON.stringify(problems) : ''}${info.side ? ' [scrolls sideways]' : ''}${info.text <= 20 ? ' [empty]' : ''}${info.err ? ' [' + info.err + ']' : ''}`);
      if (shots) await page.screenshot({ path: `${shots}/${who}-${view}-${name}.png` });
    }
    await page.context().close();
  }
}
await w.close();
process.exit(t.done() ? 1 : 0);
