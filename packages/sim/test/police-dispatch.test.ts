import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {before, test} from 'node:test';
import {encodeCollisionBundle, encodeTerrain, decodeRoadGraph, RoadIndex, type GameplayBundle, type RoadGraph, type RoadLane} from '@helsinki/world-schema';
import {Button, initPhysics, NEUTRAL, PoliceUnit, POLICE_DISPATCH, policeDispatchCandidates, Simulation, StaticWorld} from '../src/index.ts';

before(initPhysics);
const base = JSON.parse(fs.readFileSync(new URL('../../../content/helsinki/gameplay.json', import.meta.url), 'utf8')) as GameplayBundle;
function lane(id: string, x: number, z: number, direction = 1, length = 400): RoadLane {
  return {id, wayId: 1, index: 0, count: 1, name: id, highway: 'residential', surface: 'asphalt', speedLimit: 10, width: 4,
    points: [[x - direction * length / 2, 0, z], [x + direction * length / 2, 0, z]], length, from: id + 'a', to: id + 'b'};
}
function graph(centres = [0, 1000]): RoadGraph {
  const lanes = centres.flatMap((x, i) => [lane(`${i}-east`, x, -5), lane(`${i}-west`, x, 5, -1)]);
  const connectors = centres.flatMap((_x, i) => {
    const a = lanes[i * 2]!, b = lanes[i * 2 + 1]!;
    return [[a, b], [b, a]].map(([from, to], j) => ({id: `${i}-turn${j}`, from: from!.id, to: to!.id, node: `${i}-${j}`, points: [from!.points.at(-1)!, to!.points[0]!], length: 10, turn: 'u-turn' as const}));
  });
  return {schemaVersion: 2, originId: 'dispatch-test', source: {id: 'test', sha256: 'x', attribution: 'test', license: 'CC0'}, nodes: [], lanes, connectors, parking: [], footways: []};
}
function gameplay(x = 0, initialPatrols = 1): GameplayBundle {
  return {...base, originId: 'dispatch-test', killHeight: -30, playArea: {minX: -300, maxX: 1300, minZ: -250, maxZ: 250},
    player: {...base.player, spawn: {position: [x, 0], headingDeg: 90}}, vehicles: [],
    police: {...base.police, initialPatrols, spawnMinDistance: 150, patrolSpawns: [{position: [0, -5], headingDeg: 90}]},
    wanted: {...base.wanted, unitCaps: [1, 2, 3, 4, 5]}};
}
function makeSim(x = 0, options: {native?: boolean; floorY?: number; roadY?: number; initial?: number; roads?: RoadGraph; streamed?: boolean; water?: boolean} = {}) {
  const roads = options.roads ?? graph();
  if (options.roadY) for (const l of roads.lanes) for (const p of l.points) (p as number[])[1] = options.roadY;
  const world = StaticWorld.fromBytes(encodeTerrain({x0: -300, z0: -250, resolution: 10, nx: 161, nz: 51, heights: new Float32Array(161 * 51)}), roads, gameplay(x, options.initial ?? 1));
  if (options.native !== false) {
    const y = options.floorY ?? 0;
    const bytes = encodeCollisionBundle({originId: 'dispatch-test', frame: 'X-east,Y-up,Z-south', cell: 'native', surfaceTags: [options.water ? 'water' : 'road:asphalt']}, [{id: 'road', group: 'ground', ref: null,
      positions: new Float32Array([-300, y, -250, 1300, y, -250, 1300, y, 250, -300, y, 250]), indices: new Uint32Array([0, 2, 1, 0, 3, 2]), triangleTags: new Uint16Array([0, 0])}]);
    if (options.streamed) world.enableStreaming([{id: 'native', boundsXZ: [-300, -250, 1300, 250]}], () => bytes);
    else world.addCell('native', bytes);
  }
  return new Simulation(world, {seed: 7});
}

