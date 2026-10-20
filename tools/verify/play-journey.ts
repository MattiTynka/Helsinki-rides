// The M1 gate: the 60-second test (plan section 17 and the M1 acceptance list), played through the real input path
// in a browser, N times in a row. Spawn at Senate Square, walk 10 m, take the spawned car, drive onto Unioninkatu,
// ram the patrol car (1 star), pursuit with lights and siren, get out, fire at the patrol car (3 stars), be shot at,
// then die (Wasted, Meilahti hospital) on odd runs or get arrested (Busted, Pasila police station) on even runs. No
// page reload between runs. Keys go through Playwright's keyboard; aiming uses the camera API because headless
// Chromium cannot grant pointer lock. The browser's command trace is replayed in Node and the hashes must match.
//   node tools/verify/play-journey.ts --url http://127.0.0.1:5317/?review=1 --release apps/game/public/world/<id> --out data/evidence/NEW_DIR [--runs 10] [--headful]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { Page } from 'playwright';
import { decodeCommand, initPhysics, Simulation, StaticWorld, type SimState, type EncodedCommand } from '../../packages/sim/src/index.ts';
import type { WorldManifest } from '../../packages/world-schema/src/index.ts';
import { game, openGame } from './lib/browser.ts';
import { readSimulationPayload, replayWorld } from './lib/simulation-payload.ts';

const { values } = parseArgs({ options: {
  url: { type: 'string', default: 'http://127.0.0.1:5317/?review=1' }, release: { type: 'string' }, out: { type: 'string' },
  runs: { type: 'string', default: '10' }, headful: { type: 'boolean', default: false }, 'min-fps': { type: 'string', default: '30' }, 'max-seconds': { type: 'string', default: '75' },
  ending: { type: 'string', default: 'alternate' },
  'capture-reactions': { type: 'boolean', default: false },
} });
if (!values.release || !values.out) throw new Error('--release and --out are required');
const OUT = values.out;
if (existsSync(OUT)) throw new Error(`${OUT} exists; evidence directories are never overwritten`);
mkdirSync(OUT, { recursive: true });
const RUNS = Number(values.runs);
const MIN_FPS = Number(values['min-fps']);
const MAX_SECONDS = Number(values['max-seconds']);

interface Check { id: string; pass: boolean; detail: string }
interface RunResult { run: number; ending: 'wasted' | 'busted'; checks: Check[]; pass: boolean; seconds: number; fpsMin: number; fpsAvg: number; drawCallsMax: number; ticks: number; hash: string; replayHash: string | null }

const manifest = JSON.parse(readFileSync(path.join(values.release, 'manifest.json'), 'utf8')) as WorldManifest;
const session = await openGame(values.url, { headful: values.headful, timeoutMs: 240000 });
const { page } = session;
const pageMarker = await page.evaluate(() => { (window as unknown as { __journeyMarker: number }).__journeyMarker = Math.random(); return (window as unknown as { __journeyMarker: number }).__journeyMarker; });
await game.start(page);
const release = await game.release(page);
if (release !== manifest.worldReleaseId) throw new Error(`browser runs ${release}, --release is ${manifest.worldReleaseId}`);
const seed = await page.evaluate(() => (window as unknown as { __HELSINKI_GAME__: { seed(): number } }).__HELSINKI_GAME__.seed());
const timeline: string[] = [];
const t0 = Date.now();
const note = (s: string) => { const line = `${((Date.now() - t0) / 1000).toFixed(1)}s ${s}`; timeline.push(line); console.log(line); };

const wrap = (a: number): number => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };
const yawOfQuat = (q: readonly number[]): number => Math.atan2(2 * (q[0]! * q[2]! + q[3]! * q[1]!), 1 - 2 * (q[0]! * q[0]! + q[1]! * q[1]!));
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const held = new Set<string>();
async function key(code: string, down: boolean): Promise<void> {
  if (down && !held.has(code)) { held.add(code); await page.keyboard.down(code); }
  else if (!down && held.has(code)) { held.delete(code); await page.keyboard.up(code); }
}
async function releaseAll(): Promise<void> { for (const k of [...held]) await key(k, false); await page.mouse.up({ button: 'left' }).catch(() => {}); await page.mouse.up({ button: 'right' }).catch(() => {}); }

const patrolCar = (s: SimState) => { const ids = new Set(s.police.map(u => u.vehicleId)); let best: SimState['vehicles'][number] | null = null, bd = Infinity; for (const v of s.vehicles) { if (!ids.has(v.id)) continue; const d = Math.hypot(v.position[0] - s.player.position[0], v.position[2] - s.player.position[2]); if (d < bd) { bd = d; best = v; } } return best; };
const laneName = (x: number, z: number): { name: string | null; distance: number } | null => { const hit = roadsIndex.nearestLane(x, z, undefined, 15); return hit ? { name: roadsIndex.laneById.get(hit.laneId)!.name, distance: hit.distance } : null; };

