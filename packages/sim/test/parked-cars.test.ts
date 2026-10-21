import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { before, test } from 'node:test';
import { encodeCollisionBundle, encodeTerrain, type GameplayBundle, type RoadGraph, type RoadLane } from '@helsinki/world-schema';
import { Button, initPhysics, NEUTRAL, Simulation, StaticWorld } from '../src/index.ts';
import { cityParkingSlots, PARKED_CARS } from '../src/parked-cars.ts';

const source = JSON.parse(readFileSync(new URL('../../../content/helsinki/gameplay.json', import.meta.url), 'utf8'));
const terrain = encodeTerrain({ x0: -1800, z0: -1800, resolution: 100, nx: 37, nz: 37, heights: new Float32Array(37 * 37) });
const centers = [[0, 0], [1000, 0], [0, -1000], [-1000, 0]] as const;
const lane = (id: string, x: number, z: number): RoadLane => ({ id, wayId: 1, name: id, highway: 'residential', surface: 'asphalt', speedLimit: 10, width: 3,
  from: `${id}-a`, to: `${id}-b`, points: [[x - 150, 0, z], [x + 150, 0, z]], length: 300, index: 0, count: 1 });
const roads: RoadGraph = { schemaVersion: 2, originId: 't', source: { id: 'fixture', sha256: 'x', attribution: 'fixture', license: 'fixture' },
  lanes: centers.map(([x, z], i) => lane(`street-${i}`, x, z)), nodes: [], connectors: [], footways: [],
  parking: centers.map(([x, z], i) => ({ id: `lot-${i}`, kind: 'area', heading: 90,
    points: Array.from({ length: 20 }, (_, j) => [x - 114 + j * 12, 0, z + 8] as [number, number, number]) })) };
const gameplay: GameplayBundle = { ...source, schemaVersion: 2, originId: 't',
  playArea: { minX: -1800, maxX: 1800, minZ: -1800, maxZ: 1800 },
  player: { ...source.player, spawn: { position: [0, 0], headingDeg: 0 } }, vehicles: [],
  police: { ...source.police, initialPatrols: 0 }, wanted: { ...source.wanted, unitCaps: [0, 0, 0, 0, 0] }, addresses: [] };
function floor(x: number, z: number, halfX = 160, halfZ = 30, y = 0, tag = 'road:asphalt') {
  return encodeCollisionBundle({ originId: 't', frame: 'X-east,Y-up,Z-south', cell: 'fixture', surfaceTags: [tag] }, [{
    id: 'floor', group: 'ground', ref: null, positions: new Float32Array([x - halfX, y, z - halfZ, x + halfX, y, z - halfZ, x + halfX, y, z + halfZ, x - halfX, y, z + halfZ]),
    indices: new Uint32Array([0, 2, 1, 0, 3, 2]), triangleTags: new Uint16Array([0, 0]),
  }]);
}
function makeSim() {
  const world = StaticWorld.fromBytes(terrain, roads, gameplay);
  centers.forEach(([x, z], i) => world.addCell(`floor-${i}`, floor(x, z)));
  return new Simulation(world, { seed: 7 });
}
function advance(sim: Simulation, n: number) { for (let i = 0; i < n; i++) sim.step(NEUTRAL); }
const ambient = (sim: Simulation) => [...sim.vehicles.values()].filter(v => v.id.startsWith('city-car-'));
before(initPhysics);

test('nearby stealable cars populate distant districts and old cars retire within the population cap', () => {
  const sim = makeSim();
  try {
    let previous: string[] = [];
    for (const [x, z] of centers) {
      sim.dropIn([x, 0, z], 0); advance(sim, 9 * 60);
      const cars = ambient(sim);
      assert.ok(cars.length >= 5, 'several cars appear in every distant district');
      assert.ok(cars.length <= PARKED_CARS.target);
      assert.ok(cars.every(v => Math.hypot(v.position[0] - x, v.position[2] - z) < 160));
      assert.ok(cars.every(v => v.def.role === 'civilian' && !v.driver && v.occupants.size === 0 && v.wheelsInContact === 4));
      for (const id of previous) assert.equal(sim.vehicles.has(id), false, 'old district releases its dynamic bodies');
      previous = cars.map(v => v.id);
    }
  } finally { sim.world.physics.free(); }
});

test('an ambient car uses the normal entry, theft and driving path and remains owned while driven', () => {
  const sim = makeSim();
  try {
    advance(sim, 180);
    const vehicle = ambient(sim)[0]!;
    assert.ok(vehicle);
    const stage = vehicle.localToWorld([2.1, 0, -0.95]);
    sim.player.teleport([stage[0], 0, stage[2]], vehicle.yaw); advance(sim, 30);
    sim.step({ ...NEUTRAL, buttons: Button.interact });
    for (let i = 0; i < 800 && sim.mode === 'entering'; i++) sim.step(NEUTRAL);
    assert.equal(sim.mode, 'driving'); assert.equal(sim.player.inVehicle, vehicle.id);
    assert.ok(sim.log.some(e => e.type === 'enterVehicle' && e.detail === vehicle.id));
    vehicle.body.setTranslation({ x: 1000, y: 0.25, z: 0 }, true);
    advance(sim, 360);
    assert.equal(sim.vehicles.get(vehicle.id), vehicle); assert.equal(vehicle.driver, 'player');
    assert.ok(sim.vehicles.size <= PARKED_CARS.target);
  } finally { sim.world.physics.free(); }
});

