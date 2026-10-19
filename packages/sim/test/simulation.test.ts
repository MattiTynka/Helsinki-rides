import assert from 'node:assert/strict';
import { PoliceUnit } from '../src/police.ts';
import { before, test } from 'node:test';
import { encodeCollisionBundle, encodeTerrain, type GameplayBundle, type RoadGraph } from '@helsinki/world-schema';
import { Button, CHARACTER, CLIMB, GROUP, groups, initPhysics, NEUTRAL, RAPIER, Simulation, StaticWorld, VEHICLE_INTERACTION, vehicleExitClips, vehicleExitYaw, wrapAngle, type Command } from '../src/index.ts';

// A flat 200 x 200 m world with one car, no roads and no police: enough for the player, vehicle and wanted logic.
const nx = 41, nz = 41;
const terrain = encodeTerrain({ x0: -100, z0: -100, resolution: 5, nx, nz, heights: new Float32Array(nx * nz) });
const ground = encodeCollisionBundle({ originId: 't', frame: 'X-east,Y-up,Z-south', cell: 'flat', surfaceTags: ['road'] }, [{
  id: 'g', group: 'ground', ref: null,
  positions: new Float32Array([-100, 0, -100, 100, 0, -100, 100, 0, 100, -100, 0, 100]), indices: new Uint32Array([0, 2, 1, 0, 3, 2]), triangleTags: new Uint16Array([0, 0]),
}]);
const roads: RoadGraph = { schemaVersion: 2, originId: 't', source: { id: 'osm', sha256: 'x', attribution: 'a', license: 'ODbL' }, nodes: [], lanes: [], connectors: [], parking: [], footways: [] };
const car = {
  id: 'car', label: 'Car', assetId: 'vehicle-lumi-gt', role: 'civilian' as const, massKg: 1650, centreOfMass: [0, 0.38, 0.1] as [number, number, number],
  collider: { halfExtents: [0.94, 0.4, 2.35] as [number, number, number], centre: [0, 0.95, -0.07] as [number, number, number], skid: { halfExtents: [0.94, 0.25, 1.3] as [number, number, number], centre: [0, 0.6, -0.07] as [number, number, number] } }, wheelRadius: 0.342, wheelWidth: 0.29,
  wheels: [
    { socket: 'WHEEL_FL', position: [0.822, 0.342, 1.333] as [number, number, number], steer: true, drive: false, handbrake: false },
    { socket: 'WHEEL_FR', position: [-0.822, 0.342, 1.333] as [number, number, number], steer: true, drive: false, handbrake: false },
    { socket: 'WHEEL_RL', position: [0.822, 0.342, -1.333] as [number, number, number], steer: false, drive: true, handbrake: true },
    { socket: 'WHEEL_RR', position: [-0.822, 0.342, -1.333] as [number, number, number], steer: false, drive: true, handbrake: true },
  ],
  suspension: { restLength: 0.42, stiffness: 32, damping: 4.4, compression: 4.0, maxTravel: 0.3 }, tyres: { frictionSlip: 3.2, sideFriction: 1.0 },
  engine: { maxForceN: 9000, reverseForceN: 4500, topSpeedMs: 58, topSpeedReverseMs: 8 }, brakes: { forceN: 5200, handbrakeN: 7000 },
  steering: { maxAngleDeg: 36, highSpeedAngleDeg: 9, rateDegPerS: 140 }, aero: { dragCoefficient: 0.42, downforce: 0.6 },
  seat: { driver: [0.365, 0.598, -0.281] as [number, number, number], exits: [[1.5, 0, 0] as [number, number, number], [-1.5, 0, 0] as [number, number, number]], entryRadius: 2.4 },
  cameraChase: [0, 2.3, -7.5] as [number, number, number], health: 1000, damage: { smokeBelow: 0.3, fireBelow: 0.1, explodeAfterSeconds: 5 },
};
const gameplay: GameplayBundle = {
  schemaVersion: 2, originId: 't', killHeight: -25, playArea: { minX: -100, maxX: 100, minZ: -100, maxZ: 100 },
  player: { spawn: { position: [0, 0], headingDeg: 0 }, health: 100, armour: 0 },
  vehicleDefinitions: [car, { ...car, id: 'patrol', role: 'patrol', assetId: 'vehicle-patrol' }],
  vehicles: [{ id: 'car-1', definition: 'car', position: [0, -6], headingDeg: 0, occupied: false }],
  anchors: [
    { id: 'h', kind: 'hospital', label: 'h', placeholder: true, destinationName: 'Meilahti hospital', position: [50, 50], headingDeg: 0 },
    { id: 'p', kind: 'police', label: 'p', placeholder: true, destinationName: 'Pasila police station', position: [-50, -50], headingDeg: 0 },
  ],
  weapons: [{ id: 'pistol', label: 'Pistol', damage: 26, headshotMultiplier: 3, rangeMeters: 120, spreadDeg: 1.2, recoilDeg: 2.5, roundsPerMinute: 360, magazine: 12, reloadSeconds: 1.4, automatic: false }],
  wanted: { starWeights: { takeCar: 1, ram: 0.5, ramPolice: 1, hitPedestrian: 1, drawWeapon: 0.4, fire: 1, shootAtPolice: 2, kill: 3, killOfficer: 3 }, starThresholds: [1, 2, 3, 5, 8], decaySeconds: [1, 2, 3, 4, 5], unitCaps: [0, 0, 0, 0, 0], witnessReportSeconds: [0.5, 0.5], arrest: { footRadius: 3, footSeconds: 2, boxedSeconds: 3 }, searchRadius: 60 },
  police: { spawnMinDistance: 150, initialPatrols: 0, patrolSpawns: [{ position: [90, 90], headingDeg: 0 }, { position: [-90, -90], headingDeg: 180 }] },
  addresses: [], landmarks: [], district: { name: 't', boundary: [] }, playerStart: { weapons: [{ id: 'pistol', reserve: 24 }] },
};
const cmd = (over: Partial<Command>): Command => ({ ...NEUTRAL, ...over });
function makeSim(seed = 1): Simulation { const w = StaticWorld.fromBytes(terrain, roads, gameplay); w.addCell('flat', ground); return new Simulation(w, { seed }); }

function waitForMode(sim: Simulation, mode: Simulation['mode'], maxTicks = 1000): void {
  for (let i = 0; i < maxTicks && sim.mode !== mode; i++) sim.step(NEUTRAL);
  assert.equal(sim.mode, mode, `reached ${mode} within ${maxTicks} ticks; ${sim.digest()}`);
}

function boardStoppedCar(sim: Simulation): void {
  const v = sim.vehicles.get('car-1')!;
  const beside = v.localToWorld([2.1, 0, -0.95]);
  sim.player.teleport([beside[0], 0, beside[2]], v.yaw);
  for (let i = 0; i < 30; i++) sim.step(NEUTRAL);
  sim.step(cmd({ buttons: Button.interact }));
  waitForMode(sim, 'driving');
  for (let i = 0; i < 12; i++) sim.step(NEUTRAL);
}

/** A patrol whose officer died on foot, away from the unlocked car. */
function abandonedPatrol() {
  const sim = makeSim();
  sim.removeVehicle(sim.vehicles.get('car-1')!);
  const vehicle = sim.spawnVehicle('abandoned-patrol', 'patrol', [0, -6], Math.PI);
  const officer = sim.spawnCharacter('police-test-officer', [80, 0, 80], 0, 100);
  officer.takeDamage(100);
  const unit = new PoliceUnit('police-test', vehicle, officer, 0);
  sim.police.units.push(unit);
  sim.player.teleport([1.6, 0, -6], Math.PI);
  for (let i = 0; i < 30; i++) sim.step(NEUTRAL);
  return { sim, vehicle, officer, unit };
}

