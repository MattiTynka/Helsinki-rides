import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { before, test } from 'node:test';
import { decodeRoadGraph, encodeCollisionBundle, encodeTerrain, pointAlong, type ColliderGroup, type GameplayBundle, type RoadGraph, type RoadLane, type WorldManifest } from '@helsinki/world-schema';
import { Button, CHARACTER, CHARACTER_SKIN, collisionCellRefs, GROUP, groups, initPhysics, NEUTRAL, RAPIER, Simulation, StaticWorld, wrapAngle } from '../src/index.ts';
import { CIVILIAN_KNOCKDOWN, CIVILIAN_PANIC, CIVILIAN_VARIANTS, CIVILIAN_VAULT, PEDESTRIAN_STEERING, PEDESTRIANS, cityPedestrianRoutes, civilianVariant, pedestrianGround, pedestrianRouteCoordinate } from '../src/pedestrians.ts';

const source = JSON.parse(readFileSync(new URL('../../../content/helsinki/gameplay.json', import.meta.url), 'utf8'));
const terrain = encodeTerrain({ x0: -1800, z0: -1800, resolution: 100, nx: 37, nz: 37, heights: new Float32Array(37 * 37) });
/** The same fallback terrain 20 m below the native floors: stepping off a floor is a fall. */
const deep = encodeTerrain({ x0: -1800, z0: -1800, resolution: 100, nx: 37, nz: 37, heights: new Float32Array(37 * 37).fill(-20) });
const centers = [[0, 0], [1000, 0], [0, -1000], [-1000, 0]] as const;
const lane = (id: string, x: number, z: number): RoadLane => ({ id, wayId: 1, name: id, highway: 'residential', surface: 'asphalt', speedLimit: 10, width: 3,
  from: `${id}-a`, to: `${id}-b`, points: [[x - 150, 0, z], [x + 150, 0, z]], length: 300, index: 0, count: 1 });
const roads: RoadGraph = { schemaVersion: 2, originId: 't', source: { id: 'fixture', sha256: 'x', attribution: 'fixture', license: 'fixture' },
  lanes: centers.map(([x, z], i) => lane(`street-${i}`, x, z)), nodes: [], connectors: [], parking: [],
  footways: centers.flatMap(([x, z], i) => [-1, 1].map(side => ({ id: `sidewalk-${i}-${side}`, points: [[x - 145, 0, z + side * 12], [x + 145, 0, z + side * 12]] as [number, number, number][] }))) };
const gameplay: GameplayBundle = { ...source, schemaVersion: 2, originId: 't', playArea: { minX: -1800, maxX: 1800, minZ: -1800, maxZ: 1800 },
  civilianVariants: CIVILIAN_VARIANTS,
  player: { ...source.player, spawn: { position: [0, 0], headingDeg: 0 } }, vehicles: [], vehicleDefinitions: [],
  police: { ...source.police, initialPatrols: 0 }, wanted: { ...source.wanted, unitCaps: [0, 0, 0, 0, 0] }, addresses: [] };
/** `dx`, `dz` from (`x`, `z`), turned `yaw` radians about the vertical: +x toward +z. */
const turned = (x: number, z: number, dx: number, dz: number, yaw: number) => [x + dx * Math.cos(yaw) - dz * Math.sin(yaw), z + dx * Math.sin(yaw) + dz * Math.cos(yaw)];
function floor(x: number, z: number, halfX = 160, halfZ = 30, y = 0, tag = 'paving', yaw = 0) {
  const corners = [[-halfX, -halfZ], [halfX, -halfZ], [halfX, halfZ], [-halfX, halfZ]].map(([dx, dz]) => turned(x, z, dx!, dz!, yaw));
  return encodeCollisionBundle({ originId: 't', frame: 'X-east,Y-up,Z-south', cell: 'fixture', surfaceTags: [tag] }, [{
    id: 'floor', group: 'ground', ref: null, positions: new Float32Array(corners.flatMap(([px, pz]) => [px!, y, pz!])),
    indices: new Uint32Array([0, 2, 1, 0, 3, 2]), triangleTags: new Uint16Array([0, 0]),
  }]);
}
function makeSim(graph = roads, content = gameplay, ground = terrain) {
  const world = StaticWorld.fromBytes(ground, graph, content);
  centers.forEach(([x, z], i) => world.addCell(`floor-${i}`, floor(x, z)));
  const sim = new Simulation(world, { seed: 7 });
  return { sim, pedestrians: sim.pedestrians };
}
function advance(fixture: ReturnType<typeof makeSim>, n: number) {
  for (let i = 0; i < n; i++) {
    fixture.sim.step(NEUTRAL);
  }
}
const civilians = (sim: Simulation) => [...sim.characters.values()].filter(c => civilianVariant(c.id));
/** The mesh of a closed box standing on the floor, turned `yaw` about its middle. */
function boxMesh(x0: number, z0: number, x1: number, z1: number, height: number, yaw: number) {
  const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
  const corners = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]].map(([px, pz]) => yaw ? turned(mx, mz, px! - mx, pz! - mz, yaw) : [px!, pz!]);
  const positions = new Float32Array([0, height].flatMap(py => corners.flatMap(([px, pz]) => [px!, py, pz!])));
  const indices = new Uint32Array([0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7, 4, 5, 6, 4, 6, 7]);
  return { positions, indices };
}
/** A closed box standing on the floor, turned `yaw` about its middle: a post, a facade corner, a wall across a footway. */
function box(id: string, x0: number, z0: number, x1: number, z1: number, height = 2.5, yaw = 0, group: ColliderGroup = 'buildings') {
  const { positions, indices } = boxMesh(x0, z0, x1, z1, height, yaw);
  return encodeCollisionBundle({ originId: 't', frame: 'X-east,Y-up,Z-south', cell: id, surfaceTags: ['wall'] },
    [{ id, group, ref: null, positions, indices, triangleTags: new Uint16Array(indices.length / 3) }]);
}
/** The same box as a bare static collider with no surface tags, which the world reports as terrain. */
function bareBox(world: StaticWorld, x0: number, z0: number, x1: number, z1: number, height: number, yaw: number) {
  const { positions, indices } = boxMesh(x0, z0, x1, z1, height, yaw);
  const collider = world.physics.createCollider(RAPIER.ColliderDesc.trimesh(positions, indices).setCollisionGroups(groups(GROUP.static, GROUP.all)),
    world.physics.createRigidBody(RAPIER.RigidBodyDesc.fixed()));
  world.staticHandles.add(collider.handle);
  return collider;
}
interface WalkerView { direction: number; safeAhead: boolean; waitUntil: number; forcedReversals: number[]; limits: [number, number] | null; vault: { landing: readonly number[]; tick: number } | null }
const walkerOf = (f: ReturnType<typeof makeSim>, id: string) => (Reflect.get(f.pedestrians, 'active') as Map<string, WalkerView>).get(id)!;
before(initPhysics);

test('civilian appearance IDs are explicit and exclude police and arbitrary lookalikes', () => {
  for (const variant of CIVILIAN_VARIANTS) assert.equal(civilianVariant(`civilian-${variant}-12`), variant);
  for (const id of ['officer-1', 'civilian-rain-black-bad', 'civilian-rain-black-', 'civilian-agent471-2', 'player']) assert.equal(civilianVariant(id), null);
});

test('old worlds without civilian assets create no population; selected variants are honored exactly', () => {
  const { civilianVariants: _omitted, ...oldContent } = gameplay;
  const old = makeSim(roads, oldContent), disabled = makeSim(roads, { ...gameplay, civilianVariants: [] });
  const one = makeSim(roads, { ...gameplay, civilianVariants: ['snow-black'] });
  try {
    advance(old, 300); advance(disabled, 300); advance(one, 600);
    assert.equal(civilians(old.sim).length, 0); assert.equal(civilians(disabled.sim).length, 0);
    assert.equal(civilians(one.sim).length, PEDESTRIANS.target);
    assert.ok(civilians(one.sim).every(c => civilianVariant(c.id) === 'snow-black'));
  } finally { old.sim.world.physics.free(); disabled.sim.world.physics.free(); one.sim.world.physics.free(); }
});

