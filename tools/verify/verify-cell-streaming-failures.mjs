// Deliberate request-failure and delayed-completion fixtures. These are not traversal evidence.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { game, openGame } from './lib/browser.ts';

const { values } = parseArgs({ options: { url: { type: 'string', default: 'http://127.0.0.1:5317/' }, release: { type: 'string' }, out: { type: 'string' }, preset: { type: 'string', default: 'low' } } });
if (!values.release || !values.out || fs.existsSync(values.out)) throw new Error('--release and fresh --out required');
fs.mkdirSync(values.out, { recursive: true });
const manifestBytes = fs.readFileSync(path.join(values.release, 'manifest.json')), manifest = JSON.parse(manifestBytes);
const gameplay = JSON.parse(fs.readFileSync(path.join(values.release, manifest.gameplay.path)));
const spawn = gameplay.player.spawn.position;
const target = gameplay.landmarks.filter(p => Math.hypot(p.position[0] - spawn[0], p.position[1] - spawn[1]) > 400)
  .sort((a, b) => Math.hypot(b.position[0] - spawn[0], b.position[1] - spawn[1]) - Math.hypot(a.position[0] - spawn[0], a.position[1] - spawn[1]))[0];
if (!target) throw new Error('failure fixture needs a landmark at least 400m from spawn');
const pathsNear = ([x, z]) => new Set(manifest.cells.filter(c => Math.hypot(Math.max(c.boundsXZ[0] - x, 0, x - c.boundsXZ[2]), Math.max(c.boundsXZ[1] - z, 0, z - c.boundsXZ[3])) < 180)
  .flatMap(c => [c.visual.lod0.path, c.visual.lod1?.path, c.visual.lod2?.path].filter(Boolean)));
const farPaths = pathsNear(target.position), originPaths = pathsNear(spawn);
const url = new URL(values.url); url.searchParams.set('release', manifest.worldReleaseId); url.searchParams.set('review', '1'); url.searchParams.set('preset', values.preset);
const session = await openGame(url.href, { timeoutMs: 240000 }), { page } = session;
const runtimeUrl = await page.locator('script[type="module"][src]').first().getAttribute('src');
const runtimeBytes = runtimeUrl ? await (await page.request.get(new URL(runtimeUrl, url).href)).body() : null;
const binding = { manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'), runtimeUrl,
  runtimeSha256: runtimeBytes ? createHash('sha256').update(runtimeBytes).digest('hex') : null, browser: session.browser.version(), viewport: page.viewportSize() };