test('dispatch reaches a small disconnected district instead of snapping to the largest road component', () => {
  const roads = graph([0, 1000, 1100]);
  const candidates = policeDispatchCandidates(new RoadIndex(roads), [0, .9, 0]);
  assert.ok(candidates.length >= 2);
  assert.ok(candidates.every(c => c.laneId.startsWith('0-')));
  for (const c of candidates) {
    const d = Math.hypot(c.point[0], c.point[2]);
    assert.ok(d >= 96 && d <= 124);
    assert.ok(new RoadIndex(roads).route(c.laneId, c.s, '0-east', 200));
  }
});

test('fixed Senate spawns do not prevent a native-supported local patrol a kilometre away', () => {
  const sim = makeSim(1000);
  try {
    assert.equal(sim.police.units.length, 1);
    const unit = sim.police.units[0]!, d = Math.hypot(unit.position[0] - 1000, unit.position[2]);
    assert.ok(d >= POLICE_DISPATCH.minimumDistance && d <= POLICE_DISPATCH.maximumDistance);
    assert.ok(unit.vehicle && sim.world.roads.nearestLane(unit.position[0], unit.position[2], undefined, .01)?.laneId.startsWith('1-'));
    assert.equal(sim.characters.size, 1);
  } finally { sim.world.physics.free(); }
});

test('fallback-only, water and wrong-level roads never create a remote or unsupported replacement', () => {
  for (const options of [{native: false}, {roadY: 7, floorY: 0}, {water: true}]) {
    const sim = makeSim(1000, options);
    try {
      assert.equal(sim.police.units.length, 0);
      for (let i = 0; i < 30; i++) sim.police.step();
      assert.equal(sim.police.units.length, 0);
      assert.equal(sim.vehicles.size, 0, 'no fallback patrol is silently put at Senate or on terrain');
    } finally { sim.world.physics.free(); }
  }
});

test('newly inserted streamed collision is not used before its first physics step', () => {
  const sim = makeSim(1000, {streamed: true, initial: 0});
  try {
    // Reinsert the native cell without a physics step, reproducing a newly arrived streaming payload.
    const bytes = encodeCollisionBundle({originId: 'dispatch-test', frame: 'X-east,Y-up,Z-south', cell: 'native', surfaceTags: ['road:asphalt']}, [{id: 'road', group: 'ground', ref: null,
      positions: new Float32Array([-300, 0, -250, 1300, 0, -250, 1300, 0, 250, -300, 0, 250]), indices: new Uint32Array([0, 2, 1, 0, 3, 2]), triangleTags: new Uint16Array([0, 0])}]);
    sim.world.removeCell('native'); sim.world.addCell('native', bytes);
    sim.wanted.report('takeCar', sim.tick, true, 0, sim.events, sim.playerPosition);
    sim.police.step();
    assert.equal(sim.police.units.length, 0);
    sim.world.physics.step(); sim.world.markStepped();
    for (let i = 0; i < 16; i++) sim.police.step();
    assert.equal(sim.police.units.length, 1, 'the delayed local dispatch retries after collision becomes queryable');
  } finally { sim.world.physics.free(); }
});

test('a full force recycles only distant unseen units and preserves a nearby patrol without teleporting it', () => {
  const sim = makeSim();
  try {
    const old = sim.police.units[0]!;
    sim.player.teleport([1000, 0, 0], 0);
    sim.wanted.report('takeCar', sim.tick, true, 0, sim.events, sim.playerPosition);
    old.sees = true;
    sim.police.step();
    assert.equal(sim.police.units[0], old, 'an observed unit is not recycled');
    old.sees = false;
    sim.police.step();
    assert.equal(sim.police.units.length, 1, 'wanted cap remains one');
    assert.ok(!sim.police.units.includes(old));
    assert.ok(!sim.characters.has(old.officer.id));
    assert.ok(!sim.vehicles.has(old.vehicle!.id));
    const local = sim.police.units[0]!, position = [...local.vehicle!.position];
    for (let i = 0; i < 170; i++) sim.police.step();
    assert.equal(sim.police.units[0], local);
    assert.deepEqual(local.vehicle!.position, position, 'AI inputs do not teleport a retained nearby car');
    assert.equal(sim.characters.size, 1);
    assert.equal(sim.vehicles.size, 1);
    sim.police.reset();
    assert.equal(sim.police.units.length, 1);
    assert.equal(sim.characters.size, 1, 'reset retires the old officer');
    assert.equal(sim.vehicles.size, 1, 'reset retires the old car');
  } finally { sim.world.physics.free(); }
});