test('native sidewalk walkers appear in distant districts, use all variants and retire their old physics bodies', () => {
  const f = makeSim();
  try {
    let previous: string[] = [];
    for (const [x, z] of centers) {
      f.sim.dropIn([x, 0, z], 0); advance(f, 9 * 60);
      const actors = civilians(f.sim);
      assert.equal(actors.length, PEDESTRIANS.target);
      assert.equal(new Set(actors.map(c => civilianVariant(c.id))).size, CIVILIAN_VARIANTS.length);
      assert.ok(actors.every(c => Math.hypot(c.position[0] - x, c.position[2] - z) < 150));
      assert.ok(actors.every(c => Math.abs(c.position[2] - z) > 3), 'stay outside active travel lanes');
      assert.ok(actors.every(c => c.position[1] >= -0.05 && c.grounded), 'native support under every civilian');
      assert.ok(actors.some(c => c.speed > 0.6 && c.clip === 'walk'), 'actual character controllers move, not only animations');
      for (const id of previous) assert.equal(f.sim.characters.has(id), false);
      previous = actors.map(c => c.id);
    }
  } finally { f.sim.world.physics.free(); }
});

test('spawn qualification rejects missing, water, wrong-level, partial and occupied support', () => {
  const f = makeSim(), world = f.sim.world;
  try {
    assert.equal(pedestrianGround(world, [500, 0, 500]), null, 'fallback terrain is not native ground');
    assert.equal(pedestrianGround(world, [60, 6, 12]), null, 'a lower floor is not an upper footway');
    assert.equal(pedestrianGround(world, [1801, 0, 12]), null);
    world.addCell('water', floor(500, 500, 20, 20, 0, 'water'));
    world.addCell('tiny', floor(600, 600, 0.1, 0.1));
    world.physics.step(); world.markStepped();
    assert.equal(pedestrianGround(world, [500, 0, 500]), null);
    assert.equal(pedestrianGround(world, [600, 0, 600]), null);
    const clear = pedestrianGround(world, [60, 0, 12]); assert.ok(clear);
    const blocker = f.sim.spawnCharacter('blocking-person', clear, 0, 100);
    world.physics.step(); world.markStepped();
    assert.equal(pedestrianGround(world, [60, 0, 12]), null);
    assert.ok(pedestrianGround(world, [60, 0, 12], blocker.body), 'a walker excludes only its own body');
  } finally { world.physics.free(); }
});

test('all traffic lanes and intersection connectors disqualify crossing footway proposals', () => {
  const crossing: RoadGraph = { ...roads, lanes: [], footways: [{ id: 'bad-crossing', points: [[-145, 0, 0], [145, 0, 0]] }],
    connectors: [{ id: 'intersection', node: 'n', from: 'a', to: 'b', turn: 'straight', length: 300, points: [[-150, 0, 0], [150, 0, 0]] }] };
  const f = makeSim(crossing);
  try { advance(f, 10 * 60); assert.equal(civilians(f.sim).length, 0); }
  finally { f.sim.world.physics.free(); }
});

test('proposals exclude motorway edges and inner traffic lanes; short invalid footways are ignored', () => {
  const route = roads.lanes[0]!;
  const proposed = cityPedestrianRoutes({ ...roads, footways: [{ id: 'tiny', points: [[0, 0, 0], [1, 0, 0]] }],
    lanes: [{ ...route, highway: 'motorway' }, { ...route, id: 'inner', index: 0, count: 2 }] });
  assert.deepEqual(proposed, []);
});

test('lateral collision corrections do not advance route progress or jump to a nearby crossing', () => {
  const straight: [number, number, number][] = [[0, 0, 0], [100, 0, 0]];
  assert.equal(pedestrianRouteCoordinate(straight, [10, 0, 1.5], 10), 10);
  assert.equal(pedestrianRouteCoordinate(straight, [10, 0, 3], 10), 10);
  assert.equal(pedestrianRouteCoordinate(straight, [10.2, 0, 3], 10), 10.2);
  const crossing: [number, number, number][] = [[0, 0, 0], [10, 0, 0], [10, 0, 10], [5, 0, 10], [5, 0, -10]];
  // The later segment passes directly under this point, but it is 30 m farther along the route.
  assert.equal(pedestrianRouteCoordinate(crossing, [5, 0, 0.3], 5), 5);
  assert.equal(pedestrianRouteCoordinate(straight, [80, 0, 0], 10), 12, 'large displacements cannot skip the local arc');
});

test('the native Esplanadi stop loop reanchors its cursor before choosing the return target', () => {
  const points: [number, number, number][] = [[-372.323, -5.172, 77.271], [-368.612, -4.398, 135.444],
    [-367.746, -4.061, 155.544], [-366.268, -3.465, 187.087]];
  const position: [number, number, number] = [-372.19885254739256, -5.104173003530741, 79.18047898340342];
  const stale = 0.9777;
  const wrongTarget = pointAlong(points, stale + 0.9).point;
  assert.ok(Math.hypot(wrongTarget[0] - position[0], wrongTarget[2] - position[2]) < 0.08,
    'recorded drift makes the old return target immediately reverse again');
  const coordinate = pedestrianRouteCoordinate(points, position, stale);
  assert.ok(coordinate > 1.8 && coordinate < 2.1, 'progress follows the real body rather than unsigned travelled distance');
  const returnTarget = pointAlong(points, coordinate + 0.9).point;
  assert.ok(returnTarget[2] > position[2] + 0.8, 'return direction now points back along the footway');
  assert.ok(Math.hypot(returnTarget[0] - position[0], returnTarget[2] - position[2]) > 0.89);
});

test('a stopped walker escapes the recorded stale-cursor endpoint flip cycle', () => {
  const f = makeSim({ ...roads, lanes: [], footways: [{ id: 'cursor-drift', points: [[50, 0, 12], [62, 0, 12]] }] });
  try {
    advance(f, 150); const c = civilians(f.sim)[0]!; assert.ok(c);
    f.sim.player.teleport([54, 0, 25], 0);
    // Freeze the observed failure geometry: the capsule is 1.91 m along its route,
    // but collision-correction distance left the cursor at 0.9777 m. Without reanchoring,
    // the return lookahead is already underfoot and both directions reverse forever.
    c.teleport([51.91, 0.03, 12], -Math.PI / 2); c.speed = 0.000118;
    const active = Reflect.get(f.pedestrians, 'active') as Map<string, {
      s: number; direction: number; waitUntil: number; nextGroundTick: number; blockedTicks: number;
    }>;
    const walker = active.get(c.id)!;
    walker.s = 0.9777; walker.direction = 1; walker.waitUntil = f.sim.tick;
    walker.nextGroundTick = 0; walker.blockedTicks = 0;
    let maxX = c.position[0], turned = false;
    for (let i = 0; i < 10 * 60; i++) {
      advance(f, 1); maxX = Math.max(maxX, c.position[0]);
      if (Math.abs(wrapAngle(c.yaw - Math.PI / 2)) < 0.12) turned = true;
      assert.equal(c.alive, true); assert.equal(c.health, 100);
    }
    assert.ok(turned, 'a return target beyond the body produces a real turn');
    assert.ok(maxX > 55, `the civilian resumes supported movement instead of flipping an idle timer: ${maxX}`);
  } finally { f.sim.world.physics.free(); }
});

test('walkers turn around before native support ends and never follow a footway into fallback terrain', () => {
  const f = makeSim({ ...roads, lanes: [], footways: [{ id: 'past-edge', points: [[40, 0, 12], [400, 0, 12]] }] });
  try {
    advance(f, 60 * 60);
    const actors = civilians(f.sim); assert.ok(actors.length > 0);
    assert.ok(actors.every(c => c.position[0] < 159.5 && c.position[1] > -0.1 && c.grounded));
    assert.ok(actors.every(c => c.position[0] > 38));
  } finally { f.sim.world.physics.free(); }
});

