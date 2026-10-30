// Configurable district acceptance. Real keyboard tours and labelled fixture
// circuits are separate evidence; neither changes the application or its budgets.
// node tools/verify/verify-district-expansion.mjs --release RELEASE --plan PLAN.json
//   --runtime-sha256 REVIEW_JS_SHA --out FRESH_DIR --preset low
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { game, openGame } from './lib/browser.ts';
import { captureOwnedBrowserMemory } from './lib/process-memory.ts';
import { beginTravelFrames, finishTravelFrames } from './lib/travel-frames.ts';
import { openPedestrianDetours, occupiedTargets, DETOUR_POLICY } from '../world/lib/walk-pedestrian-detour.mjs';

const { values } = parseArgs({ options: {
  url: { type: 'string', default: 'http://127.0.0.1:5317/' }, release: { type: 'string' },
  plan: { type: 'string' }, out: { type: 'string' }, preset: { type: 'string', default: 'low' },
  'runtime-sha256': { type: 'string' }, 'max-seconds': { type: 'string', default: '1800' },
  'walk-only': { type: 'boolean', default: false }, 'fixtures-only': { type: 'boolean', default: false },
  'plan-only': { type: 'boolean', default: false },
} });
for (const key of ['release', 'plan', 'out', 'runtime-sha256']) assert.ok(values[key], `--${key} is required`);
assert.match(values['runtime-sha256'], /^[a-f0-9]{64}$/, 'runtime SHA-256 must be lowercase hex');
assert.ok(['low', 'standard'].includes(values.preset), '--preset must be low or standard');
assert.ok(!(values['walk-only'] && values['fixtures-only']), 'Select at most one restricted mode');
const maxSeconds = Number(values['max-seconds']);
assert.ok(Number.isFinite(maxSeconds) && maxSeconds > 0 && maxSeconds <= 7200, '--max-seconds must be in (0, 7200]');
assert.ok(!fs.existsSync(values.out), 'Use a fresh evidence directory');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const manifestBytes = fs.readFileSync(path.join(values.release, 'manifest.json'));
const manifest = JSON.parse(manifestBytes), gameplayBytes = fs.readFileSync(path.join(values.release, manifest.gameplay.path));
assert.equal(sha(gameplayBytes), manifest.gameplay.sha256, 'Gameplay payload must match manifest');
const gameplay = JSON.parse(gameplayBytes), area = gameplay.playArea;
const planBytes = fs.readFileSync(values.plan), plan = JSON.parse(planBytes);
assert.equal(plan.schemaVersion, 1, 'Plan schemaVersion must be 1');
assert.ok(Array.isArray(plan.routes) && Array.isArray(plan.fixtures), 'Plan needs routes and fixtures arrays');
const validLabel = label => typeof label === 'string' && label.length > 0 && label.length <= 160;
const inArea = ([x, z]) => x >= area.minX && x <= area.maxX && z >= area.minZ && z <= area.maxZ;
const positive = (value, fallback) => value === undefined ? fallback : Number.isFinite(value) && value > 0 ? value : NaN;
const routeIds = new Set();
for (const route of plan.routes) {
  assert.ok(validLabel(route.id) && !routeIds.has(route.id), 'Route IDs must be unique bounded strings'); routeIds.add(route.id);
  assert.ok(Array.isArray(route.waypoints) && route.waypoints.length > 0, `Route ${route.id} needs waypoints`);
  for (const point of route.waypoints) {
    assert.ok(validLabel(point.label), 'Every waypoint needs a label');
    assert.ok(Array.isArray(point.xz) && point.xz.length === 2 && point.xz.every(Number.isFinite) && inArea(point.xz), `Unsupported waypoint ${point.label}`);
    assert.ok(Number.isFinite(positive(point.radius, 2)) && positive(point.radius, 2) <= 6, 'Waypoint radius must be in (0, 6]');
    assert.ok(Number.isFinite(positive(point.timeoutSeconds, 120)) && positive(point.timeoutSeconds, 120) <= 600, 'Waypoint timeout must be in (0, 600]');
    for (const key of ['yaw', 'pitch']) assert.ok(point[key] === undefined || Number.isFinite(point[key]), `Invalid ${key}`);
  }
}
const dropIns = new Set([...gameplay.landmarks, ...gameplay.addresses].map(point => point.label));
for (const stop of plan.fixtures) {
  assert.ok(validLabel(stop.label) && dropIns.has(stop.label), `Unknown fixture drop-in ${stop.label}`);
  assert.ok(Number.isFinite(stop.yaw) && (stop.pitch === undefined || Number.isFinite(stop.pitch)), 'Fixture needs finite heading');
}
function verifyDetourProducer() { if (!plan.pedestrianDetours) return; assert.deepEqual(plan.pedestrianDetours.policy, DETOUR_POLICY); for (const closure of plan.pedestrianDetours.producerClosure) for (const [file, expected] of Object.entries(closure.files)) assert.equal(sha(fs.readFileSync(file)), expected, `Pedestrian detour producer changed: ${file}`); }
verifyDetourProducer();
const runWalk = !values['fixtures-only'], runFixtures = !values['walk-only'];
assert.ok(!runWalk || plan.routes.length > 0, 'Walking mode needs a route');
assert.ok(!runFixtures || plan.fixtures.length > 1, 'Fixture mode needs at least two stops, ending at a repeatable return');
fs.mkdirSync(values.out, { recursive: true });
const binding = { release: manifest.worldReleaseId, manifestSha256: sha(manifestBytes), gameplaySha256: sha(gameplayBytes),
  planPath: values.plan, planSha256: sha(planBytes), harnessSha256: sha(fs.readFileSync(new URL(import.meta.url))),
  browserHelperSha256: sha(fs.readFileSync(new URL('./lib/browser.ts', import.meta.url))),
  processMemoryHelperSha256: sha(fs.readFileSync(new URL('./lib/process-memory.ts', import.meta.url))),
  expectedRuntimeSha256: values['runtime-sha256'], preset: values.preset,
  mode: values['walk-only'] ? 'walk-only' : values['fixtures-only'] ? 'fixtures-only' : 'walk-and-fixtures' };