test('local population spawns reject fallback terrain, water, partial support, wrong levels, solids and occupied footprints', () => {
  const sim = makeSim();
  try {
    const attempt = (x: number, z: number, y = 0) => sim.trySpawnVehicle(`probe-${x}-${z}`, 'lumi-gt', [x, z], 0, y);
    assert.equal(attempt(500, 500), null, 'heightfield outside authored ground is not support');
    assert.equal(attempt(0, 0, 6), null, 'lower floor cannot stand in for an upper road');
    assert.equal(attempt(1801, 0), null, 'outside map does not relocate to start');
    sim.world.addCell('water', floor(500, 500, 20, 20, 0, 'water'));
    sim.world.addCell('tiny', floor(600, 600, 0.5, 0.5));
    sim.world.physics.step(); sim.world.markStepped();
    assert.equal(attempt(500, 500), null); assert.equal(attempt(600, 600), null);
    const first = attempt(60, 10)!; assert.ok(first);
    sim.world.physics.step(); sim.world.markStepped();
    assert.equal(attempt(60, 10), null, 'a car cannot overlap a dynamic car');
    assert.equal(attempt(0, 0), null, 'a car cannot overlap the player');
    assert.equal(sim.vehicles.size, 1, 'rejected proposals leave no bodies behind');
  } finally { sim.world.physics.free(); }
});

test('curb proposals use outer ordinary-road lanes and leave junctions and travel lanes clear', () => {
  const slots = cityParkingSlots({ ...roads, parking: [], lanes: [roads.lanes[0]!,
    { ...roads.lanes[0]!, id: 'inside', index: 0, count: 2 }, { ...roads.lanes[0]!, id: 'motorway', highway: 'motorway' }] });
  assert.ok(slots.length > 0);
  assert.ok(slots.every(s => s.id.startsWith('curb:street-0:') && s.position[2] > 2.9));
  const sim = makeSim();
  try {
    advance(sim, 600);
    assert.ok(ambient(sim).every(v => Math.abs(v.position[2]) > 2.9));
  } finally { sim.world.physics.free(); }
});

test('parked population and retirement replay deterministically across multiple district visits', () => {
  const a = makeSim(), b = makeSim();
  try {
    for (const [x, z] of [...centers, centers[0]]) {
      for (const sim of [a, b]) { sim.dropIn([x, 0, z], 0); advance(sim, 240); }
      assert.equal(a.hash(), b.hash());
    }
  } finally { a.world.physics.free(); b.world.physics.free(); }
});

test('new local cars wait for streamed collision to become queryable and protect entry reservations during retirement', () => {
  const world = StaticWorld.fromBytes(terrain, roads, gameplay);
  const refs = centers.map(([x, z], i) => ({ id: `floor-${i}`, boundsXZ: [x - 160, z - 30, x + 160, z + 30] as const }));
  world.enableStreaming(refs, id => { const i = Number(id.slice(6)), [x, z] = centers[i]!; return floor(x, z); });
  const sim = new Simulation(world, { seed: 7 });
  try {
    assert.equal(sim.trySpawnVehicle('remote', 'lumi-gt', [1060, 10], 0, 0), null, 'fallback floor cannot stand in for a nonresident cell');
    world.applyResidency({ insert: ['floor-1'], remove: [] });
    assert.equal(sim.trySpawnVehicle('remote', 'lumi-gt', [1060, 10], 0, 0), null, 'new colliders wait for the physics broadphase');
    world.physics.step(); world.markStepped();
    const remote = sim.trySpawnVehicle('remote', 'lumi-gt', [1060, 10], 0, 0)!; assert.ok(remote);
    assert.ok(sim.removeVehicle(remote));
    advance(sim, 180);
    const vehicle = ambient(sim)[0]!, stage = vehicle.localToWorld([2.1, 0, -0.95]);
    sim.player.teleport([stage[0], 0, stage[2]], vehicle.yaw); advance(sim, 30);
    sim.step({ ...NEUTRAL, buttons: Button.interact });
    assert.equal(sim.mode, 'entering');
    // Make it a retirement candidate while the same entry animation still owns it.
    sim.player.teleport([1000, 0, 0], 0);
    sim.tick += PARKED_CARS.retireAfterTicks + PARKED_CARS.refreshTicks;
    sim.tick = Math.ceil(sim.tick / PARKED_CARS.refreshTicks) * PARKED_CARS.refreshTicks + 1;
    sim.parkedCars.step();
    assert.equal(sim.vehicles.get(vehicle.id), vehicle, 'retirement cannot delete a car reserved by entry');
  } finally { world.physics.free(); }
});