test('forward-only walkers align before moving and brake to finite endpoint reversals', () => {
  const f = makeSim({ ...roads, lanes: [], footways: [{ id: 'short-walk', points: [[50, 0, 12], [62, 0, 12]] }] });
  try {
    advance(f, 150); const c = civilians(f.sim)[0]!; assert.ok(c);
    // Keep the sole spawn slot inside the player's no-birth radius while leaving the
    // pedestrian's native path clear, so another walker cannot create a safety stop.
    f.sim.player.teleport([54, 0, 25], 0);
    let lastDirection = 0, reversals = 0, brakingTicks = 0, movingTicks = 0;
    let minX = c.position[0], maxX = c.position[0], previousSpeed = c.speed;
    const speedStep = PEDESTRIANS.walkAcceleration / 60;
    for (let i = 0; i < 60 * 60; i++) {
      advance(f, 1);
      assert.equal(f.sim.characters.get(c.id), c, 'one managed walker completes repeated out-and-back trips');
      const desiredSpeed = Math.hypot(c.desiredVx, c.desiredVz);
      assert.ok(Math.abs(desiredSpeed - previousSpeed) <= speedStep + 1e-6,
        `clear planned motion respects acceleration/deceleration at ${c.position}: ${previousSpeed} -> ${desiredSpeed}; ${f.pedestrians.digest()}`);
      if (desiredSpeed > 0.01) {
        movingTicks++;
        const headingError = Math.abs(wrapAngle(Math.atan2(c.desiredVx, c.desiredVz) - c.yaw));
        assert.ok(headingError < PEDESTRIANS.turnAlignment + 1e-10, 'the forward-only clip faces its checked travel direction');
        const direction = Math.sign(c.desiredVx);
        if (lastDirection && direction !== lastDirection) reversals++;
        lastDirection = direction;
        if (desiredSpeed < previousSpeed - 0.01) brakingTicks++;
      }
      minX = Math.min(minX, c.position[0]); maxX = Math.max(maxX, c.position[0]);
      assert.equal(c.health, 100); assert.equal(c.alive, true);
      previousSpeed = c.speed;
    }
    assert.ok(movingTicks > 1000 && reversals >= 4, `endpoint braking cannot stall asymptotically: ${reversals} reversals`);
    assert.ok(brakingTicks >= 30, 'planned endpoints include a gradual slowdown');
    assert.ok(minX < 51.1 && maxX > 60.9, `both endpoint margins are reached: ${minX}, ${maxX}`);
    assert.ok(minX > 50.8 && maxX < 61.2, 'braking stays within the supported route');
  } finally { f.sim.world.physics.free(); }
});

test('nonlethal damage knocks a civilian down, holds movement and gets up without falsifying health', () => {
  const f = makeSim();
  try {
    advance(f, 300); const c = civilians(f.sim)[0]!; assert.ok(c);
    c.takeDamage(25); advance(f, 1);
    assert.equal(c.alive, true); assert.equal(c.health, 75); assert.equal(c.clip, 'death');
    assert.ok(f.pedestrians.knockdown(c.id));
    const position = [...c.position]; advance(f, 2 * 60);
    assert.equal(c.desiredVx, 0); assert.equal(c.desiredVz, 0);
    assert.ok(Math.hypot(c.position[0] - position[0]!, c.position[2] - position[2]!) < 0.02);
    assert.ok(f.pedestrians.knockdown(c.id)!.elapsed >= 2);
    advance(f, Math.ceil((CIVILIAN_KNOCKDOWN.fallSeconds + CIVILIAN_KNOCKDOWN.holdSeconds + CIVILIAN_KNOCKDOWN.riseSeconds) * 60));
    assert.equal(f.pedestrians.knockdown(c.id), null); assert.equal(c.health, 75); assert.equal(c.alive, true);
    assert.notEqual(c.clip, 'death');
  } finally { f.sim.world.physics.free(); }
});

test('a fatal hit keeps death permanent and old bodies are removed without unbounded actor residency', () => {
  const f = makeSim();
  try {
    advance(f, 300); const c = civilians(f.sim)[0]!; assert.ok(c);
    c.takeDamage(150); advance(f, 3);
    assert.equal(c.clip, 'death'); assert.equal(c.alive, false); assert.equal(f.pedestrians.knockdown(c.id), null);
    assert.ok(c.deathTicks > 0);
    f.sim.dropIn([1000, 0, 0], 0); advance(f, 10 * 60);
    assert.equal(f.sim.characters.has(c.id), false);
    assert.equal(f.sim.characterOf(c.collider.handle), null);
    assert.ok(civilians(f.sim).length <= PEDESTRIANS.target);
  } finally { f.sim.world.physics.free(); }
});

test('lethal damage during a fall, floor hold or recovery immediately enters permanent death', () => {
  for (const elapsedTicks of [42, 108, 168]) {
    const f = makeSim();
    try {
      advance(f, 300); const c = civilians(f.sim)[0]!;
      f.sim.player.teleport([c.position[0] + 3, c.position[1], c.position[2]], 0);
      c.takeDamage(10); advance(f, 1 + elapsedTicks);
      assert.ok(f.pedestrians.knockdown(c.id), `${elapsedTicks}: live reaction is active`);
      c.takeDamage(c.health);
      const killed = f.sim.state().characters.find(actor => actor.id === c.id)!;
      assert.equal(killed.alive, false); assert.equal(killed.health, 0);
      assert.equal(killed.clip, 'death', 'death is published before the next AI step');
      assert.equal(killed.speed, 0); assert.equal(killed.deathElapsed, 0);
      assert.equal(f.pedestrians.knockdown(c.id), null, 'a corpse cannot expose a recovery timeline');
      assert.equal(c.desiredVx, 0); assert.equal(c.desiredVz, 0);
      const position = [...c.position];
      for (let i = 0; i < 8 * 60; i++) {
        advance(f, 1);
        const corpse = f.sim.state().characters.find(actor => actor.id === c.id)!;
        assert.ok(corpse, 'nearby corpse is retained through the recovery window');
        assert.equal(corpse.alive, false); assert.equal(corpse.health, 0); assert.equal(corpse.clip, 'death');
        assert.ok(Math.abs(corpse.deathElapsed! - (i + 1) / 60) < 1e-12);
        assert.equal(f.pedestrians.knockdown(c.id), null);
        assert.equal(c.desiredVx, 0); assert.equal(c.desiredVz, 0);
      }
      assert.ok(Math.hypot(c.position[0] - position[0]!, c.position[2] - position[2]!) < 0.02, 'death never resumes its walking route');
      const age = c.deathElapsed;
      assert.equal(c.takeDamage(50), 0); assert.equal(c.deathElapsed, age, 'later hits never restart corpse age');
    } finally { f.sim.world.physics.free(); }
  }
});

test('a second hit halfway through getting up reverses the fall without popping to standing', () => {
  const f = makeSim();
  try {
    advance(f, 300); const c = civilians(f.sim)[0]!; assert.ok(c);
    c.takeDamage(10); advance(f, 1); advance(f, 168);
    const rising = f.pedestrians.knockdown(c.id)!;
    assert.ok(Math.abs(rising.elapsed - 2.8) < 0.02, 'halfway through the 1.6 second get-up');
    const beforeProgress = 1 - (rising.elapsed - rising.fallSeconds - rising.holdSeconds) / rising.riseSeconds;
    assert.ok(Math.abs(beforeProgress - 0.5) < 0.02);
    c.takeDamage(10); advance(f, 1);
    const falling = f.pedestrians.knockdown(c.id)!;
    assert.ok(falling.elapsed > 0.5 && falling.elapsed < 0.9, 'continues the existing half-collapsed pose');
    const afterProgress = falling.elapsed / falling.fallSeconds;
    assert.ok(Math.abs(afterProgress - beforeProgress) < 0.025, 'at most a normal fixed-frame pose change');
    assert.equal(c.health, 80); assert.equal(c.alive, true); assert.equal(c.desiredVx, 0); assert.equal(c.desiredVz, 0);
    advance(f, 30);
    const later = f.pedestrians.knockdown(c.id)!;
    assert.ok(later.elapsed / later.fallSeconds > afterProgress + 0.3, 'the interrupted rise now falls toward the floor');
    advance(f, 120);
    assert.ok(f.pedestrians.knockdown(c.id), 're-fall gets a fresh floor hold and recovery');
    advance(f, 100); assert.equal(f.pedestrians.knockdown(c.id), null);
  } finally { f.sim.world.physics.free(); }
});

test('nearby corpses also have a finite lifetime and release their collider mapping', () => {
  const f = makeSim();
  try {
    advance(f, 300); const c = civilians(f.sim)[0]!; assert.ok(c);
    f.sim.player.teleport([c.position[0] + 3, c.position[1], c.position[2]], 0);
    c.takeDamage(150); advance(f, 1); c.deathTicks = PEDESTRIANS.corpseMaximumTicks;
    advance(f, 2);
    assert.equal(f.sim.characters.has(c.id), false); assert.equal(f.sim.characterOf(c.collider.handle), null);
  } finally { f.sim.world.physics.free(); }
});

