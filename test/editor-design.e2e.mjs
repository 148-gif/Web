// Keyboard access, legible editing states and narrow-screen layout, using only the isolated editor world.
// Run after the site build: node test/editor-design.e2e.mjs
import { startWorld, reporter } from './helpers/editor-world.mjs';

const w = await startWorld(), t = reporter();

function contrast(foreground, background) {
  const luminance = (color) => color.match(/[\d.]+/g).slice(0, 3).map(Number)
    .map((value) => value / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    .reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
  const a = luminance(foreground), b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

async function colors(locator) {
  return locator.evaluate((node) => {
    const css = getComputedStyle(node);
    return { text: css.color, background: css.backgroundColor };
  });
}

try {
  for (const dark of [false, true]) {
    const label = dark ? 'dark' : 'light';
    const { page, go, problems } = await w.open('owner', { width: 1280, height: 900, dark });
    await go('#/pages', '#main .btn.pri');
    const primary = page.locator('#main .btn.pri').first();
    const normal = await colors(primary);
    t.ok(contrast(normal.text, normal.background) >= 4.5, `${label}: primary action text contrast`);
    await primary.hover();
    const hover = await colors(primary);
    t.ok(contrast(hover.text, hover.background) >= 4.5, `${label}: primary action hover contrast`);
    await primary.evaluate((button) => { button.disabled = true; });
    t.ok((await colors(primary)).background === normal.background, `${label}: disabled primary action does not receive hover styling`);
    await primary.evaluate((button) => { button.disabled = false; });

    for (const kind of ['ok', 'bad']) {
      await page.locator('#msg').evaluate((node, state) => {
        node.className = `toast ${state}`;
        node.textContent = state === 'ok' ? 'הטיוטה נשמרה' : 'השמירה לא הצליחה';
        node.hidden = false;
      }, kind);
      const toast = await colors(page.locator('#msg'));
      t.ok(contrast(toast.text, toast.background) >= 4.5, `${label}: ${kind} message text contrast`);
    }
    await page.locator('#msg').evaluate((node) => { node.hidden = true; });

    await go('#/shut', '#main .findbar input');
    await page.locator('.findbar input').first().focus();
    const focus = await page.locator('.findbar').first().evaluate((node) => {
      const css = getComputedStyle(node);
      return { width: parseFloat(css.outlineWidth), style: css.outlineStyle, color: css.outlineColor, background: css.backgroundColor };
    });
    t.ok(focus.width >= 2 && focus.style !== 'none' && contrast(focus.color, focus.background) >= 3, `${label}: search field has a visible, contrasting focus ring`);

    await go('#/page/chy', '#main .bigtitle');
    await page.locator('.bigtitle').first().focus();
    const titleFocus = await page.locator('.bigtitle').first().evaluate((node) => {
      const css = getComputedStyle(node);
      return css.outlineStyle !== 'none' && parseFloat(css.outlineWidth) >= 2;
    });
    t.ok(titleFocus, `${label}: page title keeps a visible keyboard focus ring`);
    const placeholder = await page.locator('.prow textarea').first().evaluate((node) => ({
      text: getComputedStyle(node, '::placeholder').color,
      background: getComputedStyle(node).backgroundColor,
    }));
    t.ok(contrast(placeholder.text, placeholder.background) >= 4.5, `${label}: field placeholder text contrast`);

    const route = await page.evaluate(() => location.hash);
    await page.locator('#skip').focus();
    await page.keyboard.press('Enter');
    t.ok(await page.evaluate((hash) => location.hash === hash && document.activeElement.id === 'main', route), `${label}: skip link focuses content without changing the editor route`);

    await page.setViewportSize({ width: 320, height: 740 });
    await page.waitForTimeout(250);
    t.ok(await page.locator('#nav').evaluate((node) => getComputedStyle(node).visibility === 'hidden'), `${label}: closed phone navigation is hidden from keyboard focus`);
    await page.locator('#burger').click();
    await page.locator('#nav').waitFor({ state: 'visible' });
    t.ok(await page.locator('#burger').getAttribute('aria-expanded') === 'true' && await page.locator('#nav').isVisible(), `${label}: phone menu exposes its expanded state`);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    t.ok(await page.evaluate(() => document.querySelector('#burger').getAttribute('aria-expanded') === 'false' && document.activeElement.id === 'burger' && getComputedStyle(document.querySelector('#nav')).visibility === 'hidden'), `${label}: Escape closes the phone menu and restores focus`);
    t.ok(await page.locator('.prow textarea').first().evaluate((node) => node.getBoundingClientRect().width >= node.closest('.prow').getBoundingClientRect().width * 0.9), `${label}: paragraph editor keeps the available phone width`);
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/editor-design-${label}-page-phone.png` });

    for (const [hash, selector] of [['#/', '.tile'], ['#/page/chy', '.bigtitle'], ['#/shut', '.findbar'], ['#/media', '.mgrid'], ['#/editors', '.addrow']]) {
      await go(hash, `#main ${selector}`);
      t.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${label}: ${hash} fits a 320px screen`);
    }

    await go('#/', '#main .tile');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.locator('.tile').first().hover();
    t.ok(await page.locator('.tile').first().evaluate((node) => {
      const css = getComputedStyle(node);
      return css.transform === 'none' && css.transitionDuration.split(',').every((value) => parseFloat(value) === 0);
    }), `${label}: reduced motion disables hover movement`);
    t.ok(!problems.length, `${label}: no script errors or CSP failures${problems.length ? ` ${JSON.stringify(problems)}` : ''}`);
    if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/editor-design-${label}-phone.png` });
    await page.context().close();
  }
} finally {
  await w.close();
}

process.exit(t.done() ? 1 : 0);
