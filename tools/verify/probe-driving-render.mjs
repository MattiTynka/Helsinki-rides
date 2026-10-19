// Replays a recorded command stream to expensive driving views. This is a diagnostic fixture, not a traversal gate.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { decodeCommand } from '../../packages/sim/src/commands.ts';
import { game, openGame } from './lib/browser.ts';

const { values } = parseArgs({ options: { url: { type: 'string', default: 'http://127.0.0.1:5317/' }, release: { type: 'string' },
  recording: { type: 'string' }, out: { type: 'string' }, preset: { type: 'string', default: 'low' }, 'far-assets-from': { type: 'string' } } });
if (!values.release || !values.recording || !values.out || fs.existsSync(values.out)) throw new Error('--release, --recording and fresh --out required');
const recordingBytes = fs.readFileSync(values.recording), recording = JSON.parse(recordingBytes);
const targets = [{ tick: 6860, label: 'Aleksanterinkatu-east', expectedXZ: [-245.26, 63.56] },
  { tick: 13887, label: 'Esplanadi-east', expectedXZ: [-262.48, 260.12] }];
if (recording.commands.length < targets.at(-1).tick) throw new Error('Recording is too short');
fs.mkdirSync(values.out, { recursive: true });
const url = new URL(values.url);
url.searchParams.set('release', values.release); url.searchParams.set('review', '1'); url.searchParams.set('preset', values.preset);
url.searchParams.set('seed', String(recording.seed));
const session = await openGame(url.href, { timeoutMs: 240000 }), { page } = session, records = [];
await game.pause(page);
const manifestBytes = fs.readFileSync(path.join('apps/game/public/world', values.release, 'manifest.json'));
let overlay = null;
if (values['far-assets-from']) {
  const sourceBytes = fs.readFileSync(path.join('apps/game/public/world', values['far-assets-from'], 'manifest.json'));
  const source = JSON.parse(sourceBytes), manifest = JSON.parse(manifestBytes);
  const variants = source.assets.filter(asset => ['vehicle-lumi-gt-far-low', 'vehicle-patrol-far-low'].includes(asset.id));
  if (variants.length !== 2) throw new Error('Both far-car variants are required for the diagnostic overlay');
  manifest.assets.push(...variants.map(asset => ({ ...asset, path: `../${values['far-assets-from']}/${asset.path}` })));
  overlay = { sourceRelease: source.worldReleaseId, sourceManifestSha256: createHash('sha256').update(sourceBytes).digest('hex'), assets: variants,
    scope: 'Two optional low far-car prop assets only; base world geometry/collision/simulation unchanged. Not a release acceptance run.' };
  await page.route(`**/world/${values.release}/manifest.json`, route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(manifest) }));
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => window.__HELSINKI_GAME__?.ready || window.__HELSINKI_ERROR__, undefined, { timeout: 240000 });
  const error = await page.evaluate(() => window.__HELSINKI_ERROR__); if (error) throw new Error(error);
}
const runtimeUrl = await page.locator('script[type="module"][src]').first().getAttribute('src');
const runtimeBytes = runtimeUrl ? await (await page.request.get(new URL(runtimeUrl, url).href)).body() : null;
const binding = { manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'), runtimeUrl,
  runtimeSha256: runtimeBytes ? createHash('sha256').update(runtimeBytes).digest('hex') : null,
  browser: session.browser.version(), viewport: page.viewportSize() };
try {
  await page.evaluate(() => { const g = window.__HELSINKI_GAME__; g.pause(); g.reset(); g.start(); if (g.tick() !== 0) throw new Error('Replay must start at tick zero'); });
  let tick = 0;
  for (const target of targets) {
    while (tick < target.tick) {
      const end = Math.min(target.tick, tick + 120), runs = [];
      for (let i = tick; i < end; i++) {
        const encoded = recording.commands[i], key = JSON.stringify(encoded), previous = runs.at(-1);
        if (previous?.key === key) previous.count++;
        else runs.push({ key, count: 1, command: decodeCommand(encoded) });
      }
      await page.evaluate(runs => { const g = window.__HELSINKI_GAME__; for (const run of runs) g.step(run.count, run.command); }, runs);
      tick = end;
    }
    await game.awaitVisuals(page);
    await game.setCamera(page, Math.PI / 2, -.18);
    // A final rendered update uses the driving camera already advanced by the replayed simulation.
    await page.evaluate(() => window.__HELSINKI_GAME__.render());
    const data = await page.evaluate(() => { const g = window.__HELSINKI_GAME__; return { state: g.state(), camera: g.presentation().camera,
      breakdown: g.renderBreakdown(), stream: g.streaming(), memory: g.textureMemory(), stats: g.stats() }; });
    const car = data.state.vehicles.find(vehicle => vehicle.id === data.state.player.inVehicle);
    const distance = car ? Math.hypot(car.position[0] - target.expectedXZ[0], car.position[2] - target.expectedXZ[1]) : null;
    records.push({ ...target, actualCar: car?.position, expectedDistance: distance, ...data });
    await page.screenshot({ path: path.join(values.out, `${target.label}.png`) });
    console.log(target.label, JSON.stringify({ actualCar: car?.position, expectedDistance: distance, triangles: data.breakdown.triangles,
      groups: data.breakdown.groups.slice(0, 10) }));
  }
} finally { await session.close(); }
fs.writeFileSync(path.join(values.out, 'results.json'), JSON.stringify({ release: values.release, preset: values.preset, ...binding, overlay,
  sourceRelease: recording.release, recordingSha256: createHash('sha256').update(recordingBytes).digest('hex'),
  diagnosticFixture: true, records, errors: session.consoleErrors }, null, 2));