test('dead officer cleanup preserves the stolen patrol car and its driver after twenty seconds', () => {
  const { sim, vehicle, unit } = abandonedPatrol();
  sim.step(cmd({ buttons: Button.interact }));
  for (let i = 0; i < 1250; i++) {
    sim.step(NEUTRAL);
    const s = sim.state();
    assert.ok(s.player.inVehicle === null || s.vehicles.some(v => v.id === s.player.inVehicle), `occupied vehicle survives at tick ${s.tick}`);
  }
  assert.equal(sim.police.units.includes(unit), false, 'the old officer still retires');
  assert.equal(sim.playerVehicle, vehicle);
  assert.equal(sim.mode, 'driving');
  assert.equal(vehicle.driver, 'player');
  for (let i = 0; i < 60; i++) sim.step(cmd({ moveZ: 1 }));
  assert.ok(vehicle.forwardSpeed > 2, 'the retained car remains drivable');
  sim.step(cmd({ buttons: Button.interact }));
  waitForMode(sim, 'onFoot');
  assert.equal(sim.mode, 'onFoot');
  assert.equal(sim.player.inVehicle, null);
  assert.ok(sim.player.body.translation().y > -10, 'exiting restores the hidden capsule');
  sim.removeVehicle(vehicle);
  assert.equal(sim.vehicles.has(vehicle.id), false, 'unused cars can still be removed');
});

test('police cleanup cannot remove a vehicle reserved during the entry animation', () => {
  const { sim, vehicle, officer, unit } = abandonedPatrol();
  officer.deathTicks = 1201;
  sim.step(cmd({ buttons: Button.interact }));
  assert.equal(sim.mode, 'entering');
  assert.equal(sim.player.inVehicle, null, 'entry has not seated the player yet');
  assert.equal(sim.police.units.includes(unit), false);
  assert.equal(sim.vehicles.get(vehicle.id), vehicle, 'the seat reservation protects entry');
  waitForMode(sim, 'driving');
  assert.equal(sim.playerVehicle, vehicle);
  assert.equal(sim.mode, 'driving');
});

test('vehicle cleanup preserves exiting and wasted camera targets even after the seat is released', () => {
  for (const mode of ['exiting', 'wasted'] as const) {
    const { sim, vehicle, officer } = abandonedPatrol();
    sim.step(cmd({ buttons: Button.interact }));
    waitForMode(sim, 'driving');
    for (let i = 0; i < 12; i++) sim.step(NEUTRAL);
    if (mode === 'exiting') sim.step(cmd({ buttons: Button.interact }));
    else { sim.player.takeDamage(500); sim.step(NEUTRAL); }
    assert.equal(sim.mode, mode);
    if (mode === 'wasted') assert.equal(vehicle.driver, null);
    officer.deathTicks = 1201;
    sim.step(NEUTRAL);
    assert.equal(sim.playerVehicle, vehicle, `${mode} still needs its vehicle`);
    waitForMode(sim, 'onFoot');
    assert.equal(sim.mode, 'onFoot');
    assert.equal(sim.player.inVehicle, null);
  }
});

test('unclaimed patrol cars are still removed with their retired officer', () => {
  const { sim, vehicle, officer } = abandonedPatrol();
  officer.deathTicks = 1201;
  sim.step(NEUTRAL);
  assert.equal(sim.vehicles.has(vehicle.id), false);
  assert.equal(sim.characters.has(officer.id), false);
});

test('death during entry releases the reservation so later cleanup can remove the unused car', () => {
  const { sim, vehicle, officer } = abandonedPatrol();
  sim.step(cmd({ buttons: Button.interact }));
  assert.equal(sim.mode, 'entering');
  sim.player.takeDamage(500);
  sim.step(NEUTRAL);
  assert.equal(sim.mode, 'wasted');
  assert.equal(vehicle.driver, null);
  officer.deathTicks = 1201;
  sim.step(NEUTRAL);
  assert.equal(sim.vehicles.has(vehicle.id), false);
  assert.equal(sim.player.inVehicle, null);
  for (let i = 0; i < 185; i++) sim.step(NEUTRAL);
  assert.equal(sim.mode, 'onFoot');
});

test('car entry routes around the bonnet and passenger side, then runs the complete seating animation', () => {
  for (const local of [[-2, 0, 0], [0, 0, 3.2], [2, 0, -0.95]] as const) {
    const sim = makeSim(), v = sim.vehicles.get('car-1')!;
    const start = v.localToWorld([...local]);
    sim.player.teleport([start[0], 0, start[2]], v.yaw);
    for (let i = 0; i < 30; i++) sim.step(NEUTRAL);
    sim.step(cmd({ buttons: Button.interact }));
    assert.equal(sim.state().player.vehicleInteraction?.stage, 'approach');
    for (let i = 0; i < 48; i++) sim.step(NEUTRAL);
    assert.equal(sim.player.inVehicle, null, 'the former fixed timer cannot board an unreached seat');
    assert.equal(sim.mode, 'entering');
    for (let i = 0; i < 720 && sim.vehicleInteraction?.stage === 'approach'; i++) {
      const pp = sim.player.position, vp = v.position, dx = pp[0] - vp[0], dz = pp[2] - vp[2];
      const x = dx * Math.cos(v.yaw) - dz * Math.sin(v.yaw), z = dx * Math.sin(v.yaw) + dz * Math.cos(v.yaw);
      assert.ok(Math.abs(x) > 1.2 || Math.abs(z + 0.07) > 2.6, `approach remains outside chassis at ${x},${z}`);
      sim.step(NEUTRAL);
    }
    assert.equal(sim.vehicleInteraction?.stage, 'enter');
    assert.ok(sim.player.body.translation().y < -900, 'authored crouching path owns presentation without a standing capsule hitting the car');
    // The walk-up stops anywhere near the stage; the remaining offset is handed to the renderer to blend out.
    const [ox, oz, oyaw] = sim.vehicleInteraction!.startOffset;
    assert.ok(Math.hypot(ox, oz) <= VEHICLE_INTERACTION.arrivalRadius + 1e-9 && Math.abs(oyaw) <= VEHICLE_INTERACTION.arrivalYaw + 1e-9);
    assert.ok(Math.abs(wrapAngle(sim.player.yaw - v.yaw - VEHICLE_INTERACTION.entryYaw)) < 1e-9, 'the clip starts from its authored heading');
    const progress = sim.vehicleInteraction!.progress;
    for (let i = 0; i < 60; i++) sim.step(NEUTRAL);
    assert.equal(sim.player.inVehicle, null);
    assert.ok(sim.vehicleInteraction!.progress > progress);
    waitForMode(sim, 'driving');
    assert.equal(sim.playerVehicle?.id, v.id);
    assert.deepEqual(sim.state().player.vehicleInteraction, { vehicleId: v.id, stage: 'seated', clip: 'enter', side: 'driver', progress: 1, startOffset: [0, 0, 0] });
  }
});