// Road index for lane checks and the Node replay.
const roadsJson = JSON.parse(readFileSync(path.join(values.release, manifest.roads.path), 'utf8'));
const { RoadIndex } = await import('../../packages/world-schema/src/index.ts');
const roadsIndex = new RoadIndex(roadsJson);
const gameplayJson = JSON.parse(readFileSync(path.join(values.release, manifest.gameplay.path), 'utf8'));
const terrainBytes = await readSimulationPayload(values.release, manifest.terrain);
const RELEASE_DIR = values.release;
const collisionFiles = await Promise.all(manifest.cells.map(async c => [c.id, await readSimulationPayload(RELEASE_DIR, c.collision)] as const));
await initPhysics();
// Terrain-only world for ground-height checks (a respawn inside a building ends up on its roof).
const heightWorld = StaticWorld.fromBytes(terrainBytes, roadsJson, gameplayJson);

/** Closed-loop step: poll state, act, until `done` or timeout (wall-clock seconds). */
async function loop(label: string, timeoutS: number, act: (s: SimState) => Promise<void>, done: (s: SimState) => boolean): Promise<SimState> {
  const start = Date.now();
  let s = await game.state(page);
  while (!done(s)) {
    if (Date.now() - start > timeoutS * 1000) { note(`${label}: timeout after ${timeoutS}s`); break; }
    await act(s);
    await sleep(40);
    s = await game.state(page);
    sampleStats(s);
  }
  return s;
}

let fpsSamples: number[] = [];
let drawCallsMax = 0;
let lastSample = 0;
let statsPromise: Promise<void> | null = null;
function sampleStats(_s: SimState): void {
  if (Date.now() - lastSample < 500 || statsPromise) return;
  lastSample = Date.now();
  statsPromise = game.stats(page).then(st => { if (st.fps! > 0) fpsSamples.push(st.fps!); drawCallsMax = Math.max(drawCallsMax, st.drawCalls!); statsPromise = null; });
}

async function walkToward(target: [number, number], stopWithin: number, timeoutS: number, sprint: boolean): Promise<SimState> {
  await key('KeyW', true);
  if (sprint) await key('ShiftLeft', true);
  const s = await loop('walk', timeoutS, async st => {
    const yaw = Math.atan2(target[0] - st.player.position[0], target[1] - st.player.position[2]);
    await game.setCamera(page, yaw, -0.15);
  }, st => Math.hypot(target[0] - st.player.position[0], target[1] - st.player.position[2]) <= stopWithin);
  await key('KeyW', false);
  await key('ShiftLeft', false);
  return s;
}

/**
 * Drive along the road graph toward a (moving) target with the keyboard: a route is planned on the lane graph and
 * followed with pure pursuit; within `directRange` of the target the car heads straight for it (the ram).
 */