if (values['plan-only']) {
  fs.writeFileSync(path.join(values.out, 'plan.json'), JSON.stringify({ status: 'PLANNED_NOT_PLAYED', ...binding, plan }, null, 2) + '\n');
  console.log(`PLANNED_NOT_PLAYED: ${plan.routes.length} routes, ${plan.fixtures.length} fixture stops`);
  process.exit(0);
}

const low = values.preset === 'low';
const limits = { totalTextureMiB: low ? 160 : 320, detailCells: low ? 16 : 28, fallbackCells: low ? 28 : 42,
  detailGeometryMiB: low ? 96 : 160, fallbackGeometryMiB: low ? 64 : 96,
  triangles: low ? 500000 : 1200000, drawCalls: low ? 350 : 600 };
const checks = [], samples = [], checkpoints = [], routes = [], fixtureRounds = [], captures = [], pedestrianDetours = [];
let pedestrianPlanner;
const held = new Set(), t0 = Date.now();
let session, page, failure = null, failureView = null, startup = null, runtimeUrl = null, runtimeSha256 = null, documentId = null;
let lastSample = 0, lastTick = null, lastTickAt = Date.now(), lastWorldPosition = null, walkedMetres = 0;
let travelFramesStarted = false, travelFramesFinished = false;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function check(id, pass, detail) { checks.push({ id, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${id}: ${JSON.stringify(detail)}`); }
function timeGuard() { assert.ok((Date.now() - t0) / 1000 <= maxSeconds, `Overall ${maxSeconds}s limit exceeded`); }
async function key(code, down) {
  if (down && !held.has(code)) { held.add(code); await page.keyboard.down(code); }
  if (!down && held.has(code)) { held.delete(code); await page.keyboard.up(code); }
}
async function releaseKeys() { for (const code of [...held]) await key(code, false); }
async function recordTravelFrames() {
  if (!travelFramesStarted || travelFramesFinished) return;
  const frames = await finishTravelFrames(page);
  travelFramesFinished = true;
  fs.writeFileSync(path.join(values.out, 'travel-frames.json'), JSON.stringify({ ...frames,
    scope: 'Real walking phase only; paused drop-in fixtures excluded',
    helperSha256: sha(fs.readFileSync(new URL('./lib/travel-frames.ts', import.meta.url))) }, null, 2) + '\n');
  if (frames.status !== 'CAPTURED') failure ??= 'Incomplete travel frame metrics';
}
async function inspect() {
  return page.evaluate(() => {
    const api = window.__HELSINKI_GAME__, state = api.state();
    return { tick: state.tick, player: state.player, stats: api.stats(), stream: api.streaming(), textures: api.textureMemory(),
      heapBytes: performance.memory?.usedJSHeapSize ?? null, scheduling: window.__districtTiming ?? null };
  });
}
function assertResources(data) {
  assert.ok(data.stream, 'Expanded candidate must use visual streaming');
  const { detail, fallback } = data.stream;
  assert.equal(data.stream.totalTextureBudgetMiB, limits.totalTextureMiB, 'Accepted texture cap changed');
  assert.ok(data.textures.mib <= limits.totalTextureMiB + .01, `Scene textures ${data.textures.mib} MiB exceed cap`);
  const retained = detail.residentTextureMiB + fallback.residentTextureMiB + data.stream.persistentTextureMiB;
  assert.ok(retained <= limits.totalTextureMiB + .01, `Retained textures ${retained} MiB exceed cap`);
  assert.ok(detail.residentTextureMiB <= detail.textureBudgetMiB + .01 && fallback.residentTextureMiB <= fallback.textureBudgetMiB + .01, 'Tier texture cap exceeded');
  assert.ok(detail.residentCells <= limits.detailCells && fallback.residentCells <= limits.fallbackCells, 'Accepted resident cell cap exceeded');
  assert.ok(detail.residentGeometryMiB <= limits.detailGeometryMiB + .01 && fallback.residentGeometryMiB <= limits.fallbackGeometryMiB + .01, 'Accepted geometry cap exceeded');
  assert.deepEqual([...detail.errors, ...fallback.errors], [], 'Current visual load failure');
}
async function sample(label, force = false) {
  timeGuard();
  if (!force && Date.now() - lastSample < 500) return null;
  lastSample = Date.now(); const data = await inspect(); assertResources(data);
  samples.push({ label, seconds: (Date.now() - t0) / 1000, ...data }); return data;
}
async function settleView() {
  await page.evaluate(() => new Promise((resolve, reject) => {
    let previous = performance.now(), renderedMs = 0, frames = 0;
    const timeout = setTimeout(() => reject(new Error('Rendered view did not settle in20s')), 20000);
    const frame = now => { renderedMs += Math.min(100, Math.max(0, now - previous)); previous = now; frames++;
      if (renderedMs >= 300 && frames >= 4) { clearTimeout(timeout); resolve(); } else requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
  }));
}
async function capture(label, kind, yaw, pitch = -.1) {
  if (yaw !== undefined) await game.setCamera(page, yaw, pitch);
  await page.evaluate(() => window.__HELSINKI_GAME__.awaitVisuals()); await settleView();
  const file = `${String(captures.length).padStart(3, '0')}-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`;
  await page.screenshot({ path: path.join(values.out, file) });
  const data = await sample(`capture:${label}`, true);
  captures.push({ label, kind, file, tick: data.tick, position: data.player.position, review: 'CAPTURED_NOT_REVIEWED' });
}
function assertWalkingState(state) {
  const { player } = state;
  assert.ok(player.alive && player.mode === 'onFoot' && !player.inVehicle, 'Walking tour left the live on-foot state');
  assert.ok(player.position.every(Number.isFinite) && inArea([player.position[0], player.position[2]]), 'Walking tour left supported bounds');
  assert.ok(!state.events.some(event => ['killPlane', 'wasted', 'busted'].includes(event.type)), 'Walking tour used death/fall recovery');
  if (lastTick !== state.tick) { lastTick = state.tick; lastTickAt = Date.now(); }
  assert.ok(Date.now() - lastTickAt < 30000, 'Simulation made no progress for30s');
  if (lastWorldPosition) walkedMetres += Math.hypot(player.position[0] - lastWorldPosition[0], player.position[2] - lastWorldPosition[2]);
  lastWorldPosition = [...player.position];
}

try {
  const url = new URL(values.url); url.searchParams.set('release', manifest.worldReleaseId); url.searchParams.set('review', '1'); url.searchParams.set('preset', values.preset);
  const openedAt = Date.now(); session = await openGame(url.href, { timeoutMs: 240000 }); page = session.page;
  const secondsToReady = (Date.now() - openedAt) / 1000;
  runtimeUrl = await page.locator('script[type="module"][src]').first().getAttribute('src'); assert.ok(runtimeUrl, 'Missing runtime module');
  runtimeSha256 = await session.loadedResponseSha256(new URL(runtimeUrl, url).href);
  assert.equal(runtimeSha256, values['runtime-sha256'], 'Wrong candidate runtime');
  assert.equal(await game.release(page), manifest.worldReleaseId, 'Wrong candidate release');
  const manifestUrls = await page.evaluate(release => [...new Set(performance.getEntriesByType('resource').map(entry => entry.name).filter(name => new URL(name).pathname.endsWith(`/${release}/manifest.json`)))], manifest.worldReleaseId);
  assert.equal(manifestUrls.length, 1, 'Exactly one loaded candidate manifest is required');
  assert.equal(await session.loadedResponseSha256(manifestUrls[0]), sha(manifestBytes), 'Loaded world differs from verified local manifest');
  documentId = await page.evaluate(() => performance.timeOrigin);
  await page.evaluate(() => {
    const timing = window.__districtTiming = { frames: 0, maximumFrameGapMs: 0, gapsOver100Ms: 0, longTaskCount: 0, longTaskMs: 0, lastFrameAt: performance.now() };
    function frame(now) { const gap = now - timing.lastFrameAt; timing.lastFrameAt = now; timing.frames++; timing.maximumFrameGapMs = Math.max(timing.maximumFrameGapMs, gap); if (gap > 100) timing.gapsOver100Ms++; requestAnimationFrame(frame); }
    requestAnimationFrame(frame);
    if (PerformanceObserver.supportedEntryTypes.includes('longtask')) new PerformanceObserver(entries => { for (const task of entries.getEntries()) { timing.longTaskCount++; timing.longTaskMs += task.duration; } }).observe({ type: 'longtask' });
  });
  await game.start(page); await page.evaluate(() => window.__HELSINKI_GAME__.awaitVisuals()); await settleView();
  if (runWalk) { await beginTravelFrames(page); travelFramesStarted = true; }
  else fs.writeFileSync(path.join(values.out, 'travel-frames.json'), JSON.stringify({
    status: 'NOT_RUN', reason: 'Fixture-only mode does not measure moving travel frames',
  }, null, 2) + '\n');
  const first = await sample('startup', true);
  startup = { secondsToReady, secondsToStartedAndSettled: (Date.now() - openedAt) / 1000, heapBytes: first.heapBytes,
    ownedBrowserMemory: await captureOwnedBrowserMemory(session.browser),
    collisionPayloadBytes: manifest.cells.reduce((sum, cell) => sum + cell.collision.bytes, 0), terrainPayloadBytes: manifest.terrain.bytes,
    network: await page.evaluate(({release,collisionPaths}) => { const collision = new Set(collisionPaths), resources = performance.getEntriesByType('resource').filter(entry => entry.name.includes(`/world/${release}/`));
      return { worldRequests: resources.length, encodedBytes: resources.reduce((sum, entry) => sum + entry.encodedBodySize, 0),
        transferredBytes: resources.reduce((sum, entry) => sum + entry.transferSize, 0), collisionRequests: resources.filter(entry => collision.has(new URL(entry.name).pathname)).length }; }, {release:manifest.worldReleaseId,collisionPaths:manifest.cells.map(cell=>new URL(cell.collision.path,new URL(`world/${manifest.worldReleaseId}/`,values.url)).pathname)}),
    limitation: 'Readiness includes all resident static collision construction. Payload bytes and Chromium JS heap do not measure total Rapier/WASM or browser RAM.' };
  check('candidate-identity', true, { release: manifest.worldReleaseId, runtimeUrl, runtimeSha256 });
  check('bounded-startup', first.stream.detail.residentCells < manifest.cells.length && first.stream.fallback.residentCells < manifest.cells.length,
    { totalCells: manifest.cells.length, detail: first.stream.detail.residentCells, fallback: first.stream.fallback.residentCells, ...startup });
  await capture('senate-start', 'startup-view');
  if (runWalk) for (const route of plan.routes) {
    const began = await game.state(page), startMetres = walkedMetres, routeStart = Date.now(), points = [];
    lastWorldPosition = [...began.player.position]; lastTick = began.tick; lastTickAt = Date.now();
    const liveWaypoints = [...route.waypoints];
    for (let waypointIndex = 0; waypointIndex < liveWaypoints.length; waypointIndex++) {
      const waypoint = liveWaypoints[waypointIndex];
      const pointStart = Date.now(); let state, arrived = false, rerouted = false, progressAt = Date.now(), bestRemaining = Infinity, attemptedAt = 0;
      while ((Date.now() - pointStart) / 1000 < (waypoint.timeoutSeconds ?? 120)) {
        timeGuard(); state = await game.state(page); assertWalkingState(state);
        const p = state.player.position, remaining = Math.hypot(p[0] - waypoint.xz[0], p[2] - waypoint.xz[1]);
        if (remaining <= (waypoint.radius ?? 2)) { arrived = true; break; }
        if (remaining < bestRemaining - .02) { bestRemaining = remaining; progressAt = Date.now(); }
        if (plan.pedestrianDetours && Date.now() - progressAt >= 2000 && Date.now() - attemptedAt >= 5000 && occupiedTargets(state, liveWaypoints.slice(waypointIndex))) {
          await releaseKeys(); attemptedAt = Date.now();
          assert.ok(pedestrianDetours.length < DETOUR_POLICY.maximumDetours, 'Bounded pedestrian detour limit exceeded');
          pedestrianPlanner ??= await openPedestrianDetours(values.release, plan.pedestrianDetours);
          const observed = await game.state(page), proposal = await pedestrianPlanner.plan(observed, liveWaypoints.slice(waypointIndex));
          if (proposal) {
            const file = `pedestrian-detour-${String(pedestrianDetours.length + 1).padStart(2, '0')}.json`;
            const proof = { route: route.id, originalWaypointIndex: waypointIndex, ...proposal };
            fs.writeFileSync(path.join(values.out, file), JSON.stringify(proof, null, 2) + '\n');
            pedestrianDetours.push({ file, sha256: sha(fs.readFileSync(path.join(values.out, file))), status: proposal.status, replaced: proposal.replaced ?? [] });
            if (proposal.status === 'SOURCE_STATIC_PARKING_AND_CAPTURED_CHARACTER_DETOUR_QUALIFIED_REAL_KEYBOARD_PENDING') {
              liveWaypoints.splice(waypointIndex, proposal.replaceCount, ...proposal.waypoints);
              rerouted = true; waypointIndex--; break;
            }
          }
        }
        await game.setCamera(page, Math.atan2(waypoint.xz[0] - p[0], waypoint.xz[1] - p[2]), -.12);
        // Native keyboard speeds only: release sprint near a turn, then use Alt walking for precise
        // source-path targets. At 6 m/s one 60 ms observation already spans a 0.18 m target radius.
        await key('ShiftLeft', remaining > 3);
        await key('AltLeft', remaining <= 1 && (waypoint.radius ?? 2) < .5);
        await key('KeyW', true);
        await sample(`walk:${route.id}:${waypoint.label}`); await wait(60);
      }
      await releaseKeys(); if (rerouted) continue; assert.ok(arrived, `Did not reach ${route.id}/${waypoint.label}; last position ${state?.player.position}`);
      const record = { label: waypoint.label, target: waypoint.xz, position: state.player.position, tick: state.tick, seconds: (Date.now() - pointStart) / 1000 };
      points.push(record); checkpoints.push({ route: route.id, ...record });
      check(`walk:${route.id}:${waypoint.label}`, true, record);
      if (waypoint.capture) await capture(`${route.id}-${waypoint.label}`, 'real-keyboard-waypoint', waypoint.yaw, waypoint.pitch ?? -.1);
    }
    const ended = await game.state(page), badEvents = (await game.events(page, began.tick)).filter(event => ['killPlane', 'wasted', 'busted'].includes(event.type));
    assert.deepEqual(badEvents, [], 'Route contained death/fall recovery');
    assert.equal(await page.evaluate(() => performance.timeOrigin), documentId, 'Tour reloaded document');
    const result = { id: route.id, startTick: began.tick, endTick: ended.tick, seconds: (Date.now() - routeStart) / 1000,
      walkedMetres: walkedMetres - startMetres, waypoints: points, start: began.player.position, end: ended.player.position,
      forbiddenEvents: badEvents, controls: 'Real KeyW, ShiftLeft sprint when more than 3m away, and AltLeft walk within 1m of tight targets; native camera heading only. No teleport, reset, drop-in, forced step or scripted commands.' };
    routes.push(result); check(`tour:${route.id}`, true, { ticks: ended.tick - began.tick, seconds: result.seconds, metres: result.walkedMetres });
  }
  await recordTravelFrames();
  if (runFixtures) {
    await game.pause(page);
    for (let round = 0; round < 2; round++) {
      const stops = [];
      for (const stop of plan.fixtures) {
        timeGuard(); await game.dropIn(page, stop.label); await page.evaluate(() => window.__HELSINKI_GAME__.render());
        await page.evaluate(() => window.__HELSINKI_GAME__.awaitVisuals()); await page.evaluate(() => window.__HELSINKI_GAME__.render());
        const views = [];
        for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
          await game.setCamera(page, yaw, stop.pitch ?? -.1); await settleView();
          const data = await sample(`fixture:${round}:${stop.label}:${yaw}`, true);
          assert.ok(data.stats.triangles <= limits.triangles, `${stop.label} submitted ${data.stats.triangles} triangles`);
          assert.ok(data.stats.drawCalls <= limits.drawCalls, `${stop.label} submitted ${data.stats.drawCalls} calls`);
          views.push({ yaw, stats: data.stats, textures: data.textures, heapBytes: data.heapBytes });
        }
        await game.setCamera(page, stop.yaw, stop.pitch ?? -.1); await settleView();
        const data = await sample(`fixture-return:${round}:${stop.label}`, true);
        assert.equal(data.stream.coverage.missingCells.length, 0, 'Fixture lacks nearby ground');
        assert.equal(data.stream.fallback.pendingCells, 0, 'Fixture distant tier not settled');
        assert.equal(data.stream.fallback.missingNearDetail.length, 0, 'Fixture distant tier lacks a near owner');
        const result = { label: stop.label, views, tick: data.tick, position: data.player.position, stats: data.stats, textures: data.textures, stream: data.stream, heapBytes: data.heapBytes,
          ownedBrowserMemory: await captureOwnedBrowserMemory(session.browser) };
        stops.push(result); check(`fixture:${round}:${stop.label}`, true, { texturesMiB: data.textures.mib, detail: data.stream.detail.residentCells, fallback: data.stream.fallback.residentCells });
        if (round === 0) await capture(stop.label, 'labelled-drop-in-fixture', stop.yaw, stop.pitch ?? -.1);
      }
      fixtureRounds.push({ round, stops });
    }
    const returns = fixtureRounds.map(round => round.stops.at(-1));
    check('stable-return-textures', Math.abs(returns[1].textures.mib - returns[0].textures.mib) < 3, returns.map(stop => stop.textures.mib));
    check('stable-return-gpu-allocations', Math.abs(returns[1].stats.textures - returns[0].stats.textures) <= 2 && Math.abs(returns[1].stats.geometries - returns[0].stats.geometries) <= 5,
      returns.map(stop => ({ textures: stop.stats.textures, geometries: stop.stats.geometries })));
    const last = await sample('final', true);
    check('detail-and-fallback-evicted', last.stream.detail.evicted > 0 && last.stream.fallback.evicted > 0,
      { detail: last.stream.detail.evicted, fallback: last.stream.fallback.evicted });
  }
  check('single-document', await page.evaluate(() => performance.timeOrigin) === documentId, documentId);
  check('browser-errors', session.consoleErrors.length === 0, session.consoleErrors);
} catch (error) {
  failure = String(error.stack ?? error); check('harness', false, failure);
  if (page) failureView = await page.evaluate(() => {
    const api = window.__HELSINKI_GAME__;
    return api ? { state: api.state(), presentation: api.presentation(), stream: api.streaming(), breakdown: api.renderBreakdown() } : null;
  }).catch(error => ({ diagnosticError: String(error) }));
  if (page) await page.screenshot({ path: path.join(values.out, 'failure.png') }).catch(() => {});
} finally {
  if (page) await releaseKeys().catch(() => {});
  if (page) try { await recordTravelFrames(); }
  catch (error) { failure ??= `Travel frame metrics failed: ${String(error)}`; }
  if (session) await session.close();
  if (pedestrianPlanner) { try { pedestrianPlanner.verify(); verifyDetourProducer(); } catch (error) { failure ??= String(error); } finally { pedestrianPlanner.close(); } }
}
const heaps = samples.map(sample => sample.heapBytes).filter(Number.isFinite);
const summary = { status: checks.every(item => item.pass) && !failure ? 'PASS' : 'FAIL', ...binding, runtimeUrl, runtimeSha256,
  angle: process.env.HELSINKI_VERIFY_ANGLE ?? 'd3d11', browser: session?.browser.version(), viewport: { width: 1280, height: 720 },
  seconds: (Date.now() - t0) / 1000, limits, startup, checks, routes, checkpoints, fixtureRounds, captures, samples, pedestrianDetours,
  peaks: { texturesMiB: Math.max(0, ...samples.map(sample => sample.textures.mib)),
    detailGeometryMiB: Math.max(0, ...samples.map(sample => sample.stream.detail.residentGeometryMiB)),
    fallbackGeometryMiB: Math.max(0, ...samples.map(sample => sample.stream.fallback.residentGeometryMiB)),
    heapMiB: heaps.length ? Math.max(...heaps) / 2 ** 20 : null, heapMinimumMiB: heaps.length ? Math.min(...heaps) / 2 ** 20 : null },
  consoleErrors: session?.consoleErrors ?? [], failure, failureView,
  limitations: ['Only routes marked real-keyboard-waypoint establish continuous walking reachability; drop-ins are residency and view fixtures.',
    'Images remain CAPTURED_NOT_REVIEWED until opened and recorded separately.',
    'Chromium JS heap, encoded payload bytes and retained graphics estimates do not measure total browser/Rapier RAM.',
    'These walking routes do not prove vehicle road legality, driving support or deterministic replay; use the native drive/world gates separately.'] };
fs.writeFileSync(path.join(values.out, 'results.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(`${summary.status}: ${checks.filter(item => item.pass).length}/${checks.length} district checks, ${values.out}`);
if (summary.status !== 'PASS') process.exitCode = 1;