test('roaming population and knockdowns replay deterministically across district changes', () => {
  const a = makeSim(), b = makeSim();
  try {
    for (const [x, z] of centers) {
      for (const f of [a, b]) { f.sim.dropIn([x, 0, z], 0); advance(f, 360); civilians(f.sim)[0]!.takeDamage(10); advance(f, 300); }
      assert.equal(a.sim.hash(), b.sim.hash());
      assert.equal(a.pedestrians.digest(), b.pedestrians.digest());
      assert.deepEqual(civilians(a.sim).map(c => a.pedestrians.knockdown(c.id)), civilians(b.sim).map(c => b.pedestrians.knockdown(c.id)));
    }
  } finally { a.sim.world.physics.free(); b.sim.world.physics.free(); }
});

test('pedestrians wait for streamed native cells to settle before they may spawn', () => {
  const world = StaticWorld.fromBytes(terrain, roads, gameplay);
  world.enableStreaming(centers.map(([x, z], i) => ({ id: `floor-${i}`, boundsXZ: [x - 160, z - 30, x + 160, z + 30] as const })),
    id => { const [x, z] = centers[Number(id.slice(6))]!; return floor(x, z); });
  const sim = new Simulation(world, { seed: 7 });
  try {
    assert.equal(pedestrianGround(world, [1060, 0, 12]), null);
    world.applyResidency({ insert: ['floor-1'], remove: [] });
    assert.equal(pedestrianGround(world, [1060, 0, 12]), null);
    world.physics.step(); world.markStepped();
    assert.ok(pedestrianGround(world, [1060, 0, 12]));
    assert.equal(civilians(sim).length, 0);
  } finally { world.physics.free(); }
});

test('a post on the footway is stepped around instead of turning the walk back', () => {
  const f = makeSim({ ...roads, lanes: [], footways: [{ id: 'post', points: [[40, 0, 12], [64, 0, 12]] }] });
  try {
    f.sim.world.addCell('post', box('post', 53.6, 11.6, 54.4, 12.4)); f.sim.world.physics.step(); f.sim.world.markStepped();
    advance(f, 150); const c = civilians(f.sim)[0]!; assert.ok(c);
    // Inside the no-birth radius of the only slot: this walker has the footway to itself.
    f.sim.player.teleport([48, 0, 25], 0);
    let crossings = 0, side = Math.sign(c.position[0] - 54), drift = 0;
    for (let i = 0; i < 60 * 60; i++) {
      advance(f, 1);
      const now = Math.sign(c.position[0] - 54);
      if (now && now !== side) { crossings++; side = now; }
      drift = Math.max(drift, Math.abs(c.position[2] - 12));
    }
    const w = walkerOf(f, c.id);
    assert.ok(crossings >= 2, `passes the post both ways: ${crossings}`);
    assert.deepEqual(w.forcedReversals, []); assert.equal(w.limits, null);
    assert.ok(drift < PEDESTRIAN_STEERING.maxOffset + 0.1, `side-steps stay on the footway: ${drift}`);
  } finally { f.sim.world.physics.free(); }
});

test('a footway closed by a wall turns its walker short of the wall after the first bump', () => {
  const f = makeSim({ ...roads, lanes: [], footways: [{ id: 'closed', points: [[40, 0, 12], [80, 0, 12]] }] });
  try {
    f.sim.world.addCell('wall', box('wall', 59.8, 6, 60.2, 18)); f.sim.world.physics.step(); f.sim.world.markStepped();
    advance(f, 150);
    const actors = civilians(f.sim); assert.equal(actors.length, 1, 'the slot right behind the wall is never used'); const c = actors[0]!;
    f.sim.player.teleport([48, 0, 25], 0);
    let turns = 0, bumps = 0, wasBlocked = false, direction = walkerOf(f, c.id).direction, maxX = c.position[0];
    for (let i = 0; i < 120 * 60; i++) {
      advance(f, 1);
      const w = walkerOf(f, c.id), blocked = !w.safeAhead && f.sim.tick >= w.waitUntil && c.clip === 'idle';
      if (blocked && !wasBlocked) bumps++;
      wasBlocked = blocked;
      if (w.direction !== direction) { turns++; direction = w.direction; }
      maxX = Math.max(maxX, c.position[0]);
    }
    const w = walkerOf(f, c.id);
    assert.ok(turns >= 5, `keeps walking out and back: ${turns}`);
    assert.equal(bumps, 1, 'stands at the wall once, then turns before reaching it');
    assert.equal(w.forcedReversals.length, 1); assert.ok(w.limits && w.limits[1] < 20, `${w.limits}`);
    assert.ok(maxX < 59.6, `never walks into the wall: ${maxX}`);
  } finally { f.sim.world.physics.free(); }
});

test('gunfire sends nearby walkers hurrying away along their footway, and they calm down afterwards', () => {
  const f = makeSim();
  try {
    advance(f, 9 * 60);
    const shooter = [...f.sim.player.position];
    const away = (c: { position: readonly number[] }) => Math.abs(c.position[0]! - shooter[0]!);
    const near = civilians(f.sim).filter(c => Math.hypot(c.position[0] - shooter[0]!, c.position[2] - shooter[2]!) < CIVILIAN_PANIC.shotRadius - 5);
    assert.ok(near.length >= 2, `${near.length} walkers within earshot`);
    const before = new Map(near.map(c => [c.id, away(c)]));
    f.sim.step({ ...NEUTRAL, pitch: 1, buttons: Button.fire });
    assert.equal(f.sim.shots.length, 1, 'one shot into the air');
    assert.equal(f.sim.events.filter(e => e.type === 'civilianPanic').length, near.length);
    const peak = new Map(near.map(c => [c.id, 0]));
    for (let i = 0; i < 3 * 60; i++) { advance(f, 1); for (const c of near) peak.set(c.id, Math.max(peak.get(c.id)!, c.speed)); }
    for (const c of near) {
      assert.ok(c.alive && away(c) > before.get(c.id)! + 2, `${c.id} moves away from the shot: ${before.get(c.id)} -> ${away(c)}`);
      assert.ok(peak.get(c.id)! > CIVILIAN_PANIC.runSpeed - 0.1, `${c.id} runs, faster than any walk: ${peak.get(c.id)}`);
    }
    advance(f, CIVILIAN_PANIC.ticks - 3 * 60 + 2 * CIVILIAN_PANIC.calmTicks + 2 * 60);
    for (const c of near) assert.ok(c.speed < 1.35, `${c.id} walks normally again: ${c.speed}`);
  } finally { f.sim.world.physics.free(); }
});

/**
 * A walker at x = `at` on its own footway flees a shot fired `behind` metres back along it, toward a box `height` high
 * and `depth` deep that crosses the footway at x = 66 (none at height 0); or, with `fire` false, just walks on.
 * The footway crosses the floor quad's diagonal, an internal edge of the ground mesh, at x = 64.
 * With `edge`, the native floor ends at x = `edge`, and with `gap`, it is missing between those two x, above `deep`
 * terrain. With `second`, the same shooter fires again from `second` metres behind the walker on the tick after it
 * takes off, while its jump is still on the ground. The box is turned `angle` radians about its middle; with
 * `platform`, the floor ends at the box's middle, turned with it, and beyond it only a strip from z = 12 + `platform[0]`
 * to 12 + `platform[1]` runs along the footway, above `deep` terrain; with `lane` instead, the strip reaches `lane` either
 * side of the line square to the box's face through `at`. With `stand`, the walker is put back at `at` the moment before
 * the shot, where the route cursor has found it. Each of `boxes` (x0, z0, x1, z1, height, a turn in radians and a group,
 * as `box()` takes them, or 'untagged' for a bare collider) stands beside or behind the box as well, and each of `floors`
 * (x, z, half sizes, height and a turn, as `floor()` takes them) lies on the floor or the strip. Each of `people` (x, z)
 * is a person standing still there and each of `vehicles` (x0, z0, x1, z1, bottom, top and a turn) a fixed box in the
 * vehicles' collision group, both in place before the shot; with either, the footway's other walkers wait behind the
 * shooter.
 */
