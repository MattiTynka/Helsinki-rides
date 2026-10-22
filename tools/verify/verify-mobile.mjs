// Native CDP touch events against the ordinary shipped UI. No production debug API is installed.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { createNativeTouch } from './lib/native-touch.mjs';

const { values } = parseArgs({ options: { url: { type: 'string' }, out: { type: 'string' }, review: { type: 'boolean' }, language: { type: 'string' } } });
assert.ok(values.url && values.out, '--url and --out are required');
const target = new URL(values.url);
assert.ok(['127.0.0.1', 'localhost', 'mattitynka.github.io'].includes(target.hostname), 'unsupported verification host');
await mkdir(values.out, { recursive: false });
const browser = await chromium.launch({ channel: 'chromium', headless: true,
  args: ['--enable-gpu', '--ignore-gpu-blocklist', `--use-angle=${process.env.HELSINKI_VERIFY_ANGLE ?? 'vulkan'}`, '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
if (values.language) {
  assert.ok(['en', 'fi'].includes(values.language));
  await context.addInitScript(language => localStorage.setItem('helsinki-rides:language', language), values.language);
}
await context.addInitScript(() => {
  performance.setResourceTimingBufferSize(10000);
  const probe = { frames: [], pointers: [] };
  window.__mobileProbe = probe;
  const clear = WebGL2RenderingContext.prototype.clear;
  WebGL2RenderingContext.prototype.clear = function(mask) {
    if ((mask & this.COLOR_BUFFER_BIT) !== 0 && this.canvas.id === 'view') {
      probe.frames.push(performance.now()); if (probe.frames.length > 10000) probe.frames.shift();
    }
    return clear.call(this, mask);
  };
  for (const type of ['pointerdown', 'pointerup', 'pointercancel']) addEventListener(type, event => {
    probe.pointers.push({ type, pointerType: event.pointerType, role: event.target?.dataset?.touchRole ?? event.target?.className });
  }, true);
});
const page = await context.newPage(), errors = [], records = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
const cdp = await context.newCDPSession(page);
const touch = createNativeTouch(cdp);
async function centre(selector) {
  // A streamed character can briefly pause play after Start. A visible wrapper can have hidden
  // controls, so wait for the actual hit target instead of assuming network work finishes in 1.5 s.
  await page.locator(selector).waitFor({ state: 'visible', timeout: 90000 });
  const box = await page.locator(selector).boundingBox(); assert.ok(box, `${selector}: visible`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2, width: box.width, height: box.height };
}
async function tap(selector, id = 9) {
  const p = await centre(selector); await touch('touchStart', id, p.x, p.y); await touch('touchEnd', id);
}
const capture = name => page.screenshot({ path: path.join(values.out, `${name}.png`) });
const tick = () => page.evaluate(() => window.__HELSINKI_GAME__?.tick()
  ?? Number(/(?:tick|askel) (\d+)/.exec(document.querySelector('#stats')?.textContent ?? '')?.[1] ?? -1));
const state = () => page.evaluate(() => window.__HELSINKI_GAME__?.state() ?? null);
try {
  await page.goto(target.href, { waitUntil: 'load' });
  await page.waitForFunction(() => !document.querySelector('#play-button')?.disabled || !!window.__HELSINKI_ERROR__, null, { timeout: 180000 });
  assert.equal(await page.evaluate(() => window.__HELSINKI_ERROR__ ?? null), null);
  if (values.language) assert.equal(await page.getAttribute('html', 'lang'), values.language);
  if (!values.review) {
    assert.equal(await page.evaluate(() => typeof window.__HELSINKI_GAME__), 'undefined');
    const before = await tick(); await page.waitForTimeout(700); assert.equal(await tick(), before, 'startup waits for play');
    await capture('startup'); await page.locator('#play-button').tap();
  }
  await page.locator('#touch-controls').waitFor({ state: 'visible' });
  await page.waitForTimeout(1500);
  const startState = await state(), beforeMove = await tick();
  const stick = await centre('.touch-stick');
  await touch('touchStart', 1, stick.x, stick.y - stick.height * .33);
  await page.waitForTimeout(1300);
  const fire = await centre('[data-touch-role="fire"]');
  const beforeAmmo = await page.locator('#weapon').textContent();
  await touch('touchStart', 2, fire.x, fire.y);
  await touch('touchMove', 2, fire.x + 22, fire.y - 10);
  await page.waitForTimeout(100);
  await touch('touchEnd', 2); await touch('touchEnd', 1);
  await page.waitForTimeout(400);
  assert.ok(await tick() > beforeMove + 30, 'fixed ticks advance with native touch');
  assert.equal(await page.evaluate(() => document.pointerLockElement === null), true, 'touch does not require pointer lock');
  const afterMove = await state();
  if (startState && afterMove) assert.ok(Math.hypot(afterMove.player.position[0] - startState.player.position[0], afterMove.player.position[2] - startState.player.position[2]) > .5, 'native touch moves the player');
  const afterAmmo = await page.locator('#weapon').textContent();
  assert.notEqual(afterAmmo, beforeAmmo, 'native fire changes weapon/ammunition');
  await capture('walking-and-fire');
  await tap('[data-touch-role="jump"]'); await page.waitForTimeout(65); await tap('[data-touch-role="jump"]');
  if (values.review) {
    await page.waitForTimeout(90); const jumped = await state();
    records.push({ jump: jumped.player });
    assert.ok(jumped.player.jumpKind === 'super' || jumped.player.position[1] > afterMove.player.position[1] + .5, 'quick double tap jumps');
  }
  await page.locator('#pause-button').tap();
  await page.locator('#pause-menu').waitFor({ state: 'visible' });
  if (!values.review) await page.waitForTimeout(2000); // The cosmetic HUD timer also slows while paused.
  const pausedTick = await tick(); await page.waitForTimeout(600); assert.equal(await tick(), pausedTick, 'pause stops simulation');
  await capture('paused');
  await page.locator('#resume-button').tap(); await page.waitForTimeout(500);
  assert.ok(await tick() > pausedTick, 'resume restarts simulation');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'view', 'resume returns gameplay focus');
  await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(400);
  await capture('portrait');
  for (const selector of ['.touch-stick', '[data-touch-role="fire"]', '#pause-button']) {
    const p = await centre(selector); assert.ok(p.x >= 0 && p.y >= 0 && p.x <= 390 && p.y <= 844, `${selector}: portrait hit target on screen`);
  }
  await page.setViewportSize({ width: 844, height: 390 }); await page.waitForTimeout(500);
  await page.evaluate(() => { window.__mobileProbe.frames.length = 0; });
  await page.waitForTimeout(5000);
  const metrics = await page.evaluate(() => {
    const frames = window.__mobileProbe.frames, intervals = frames.slice(1).map((time, i) => time - frames[i]).sort((a,b) => a-b);
    const canvas = document.querySelector('#view');
    return { browser: navigator.userAgent, pointerCoarse: matchMedia('(pointer: coarse)').matches,
      width: canvas.width, height: canvas.height, css: [innerWidth, innerHeight],
      medianMs: intervals[Math.floor(intervals.length * .5)], p95Ms: intervals[Math.floor(intervals.length * .95)],
      frames: frames.length, pointers: window.__mobileProbe.pointers,
      reducedTextures: performance.getEntriesByType('resource').filter(r => r.name.includes('/textures-m1/')).length,
      resourceEncodedBytes: performance.getEntriesByType('resource').reduce((sum,r) => sum + r.encodedBodySize, 0) };
  });
  assert.ok(metrics.width <= 844 && metrics.height <= 390, '3D resolution is bounded independently of DPR 3');
  assert.ok(metrics.reducedTextures > 0, 'automatic mobile mode requests reduced textures');
  assert.ok(metrics.pointers.some(p => p.pointerType === 'touch' && p.role === 'fire'), 'actual browser touch fired');
  assert.ok(metrics.frames < 180, 'mobile presentation does not run at desktop/retina frame rate');
  assert.deepEqual(errors, []);
  await capture('landscape');
  await writeFile(path.join(values.out, 'result.json'), JSON.stringify({ status: 'PASS', scope: 'Chromium touch emulation; physical phone performance unmeasured', url: target.href, review: !!values.review, records, metrics, errors }, null, 2));
  console.log(JSON.stringify({ status: 'PASS', frames: metrics.frames, medianMs: metrics.medianMs, p95Ms: metrics.p95Ms }));
} catch (error) {
  await capture('failure').catch(() => {});
  await writeFile(path.join(values.out, 'result.json'), JSON.stringify({ status: 'FAIL', message: error.message, errors, records }, null, 2));
  throw error;
} finally { await context.close(); await browser.close(); }
