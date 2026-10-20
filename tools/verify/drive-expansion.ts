// Senate -> Kluuvi/Stockmann -> Esplanadi -> Senate, using actual keyboard controls and one browser document.
// Only the native camera hook is used for headless look direction; no teleport, reset, forced step or scripted command.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { decodeCommand, initPhysics, Simulation, StaticWorld, type EncodedCommand, type SimState } from '../../packages/sim/src/index.ts';
import { RoadIndex, type GameplayBundle, type RoadGraph, type WorldManifest, type Vec3, type LaneHit } from '../../packages/world-schema/src/index.ts';
import type { HelsinkiTestApi } from '../../apps/game/src/testapi.ts';
import { game, openGame } from './lib/browser.ts';
import { clippedRoutePoints, planDriveLeg, type DriveGoal } from './lib/keyboard-route.ts';
import { keyboardDriveControl } from './lib/keyboard-driving.ts';
import { buildDrivingRouteHints, previewDrivingRoute, type DrivingRouteHints } from './lib/driving-route-preview.ts';
import { readSimulationPayload } from './lib/simulation-payload.ts';

const { values } = parseArgs({ options: { url: { type: 'string', default: 'http://127.0.0.1:5317/?review=1' }, release: { type: 'string' }, out: { type: 'string' }, goals: { type: 'string' }, headful: { type: 'boolean', default: false }, 'max-seconds': { type: 'string', default: '600' }, 'max-recoveries': { type: 'string', default: '2' }, 'max-speed': { type: 'string', default: '10' }, 'plan-only': { type: 'boolean', default: false } } });
assert.ok(values.release && values.out, '--release and --out required'); assert.ok(!existsSync(values.out), 'Use a fresh evidence directory'); mkdirSync(values.out, { recursive: true });
const releaseDir = values.release, out = values.out, sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const manifestBytes = readFileSync(path.join(releaseDir, 'manifest.json')), manifest = JSON.parse(manifestBytes.toString()) as WorldManifest;
const readPayload = (p: { path: string; sha256: string }) => { const b = readFileSync(path.join(releaseDir, p.path)); assert.equal(sha(b), p.sha256); return b; };
const roads = JSON.parse(readPayload(manifest.roads).toString()) as RoadGraph, gameplay = JSON.parse(readPayload(manifest.gameplay).toString()) as GameplayBundle, index = new RoadIndex(roads);
const terrain = await readSimulationPayload(releaseDir, manifest.terrain);
const collisionFiles = await Promise.all(manifest.cells.map(async c => [c.id, await readSimulationPayload(releaseDir, c.collision)] as const));
const startHit = index.nearestLane(-69, 42, [0, 1], 10), returnHit = index.nearestLane(-75, -25, [0, 1], 10); assert.ok(startHit && returnHit);
const defaultGoals: DriveGoal[] = [
  { label: 'Kluuvi Aleksanterinkatu', xz: [-320, 64], road: 'Aleksanterinkatu' },
  { label: 'Stockmann eastern frontage', xz: [-530, 73], road: 'Aleksanterinkatu' },
  { label: 'Esplanadi', xz: [-417, 277], road: 'Eteläesplanadi' },
  { label: 'Senate Square return', xz: [-75, -25], road: 'Unioninkatu', radius: 8 },
];
let goals = defaultGoals, goalsSha256: string | null = null, requiredWayIds: number[] = [];
if (values.goals) {
  const goalBytes = readFileSync(values.goals), specification = JSON.parse(goalBytes.toString()) as { schemaVersion?: number; goals?: DriveGoal[]; requiredWayIds?: number[] };
  assert.ok(specification.schemaVersion === undefined || specification.schemaVersion === 1, 'Goals schemaVersion must be1');
  assert.ok(Array.isArray(specification.goals) && specification.goals.length > 0 && specification.goals.length <= 32, 'Goals must contain1–32 destinations');
  for (const goal of specification.goals) {
    assert.ok(goal && typeof goal.label === 'string' && goal.label.length > 0 && goal.label.length <= 160 && typeof goal.road === 'string' && goal.road.length > 0 && goal.road.length <= 160, 'Every goal needs a bounded label and exact road name');
    assert.ok(Array.isArray(goal.xz) && goal.xz.length === 2 && goal.xz.every(Number.isFinite), 'Goal coordinates must be finite XZ');
    assert.ok(goal.radius === undefined || (Number.isFinite(goal.radius) && goal.radius > 0 && goal.radius <= 100), 'Goal radius must be in (0,100]');
  }
  if (specification.requiredWayIds !== undefined) assert.ok(Array.isArray(specification.requiredWayIds) && specification.requiredWayIds.length <= 100 && specification.requiredWayIds.every(id => Number.isSafeInteger(id) && id > 0), 'Required source way IDs must be positive integers');
  goals = specification.goals; goalsSha256 = sha(goalBytes); requiredWayIds = specification.requiredWayIds ?? [];
}
let plannedFrom = startHit;
const legs = goals.map(goal => { const leg = planDriveLeg(index, plannedFrom, goal, returnHit, gameplay.playArea); plannedFrom = leg.target; return leg; });
assert.ok(Math.hypot(legs.at(-1)!.target.point[0] - returnHit.point[0], legs.at(-1)!.target.point[2] - returnHit.point[2]) <= 12, 'A drive loop must finish at the supported Senate Square return road');
const plannedWayIds = new Set(legs.flatMap(leg => leg.route.flatMap(id => { const lane = index.laneById.get(id); return lane ? [lane.wayId] : []; })));
for (const id of requiredWayIds) assert.ok(plannedWayIds.has(id), `Planned road loop does not traverse required source way${id}`);
const plan = { release: manifest.worldReleaseId, manifestSha256: sha(manifestBytes), goalsPath: values.goals ?? null, goalsSha256, requiredWayIds, requiredWaysAre: 'Planned source-way membership; actual controls and recorded positions establish traversal separately.', approach: startHit, legs, totalRoadMetres: legs.reduce((s, l) => s + l.length, 0), stationLimit: values.goals ? null : 'No legal directed station-frontage return inside current bounds: OSM only_straight_on relations53473 and30402 require detours outside west/north boundaries. This journey proves the bounded Kluuvi/Stockmann/Esplanadi loop; railway station access is separate walking evidence.' };
writeFileSync(path.join(out, 'route-plan.json'), JSON.stringify(plan, null, 2) + '\n');
if (values['plan-only']) { console.log(JSON.stringify({ status: 'PLANNED_NOT_PLAYED', metres: plan.totalRoadMetres, legs: legs.map(l => ({ label: l.goal.label, metres: l.length, roads: l.roadNames })) })); process.exit(0); }
await initPhysics();
const heightWorld = StaticWorld.fromBytes(terrain, roads, gameplay); for (const [id, bytes] of collisionFiles) heightWorld.addCell(id, bytes); heightWorld.physics.step();
const session = await openGame(values.url, { headful: values.headful, timeoutMs: 240000 });
const page = session.page, held = new Set<string>(), timeline: string[] = [], samples: unknown[] = [], checkpoints: unknown[] = [], recoveries: unknown[] = [], t0 = Date.now();
const runtimeUrl = await page.locator('script[type="module"][src]').first().getAttribute('src');
assert.ok(runtimeUrl, 'Missing runtime module');
const runtimeSha256 = sha(await (await page.request.get(new URL(runtimeUrl, values.url).href)).body());
// Observe scheduling independently of the game's capped frame delta. This never drives ticks or changes
// browser focus/visibility: a stalled rAF can otherwise look like slow driving despite cheap render frames.
await page.evaluate(() => {
  const w = window as unknown as { __driveTiming: { started: number; frames: number; maxGapMs: number; gapCount: number;
    gaps: unknown[]; timerGaps: unknown[]; visibility: unknown[] } };
  const timing: typeof w.__driveTiming = { started: performance.now(), frames: 0, maxGapMs: 0, gapCount: 0, gaps: [], timerGaps: [], visibility: [] };
  w.__driveTiming = timing;
  let lastFrame = performance.now(), lastTimer = lastFrame;
  const state = () => ({ now: performance.now(), wall: Date.now(), visibility: document.visibilityState,
    focused: document.hasFocus(), tick: window.__HELSINKI_GAME__!.tick(), stats: window.__HELSINKI_GAME__!.stats() });
  const frame = (now: number) => {
    const gapMs = now - lastFrame; lastFrame = now; timing.frames++; timing.maxGapMs = Math.max(timing.maxGapMs, gapMs);
    if (gapMs > 100) { timing.gapCount++; timing.gaps.push({ gapMs, ...state() }); if (timing.gaps.length > 512) timing.gaps.shift(); }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  setInterval(() => { const now = performance.now(), gapMs = now - lastTimer; lastTimer = now;
    if (gapMs > 500) { timing.timerGaps.push({ gapMs, ...state() }); if (timing.timerGaps.length > 512) timing.timerGaps.shift(); }
  }, 250);
  document.addEventListener('visibilitychange', () => timing.visibility.push(state()));
});
const maxSeconds = Number(values['max-seconds']), maxRecoveries = Number(values['max-recoveries']), maxSpeed = Number(values['max-speed']);
let lastSample = 0, lastTick = -1, lastProgress = Date.now(), seed = 0, failure: string | null = null, replayHash: string | null = null, browserClosed = false;
const note = (message: string) => { const line = `${((Date.now() - t0) / 1000).toFixed(1)}s ${message}`; timeline.push(line); console.log(line); };
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const distance = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[2]! - b[2]!);
const yawOf = (q: readonly number[]) => Math.atan2(2 * (q[0]! * q[2]! + q[3]! * q[1]!), 1 - 2 * (q[0]! * q[0]! + q[1]! * q[1]!));
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
async function key(code: string, down: boolean) { if (down && !held.has(code)) { held.add(code); await page.keyboard.down(code); } else if (!down && held.has(code)) { held.delete(code); await page.keyboard.up(code); } }
async function releaseKeys() { for (const code of [...held]) await key(code, false); }
const carOf = (s: SimState) => s.vehicles.find(v => v.id === s.player.inVehicle);
async function inspect(s: SimState, force = false) {
  assert.ok((Date.now() - t0) / 1000 <= maxSeconds, `Journey exceeded ${maxSeconds}s`);
  assert.ok(s.player.alive && s.player.mode !== 'wasted' && s.player.mode !== 'busted', 'Player died or was arrested during traversal');
  assert.ok(s.player.position.every(Number.isFinite));
  assert.ok(!s.events.some(e => e.type === 'killPlane'), 'Fall recovery occurred');
  if (s.tick !== lastTick) { lastTick = s.tick; lastProgress = Date.now(); }
  assert.ok(Date.now() - lastProgress < 30000, 'Simulation made no progress for30s');
  if (!force && Date.now() - lastSample < 1000) return; lastSample = Date.now();
  const snapshot = await page.evaluate(() => { const g = window.__HELSINKI_GAME__!, timing = (window as unknown as { __driveTiming: { frames: number; maxGapMs: number; gapCount: number } }).__driveTiming;
    return { stats: g.stats(), streaming: g.streaming(), memory: g.textureMemory(), scheduling: { now: performance.now(), wall: Date.now(), frames: timing.frames,
      maxGapMs: timing.maxGapMs, gapCount: timing.gapCount, visibility: document.visibilityState, focused: document.hasFocus() } }; });
  const p = s.player.position, area = gameplay.playArea; assert.ok(p[0] >= area.minX && p[0] <= area.maxX && p[2] >= area.minZ && p[2] <= area.maxZ, 'Player outside supported map');
  const support = heightWorld.groundBelow(p[0], p[1] + .3, p[2], 12), feetClearance = support ? p[1] - support.y : null;
  if (s.player.mode === 'onFoot') assert.ok(feetClearance !== null && feetClearance > -.3 && feetClearance < 2.5, `Unsupported on-foot position; feet clearance${feetClearance}`);
  const vehicle = carOf(s), vehicleSupport = vehicle ? heightWorld.groundBelow(vehicle.position[0], vehicle.position[1] + .7, vehicle.position[2], 20) : null;
  const chassisClearance = vehicle && vehicleSupport ? vehicle.position[1] - vehicleSupport.y : null;
  if (vehicle) assert.ok(chassisClearance !== null && chassisClearance > -.7 && chassisClearance < 8, `Car has no reasonable ground support; clearance${chassisClearance}`);
  if (snapshot.streaming) {
    const st = snapshot.streaming; assert.deepEqual([...st.detail.errors, ...st.fallback.errors], [], 'Streaming load failed');
    assert.ok(snapshot.memory.mib <= st.totalTextureBudgetMiB + .15, `Texture memory${snapshot.memory.mib} exceeds${st.totalTextureBudgetMiB}`);
    assert.ok(st.detail.residentTextureMiB <= st.detail.textureBudgetMiB + .01);
    if (st.detail.geometryBudgetMiB !== null) assert.ok(st.detail.residentGeometryMiB <= st.detail.geometryBudgetMiB + .01);
  }
  samples.push({ tick: s.tick, seconds: (Date.now() - t0) / 1000, position: p, mode: s.player.mode, car: vehicle?.position ?? null, feetClearance, surface: support?.surface, chassisClearance, vehicleSurface: vehicleSupport?.surface, terrainHeight: heightWorld.groundHeight(p[0], p[2]), ...snapshot });
}
async function until(label: string, timeout: number, act: (s: SimState) => Promise<void>, done: (s: SimState) => boolean, pollMs = 60) {
  const deadline = Date.now() + timeout * 1000; let s = await game.state(page);
  while (!done(s)) { assert.ok(Date.now() < deadline, `${label} not reached within${timeout}s`); await inspect(s); await act(s); await wait(pollMs); s = await game.state(page); }
  await inspect(s, true); return s;
}
async function capture(label: string, s: SimState) {
  await page.evaluate(() => window.__HELSINKI_GAME__!.awaitVisuals()); await wait(250);
  const file = label.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.png'; await page.screenshot({ path: path.join(out, file) }); checkpoints.push({ label, file, tick: s.tick, player: s.player.position, car: carOf(s)?.position }); note(`Reached ${label}`);
}
async function stopCar() { await releaseKeys(); await key('Space', true); const s = await until('braking', 10, async st => { const car = carOf(st); await key('KeyS', !!car && car.forwardSpeed > .5); }, st => !!carOf(st) && carOf(st)!.speed < .35); await key('KeyS', false); return s; }
async function drive(target: LaneHit, label: string, direct = false) {
  await releaseKeys(); let points: Vec3[] = [], progress = 0, lastLog = 0, lastMoved = Date.now(), lastPosition: readonly number[] | null = null;
  let routeHints: DrivingRouteHints | null = null;
  let previousYaw: number | null = null, previousControlTick = 0;
  const replan = (s: SimState) => { const car = carOf(s)!; if (direct) { points = [[...car.position], target.point]; progress = 0; return; }
    const yaw = yawOf(car.rotation), from = index.nearestLane(car.position[0], car.position[2], [Math.sin(yaw), Math.cos(yaw)], 30); assert.ok(from, 'Car left mapped roads');
    const route = index.route(from.laneId, from.s, target.laneId, target.s); assert.ok(route, `No directed route after movement to${label}`); points = clippedRoutePoints(index, route, from, target); routeHints = buildDrivingRouteHints(index, route, points, maxSpeed); progress = 0;
  };
  const state = await until(label, 240, async s => {
    const car = carOf(s); assert.ok(car, 'Player left the car during driving'); if (!points.length) replan(s);
    const up = 1 - 2 * (car.rotation[0] ** 2 + car.rotation[2] ** 2);
    if (!lastPosition || distance(car.position, lastPosition) > 4) { lastPosition = [...car.position]; lastMoved = Date.now(); }
    if (up < .4 || Date.now() - lastMoved > 8000) {
      assert.ok(recoveries.length < maxRecoveries, `Recovery limit${maxRecoveries} reached at${car.position}`); await releaseKeys();
      recoveries.push({ tick: s.tick, position: car.position, reason: up < .4 ? 'overturned' : 'no progress8s', control: 'hold KeyX1100ms' }); note(`Recovery X at${car.position.map(n => n.toFixed(1))}`);
      await key('KeyX', true); await wait(1100); await key('KeyX', false); points = []; lastMoved = Date.now(); lastPosition = null; return;
    }
    // Keep progress local so a later crossing of the same junction cannot skip half the planned route.
    let nearest = progress, best = Infinity;
    for (let i = progress; i < Math.min(points.length, progress + 10); i++) { const d = distance(car.position, points[i]!); if (d < best) { best = d; nearest = i; } }
    progress = nearest; const preview = previewDrivingRoute(routeHints, progress, car.position, car.forwardSpeed, maxSpeed), lookahead = preview.lookahead;
    while (progress < points.length - 1 && distance(car.position, points[progress]!) < lookahead) progress++;
    const aim = points[progress]!, yaw = yawOf(car.rotation), delta = wrap(Math.atan2(aim[0] - car.position[0], aim[2] - car.position[2]) - yaw);
    const yawRate = previousYaw === null || s.tick <= previousControlTick ? 0 : wrap(yaw - previousYaw) / ((s.tick - previousControlTick) / 60);
    const control = keyboardDriveControl({ headingError: delta, lookahead, forwardSpeed: car.forwardSpeed,
      steerAngle: car.steerAngle, yawRate, maxSpeed: preview.maxSpeed, distanceToGoal: distance(car.position, target.point) });
    previousYaw = yaw; previousControlTick = s.tick;
    await key('KeyA', control.steer > 0); await key('KeyD', control.steer < 0);
    await key('KeyW', control.throttle > 0); await key('KeyS', control.throttle < 0);
    await game.setCamera(page, yaw, -.18);
    if (Date.now() - lastLog > 5000) { lastLog = Date.now(); note(`${label}: ${car.position.map(n => n.toFixed(0))} speed${car.speed.toFixed(1)} target${distance(car.position, target.point).toFixed(0)}m path${progress}/${points.length}`); }
  // A short input poll releases A/D before rate-limited wheels overrun a small target.
  // Simulation still advances exclusively from normal browser frames and real key events.
  }, s => !!carOf(s) && distance(carOf(s)!.position, target.point) <= 6, 20);
  const stopped = await stopCar(); assert.ok(distance(carOf(stopped)!.position, target.point) <= 12, `${label}: braking overshot checkpoint`); await capture(label, stopped); return state;
}
try {
  assert.equal(await game.release(page), manifest.worldReleaseId); await game.start(page);
  seed = await page.evaluate(() => window.__HELSINKI_GAME__!.seed());
  const documentId = await page.evaluate(() => { const w = window as unknown as { __driveExpansionDocument?: number }; return w.__driveExpansionDocument = performance.timeOrigin; });
  let state = await game.state(page); assert.equal(state.player.mode, 'onFoot');
  const car = state.vehicles.find(v => v.id === 'car-1'); assert.ok(car);
  await key('KeyW', true); await key('ShiftLeft', true);
  state = await until('walk from spawn to car-1', 25, async s => { await game.setCamera(page, Math.atan2(car.position[0] - s.player.position[0], car.position[2] - s.player.position[2]), -.15); }, s => distance(s.player.position, car.position) < 2.2);
  await releaseKeys(); await page.keyboard.press('KeyF'); state = await until('car entry', 20, async () => {}, s => s.player.mode === 'driving'); assert.equal(state.player.inVehicle, 'car-1'); await capture('Boarded at Senate Square', state);
  await drive(startHit, 'Unioninkatu departure', true);
  for (const leg of legs) await drive(leg.target, leg.goal.label);
  await key('Space', false); await page.keyboard.press('KeyF'); state = await until('exit after return', 15, async () => {}, s => s.player.mode === 'onFoot'); await capture('Returned on foot at Senate Square', state);
  assert.equal(await page.evaluate(() => (window as unknown as { __driveExpansionDocument?: number }).__driveExpansionDocument), documentId, 'Document reloaded');
  if (!values.goals) assert.ok((samples as { position: number[] }[]).some(s => s.position[0]! < -480), 'Never traversed beyond old district to Stockmann');
  const events = await game.events(page, 0); assert.ok(!events.some(e => ['killPlane', 'wasted', 'busted'].includes(e.type)), 'Route used death/fall respawn');
} catch (error) { failure = error instanceof Error ? error.stack ?? error.message : String(error); note(`FAIL ${failure}`); await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {}); }
finally {
  await releaseKeys();
  const scheduling = await page.evaluate(() => (window as unknown as { __driveTiming: unknown }).__driveTiming);
  writeFileSync(path.join(out, 'scheduling.json'), JSON.stringify(scheduling, null, 2) + '\n');
  try {
    const recording = await page.evaluate(() => { const g = window.__HELSINKI_GAME__!; return { hash: g.hash(), commands: g.commands(), trace: g.trace(), tick: g.tick() }; });
    writeFileSync(path.join(out, 'recording.json'), JSON.stringify({ release: manifest.worldReleaseId, seed, ending: 'expansion-loop', ticks: recording.commands.length, hash: recording.hash, commands: recording.commands }) + '\n');
    // Release the live browser/GPU before constructing another full static world
    // for replay. Large districts must not pay both browser and replay RAM at once.
    await session.close(); browserClosed = true;
    const world = StaticWorld.fromBytes(terrain, roads, gameplay); for (const [id, b] of collisionFiles) world.addCell(id, b); const sim = new Simulation(world, { seed });
    let firstDivergence: { tick: number; browser: string; node: string } | null = null;
    for (const c of recording.commands as EncodedCommand[]) { sim.step(decodeCommand(c)); const b = recording.trace[sim.tick - 1]; if (b !== undefined && !firstDivergence && sim.digest() !== b) firstDivergence = { tick: sim.tick, browser: b, node: sim.digest() }; }
    replayHash = sim.hash(); const replay = { pass: replayHash === recording.hash && sim.tick === recording.tick, browserHash: recording.hash, replayHash, ticks: sim.tick, firstDivergence };
    writeFileSync(path.join(out, 'replay.json'), JSON.stringify(replay, null, 2) + '\n'); if (!replay.pass) failure ??= 'Browser/Node replay mismatch';
    world.physics.free();
  } catch (error) { failure ??= `Recording/replay failed: ${String(error)}`; }
  const status = !failure && session.consoleErrors.length === 0 ? 'PASS' : 'FAIL';
  writeFileSync(path.join(out, 'journey.json'), JSON.stringify({ status, release: manifest.worldReleaseId, manifestSha256: sha(manifestBytes), runtimeUrl, runtimeSha256, scriptSha256: sha(readFileSync(import.meta.filename)), helperSha256: sha(readFileSync('tools/verify/lib/keyboard-route.ts')), driverHelperSha256: sha(readFileSync('tools/verify/lib/keyboard-driving.ts')), browserBackend: process.env.HELSINKI_VERIFY_ANGLE ?? 'd3d11', url: values.url, seed, limits: { maxSeconds, perLegSeconds: 240, maxRecoveries, maxSpeedTarget: maxSpeed }, scope: 'Real keyboard walk, entry, bounded directed road loop, return and exit; camera hook only; no teleport/reset/step/setCommand', route: plan, checkpoints, samples, recoveries, replayHash, seconds: (Date.now() - t0) / 1000, consoleErrors: session.consoleErrors, failure, timeline }, null, 2) + '\n');
  heightWorld.physics.free(); if (!browserClosed) await session.close(); console.log(`${status}: expansion drive, ${recoveries.length} recoveries`); process.exitCode = status === 'PASS' ? 0 : 1;
}