function flee(behind: number, height = 0, depth = 0.4, fire = true, at = 58,
  options: { edge?: number; gap?: readonly [number, number]; second?: number; angle?: number; platform?: readonly [number, number]; lane?: number; stand?: boolean;
    boxes?: readonly (readonly [number, number, number, number, number, number?, (ColliderGroup | 'untagged')?])[];
    floors?: readonly (readonly [number, number, number, number, number, number])[]; people?: readonly (readonly [number, number])[];
    vehicles?: readonly (readonly [number, number, number, number, number, number, number?])[]; hit?: readonly [string, number] } = {}) {
  const { edge, gap, second, angle = 0, platform, lane, stand, boxes = [], floors = [], people = [], vehicles = [], hit } = options;
  const f = makeSim({ ...roads, lanes: [], footways: [{ id: 'flee', points: [[25, 0, 12], [82, 0, 12]] }] }, gameplay, edge === undefined && !gap && !platform && lane === undefined ? terrain : deep);
  try {
    if (platform || lane !== undefined) {
      const [nx, nz] = turned(66 + depth / 2, 12, -40, 0, angle), [lx, lz] = turned(at, 12, 20, 0, angle), [low, high] = platform ?? [0, 0];
      f.sim.world.removeCell('floor-0');
      f.sim.world.addCell('floor-0', floor(nx!, nz!, 40, 30, 0, 'paving', angle));
      f.sim.world.addCell('platform', lane === undefined ? floor(113, 12 + (low + high) / 2, 47, (high - low) / 2) : floor(lx!, lz!, 20, lane, 0, 'paving', angle));
      f.sim.world.physics.step(); f.sim.world.markStepped();
    } else if (edge !== undefined || gap) {
      const end = edge ?? 160, pieces = gap ? [[-160, gap[0]], [gap[1], end]] : [[-160, end]];
      f.sim.world.removeCell('floor-0');
      pieces.forEach(([a, b], i) => f.sim.world.addCell(i ? `floor-0-${i}` : 'floor-0', floor((a! + b!) / 2, 0, (b! - a!) / 2)));
      f.sim.world.physics.step(); f.sim.world.markStepped();
    }
    if (height) { f.sim.world.addCell('obstacle', box('obstacle', 66, 6, 66 + depth, 18, height, angle)); f.sim.world.physics.step(); f.sim.world.markStepped(); }
    boxes.forEach(([x0, z0, x1, z1, high, yaw = 0, group], i) => group === 'untagged' ? bareBox(f.sim.world, x0, z0, x1, z1, high, yaw)
      : f.sim.world.addCell(`box-${i}`, box(`box-${i}`, x0, z0, x1, z1, high, yaw, group)));
    floors.forEach(([x, z, halfX, halfZ, y, yaw], i) => f.sim.world.addCell(`floor-extra-${i}`, floor(x, z, halfX, halfZ, y, 'paving', yaw)));
    if (boxes.length || floors.length) { f.sim.world.physics.step(); f.sim.world.markStepped(); }
    advance(f, 150); const c = civilians(f.sim)[0]!; assert.ok(c);
    // The route cursor finds the walker again within a couple of seconds of being moved.
    c.teleport([at, 0, 12], Math.PI / 2); f.sim.player.teleport([at - behind, 0, 30], 0);
    advance(f, 2 * 60);
    if (stand) {
      // A walker the footway brought to that spot meanwhile goes behind the shooter instead of inside the capsule.
      for (const o of civilians(f.sim)) if (o !== c && Math.hypot(o.position[0] - at, o.position[2] - 12) < 1.5) o.teleport([at - behind - 5, 0, 12], -Math.PI / 2);
      c.teleport([at, 0, 12], Math.PI / 2);
    }
    if (people.length || vehicles.length) {
      civilians(f.sim).filter(o => o !== c).forEach((o, i) => o.teleport([at - behind - 5 - 2 * i, 0, 12], -Math.PI / 2));
      people.forEach(([x, z], i) => f.sim.spawnCharacter(`bystander-${i}`, [x, 0, z], -Math.PI / 2, 100));
      for (const [x0, z0, x1, z1, bottom, top, yaw = 0] of vehicles) {
        f.sim.world.physics.createCollider(RAPIER.ColliderDesc.cuboid((x1 - x0) / 2, (top - bottom) / 2, (z1 - z0) / 2)
          .setTranslation((x0 + x1) / 2, (bottom + top) / 2, (z0 + z1) / 2).setRotation({ x: 0, y: Math.sin(-yaw / 2), z: 0, w: Math.cos(-yaw / 2) })
          .setCollisionGroups(groups(GROUP.vehicle, GROUP.all)),
        f.sim.world.physics.createRigidBody(RAPIER.RigidBodyDesc.fixed()));
      }
    }
    f.sim.player.teleport([c.position[0] - behind, 0, 14], Math.PI / 2);
    advance(f, 2);
    const seen = { vaults: 0, clips: new Set<string>(), phases: new Set<string>(), peak: 0, over: -Infinity, maxX: c.position[0], low: c.position[1], refired: null as string | null,
      starts: [] as number[][], landing: null as readonly number[] | null, flight: -Infinity };
    // Damage in the given jump phase, then how far it moves and rises until it is up again, and where it stands then.
    let knock: { tick: number; at: number[]; jumps: number; drift: number; gain: number; kept: boolean; end: number[] | null; grounded: boolean; moved: number } | null = null;
    for (let i = 0; i <= (fire ? 6 : 60) * 60 + (hit ? 6 * 60 : 0); i++) {
      if (i === 0) { if (fire) f.sim.step({ ...NEUTRAL, pitch: 1, buttons: Button.fire }); else continue; }
      else if (second !== undefined && seen.vaults && seen.refired === null) {
        seen.refired = c.jumpPhase;
        f.sim.player.teleport([c.position[0] - second, 0, 14], Math.PI / 2);
        f.sim.step({ ...NEUTRAL, pitch: 1, buttons: Button.fire });
        assert.equal(f.sim.shots.length, 1, 'the second shot is fired');
      } else advance(f, 1);
      const jumps = f.sim.events.filter(e => e.type === 'civilianVault' && e.detail === c.id).length;
      seen.vaults += jumps; if (jumps) seen.starts.push([...c.position]);
      seen.clips.add(c.clip); seen.phases.add(c.jumpPhase); seen.peak = Math.max(seen.peak, c.speed);
      if (c.position[0] > 66 && c.position[0] < 66 + depth) seen.over = Math.max(seen.over, c.position[1]);
      seen.maxX = Math.max(seen.maxX, c.position[0]); seen.low = Math.min(seen.low, c.position[1]);
      const vault = walkerOf(f, c.id)?.vault;
      if (vault) { seen.landing = vault.landing; seen.flight = Math.max(seen.flight, c.position[0]); }
      if (hit && !knock && seen.vaults && c.jumpPhase === hit[0]) {
        knock = { tick: f.sim.tick, at: [...c.position], jumps: seen.vaults, drift: 0, gain: -Infinity, kept: false, end: null, grounded: false, moved: 0 };
        c.takeDamage(hit[1]);
      } else if (knock && !knock.end) {
        knock.drift = Math.max(knock.drift, Math.hypot(c.position[0] - knock.at[0]!, c.position[2] - knock.at[2]!));
        knock.gain = Math.max(knock.gain, c.position[1] - knock.at[1]!);
        if (vault || c.climb || seen.vaults > knock.jumps) knock.kept = true;
        if (c.alive && !f.sim.pedestrians.knockedDown(c.id)) { knock.end = [...c.position]; knock.grounded = c.grounded; }
      } else if (knock?.end) {
        knock.moved = Math.max(knock.moved, Math.hypot(c.position[0] - knock.end[0]!, c.position[2] - knock.end[2]!));
        if (vault && vault.tick <= knock.tick) knock.kept = true;
      }
    }
    if (knock && !knock.end) { knock.end = [...c.position]; knock.grounded = c.grounded; }
    return { ...seen, c, end: [...c.position], knock };
  } finally { f.sim.world.physics.free(); }
}

test('a walker sprints from a shot close behind and runs from one farther off', () => {
  const close = flee(CIVILIAN_PANIC.sprintRadius - 8), far = flee(CIVILIAN_PANIC.sprintRadius + 10);
  assert.ok(close.clips.has('sprint') && !close.clips.has('run'), `${[...close.clips]}`);
  assert.ok(close.peak > CIVILIAN_PANIC.sprintSpeed - 0.1, `sprints: ${close.peak}`);
  assert.ok(far.clips.has('run') && !far.clips.has('sprint'), `${[...far.clips]}`);
  assert.ok(far.peak > CIVILIAN_PANIC.runSpeed - 0.1 && far.peak < CIVILIAN_PANIC.runSpeed + 0.1, `runs: ${far.peak}`);
  for (const r of [close, far]) assert.ok(r.end[0]! > 75 && r.c.alive && r.vaults === 0, `flees along the footway: ${r.end}`);
});

