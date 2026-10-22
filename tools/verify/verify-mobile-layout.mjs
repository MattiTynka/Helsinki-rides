// Check the ordinary production UI with actual translated text and browser layout, without a simulation API.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';

const { values } = parseArgs({ options: { url: { type: 'string' }, out: { type: 'string' } } });
assert.ok(values.url && values.out, '--url and --out are required');
const target = new URL(values.url);
assert.ok(['127.0.0.1', 'localhost', 'mattitynka.github.io'].includes(target.hostname), 'unsupported verification host');
await mkdir(path.dirname(values.out), { recursive: true }); await mkdir(values.out, { recursive: false });
const browser = await chromium.launch({ channel: 'chromium', headless: true,
  args: ['--enable-gpu', '--ignore-gpu-blocklist', `--use-angle=${process.env.HELSINKI_VERIFY_ANGLE ?? 'vulkan'}`, '--enable-unsafe-swiftshader'] });
const captures = [], errors = [];
try {
  for (const language of ['en', 'fi']) {
    const context = await browser.newContext({ viewport: { width: 844, height: 390 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
    try {
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
      await page.goto(target.href, { waitUntil: 'load' });
      await page.locator(`[data-language="${language}"]`).tap();
      await page.waitForFunction(() => !document.querySelector('#play-button')?.disabled || !!window.__HELSINKI_ERROR__, null, { timeout: 180000 });
      assert.equal(await page.evaluate(() => window.__HELSINKI_ERROR__ ?? null), null);
      await page.locator('#play-button').tap();
      await page.locator('#touch-controls').waitFor({ state: 'visible', timeout: 30000 });
      await page.waitForTimeout(1600);
      for (const [name, width, height] of [['landscape', 844, 390], ['portrait', 390, 844], ['narrow-portrait', 320, 568]]) {
        await page.setViewportSize({ width, height }); await page.waitForTimeout(350);
        await page.locator('#touch-controls').waitFor({ state: 'visible', timeout: 30000 });
        const layout = await page.evaluate(() => {
          const rect = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
          const pause = rect(document.querySelector('#pause-button')), dropin = rect(document.querySelector('#dropin')), minimap = rect(document.querySelector('#minimap'));
          const failures = [], controls = [];
          for (const button of document.querySelectorAll('.touch-button')) {
            if (!button.getClientRects().length) continue;
            const box = rect(button), label = button.textContent, words = [];
            if (box.width < 44 || box.height < 44) failures.push(`${label}: target smaller than 44px`);
            if (box.x < 0 || box.y < 0 || box.right > innerWidth + .5 || box.bottom > innerHeight + .5) failures.push(`${label}: target outside viewport`);
            const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
            for (let node = walker.nextNode(); node; node = walker.nextNode()) for (const word of node.textContent.matchAll(/\S+/g)) {
              const range = document.createRange(); range.setStart(node, word.index); range.setEnd(node, word.index + word[0].length);
              const fragments = [...range.getClientRects()].filter(r => r.width > 0), rows = new Set(fragments.map(r => Math.round(r.top * 2) / 2));
              if (rows.size > 1) failures.push(`${label}: word ${word[0]} wraps across lines`);
              if (fragments.some(r => r.left < box.x - .5 || r.right > box.right + .5)) failures.push(`${label}: word ${word[0]} overflows its button`);
              words.push({ word: word[0], rows: [...rows], widths: fragments.map(r => r.width) });
            }
            controls.push({ role: button.dataset.touchRole, label, box, words });
          }
          const overlap = pause.x < dropin.right && pause.right > dropin.x && pause.y < dropin.bottom && pause.bottom > dropin.y;
          if (overlap) failures.push('Pause overlaps the location selector');
          if (dropin.x < minimap.right && dropin.right > minimap.x && dropin.y < minimap.bottom && dropin.bottom > minimap.y) failures.push('Location selector overlaps the minimap');
          if (pause.width < 44 || pause.height < 44 || dropin.height < 44) failures.push('Pause or location selector has an undersized touch target');
          return { language: document.documentElement.lang, viewport: [innerWidth, innerHeight], pause, dropin, minimap, controls, failures,
            hasReviewApi: typeof window.__HELSINKI_GAME__ !== 'undefined' };
        });
        captures.push({ name: `${language}-${name}`, ...layout });
        await page.screenshot({ path: path.join(values.out, `${language}-${name}.png`) });
        assert.equal(layout.language, language);
        assert.equal(layout.hasReviewApi, false, 'ordinary production has no review API');
        assert.deepEqual(layout.failures, [], `${language} ${name}: translated controls fit`);
        console.log(`PASS ${language} ${name}: ${layout.controls.length} visible controls, no split words or Pause overlap`);
      }
    } finally { await context.close(); }
  }
  assert.deepEqual(errors, []);
  await writeFile(path.join(values.out, 'result.json'), JSON.stringify({ status: 'PASS', scope: 'Chromium mobile layout at DPR 3; physical-device performance unmeasured', captures, errors }, null, 2));
} catch (error) {
  await writeFile(path.join(values.out, 'result.json'), JSON.stringify({ status: 'FAIL', message: error.message, captures, errors }, null, 2));
  throw error;
} finally { await browser.close(); }