async function driveToward(target: () => [number, number], stopWithin: number, timeoutS: number, maxSpeed: number, done?: (s: SimState) => boolean, directRange = 0): Promise<SimState> {
  let route: number[][] = [];
  let routeIndex = 0;
  let plannedAt = 0;
  let plannedFor: [number, number] = [NaN, NaN];
  let lastLog = Date.now();
  let stuckSince = 0;
  let flippedSince = 0;
  let reverses = 0;
  let progressFrom: readonly number[] | null = null;
  let progressAt = 0;
  // The game's recover control (hold X): what a player does with a car on its roof or wedged in a corner.
  const recover = async (why: string, at: readonly number[]): Promise<void> => {
    for (const k of ['KeyA', 'KeyD', 'KeyW', 'KeyS']) await key(k, false);
    note(`  recover: ${why} at ${at.map(x => x.toFixed(0))}, holding X`);
    await key('KeyX', true); await sleep(1100); await key('KeyX', false);
    route = []; stuckSince = 0; flippedSince = 0; reverses = 0; progressFrom = null;
  };
  const s = await loop('drive', timeoutS, async st => {
    const car = st.vehicles.find(v => v.id === st.player.inVehicle);
    if (!car) return;
    const q = car.rotation;
    if (1 - 2 * (q[0]! * q[0]! + q[2]! * q[2]!) < 0.5) {
      if (flippedSince === 0) flippedSince = Date.now();
      if (Date.now() - flippedSince > 1000) await recover('car on its side or roof', car.position);
      return;
    }
    flippedSince = 0;
    // Rocking between two plans in a junction never trips the stuck test; a player gives up and recovers.
    if (!progressFrom || Math.hypot(car.position[0] - progressFrom[0]!, car.position[2] - progressFrom[2]!) > 5) { progressFrom = car.position; progressAt = Date.now(); }
    else if (Date.now() - progressAt > 6000) { await recover('no progress for 6 s', car.position); return; }
    const t = target();
    const yaw = yawOfQuat(car.rotation);
    const dTarget = Math.hypot(t[0] - car.position[0], t[1] - car.position[2]);
    let aim: [number, number] = t;
    const direct = dTarget <= directRange;
    if (!direct) {
      const moved = Math.hypot(t[0] - plannedFor[0], t[1] - plannedFor[1]);
      if (route.length === 0 || Date.now() - plannedAt > 2500 || moved > 15) {
        const f = [Math.sin(yaw), Math.cos(yaw)] as [number, number];
        const from = roadsIndex.nearestLane(car.position[0], car.position[2], f, 40);
        const to = roadsIndex.nearestLane(t[0], t[1], undefined, 60);
        const r = from && to ? roadsIndex.route(from.laneId, from.s, to.laneId, to.s) : null;
        route = r ? roadsIndex.routePoints(r).map(p => [p[0], p[2]]) : [];
        if (route.length) route.push([t[0], t[1]]);
        routeIndex = 0;
        plannedAt = Date.now();
        plannedFor = [t[0], t[1]];
      }
      if (route.length) {
        const lookahead = 5 + car.speed * 0.5;
        let best = routeIndex, bd = Infinity;
        for (let i = routeIndex; i < route.length; i++) { const d = Math.hypot(route[i]![0]! - car.position[0], route[i]![1]! - car.position[2]); if (d < bd) { bd = d; best = i; } }
        routeIndex = best;
        while (routeIndex < route.length - 1 && Math.hypot(route[routeIndex]![0]! - car.position[0], route[routeIndex]![1]! - car.position[2]) < lookahead) routeIndex++;
        aim = [route[routeIndex]![0]!, route[routeIndex]![1]!];
      }
    }
    const desired = Math.atan2(aim[0] - car.position[0], aim[1] - car.position[2]);
    const delta = wrap(desired - yaw);
    const stuck = car.speed < 0.3 && held.has('KeyW');
    if (stuck && stuckSince === 0) stuckSince = Date.now();
    if (!stuck) { stuckSince = 0; if (car.speed > 3) reverses = 0; }
    if (stuckSince && Date.now() - stuckSince > 1500) {
      if (++reverses > 2) { await recover('still wedged after two reverses', car.position); return; }
      // Reverse out with opposite steering for a moment.
      await key('KeyW', false); await key('KeyS', true); await key('KeyA', delta < 0); await key('KeyD', delta > 0);
      await sleep(900);
      await key('KeyS', false);
      stuckSince = 0;
      return;
    }
    // Aim behind at speed (a replan that turns the car around): brake straight first. Full lock at 20 m/s spins
    // the car into the nearest facade (journey-m1-try6 run 7, Snellmaninkatu).
    const behind = Math.abs(delta) > 1.5 && car.forwardSpeed > 8;
    await key('KeyA', !behind && delta > 0.06);
    await key('KeyD', !behind && delta < -0.06);
    const turnLimit = maxSpeed * (1 - Math.min(1, Math.abs(delta) / 1.2) * 0.7);
    const wantSpeed = direct ? turnLimit : Math.min(turnLimit, Math.max(4, dTarget / 1.2));
    // Once slow, steer forwards toward a target behind us. Holding S for that heading kept the old
    // driver chasing in reverse at 8 m/s indefinitely (facade-junction-20261017/journey run 1).
    await key('KeyW', car.forwardSpeed < wantSpeed && !behind);
    await key('KeyS', car.forwardSpeed > wantSpeed + 3 || behind);
    if (Date.now() - lastLog > 2000) { lastLog = Date.now(); const pc = patrolCar(st); note(`  drive: car ${car.position.map(x => x.toFixed(0))} v=${car.speed.toFixed(1)} → aim ${aim.map(x => x.toFixed(0))} target ${t.map(x => x.toFixed(0))} d=${dTarget.toFixed(0)} route=${route.length}/${routeIndex}${pc ? ` patrol ${pc.position.map(x => x.toFixed(0))} v=${pc.speed.toFixed(1)} ${st.police.map(u => u.state).join('/')}` : ''} stars=${st.wanted.stars}`); }
  }, st => { const car = st.vehicles.find(v => v.id === st.player.inVehicle); const t = target(); return (done?.(st) ?? false) || (!!car && Math.hypot(t[0] - car.position[0], t[1] - car.position[2]) <= stopWithin); });
  for (const k of ['KeyA', 'KeyD', 'KeyW', 'KeyS']) await key(k, false);
  return s;
}

async function aimAtCar(s: SimState): Promise<void> {
  const car = patrolCar(s);
  if (!car) return;
  const e: [number, number, number] = [s.player.position[0], s.player.position[1] + 1.62, s.player.position[2]];
  const dx = car.position[0] - e[0], dy = car.position[1] + 0.7 - e[1], dz = car.position[2] - e[2];
  await game.setCamera(page, Math.atan2(dx, dz), Math.atan2(dy, Math.hypot(dx, dz)));
}