test('a fleeing walker jumps a low wall across its footway and runs on beyond it', () => {
  const r = flee(10, 0.6);
  assert.equal(r.vaults, 1);
  assert.ok(!r.phases.has('climb'), 'clears it without grabbing the edge');
  assert.ok(r.over > 0.6, `feet above the wall top while over it: ${r.over}`);
  assert.ok(r.end[0]! > 70 && Math.abs(r.end[1]!) < 0.05 && r.c.alive, `back down beyond it: ${r.end}`);
});

test('a walker standing right at a low wall when the shot comes jumps it from a stand', () => {
  const r = flee(10, 0.6, 0.4, true, 65.5);
  assert.equal(r.vaults, 1);
  assert.ok(r.end[0]! > 70 && Math.abs(r.end[1]!) < 0.05 && r.c.alive, `over and away: ${r.end}`);
});

test('a fleeing walker climbs over a chest-high block across its footway', () => {
  const r = flee(30, 1.2, 1);
  assert.ok(r.vaults >= 1 && r.phases.has('climb'), `${r.vaults} jumps, phases ${[...r.phases]}`);
  assert.ok(r.over > 1.15, `stands on top on the way over: ${r.over}`);
  assert.ok(r.end[0]! > 70 && Math.abs(r.end[1]!) < 0.05 && r.c.alive, `back down beyond it: ${r.end}`);
});

/**
 * Hit mid-jump, a walker drops from where it was hit onto the support below: it moves sideways no more than `settle` (to
 * slide off an edge its capsule came down on), gains no height beyond settling onto the floor, and its jump or climb is
 * over for good. `rest` is how far above the support it may come to rest.
 */
function knockedOffJump(r: ReturnType<typeof flee>, support: number, settle = 0.05, rest = 0.05) {
  const k = r.knock;
  assert.ok(k?.end, 'hit during the jump');
  assert.ok(k.drift < settle, `no horizontal progress while down: ${k.drift}`);
  assert.ok(k.gain < 0.01, `no height gained while down: ${k.gain}`);
  assert.equal(k.kept, false, 'the jump or climb ends with the hit and is never taken up again');
  assert.ok(k.grounded && Math.abs(k.end[1]! - support) < rest, `grounded on the support below at the end: ${k.grounded} ${k.end}`);
  return k;
}

test('a walker knocked down as it takes off for a low wall never leaves the ground and walks on after getting up', () => {
  const k = knockedOffJump(flee(10, 0.6, 0.4, true, 58, { hit: ['takeoff', 10] }), 0);
  assert.ok(k.moved > 1, `moves on: ${k.moved}`);
});

test('a walker knocked down rising over a low wall drops straight back to the floor and walks on after getting up', () => {
  const k = knockedOffJump(flee(10, 0.6, 0.4, true, 58, { hit: ['rise', 10] }), 0);
  assert.ok(k.moved > 1, `moves on: ${k.moved}`);
});

test('a walker knocked down coming down past a low wall slides off its far edge to the floor and walks on after getting up', () => {
  const k = knockedOffJump(flee(10, 0.6, 0.4, true, 58, { hit: ['fall', 10] }), 0, CHARACTER.radius);
  assert.ok(k.at[0]! > 66.4 && k.at[0]! < 66.4 + CHARACTER.radius, `hit with the capsule's rim over the far edge: ${k.at}`);
  assert.ok(k.moved > 1, `moves on: ${k.moved}`);
});

test('a walker knocked down climbing a chest-high block lets go of its edge, drops to the floor and walks on after getting up', () => {
  const k = knockedOffJump(flee(30, 1.2, 1, true, 58, { hit: ['climb', 10] }), 0);
  assert.ok(k.moved > 1, `moves on: ${k.moved}`);
});

test('a walker killed rising over a low wall drops straight down where it was hit', () => {
  const r = flee(10, 0.6, 0.4, true, 58, { hit: ['rise', 1000] });
  assert.equal(r.c.alive, false);
  // A body is no longer moved once the controller grounds it, which it can do a few centimetres above standing height.
  knockedOffJump(r, 0, 0.05, 0.08);
});

test('a fleeing walker does not jump at a chest-high fence with no standing room on top', () => {
  const r = flee(10, 1.2, 0.1);
  assert.equal(r.vaults, 0);
  assert.ok(!r.phases.has('climb') && r.maxX < 66 && r.c.alive, `stays on its side: ${r.maxX}`);
});

test('a calm walker never jumps a low wall, it turns back at it', () => {
  const r = flee(10, 0.6, 0.4, false);
  assert.equal(r.vaults, 0);
  assert.deepEqual([...r.phases], ['grounded']);
  assert.ok(r.maxX < 66, `stays on its side: ${r.maxX}`);
});

// The native floor ends 2.1 m or 2.3 m past the low wall, above a 20 m drop.
test('a sprinting walker only jumps a low wall where it lands on the floor beyond it', () => {
  for (const edge of [68.5, 68.7]) {
    const r = flee(CIVILIAN_PANIC.sprintRadius - 10, 0.6, 0.4, true, 58, { edge });
    assert.ok(r.clips.has('sprint'), `${edge}: sprints`);
    assert.ok(r.c.alive && r.low > -1 && r.maxX < edge, `${edge}: ${r.vaults} jumps, stays on the floor: lowest ${r.low}, farthest ${r.maxX}`);
  }
});

test('a walker that jumps at a run lands at the speed its jump was checked for when a second shot makes it sprint', () => {
  for (const edge of [68.5, 68.7]) {
    const r = flee(CIVILIAN_PANIC.sprintRadius + 10, 0.6, 0.4, true, 58, { edge, second: CIVILIAN_PANIC.sprintRadius - 10 });
    // At a run it comes down about a metre short of the edge at 68.7, so that jump is taken.
    if (edge === 68.7) assert.ok(r.vaults >= 1, `${edge}: jumps at a run`);
    if (r.vaults) assert.equal(r.refired, 'takeoff', `${edge}: the second shot comes during take-off`);
    assert.ok(r.c.alive && r.low > -1 && r.maxX < edge, `${edge}: ${r.vaults} jumps, stays on the floor: lowest ${r.low}, farthest ${r.maxX}`);
  }
});

// A sprint from a stand at the wall comes down near 69.4, a metre short of the touchdown predicted for its speed: the
// floor is missing from 68.4 to 69.9, wider than the capsule, above a 20 m drop.
test('a fleeing walker only jumps a low wall where the floor covers every spot it can come down on', () => {
  for (const [start, at] of [['standing', 65.5], ['running', 58]] as const) {
    const r = flee(CIVILIAN_PANIC.sprintRadius - 10, 0.6, 0.4, true, at, { gap: [68.4, 69.9] });
    assert.ok(r.c.alive && r.low > -1, `${start}: ${r.vaults} jumps, stays on the floor: lowest ${r.low}, end ${r.end}`);
  }
});

test('a walker standing at a low wall still jumps it when the floor is missing only beyond where it can come down', () => {
  const r = flee(CIVILIAN_PANIC.sprintRadius - 10, 0.6, 0.4, true, 65.5, { gap: [71.2, 72.6] });
  assert.equal(r.vaults, 1);
  assert.ok(r.c.alive && r.low > -1 && r.end[0]! > 67 && r.maxX < 71.2, `over the wall, short of the gap: lowest ${r.low}, end ${r.end}, farthest ${r.maxX}`);
});

/** Where a walker stands on the footway with its capsule `gap` short of the face of a 0.4 m deep box turned `angle` radians. */
const atFace = (angle: number, gap: number) => 66.2 - (0.2 + CHARACTER.radius + CHARACTER_SKIN + gap) / Math.cos(angle);

