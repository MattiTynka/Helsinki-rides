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
  await page.locator('#loading').click({ position: { x: 500, y: 300 } });
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
  check('network', failed.length === 0, `${failed.length} failed requests`);
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
  writeFileSync(path.join(values.out, 'result.json'), JSON.stringify({ status: checks.every(c => c.pass) && !fatal ? 'PASS' : 'FAIL', url: url.href, browser: browser.version(), checks, errors, failed, responses, captures, fatal, appearance: 'CAPTURED_NOT_REVIEWED' }, null, 2) + '\n');
  await context.close(); await browser.close();
}
process.exitCode = checks.every(c => c.pass) && !fatal ? 0 : 1;