/** Leave the ram contact through real controls before attempting an exit. A pursuit flag can already
 * be true on the collision tick, so it cannot be the stop condition for this movement. */
async function driveClearOfPatrol(): Promise<{ state: SimState; distance: number; seconds: number }> {
  await releaseAll();
  const initial = await game.state(page), own = initial.vehicles.find(v => v.id === initial.player.inVehicle);
  if (!own) return { state: initial, distance: 0, seconds: 0 };
  const patrol = patrolCar(initial), yaw = yawOfQuat(own.rotation);
  const front = patrol ? (patrol.position[0] - own.position[0]) * Math.sin(yaw) + (patrol.position[2] - own.position[2]) * Math.cos(yaw) : 1;
  const direction = front >= 0 ? -1 : 1;
  const distance = (st: SimState) => {
    const car = st.vehicles.find(v => v.id === own.id);
    return car ? Math.hypot(car.position[0] - own.position[0], car.position[2] - own.position[2]) : 0;
  };
  const state = await loop('driveClear', 8, async st => {
    const car = st.vehicles.find(v => v.id === own.id);
    if (!car || st.player.mode !== 'driving') return;
    // Reversing away from a head-on ram avoids trying a U-turn against the patrol bumper.
    const accelerate = car.forwardSpeed * direction < 3.5;
    await key('KeyW', accelerate && direction > 0);
    await key('KeyS', accelerate && direction < 0);
  }, st => {
    if (st.player.mode !== 'driving') return true;
    const car = st.vehicles.find(v => v.id === own.id), pc = st.vehicles.find(v => v.id === patrol?.id);
    const separation = car && pc ? Math.hypot(car.position[0] - pc.position[0], car.position[2] - pc.position[2]) : Infinity;
    return st.tick - initial.tick >= 180 && distance(st) >= 6 && separation >= 7;
  });
  await key('KeyW', false); await key('KeyS', false);
  const result = { state, distance: distance(state), seconds: (state.tick - initial.tick) / 60 };
  note(`  drove clear ${result.distance.toFixed(1)} m over ${result.seconds.toFixed(1)} s using ${direction < 0 ? 'reverse' : 'forward'} controls`);
  return result;
}

/** Wait for the post-braking suspension motion too: speed includes vertical velocity. Pressing F on
 * the first low-speed tick otherwise begins exit just before the car rebounds above 0.3 m/s. */
async function settleCar(): Promise<SimState> {
  await key('KeyA', false); await key('KeyD', false); await key('Space', true);
  let settledAt: number | null = null;
  const state = await loop('settleCar', 5, async st => {
    const car = st.vehicles.find(v => v.id === st.player.inVehicle);
    await key('KeyS', !!car && car.forwardSpeed > .25);
    await key('KeyW', !!car && car.forwardSpeed < -.25);
  }, st => {
    if (st.player.mode !== 'driving') return true;
    const car = st.vehicles.find(v => v.id === st.player.inVehicle);
    if (car && car.speed < .18) settledAt ??= st.tick;
    else settledAt = null;
    return settledAt !== null && st.tick - settledAt >= 30;
  });
  await key('KeyW', false); await key('KeyS', false);
  return state;
}

/** Preserve doorway collision and motion safeguards; bounded retries use real controls. */
async function exitThroughClearDoor(): Promise<SimState> {
  let state = await game.state(page);
  for (let attempt = 0; attempt < 3 && state.player.mode === 'driving'; attempt++) {
    if (attempt === 2) await driveClearOfPatrol();
    if (attempt > 0) note(`  exit retry ${attempt}: wait for a settled car before F`);
    state = await settleCar();
    if (state.player.mode !== 'driving') break;
    const since = state.tick;
    await page.keyboard.press('KeyF');
    let blocked = false;
    state = await loop('exit', 8, async () => {
      blocked = (await game.events(page, since)).some(event => event.type === 'vehicleExitBlocked');
    }, st => st.player.mode === 'onFoot' || st.player.mode === 'busted' || st.player.mode === 'wasted' || (blocked && st.player.mode === 'driving'));
    if (!blocked) break;
    note(`  exit blocked at tick ${state.tick}; retaining the doorway collision rule`);
  }
  await key('Space', false);
  return state;
}

/** Length of the lane-graph route from the player's car to the patrol car, or Infinity without one. */
function routeToPatrol(st: SimState): number {
  const car = st.vehicles.find(v => v.id === st.player.inVehicle), pc = patrolCar(st);
  if (!car || !pc) return Infinity;
  const yaw = yawOfQuat(car.rotation);
  const from = roadsIndex.nearestLane(car.position[0], car.position[2], [Math.sin(yaw), Math.cos(yaw)], 40);
  const to = roadsIndex.nearestLane(pc.position[0], pc.position[2], undefined, 60);
  const r = from && to ? roadsIndex.route(from.laneId, from.s, to.laneId, to.s) : null;
  if (!r) return Infinity;
  const pts = roadsIndex.routePoints(r);
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![2] - pts[i - 1]![2]);
  return len;
}

