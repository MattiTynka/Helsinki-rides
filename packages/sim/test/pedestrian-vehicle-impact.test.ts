import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {before, test} from 'node:test';
import {encodeCollisionBundle, encodeTerrain, type GameplayBundle, type RoadGraph} from '@helsinki/world-schema';
import {civilianVariant, initPhysics, NEUTRAL, Simulation, StaticWorld} from '../src/index.ts';

before(initPhysics);
const source = JSON.parse(readFileSync(new URL('../../../content/helsinki/gameplay.json', import.meta.url), 'utf8')) as GameplayBundle;
const roads: RoadGraph = {schemaVersion: 2, originId: 'impact-test', source: {id: 'test', sha256: 'x', attribution: 'test', license: 'CC0'}, nodes: [], parking: [],
  lanes: [
    {id: 'east', wayId: 1, index: 0, count: 1, name: 'test', highway: 'residential', surface: 'asphalt', speedLimit: 10, width: 3, points: [[-150, 0, -3], [150, 0, -3]], length: 300, from: 'west', to: 'east'},
    {id: 'west', wayId: 2, index: 0, count: 1, name: 'test', highway: 'residential', surface: 'asphalt', speedLimit: 10, width: 3, points: [[150, 0, 3], [-150, 0, 3]], length: 300, from: 'east', to: 'west'},
  ],
  connectors: [
    {id: 'turn-east', from: 'east', to: 'west', node: 'east', points: [[150, 0, -3], [150, 0, 3]], length: 6, turn: 'u-turn'},
    {id: 'turn-west', from: 'west', to: 'east', node: 'west', points: [[-150, 0, 3], [-150, 0, -3]], length: 6, turn: 'u-turn'},
  ],
  footways: [-1, 1].map(side => ({id: `sidewalk-${side}`, points: [[-145, 0, side * 12], [145, 0, side * 12]]})),
};

function fixture(duplicateSkid = false) {
  const content: GameplayBundle = {...source, schemaVersion: 2, originId: 'impact-test', civilianVariants: ['snow-black'], vehicles: [],
    playArea: {minX: -200, maxX: 200, minZ: -150, maxZ: 150},
    player: {...source.player, spawn: {position: [0, 0], headingDeg: 0}},
    vehicleDefinitions: source.vehicleDefinitions.map(def => def.role === 'civilian' && duplicateSkid
      ? {...def, collider: {...def.collider, skid: {halfExtents: def.collider.halfExtents, centre: def.collider.centre}}} : def),
    police: {...source.police, initialPatrols: 0, patrolSpawns: [{position: [-120, -3], headingDeg: 90}]},
    wanted: {...source.wanted, unitCaps: [1, 2, 3, 4, 5]}};
  const world = StaticWorld.fromBytes(encodeTerrain({x0: -200, z0: -150, nx: 41, nz: 31, resolution: 10, heights: new Float32Array(41 * 31)}), roads, content);
  world.addCell('native', encodeCollisionBundle({originId: 'impact-test', frame: 'X-east,Y-up,Z-south', cell: 'native', surfaceTags: ['paving']}, [{id: 'ground', group: 'ground', ref: null,
    positions: new Float32Array([-200, 0, -150, 200, 0, -150, 200, 0, 150, -200, 0, 150]), indices: new Uint32Array([0, 2, 1, 0, 3, 2]), triangleTags: new Uint16Array([0, 0])}]));
  const sim = new Simulation(world, {seed: 7});
  for (let i = 0; i < 300; i++) sim.step(NEUTRAL);
  const civilian = [...sim.characters.values()].find(c => civilianVariant(c.id));
  assert.ok(civilian);
  // Place only the test vehicle and its seated driver; the managed civilian keeps its real walking controller.
  const [x, , z] = civilian.position, car = sim.spawnVehicle('impact-car', 'lumi-gt', [x, z - 6], 0);
  car.driver = 'player'; car.occupants.add('player'); sim.player.inVehicle = car.id; sim.player.hide(); sim.mode = 'driving';
  return {sim, civilian, car};
}

