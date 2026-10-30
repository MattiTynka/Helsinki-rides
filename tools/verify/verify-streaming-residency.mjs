// Repeated native drop-in fixtures for visual residency, disposal and retained-memory regression.
// These are labelled inspection fixtures, not evidence of continuous walking or driving.
// node tools/verify/verify-streaming-residency.mjs --url http://127.0.0.1:5317/
//   --out build/streaming-soak-FRESH --cycles 3 --dwell-seconds 10 --preset standard
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { game, openGame } from './lib/browser.ts';

const { values } = parseArgs({ options: {
  url: { type: 'string', default: 'http://127.0.0.1:5317/' }, out: { type: 'string' },
  cycles: { type: 'string', default: '3' }, 'dwell-seconds': { type: 'string', default: '10' },
  'duration-seconds': { type: 'string', default: '0' }, preset: { type: 'string', default: 'standard' },
  'runtime-sha256': { type: 'string' }, 'manifest-sha256': { type: 'string' },
  'drop-in': { type: 'string', multiple: true },
  headful: { type: 'boolean', default: false }, trace: { type: 'boolean', default: false },
} });
assert.ok(values.out, '--out is required and must be a new evidence directory');
assert.ok(!fs.existsSync(values.out), 'Evidence directory already exists');
const url = new URL(values.url);
assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname), 'Only a loopback review build may be inspected');
assert.ok(['http:', 'https:'].includes(url.protocol), 'Use a loopback HTTP(S) server');
assert.ok(!url.username && !url.password, 'Credentials in URLs are not accepted');
assert.ok(['standard', 'low'].includes(values.preset), '--preset must be standard or low');
const cycles = Number(values.cycles), dwellSeconds = Number(values['dwell-seconds']), durationSeconds = Number(values['duration-seconds']);
assert.ok(Number.isInteger(cycles) && cycles >= 1 && cycles <= 30, '--cycles must be an integer from 1 to 30');
assert.ok(Number.isFinite(dwellSeconds) && dwellSeconds >= 1 && dwellSeconds <= 60, '--dwell-seconds must be from 1 to 60');
assert.ok(Number.isFinite(durationSeconds) && durationSeconds >= 0 && durationSeconds <= 7200, '--duration-seconds must be from 0 to 7200');
for (const key of ['runtime-sha256', 'manifest-sha256']) if (values[key]) assert.match(values[key], /^[a-f0-9]{64}$/, `Invalid --${key}`);
url.searchParams.set('review', '1'); url.searchParams.set('preset', values.preset); url.searchParams.set('audio', '0');
fs.mkdirSync(values.out, { recursive: true });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const root = fileURLToPath(new URL('../../', import.meta.url));
const sourceFiles = ['apps/game/src/game.ts', 'apps/game/src/testapi.ts', 'apps/game/src/world/cell-streaming.ts',
  'apps/game/src/world/loader.ts', 'apps/game/src/render/scene.ts', 'apps/game/src/render/assets.ts',
  'apps/game/src/render/cell-resources.ts', 'apps/game/src/world/owned-ktx2-loader.ts',
  'apps/game/src/render/upload-queue.ts', 'apps/game/src/world/payload.ts',
  'apps/game/src/world/startup-queue.ts', 'apps/game/src/world/collision-stream.ts', 'packages/world-schema/src/payload.ts',
  'packages/sim/src/collision-residency.ts', 'packages/sim/src/world.ts', 'apps/game/src/review/texture-ownership.ts'];
const sourceHashes = Object.fromEntries(sourceFiles.filter(file => fs.existsSync(path.join(root, file)))
  .map(file => [file, sha(fs.readFileSync(path.join(root, file)))]));
const low = values.preset === 'low';
const limits = { detailCells: low ? 16 : 28, fallbackCells: low ? 28 : 42, totalTextureMiB: low ? 160 : 320,
  detailGeometryMiB: low ? 96 : 160, fallbackGeometryMiB: low ? 64 : 96,
  returnGeometriesGrowth: 10, returnTexturesGrowth: 4, returnRetainedHeapGrowthMiB: 20 };