/** Stop and wait while the patrol car is beyond `directRange` and reachable only the long way round (one-way streets):
 *  a player lies in wait rather than circling the block (journey-57f007bf-2 run 2 chased it 230 m round the block
 *  while it drove past the spot the player had left). */
async function waitForPatrol(s: SimState, directRange: number, timeoutS: number): Promise<SimState> {
  const straight = (st: SimState) => { const car = st.vehicles.find(v => v.id === st.player.inVehicle), pc = patrolCar(st); return car && pc ? Math.hypot(pc.position[0] - car.position[0], pc.position[2] - car.position[2]) : 0; };
  const detour = (st: SimState) => straight(st) > directRange && routeToPatrol(st) > straight(st) + 60;
  if (!detour(s)) return s;
  note(`  wait: patrol car ${straight(s).toFixed(0)} m away, ${routeToPatrol(s).toFixed(0)} m by road; waiting for it`);
  for (const k of ['KeyA', 'KeyD', 'KeyW']) await key(k, false);
  // S brakes only while rolling forward (held at a standstill it reverses: journey-57f007bf-3 run 4 backed 50 m
  // off the road); the handbrake holds the car once stopped.
  await key('Space', true);
  const out = await loop('waitPatrol', timeoutS, async st => { const car = st.vehicles.find(v => v.id === st.player.inVehicle); await key('KeyS', !!car && car.forwardSpeed > 0.5); }, st => !detour(st));
  await key('KeyS', false);
  await key('Space', false);
  return out;
}

/** Distance of `c` from the line of fire p → t where it lies between them, otherwise Infinity (ground plane). */
function offLineOfFire(p: readonly [number, number], t: readonly [number, number], c: readonly [number, number]): number {
  const dx = t[0] - p[0], dz = t[1] - p[1], len = Math.hypot(dx, dz);
  const along = ((c[0] - p[0]) * dx + (c[1] - p[1]) * dz) / len;
  return along > 0 && along < len ? Math.abs((c[0] - p[0]) * dz - (c[1] - p[1]) * dx) / len : Infinity;
}

/** Walk sideways, away from the player's own car, while it stands within `clear` metres of the line of fire to the
 *  patrol car (backlog 26: in journey-57f007bf run 1 all ten shots hit car-1, parked between the two). */
async function stepClearOf(carId: string | null, s: SimState, clear = 3, timeoutS = 4): Promise<SimState> {
  const blocked = (st: SimState) => {
    const own = st.vehicles.find(v => v.id === carId), pc = patrolCar(st);
    return !!own && !!pc && offLineOfFire([st.player.position[0], st.player.position[2]], [pc.position[0], pc.position[2]], [own.position[0], own.position[2]]) < clear;
  };
  if (!blocked(s)) return s;
  const own = s.vehicles.find(v => v.id === carId)!, pc = patrolCar(s)!, p = s.player.position;
  const dx = pc.position[0] - p[0], dz = pc.position[2] - p[2], len = Math.hypot(dx, dz);
  // (dz, -dx) / len is the line's normal; the car's centre lies on the side `side` of it, so walk to the other.
  const side = Math.sign((own.position[0] - p[0]) * dz - (own.position[2] - p[2]) * dx) || 1;
  const goal: [number, number] = [p[0] - side * dz / len * 10, p[2] + side * dx / len * 10];
  note(`  step clear: ${carId} in the line of fire, walking toward ${goal.map(x => x.toFixed(0))}`);
  await key('KeyW', true);
  const out = await loop('stepClear', timeoutS, async st => { await game.setCamera(page, Math.atan2(goal[0] - st.player.position[0], goal[1] - st.player.position[2]), -0.15); }, st => !blocked(st));
  await key('KeyW', false);
  return out;
}

