// Runtime acceptance and benchmark against the dev or preview server on loopback (plan sections 5, 15 and 17):
// the release loads without console errors, the budgets hold in the real renderer (draw calls, textures, frame time)
// at the spawn, on Unioninkatu and during a drive, and the lighting A/B captures are written for review.
//   node tools/verify/verify-browser.ts --url http://127.0.0.1:5317/?review=1 --release apps/game/public/world/<id> --out data/evidence/NEW_DIR [--preset standard|low] [--headful]
// Screenshots are CAPTURED_NOT_REVIEWED until a person opens them.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import type { WorldManifest } from '../../packages/world-schema/src/index.ts';
import { game, openGame } from './lib/browser.ts';

const { values } = parseArgs({ options: {
  url: { type: 'string', default: 'http://127.0.0.1:5317/?review=1' }, release: { type: 'string' }, out: { type: 'string' },
  preset: { type: 'string', default: 'standard' }, headful: { type: 'boolean', default: false }, seconds: { type: 'string', default: '8' },
} });
if (!values.release || !values.out) throw new Error('--release and --out are required');
const OUT = values.out;
if (existsSync(OUT)) throw new Error(`${OUT} exists; evidence directories are never overwritten`);
mkdirSync(OUT, { recursive: true });
const manifestBytes = readFileSync(path.join(values.release, 'manifest.json'));
const manifest = JSON.parse(manifestBytes.toString()) as WorldManifest;
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const cellsConfig = JSON.parse(readFileSync('content/helsinki/cells.json', 'utf8')) as { budgets: { drawCallsPerCell: number; sceneTextureMiB: number; lowPresetTextureMiB: number } };
const preset = values.preset === 'low' ? 'low' : 'standard';
const DRAW_CALL_LIMIT = preset === 'low' ? 350 : 600;
const TRIANGLE_LIMIT = preset === 'low' ? 500000 : 1200000;
const TEXTURE_MIB_LIMIT = preset === 'low' ? cellsConfig.budgets.lowPresetTextureMiB : 320;
const MIN_FPS = 30;
const SECONDS = Number(values.seconds);