test('an unattended car remains parked on a slope and releases its brakes when the player drives', () => {
  // The real spawn has a roughly 5% grade. An unbraked car exceeds the stopped-entry
  // threshold before the player can walk from spawn; flat-ground tests cannot catch it.
  const slope = encodeCollisionBundle({ originId: 't', frame: 'X-east,Y-up,Z-south', cell: 'slope', surfaceTags: ['road'] }, [{
    id: 'slope', group: 'ground', ref: null,
    positions: new Float32Array([-100, 0, -100, 100, 0, -100, 100, 10, 100, -100, 10, 100]),
    indices: new Uint32Array([0, 2, 1, 0, 3, 2]), triangleTags: new Uint16Array([0, 0]),
  }]);
  const world = StaticWorld.fromBytes(terrain, roads, gameplay); world.addCell('slope', slope);
  const sim = new Simulation(world, { seed: 1 }), v = sim.vehicles.get('car-1')!;
  for (let i = 0; i < 60; i++) sim.step(NEUTRAL);
  const start = v.position;
  for (let i = 0; i < 1200; i++) sim.step(NEUTRAL);
  assert.ok(Math.hypot(v.position[0] - start[0], v.position[2] - start[2]) < 0.3, 'the parked car does not roll away during the approach');
  assert.ok(v.speed < VEHICLE_INTERACTION.stoppedSpeed);
  const beside = v.localToWorld([2, 0, -0.95]);
  sim.player.teleport(sim.groundPoint(beside[0], beside[2]), v.yaw);
  for (let i = 0; i < 30; i++) sim.step(NEUTRAL);
  assert.equal(sim.state().player.nearVehicle, v.id, 'the parked car remains available for entry');
  sim.step(cmd({ buttons: Button.interact }));
  waitForMode(sim, 'driving');
  for (let i = 0; i < 120; i++) sim.step(cmd({ moveZ: 1 }));
  assert.equal(v.input.brake, 0);
  assert.equal(v.input.handbrake, false);
  assert.ok(v.forwardSpeed > 5, `the player accelerates normally: ${v.forwardSpeed} m/s`);
});

test('an obstructed approach cancels without teleporting through the obstacle or reserving the car forever', () => {
  const sim = makeSim(), v = sim.vehicles.get('car-1')!;
  const start = v.localToWorld([2.5, 0, -0.95]), stage = v.localToWorld(VEHICLE_INTERACTION.stage);
  sim.player.teleport([start[0], 0, start[2]], v.yaw);
  box(sim, [stage[0], 1, stage[2]], [0.12, 1, 1.8]);
  for (let i = 0; i < 30; i++) sim.step(NEUTRAL);
  sim.step(cmd({ buttons: Button.interact }));
  assert.equal(sim.mode, 'entering');
  waitForMode(sim, 'onFoot');
  assert.equal(v.driver, null);
  assert.equal(sim.player.inVehicle, null);
  assert.equal(sim.vehicleInteraction, null);
  assert.ok(sim.player.grounded && sim.player.body.translation().y > 0);
  assert.ok(sim.log.some(e => e.type === 'vehicleEntryBlocked'));
});

test('a living person blocks the upper doorway while a settled body beside the clear standing stage does not', () => {
  for (const alive of [true, false]) {
    const sim = makeSim(), v = sim.vehicles.get('car-1')!;
    const start = v.localToWorld([2.1, 0, -0.95]), doorway = v.localToWorld([1.5, 0, -0.15]);
    sim.player.teleport([start[0], 0, start[2]], v.yaw);
    const bystander = sim.spawnCharacter('doorway-bystander', [doorway[0], 0, doorway[2]], v.yaw, 100);
    for (let i = 0; i < 30; i++) sim.step(NEUTRAL);
    if (!alive) bystander.takeDamage(100);
    for (let i = 0; i < 100; i++) sim.step(NEUTRAL);
    assert.ok(bystander.grounded);
    const bodyHandle = bystander.collider.handle;
    sim.step(cmd({ buttons: Button.interact }));
    assert.equal(sim.mode, 'entering');
    waitForMode(sim, alive ? 'onFoot' : 'driving');
    assert.equal(sim.player.inVehicle, alive ? null : v.id);
    assert.equal(bystander.collider.handle, bodyHandle, 'the body is not hidden or deleted to open the doorway');
    assert.ok(bystander.body.translation().y > 0, 'its walking collision remains on the road');
  }
});

test('a settled body occupying the actual driver staging point still blocks entry', () => {
  const sim = makeSim(), v = sim.vehicles.get('car-1')!;
  const start = v.localToWorld([2.5, 0, -0.95]), stage = v.localToWorld(VEHICLE_INTERACTION.stage);
  sim.player.teleport([start[0], 0, start[2]], v.yaw);
  const body = sim.spawnCharacter('body-at-feet', [stage[0], 0, stage[2]], v.yaw, 100);
  for (let i = 0; i < 30; i++) sim.step(NEUTRAL);
  body.takeDamage(100);
  for (let i = 0; i < 100; i++) sim.step(NEUTRAL);
  sim.step(cmd({ buttons: Button.interact }));
  assert.equal(sim.mode, 'entering');
  waitForMode(sim, 'onFoot');
  assert.equal(sim.player.inVehicle, null);
  assert.equal(v.driver, null);
  assert.ok(Math.hypot(body.position[0] - sim.player.position[0], body.position[2] - sim.player.position[2]) >= CHARACTER.radius * 2);
});

test('death during the seating pose restores the hidden capsule and releases the seat', () => {
  const sim = makeSim(), v = sim.vehicles.get('car-1')!;
  const start = v.localToWorld([2, 0, -0.95]);
  sim.player.teleport([start[0], 0, start[2]], v.yaw);
  for (let i = 0; i < 30; i++) sim.step(NEUTRAL);
  sim.step(cmd({ buttons: Button.interact }));
  for (let i = 0; i < 500 && sim.vehicleInteraction?.stage !== 'enter'; i++) sim.step(NEUTRAL);
  assert.equal(sim.vehicleInteraction?.stage, 'enter');
  sim.player.takeDamage(500);
  sim.step(NEUTRAL);
  assert.equal(sim.mode, 'wasted');
  assert.equal(v.driver, null);
  assert.equal(sim.player.inVehicle, null);
  assert.equal(sim.vehicleInteraction, null);
  assert.ok(sim.player.body.translation().y > 0);
  waitForMode(sim, 'onFoot');
  assert.ok(sim.player.position.every(Number.isFinite));
});

const sideBlocker = (sim: Simulation, side: 1 | -1) => {
  const v = sim.playerVehicle!, [x, y, z] = VEHICLE_INTERACTION.stage, stage = v.localToWorld([x * side, y, z]);
  return sim.world.physics.createCollider(RAPIER.ColliderDesc.cuboid(0.15, 1, 1).setTranslation(stage[0], 1, stage[2]).setCollisionGroups(groups(GROUP.static, GROUP.all)));
};

test('with both doors boxed in Finn kicks out the windshield and leaves over the bonnet', () => {
  const sim = makeSim(); boardStoppedCar(sim);
  const v = sim.playerVehicle!;
  const blockers = [sideBlocker(sim, 1), sideBlocker(sim, -1)];
  sim.step(NEUTRAL);
  sim.step(cmd({ buttons: Button.interact }));
  assert.equal(sim.mode, 'exiting');
  assert.deepEqual([sim.vehicleInteraction?.side, sim.vehicleInteraction?.clip], ['windshield', 'exitWindshield']);
  let broke = -1;
  for (let tick = 1; sim.mode === 'exiting' && tick < 400; tick++) {
    sim.step(NEUTRAL);
    if (broke < 0 && sim.events.some(e => e.type === 'windshieldBreak')) broke = tick;
  }
  assert.equal(sim.mode, 'onFoot');
  assert.equal(broke, Math.round(VEHICLE_INTERACTION.windshieldBreak * Math.round(VEHICLE_INTERACTION.durations.exitWindshield * 60)), 'the glass breaks on the kick');
  assert.equal(v.windshieldBroken, true);
  const stage = v.localToWorld(VEHICLE_INTERACTION.windshieldStage);
  assert.ok(Math.hypot(sim.player.position[0] - stage[0], sim.player.position[2] - stage[2]) < 0.05, 'Finn stands in front of the bumper');
  assert.ok(Math.abs(wrapAngle(sim.player.yaw - v.yaw - VEHICLE_INTERACTION.windshieldYaw)) < 1e-6);
  assert.equal(sim.player.inVehicle, null);
  for (const blocker of blockers) sim.world.physics.removeCollider(blocker, true);
});