const checks = [], samples = [], rounds = [], captures = [], requests = [], failedRequests = [], badResponses = [];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const startedAt = Date.now();
let routeStartedAt = null, session, page, cdp, browserCdp, traceActive = false, traceFile = null;
let failure = null, identity = null, renderer = null, route = [], availableLabels = [], baseline = null;
let startupSeconds = null, documentId = null, frameCount = 0, gcAvailable = false;
let networkAtReadiness = [], lastCycle = 0;
function check(id, pass, detail) {
  checks.push({ id, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id}: ${JSON.stringify(detail)}`);
}
function required(id, pass, detail) { check(id, pass, detail); assert.ok(pass, id); }
function percentile(numbers, p) {
  const sorted = numbers.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)] : null;
}
function frameSummary(frames) {
  return { samples: frames.length, p50Ms: percentile(frames, .5), p95Ms: percentile(frames, .95),
    p99Ms: percentile(frames, .99), maximumMs: frames.length ? Math.max(...frames) : null,
    over50Ms: frames.filter(ms => ms > 50).length, over100Ms: frames.filter(ms => ms > 100).length };
}
async function readSnapshot(label, phase = 'dwell') {
  const data = await page.evaluate(() => {
    const api = window.__HELSINKI_GAME__, state = api.state();
    const collector = window.__streamResidencyFrames;
    const frames = collector.frames.splice(0);
    return { tick: state.tick, position: state.player.position, mode: state.player.mode,
      actors: { characters: state.characters.length, vehicles: state.vehicles.length, policeUnits: state.police.length },
      stats: api.stats(), stream: api.streaming(), textureMemory: api.textureMemory(), textureOwnership: api.textureOwnership(), frames,
      rendererHeapBytes: performance.memory?.usedJSHeapSize ?? null };
  });
  frameCount += data.frames.length;
  const result = { label, phase, seconds: (Date.now() - startedAt) / 1000, ...data,
    frameIntervals: frameSummary(data.frames) };
  delete result.frames;
  // Keep raw intervals separate from the readable snapshots, bounded by the maximum run time.
  result.rawFrameIntervalsMs = data.frames;
  samples.push(result);
  validateResources(result);
  return result;
}
function validateResources(data) {
  assert.ok(data.stream, 'Review adapter must expose native visual streaming');
  const { detail, fallback } = data.stream;
  for (const [tier, stats] of [['detail', detail], ['fallback', fallback]]) {
    assert.ok(stats.residentCells <= limits[`${tier}Cells`], `${tier} resident cells exceed native cap`);
    assert.ok(stats.residentTextureMiB <= stats.textureBudgetMiB + .01, `${tier} texture budget exceeded`);
    assert.ok(stats.residentGeometryMiB <= limits[`${tier}GeometryMiB`] + .01, `${tier} geometry budget exceeded`);
    if (Number.isFinite(stats.maxCells)) assert.ok(stats.residentCells <= stats.maxCells, `${tier} declared cell budget exceeded`);
    assert.deepEqual(stats.errors, [], `${tier} current load errors`);
    assert.deepEqual(stats.errorHistory ?? [], [], `${tier} load error history`);
  }
  assert.equal(data.stream.totalTextureBudgetMiB, limits.totalTextureMiB, 'Native total texture cap changed');
  assert.ok(detail.residentTextureMiB + fallback.residentTextureMiB + data.stream.persistentTextureMiB <= limits.totalTextureMiB + .01,
    'Combined retained texture budget exceeded');
  assert.ok(data.textureMemory.mib <= limits.totalTextureMiB + .01, 'Scene texture memory exceeds total cap');
}
async function settle(label) {
  // Bound the adapter promise in the page as evaluate itself has no default timeout.
  await page.evaluate(() => Promise.race([
    window.__HELSINKI_GAME__.awaitVisuals(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Native visual settle exceeded 180 seconds')), 180000)),
  ]));
  let quietSince = null;
  const begin = Date.now();
  while (Date.now() - begin < 180000) {
    const snapshot = await readSnapshot(label, 'settle');
    const stream = snapshot.stream;
    const quiet = stream.detail.pendingCells === 0 && stream.fallback.pendingCells === 0 &&
      stream.coverage.missingCells.length === 0 && !stream.coverage.blocked && stream.fallback.missingNearDetail.length === 0;
    if (quiet) { quietSince ??= Date.now(); if (Date.now() - quietSince >= 1000) return snapshot; }
    else quietSince = null;
    await wait(250);
  }
  throw new Error(`Native streaming did not become quiet with complete near coverage: ${label}`);
}
async function dwell(label) {
  const begin = Date.now();
  while (Date.now() - begin < dwellSeconds * 1000) {
    await wait(Math.min(500, Math.max(1, dwellSeconds * 1000 - (Date.now() - begin))));
    await readSnapshot(label, 'dwell');
  }
}
async function performanceMetrics() {
  const { metrics } = await cdp.send('Performance.getMetrics');
  return Object.fromEntries(metrics.map(metric => [metric.name, metric.value]));
}
async function retainedEndpoint(cycle, label) {
  const beforeGC = await performanceMetrics();
  await cdp.send('HeapProfiler.collectGarbage');
  gcAvailable = true;
  // Render again so renderer.info observes GPU deletions as well as admissions.
  await page.evaluate(() => window.__HELSINKI_GAME__.render());
  await wait(500);
  const data = await readSnapshot(`cycle-${cycle}:${label}:after-gc`, 'endpoint-after-gc');
  const metrics = await performanceMetrics();
  assert.ok(Number.isFinite(metrics.JSHeapUsedSize) && metrics.JSHeapUsedSize > 0, 'CDP retained heap metric unavailable');
  required(`cycle-${cycle}:near-coverage`, data.stream.coverage.missingCells.length === 0 && !data.stream.coverage.blocked &&
    data.stream.fallback.missingNearDetail.length === 0, data.stream.coverage);
  required(`cycle-${cycle}:pending-settled`, data.stream.detail.pendingCells === 0 && data.stream.fallback.pendingCells === 0,
    { detail: data.stream.detail.pendingCells, fallback: data.stream.fallback.pendingCells });
  const ownership = data.textureOwnership;
  required(`cycle-${cycle}:gpu-textures-fully-owned`, ownership.unaccountedGpuTextures === 0 && ownership.rendererTextures === data.stats.textures,
    { rendererTextures: data.stats.textures, ownedGpuTextures: ownership.ownedGpuTextures, unaccounted: ownership.unaccountedGpuTextures });
  required(`cycle-${cycle}:gpu-texture-storage-measured`, ownership.unmeasuredGpuTextures === 0,
    { unmeasuredGpuTextures: ownership.unmeasuredGpuTextures, textureIds: ownership.unmeasuredTextureIds });
  required(`cycle-${cycle}:gpu-texture-byte-budget`, ownership.ownedGpuMiB <= limits.totalTextureMiB + .01,
    { ownedGpuMiB: ownership.ownedGpuMiB, totalTextureBudgetMiB: limits.totalTextureMiB, sharedBytesSaved: ownership.sharedBytesSaved });
  return { cycle, label, stats: data.stats, stream: data.stream, textureMemory: data.textureMemory, textureOwnership: ownership,
    position: data.position, actors: data.actors, tick: data.tick, beforeGCMetrics: beforeGC, afterGCMetrics: metrics,
    retainedHeapMiB: metrics.JSHeapUsedSize / 2 ** 20, seconds: data.seconds };
}
async function capture(label) {
  const file = `${label}.png`;
  await page.screenshot({ path: path.join(values.out, file) });
  captures.push({ label, file, review: 'CAPTURED_NOT_REVIEWED' });
}
async function fetchBinding(resourceUrl) {
  const resolved = new URL(resourceUrl, url);
  assert.equal(resolved.origin, url.origin, 'Runtime and world identity must come from the local candidate');
  const response = await page.request.get(resolved.href);
  assert.ok(response.ok(), `Cannot read candidate identity ${resolved.pathname}: ${response.status()}`);
  const bytes = await response.body();
  return { url: resolved.href, sha256: sha(bytes), bytes: bytes.length, body: bytes };
}
async function finishTrace() {
  if (!traceActive) return;
  traceActive = false;
  const complete = new Promise(resolve => cdp.once('Tracing.tracingComplete', resolve));
  await cdp.send('Tracing.end');
  const { stream } = await complete;
  traceFile = 'renderer-trace.json';
  const destination = fs.openSync(path.join(values.out, traceFile), 'wx');
  try {
    let eof = false;
    while (!eof) {
      const chunk = await cdp.send('IO.read', { handle: stream, size: 65536 });
      fs.writeSync(destination, Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8'));
      eof = chunk.eof;
    }
  } finally { fs.closeSync(destination); await cdp.send('IO.close', { handle: stream }); }
}

try {
  const opening = Date.now();
  session = await openGame(url.href, { headful: values.headful, timeoutMs: 240000 }); page = session.page;
  startupSeconds = (Date.now() - opening) / 1000;
  page.on('request', request => requests.push({ url: request.url(), resourceType: request.resourceType(), seconds: (Date.now() - startedAt) / 1000 }));
  page.on('requestfailed', request => failedRequests.push({ url: request.url(), failure: request.failure()?.errorText,
    expectedCancellation: /ERR_ABORTED|ABORT_ERR/i.test(request.failure()?.errorText ?? '') }));
  page.on('response', response => { if (response.status() >= 400) badResponses.push({ url: response.url(), status: response.status() }); });
  documentId = await page.evaluate(() => performance.timeOrigin);
  networkAtReadiness = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => ({
    url: entry.name, initiatorType: entry.initiatorType, encodedBytes: entry.encodedBodySize, transferredBytes: entry.transferSize,
  })));
  const runtimeUrl = await page.locator('script[type="module"][src]').first().getAttribute('src');
  assert.ok(runtimeUrl, 'A built runtime module is required');
  assert.ok(!runtimeUrl.includes('/src/'), 'Use the built review candidate, not a development server');
  const runtime = await fetchBinding(runtimeUrl);
  const manifestUrl = networkAtReadiness.find(entry => new URL(entry.url).pathname.endsWith('/manifest.json'))?.url;
  assert.ok(manifestUrl, 'A loaded native world manifest is required');
  const manifestResource = await fetchBinding(manifestUrl), manifest = JSON.parse(manifestResource.body.toString('utf8'));
  identity = { runtime: { url: runtime.url, sha256: runtime.sha256, bytes: runtime.bytes },
    world: { release: manifest.worldReleaseId, manifestUrl: manifestResource.url, manifestSha256: manifestResource.sha256,
      manifestBytes: manifestResource.bytes, cells: manifest.cells.length }, sourceHashes,
    harnessSha256: sha(fs.readFileSync(new URL(import.meta.url))), browserHelperSha256: sha(fs.readFileSync(new URL('./lib/browser.ts', import.meta.url))) };
  if (values['runtime-sha256']) assert.equal(runtime.sha256, values['runtime-sha256'], 'Wrong served runtime');
  if (values['manifest-sha256']) assert.equal(manifestResource.sha256, values['manifest-sha256'], 'Wrong served manifest');
  assert.equal(await game.release(page), manifest.worldReleaseId, 'Review runtime and manifest disagree');
  availableLabels = await page.locator('#dropin option').evaluateAll(options => options.map(option => option.label || option.textContent));
  const choose = (label, pattern) => {
    const found = availableLabels.find(candidate => candidate === label) ?? availableLabels.find(candidate => pattern.test(candidate));
    assert.ok(found, `Required native drop-in missing: ${label}`); return found;
  };
  const senate = choose('Senate Square', /^Senate Square$/i);
  if (values['drop-in']) {
    assert.ok(values['drop-in'].length >= 1 && values['drop-in'].length <= 30, 'Select1..30 native residency stops');
    for (const label of values['drop-in']) assert.ok(availableLabels.includes(label), `Unknown native residency stop: ${label}`);
    assert.ok(values['drop-in'].some(label => label !== senate), 'Residency route must leave Senate Square');
    route = [senate, ...values['drop-in']];
    if (route.at(-1) !== senate) route.push(senate);
  } else route = [senate, choose('Mannerheimintie / Lasipalatsi', /Mannerheimintie.*Lasipalatsi/i),
    choose('Esplanadi', /^Esplanadi$/i), choose('Uspenski Cathedral / Rahapajankatu', /Uspenski.*Rahapajankatu/i),
    choose('Parliament House / Mannerheimintie', /Parliament House/i),
    choose('Temppeliaukio public approach', /Temppeliaukio/i),
    choose('Töölöntori public western edge', /T.{0,4}l.{0,4}ntori|Hakaniementori/i), senate];
  cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  await cdp.send('HeapProfiler.enable');
  browserCdp = await session.browser.newBrowserCDPSession();
  const gpu = await browserCdp.send('SystemInfo.getInfo').catch(error => ({ error: String(error) }));
  const gpuInfo = gpu.gpu ?? gpu;
  renderer = { gpu: gpuInfo, softwareRendering: /swiftshader|llvmpipe|software rasterizer|microsoft basic render/i.test(JSON.stringify(gpuInfo)),
    chromium: session.browser.version(), angle: process.env.HELSINKI_VERIFY_ANGLE ?? 'd3d11',
    headful: values.headful, viewport: page.viewportSize(), platform: process.platform };
  await page.evaluate(() => {
    const collector = window.__streamResidencyFrames = { frames: [], last: null };
    const frame = now => { if (collector.last !== null) collector.frames.push(now - collector.last); collector.last = now; requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
  });
  if (values.trace) {
    await cdp.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline,v8,gpu,blink', transferMode: 'ReturnAsStream' });
    traceActive = true;
  }
  await game.start(page); await game.pause(page);
  await game.dropIn(page, senate); await game.setCamera(page, 0, -.1);
  await settle('baseline:Senate Square'); await dwell('baseline:Senate Square');
  baseline = await retainedEndpoint(0, senate); await capture('first-senate');
  routeStartedAt = Date.now();
  for (let cycle = 1; cycle <= cycles || (Date.now() - routeStartedAt) / 1000 < durationSeconds; cycle++) {
    assert.ok(cycle <= 100, 'Maximum of 100 complete fixture cycles reached');
    const stops = [], cycleStarted = Date.now();
    for (let stop = 1; stop < route.length; stop++) {
      const label = route[stop];
      await game.dropIn(page, label); await game.setCamera(page, 0, -.1);
      const settled = await settle(`cycle-${cycle}:${label}`); await dwell(`cycle-${cycle}:${label}`);
      stops.push({ label, position: settled.position, stats: settled.stats, stream: settled.stream,
        seconds: (Date.now() - startedAt) / 1000 });
    }
    const endpoint = await retainedEndpoint(cycle, senate);
    rounds.push({ cycle, seconds: (Date.now() - cycleStarted) / 1000, stops, endpoint }); lastCycle = cycle;
    console.log(`CYCLE ${cycle}: heap=${endpoint.retainedHeapMiB.toFixed(1)} MiB, geometries=${endpoint.stats.geometries}, textures=${endpoint.stats.textures}`);
  }
  await capture('last-senate');
  const returned = rounds.map(round => round.endpoint), last = returned.at(-1);
  required('distant-detail-eviction', last.stream.detail.evicted > baseline.stream.detail.evicted,
    { before: baseline.stream.detail.evicted, after: last.stream.detail.evicted });
  required('distant-fallback-eviction', last.stream.fallback.evicted > baseline.stream.fallback.evicted,
    { before: baseline.stream.fallback.evicted, after: last.stream.fallback.evicted });
  if (returned.length >= 2) {
    const warm = returned[0], later = returned.slice(1);
    for (const [field, tolerance] of [['geometries', limits.returnGeometriesGrowth]]) {
      const values = returned.map(endpoint => endpoint.stats[field]);
      required(`bounded-repeat-endpoint-${field}`, later.every(endpoint => endpoint.stats[field] <= warm.stats[field] + tolerance),
        { warmup: values[0], repeated: values.slice(1), allowedGrowth: tolerance,
          rationale: 'Same Senate fixture, camera and settled resident selection; small renderer initialization/race allowance after one full warmup circuit.' });
    }
    // FileLoader coalesces overlapping KTX2 requests; sequential loads own distinct Sources.
    // Thus raw GPU counts can vary despite identical live resources. Retain those observations,
    // but bound logical ownership and orphan allocations instead, with the same +4 allowance.
    required('bounded-repeat-endpoint-logical-textures', later.every(endpoint =>
      endpoint.textureOwnership.logicalTextureHandles <= warm.textureOwnership.logicalTextureHandles + limits.returnTexturesGrowth),
    { warmup: warm.textureOwnership.logicalTextureHandles, repeated: later.map(endpoint => endpoint.textureOwnership.logicalTextureHandles),
      materialHandles: returned.map(endpoint => endpoint.textureOwnership.materialTextureHandles), boneHandles: returned.map(endpoint => endpoint.textureOwnership.boneTextureHandles),
      rawGpuAllocations: returned.map(endpoint => endpoint.stats.textures), allowedGrowth: limits.returnTexturesGrowth });
    required('bounded-repeat-endpoint-unaccounted-textures', later.every(endpoint =>
      endpoint.textureOwnership.unaccountedGpuTextures <= warm.textureOwnership.unaccountedGpuTextures + limits.returnTexturesGrowth),
    { warmup: warm.textureOwnership.unaccountedGpuTextures, repeated: later.map(endpoint => endpoint.textureOwnership.unaccountedGpuTextures),
      allowedGrowth: limits.returnTexturesGrowth, rationale: 'Every quiet endpoint additionally requires exact zero residual and measured storage.' });
    required('bounded-repeat-endpoint-retained-heap', later.every(endpoint => endpoint.retainedHeapMiB <= warm.retainedHeapMiB + limits.returnRetainedHeapGrowthMiB),
      { afterForcedGCMiB: returned.map(endpoint => endpoint.retainedHeapMiB), allowedGrowthMiB: limits.returnRetainedHeapGrowthMiB,
        rationale: 'One full circuit warms decoders/caches. GC samples at the same quiet endpoint tolerate 20 MiB of normal VM/cache variation.' });
  } else check('repeat-endpoint-memory-coverage', false, 'At least two complete circuits are required for a warmed endpoint comparison');
  required('single-document', await page.evaluate(() => performance.timeOrigin) === documentId, documentId);
  required('no-http-errors', badResponses.length === 0, badResponses);
  required('no-unexpected-request-failures', failedRequests.every(request => request.expectedCancellation), failedRequests);
  const unexpectedConsoleErrors = session.consoleErrors.filter(message => !/net::ERR_ABORTED|AbortError:.*abort/i.test(message));
  required('no-browser-errors', unexpectedConsoleErrors.length === 0, unexpectedConsoleErrors);
} catch (error) {
  failure = String(error.stack ?? error); check('harness', false, failure);
  if (page) await capture('failure').catch(() => {});
} finally {
  if (traceActive) await finishTrace().catch(error => { failure ??= `Trace collection failed: ${error}`; });
  if (cdp) await cdp.detach().catch(() => {});
  if (browserCdp) await browserCdp.detach().catch(() => {});
  if (session) await session.close();
}
const allFrameIntervals = samples.flatMap(sample => sample.rawFrameIntervalsMs);
const phaseFrames = Object.fromEntries(['settle', 'dwell', 'endpoint-after-gc'].map(phase => [phase,
  frameSummary(samples.filter(sample => sample.phase === phase).flatMap(sample => sample.rawFrameIntervalsMs))]));
const observedFrameMs = samples.filter(sample => sample.phase === 'dwell').map(sample => sample.stats.frameMs);
const status = !failure && checks.every(item => item.pass) ? 'PASS' : 'FAIL';
const result = { status, scope: 'Native labelled drop-in residency soak. Simulation paused; renderer and stream updates remain active. This does not prove continuous gameplay frame rate.',
  url: url.href, identity, renderer, limits, requested: { cycles, dwellSeconds, durationSeconds }, completedCycles: lastCycle,
  measuredSeconds: (Date.now() - startedAt) / 1000, routeSeconds: routeStartedAt ? (Date.now() - routeStartedAt) / 1000 : 0,
  startupSeconds, route, availableLabels, baseline, rounds, checks, captures, traceFile, gcAvailable,
  frames: { total: frameCount, intervals: frameSummary(allFrameIntervals), phases: phaseFrames,
    renderCpuMs: { p50: percentile(observedFrameMs, .5), p95: percentile(observedFrameMs, .95),
      note: 'Native frameMs is an exponential moving average of CPU frame work; RAF intervals measure scheduling/presentation gaps.' } },
  network: { scope: 'Startup resource timings plus request/response events after adapter readiness; explicit identity reads use the API request client.',
    startup: networkAtReadiness, routeRequests: requests.length,
    visualRequests: requests.filter(request => /\.glb(?:\?|$)/i.test(request.url)).length,
    failedRequests, badResponses, requests },
  consoleErrors: session?.consoleErrors ?? [], consoleLines: session?.consoleLines ?? [], failure, samples,
  limitations: ['Drop-ins stress residency/disposal without claiming real keyboard traversal or vehicle reachability.',
    'Chromium retained JS heap excludes native renderer, decoded image storage, GPU driver and Rapier/WASM committed RAM.',
    'Renderer counts are allocation counts, not GPU byte measurements. Native texture/geometry estimates are also recorded.',
    'Images are CAPTURED_NOT_REVIEWED until opened. Software/SwiftShader rendering, if shown in GPU info, limits frame-rate conclusions.',
    'Abort cancellations are recorded separately and are allowed; HTTP errors and other request failures fail the harness.',
    'A duration target is a minimum; the harness completes the final full circuit before stopping.'] };
fs.writeFileSync(path.join(values.out, 'results.json'), JSON.stringify(result, null, 2) + '\n');
console.log(`${status}: ${rounds.length} fixture circuits, ${(result.measuredSeconds).toFixed(1)} seconds; ${values.out}`);
if (status !== 'PASS') process.exitCode = 1;