test('an unavailable replacement keeps the old officer and car instead of silently deleting the force', () => {
  const sim = makeSim();
  try {
    const old = sim.police.units[0]!;
    sim.player.teleport([1000, 0, 0], 0); sim.world.removeCell('native'); sim.wanted.stars = 1;
    sim.police.step();
    assert.equal(sim.police.units[0], old);
    assert.ok(sim.vehicles.has(old.vehicle!.id));
    assert.ok(sim.characters.has(old.officer.id));
  } finally { sim.world.physics.free(); }
});

test('a stolen patrol near the player does not reserve the remote officer\'s response slot', () => {
  const sim = makeSim();
  try {
    const old = sim.police.units[0]!, stolen = old.vehicle!;
    old.officer.inVehicle = null; old.officer.teleport([0, 0, 0], 0);
    stolen.occupants.delete(old.officer.id); stolen.occupants.add(sim.player.id);
    stolen.place([1000, .25, 0], 0); stolen.driver = sim.player.id;
    sim.player.inVehicle = stolen.id; sim.player.hide();
    sim.wanted.report('takeCar', sim.tick, true, 0, sim.events, sim.playerPosition);
    sim.police.step();
    assert.equal(sim.police.units.length, 1);
    assert.ok(!sim.police.units.includes(old));
    assert.ok(!sim.characters.has(old.officer.id));
    assert.equal(sim.playerVehicle, stolen);
    assert.equal(sim.vehicles.get(stolen.id), stolen, 'retiring the old officer cannot delete the stolen car');
    assert.equal(stolen.driver, sim.player.id);
    assert.equal(sim.vehicles.size, 2, 'one protected player car and one replacement patrol');
    sim.police.reset();
    assert.equal(sim.playerVehicle, stolen, 'reset preserves ownership and orphan bookkeeping');
    sim.player.inVehicle = null; stolen.driver = null; stolen.occupants.delete(sim.player.id);
    sim.player.teleport([1000, 0, 0], 0);
    sim.police.step();
    assert.equal(sim.vehicles.get(stolen.id), stolen, 'a newly abandoned car beside the player stays visible');
    sim.player.teleport([0, 0, 0], 0);
    sim.police.step();
    assert.ok(!sim.vehicles.has(stolen.id), 'travel away retires the abandoned former patrol');
    assert.equal(stolen.body.isValid(), false, 'the original physical body is removed even if its slot is reused');
    assert.ok(!sim.collisionSources().some(s => s.x === 1000 && s.z === 0), 'the old car no longer pins collision');
  } finally { sim.world.physics.free(); }
});

test('entry reservation of a remote officer\'s car survives local replacement at the wanted cap', () => {
  const sim = makeSim();
  try {
    const old = sim.police.units[0]!, reserved = old.vehicle!;
    old.officer.inVehicle = null; old.officer.teleport([0, 0, 0], 0);
    reserved.occupants.delete(old.officer.id); reserved.driver = null;
    reserved.place([1000, .25, 0], 0);
    sim.player.teleport([1001.6, 0, -.95], Math.PI);
    sim.wanted.stars = 1;
    for (let i = 0; i < 20; i++) sim.step(NEUTRAL);
    sim.step({...NEUTRAL, buttons: Button.interact});
    assert.equal(sim.mode, 'entering');
    assert.equal(sim.vehicleInteraction?.vehicleId, reserved.id);
    assert.ok(!sim.police.units.includes(old));
    assert.equal(sim.vehicles.get(reserved.id), reserved);
    assert.equal(sim.police.units.length, 1);
    sim.police.reset();
    sim.player.teleport([0, 0, 0], 0);
    sim.police.step();
    assert.equal(sim.vehicles.get(reserved.id), reserved, 'an unseated entry reservation remains protected even far away');
  } finally { sim.world.physics.free(); }
});

