// Ordinary production smoke: DOM, rendered captures and keyboard input, without review capabilities.
import assert from 'node:assert/strict';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { chromium } from 'playwright';

const { values } = parseArgs({ options: { url: { type: 'string' }, out: { type: 'string' } } });
if (!values.url || !values.out) throw new Error('--url and a new --out directory are required');
const url = new URL(values.url);
if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password
  || !['mattitynka.github.io', '127.0.0.1', 'localhost'].includes(url.hostname)) {
  throw new Error('Only the official Pages site and loopback fixtures are accepted');
}
if (url.hostname === 'mattitynka.github.io' && (url.protocol !== 'https:' || url.pathname !== '/Helsinki-rides/')) {
  throw new Error('The public smoke must use the exact HTTPS game URL');
}
if (existsSync(values.out)) throw new Error('Evidence directories are never overwritten');
mkdirSync(values.out, { recursive: true });
const errors = [], failed = [], responses = [], checks = [], captures = [];
let loadingCredits = [], shortViewport = null;
const expectedCellCancellations = [];
const check = (id, pass, detail) => { checks.push({ id, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${id}: ${detail}`); };
const browser = await chromium.launch({ channel: 'chromium', headless: true,
  args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const t0 = Date.now();
let fatal = null;
try {
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('requestfailed', request => failed.push({ url: request.url(), error: request.failure()?.errorText }));
  page.on('response', response => responses.push({ url: response.url(), status: response.status() }));
  await page.goto(url.href, { waitUntil: 'load' });
  await page.waitForFunction(() => document.getElementById('loading-text')?.textContent === 'Click to play' || !!window.__HELSINKI_ERROR__, null, { timeout: 300000 });
  check('startup', !await page.evaluate(() => window.__HELSINKI_ERROR__), `ready after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  assert.equal(await page.locator('#loading-text').textContent(), 'Click to play');
  check('production-capabilities', await page.evaluate(() => typeof window.__HELSINKI_GAME__ === 'undefined'), 'review API absent');
  const info = await page.request.get(new URL('release-info.json', url).href);
  check('release-info', info.ok(), `HTTP ${info.status()}`);
  const releaseInfo = info.ok() ? await info.json() : null;
  const credits = page.locator('#loading-credits');
  assert.equal(await credits.isVisible(), true, 'credits are readable before entering the game');
  const creditText = await credits.textContent();
  for (const name of ['NoOb StUfFs (@NoObStUfFs)', 'Lumi GT', 'Revontuli', 'City of Helsinki',
    'Dany Sánchez (MiniWorld3D)', 'Jukka Seppänen (@kijaidesign)', 'Blender Studio', 'OpenStreetMap contributors']) {
    assert.ok(creditText.includes(name), `loading credit includes ${name}`);
  }
  assert.ok(!/Kaamos|GT40/.test(creditText), 'removed car has no loading credit');
  loadingCredits = await credits.locator('a').evaluateAll(links => links.map(link => ({
    text: link.textContent, href: link.href, target: link.target, rel: link.rel,
  })));
  const requiredSources = [
    'https://sketchfab.com/3d-models/ford-mustang-gt-500-with-pro-rig-for-free-f26a29f766844f46910547d6d2cc291d',
    'https://sketchfab.com/3d-models/bugatti-veyron-fully-rigged-5ca18dc84d074655966a6fe7165aa157',
    'https://sketchfab.com/NoObStUfFs', 'https://kartta.hel.fi/3d/',
    'https://www.printables.com/model/486571-helsinki-cathedral-finland',
    'https://creativecommons.org/licenses/by/4.0/', 'https://www.openstreetmap.org/copyright',
    'https://opendatacommons.org/licenses/odbl/1-0/',
  ];
  for (const href of requiredSources) assert.ok(loadingCredits.some(link => link.href === href), `linked credit: ${href}`);
  assert.ok(loadingCredits.every(link => link.target === '_blank' && link.rel.split(/\s+/).includes('noopener')
    && link.rel.split(/\s+/).includes('noreferrer')), 'credit links isolate the new tab');
  check('loading-credits', true, 'named source authors, adaptations and licenses are visible and linked');
  await page.screenshot({ path: path.join(values.out, 'loading-credits.png') });
  captures.push('loading-credits.png');
  // Exercise the real anchor without downloading a third-party model page. The
  // intercepted popup still navigates to the exact source URL in a separate tab.
  await context.route('https://sketchfab.com/**', route => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><title>Credit source link</title>',
  }));
  const [sourceTab] = await Promise.all([
    page.waitForEvent('popup'),
    credits.locator(`a[href="${requiredSources[0]}"]`).click(),
  ]);
  await sourceTab.waitForURL(requiredSources[0]);
  await sourceTab.close();
  await context.unroute('https://sketchfab.com/**');
  await page.locator('#loading-credits-title').click();
  check('credit-click-keeps-loading', await page.locator('#loading').isVisible()
    && await page.evaluate(() => document.pointerLockElement === null), 'source link and credit text leave click-to-play intact');
  await page.setViewportSize({ width: 390, height: 360 });
  await credits.locator('p a').scrollIntoViewIfNeeded();
  shortViewport = await page.evaluate(() => {
    const overlay = document.getElementById('loading');
    const last = document.querySelector('#loading-credits p a').getBoundingClientRect();
    return { width: innerWidth, height: innerHeight, clientWidth: overlay.clientWidth, scrollWidth: overlay.scrollWidth,
      clientHeight: overlay.clientHeight, scrollHeight: overlay.scrollHeight, scrollTop: overlay.scrollTop,
      lastLinkTop: last.top, lastLinkBottom: last.bottom };
  });
  check('loading-short-viewport', shortViewport.scrollWidth <= shortViewport.clientWidth + 1
    && shortViewport.scrollHeight > shortViewport.clientHeight && shortViewport.scrollTop > 0
    && shortViewport.lastLinkTop >= 0 && shortViewport.lastLinkBottom <= shortViewport.height,
  '390 × 360 credit panel scrolls to its final link without horizontal overflow');
  await page.screenshot({ path: path.join(values.out, 'loading-credits-short.png') });
  captures.push('loading-credits-short.png');
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.locator('#loading-text').click();
  check('play-after-credit-click', !await page.locator('#loading').isVisible(), 'click-to-play still works after opening credits');
  await page.waitForFunction(() => /tick \d+/.test(document.getElementById('stats')?.textContent ?? ''));
  const tick = async () => Number(/tick (\d+)/.exec(await page.locator('#stats').textContent())?.[1] ?? -1);
  const before = await tick();
  await page.keyboard.down('w');
  await page.waitForTimeout(1800);
  await page.keyboard.up('w');
  check('real-keyboard-simulation', await tick() > before, 'simulation ticks advance during WASD input');
  await page.screenshot({ path: path.join(values.out, 'senate-square.png') });
  captures.push('senate-square.png');
  const labels = await page.locator('#dropin option').allTextContents();
  for (const [id, pattern] of [['mannerheimintie', /Mannerheimintie/i], ['esplanadi', /Esplanadi/i], ['uspenski', /Uspenski/i], ['cathedral', /Helsinki Cathedral steps/i]]) {
    const label = labels.find(label => pattern.test(label));
    check(`landmark-${id}`, !!label, label ?? 'no matching drop-in destination');
    if (!label) continue;
    await page.locator('#dropin').selectOption({ label });
    await page.waitForTimeout(2000);
    await page.waitForFunction(() => document.getElementById('world-stream-status')?.classList.contains('hidden') ?? true, null, { timeout: 90000 });
    await page.screenshot({ path: path.join(values.out, `${id}.png`) });
    captures.push(`${id}.png`);
  }
  check('credits', /Helsinki|OpenStreetMap/.test(await page.locator('#attribution').textContent()), 'world attribution visible in the game');
  const visuals = new Set(responses.filter(r => /\.lod[012]\.[A-Za-z0-9.-]+\.glb$/.test(r.url)).map(r => r.url));
  check('streamed-visuals', visuals.size > 0 && visuals.size < 608, `${visuals.size} of 608 city visual files requested across the tested route`);
  check('http', responses.every(r => r.status < 400), `${responses.filter(r => r.status >= 400).length} HTTP errors`);
  // Moving to another district now deliberately aborts obsolete cell downloads.
  // Only exact cell GLB aborts count as expected; failures of other resources still fail the gate.
  expectedCellCancellations.push(...failed.filter(request => request.error === 'net::ERR_ABORTED'
    && new URL(request.url).origin === url.origin && /\/world\/[^/]+\/cells\/[A-Za-z0-9._-]+\.glb$/.test(new URL(request.url).pathname)));
  const unexpectedFailures = failed.filter(request => !expectedCellCancellations.includes(request));
  check('network', unexpectedFailures.length === 0, `${unexpectedFailures.length} unexpected failures; ${expectedCellCancellations.length} obsolete cell downloads cancelled`);
  check('console', errors.length === 0, `${errors.length} console/page errors`);
  const review = new URL(url); review.searchParams.set('review', '1');
  await page.goto(review.href, { waitUntil: 'load' });
  await page.waitForFunction(() => document.getElementById('loading-text')?.textContent === 'Click to play' || !!window.__HELSINKI_ERROR__, null, { timeout: 300000 });
  check('query-cannot-enable-review', await page.evaluate(() => typeof window.__HELSINKI_GAME__ === 'undefined' && !window.__HELSINKI_ERROR__), 'review=1 has no state mutation capability');
  writeFileSync(path.join(values.out, 'release-info.json'), JSON.stringify(releaseInfo, null, 2) + '\n');
} catch (error) {
  fatal = String(error?.stack ?? error);
  check('completed', false, error instanceof Error ? error.message : String(error));
  await page.screenshot({ path: path.join(values.out, 'failure.png') }).catch(() => {});
} finally {
  writeFileSync(path.join(values.out, 'result.json'), JSON.stringify({ status: checks.every(c => c.pass) && !fatal ? 'PASS' : 'FAIL', url: url.href, browser: browser.version(), checks, loadingCredits, shortViewport, errors, failed, expectedCellCancellations, responses, captures, fatal, appearance: 'CAPTURED_NOT_REVIEWED' }, null, 2) + '\n');
  await context.close(); await browser.close();
}
process.exitCode = checks.every(c => c.pass) && !fatal ? 0 : 1;
