import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { before, test } from 'node:test';
import { decodeRoadGraph, encodeCollisionBundle, encodeTerrain, pointAlong, type GameplayBundle, type RoadGraph, type RoadLane, type WorldManifest } from '@helsinki/world-schema';
import { collisionCellRefs, initPhysics, NEUTRAL, Simulation, StaticWorld, wrapAngle } from '../src/index.ts';
import { CIVILIAN_KNOCKDOWN, CIVILIAN_VARIANTS, PEDESTRIANS, cityPedestrianRoutes, civilianVariant, pedestrianGround, pedestrianRouteCoordinate } from '../src/pedestrians.ts';

const source = JSON.parse(readFileSync(new URL('../../../content/helsinki/gameplay.json', import.meta.url), 'utf8'));
const terrain = encodeTerrain({ x0: -1800, z0: -1800, resolution: 100, nx: 37, nz: 37, heights: new Float32Array(37 * 37) });
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
function floor(x: number, z: number, halfX = 160, halfZ = 30, y = 0, tag = 'paving') {
  return encodeCollisionBundle({ originId: 't', frame: 'X-east,Y-up,Z-south', cell: 'fixture', surfaceTags: [tag] }, [{
    id: 'floor', group: 'ground', ref: null, positions: new Float32Array([x - halfX, y, z - halfZ, x + halfX, y, z - halfZ, x + halfX, y, z + halfZ, x - halfX, y, z + halfZ]),
    indices: new Uint32Array([0, 2, 1, 0, 3, 2]), triangleTags: new Uint16Array([0, 0]),
  }]);
}
function makeSim(graph = roads, content = gameplay) {
  const world = StaticWorld.fromBytes(terrain, graph, content);
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