test('abandoned former patrols outside the map retire without making nearby cars pop away', () => {
  const sim = makeSim();
  try {
    const old = sim.police.units[0]!, car = old.vehicle!;
    old.officer.inVehicle = null; old.officer.teleport([0, 0, 0], 0);
    car.occupants.delete(old.officer.id); car.occupants.add(sim.player.id); car.driver = sim.player.id;
    car.place([1298, .25, 0], 0); sim.player.inVehicle = car.id; sim.player.hide();
    sim.wanted.stars = 1;
    sim.police.step();
    // With no supported spawn beyond the map edge, a replacement can be unavailable. Reset still preserves and
    // tracks this player's car when it removes the old unit.
    sim.police.reset();
    car.driver = null; car.occupants.delete(sim.player.id); sim.player.inVehicle = null;
    car.place([1305, .25, 0], 0); sim.player.teleport([1290, 0, 0], 0);
    sim.police.step();
    assert.equal(sim.vehicles.get(car.id), car, 'a car just outside the edge does not pop away beside the player');
    sim.player.teleport([1100, 0, 0], 0);
    sim.police.step();
    assert.ok(!sim.vehicles.has(car.id), 'an abandoned off-map body can retire outside nearby sight');
    const tracker = Reflect.get(sim.police, 'retainedVehicles') as Map<string, unknown>;
    assert.ok(!tracker.has(car.id));

  } finally { sim.world.physics.free(); }
});

test('a newer reported incident supersedes stale knowledge from another district without tracking unseen movement', () => {
  const sim = makeSim(1000, {initial: 0});
  try {
    sim.wanted.stars = 1; sim.wanted.lastSeen = [0, 0, -5]; sim.wanted.lastSeenTick = 10;
    sim.wanted.report('takeCar', 11, true, 0, sim.events, sim.playerPosition);
    sim.police.step();
    const unit = sim.police.units[0]!;
    assert.ok(unit);
    assert.equal(unit.state, 'respond');
    assert.ok(unit.driver.route.length, 'it routes in the local district rather than braking toward disconnected Senate');
    assert.equal(unit.driver.goal?.[0], 1000);
    const fixed = [...unit.dispatchTarget!];
    sim.player.teleport([1150, 0, 0], 0);
    sim.police.step();
    assert.deepEqual(unit.dispatchTarget, fixed, 'an unseen player does not continuously update incident knowledge');
    assert.equal(unit.driver.goal?.[0], 1000);
    unit.vehicle!.place([1005, .25, -5], Math.PI / 2);
    sim.police.step();
    assert.equal(unit.state, 'search');
    assert.ok(unit.searchTarget && Math.hypot(unit.searchTarget[0] - 1000, unit.searchTarget[2]) <= 100, 'search is centred on the captured local incident');
    const oldSearch = unit.searchTarget;
    sim.wanted.lastSeen = [1020, 0, -5]; sim.wanted.lastSeenTick = 20;
    sim.police.step();
    assert.equal(unit.dispatchTarget, null);
    assert.notEqual(unit.searchTarget, oldSearch, 'a fresh sighting also invalidates a search already in progress');
    sim.wanted.lastSeen = [1050, 0, -5]; sim.wanted.lastSeenTick = 21;
    sim.police.step();
    assert.equal(unit.dispatchTarget, null, 'a fresh real sighting supersedes the local dispatch point');
    assert.equal(unit.driver.goal?.[0], 1050);
    sim.wanted.clear(); sim.police.step();
    assert.equal(unit.dispatchTarget, null);
    assert.equal(unit.state, 'patrol');
  } finally { sim.world.physics.free(); }
});

