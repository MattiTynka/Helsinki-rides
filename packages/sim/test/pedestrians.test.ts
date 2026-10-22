import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { before, test } from 'node:test';
import { decodeRoadGraph, encodeCollisionBundle, encodeTerrain, type GameplayBundle, type RoadGraph, type RoadLane, type WorldManifest } from '@helsinki/world-schema';
import { collisionCellRefs, initPhysics, NEUTRAL, Simulation, StaticWorld } from '../src/index.ts';
import { CIVILIAN_KNOCKDOWN, CIVILIAN_VARIANTS, PEDESTRIANS, cityPedestrianRoutes, civilianVariant, pedestrianGround } from '../src/pedestrians.ts';

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

test('walkers turn around before native support ends and never follow a footway into fallback terrain', () => {
  const f = makeSim({ ...roads, lanes: [], footways: [{ id: 'past-edge', points: [[40, 0, 12], [400, 0, 12]] }] });
  try {
    advance(f, 60 * 60);
    const actors = civilians(f.sim); assert.ok(actors.length > 0);
    assert.ok(actors.every(c => c.position[0] < 159.5 && c.position[1] > -0.1 && c.grounded));
    assert.ok(actors.every(c => c.position[0] > 38));
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
