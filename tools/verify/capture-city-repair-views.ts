// Reproducible native-runtime wall and facade views. Simulation is paused and advanced in fixed ticks through
// actual keyboard controls; fixtures are not a claim of continuous play. No direct position/renderer hook is used.
// node tools/verify/capture-city-repair-views.ts --release apps/game/public/world/ID --out data/evidence/NEW [--facade-only]
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { EncodedCommand, SimState } from '../../packages/sim/src/index.ts';
import type { WorldManifest } from '../../packages/world-schema/src/index.ts';
import { game, openGame } from './lib/browser.ts';

const { values } = parseArgs({ options: { release: { type: 'string' }, out: { type: 'string' }, url: { type: 'string', default: 'http://127.0.0.1:5317/' }, 'facade-only': { type: 'boolean', default: false }, 'wall-only': { type: 'boolean', default: false }, 'survey-only': { type: 'boolean', default: false }, 'reference-only': { type: 'boolean', default: false }, 'view-plan': { type: 'string' }, 'runtime-sha256': { type: 'string' } } });
if (!values.release || !values.out) throw new Error('--release and --out are required');
if ([values['facade-only'], values['wall-only'], values['survey-only'], values['reference-only'], values['view-plan']].filter(Boolean).length > 1) throw new Error('Capture mode flags are mutually exclusive');
const out = values.out;
const sourceSha256 = createHash('sha256').update(readFileSync(import.meta.filename)).digest('hex');
if (existsSync(out)) throw new Error(`${out} exists; evidence is never overwritten`);
mkdirSync(out, { recursive: true });
const bytes = readFileSync(path.join(values.release, 'manifest.json')), manifest = JSON.parse(bytes.toString('utf8')) as WorldManifest;
type ViewFixture = { id: string; startXZ: [number, number]; approachXZs?: [number, number][]; views: [number, number][] };
const planBytes = values['view-plan'] ? readFileSync(values['view-plan']) : null;
const plan = planBytes ? JSON.parse(planBytes.toString('utf8')) as { schemaVersion: number; fixtures: ViewFixture[] } : null;
if (plan) {
  const finitePair = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2 && v.every(Number.isFinite);
  if (plan.schemaVersion !== 1 || !Array.isArray(plan.fixtures) || !plan.fixtures.length || plan.fixtures.length > 20) throw new Error('View plan needs schemaVersion1 and 1-20 fixtures');
  const ids = new Set<string>();
  for (const fixture of plan.fixtures) {
    if (!/^[a-z0-9-]{1,80}$/.test(fixture.id) || ids.has(fixture.id) || !finitePair(fixture.startXZ) || !Array.isArray(fixture.views) || !fixture.views.length || fixture.views.length > 20 || fixture.views.some(v => !finitePair(v) || Math.abs(v[0]) > Math.PI || Math.abs(v[1]) > .7)) throw new Error('Invalid bounded view fixture');
    ids.add(fixture.id);
    if (fixture.approachXZs && (!Array.isArray(fixture.approachXZs) || fixture.approachXZs.length > 30 || fixture.approachXZs.some(v => !finitePair(v)))) throw new Error('Invalid fixture approach');
    for (const [x, z] of [fixture.startXZ, ...(fixture.approachXZs ?? [])]) if (x < manifest.boundsRuntimeXZ[0] || x > manifest.boundsRuntimeXZ[2] || z < manifest.boundsRuntimeXZ[1] || z > manifest.boundsRuntimeXZ[3]) throw new Error('Fixture outside world bounds');
  }
}
const url = new URL(values.url); url.searchParams.set('review', '1'); url.searchParams.set('release', manifest.worldReleaseId);
const session = await openGame(url.toString(), { width: 1200, height: 850 });
const { page } = session;
const runtimeUrl = await page.locator('script[type="module"][src]').first().getAttribute('src');
if (!runtimeUrl) { await session.close(); throw new Error('Missing runtime module'); }
const runtimeSha256 = createHash('sha256').update(await (await page.request.get(new URL(runtimeUrl, url).href)).body()).digest('hex');
if (values['runtime-sha256'] && runtimeSha256 !== values['runtime-sha256']) { await session.close(); throw new Error('Wrong candidate runtime'); }
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
type Native = Window & { __HELSINKI_GAME__: { reset(): void; commands(): EncodedCommand[] } };
const fixtures: { id: string; request: number[]; state: SimState; commands: EncodedCommand[]; captures: { file: string; yaw: number; pitch: number }[] }[] = [];
async function reset(x: number, z: number): Promise<void> {
  await game.pause(page); await page.evaluate(() => (window as unknown as Native).__HELSINKI_GAME__.reset());
  await game.setCommand(page, null); await game.teleport(page, x, z); await game.step(page, 30);
}
async function walkTo(x: number, z: number): Promise<void> {
  await page.keyboard.down('AltLeft'); await page.keyboard.down('KeyW');
  try {
    for (let i = 0; i < 700; i++) {
      const p = (await game.state(page)).player.position, distance = Math.hypot(x - p[0], z - p[2]);
      if (distance < 0.06) return;
      await game.setCamera(page, Math.atan2(x - p[0], z - p[2]), -0.12);
      await game.step(page, distance < 0.5 ? 2 : 6);
    }
    throw new Error(`keyboard fixture approach did not reach ${x},${z}`);
  } finally { await page.keyboard.up('KeyW'); await page.keyboard.up('AltLeft'); await game.step(page, 30); }
}
async function capture(id: string, request: number[], views: [number, number][]): Promise<void> {
  const state = await game.state(page), captures: { file: string; yaw: number; pitch: number }[] = [];
  for (const [yaw, pitch] of views) {
    await game.setCamera(page, yaw, pitch); await game.awaitVisuals(page); await sleep(650);
    await page.evaluate(() => window.__HELSINKI_GAME__!.render());
    const file = `${id}-yaw${yaw.toFixed(3)}-pitch${pitch.toFixed(2)}.png`;
    await page.screenshot({ path: path.join(out, file) }); captures.push({ file, yaw, pitch });
  }
  fixtures.push({ id, request, state, commands: await page.evaluate(() => (window as unknown as Native).__HELSINKI_GAME__.commands()), captures });
  console.log(`${id}: ${JSON.stringify(state.player.position)}, ${captures.length} views`);
}
let failure: string | null = null;
try {
  await game.start(page); await game.pause(page);
  if (await game.release(page) !== manifest.worldReleaseId) throw new Error('runtime release mismatch');
  if (plan) {
    for (const fixture of plan.fixtures) {
      await reset(...fixture.startXZ);
      for (const point of fixture.approachXZs ?? []) await walkTo(...point);
      await capture(fixture.id, fixture.startXZ, fixture.views);
    }
  } else if (values['reference-only']) {
    await reset(-74.235879667, -45.152118931);
    const views: [number, number][] = [];
    for (const heading of [230, 240, 250]) for (const pitch of [-0.12, 0.25, 0.4]) views.push([Math.PI - heading * Math.PI / 180, pitch]);
    await capture('university-ne-reference-road', [-74.235879667, -45.152118931], views);
  } else if (values['survey-only']) {
    // Preserve the named Street View survey positions/headings from handoff-20261017/tools/views.ts.
    const survey: [string, number, number, number[]][] = [
      ['p2-yliopistonkatu-library', -70, -25, [300, 30]],
      ['p3-unioninkatu36-library', -79, -105, [200, 290]],
      ['p5-kirkkokatu13-estates', 120, -155, [0, 315]],
      ['p6-snellmaninkatu3', 70, -65, [270, 90]],
    ];
    for (const [id, x, z, headings] of survey) {
      await reset(x, z);
      await capture(id, [x, z], headings.map(h => [Math.PI - h * Math.PI / 180, -0.02]));
    }
  } else {
  const facadeViews: [number, number][] = [];
  for (const heading of [230, 240, 250, 260]) for (const pitch of [-0.12, -0.3]) facadeViews.push([Math.PI - heading * Math.PI / 180, pitch]);
  // Street View reference camera 60.1699191,24.9509267 converted through the recorded EPSG:3879 origin.
  if (!values['wall-only']) {
    await reset(-74.235879667, -45.152118931); await capture('university-ne-reference-road', [-74.235879667, -45.152118931], facadeViews);
    await reset(-70, -25); await capture('university-ne-road', [-70, -25], facadeViews);
  }
  await reset(-33.7, -37.5); await walkTo(-33.7, -37.5); await walkTo(-34.365094, -41.343203);
  if (!values['wall-only']) await capture('university-ne-from-stairs', [-34.365094, -41.343203], facadeViews);
  if (!values['facade-only']) {
    const wallViews: [number, number][] = [];
    for (const yaw of [-3.09, -2.6, -2.2, -1.8, -1.4]) for (const pitch of [-0.12, -0.4, 0.05]) wallViews.push([yaw, pitch]);
    await capture('west-pier-step9', [-34.365094, -41.343203], wallViews);
    await walkTo(-34.382183, -41.698133); await capture('west-pier-step10', [-34.382183, -41.698133], wallViews);
    await walkTo(-34.74571534795, -47.16901772365);
    await capture('west-landing-inside', [-34.74571534795, -47.16901772365], [[-2.2, -0.12], [-1.4, -0.4]]);
    await walkTo(-35.44490474795, -47.13535402365);
    await capture('west-landing-outside', [-35.44490474795, -47.13535402365], [[-2.2, -0.12], [-1.4, -0.4]]);
    await walkTo(-34.74571534795, -47.16901772365);
  }
  await walkTo(-34.45, -55); await walkTo(-36, -55.2);
  const topViews: [number, number][] = [];
  for (const heading of [250, 260, 270, 280, 290, 300]) topViews.push([Math.PI - heading * Math.PI / 180, -0.12]);
  await capture('university-ne-from-top', [-36, -55.2], topViews);
  }
} catch (error) { failure = String(error); console.error(failure); process.exitCode = 1; }
finally {
  writeFileSync(path.join(out, 'views.json'), JSON.stringify({ status: failure ? 'INCOMPLETE' : 'CAPTURED_NOT_REVIEWED', release: manifest.worldReleaseId, manifestSha256: createHash('sha256').update(bytes).digest('hex'), sourceSha256, runtimeUrl, runtimeSha256, planPath: values['view-plan'] ?? null, planSha256: planBytes ? createHash('sha256').update(planBytes).digest('hex') : null, browser: session.browser.version(), viewport: page.viewportSize(), angle: process.env.HELSINKI_VERIFY_ANGLE ?? 'd3d11', method: 'Fixed simulation ticks through real Alt+W keyboard state; initial teleport snaps to nearest road; fixtures and camera angles are explicit.', fixtures, consoleErrors: session.consoleErrors, failure }, null, 2) + '\n');
  if (!page.isClosed()) { await page.keyboard.up('KeyW'); await page.keyboard.up('AltLeft'); }
  await session.close();
}