/** Put the player's car on its roof and let it settle. */
function rollOver(sim: Simulation): void {
  const v = sim.playerVehicle!;
  v.body.setTranslation({ x: v.position[0], y: car.collider.centre[1] + car.collider.halfExtents[1] + 0.05, z: v.position[2] }, true);
  v.body.setRotation({ x: 0, y: 0, z: 1, w: 0 }, true);
  v.body.setLinvel({ x: 0, y: 0, z: 0 }, true); v.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  for (let i = 0; i < 90; i++) sim.step(NEUTRAL);
}

test('on a car lying on its roof Finn crawls out of the driver door and stands beside the car', () => {
  const sim = makeSim(); boardStoppedCar(sim);
  const v = sim.playerVehicle!;
  rollOver(sim);
  assert.ok(v.up[1] < VEHICLE_INTERACTION.flippedUp, `car is on its roof (up ${v.up[1].toFixed(2)})`);
  sim.step(cmd({ buttons: Button.interact }));
  assert.equal(sim.mode, 'exiting');
  assert.deepEqual([sim.vehicleInteraction?.side, sim.vehicleInteraction?.clip], ['driver', 'exitFlipped']);
  waitForMode(sim, 'onFoot', Math.round(VEHICLE_INTERACTION.durations.exitFlipped * 60) + 5);
  const [x, z] = VEHICLE_INTERACTION.flippedStage, stage = v.localToWorld([x, 0, z]);
  assert.ok(Math.hypot(sim.player.position[0] - stage[0], sim.player.position[2] - stage[2]) < 0.05, 'Finn stands where the crawl ends');
  assert.ok(Math.abs(wrapAngle(sim.player.yaw - vehicleExitYaw(v, 'exitFlipped'))) < 1e-6);
  assert.ok(sim.player.body.translation().y > 0);
  assert.equal(sim.player.inVehicle, null);
});

test('on a car lying on its roof with the driver side blocked Finn crawls across and out of the passenger door', () => {
  const sim = makeSim(); boardStoppedCar(sim);
  rollOver(sim);
  const blocker = sideBlocker(sim, 1);
  sim.step(NEUTRAL);
  sim.step(cmd({ buttons: Button.interact }));
  assert.equal(sim.mode, 'exiting');
  assert.deepEqual([sim.vehicleInteraction?.side, sim.vehicleInteraction?.clip], ['passenger', 'exitFlippedPassenger']);
  waitForMode(sim, 'onFoot', Math.round(VEHICLE_INTERACTION.durations.exitFlippedPassenger * 60) + 5);
  assert.equal(sim.player.inVehicle, null);
  sim.world.physics.removeCollider(blocker, true);
});

test('with no authored way out Finn is put on clear ground instead of staying trapped', () => {
  // A car on its side or badly tilted has no clip at all; here both doors of a car on its roof are blocked.
  assert.deepEqual(vehicleExitClips(null), []);
  const sim = makeSim(); boardStoppedCar(sim);
  const v = sim.playerVehicle!;
  rollOver(sim);
  const blockers = [sideBlocker(sim, 1), sideBlocker(sim, -1)];
  sim.step(NEUTRAL);
  sim.step(cmd({ buttons: Button.interact }));
  assert.equal(sim.mode, 'onFoot');
  assert.ok(sim.events.some(e => e.type === 'vehicleExitSqueezed'));
  assert.equal(sim.player.inVehicle, null);
  assert.equal(v.driver, null);
  assert.ok(sim.player.position.every(Number.isFinite));
  assert.ok(sim.player.body.translation().y > 0);
  for (const blocker of blockers) sim.world.physics.removeCollider(blocker, true);
});

test('a moving car brakes before opening the door', () => {
  const sim = makeSim(); boardStoppedCar(sim);
  const v = sim.playerVehicle!;
  for (let i = 0; i < 60; i++) sim.step(cmd({ moveZ: 1 }));
  assert.ok(v.speed > 2);
  sim.step(cmd({ buttons: Button.interact }));
  assert.equal(sim.mode, 'driving', 'the door stays closed at driving speed');
  assert.equal(v.input.brake, 1);
  waitForMode(sim, 'exiting');
  assert.ok(v.speed <= VEHICLE_INTERACTION.stoppedSpeed);
  assert.equal(sim.vehicleInteraction?.side, 'driver');
});

test('the driver exit is its own clip: it runs forward for its full duration and leaves Finn turned toward the rear', () => {
  const sim = makeSim(); boardStoppedCar(sim);
  const v = sim.playerVehicle!;
  sim.step(cmd({ buttons: Button.interact }));
  assert.equal(sim.mode, 'exiting');
  assert.equal(sim.vehicleInteraction?.clip, 'exit');
  let ticks = 0, last = sim.vehicleInteraction!.progress;
  while (sim.mode === 'exiting') {
    sim.step(NEUTRAL); ticks++;
    if (sim.vehicleInteraction) { assert.ok(sim.vehicleInteraction.progress > last, 'exit progress only moves forward'); last = sim.vehicleInteraction.progress; }
  }
  assert.equal(ticks, Math.round(VEHICLE_INTERACTION.durations.exit * 60));
  assert.notEqual(VEHICLE_INTERACTION.durations.exit, VEHICLE_INTERACTION.durations.enter);
  const stage = v.localToWorld(VEHICLE_INTERACTION.stage);
  assert.ok(Math.hypot(sim.player.position[0] - stage[0], sim.player.position[2] - stage[2]) < 0.05);
  assert.ok(Math.abs(wrapAngle(sim.player.yaw - v.yaw - VEHICLE_INTERACTION.exitYaw)) < 1e-6);
  assert.ok(sim.player.body.translation().y > 0);
  assert.equal(v.driver, null);
});

test('a boxed-in driver door sends Finn across the cabin and out of the passenger door', () => {
  const sim = makeSim(); boardStoppedCar(sim);
  const v = sim.playerVehicle!;
  const blocker = sideBlocker(sim, 1);
  sim.step(NEUTRAL);
  sim.step(cmd({ buttons: Button.interact }));
  assert.equal(sim.mode, 'exiting');
  assert.deepEqual([sim.vehicleInteraction?.side, sim.vehicleInteraction?.clip], ['passenger', 'exitPassenger']);
  assert.match(sim.digest(), /exitPassenger/);
  waitForMode(sim, 'onFoot', Math.round(VEHICLE_INTERACTION.durations.exitPassenger * 60) + 5);
  const [x, y, z] = VEHICLE_INTERACTION.stage, stage = v.localToWorld([-x, y, z]);
  assert.ok(Math.hypot(sim.player.position[0] - stage[0], sim.player.position[2] - stage[2]) < 0.05, 'Finn stands beside the passenger door');
  assert.ok(Math.abs(wrapAngle(sim.player.yaw - v.yaw + VEHICLE_INTERACTION.exitYaw)) < 1e-6, 'mirrored exit heading');
  assert.ok(sim.player.body.translation().y > 0);
  assert.equal(sim.player.inVehicle, null);
  sim.world.physics.removeCollider(blocker, true);
});

