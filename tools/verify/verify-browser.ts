// Runtime acceptance and benchmark against the dev or preview server on loopback (plan sections 5, 15 and 17):
// the release loads without console errors, the budgets hold in the real renderer (draw calls, textures, frame time)
// at the spawn, on Unioninkatu and during a drive, and the lighting A/B captures are written for review.
//   node tools/verify/verify-browser.ts --url http://127.0.0.1:5317/?review=1 --release apps/game/public/world/<id> --out data/evidence/NEW_DIR [--preset standard|low] [--headful]
// Screenshots are CAPTURED_NOT_REVIEWED until a person opens them.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import type { WorldManifest } from '../../packages/world-schema/src/index.ts';
import { game, openGame } from './lib/browser.ts';

const { values } = parseArgs({ options: {
  url: { type: 'string', default: 'http://127.0.0.1:5317/?review=1' }, release: { type: 'string' }, out: { type: 'string' },
  preset: { type: 'string', default: 'standard' }, headful: { type: 'boolean', default: false }, seconds: { type: 'string', default: '8' },
  'runtime-sha256': {type: 'string'},
  'drop-in': {type: 'string', multiple: true},
  'extra-yaw-deg': {type: 'string', multiple: true},
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
const extraYaw=(values['extra-yaw-deg']??[]).map(Number);
assert.ok(extraYaw.length<=4&&extraYaw.every(v=>Number.isFinite(v)&&v>=-180&&v<=180),'Extra benchmark views require up to four finite angles in [-180,180]');
assert.ok(!extraYaw.length||values['drop-in']?.length,'Extra benchmark views require selected district stops');

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
const runtimeSha256 = await session.loadedResponseSha256(new URL(runtimeUrl, url).href);
if (values['runtime-sha256']) {
  assert.match(values['runtime-sha256'], /^[a-f0-9]{64}$/);
  assert.equal(runtimeSha256, values['runtime-sha256'], 'Wrong original benchmark runtime');
}
const loadedManifestUrls = await page.evaluate(release => [...new Set(performance.getEntriesByType('resource')
  .map(entry => entry.name).filter(name => new URL(name).pathname.endsWith(`/${release}/manifest.json`)))], manifest.worldReleaseId);
assert.equal(loadedManifestUrls.length, 1, 'Exactly one originally loaded candidate manifest is required');
assert.equal(await session.loadedResponseSha256(loadedManifestUrls[0]!), sha(manifestBytes), 'Wrong original benchmark world');
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

interface Sample { fps: number; frameMs: number; drawCalls: number; triangles: number; textures: number;
  tick: number; actors: { characters: number; vehicles: number; police: number } }
const overBudgetViews: unknown[] = [];
let diagnosedTrianglePeak = TRIANGLE_LIMIT;
async function measure(label: string, seconds: number, act?: () => Promise<void>) {
  const samples: Sample[] = [];
  const end = Date.now() + seconds * 1000;
  // The native stats gate keeps its original cadence. A separate rAF census
  // records real frame intervals, including while controls move the vehicle.
  const simulationStartTick = await page.evaluate(() => {
    const host=window as unknown as {__nativeBenchmarkFrames?:{active:boolean;last:number|null;frames:number[];overflow:number}};
    if(host.__nativeBenchmarkFrames?.active)throw new Error('A benchmark frame census is already active');
    const capture={active:true,last:null as number|null,frames:[] as number[],overflow:0};host.__nativeBenchmarkFrames=capture;
    // rAF timestamps can precede performance.now() within the same frame. Only
    // differences between successive rAF timestamps are frame intervals.
    const frame=(now:number)=>{if(!capture.active)return;if(capture.last!==null){const ms=now-capture.last;if(capture.frames.length<120000)capture.frames.push(ms);else capture.overflow++;}capture.last=now;requestAnimationFrame(frame);};requestAnimationFrame(frame);
    return window.__HELSINKI_GAME__!.tick();
  });
  await sleep(600);
  while (Date.now() < end) {
    if (act) await act();
    const {st, actors} = await page.evaluate(() => {
      const api=window.__HELSINKI_GAME__!, state=api.state();
      return {st:api.stats(), actors:{characters:state.characters.length,vehicles:state.vehicles.length,police:state.police.length}};
    });
    if (st.fps > 0) samples.push({ fps: st.fps, frameMs: st.frameMs, drawCalls: st.drawCalls, triangles: st.triangles, textures: st.textures, tick:st.tick, actors });
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
  const resources=await page.evaluate(()=>{
    const host=window as unknown as {__nativeBenchmarkFrames?:{active:boolean;last:number|null;frames:number[];overflow:number}},capture=host.__nativeBenchmarkFrames,api=window.__HELSINKI_GAME__;
    if(!capture||!api)throw new Error('Benchmark frame/resource census is unavailable');capture.active=false;
    const state=api.state();
    return{rawFrameIntervalsMs:capture.frames,frameOverflow:capture.overflow,textureOwnership:api.textureOwnership(),rendererTextures:api.stats().textures,
      simulationEndTick:state.tick,actorCensus:{playerMode:state.player.mode,playerPosition:state.player.position,
        characterIds:state.characters.map(actor=>actor.id),vehicleIds:state.vehicles.map(actor=>actor.id),policeUnits:state.police.length}};
  });
  assert.equal(resources.frameOverflow,0,'Benchmark raw frame census overflow');
  assert.ok(resources.rawFrameIntervalsMs.length>0&&resources.rawFrameIntervalsMs.every(v=>Number.isFinite(v)&&v>=0),'Benchmark frame intervals are missing or nonfinite');
  const raw=[...resources.rawFrameIntervalsMs].sort((a,b)=>a-b),percentile=(p:number)=>raw[Math.min(raw.length-1,Math.floor(raw.length*p))]!;
  const r = { label, samples, fpsAvg: fps.reduce((a, b) => a + b, 0) / Math.max(1, fps.length), fpsMin: Math.min(...fps), frameMsP95: ms[Math.floor(ms.length * 0.95)] ?? 0, drawCallsMax: Math.max(...samples.map(s => s.drawCalls)), trianglesMax: Math.max(...samples.map(s => s.triangles)), texturesMax: Math.max(...samples.map(s => s.textures)),
    actorSamples:samples.map(({tick,actors})=>({tick,...actors})),
    frameIntervals:{samples:raw.length,p50Ms:percentile(.5),p95Ms:percentile(.95),p99Ms:percentile(.99),maximumMs:raw.at(-1)!,over50Ms:raw.filter(v=>v>50).length,over100Ms:raw.filter(v=>v>100).length},simulationStartTick,...resources };
  console.log(`${label}: ${r.fpsAvg.toFixed(0)} fps avg, ${r.fpsMin.toFixed(0)} min, frame p95 ${r.frameMsP95.toFixed(2)} ms, ${r.drawCallsMax} draw calls, ${r.trianglesMax} triangles, ${r.texturesMax} textures; rAF p50/p95/p99 ${r.frameIntervals.p50Ms.toFixed(2)}/${r.frameIntervals.p95Ms.toFixed(2)}/${r.frameIntervals.p99Ms.toFixed(2)} ms`);
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
// Optional expansion fixtures join the same unchanged native FPS/draw/triangle
// gates. Cardinal views inspect a new district independently of route headings;
// optional angles include a specifically diagnosed worst view such as Eira +35.
const expansionScenes: Awaited<ReturnType<typeof measure>>[] = [];
if (values['drop-in']) {
  assert.ok(values['drop-in'].length >= 1 && values['drop-in'].length <= 16, 'Select1..16 native expansion benchmark stops');
  const labels = await page.locator('#dropin option').evaluateAll(options => options.map(option => option.getAttribute('label') || option.textContent));
  for (const [index, label] of values['drop-in'].entries()) {
    assert.ok(labels.includes(label), `Unknown native benchmark stop: ${label}`);
    await game.dropIn(page, label); await game.awaitVisuals(page);
    const angles=[...new Set([0,90,180,-90,...extraYaw])].map(degrees=>degrees*Math.PI/180);
    for (const [view, yaw] of angles.entries()) {
      await game.setCamera(page, yaw, -.1);
      expansionScenes.push(await measure(`expanded:${label}:view-${view}`, SECONDS));
      await page.screenshot({path: path.join(OUT, `${preset}-expanded-${index}-${view}.png`)});
    }
  }
}
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
const worst = [spawnLit, street, ...expansionScenes, drive];
const drawCallsMax = Math.max(...worst.map(w => w.drawCallsMax));
const trianglesMax = Math.max(...worst.map(w => w.trianglesMax));
const fpsMin = Math.min(...worst.map(w => w.fpsAvg));
check('drawCalls', drawCallsMax <= DRAW_CALL_LIMIT, `max ${drawCallsMax} (limit ${DRAW_CALL_LIMIT}, ${preset})`);
check('triangles', trianglesMax <= TRIANGLE_LIMIT, `max ${trianglesMax} (limit ${TRIANGLE_LIMIT}, ${preset})`);
check('fps', fpsMin >= MIN_FPS, `lowest scene average ${fpsMin.toFixed(0)} fps (limit ${MIN_FPS})`);
check('simulationAdvanced', worst.every(scene=>scene.simulationEndTick>scene.simulationStartTick),
  'The real simulation advances during every measurement; actor IDs/counts are recorded without assuming they are visible');
// Logical material handles provide a conservative scene estimate. Renderer-backed
// allocation identity separately accounts for shared Source/GL storage.
const uncompressedSumMiB = manifest.cells.reduce((a, c) => a + c.visual.lod0.textureBytesEstimate, 0) / (1024 * 1024);
const gpuTextures = await page.evaluate(() => (window as unknown as { __HELSINKI_GAME__: { textureMemory(): { textures: number; mib: number; duplicateMiB: number } } }).__HELSINKI_GAME__.textureMemory());
const textureOwnership = await page.evaluate(() => {
  const api = window.__HELSINKI_GAME__;
  if (!api) throw new Error('Review texture ownership adapter is unavailable');
  return api.textureOwnership();
});
const cellsReport = { sceneLogicalTextureMiB: Math.round(gpuTextures.mib * 10) / 10, logicalTextureHandles: gpuTextures.textures, duplicateLogicalTextureMiB: Math.round(gpuTextures.duplicateMiB * 10) / 10, textureOwnership, uncompressedSumMiB: Math.round(uncompressedSumMiB) };
check('textures', gpuTextures.mib <= TEXTURE_MIB_LIMIT, `${gpuTextures.mib.toFixed(1)} MiB logical material estimate in ${gpuTextures.textures} handles; limit ${TEXTURE_MIB_LIMIT}. Shared GPU allocation is recorded separately.`);
check('gpuTextureOwnership', worst.every(s=>s.textureOwnership.unaccountedGpuTextures===0&&s.textureOwnership.rendererTextures===s.rendererTextures), 'Each scene measurement endpoint has complete renderer-backed texture ownership');
check('gpuTextureStorageMeasured', worst.every(s=>s.textureOwnership.unmeasuredGpuTextures===0), 'Each scene measurement endpoint has measured GPU texture storage');
check('gpuTextureBytes', worst.every(s=>Number.isFinite(s.textureOwnership.ownedGpuMiB)&&s.textureOwnership.ownedGpuMiB<=TEXTURE_MIB_LIMIT+.01), `Scene endpoint GPU allocations stay within ${TEXTURE_MIB_LIMIT} MiB; residency soak is separate`);
check('consoleErrors', session.consoleErrors.length === 0, session.consoleErrors.length ? session.consoleErrors.slice(0, 3).join(' | ') : 'none');

const transfer = await transferred();
const summary = { status: checks.every(c => c.pass) ? 'PASS' : 'FAIL', release, manifestSha256: sha(manifestBytes), runtimeUrl, runtimeSha256, expectedRuntimeSha256: values['runtime-sha256'] ?? null, identityMethod: 'Original completed HTTP200 script and manifest responses; no identity refetch', harnessSha256: sha(readFileSync(new URL(import.meta.url))), browser: session.browser.version(), viewport: page.viewportSize(), angle: process.env.HELSINKI_VERIFY_ANGLE ?? 'd3d11', preset, gpu, loadSeconds, transferToControlMB: Math.round(transferToControl / 1e5) / 10, transferMB: Math.round(transfer / 1e5) / 10, checks, scenes: worst.map(({ samples: _s, ...rest }) => rest), overBudgetViews, cellsReport, screenshots: 'CAPTURED_NOT_REVIEWED', capturedAt: new Date().toISOString() };
writeFileSync(path.join(OUT, 'browser.json'), JSON.stringify(summary, null, 1) + '\n');
console.log(`\n${summary.status}: ${checks.filter(c => c.pass).length}/${checks.length} checks, ${summary.transferToControlMB} MB transferred to first control, ${summary.transferMB} MB in total, evidence in ${OUT}`);
await session.close();
process.exit(summary.status === 'PASS' ? 0 : 1);