async function runOnce(run: number): Promise<RunResult> {
  const ending: 'wasted' | 'busted' = values.ending === 'wasted' || values.ending === 'busted' ? values.ending : run % 2 === 1 ? 'wasted' : 'busted';
  const checks: Check[] = [];
  const check = (id: string, pass: boolean, detail: string) => { checks.push({ id, pass, detail }); note(`${pass ? 'PASS' : 'FAIL'} ${id}: ${detail}`); };
  fpsSamples = []; drawCallsMax = 0;
  const startState = await game.state(page);
  const startTick = startState.tick;
  const sinceTick = startTick;
  const gp = gameplayJson as { player: { spawn: { position: [number, number] } }; anchors: { kind: string; position: [number, number]; destinationName: string }[] };
  // 1. Spawn position (first run) / on foot and alive.
  const p0 = startState.player;
  const spawnD = Math.hypot(p0.position[0] - gp.player.spawn.position[0], p0.position[2] - gp.player.spawn.position[1]);
  check('spawn', p0.mode === 'onFoot' && p0.alive && (run > 1 || spawnD < 3), `mode ${p0.mode}, ${spawnD.toFixed(1)} m from the spawn point`);
  // 2. Walk 10 m toward the spawned car.
  const car1 = startState.vehicles.find(v => v.id === 'car-1')!;
  const walkStart: [number, number, number] = [p0.position[0], p0.position[1], p0.position[2]];
  let s = await walkToward([car1.position[0], car1.position[2]], 2.2, 25, true);
  const walked = Math.hypot(s.player.position[0] - walkStart[0], s.player.position[2] - walkStart[2]);
  check('walk10', walked >= 10, `walked ${walked.toFixed(1)} m`);
  // 3. Enter the car.
  await page.keyboard.press('KeyF');
  s = await loop('enter', 16, async () => {}, st => st.player.mode === 'driving');
  check('enterCar', s.player.mode === 'driving' && s.player.inVehicle === 'car-1', `mode ${s.player.mode} in ${s.player.inVehicle}`);
  // 4. Drive onto Unioninkatu (the junction with Aleksanterinkatu, then north along the street).
  s = await driveToward(() => [-68, 42], 6, 25, 14);
  s = await driveToward(() => [-70, -10], 8, 25, 14, st => { const car = st.vehicles.find(v => v.id === st.player.inVehicle); const l = car ? laneName(car.position[0], car.position[2]) : null; return !!l && l.name === 'Unioninkatu' && l.distance < 6; });
  const carNow = s.vehicles.find(v => v.id === s.player.inVehicle)!;
  const lane = laneName(carNow.position[0], carNow.position[2]);
  check('unioninkatu', lane?.name === 'Unioninkatu' && lane.distance < 10, `on ${lane?.name ?? 'no lane'} (${lane?.distance.toFixed(1) ?? '-'} m)`);
  // 5. Ram the patrol car: wait for it if it is only reachable the long way round, then chase it head-on.
  s = await waitForPatrol(s, 45, 25);
  let latest: SimState = s;
  s = await driveToward(() => { const pc = patrolCar(latest); return pc ? [pc.position[0], pc.position[2]] : [-70, -100]; }, 0, 45, 22, st => { latest = st; return st.wanted.stars >= 1 || st.events.some(e => e.type === 'ramPolice'); }, 45);
  const evAfterRam = await game.events(page, sinceTick);
  check('ramPolice', evAfterRam.some(e => e.type === 'ramPolice') && s.wanted.stars >= 1, `stars ${s.wanted.stars}, events ${evAfterRam.filter(e => e.type === 'ramPolice').length} ramPolice`);
  // 6. Actually move clear of the collision, then confirm pursuit with lights and siren.
  const clear = await driveClearOfPatrol();
  s = clear.state;
  check('driveClear', clear.distance >= 6 && clear.seconds >= 3, `moved ${clear.distance.toFixed(1)} m over ${clear.seconds.toFixed(1)} s`);
  const pursuing = s.police.filter(u => u.state === 'pursue' || u.state === 'boxin' || u.state === 'respond');
  const sirens = s.vehicles.filter(v => v.sirenOn && v.lightsOn).length;
  check('pursuit', pursuing.length > 0 && sirens > 0, `${pursuing.length} unit(s) ${pursuing.map(u => u.state).join('/')}, ${sirens} siren(s) on, seen=${s.wanted.seen}`);
  // 7. Stop, get out.
  const ownCar = s.player.inVehicle;
  s = await exitThroughClearDoor();
  check('exitCar', s.player.mode === 'onFoot', `mode ${s.player.mode}`);
  // 8. Aim and fire at the patrol car until 3 stars, from a spot where the own car is not in the way.
  s = await stepClearOf(ownCar, s);
  const tickBeforeFire = s.tick;
  await aimAtCar(s);
  await page.mouse.move(640, 360);
  await page.mouse.down({ button: 'right' });
  await sleep(300);
  s = await loop('fire', 15, async st => { await aimAtCar(st); await page.mouse.down({ button: 'left' }); await sleep(60); await page.mouse.up({ button: 'left' }); }, st => st.wanted.stars >= 3);
  const evFire = (await game.events(page, tickBeforeFire));
  check('fireAtPolice', evFire.some(e => e.type === 'fire') && evFire.some(e => e.type === 'crime' && e.detail === 'shootAtPolice') && s.wanted.stars >= 3, `stars ${s.wanted.stars}, ${evFire.filter(e => e.type === 'fire').length} shots`);
  // 9. Be shot at: keep aiming so the officers engage.
  let sawPoliceFire = false;
  s = await loop('shotAt', 25, async st => { await aimAtCar(st); }, st => { if (st.events.some(e => e.type === 'policeFire')) sawPoliceFire = true; return sawPoliceFire || st.player.health < 100 || st.player.mode === 'wasted'; });
  const evShot = await game.events(page, tickBeforeFire);
  const policeShots = evShot.filter(e => e.type === 'policeFire').length;
  check('shotAt', policeShots > 0, `${policeShots} police shots, player health ${s.player.health.toFixed(0)}`);
  // 10. Ending.
  let lastEndingLog = 0;
  const endingLog = async (st: SimState) => {
    if (Date.now() - lastEndingLog < 3000) return;
    lastEndingLog = Date.now();
    // A seated officer's character stays where it boarded, so a driving unit is measured by its car.
    note(`  ending: hp=${st.player.health.toFixed(0)} mode=${st.player.mode} stars=${st.wanted.stars} seen=${st.wanted.seen} arrest=${st.arrestProgress.toFixed(2)} ${st.police.map(u => { const o = st.characters.find(c => c.id === u.officerId); const car = u.vehicleId ? st.vehicles.find(v => v.id === u.vehicleId) : null; const pos = (!u.onFoot && car ? car : o)?.position; const d = pos ? Math.hypot(pos[0] - st.player.position[0], pos[2] - st.player.position[2]) : NaN; return `${u.id}:${u.state}${u.onFoot ? '(foot)' : ''}${u.seesPlayer ? '*' : ''} d=${d.toFixed(1)}`; }).join(' | ')}`);
  };
  if (ending === 'wasted') {
    s = await loop('wasted', 45, async st => { await aimAtCar(st); await endingLog(st); }, st => st.player.mode === 'wasted' || st.player.mode === 'busted');
    await page.mouse.up({ button: 'right' });
    check('wasted', s.screen?.kind === 'wasted' && s.screen.destination === gp.anchors.find(a => a.kind === 'hospital')!.destinationName, `screen ${s.screen?.kind ?? 'none'} → ${s.screen?.destination ?? '-'}`);
  } else {
    await page.mouse.up({ button: 'right' });
    s = await loop('busted', 45, async st => { await endingLog(st); }, st => st.player.mode === 'busted' || st.player.mode === 'wasted');
    check('busted', s.screen?.kind === 'busted' && s.screen.destination === gp.anchors.find(a => a.kind === 'police')!.destinationName, `screen ${s.screen?.kind ?? 'none'} → ${s.screen?.destination ?? '-'}`);
  }
  if (values['capture-reactions']) {
    // Capture the actual full-body ending after its animation has settled, before the normal respawn.
    // Controls, simulation and rendering continue; this is not a forced pose or fixture.
    await sleep(ending === 'wasted' ? 1500 : 400);
    const reaction = await game.state(page);
    if (reaction.player.mode !== ending) throw new Error(`Missed ${ending} reaction capture`);
    const stem = `run-${String(run).padStart(2, '0')}-${ending}`;
    await page.screenshot({ path: path.join(OUT, `${stem}.png`) });
    writeFileSync(path.join(OUT, `${stem}.json`), JSON.stringify({ release, state: reaction, scope: 'Natural journey ending; no pose override or fixture.' }, null, 2) + '\n');
  }
  // 11. Respawn at the anchor, no reload.
  s = await loop('respawn', 10, async () => {}, st => st.player.mode === 'onFoot' && st.screen === null);
  const anchor = gp.anchors.find(a => a.kind === (ending === 'wasted' ? 'hospital' : 'police'))!;
  const anchorD = Math.hypot(s.player.position[0] - anchor.position[0], s.player.position[2] - anchor.position[1]);
  const aboveGround = s.player.position[1] - heightWorld.groundHeight(s.player.position[0], s.player.position[2]);
  check('respawn', s.player.mode === 'onFoot' && anchorD < 12 && Math.abs(aboveGround) < 2.5 && s.wanted.stars === 0, `${anchorD.toFixed(1)} m from the ${anchor.kind} anchor, ${aboveGround.toFixed(1)} m above the terrain, stars ${s.wanted.stars}`);
  const marker = await page.evaluate(() => (window as unknown as { __journeyMarker: number }).__journeyMarker);
  check('noReload', marker === pageMarker, marker === pageMarker ? 'same document' : 'page was reloaded');
  await releaseAll();
  // Let the 0.15 s crossfade out of the arrest or death clip finish, or the capture shows a half-blended pose.
  await page.waitForTimeout(600);
  // A new life has the configured starting loadout, including after an arrest.
  await page.mouse.down({ button: 'right' });
  await sleep(120);
  const restored = await game.state(page);
  const startWeapons = gameplayJson.playerStart.weapons as { id: string; reserve: number }[];
  const startingWeapon = startWeapons[0];
  const weaponDef = gameplayJson.weapons.find((w: { id: string }) => w.id === startingWeapon?.id);
  check('respawnAmmo', !!startingWeapon && restored.player.weapon?.id === startingWeapon.id && restored.player.weapon.magazine === weaponDef?.magazine && restored.player.weapon.reserve === startingWeapon.reserve && !restored.player.weapon.reloading,
    `${ending}: ${restored.player.weapon?.magazine ?? 'none'} loaded / ${restored.player.weapon?.reserve ?? 'none'} reserve`);
  const tickBeforeRespawnShot = restored.tick;
  await page.mouse.down({ button: 'left' });
  await sleep(75); // Hold through a simulation tick; Playwright's instantaneous click can fall between ticks.
  await page.mouse.up({ button: 'left' });
  await sleep(120);
  check('respawnFire', (await game.events(page, tickBeforeRespawnShot)).some(e => e.type === 'fire'), 'pistol fires through the real mouse input after respawn');
  await page.mouse.up({ button: 'right' });
  await page.screenshot({ path: path.join(OUT, `run-${String(run).padStart(2, '0')}-end.png`) });
  // Walk back to the Senate Square spawn for the next run (drop-in is a dev tool, not a command, so use it only
  // between runs and record it).
  const seconds = (s.tick - startTick) / 60;
  const fpsMin = fpsSamples.length ? Math.min(...fpsSamples) : 0, fpsAvg = fpsSamples.length ? fpsSamples.reduce((a, b) => a + b, 0) / fpsSamples.length : 0;
  check('fps', fpsAvg >= MIN_FPS && fpsMin >= MIN_FPS * 0.5, `avg ${fpsAvg.toFixed(0)} fps, min ${fpsMin.toFixed(0)}, max ${drawCallsMax} draw calls`);
  check('duration', seconds <= MAX_SECONDS, `${seconds.toFixed(1)} s of simulation`);
  // Offline replay of this run's command trace on a fresh Node simulation with the same seed.
  // One evaluate so the hash, the command log and the trace come from the same tick (the loop keeps running).
  const { hash, commands, browserTrace, collision } = await page.evaluate(() => {
    const g = (window as unknown as { __HELSINKI_GAME__: { hash(): string; commands(): EncodedCommand[]; trace(): string[]; collision(): { residency: string | null } } }).__HELSINKI_GAME__;
    return { hash: g.hash(), commands: g.commands(), browserTrace: g.trace(), collision: g.collision().residency };
  });
  const world = replayWorld(terrainBytes, roadsJson, gameplayJson, manifest.cells, new Map(collisionFiles), collision);
  const sim = new Simulation(world, { seed });
  let firstDivergence: { tick: number; browser: string; node: string } | null = null;
  for (const c of commands) {
    sim.step(decodeCommand(c));
    const b = browserTrace[sim.tick - 1];
    if (b !== undefined && !firstDivergence) { const n = sim.digest(); if (n !== b) firstDivergence = { tick: sim.tick, browser: b, node: n }; }
  }
  const replayHash = sim.hash();
  const replayMatch = replayHash === hash && commands.length === sim.tick;
  check('replay', replayMatch, `${commands.length} commands, browser ${hash}, node ${replayHash}${firstDivergence ? `, first divergence at tick ${firstDivergence.tick}` : ''}`);
  if (firstDivergence) { note(`  browser: ${firstDivergence.browser}`); note(`  node:    ${firstDivergence.node}`); }
  // The input recording: enough to replay this run offline (tools/verify/replay-recording.ts).
  writeFileSync(path.join(OUT, `run-${String(run).padStart(2, '0')}-recording.json`), JSON.stringify({ release, seed, ending, ticks: commands.length, hash, commands, collision: collision ?? undefined }) + '\n');
  return { run, ending, checks, pass: checks.every(c => c.pass), seconds, fpsMin, fpsAvg, drawCallsMax, ticks: s.tick - startTick, hash, replayHash };
}

