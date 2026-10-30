// Labelled visual fixtures only. Real-control reachability is a separate journey gate.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { game, openGame } from './lib/browser.ts';

const { values } = parseArgs({ options: {
  url: { type: 'string', default: 'http://127.0.0.1:5329/' },
  release: { type: 'string' }, survey: { type: 'string' },
  view: { type: 'string', multiple: true }, out: { type: 'string' },
  preset: { type: 'string', default: 'standard' }, 'runtime-sha256': { type: 'string' },
} });
for (const key of ['release', 'survey', 'out', 'runtime-sha256']) assert.ok(values[key], `--${key} required`);
assert.ok(values.view?.length, 'Explicit --view IDs required');
assert.match(values['runtime-sha256'], /^[a-f0-9]{64}$/);
assert.ok(['low', 'standard'].includes(values.preset));
assert.ok(!fs.existsSync(values.out), 'Use a fresh output directory');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const manifestBytes = fs.readFileSync(path.join(values.release, 'manifest.json'));
const manifest = JSON.parse(manifestBytes);
const surveyBytes = fs.readFileSync(values.survey), survey = JSON.parse(surveyBytes);
const selected = values.view.map(id => {
  const matches = survey.views.filter(view => view.id === id);
  assert.equal(matches.length, 1, `Unique survey view required: ${id}`);
  const view = matches[0];
  assert.ok(Array.isArray(view.runtimeXZ) && view.runtimeXZ.length === 2 && view.runtimeXZ.every(Number.isFinite));
  assert.ok(Number.isFinite(view.headingDegrees ?? view.headingsInspectedDegrees?.[0]));
  return view;
});
const url = new URL(values.url);
assert.ok(['localhost', '127.0.0.1'].includes(url.hostname), 'Only local candidates may be captured');
url.searchParams.set('release', manifest.worldReleaseId);
url.searchParams.set('review', '1'); url.searchParams.set('preset', values.preset);
fs.mkdirSync(values.out, { recursive: true });
const captures = [];
let session, failure = null, runtimeSha256 = null;
try {
  session = await openGame(url.href, { timeoutMs: 240000 });
  const page = session.page;
  assert.equal(await game.release(page), manifest.worldReleaseId);
  const runtimeUrl = await page.locator('script[type="module"][src]').first().getAttribute('src');
  assert.ok(runtimeUrl);
  runtimeSha256 = await session.loadedResponseSha256(new URL(runtimeUrl, url).href);
  assert.equal(runtimeSha256, values['runtime-sha256'], 'Wrong candidate runtime');
  const manifestUrls = await page.evaluate(release => [...new Set(performance.getEntriesByType('resource').map(entry => entry.name).filter(name => new URL(name).pathname.endsWith(`/${release}/manifest.json`)))], manifest.worldReleaseId);
  assert.equal(manifestUrls.length, 1);
  assert.equal(await session.loadedResponseSha256(manifestUrls[0]), sha(manifestBytes), 'Loaded world differs from verified local manifest');
  await game.start(page); await game.pause(page);
  for (const view of selected) {
    const heading = view.headingDegrees ?? view.headingsInspectedDegrees[0];
    await game.teleport(page, ...view.runtimeXZ, heading);
    for (const offset of [0, -35, 35]) {
      const yaw = Math.PI - (heading + offset) * Math.PI / 180;
      await game.setCamera(page, yaw, -.08);
      await game.awaitVisuals(page);
      await page.evaluate(() => new Promise(resolve => {
        let frames = 0;
        const frame = () => { if (++frames >= 6) resolve(); else requestAnimationFrame(frame); };
        requestAnimationFrame(frame);
      }));
      const snapshot = await page.evaluate(() => {
        const api = window.__HELSINKI_GAME__;
        return { state: api.state(), presentation: api.presentation(), streaming: api.streaming(),
          stats: api.stats(), textures: api.textureMemory(), breakdown: api.renderBreakdown() };
      });
      assert.deepEqual([...(snapshot.streaming?.detail.errors ?? []), ...(snapshot.streaming?.fallback.errors ?? [])], []);
      const file = `${String(captures.length).padStart(3, '0')}-${view.id.replace(/[^a-z0-9-]/gi, '-')}-${offset}.png`;
      await page.screenshot({ path: path.join(values.out, file) });
      captures.push({ file, view: view.id, requestedXZ: view.runtimeXZ, heading, offset, yaw,
        placementOffsetMetres: Math.hypot(snapshot.state.player.position[0] - view.runtimeXZ[0], snapshot.state.player.position[2] - view.runtimeXZ[1]),
        review: 'CAPTURED_NOT_REVIEWED', ...snapshot });
      console.log(`CAPTURED_NOT_REVIEWED ${file}`);
    }
  }
  assert.deepEqual(session.consoleErrors, []);
} catch (error) {
  failure = String(error.stack ?? error);
  if (session) await session.page.screenshot({ path: path.join(values.out, 'failure.png') }).catch(() => {});
} finally {
  if (session) await session.close();
}
const result = {
  status: failure ? 'FAIL' : 'CAPTURED_NOT_REVIEWED',
  scope: 'Paused coordinate drop-in visual fixtures. No walking, driving, FPS or reachability acceptance.',
  release: manifest.worldReleaseId, manifestSha256: sha(manifestBytes),
  surveySha256: sha(surveyBytes), expectedRuntimeSha256: values['runtime-sha256'], runtimeSha256,
  producerSha256: sha(fs.readFileSync(new URL(import.meta.url))),
  browserHelperSha256: sha(fs.readFileSync(new URL('./lib/browser.ts', import.meta.url))),
  preset: values.preset, browser: session?.browser.version(), captures, failure,
};
fs.writeFileSync(path.join(values.out, 'result.json'), JSON.stringify(result, null, 2) + '\n');
console.log(result.status);
if (failure) { console.error(failure); process.exitCode = 1; }