// Pressed against a face turned 30° off its way, the controller slides a walker along it until the jump clears the top.
// Beyond the wall a strip of floor runs on along the footway, reaching 0.39 m toward the side the face slides it to.
test('a walker at a wall turned off square to its footway jumps it only onto support checked for where it comes down', () => {
  for (const [start, degrees, at, stand] of [['standing', 30, atFace(Math.PI / 6, 0.005), true], ['running', 58, 58, false]] as const) {
    const r = flee(CIVILIAN_PANIC.sprintRadius - 10, 0.6, 0.4, true, at, { angle: degrees * Math.PI / 180, platform: [-0.39, 2], stand });
    assert.ok(r.c.alive && r.low > -1, `${start} at ${degrees}°: ${r.vaults} jumps, stays on the strip: lowest ${r.low}, end ${r.end}`);
  }
  // A strip 1 m wide laid square to the face from where the walker stands is the support it jumps onto.
  for (const degrees of [30, 58]) {
    const angle = degrees * Math.PI / 180, r = flee(CIVILIAN_PANIC.sprintRadius - 10, 0.6, 0.4, true, atFace(angle, 0.18), { angle, lane: 0.5, stand: true });
    assert.ok(r.vaults >= 1 && r.c.alive && r.low > -1, `standing at ${degrees}° before a strip square to the face: ${r.vaults} jumps, lowest ${r.low}, end ${r.end}`);
  }
});

test('a fleeing walker jumps a low wall turned off square to its footway and comes down beyond it', () => {
  for (const degrees of [30, 58]) {
    const angle = degrees * Math.PI / 180;
    for (const [start, at, stand] of [['standing', atFace(angle, 0.18), true], ['running', 58, false]] as const) {
      const r = flee(CIVILIAN_PANIC.sprintRadius - 10, 0.6, 0.4, true, at, { angle, stand });
      const beyond = (r.end[0]! - 66.2) * Math.cos(angle) + (r.end[2]! - 12) * Math.sin(angle);
      assert.ok(r.vaults >= 1 && r.c.alive && beyond > 1 && Math.abs(r.end[1]!) < 0.05, `${start} at ${degrees}°: ${r.vaults} jumps, end ${r.end}`);
    }
  }
});

// A slab 3 m high turned 45° stands just behind the wall, across the footway, and beyond the wall only a strip of floor
// 1 m wide runs on above `deep` terrain: run into, the slab's turned face slides the walker off the strip.
test('a fleeing walker does not jump a low wall into a post standing just behind it', () => {
  const r = flee(CIVILIAN_PANIC.sprintRadius - 10, 0.6, 0.4, true, 58, { platform: [-0.5, 0.5], boxes: [[66.5, 11.6, 66.7, 12.4, 3, Math.PI / 4]] });
  assert.ok(r.c.alive && r.low > -1, `${r.vaults} jumps, stays on the strip: lowest ${r.low}, end ${r.end}`);
});

// A bollard 0.9 m high a little behind the wall is lower than the flight but in the way of the walker's legs.
test('a fleeing walker does not jump a low wall where a bollard behind it stands in the way of its legs', () => {
  const r = flee(CIVILIAN_PANIC.sprintRadius - 10, 0.6, 0.4, true, 58, { boxes: [[66.8, 11.9, 67, 12.1, 0.9]] });
  assert.ok(r.vaults === 0 && r.c.alive && r.low > -1, `${r.vaults} jumps, lowest ${r.low}, end ${r.end}`);
});

// The swept space reaches the controller's contact margin past the capsule's skin, 0.4 m from the path's middle (the
// controller grounds on what comes that close under the feet; sideways only what gets inside the skin pushes it): a post
// 0.36 m off stops the jump there (turned away from the wall, the walker may still jump it from where the post is 0.4 m
// clear), one 0.42 m off does not.
test('a fleeing walker jumps a low wall past a post standing just clear of its path', () => {
  const near = flee(CIVILIAN_PANIC.sprintRadius - 10, 0.6, 0.4, true, 58, { boxes: [[66.8, 12.36, 67, 12.56, 3]] });
  const off = (p: number[]) => Math.max(12.36 - p[2]!, p[2]! - 12.56);
  assert.ok(near.c.alive && near.starts.every(p => off(p) > 0.399), `a post 0.36 m off the path: jumps with it ${near.starts.map(off)} off, end ${near.end}`);
  const clear = flee(CIVILIAN_PANIC.sprintRadius - 10, 0.6, 0.4, true, 58, { boxes: [[66.8, 12.42, 67, 12.62, 3]] });
  assert.ok(clear.vaults >= 1 && clear.c.alive && clear.end[0]! > 67 && Math.abs(clear.end[1]!) < 0.05, `a post 0.42 m off the path: ${clear.vaults} jumps, end ${clear.end}`);
});

// The same slab as walkable ground, a kerb or a collider with no surface tags (which the world takes for terrain): what the
// walker could stand on counts as soon as it rises into the jump's way.
test('a fleeing walker does not jump a low wall into a ground, kerb or untagged slab standing just behind it', () => {
  const f = makeSim();
  try { assert.equal(f.sim.world.surfaceAt(bareBox(f.sim.world, 66.5, 11.6, 66.7, 12.4, 3, Math.PI / 4).handle, null)?.group, 'terrain'); }
  finally { f.sim.world.physics.free(); }
  for (const group of ['ground', 'kerbs', 'untagged'] as const) {
    const r = flee(CIVILIAN_PANIC.sprintRadius - 10, 0.6, 0.4, true, 58, { platform: [-0.5, 0.5], boxes: [[66.5, 11.6, 66.7, 12.4, 3, Math.PI / 4, group]] });
    assert.ok(r.c.alive && r.low > -1, `${group}: ${r.vaults} jumps, stays on the strip: lowest ${r.low}, end ${r.end}`);
  }
});

// Beyond the wall the strip steps up along an edge turned 45° across it, where the walker comes down. A step 0.04 m high
// is within CIVILIAN_VAULT.supportRise and is jumped onto; one 0.06 m high would catch a falling capsule's rounded bottom
// and push it sideways, so the jump is not taken.
test('a fleeing walker jumps onto a strip with a step within the support tolerance and not onto one above it', () => {
  const step = (high: number) => [68.7 + 6 * Math.SQRT1_2, 12 + 6 * Math.SQRT1_2, 6, 6, high, Math.PI / 4] as const;
  const within = flee(CIVILIAN_PANIC.sprintRadius - 10, 0.6, 0.4, true, 58, { platform: [-0.5, 0.5], floors: [step(0.04)] });
  assert.ok(within.vaults >= 1 && within.c.alive && within.low > -1 && within.end[0]! > 67, `a 0.04 m step: ${within.vaults} jumps, lowest ${within.low}, end ${within.end}`);
  const above = flee(CIVILIAN_PANIC.sprintRadius - 10, 0.6, 0.4, true, 58, { platform: [-0.5, 0.5], floors: [step(0.06)] });
  assert.ok(above.vaults === 0 && above.c.alive && above.low > -1, `a 0.06 m step: ${above.vaults} jumps, lowest ${above.low}, end ${above.end}`);
});

// From the low wall's middle on, the native floor lies at `y` while the footway's route stays at 0 (the reviewer's case,
// 14-final-review, is 1.1 m down).
const lowerFloor = (y: number) => flee(CIVILIAN_PANIC.sprintRadius - 10, 0.6, 0.4, true, 58, { edge: 66.2, floors: [[86.2, 12, 20, 30, y, 0]] });

for (const y of [-1.1, -0.6]) {
  test(`a fleeing walker does not jump a low wall onto ground at Y ${y}, more than the level tolerance below its route`, () => {
    const r = lowerFloor(y);
    assert.equal(r.vaults, 0, 'no jump');
    assert.ok(r.c.alive && r.low > -CIVILIAN_VAULT.levelTolerance, `stays at its route's level: lowest ${r.low}, end ${r.end}`);
  });
}

// The touchdown is checked for a landing at the route's level; one lower comes down later, but the jump drives no farther
// than that touchdown, so the walker stays inside the checked support, `stop` short of its end.
for (const y of [0, -0.3, -0.39]) {
  test(`a fleeing walker jumps a low wall onto ground at Y ${y}, within the level tolerance of its route`, () => {
    const r = lowerFloor(y);
    assert.equal(r.vaults, 1, 'jumps');
    assert.ok(r.c.alive && r.end[0]! > 70 && Math.abs(r.end[1]! - y) < 0.05, `down on the floor beyond it: ${r.end}`);
    assert.ok(r.landing && r.flight > 66.4 && r.flight <= r.landing[0]! + 1e-3, `jumped to ${r.flight}, touchdown checked at ${r.landing}`);
  });
}