const checks = [], samples = [], requests = [], delayed = [];
const check = (id, pass, detail) => { checks.push({ id, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${id}: ${detail}`); };
const inspect = () => page.evaluate(() => ({ tick: window.__HELSINKI_GAME__.tick(), state: window.__HELSINKI_GAME__.state(), stream: window.__HELSINKI_GAME__.streaming(), stats: window.__HELSINKI_GAME__.stats(), message: document.getElementById('world-stream-status')?.textContent }));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let mode = 'pass';
try {
  await game.start(page);
  await page.route('**/cells/*.glb', async route => {
    const pathname = new URL(route.request().url()).pathname;
    const relative = pathname.slice(pathname.indexOf('/cells/') + 1);
    if (mode === '404' && farPaths.has(relative)) {
      requests.push({ kind: '404', path: relative });
      await route.fulfill({ status: 404, contentType: 'text/plain', body: 'Intentional streaming recovery fixture' });
    } else if (mode === 'delay' && originPaths.has(relative)) {
      requests.push({ kind: 'delayed', path: relative });
      await new Promise(resolve => delayed.push(async () => { await route.continue(); resolve(); }));
    } else await route.continue();
  });
  const before = await inspect(); samples.push({ label: 'startup', ...before });
  mode = '404';
  await game.dropIn(page, target.label);
  await page.waitForFunction(() => window.__HELSINKI_GAME__.streaming().coverage.blocked && window.__HELSINKI_GAME__.streaming().fallback.failedLoads > 0, undefined, { timeout: 15000 });
  const blocked = await inspect(); samples.push({ label: 'intentional-404-blocked', ...blocked });
  await page.keyboard.down('KeyW'); await sleep(700);
  const held = await inspect(); samples.push({ label: 'held-key-while-blocked', ...held });
  check('404-exercised', requests.some(r => r.kind === '404'), `${requests.filter(r => r.kind === '404').length} deliberate failures`);
  check('visible-loading-message', /Could not load nearby streets\. Retrying/.test(held.message), held.message);
  check('no-invisible-ground-traversal', held.tick === blocked.tick && JSON.stringify(held.state.player.position) === JSON.stringify(blocked.state.player.position), `tick ${blocked.tick} -> ${held.tick}`);
  await page.screenshot({ path: path.join(values.out, 'intentional-404-loading.png') });
  mode = 'pass';
  await page.waitForFunction(tick => !window.__HELSINKI_GAME__.streaming().coverage.blocked && window.__HELSINKI_GAME__.tick() > tick, held.tick, { timeout: 45000 });
  await page.keyboard.up('KeyW');
  await page.evaluate(() => window.__HELSINKI_GAME__.awaitVisuals());
  const recovered = await inspect(); samples.push({ label: 'retry-recovered', ...recovered });
  check('retry-resumes-controls', recovered.tick > held.tick && !recovered.stream.coverage.blocked && recovered.stream.coverage.missingCells.length === 0, `tick ${held.tick} -> ${recovered.tick}`);
  check('retry-clears-errors', recovered.stream.fallback.errors.length === 0 && recovered.stream.detail.errors.length === 0, JSON.stringify({ detail: recovered.stream.detail.errors, fallback: recovered.stream.fallback.errors }));
  await page.screenshot({ path: path.join(values.out, 'retry-recovered.png') });
  mode = 'delay';
  await game.teleport(page, spawn[0], spawn[1], gameplay.player.spawn.headingDeg);
  const until = Date.now() + 10000;
  while (!delayed.length && Date.now() < until) await sleep(50);
  check('delay-exercised', delayed.length > 0, `${delayed.length} held old-destination requests`);
  mode = 'pass';
  await game.dropIn(page, target.label);
  await Promise.all(delayed.splice(0).map(release => release()));
  await page.evaluate(() => window.__HELSINKI_GAME__.awaitVisuals());
  const final = await inspect(); samples.push({ label: 'stale-completion-retired', ...final });
  const retired = stream => stream.detail.staleDisposed + stream.fallback.staleDisposed + (stream.detail.cancelledLoads ?? 0) + (stream.fallback.cancelledLoads ?? 0);
  check('stale-work-retired', retired(final.stream) > retired(recovered.stream), JSON.stringify({ detailDisposed: final.stream.detail.staleDisposed, fallbackDisposed: final.stream.fallback.staleDisposed,
    detailCancelled: final.stream.detail.cancelledLoads, fallbackCancelled: final.stream.fallback.cancelledLoads }));
  check('final-coverage', final.stream.coverage.missingCells.length === 0, JSON.stringify(final.stream.coverage));
  const bytes = final.stream.detail.residentTextureMiB + final.stream.fallback.residentTextureMiB + final.stream.persistentTextureMiB;
  check('memory-cap', bytes <= final.stream.totalTextureBudgetMiB, `${bytes.toFixed(2)} / ${final.stream.totalTextureBudgetMiB} MiB`);
  check('no-unexpected-errors', session.consoleErrors.every(error => /Failed to load resource.*404/.test(error)), session.consoleErrors.join('; ') || 'none');
} catch (error) { check('harness', false, String(error.stack ?? error)); }
finally {
  mode = 'pass'; await Promise.all(delayed.splice(0).map(release => release())).catch(() => {});
  await page.keyboard.up('KeyW').catch(() => {}); await session.close();
}
fs.writeFileSync(path.join(values.out, 'results.json'), JSON.stringify({ status: checks.every(c => c.pass) ? 'PASS' : 'FAIL', release: manifest.worldReleaseId, ...binding,
  harnessSha256: createHash('sha256').update(fs.readFileSync(new URL(import.meta.url))).digest('hex'), preset: values.preset, target, checks, samples, requests,
  consoleErrors: session.consoleErrors, limitations: 'Intentional 404 and delayed-request fixtures with labelled teleports; screenshots require opened review. No continuous traversal claim.' }, null, 1));
if (checks.some(c => !c.pass)) process.exitCode = 1;
