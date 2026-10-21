// Ordinary production language interaction check. Run against a served build; never inject a review API.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';

const { values } = parseArgs({ options: { url: { type: 'string' }, out: { type: 'string' } } });
if (!values.url || !values.out) throw new Error('Usage: node tools/verify/verify-language.mjs --url URL --out NEW_DIRECTORY');
const url = new URL(values.url);
if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
  || !['localhost', '127.0.0.1', 'mattitynka.github.io'].includes(url.hostname)
  || (url.hostname === 'mattitynka.github.io' && (url.protocol !== 'https:' || url.pathname !== '/Helsinki-rides/'))) {
  throw new Error('Only loopback builds or the official HTTPS game are supported');
}
if (existsSync(values.out)) throw new Error('Evidence directories are never overwritten');
mkdirSync(values.out, { recursive: true });
const checks = [], errors = [], captures = [];
const check = (id, pass, detail) => {
  checks.push({ id, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id}: ${detail}`);
  assert.ok(pass, id);
};
const browser = await chromium.launch({ channel: 'chromium', headless: true,
  args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--enable-unsafe-swiftshader'] });
let fatal = null;
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(url.href, { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelector('[data-language="en"]')?.getAttribute('aria-pressed') === 'true');
  check('english-default', await page.locator('html').getAttribute('lang') === 'en', 'fresh visit stays English');
  await page.waitForFunction(() => !document.getElementById('play-button')?.disabled || !!window.__HELSINKI_ERROR__, null, { timeout: 300000 });
  check('startup', !await page.evaluate(() => window.__HELSINKI_ERROR__), 'production world loads');
  const credits = await page.locator('#loading-credits a').evaluateAll(links => links.map(link => ({ href: link.href, target: link.target, rel: link.rel })));
  const destinationValues = await page.locator('#dropin option').evaluateAll(options => options.map(option => option.value));
  await page.screenshot({ path: path.join(values.out, 'english-start.png') }); captures.push('english-start.png');

  // Native keyboard operation: Tab moves focus and Space selects Finnish without dismissing startup.
  await page.locator('[data-language="en"]').focus();
  await page.keyboard.press('Shift+Tab');
  check('keyboard-focus', await page.locator('[data-language="fi"]').evaluate(node => document.activeElement === node), 'Tab reaches the Finnish flag button');
  await page.keyboard.press('Space');
  check('finnish-keyboard-toggle', await page.locator('html').getAttribute('lang') === 'fi'
    && await page.locator('[data-language="fi"]').getAttribute('aria-pressed') === 'true'
    && await page.locator('[data-language="en"]').getAttribute('aria-pressed') === 'false', 'native Space selects Suomi and updates pressed states');
  check('toggle-keeps-startup', await page.locator('#loading').isVisible()
    && await page.evaluate(() => document.pointerLockElement === null), 'language selection leaves game start and pointer lock untouched');
  check('finnish-start-text', (await page.locator('#loading-text').textContent()) === 'Aloita peli napsauttamalla'
    && /Tekijät ja kiitokset/.test(await page.locator('#loading-credits-title').textContent())
    && /Välilyönti/.test(await page.locator('#loading-hint').textContent())
    && /Kevyt/.test(await page.locator('#graphics-preset option[value="low"]').textContent()), 'ready status, controls, graphics and credits are Finnish');
  assert.deepEqual(await page.locator('#loading-credits a').evaluateAll(links => links.map(link => ({ href: link.href, target: link.target, rel: link.rel }))), credits);
  check('credit-links-preserved', true, `${credits.length} source/license links retain destinations and safe navigation`);
  assert.deepEqual(await page.locator('#dropin option').evaluateAll(options => options.map(option => option.value)), destinationValues);
  check('dropin-values-stable', await page.locator('#dropin option[value="Senate Square"]').textContent() === 'Senaatintori'
    && await page.locator('#dropin option[value="Helsinki Cathedral steps"]').textContent() === 'Helsingin tuomiokirkon portaat', 'Finnish landmark labels retain original internal values');
  await page.screenshot({ path: path.join(values.out, 'finnish-start.png') }); captures.push('finnish-start.png');
  await page.setViewportSize({ width: 390, height: 360 });
  await page.locator('#loading-credits p a').scrollIntoViewIfNeeded();
  const narrow = await page.locator('#loading').evaluate(node => ({ client: node.clientWidth, scroll: node.scrollWidth, y: node.scrollTop, height: node.clientHeight, content: node.scrollHeight }));
  check('finnish-short-viewport', narrow.scroll <= narrow.client + 1 && narrow.y > 0 && narrow.content > narrow.height, 'Finnish credits fit horizontally and scroll fully at 390 × 360');
  await page.screenshot({ path: path.join(values.out, 'finnish-short-credits.png') }); captures.push('finnish-short-credits.png');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => !document.getElementById('play-button')?.disabled || !!window.__HELSINKI_ERROR__, null, { timeout: 300000 });
  check('finnish-persists', await page.locator('html').getAttribute('lang') === 'fi'
    && await page.locator('#play-button').textContent() === 'Aloita tutkiminen', 'explicit Finnish selection survives reload');
  await page.locator('#play-button').focus();
  await page.keyboard.press('Enter');
  check('keyboard-start', !await page.locator('#loading').isVisible(), 'Enter on the start button begins play');
  await page.waitForFunction(() => /askel \d+/.test(document.getElementById('stats')?.textContent ?? ''));
  check('finnish-hud', /PISTOOLI|NYRKIT/.test(await page.locator('#weapon').textContent())
    && /\d,\d ms/.test(await page.locator('#stats').textContent())
    && await page.locator('#dropin option[value=""]').textContent() === 'Siirry kohteeseen…'
    && await page.locator('#dropin').getAttribute('title') === 'Siirry osoitteeseen tai maamerkille',
  'weapon HUD, drop-in control and decimal separator follow Finnish');
  const tick = async () => Number(/askel (\d+)/.exec(await page.locator('#stats').textContent())?.[1] ?? -1);
  const before = await tick();
  await page.keyboard.down('w'); await page.waitForTimeout(1200); await page.keyboard.up('w');
  check('gameplay-ticking-after-start', await tick() > before,
    'simulation advances after selecting Finnish and starting play; movement needs separate native keyboard journey evidence');
  await page.screenshot({ path: path.join(values.out, 'finnish-game.png') }); captures.push('finnish-game.png');
  check('production-capabilities', await page.evaluate(() => typeof window.__HELSINKI_GAME__ === 'undefined'), 'localization adds no mutation/review API');
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => !document.getElementById('play-button')?.disabled || !!window.__HELSINKI_ERROR__, null, { timeout: 300000 });
  await page.locator('[data-language="en"]').click();
  check('english-restored', await page.locator('#loading-text').textContent() === 'Click to play'
    && await page.locator('#loading').isVisible(), 'English can be restored without starting play');
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelector('[data-language="en"]')?.getAttribute('aria-pressed') === 'true');
  check('english-persists', await page.locator('html').getAttribute('lang') === 'en', 'explicit English choice also survives reload');
  await context.close();

  const blocked = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await blocked.addInitScript(() => Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Storage unavailable', 'SecurityError'); } }));
  const privatePage = await blocked.newPage();
  privatePage.on('pageerror', error => errors.push(error.message));
  privatePage.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await privatePage.goto(url.href, { waitUntil: 'load' });
  await privatePage.locator('[data-language="fi"]').click();
  check('blocked-storage-toggle', await privatePage.locator('html').getAttribute('lang') === 'fi'
    && await privatePage.locator('#loading').isVisible(), 'Finnish remains selectable when localStorage access throws');
  await privatePage.waitForFunction(() => !document.getElementById('play-button')?.disabled || !!window.__HELSINKI_ERROR__, null, { timeout: 300000 });
  check('blocked-storage-startup', !await privatePage.evaluate(() => window.__HELSINKI_ERROR__)
    && await privatePage.locator('#loading-text').textContent() === 'Aloita peli napsauttamalla', 'storage restrictions do not prevent localized startup');
  await blocked.close();
  check('console', errors.length === 0, `${errors.length} console/page errors`);
} catch (error) {
  fatal = String(error?.stack ?? error);
  console.error(fatal);
} finally {
  writeFileSync(path.join(values.out, 'result.json'), JSON.stringify({ status: !fatal && checks.every(check => check.pass) ? 'PASS' : 'FAIL',
    url: url.href, browser: browser.version(), checks, errors, captures, fatal, appearance: 'CAPTURED_NOT_REVIEWED' }, null, 2) + '\n');
  await browser.close();
}
process.exitCode = !fatal && checks.every(check => check.pass) ? 0 : 1;