test('a finished response route stays safely braked until the next replan instead of reading past its end', () => {
  const sim = makeSim();
  try {
    const unit = sim.police.units[0]!, vehicle = unit.vehicle!;
    unit.driver.setRoute([[...vehicle.position]], vehicle.position, vehicle.forward);
    assert.equal(unit.driver.drive(vehicle, 20, 6), true);
    assert.equal(unit.driver.index, unit.driver.route.length);
    for (let i = 0; i < 120; i++) {
      assert.equal(unit.driver.drive(vehicle, 20, 6), true);
      assert.equal(vehicle.input.throttle, 0);
      assert.ok(vehicle.input.brake >= .6);
    }
  } finally { sim.world.physics.free(); }
});

test('externally removed retained patrols leave no historical tracking entries', () => {
  const sim = makeSim();
  try {
    const external = sim.police.units[0]!.vehicle!;
    external.driver = sim.player.id; sim.player.inVehicle = external.id;
    sim.police.reset();
    const tracker = Reflect.get(sim.police, 'retainedVehicles') as Map<string, unknown>;
    assert.ok(tracker.has(external.id));
    external.driver = null; external.occupants.clear(); sim.player.inVehicle = null;
    assert.ok(sim.removeVehicle(external));
    sim.police.step();
    assert.ok(!tracker.has(external.id), 'removed physical cars leave no unbounded historical tracking entry');
  } finally { sim.world.physics.free(); }
});

test('an unreachable response brakes instead of inventing a straight route between components', () => {
  const roads = graph([0, 200]);
  for (const l of roads.lanes) {
    const x = l.id.startsWith('0-') ? 0 : 200;
    (l as {points: RoadLane['points']; length: number}).points = [[x - 40, 0, -5], [x + 40, 0, -5]];
    (l as {length: number}).length = 80;
  }
  const sim = makeSim(200, {roads, initial: 0});
  try {
    const vehicle = sim.spawnVehicle('test-patrol', 'patrol', [0, -5], Math.PI / 2);
    const officer = sim.spawnCharacter('test-officer', vehicle.position, vehicle.yaw, 100);
    officer.inVehicle = vehicle.id; officer.hide(); vehicle.driver = officer.id; vehicle.occupants.add(officer.id);
    const unit = new PoliceUnit('test-unit', vehicle, officer, 0);
    sim.police.units.push(unit); sim.wanted.stars = 1; sim.wanted.lastSeen = [200, 0, -5];
    sim.police.step();
    assert.deepEqual(unit.driver.route, []);
    assert.equal(vehicle.input.throttle, 0);
    assert.ok(vehicle.input.brake >= .6);
  } finally { sim.world.physics.free(); }
});

test('a routed response stops at the target projection rather than driving to the far end of its lane', () => {
  const sim = makeSim();
  try {
    const unit = sim.police.units[0]!;
    unit.vehicle!.place([-120, .25, -5], Math.PI / 2);
    sim.wanted.stars = 1; sim.wanted.lastSeen = [0, 0, -5];
    sim.police.step();
    assert.deepEqual(unit.driver.route.at(-1), [0, 0, -5]);
    assert.ok(unit.driver.route.every(p => p[0] <= 0), 'the lane endpoint at X200 is not a response waypoint');
    assert.ok(unit.vehicle!.input.throttle > 0);
  } finally { sim.world.physics.free(); }
});

test('a reduced wanted cap retires distant surplus units without removing the nearby patrol', () => {
  const sim = makeSim();
  try {
    const nearby = sim.police.units[0]!;
    for (const z of [-50, 50]) {
      const id = `surplus-${z}`, vehicle = sim.spawnVehicle(id, 'patrol', [180, z], Math.PI);
      const officer = sim.spawnCharacter(id + '-officer', vehicle.position, vehicle.yaw, 100);
      officer.inVehicle = vehicle.id; officer.hide(); vehicle.driver = officer.id; vehicle.occupants.add(officer.id);
      sim.police.units.push(new PoliceUnit(id, vehicle, officer, 1));
    }
    sim.wanted.stars = 1;
    sim.police.step();
    assert.deepEqual(sim.police.units, [nearby]);
    assert.equal(sim.characters.size, 1); assert.equal(sim.vehicles.size, 1);
  } finally { sim.world.physics.free(); }
});