test('replay hashes include the delayed exit request before the position changes', () => {
  const a = makeSim(), b = makeSim(); boardStoppedCar(a); boardStoppedCar(b);
  for (let i = 0; i < 60; i++) { a.step(cmd({ moveZ: 1 })); b.step(cmd({ moveZ: 1 })); }
  // Both paths brake identically this tick; only A has queued an exit when stopped.
  a.step(cmd({ buttons: Button.interact }));
  b.step(cmd({ buttons: Button.handbrake }));
  assert.equal(a.mode, 'driving');
  assert.notEqual(a.hash(), b.hash());
  assert.match(a.digest(), /vehicle:/);
});

test('an obstruction arriving during exit plays the exit back into the seat without a permanent lock', () => {
  const sim = makeSim(); boardStoppedCar(sim);
  const v = sim.playerVehicle!;
  sim.step(cmd({ buttons: Button.interact }));
  for (let i = 0; i < 80; i++) sim.step(NEUTRAL);
  assert.equal(sim.mode, 'exiting');
  const progress = sim.vehicleInteraction!.progress;
  const stage = v.localToWorld(VEHICLE_INTERACTION.stage);
  const blocker = sim.world.physics.createCollider(RAPIER.ColliderDesc.cuboid(0.15, 1, 1).setTranslation(stage[0], 1, stage[2]).setCollisionGroups(groups(GROUP.static, GROUP.all)));
  sim.step(NEUTRAL); sim.step(NEUTRAL); sim.step(NEUTRAL);
  assert.ok(sim.vehicleInteraction!.progress < progress, 'the visible exit is reversed, not teleported');
  waitForMode(sim, 'driving', 100);
  assert.equal(sim.playerVehicle?.id, v.id);
  assert.ok(sim.player.body.translation().y < -900);
  sim.world.physics.removeCollider(blocker, true);
  for (let i = 0; i < 12; i++) sim.step(NEUTRAL);
  sim.step(cmd({ buttons: Button.interact }));
  waitForMode(sim, 'onFoot');
  assert.ok(sim.player.body.translation().y > 0);
});

before(async () => { await initPhysics(); });

test('the player stands on the ground, walks at run speed and faces the way it moves', () => {
  const sim = makeSim();
  for (let i = 0; i < 30; i++) sim.step(NEUTRAL);
  assert.ok(Math.abs(sim.player.position[1]) < 0.05 && sim.player.grounded, `feet at ${sim.player.position[1]}`);
  for (let i = 0; i < 120; i++) sim.step(cmd({ moveZ: 1, yaw: Math.PI / 2 })); // camera looks east
  assert.ok(sim.player.position[0] > 5.5 && sim.player.position[0] < 7.5, `walked ${sim.player.position[0]} m east in 2 s`);
  assert.equal(sim.player.clip, 'run');
  assert.ok(Math.abs(sim.player.yaw - Math.PI / 2) < 0.05);
});

test('enter the car, drive forward, exit beside it', () => {
  const sim = makeSim();
  boardStoppedCar(sim);
  assert.equal(sim.mode, 'driving');
  const v = sim.vehicles.get('car-1')!;
  const z0 = v.position[2];
  for (let i = 0; i < 180; i++) sim.step(cmd({ moveZ: 1 }));
  assert.ok(v.forwardSpeed > 10, `forward speed ${v.forwardSpeed} after 3 s`);
  // Heading 0 is north, which is -Z in the runtime frame.
  assert.ok(z0 - v.position[2] > 15, `moved ${z0 - v.position[2]} m north`);
  assert.ok(v.upright && v.wheelsInContact === 4);
  for (let i = 0; i < 120; i++) sim.step(cmd({ moveZ: -1 }));
  sim.step(cmd({ buttons: Button.interact }));
  waitForMode(sim, 'onFoot');
  assert.equal(sim.mode, 'onFoot');
  const d = Math.hypot(sim.player.position[0] - v.position[0], sim.player.position[2] - v.position[2]);
  assert.ok(d > 1.2 && d < 3, `exited ${d} m from the car`);
});

test('identical command streams give identical state hashes', () => {
  const a = makeSim(7), b = makeSim(7);
  const script = (t: number): Command => t < 60 ? cmd({ moveZ: 1, yaw: Math.PI, buttons: Button.sprint }) : t === 60 ? cmd({ buttons: Button.interact }) : t < 400 ? cmd({ moveZ: 1, moveX: 0.3 }) : cmd({ moveZ: -1 });
  for (let t = 0; t < 500; t++) { a.step(script(t)); b.step(script(t)); }
  assert.equal(a.hash(), b.hash());
  assert.equal(a.digest(), b.digest());
});

test('crimes raise stars that decay while hidden, and firing uses the magazine', () => {
  const sim = makeSim();
  sim.crime('ramPolice', true);
  sim.step(NEUTRAL);
  assert.equal(sim.wanted.stars, 1);
  sim.crime('shootAtPolice', true);
  sim.step(NEUTRAL);
  assert.equal(sim.wanted.stars, 3);
  for (let i = 0; i < 60 * 7; i++) sim.step(NEUTRAL); // no police, so never seen: 3 + 2 + 1 s of decay
  assert.equal(sim.wanted.stars, 0);
  const mag = () => sim.inventory.weapon?.magazine ?? -1;
  sim.step(cmd({ buttons: Button.aim }));
  assert.equal(mag(), 12);
  for (let i = 0; i < 30; i++) sim.step(cmd({ buttons: Button.aim | Button.fire }));
  assert.equal(mag(), 12 - 3, 'three rounds at 360 rpm over half a second');
  for (let i = 0; i < 40; i++) sim.step(NEUTRAL); // the civilian report lands after witnessReportSeconds
  assert.ok(sim.wanted.stars >= 1, 'firing in the city is reported');
});

test('death sends the player to the hospital anchor with the wanted level cleared', () => {
  const sim = makeSim();
  sim.crime('ramPolice', true);
  sim.step(NEUTRAL);
  sim.player.takeDamage(500);
  sim.step(NEUTRAL);
  assert.equal(sim.mode, 'wasted');
  assert.equal(sim.state().screen?.destination, 'Meilahti hospital');
  for (let i = 0; i < sim.options.screenTicks + 2; i++) sim.step(NEUTRAL);
  assert.equal(sim.mode, 'onFoot');
  assert.ok(Math.hypot(sim.player.position[0] - 50, sim.player.position[2] - 50) < 1);
  assert.equal(sim.wanted.stars, 0);
  assert.equal(sim.player.health, 100);
});

function reachEnding(sim: Simulation, kind: 'wasted' | 'busted'): void {
  if (kind === 'wasted') { sim.player.takeDamage(500); sim.step(NEUTRAL); }
  else {
    const p = sim.player.position;
    const v = sim.spawnVehicle(null, 'patrol', [p[0] + 10, p[2] + 10], 0);
    const officer = sim.spawnCharacter(null, [p[0] + 1.5, p[1], p[2]], Math.PI / 2, 100);
    sim.police.units.push(new PoliceUnit('arrest-test', v, officer, 0));
    sim.wanted.report('ramPolice', sim.tick, true, 0, sim.events);
    sim.lastFireTick = -100000;
    sim.inventory.select(-1);
    for (let i = 0; i < 300 && sim.mode !== 'busted'; i++) sim.step(NEUTRAL);
  }
  assert.equal(sim.mode, kind);
  for (let i = 0; i < sim.options.screenTicks; i++) sim.step(NEUTRAL);
  assert.equal(sim.mode, 'onFoot');
}

