import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { game, openGame } from './lib/browser.ts';
const { values } = parseArgs({ options: { url: { type: 'string', default: 'http://127.0.0.1:5317/' }, release: { type: 'string' }, out: { type: 'string' }, preset: { type: 'string', default: 'low' } } });
if (!values.release || !values.out || fs.existsSync(values.out)) throw new Error('--release and fresh --out required');
fs.mkdirSync(values.out, { recursive: true });
const url = new URL(values.url); url.searchParams.set('release', values.release); url.searchParams.set('review', '1'); url.searchParams.set('preset', values.preset);
const session = await openGame(url.href, { timeoutMs: 240000 }), { page } = session, records = [];
await game.pause(page);
const manifestBytes = fs.readFileSync(path.join('apps/game/public/world', values.release, 'manifest.json'));
const runtimeUrl = await page.locator('script[type="module"][src]').first().getAttribute('src');
const runtimeBytes = runtimeUrl ? await (await page.request.get(new URL(runtimeUrl, url).href)).body() : null;
const binding = { manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'), runtimeUrl,
  runtimeSha256: runtimeBytes ? createHash('sha256').update(runtimeBytes).digest('hex') : null, browser: session.browser.version(), viewport: page.viewportSize() };
try {
  await game.start(page); await game.pause(page);
  for (const label of ['Senate Square', 'Kluuvi / Aleksanterinkatu', 'Ateneum / Kaivokatu', 'Helsinki Central Railway Station', 'Kaisaniemenkatu', 'Esplanadi']) {
    await game.dropIn(page, label);
    await page.evaluate(() => window.__HELSINKI_GAME__.awaitVisuals());
    for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      await game.setCamera(page, yaw, -.08);
      await page.waitForTimeout(150);
      await page.evaluate(() => window.__HELSINKI_GAME__.render());
      const data = await page.evaluate(() => ({ breakdown: window.__HELSINKI_GAME__.renderBreakdown(), stream: window.__HELSINKI_GAME__.streaming(), state: window.__HELSINKI_GAME__.state(), stats: window.__HELSINKI_GAME__.stats() }));
      records.push({ label, yaw, ...data });
      console.log(label, yaw.toFixed(2), data.breakdown.triangles, JSON.stringify(data.breakdown.groups.slice(0, 6)));
    }
  }
  await page.screenshot({ path: path.join(values.out, 'final.png') });
} finally { await session.close(); }
fs.writeFileSync(path.join(values.out, 'results.json'), JSON.stringify({ release: values.release, preset: values.preset, ...binding, records, errors: session.consoleErrors, fixture: true }, null, 1));