interface Check { id: string; pass: boolean; detail: string }
const checks: Check[] = [];
const check = (id: string, pass: boolean, detail: string) => { checks.push({ id, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${id}: ${detail}`); };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const url = new URL(values.url);
url.searchParams.set('preset', preset);
const t0 = performance.now();
const session = await openGame(url.toString(), { headful: values.headful, timeoutMs: 240000 });
const loadSeconds = (performance.now() - t0) / 1000;
const { page } = session;
const runtimeUrl = await page.locator('script[type="module"][src]').first().getAttribute('src');
if (!runtimeUrl) throw new Error('Missing runtime module');
const runtimeSha256 = sha(await (await page.request.get(new URL(runtimeUrl, url).href)).body());
// Bytes over the wire so far (Resource Timing; encoded size when the response came from cache).
const transferred = () => page.evaluate(() => performance.getEntriesByType('resource').reduce((a, e) => a + ((e as PerformanceResourceTiming).transferSize || (e as PerformanceResourceTiming).encodedBodySize || 0), 0));
const transferToControl = await transferred();
await game.start(page);
await game.awaitVisuals(page);
const release = await game.release(page);
check('release', release === manifest.worldReleaseId, `browser runs ${release}`);
check('load', loadSeconds < 60, `ready after ${loadSeconds.toFixed(1)} s`);
const gpu = await page.evaluate(() => { const c = document.createElement('canvas').getContext('webgl2'); const d = c?.getExtension('WEBGL_debug_renderer_info'); return d && c ? String(c.getParameter(d.UNMASKED_RENDERER_WEBGL)) : 'unknown'; });
console.log(`gpu: ${gpu}`);

interface Sample { fps: number; frameMs: number; drawCalls: number; triangles: number; textures: number }
const overBudgetViews: unknown[] = [];
let diagnosedTrianglePeak = TRIANGLE_LIMIT;
async function measure(label: string, seconds: number, act?: () => Promise<void>): Promise<{ label: string; samples: Sample[]; fpsAvg: number; fpsMin: number; frameMsP95: number; drawCallsMax: number; trianglesMax: number; texturesMax: number }> {
  const samples: Sample[] = [];
  const end = Date.now() + seconds * 1000;
  await sleep(600);
  while (Date.now() < end) {
    if (act) await act();
    const st = await game.stats(page);
    if (st.fps! > 0) samples.push({ fps: st.fps!, frameMs: st.frameMs!, drawCalls: st.drawCalls!, triangles: st.triangles!, textures: st.textures! });
    if (st.triangles! > diagnosedTrianglePeak) {
      diagnosedTrianglePeak = st.triangles!;
      overBudgetViews.push({ label, sampledStats: st, ...await page.evaluate(() => {
        const api = window.__HELSINKI_GAME__!;
        return { state: api.state(), presentation: api.presentation(), stream: api.streaming(), breakdown: api.renderBreakdown() };
      }) });
    }
    await sleep(250);
  }
  const fps = samples.map(s => s.fps), ms = samples.map(s => s.frameMs).sort((a, b) => a - b);
  const r = { label, samples, fpsAvg: fps.reduce((a, b) => a + b, 0) / Math.max(1, fps.length), fpsMin: Math.min(...fps), frameMsP95: ms[Math.floor(ms.length * 0.95)] ?? 0, drawCallsMax: Math.max(...samples.map(s => s.drawCalls)), trianglesMax: Math.max(...samples.map(s => s.triangles)), texturesMax: Math.max(...samples.map(s => s.textures)) };
  console.log(`${label}: ${r.fpsAvg.toFixed(0)} fps avg, ${r.fpsMin.toFixed(0)} min, frame p95 ${r.frameMsP95.toFixed(2)} ms, ${r.drawCallsMax} draw calls, ${r.trianglesMax} triangles, ${r.texturesMax} textures`);
  return r;
}

// 1. Spawn view, lit and unlit captures (the M0 A/B evidence).
const spawnLit = await measure('spawn-lit', SECONDS);
await page.screenshot({ path: path.join(OUT, `${preset}-spawn-lit.png`) });
for (const [i, yaw] of [0, Math.PI / 2, Math.PI, -Math.PI / 2].entries()) { await game.setCamera(page, yaw, -0.08); await sleep(300); await page.screenshot({ path: path.join(OUT, `${preset}-spawn-lit-${i}.png`) }); }
await game.setLighting(page, 'unlit');
await sleep(300);
for (const [i, yaw] of [0, Math.PI / 2, Math.PI, -Math.PI / 2].entries()) { await game.setCamera(page, yaw, -0.08); await sleep(300); await page.screenshot({ path: path.join(OUT, `${preset}-spawn-unlit-${i}.png`) }); }
await game.setLighting(page, 'lit');
await game.setCamera(page, 0, -0.1);
// 2. Landmarks.
for (const label of ['Unioninkatu / Aleksanterinkatu', 'Helsinki Cathedral steps', 'Snellmaninkatu', 'Kirkkokatu']) {
  await game.dropIn(page, label);
  await game.awaitVisuals(page);
  await sleep(500);
  await page.screenshot({ path: path.join(OUT, `${preset}-${label.toLowerCase().replace(/[^a-z]+/g, '-')}.png`) });
}
const street = await measure('unioninkatu', SECONDS / 2);
// 3. Drive: take the nearest car and hold the throttle while steering gently, measuring the whole time.
await game.dropIn(page, 'Senate Square');
await game.awaitVisuals(page);
await sleep(300);
let s = await game.state(page);
const car = s.vehicles.find(v => v.id === 'car-1')!;
await game.setCommand(page, { moveZ: 1, yaw: Math.atan2(car.position[0] - s.player.position[0], car.position[2] - s.player.position[2]), buttons: 1 });
for (let i = 0; i < 100; i++) { s = await game.state(page); if (s.player.nearVehicle) break; await sleep(100); }
await game.setCommand(page, { buttons: 2 });
await sleep(100);
await game.setCommand(page, null);
for (let i = 0; i < 160; i++) { s = await game.state(page); if (s.player.mode === 'driving') break; await sleep(100); }
check('enterCar', s.player.mode === 'driving', `mode ${s.player.mode}`);
let flip = 1;
const drive = await measure('drive', SECONDS, async () => { flip = -flip; await game.setCommand(page, { moveZ: 0.8, moveX: 0.25 * flip }); });
await game.setCommand(page, null);
await page.screenshot({ path: path.join(OUT, `${preset}-drive.png`) });
s = await game.state(page);
const carNow = s.vehicles.find(v => v.id === s.player.inVehicle);
check('drove', !!carNow && Math.hypot(carNow.position[0] - car.position[0], carNow.position[2] - car.position[2]) > 20, carNow ? `moved ${Math.hypot(carNow.position[0] - car.position[0], carNow.position[2] - car.position[2]).toFixed(0)} m` : 'no car');

// Budgets.
const worst = [spawnLit, street, drive];
const drawCallsMax = Math.max(...worst.map(w => w.drawCallsMax));
const trianglesMax = Math.max(...worst.map(w => w.trianglesMax));
const fpsMin = Math.min(...worst.map(w => w.fpsAvg));
check('drawCalls', drawCallsMax <= DRAW_CALL_LIMIT, `max ${drawCallsMax} (limit ${DRAW_CALL_LIMIT}, ${preset})`);
check('triangles', trianglesMax <= TRIANGLE_LIMIT, `max ${trianglesMax} (limit ${TRIANGLE_LIMIT}, ${preset})`);
check('fps', fpsMin >= MIN_FPS, `lowest scene average ${fpsMin.toFixed(0)} fps (limit ${MIN_FPS})`);
// Measured in the page: the bytes actually uploaded (transcoded KTX2 mips). The manifest's per-cell estimate is an
// uncompressed RGBA upper bound that counts shared tiles once per cell, so it is reported but not gated.
const uncompressedSumMiB = manifest.cells.reduce((a, c) => a + c.visual.lod0.textureBytesEstimate, 0) / (1024 * 1024);
const gpuTextures = await page.evaluate(() => (window as unknown as { __HELSINKI_GAME__: { textureMemory(): { textures: number; mib: number; duplicateMiB: number } } }).__HELSINKI_GAME__.textureMemory());
const cellsReport = { gpuTextureMiB: Math.round(gpuTextures.mib * 10) / 10, gpuTextures: gpuTextures.textures, duplicateTextureMiB: Math.round(gpuTextures.duplicateMiB * 10) / 10, uncompressedSumMiB: Math.round(uncompressedSumMiB) };
check('textures', gpuTextures.mib <= TEXTURE_MIB_LIMIT, `${gpuTextures.mib.toFixed(1)} MiB uploaded in ${gpuTextures.textures} textures (${gpuTextures.duplicateMiB.toFixed(1)} MiB byte-identical copies), limit ${TEXTURE_MIB_LIMIT}`);
check('consoleErrors', session.consoleErrors.length === 0, session.consoleErrors.length ? session.consoleErrors.slice(0, 3).join(' | ') : 'none');

const transfer = await transferred();
const summary = { status: checks.every(c => c.pass) ? 'PASS' : 'FAIL', release, manifestSha256: sha(manifestBytes), runtimeUrl, runtimeSha256, harnessSha256: sha(readFileSync(new URL(import.meta.url))), browser: session.browser.version(), viewport: page.viewportSize(), angle: process.env.HELSINKI_VERIFY_ANGLE ?? 'd3d11', preset, gpu, loadSeconds, transferToControlMB: Math.round(transferToControl / 1e5) / 10, transferMB: Math.round(transfer / 1e5) / 10, checks, scenes: worst.map(({ samples: _s, ...rest }) => rest), overBudgetViews, cellsReport, screenshots: 'CAPTURED_NOT_REVIEWED', capturedAt: new Date().toISOString() };
writeFileSync(path.join(OUT, 'browser.json'), JSON.stringify(summary, null, 1) + '\n');
console.log(`\n${summary.status}: ${checks.filter(c => c.pass).length}/${checks.length} checks, ${summary.transferToControlMB} MB transferred to first control, ${summary.transferMB} MB in total, evidence in ${OUT}`);
await session.close();
process.exit(summary.status === 'PASS' ? 0 : 1);