test('every death and arrest restores exactly the starting loadout, clears stale reloads and permits firing again', () => {
  const sim = makeSim();
  for (const kind of ['wasted', 'busted', 'wasted', 'busted'] as const) {
    const before = sim.inventory.slots[0]!;
    before.magazine = 0; before.reserve = 500; before.cooldownTicks = 9999; before.reloadTicks = 9999;
    reachEnding(sim, kind);
    assert.equal(sim.inventory.current, -1, 'the fresh weapon starts holstered');
    assert.equal(sim.inventory.slots.length, 1, 'repeated respawns do not duplicate guns');
    const after = sim.inventory.slots[0]!;
    assert.deepEqual({ magazine: after.magazine, reserve: after.reserve, cooldown: after.cooldownTicks, reload: after.reloadTicks },
      { magazine: 12, reserve: 24, cooldown: 0, reload: 0 });
    sim.step(cmd({ buttons: Button.aim | Button.fire }));
    assert.equal(after.magazine, 11);
    assert.ok(sim.events.some(e => e.type === 'fire'));
  }
});

function recoverySim(g: GameplayBundle, roadGraph: RoadGraph = roads, withGround = true): Simulation {
  const w = StaticWorld.fromBytes(terrain, roadGraph, g);
  if (withGround) w.addCell('flat', ground);
  return new Simulation(w, { seed: 1, screenTicks: 3 });
}

function assertSupportedPlayer(sim: Simulation): void {
  const p = sim.player.position, b = sim.gameplay.playArea, t = sim.world.terrain;
  assert.ok(p[0] >= Math.max(b.minX, t.x0) && p[0] <= Math.min(b.maxX, t.x0 + (t.nx - 1) * t.resolution));
  assert.ok(p[2] >= Math.max(b.minZ, t.z0) && p[2] <= Math.min(b.maxZ, t.z0 + (t.nz - 1) * t.resolution));
  const support = sim.world.groundBelow(p[0], p[1] + 0.2, p[2], 1);
  assert.ok(support && Math.abs(p[1] - support.y) < 0.15, `supported feet at ${p.join(',')}`);
}

test('outside initial spawn and hospital/police anchors fall back inside the actual terrain and play area', () => {
  const g: GameplayBundle = { ...gameplay,
    playArea: { minX: -25, maxX: 25, minZ: -25, maxZ: 25 },
    player: { ...gameplay.player, spawn: { position: [500, 500], headingDeg: 0 } },
    anchors: gameplay.anchors.map(a => ({ ...a, position: [500, 500] })), vehicles: [],
  };
  const sim = recoverySim(g);
  assertSupportedPlayer(sim);
  for (const kind of ['wasted', 'busted'] as const) {
    reachEnding(sim, kind);
    for (let i = 0; i < 240; i++) sim.step(NEUTRAL);
    assertSupportedPlayer(sim);
    assert.equal(sim.log.filter(e => e.type === 'killPlane').length, 0);
  }
});

test('all four map edges and very distant falls recover once, even with no roads', () => {
  const sim = recoverySim(gameplay);
  for (const [x, z] of [[-101, 0], [101, 0], [0, -101], [0, 101], [-10000, -10000], [10000, 10000]]) {
    const before = sim.log.filter(e => e.type === 'killPlane').length;
    sim.player.teleport([x!, -50, z!], 0);
    sim.step(NEUTRAL);
    assertSupportedPlayer(sim);
    for (let i = 0; i < 240; i++) sim.step(NEUTRAL);
    assertSupportedPlayer(sim);
    assert.equal(sim.player.grounded, true);
    assert.equal(sim.log.filter(e => e.type === 'killPlane').length, before + 1, 'no repeated recovery loop');
  }
});

test('a nearest road outside terrain cannot be used for player or far-away occupied vehicle recovery', () => {
  const outsideRoads: RoadGraph = { ...roads, lanes: [{ id: 'outside', wayId: 1, index: 0, count: 1, name: null, highway: 'road', surface: 'asphalt', speedLimit: 10, width: 4,
    from: 'a', to: 'b', points: [[500, 0, 490], [500, 0, 510]], length: 20 }] };
  const sim = recoverySim({ ...gameplay, playArea: { minX: -600, maxX: 600, minZ: -600, maxZ: 600 } }, outsideRoads);
  sim.player.teleport([500, -50, 500], 0);
  sim.step(NEUTRAL);
  assertSupportedPlayer(sim);
  const vehicle = sim.vehicles.get('car-1')!;
  sim.player.inVehicle = vehicle.id; sim.mode = 'driving'; vehicle.driver = 'player'; vehicle.occupants.add('player');
  vehicle.place([500, -50, 500], 1);
  sim.step(NEUTRAL);
  assert.ok(Math.abs(vehicle.position[0]) < 97 && Math.abs(vehicle.position[2]) < 97);
  const recovered = [...vehicle.position], recoveries = sim.log.filter(e => e.type === 'killPlane').length;
  for (let i = 0; i < 300; i++) sim.step(NEUTRAL);
  assert.ok(vehicle.position[1] > -1 && vehicle.wheelsInContact === 4);
  assert.ok(Math.hypot(vehicle.position[0] - recovered[0]!, vehicle.position[2] - recovered[2]!) < 0.5);
  assert.equal(sim.log.filter(e => e.type === 'killPlane').length, recoveries);
  assert.equal(sim.playerVehicle, vehicle);
});

test('unsupported anchors and roads cannot use terrain-height sampling as fictional ground', () => {
  const g: GameplayBundle = { ...gameplay, vehicles: [], anchors: gameplay.anchors.map(a => ({ ...a, position: [50, 50] })) };
  const unsupportedRoads: RoadGraph = { ...roads, lanes: [{ id: 'unsupported', wayId: 1, index: 0, count: 1, name: null, highway: 'road', surface: 'asphalt', speedLimit: 10, width: 4,
    from: 'a', to: 'b', points: [[45, 0, 50], [55, 0, 50]], length: 10 }] };
  const w = StaticWorld.fromBytes(terrain, unsupportedRoads, g);
  for (const handle of w.staticHandles) w.physics.removeCollider(w.physics.getCollider(handle)!, true);
  w.staticHandles.clear();
  w.physics.createCollider(RAPIER.ColliderDesc.cuboid(5, 0.5, 5).setTranslation(0, -0.5, 0).setCollisionGroups(groups(GROUP.static, GROUP.all)));
  const sim = new Simulation(w, { seed: 2, screenTicks: 3 });
  reachEnding(sim, 'wasted');
  assertSupportedPlayer(sim);
  assert.ok(Math.abs(sim.player.position[0]) < 5 && Math.abs(sim.player.position[2]) < 5);
  sim.player.teleport([50, -50, 50], 0); sim.step(NEUTRAL);
  for (let i = 0; i < 240; i++) sim.step(NEUTRAL);
  assertSupportedPlayer(sim);
  assert.equal(sim.log.filter(e => e.type === 'killPlane').length, 1);
});

test('vehicle recovery checks its full support footprint and avoids solid walls and the player', () => {
  const sim = recoverySim(gameplay);
  box(sim, [0, 1, 3], [8, 1, 0.5]);
  sim.step(NEUTRAL);
  const vehicle = sim.vehicles.get('car-1')!;
  vehicle.place([10000, -50, 10000], 0);
  sim.recoverVehicle(vehicle);
  for (const x of [-1.2, 1.2]) for (const z of [-2.7, 2.7]) {
    const corner = vehicle.localToWorld([x, 0, z]);
    assert.ok(Math.abs(corner[0]) < 100 && Math.abs(corner[2]) < 100);
    assert.ok(sim.world.groundBelow(corner[0], corner[1] + 1, corner[2], 3));
  }
  for (let i = 0; i < 300; i++) sim.step(NEUTRAL);
  assert.ok(vehicle.upright && vehicle.wheelsInContact === 4 && vehicle.position[1] > -1);
  assert.ok(Math.hypot(vehicle.position[0] - sim.player.position[0], vehicle.position[2] - sim.player.position[2]) > 2);
});