const results: RunResult[] = [];
for (let run = 1; run <= RUNS; run++) {
  note(`--- run ${run} / ${RUNS} ---`);
  const r = await runOnce(run);
  results.push(r);
  if (!r.pass) { note(`run ${run} FAILED`); break; }
  // A fresh simulation (same seed, same page, same GPU assets) for the next run.
  await page.evaluate(() => (window as unknown as { __HELSINKI_GAME__: { reset(): void } }).__HELSINKI_GAME__.reset());
  await sleep(400);
}

const allPass = results.length === RUNS && results.every(r => r.pass) && session.consoleErrors.length === 0;
const summary = {
  status: allPass ? 'PASS' : 'FAIL', release, seed, runs: results.length, requested: RUNS, consoleErrors: session.consoleErrors,
  results, timeline, gpu: await page.evaluate(() => { const c = document.createElement('canvas').getContext('webgl2'); const d = c?.getExtension('WEBGL_debug_renderer_info'); return d && c ? c.getParameter(d.UNMASKED_RENDERER_WEBGL) : null; }),
};
writeFileSync(path.join(OUT, 'journey.json'), JSON.stringify(summary, null, 1) + '\n');
console.log(`\n${summary.status}: ${results.filter(r => r.pass).length}/${RUNS} runs passed, ${session.consoleErrors.length} console errors`);
await session.close();
process.exit(allPass ? 0 : 1);