test('cap reduction does not make a nearby unattended patrol disappear with its remote officer', () => {
  const sim = makeSim();
  try {
    const vehicle = sim.spawnVehicle('near-unused', 'patrol', [30, 0], 0);
    const officer = sim.spawnCharacter('remote-officer', [180, 0, 50], 0, 100);
    const unit = new PoliceUnit('remote-officer-unit', vehicle, officer, 0);
    sim.police.units.push(unit); sim.wanted.stars = 1;
    sim.police.step();
    assert.ok(sim.police.units.includes(unit));
    assert.ok(sim.vehicles.has(vehicle.id));
    vehicle.place([180, .25, 50], 0);
    sim.police.step();
    assert.ok(!sim.police.units.includes(unit), 'it retires once both unclaimed bodies are outside sight');
    assert.ok(!sim.vehicles.has(vehicle.id));
  } finally { sim.world.physics.free(); }
});

const actualWorld = process.env.HELSINKI_POLICE_WORLD;
test('available deployed world supplies native-supported dispatch in four distant districts', {skip: !actualWorld}, () => {
  const root = path.resolve(actualWorld!), manifestBytes = fs.readFileSync(path.join(root, 'manifest.json')), manifest = JSON.parse(manifestBytes.toString());
  assert.equal(createHash('sha256').update(manifestBytes).digest('hex'), '1178aa4520c9c9bc5c371d85cd7229205a4836a123391f1ec38745448b89f8c1');
  const read = (ref: {path: string; compression?: string; sha256: string}) => {
    const stored = fs.readFileSync(path.join(root, ref.path)); assert.equal(createHash('sha256').update(stored).digest('hex'), ref.sha256);
    return ref.compression === 'gzip' ? gunzipSync(stored) : stored;
  };
  const roads = decodeRoadGraph(read(manifest.roads));
  const sourceGameplay = JSON.parse(read(manifest.gameplay).toString()) as GameplayBundle;
  for (const [name, x, z] of [['Senate', 0, 0], ['Alexander Theatre', -1050, 670], ['Toinen linja', -650, -1650], ['Northern Hameentie', 630, -2150]] as const) {
    const nearest = new RoadIndex(roads).nearestLane(x, z, undefined, 100); assert.ok(nearest, name);
    const g = {...sourceGameplay, player: {...sourceGameplay.player, spawn: {position: [nearest.point[0], nearest.point[2]] as [number, number], headingDeg: 0}}, vehicles: [], police: {...sourceGameplay.police, initialPatrols: 1}};
    const world = StaticWorld.fromBytes(read(manifest.terrain), roads, g);
    for (const cell of manifest.cells) {
      const b = cell.collision.boundsXZ ?? cell.boundsXZ;
      if (Math.hypot(Math.max(b[0] - x, 0, x - b[2]), Math.max(b[1] - z, 0, z - b[3])) <= 250) world.addCell(cell.id, read(cell.collision));
    }
    try {
      const sim = new Simulation(world, {seed: 17});
      assert.equal(sim.police.units.length, 1, `${name}: a qualified local patrol exists`);
      const unit = sim.police.units[0]!, d = Math.hypot(unit.position[0] - sim.playerPosition[0], unit.position[2] - sim.playerPosition[2]);
      assert.ok(d >= 96 && d <= 124, `${name}: local out-of-sight dispatch ${d}m`);
      console.log(JSON.stringify({district: name, patrol: unit.position, distance: d, loadedCells: world.cellColliders.size}));
    } finally { world.physics.free(); }
  }
});