function settle(sim: Simulation): void { for (let i = 0; i < 30; i++) sim.step(NEUTRAL); }
function box(sim: Simulation, centre: [number, number, number], half: [number, number, number]): void {
  sim.world.physics.createCollider(RAPIER.ColliderDesc.cuboid(...half).setTranslation(...centre).setCollisionGroups(groups(GROUP.static, GROUP.all)));
}

test('A and D move toward camera left and right at every cardinal camera heading', () => {
  for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) for (const moveX of [-1, 1]) {
    const sim = makeSim(); settle(sim);
    const start = [...sim.player.position];
    for (let i = 0; i < 20; i++) sim.step(cmd({ moveX, yaw }));
    const dx = sim.player.position[0] - start[0]!, dz = sim.player.position[2] - start[2]!;
    const screenRightDistance = dx * -Math.cos(yaw) + dz * Math.sin(yaw);
    assert.ok(screenRightDistance * moveX > 1, `yaw=${yaw}, moveX=${moveX}, screenRight=${screenRightDistance}`);
    assert.ok(Math.abs(dx * Math.sin(yaw) + dz * Math.cos(yaw)) < 0.01);
  }
});

test('one jump anticipates, rises 0.9 m, falls and absorbs the collision-authoritative landing', () => {
  const sim = makeSim(); settle(sim);
  const groundY = sim.player.position[1];
  sim.step(cmd({ buttons: Button.jump }));
  assert.equal(sim.state().player.jumpPhase, 'takeoff');
  assert.equal(sim.player.grounded, true);
  let apex = 0;
  const phases = new Set([sim.player.jumpPhase]);
  for (let i = 0; i < 95; i++) {
    sim.step(NEUTRAL);
    apex = Math.max(apex, sim.player.position[1] - groundY);
    phases.add(sim.player.jumpPhase);
    if (sim.player.jumpPhase === 'rise') assert.equal(sim.player.grounded, false);
  }
  assert.ok(apex > 0.88 && apex < 0.92, `apex=${apex}`);
  assert.deepEqual([...phases], ['takeoff', 'rise', 'fall', 'land', 'grounded']);
  // Rapier preserves its 3 cm controller gap on landing; the spawn starts exactly on the floor.
  assert.ok(sim.player.position[1] >= groundY && sim.player.position[1] - groundY < 0.035);
  assert.equal(sim.player.verticalSpeed, 0);
  assert.equal(sim.player.jumpKind, null);
});

test('a quick second press upgrades once to a 2.8 m apex without tap-timing height inflation', () => {
  for (const secondPress of [2, 8, 16]) {
    const sim = makeSim(); settle(sim);
    const groundY = sim.player.position[1];
    let apex = 0;
    for (let i = 0; i < 150; i++) {
      sim.step(cmd({ buttons: i === 0 || i === secondPress || i === 20 || i === 24 ? Button.jump : 0 }));
      apex = Math.max(apex, sim.player.position[1] - groundY);
    }
    assert.ok(apex > 2.77 && apex < 2.83, `tap=${secondPress}, apex=${apex}`);
    assert.equal(sim.log.filter(e => e.type === 'superJump').length, 1);
    assert.equal(sim.log.filter(e => e.type === 'jump').length, 1);
    assert.ok(sim.player.grounded);
  }
});

test('holding jump never repeats, and a late second press cannot become an air boost', () => {
  const held = makeSim(); settle(held);
  let heldApex = 0;
  for (let i = 0; i < 200; i++) { held.step(cmd({ buttons: Button.jump })); heldApex = Math.max(heldApex, held.player.position[1]); }
  assert.ok(heldApex < 1);
  assert.equal(held.log.filter(e => e.type === 'jump').length, 1);
  assert.equal(held.log.filter(e => e.type === 'superJump').length, 0);
  const late = makeSim(); settle(late);
  for (let i = 0; i < 100; i++) late.step(cmd({ buttons: i === 0 || i === 20 ? Button.jump : 0 }));
  assert.equal(late.log.filter(e => e.type === 'superJump').length, 0);
  assert.ok(late.player.grounded);
});

test('jumping lands on elevated surfaces, with feet remaining above their collision tops', () => {
  for (const height of [0.7, 2.3]) {
    const sim = makeSim();
    box(sim, [0, height / 2, 3], [2, height / 2, 1.5]);
    settle(sim);
    for (let i = 0; i < 130; i++) {
      sim.step(cmd({ moveZ: sim.player.position[2] < 2.5 ? 1 : 0, buttons: i === 0 || (height > 1 && i === 8) ? Button.jump : 0 }));
      if (sim.player.position[2] > 1.5 + CHARACTER.radius) assert.ok(sim.player.position[1] >= height, `height=${height}, feet=${sim.player.position}`);
    }
    assert.ok(sim.player.position[2] > 2, `reached platform ${height}: ${sim.player.position}`);
    assert.ok(sim.player.grounded);
    assert.ok(sim.player.position[1] > height && sim.player.position[1] < height + 0.05);
  }
});

test('a normal jump grabs a reachable 1.4 m ledge and pulls onto it through the explicit climb phase', () => {
  const sim = makeSim();
  box(sim, [0, 0.7, 3], [2, 0.7, 1.5]);
  settle(sim);
  let sawClimb = false;
  for (let i = 0; i < 130; i++) {
    sim.step(cmd({ moveZ: sim.player.position[2] < 2.5 ? 1 : 0, buttons: i === 0 ? Button.jump : 0 }));
    if (sim.player.jumpPhase === 'climb') {
      if (!sawClimb) assert.ok(sim.player.position[1] < 1, 'the normal jump remains below its apex when the hands grab');
      sawClimb = true;
      assert.ok(sim.player.climbView);
      assert.ok(Math.abs(sim.player.climbView.edge[1] - 1.4) < 0.01);
    }
    if (sim.player.position[2] > 1.5 + CHARACTER.radius) assert.ok(sim.player.position[1] >= 1.4, 'the capsule crosses the edge above the stone');
  }
  assert.ok(sawClimb, 'height above the jump apex comes from a ledge pull-up');
  assert.equal(sim.log.filter(e => e.type === 'climb').length, 1);
  assert.equal(sim.log.filter(e => e.type === 'superJump').length, 0);
  assert.ok(sim.player.position[2] > 2);
  assert.ok(sim.player.grounded && sim.player.position[1] >= 1.4 && sim.player.position[1] < 1.45);
});

test('a normal jump cannot climb a wall beyond hand reach or autostep up it while airborne', () => {
  const sim = makeSim();
  box(sim, [0, 1.4, 3], [2, 1.4, 1.5]);
  settle(sim);
  let apex = 0;
  for (let i = 0; i < 100; i++) {
    sim.step(cmd({ moveZ: 1, buttons: i === 0 ? Button.jump : 0 }));
    apex = Math.max(apex, sim.player.position[1]);
  }
  assert.ok(apex < 1);
  assert.equal(sim.log.filter(e => e.type === 'climb').length, 0);
  assert.ok(sim.player.position[2] < 1.5);
  assert.ok(sim.player.grounded && sim.player.position[1] < 0.05, `grounded=${sim.player.grounded}, feet=${sim.player.position[1]}`);
});

