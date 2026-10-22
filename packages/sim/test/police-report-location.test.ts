import assert from 'node:assert/strict';
import fs from 'node:fs';
import { before, test } from 'node:test';
import { encodeCollisionBundle, encodeTerrain, type GameplayBundle, type RoadGraph } from '@helsinki/world-schema';
import { Button, initPhysics, NEUTRAL, Simulation, StaticWorld, WantedState, type V3 } from '../src/index.ts';

before(initPhysics);
const base = JSON.parse(fs.readFileSync(new URL('../../../content/helsinki/gameplay.json', import.meta.url), 'utf8')) as GameplayBundle;
function makeSim() {
  const roads: RoadGraph = { schemaVersion: 2, originId: 'report-test', source: { id: 'fixture', sha256: 'x', attribution: 'fixture', license: 'CC0' }, nodes: [], parking: [], footways: [],
    lanes: [
      { id: 'east', wayId: 1, index: 0, count: 1, name: 'street', highway: 'primary', surface: 'asphalt', speedLimit: 10, width: 4, points: [[-250, 0, -6], [250, 0, -6]], length: 500, from: 'w', to: 'e' },
      { id: 'west', wayId: 2, index: 0, count: 1, name: 'street', highway: 'primary', surface: 'asphalt', speedLimit: 10, width: 4, points: [[250, 0, 6], [-250, 0, 6]], length: 500, from: 'e', to: 'w' },
    ], connectors: [
      { id: 'turn-e', from: 'east', to: 'west', node: 'e', points: [[250, 0, -6], [250, 0, 6]], length: 12, turn: 'u-turn' },
      { id: 'turn-w', from: 'west', to: 'east', node: 'w', points: [[-250, 0, 6], [-250, 0, -6]], length: 12, turn: 'u-turn' },
    ] };
  const gameplay: GameplayBundle = { ...base, originId: 'report-test', killHeight: -30, civilianVariants: [],
    playArea: { minX: -300, maxX: 300, minZ: -200, maxZ: 200 }, player: { ...base.player, spawn: { position: [0, 25], headingDeg: 90 } },
    vehicles: [{ id: 'first-car', definition: 'lumi-gt', position: [0, 25], headingDeg: 90, occupied: false }],
    police: { ...base.police, initialPatrols: 0 }, wanted: { ...base.wanted, unitCaps: [1, 2, 3, 4, 5] } };
  const terrain = encodeTerrain({ x0: -300, z0: -200, resolution: 10, nx: 61, nz: 41, heights: new Float32Array(61 * 41) });
  const world = StaticWorld.fromBytes(terrain, roads, gameplay);
  world.addCell('flat', encodeCollisionBundle({ originId: 'report-test', frame: 'X-east,Y-up,Z-south', cell: 'flat', surfaceTags: ['road:asphalt'] }, [{ id: 'ground', group: 'ground', ref: null,
    positions: new Float32Array([-300, 0, -200, 300, 0, -200, 300, 0, 200, -300, 0, 200]), indices: new Uint32Array([0, 2, 1, 0, 3, 2]), triangleTags: new Uint16Array([0, 0]) }]));
  return new Simulation(world, { seed: 12 });
}

test('a completed theft followed by real driving dispatches to the crime site, not the unseen current car', () => {
  const sim = makeSim();
  try {
    const car = sim.vehicles.get('first-car')!, beside = car.localToWorld([2.1, 0, -.95]);
    sim.player.teleport([beside[0], 0, beside[2]], car.yaw);
    for (let i = 0; i < 30; i++) sim.step(NEUTRAL);
    sim.step({ ...NEUTRAL, buttons: Button.interact }); assert.equal(sim.mode, 'entering');
    for (let i = 0; i < 800 && sim.mode === 'entering'; i++) sim.step(NEUTRAL);
    assert.equal(sim.mode, 'driving');
    const incident = [...sim.playerPosition], tick = sim.tick;
    for (let i = 0; i < 362 && !sim.log.some(e => e.type === 'crime' && e.detail === 'takeCar'); i++) sim.step({ ...NEUTRAL, moveZ: 1 });
    const report = sim.log.find(e => e.type === 'crime' && e.detail === 'takeCar'); assert.ok(report);
    assert.ok(report.tick - tick >= 180 && report.tick - tick <= 360);
    assert.ok(Math.hypot(sim.playerPosition[0] - incident[0]!, sim.playerPosition[2] - incident[2]!) > 30);
    assert.ok(Math.hypot(sim.wanted.lastSeen![0] - incident[0]!, sim.wanted.lastSeen![2] - incident[2]!) < .01);
    sim.step({ ...NEUTRAL, moveZ: 1 });
    const unit = sim.police.units[0]!; assert.ok(unit); assert.equal(unit.sees, false);
    assert.ok(unit.dispatchTarget && Math.hypot(unit.dispatchTarget[0] - incident[0]!, unit.dispatchTarget[2] - incident[2]!) < .01);
    const target = [...unit.dispatchTarget!];
    for (let i = 0; i < 30; i++) sim.step({ ...NEUTRAL, moveZ: 1 });
    assert.equal(unit.sees, false); assert.deepEqual(unit.dispatchTarget, target);
    assert.ok(Math.abs(unit.driver.goal![0] - incident[0]!) < .01, 'route stops at the reported street projection');
  } finally { sim.world.physics.free(); }
});

test('delayed reports copy the incident location and never overwrite a fresher sighting', () => {
  const wanted = new WantedState(base.wanted), point: V3 = [5, 0, 10];
  wanted.report('takeCar', 10, false, 180, [], point); point[0] = 500;
  wanted.step(190, false, [80, 0, 10], []);
  assert.deepEqual(wanted.lastSeen, [5, 0, 10]); assert.equal(wanted.lastSeenTick, 10);
  wanted.report('fire', 200, false, 180, [], [20, 0, 10]);
  wanted.step(300, true, [50, 0, 10], []);
  wanted.step(380, false, [100, 0, 10], []);
  assert.deepEqual(wanted.lastSeen, [50, 0, 10]); assert.equal(wanted.lastSeenTick, 300);
});

test('out-of-order report delivery retains the newest observed incident and binds pending positions to replay', () => {
  const a = new WantedState(base.wanted), b = new WantedState(base.wanted);
  a.report('takeCar', 10, false, 180, [], [1, 0, 2]); b.report('takeCar', 10, false, 180, [], [3, 0, 4]);
  assert.deepEqual(a.snapshot(), b.snapshot()); assert.notEqual(a.digest(), b.digest());
  a.report('fire', 20, false, 100, [], [7, 0, 8]);
  a.step(120, false, [90, 0, 90], []); a.step(190, false, [100, 0, 100], []);
  assert.deepEqual(a.lastSeen, [7, 0, 8]); assert.equal(a.lastSeenTick, 20);
  a.clear(); b.clear(); assert.equal(a.digest(), b.digest());
});

test('wanted heat alone supplies no unseen location and a remote old report does not spawn beside the player', () => {
  const sim = makeSim();
  try {
    sim.wanted.stars = 1; sim.police.step();
    assert.equal(sim.police.units.length, 0);
    sim.wanted.lastSeen = [-1000, 0, 0]; sim.wanted.lastSeenTick = 1;
    for (let i = 0; i < 30; i++) sim.police.step();
    assert.equal(sim.police.units.length, 0);
    assert.deepEqual(sim.wanted.lastSeen, [-1000, 0, 0]);
  } finally { sim.world.physics.free(); }
});