// The reviewer's case (07-slice-review): another walker the footway brought between the jumper and the block, 1.25 m
// ahead when it takes off, pushes the climbing capsule sideways off the strip unless the jump counts people in its way.
test('a fleeing walker does not climb a block with another walker standing in its way to it', () => {
  const r = flee(10, 1.2, 1, true, 58, { platform: [-0.5, 0.5] });
  assert.ok(r.c.alive && r.low > -1, `${r.vaults} jumps, stays on the strip: lowest ${r.low}, end ${r.end}`);
});

// A person standing still between the walker and a low wall, just off its line, is in the space the jump sweeps: the
// jump is not taken, or it comes down on the strip.
test('a fleeing walker does not jump a low wall into a person standing in front of it', () => {
  const r = flee(10, 0.6, 0.4, true, 58, { platform: [-0.5, 0.5], people: [[65.27, 11.84]] });
  assert.ok(r.c.alive && r.low > -1, `${r.vaults} jumps, stays on the strip: lowest ${r.low}, end ${r.end}`);
});

// The same with the corner of a car there: a fixed box in the vehicles' collision group, turned 45°.
test('a fleeing walker does not jump a low wall into a car standing in front of it', () => {
  const r = flee(10, 0.6, 0.4, true, 58, { platform: [-0.5, 0.5], vehicles: [[64.97, 11.54, 65.57, 12.14, 0, 1.4, Math.PI / 4]] });
  assert.ok(r.c.alive && r.low > -1, `${r.vaults} jumps, stays on the strip: lowest ${r.low}, end ${r.end}`);
});

// A person and a car standing clear either side of its path leave the jump as it was.
test('a fleeing walker still jumps a low wall with a person and a car standing clear beside its path', () => {
  const r = flee(10, 0.6, 0.4, true, 58, { platform: [-0.5, 0.5], people: [[65.27, 13.2]], vehicles: [[64.97, 10.5, 65.57, 11.1, 0, 1.4, Math.PI / 4]] });
  assert.ok(r.vaults === 1 && r.c.alive && r.low > -1 && r.end[0]! > 75, `${r.vaults} jumps, lowest ${r.low}, end ${r.end}`);
});

test('the speed and touchdown a jump was checked for are part of the walker digest', () => {
  const f = makeSim();
  try {
    advance(f, 300); const c = civilians(f.sim)[0]!; assert.ok(c);
    const w = (Reflect.get(f.pedestrians, 'active') as Map<string, { vault: object | null }>).get(c.id)!;
    const landing = [c.position[0] + 3, c.position[1], c.position[2]];
    const vault = { dir: [1, 0], start: [...c.position], tick: f.sim.tick, speed: CIVILIAN_PANIC.runSpeed, landing };
    w.vault = vault; const digest = f.pedestrians.digest();
    w.vault = { ...vault, speed: CIVILIAN_PANIC.sprintSpeed };
    assert.notEqual(f.pedestrians.digest(), digest, 'a different checked speed');
    w.vault = { ...vault, landing: [landing[0]! + 0.5, landing[1], landing[2]] };
    assert.notEqual(f.pedestrians.digest(), digest, 'a different checked touchdown');
    w.vault = { ...vault };
    assert.equal(f.pedestrians.digest(), digest);
  } finally { f.sim.world.physics.free(); }
});

test('a bullet kills a civilian outright, whoever fired it, and the body stays where it fell', () => {
  for (const shooter of ['player', 'officer-stray']) {
    const f = makeSim();
    try {
      advance(f, 300); const c = civilians(f.sim)[0]!; assert.ok(c);
      const shot = f.sim.resolveShot(shooter, { origin: [c.position[0], c.position[1] + 1.4, c.position[2] - 5], end: c.centre,
        colliderHandle: c.collider.handle, headshot: false, distance: 5 }, f.sim.weapon('pistol'));
      assert.equal(shot.hitId, c.id);
      assert.equal(c.alive, false, `${shooter}: one body shot is lethal`); assert.equal(c.health, 0);
      const fell = [...c.position], x = c.position[0] > 0 ? -1 : 1;
      // Out of view but within the corpse radius: the body is kept past its minimum time.
      f.sim.player.teleport([c.position[0] + x * 50, 0, 0], 0);
      advance(f, PEDESTRIANS.corpseMinimumTicks + 10 * 60);
      assert.equal(f.sim.characters.get(c.id), c);
      assert.equal(c.alive, false); assert.equal(c.clip, 'death'); assert.equal(f.pedestrians.knockdown(c.id), null);
      assert.ok(Math.hypot(c.position[0] - fell[0]!, c.position[2] - fell[2]!) < 0.05, 'never gets up and walks on');
      f.sim.player.teleport([c.position[0] + x * (PEDESTRIANS.corpseRetireDistance + 20), 0, 0], 0);
      advance(f, 2);
      assert.equal(f.sim.characters.has(c.id), false, 'retired once the player has left it behind');
    } finally { f.sim.world.physics.free(); }
  }
});

test('optional immutable native city supports roaming civilians in six separated districts', { skip: !process.env.HELSINKI_TEST_WORLD }, () => {
  const root = process.env.HELSINKI_TEST_WORLD!;
  const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8')) as WorldManifest;
  const payload = (ref: { path: string; compression?: string }): Uint8Array => {
    const bytes = readFileSync(path.join(root, ref.path)); return ref.compression === 'gzip' ? gunzipSync(bytes) : bytes;
  };
  const roadGraph = decodeRoadGraph(payload(manifest.roads));
  // The immutable old world supplies native surfaces; the explicit variant field exercises the new source.
  const content = { ...JSON.parse(new TextDecoder().decode(payload(manifest.gameplay))), civilianVariants: CIVILIAN_VARIANTS } as GameplayBundle;
  const terrainBytes = payload(manifest.terrain), cells = new Map(manifest.cells.map(c => [c.id, c]));
  const cache = new Map<string, Uint8Array>();
  for (const [label, x, z] of [['Senate Square', 0, 0], ['Esplanadi', -350, 260], ['Mannerheimintie', -850, -500],
    ['Hakaniemi', -280, -1250], ['Aleksanterin teatteri', -1050, 670], ['Northern Hameentie', 630, -2150]] as const) {
    const world = StaticWorld.fromBytes(terrainBytes, roadGraph, content);
    world.enableStreaming(collisionCellRefs(manifest.cells)!, id => {
      let bytes = cache.get(id); if (!bytes) { bytes = payload(cells.get(id)!.collision); cache.set(id, bytes); } return bytes;
    });
    const sim = new Simulation(world, { seed: 20261022 });
    const f = { sim, pedestrians: sim.pedestrians };
    try {
      sim.dropIn([x, world.groundHeight(x, z) + 1, z], 0); advance(f, 600);
      const actors = civilians(sim); assert.ok(actors.length >= 2, `${label}: local civilians`);
      assert.ok(actors.length <= PEDESTRIANS.target); assert.ok(actors.every(c => c.alive && c.position[1] > content.killHeight));
      const before = new Map(actors.map(c => [c.id, [...c.position]])); advance(f, 300);
      assert.ok(civilians(sim).some(c => before.has(c.id) && Math.hypot(c.position[0] - before.get(c.id)![0]!, c.position[2] - before.get(c.id)![2]!) > 1), `${label}: walks on actual collision`);
      console.log(`Native civilians ${label}: ${actors.length} local actors, movement observed`);
    } finally { world.physics.free(); }
  }
});


test('qualified coverage excludes pedestrian births and support inside a canal over otherwise valid ground', () => {
  const content: GameplayBundle = { ...gameplay, supportedArea: { schemaVersion: 1, regions: [{ id: 'city',
    outer: [[-1800,-1800],[1800,-1800],[1800,1800],[-1800,1800]], holes: [[[80,-20],[90,-20],[90,20],[80,20]]] }] } };
  const f = makeSim(roads, content);
  try {
    assert.equal(pedestrianGround(f.sim.world, [85, 0, 12]), null);
    assert.ok(pedestrianGround(f.sim.world, [70, 0, 12]));
    advance(f, 600);
    assert.ok(civilians(f.sim).length > 0, 'qualified sidewalks still populate');
    assert.ok(civilians(f.sim).every(c => c.position[0] < 80 || c.position[0] > 90 || Math.abs(c.position[2]) > 20));
  } finally { f.sim.world.physics.free(); }
});