/** Run into a ledge whose face is at z = 1.5 with one jump (or a super jump), optionally with a slab over its top. */
function climbAttempt(height: number, kind: 'normal' | 'super', depth = 1.5, slab = false, seed?: number) {
  const sim = makeSim(seed);
  box(sim, [0, height / 2, 1.5 + depth / 2], [2, height / 2, depth / 2]);
  if (slab) box(sim, [0, height + 1.2, 3.2], [2, 0.2, 1.3]); // underside 1 m above the top, from z = 1.9
  settle(sim);
  let feetAtGrab: number | null = null;
  for (let i = 0; i < 240; i++) {
    sim.step(cmd({ moveZ: sim.player.position[2] < 2.5 ? 1 : 0, buttons: i === 0 || (kind === 'super' && i === 8) ? Button.jump : 0 }));
    if (feetAtGrab === null && sim.player.jumpPhase === 'climb') feetAtGrab = sim.player.position[1];
  }
  return { sim, feetAtGrab, climbs: sim.log.filter(e => e.type === 'climb').length };
}

test('ledge reach: a normal jump pulls up onto 2.3 m but not 2.6 m, a super jump onto 4.2 m but not 4.6 m', () => {
  for (const [height, kind, climbs] of [[2.3, 'normal', true], [2.6, 'normal', false], [4.2, 'super', true], [4.6, 'super', false]] as const) {
    const { sim, feetAtGrab, climbs: count } = climbAttempt(height, kind);
    assert.equal(count, climbs ? 1 : 0, `${kind} at ${height}`);
    if (climbs) {
      assert.ok(feetAtGrab !== null && height - feetAtGrab <= CLIMB.maxHeight + 1e-6, `hands reach the edge: feet ${feetAtGrab}`);
      assert.ok(sim.player.grounded && sim.player.position[1] >= height && sim.player.position[1] < height + 0.05, `${kind} on top of ${height}: ${sim.player.position}`);
    } else {
      assert.ok(sim.player.grounded && sim.player.position[1] < 0.05 && sim.player.position[2] < 1.5, `${kind} stays below ${height}: ${sim.player.position}`);
    }
  }
});

test('no grab without standing room: a thin wall or a slab over the top is not climbed', () => {
  for (const [depth, slab] of [[0.1, false], [1.5, true]] as const) {
    const { sim, climbs } = climbAttempt(1.4, 'normal', depth, slab);
    assert.equal(climbs, 0, `depth ${depth}, slab ${slab}`);
    assert.ok(sim.player.grounded && sim.player.position[1] < 0.05);
  }
});

test('identical ledge climbs replay deterministically', () => {
  const a = climbAttempt(1.8, 'normal', 1.5, false, 11), b = climbAttempt(1.8, 'normal', 1.5, false, 11);
  assert.equal(a.climbs, 1);
  assert.equal(a.sim.hash(), b.sim.hash());
  assert.deepEqual(a.sim.state().player, b.sim.state().player);
});

test('a low ceiling stops upward velocity immediately and cannot be bypassed with a second press', () => {
  const sim = makeSim();
  box(sim, [0, 2.3, 0], [2, 0.1, 2]); // underside at 2.2, standing capsule 1.8 m
  settle(sim);
  let apex = 0, sawCeiling = false;
  for (let i = 0; i < 100; i++) {
    sim.step(cmd({ buttons: i === 0 || i === 15 ? Button.jump : 0 }));
    apex = Math.max(apex, sim.player.position[1]);
    if (sim.player.jumpPhase === 'fall' && sim.player.verticalSpeed === 0) sawCeiling = true;
  }
  assert.ok(sawCeiling, 'ceiling contact immediately cleared upward velocity');
  assert.ok(apex < 0.4, `feet ${apex} must stay under ceiling`);
  assert.equal(sim.log.filter(e => e.type === 'superJump').length, 0);
  assert.ok(sim.player.grounded);
});

test('airborne recovery and death discard pending jump energy, and airborne presses cannot start a jump', () => {
  const sim = makeSim(); settle(sim);
  sim.player.teleport([0, 3, 0], 0);
  sim.step(cmd({ buttons: Button.jump }));
  assert.equal(sim.log.filter(e => e.type === 'jump').length, 0);
  assert.equal(sim.player.jumpPhase, 'fall');
  assert.ok(sim.player.verticalSpeed < 0);
  assert.ok((sim.state().player.groundDistance ?? 0) > 2.9);
  sim.player.teleport([0, 0.03, 0], 0);
  settle(sim);
  sim.step(cmd({ buttons: Button.jump }));
  sim.player.takeDamage(1000);
  sim.step(NEUTRAL);
  assert.equal(sim.mode, 'wasted');
  assert.equal(sim.player.jumpKind, null);
  assert.equal(sim.player.verticalSpeed, 0);
  for (let i = 0; i < sim.options.screenTicks + 5; i++) sim.step(NEUTRAL);
  assert.equal(sim.mode, 'onFoot');
  assert.ok(sim.player.grounded);
  assert.equal(sim.player.jumpKind, null);
});

test('identical jump and camera-relative movement commands replay deterministically', () => {
  const a = makeSim(11), b = makeSim(11); settle(a); settle(b);
  for (let i = 0; i < 180; i++) {
    const command = cmd({ moveZ: 0.7, moveX: 0.3, yaw: 0.7, buttons: i === 0 || i === 8 ? Button.jump : 0 });
    a.step(command); b.step(command);
    assert.equal(a.hash(), b.hash());
    assert.deepEqual(a.state().player, b.state().player);
  }
});

test('death in midair cancels jump upgrades but gravity lands the character before respawn', () => {
  const sim = makeSim(); settle(sim);
  sim.step(cmd({ buttons: Button.jump }));
  for (let i = 0; i < 14; i++) sim.step(NEUTRAL);
  assert.ok(!sim.player.grounded && sim.player.position[1] > 0.4);
  const beforeDeathVelocity = sim.player.verticalSpeed;
  sim.player.takeDamage(1000);
  assert.equal(sim.player.verticalSpeed, beforeDeathVelocity, 'death preserves momentum');
  sim.step(cmd({ buttons: Button.jump }));
  assert.equal(sim.mode, 'wasted');
  assert.equal(sim.player.jumpKind, null);
  for (let i = 0; i < 80; i++) sim.step(NEUTRAL);
  assert.equal(sim.mode, 'wasted', 'landing happened before the screen finished');
  assert.ok(sim.player.grounded && sim.player.position[1] < 0.05, `grounded=${sim.player.grounded}, feet=${sim.player.position[1]}`);
  assert.equal(sim.player.verticalSpeed, 0);
});

test('jump replay hashes distinguish pending jump phases before position changes', () => {
  const a = makeSim(), b = makeSim(); settle(a); settle(b);
  a.step(cmd({ buttons: Button.jump })); b.step(NEUTRAL);
  assert.deepEqual(a.player.position, b.player.position);
  assert.notEqual(a.hash(), b.hash());
  assert.notEqual(a.digest(), b.digest());
});

test('ground autostep is restored after landing, while car Space remains a handbrake', () => {
  const sim = makeSim();
  box(sim, [0, 0.15, 3], [2, 0.15, 1.5]);
  settle(sim);
  for (let i = 0; i < 95; i++) sim.step(cmd({ buttons: i === 0 ? Button.jump : 0 }));
  for (let i = 0; i < 45; i++) sim.step(cmd({ moveZ: 1 }));
  assert.ok(sim.player.grounded && sim.player.position[1] > 0.3 && sim.player.position[1] < 0.35);
  const carSim = makeSim(); boardStoppedCar(carSim);
  assert.equal(carSim.mode, 'driving');
  carSim.step(cmd({ buttons: Button.handbrake | Button.jump }));
  assert.equal(carSim.playerVehicle?.input.handbrake, true);
  assert.equal(carSim.player.jumpKind, null);
  assert.equal(carSim.log.filter(e => e.type === 'jump').length, 0);
});