test('a real car impact injures and drops a civilian even when the collision solver stops the car', () => {
  const {sim, civilian, car} = fixture();
  try {
    car.body.setLinvel({x: 0, y: 0, z: 7}, true);
    for (let i = 0; i < 90 && civilian.health === 100; i++) sim.step({...NEUTRAL, moveZ: 1});
    assert.ok(civilian.health < 100 && civilian.alive, `real nonfatal impact: health ${civilian.health}`);
    assert.ok(Math.hypot(car.velocityBefore[0], car.velocityBefore[2]) > 6, 'car entered contact at driving speed');
    assert.ok(car.speed < 2.5, 'post-solve speed would have incorrectly discarded the impact');
    assert.equal(sim.log.filter(e => e.type === 'hitCharacter' && e.detail === civilian.id).length, 1);
    sim.step(NEUTRAL);
    assert.ok(sim.pedestrians.knockdown(civilian.id));
    assert.equal(civilian.clip, 'death');
    assert.equal(sim.wanted.playerHasFired, false, 'a vehicle injury never permits police gunfire');
    // Face away from the street so the local dispatcher can place its car outside the player's view.
    const lookAway = {...NEUTRAL, yaw: Math.PI};
    for (let i = 0; i < 361 && !sim.log.some(e => e.type === 'crime' && e.detail === 'hitPedestrian'); i++) sim.step(lookAway);
    assert.ok(sim.log.some(e => e.type === 'crime' && e.detail === 'hitPedestrian'));
    for (let i = 0; i < 30 && sim.police.units.length === 0; i++) sim.step(lookAway);
    assert.ok(sim.police.units.length > 0, 'the civilian impact causes a real local dispatch');
    assert.equal(sim.log.some(e => e.type === 'policeFire'), false);
  } finally { sim.world.physics.free(); }
});

test('chassis and skid contacts count once and later low-speed pushing cannot repeat the injury', () => {
  const {sim, civilian, car} = fixture(true);
  try {
    car.body.setLinvel({x: 0, y: 0, z: 7}, true);
    for (let i = 0; i < 90 && civilian.health === 100; i++) sim.step({...NEUTRAL, moveZ: 1});
    const velocity = civilian.body.linvel();
    const relative = Math.hypot(car.velocityBefore[0] - velocity.x, car.velocityBefore[2] - velocity.z);
    assert.ok(relative > 6);
    assert.ok(Math.abs(civilian.health - (100 - (relative - 2) * 12)) < 1e-6, 'both collider starts apply exactly one impact dose');
    const health = civilian.health;
    for (let i = 0; i < 25; i++) sim.step({...NEUTRAL, moveZ: 1});
    assert.equal(civilian.health, health);
    assert.equal(sim.log.filter(e => e.type === 'hitCharacter' && e.detail === civilian.id).length, 1);
  } finally { sim.world.physics.free(); }
});

test('a lethal car contact publishes death on the contact tick and never resumes the civilian route', () => {
  const {sim, civilian, car} = fixture();
  try {
    car.body.setLinvel({x: 0, y: 0, z: 15}, true);
    for (let i = 0; i < 90 && civilian.alive; i++) sim.step({...NEUTRAL, moveZ: 1});
    assert.equal(civilian.alive, false, `real fatal impact: health ${civilian.health}`);
    const killed = sim.state().characters.find(actor => actor.id === civilian.id)!;
    assert.equal(killed.clip, 'death', 'contact damage occurs after pedestrian AI and must override its last gait');
    assert.equal(killed.speed, 0); assert.equal(killed.deathElapsed, 1 / 60);
    assert.equal(sim.pedestrians.knockdown(civilian.id), null);
    assert.equal(civilian.desiredVx, 0); assert.equal(civilian.desiredVz, 0);
    for (let i = 0; i < 5 * 60; i++) {
      sim.step(NEUTRAL);
      assert.equal(civilian.alive, false); assert.equal(civilian.clip, 'death');
      assert.equal(civilian.desiredVx, 0); assert.equal(civilian.desiredVz, 0);
    }
    assert.equal(sim.log.filter(e => e.type === 'kill' && e.detail === civilian.id).length, 1);
  } finally { sim.world.physics.free(); }
});

test('creeping contact with a walking civilian is harmless and does not request police', () => {
  const {sim, civilian, car} = fixture();
  try {
    // Keep a slow car beside its actual walker, and verify real Rapier contacts, not fabricated damage callbacks.
    const [x, , z] = civilian.position;
    car.place([x, .03, z - 2.65], 0);
    let contacts = 0;
    const original = sim.world.physics.step.bind(sim.world.physics);
    sim.world.physics.step = queue => {
      original(queue);
      sim.world.physics.contactPairsWith(civilian.collider, other => { if (other.handle === car.collider.handle || other.handle === car.skidCollider?.handle) contacts++; });
    };
    for (let i = 0; i < 60; i++) { car.body.setLinvel({x: 0, y: 0, z: 1}, true); sim.step(NEUTRAL); }
    assert.ok(contacts > 0, 'the slowly moving car actually contacted the person');
    assert.equal(civilian.health, 100);
    assert.equal(sim.pedestrians.knockdown(civilian.id), null);
    assert.equal(sim.log.some(e => e.type === 'hitCharacter'), false);
    assert.equal(sim.wanted.stars, 0);
  } finally { sim.world.physics.free(); }
});
