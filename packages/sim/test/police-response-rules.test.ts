import assert from 'node:assert/strict';
import fs from 'node:fs';
import {before, test} from 'node:test';
import {encodeCollisionBundle, encodeTerrain, type GameplayBundle, type RoadGraph} from '@helsinki/world-schema';
import {Button, decodeCommand, encodeCommand, initPhysics, NEUTRAL, PoliceUnit, Simulation, StaticWorld} from '../src/index.ts';

before(initPhysics);
const base = JSON.parse(fs.readFileSync(new URL('../../../content/helsinki/gameplay.json', import.meta.url), 'utf8')) as GameplayBundle;
const roads: RoadGraph = {
  schemaVersion: 2, originId: 'response-test', source: {id: 'test', sha256: 'x', attribution: 'test', license: 'CC0'}, nodes: [], parking: [], footways: [],
  lanes: [
    {id: 'east', wayId: 1, index: 0, count: 1, name: 'test', highway: 'residential', surface: 'asphalt', speedLimit: 10, width: 4, points: [[-250, 0, -6], [250, 0, -6]], length: 500, from: 'west', to: 'east'},
    {id: 'west', wayId: 2, index: 0, count: 1, name: 'test', highway: 'residential', surface: 'asphalt', speedLimit: 10, width: 4, points: [[250, 0, 6], [-250, 0, 6]], length: 500, from: 'east', to: 'west'},
  ],
  connectors: [
    {id: 'turn-east', from: 'east', to: 'west', node: 'east', points: [[250, 0, -6], [250, 0, 6]], length: 12, turn: 'u-turn'},
    {id: 'turn-west', from: 'west', to: 'east', node: 'west', points: [[-250, 0, 6], [-250, 0, -6]], length: 12, turn: 'u-turn'},
  ],
};
function makeSim(dispatch = false): Simulation {
  const gameplay: GameplayBundle = {...base, schemaVersion: 2, originId: 'response-test', killHeight: -30,
    playArea: {minX: -300, maxX: 300, minZ: -200, maxZ: 200}, player: {...base.player, spawn: {position: [0, 25], headingDeg: 180}},
    vehicles: [{id: 'first-car', definition: 'lumi-gt', position: [0, 25], headingDeg: 180, occupied: false}],
    police: {...base.police, initialPatrols: 0, patrolSpawns: [{position: [-150, -6], headingDeg: 90}]},
    wanted: {...base.wanted, unitCaps: dispatch ? [1, 2, 3, 4, 5] : [0, 0, 0, 0, 0],
      arrest: {...base.wanted.arrest, boxedSeconds: dispatch ? base.wanted.arrest.boxedSeconds : 10000}}};
  const terrain = encodeTerrain({x0: -300, z0: -200, resolution: 10, nx: 61, nz: 41, heights: new Float32Array(61 * 41)});
  const world = StaticWorld.fromBytes(terrain, roads, gameplay);
  world.addCell('flat', encodeCollisionBundle({originId: 'response-test', frame: 'X-east,Y-up,Z-south', cell: 'flat', surfaceTags: ['road:asphalt']}, [{id: 'ground', group: 'ground', ref: null,
    positions: new Float32Array([-300, 0, -200, 300, 0, -200, 300, 0, 200, -300, 0, 200]), indices: new Uint32Array([0, 2, 1, 0, 3, 2]), triangleTags: new Uint16Array([0, 0])}]));
  return new Simulation(world, {seed: 12, screenTicks: 5});
}
const command = (buttons = 0) => ({...NEUTRAL, buttons});
function settleBesideCar(sim: Simulation): void {
  const car = sim.vehicles.get('first-car')!, beside = car.localToWorld([2.1, 0, -.95]);
  sim.player.teleport([beside[0], 0, beside[2]], car.yaw);
  for (let i = 0; i < 30; i++) sim.step(NEUTRAL);
}
function board(sim: Simulation): number {
  settleBesideCar(sim);
  sim.step(command(Button.interact));
  assert.equal(sim.mode, 'entering');
  for (let i = 0; i < 800 && sim.mode === 'entering'; i++) {
    assert.equal(sim.log.some(e => e.type === 'crime' && e.detail === 'takeCar'), false, 'approach and seating do not complete the theft early');
    sim.step(NEUTRAL);
  }
  assert.equal(sim.mode, 'driving');
  return sim.tick;
}
function footOfficer(sim: Simulation): PoliceUnit {
  const car = sim.spawnVehicle('test-patrol', 'patrol', [70, 70], 0);
  const officer = sim.spawnCharacter('test-officer', [20, 0, 0], -Math.PI / 2, 100);
  const unit = new PoliceUnit('test-unit', car, officer, 0);
  unit.sees = true;
  sim.police.units.push(unit);
  sim.player.teleport([0, 0, 0], 0);
  sim.player.armour = 1000;
  for (let i = 0; i < 3; i++) sim.step(NEUTRAL);
  return unit;
}

test('the first completed unseen civilian theft reports within 3–6 seconds and starts local pursuit', () => {
  const sim = makeSim(true);
  try {
    const seatedTick = board(sim);
    assert.equal(sim.wanted.stars, 0);
    assert.equal(sim.police.units.length, 0);
    for (let i = 0; i < 362 && !sim.log.some(e => e.type === 'crime' && e.detail === 'takeCar'); i++) sim.step(NEUTRAL);
    const report = sim.log.find(e => e.type === 'crime' && e.detail === 'takeCar');
    assert.ok(report);
    assert.ok(report.tick - seatedTick >= 180 && report.tick - seatedTick <= 360);
    assert.equal(sim.wanted.stars, 1);
    sim.step(NEUTRAL);
    assert.equal(sim.police.units.length, 1, 'a local patrol is dispatched immediately after the report');
    assert.ok(['respond', 'pursue', 'boxin'].includes(sim.police.units[0]!.state));
    assert.equal(sim.log.some(e => e.type === 'policeFire'), false);
  } finally { sim.world.physics.free(); }
});

test('an abandoned entry never reports a theft, including a patrol-car reservation', () => {
  for (const patrol of [false, true]) {
    const sim = makeSim();
    try {
      if (patrol) { sim.removeVehicle(sim.vehicles.get('first-car')!); sim.spawnVehicle('first-car', 'patrol', [0, 25], 0); }
      settleBesideCar(sim);
      sim.police.playerSeen = true;
      sim.step(command(Button.interact));
      assert.equal(sim.mode, 'entering');
      sim.vehicles.get('first-car')!.damage = 'wrecked';
      sim.step(NEUTRAL);
      assert.equal(sim.mode, 'onFoot');
      for (let i = 0; i < 370; i++) sim.step(NEUTRAL);
      assert.equal(sim.log.some(e => e.type === 'crime' && e.detail === 'takeCar'), false);
      assert.equal(sim.wanted.stars, 0);
    } finally { sim.world.physics.free(); }
  }
});

test('re-entering the same stolen car does not enqueue another theft report', () => {
  const sim = makeSim();
  try {
    board(sim);
    for (let i = 0; i < 370; i++) sim.step(NEUTRAL);
    sim.step(command(Button.interact));
    for (let i = 0; i < 400 && sim.mode !== 'onFoot'; i++) sim.step(NEUTRAL);
    assert.equal(sim.mode, 'onFoot');
    settleBesideCar(sim);
    sim.step(command(Button.interact));
    for (let i = 0; i < 800 && sim.state().player.mode === 'entering'; i++) sim.step(NEUTRAL);
    assert.equal(sim.mode, 'driving');
    for (let i = 0; i < 370; i++) sim.step(NEUTRAL);
    assert.equal(sim.log.filter(e => e.type === 'crime' && e.detail === 'takeCar').length, 1);
  } finally { sim.world.physics.free(); }
});

test('five-star vehicle violence, drawing and aiming never let the police shoot first', () => {
  const sim = makeSim();
  try {
    const officer = footOfficer(sim);
    sim.crime('killOfficer', true); sim.crime('kill', true); sim.crime('ramPolice', true); sim.crime('hitPedestrian', true);
    assert.equal(sim.wanted.stars, 5);
    for (let i = 0; i < 60; i++) sim.step(command(Button.aim));
    assert.ok(officer.sees && sim.aiming);
    assert.equal(sim.inventory.weapon?.magazine, 12);
    assert.equal(sim.wanted.playerHasFired, false);
    assert.equal(sim.log.some(e => e.type === 'policeFire'), false);
  } finally { sim.world.physics.free(); }
});

test('a replacement vehicle reusing a retired car ID still reports a new theft', () => {
  const sim = makeSim();
  try {
    board(sim);
    for (let i = 0; i < 370; i++) sim.step(NEUTRAL);
    sim.step(command(Button.interact));
    for (let i = 0; i < 400 && sim.mode !== 'onFoot'; i++) sim.step(NEUTRAL);
    assert.equal(sim.mode, 'onFoot');
    assert.ok(sim.removeVehicle(sim.vehicles.get('first-car')!));
    sim.spawnVehicle('first-car', 'lumi-gt', [0, 25], 0);
    settleBesideCar(sim);
    sim.step(command(Button.interact));
    for (let i = 0; i < 800 && sim.state().player.mode === 'entering'; i++) sim.step(NEUTRAL);
    assert.equal(sim.mode, 'driving');
    for (let i = 0; i < 370; i++) sim.step(NEUTRAL);
    assert.equal(sim.log.filter(e => e.type === 'crime' && e.detail === 'takeCar').length, 2);
  } finally { sim.world.physics.free(); }
});

test('return-fire permission is part of replay identity before another action changes visible state', () => {
  const a = makeSim(), b = makeSim();
  try {
    assert.equal(a.hash(), b.hash());
    a.wanted.recordPlayerShot();
    assert.notEqual(a.hash(), b.hash());
    assert.notEqual(a.digest(), b.digest());
    a.wanted.clear();
    assert.equal(a.hash(), b.hash());
  } finally { a.world.physics.free(); b.world.physics.free(); }
});

test('empty-trigger presses and reloads do not authorise police return fire', () => {
  const sim = makeSim();
  try {
    footOfficer(sim);
    sim.crime('killOfficer', true);
    sim.inventory.select(0);
    sim.inventory.weapon!.magazine = 0;
    sim.inventory.weapon!.reserve = 0;
    for (let i = 0; i < 20; i++) sim.step(command(Button.fire | Button.aim));
    assert.equal(sim.wanted.playerHasFired, false);
    sim.inventory.weapon!.reserve = 24;
    sim.step(command(Button.reload));
    for (let i = 0; i < 20; i++) sim.step(command(Button.fire | Button.aim));
    assert.ok(sim.inventory.weapon!.reloadTicks > 0);
    assert.equal(sim.log.some(e => e.type === 'fire' || e.type === 'policeFire'), false);
  } finally { sim.world.physics.free(); }
});

test('one real shot allows return fire at one star and stays valid while the encounter continues', () => {
  const sim = makeSim();
  try {
    const unit = footOfficer(sim);
    sim.police.playerSeen = true;
    sim.step(command(Button.fire));
    assert.equal(sim.inventory.weapon?.magazine, 11);
    assert.equal(sim.wanted.stars, 1, 'the first missed shot is enough; three stars are not required');
    assert.ok(sim.log.some(e => e.type === 'fire'));
    assert.ok(sim.log.some(e => e.type === 'policeFire'));
    for (let i = 0; i < 160; i++) sim.step(NEUTRAL);
    assert.ok(sim.wanted.playerHasFired && sim.policeMayFire);
    assert.ok(sim.log.some(e => e.type === 'policeFire' && e.tick > sim.lastFireTick + 90), 'return fire does not arbitrarily stop after 1.5 seconds');
    sim.inventory.select(-1);
    unit.fireTicks = 0;
    sim.step(NEUTRAL);
    assert.equal(sim.wanted.playerHasFired, false);
    assert.equal(sim.events.some(e => e.type === 'policeFire'), false, 'holstering stops return fire immediately');
    sim.step(command(Button.aim));
    sim.step(command(Button.aim));
    assert.equal(sim.policeMayFire, false, 'redrawing alone does not reopen permission after surrender');
  } finally { sim.world.physics.free(); }
});

test('an unseen actual shot retains its permission through the delayed witness report', () => {
  const sim = makeSim();
  try {
    sim.player.teleport([0, 0, 0], 0);
    sim.step(command(Button.fire));
    assert.equal(sim.wanted.stars, 0);
    for (let i = 0; i < 179; i++) sim.step(NEUTRAL);
    assert.equal(sim.wanted.stars, 0);
    assert.equal(sim.wanted.playerHasFired, true);
    for (let i = 0; i < 182 && sim.wanted.stars === 0; i++) sim.step(NEUTRAL);
    assert.equal(sim.wanted.stars, 1);
    assert.equal(sim.wanted.playerHasFired, true);
  } finally { sim.world.physics.free(); }
});

test('a moving officer keeps the aimed upper body between return-fire shots and lowers it on surrender', () => {
  const sim = makeSim();
  try {
    const unit = footOfficer(sim);
    sim.police.playerSeen = true;
    sim.step(command(Button.fire));
    assert.equal(unit.officer.clip, 'fire');
    assert.ok(unit.officer.speed > 2, 'the officer is still approaching while firing');
    sim.step(NEUTRAL);
    assert.equal(sim.shots.length, 0, 'the cooldown tick does not emit a new shot');
    assert.equal(unit.officer.clip, 'aim', 'a two-tick presentation frame retains a raised weapon and recoil');
    assert.ok(unit.officer.speed > 2, 'aim overlay retains actual moving legs');
    sim.inventory.select(-1);
    sim.step(NEUTRAL);
    assert.ok(!['aim', 'fire'].includes(unit.officer.clip), 'surrender returns to ordinary approach');
    assert.equal(sim.events.some(e => e.type === 'policeFire'), false);
  } finally { sim.world.physics.free(); }
});

test('the holster command wins simultaneous aim/fire/reload and a later draw cannot reopen return fire', () => {
  const sim = makeSim();
  try {
    const unit = footOfficer(sim);
    sim.police.playerSeen = true;
    sim.step(command(Button.fire));
    assert.equal(sim.wanted.playerHasFired, true);
    const magazine = sim.inventory.weapon!.magazine;
    unit.fireTicks = 0;
    sim.step(decodeCommand(encodeCommand(command(Button.holster | Button.fire | Button.aim | Button.reload))));
    assert.equal(sim.inventory.current, -1);
    assert.equal(sim.state().player.weapon, null);
    assert.equal(sim.aiming, false);
    assert.equal(sim.wanted.playerHasFired, false);
    assert.equal(sim.policeMayFire, false);
    assert.ok(!['aim', 'fire'].includes(sim.player.clip), 'holster releases the recent firing pose immediately');
    assert.equal(sim.inventory.slots[0]!.magazine, magazine);
    assert.equal(sim.inventory.slots[0]!.reloadTicks, 0);
    assert.equal(sim.events.some(e => e.type === 'fire' || e.type === 'policeFire' || e.type === 'aim'), false);
    assert.ok(sim.events.some(e => e.type === 'holster'));
    for (let i = 0; i < 20; i++) sim.step(command(Button.aim));
    assert.ok(sim.aiming);
    assert.equal(sim.inventory.current, 0, 'a later ordinary aim draws the weapon');
    assert.equal(sim.wanted.playerHasFired, false);
    assert.equal(sim.policeMayFire, false);
    assert.equal(sim.log.some(e => e.type === 'policeFire' && e.tick > sim.log.find(e => e.type === 'holster')!.tick), false);
    unit.fireTicks = 0;
    sim.step(command(Button.fire));
    assert.equal(sim.inventory.weapon!.magazine, magazine - 1);
    assert.equal(sim.wanted.playerHasFired, true);
    assert.ok(sim.events.some(e => e.type === 'policeFire'), 'a new real shot authorises return fire again');
  } finally { sim.world.physics.free(); }
});

test('recorded holster input lets a real officer close in and arrest deterministically', () => {
  const a = makeSim(), b = makeSim();
  try {
    for (const sim of [a, b]) { footOfficer(sim); sim.police.playerSeen = true; }
    const step = (buttons: number) => {
      const encoded = encodeCommand(command(buttons));
      a.step(decodeCommand(encoded)); b.step(decodeCommand(encoded));
      assert.equal(a.hash(), b.hash());
    };
    step(Button.fire);
    assert.equal(a.wanted.playerHasFired, true);
    step(Button.holster);
    const surrenderedAt = a.tick;
    for (let i = 0; i < 600 && a.mode !== 'busted'; i++) step(0);
    assert.equal(a.mode, 'busted', 'the officer closes its former firing standoff and performs the normal arrest');
    assert.equal(a.screen?.kind, 'busted');
    assert.equal(a.log.some(e => e.type === 'policeFire' && e.tick >= surrenderedAt), false);
    assert.equal(a.wanted.playerHasFired, false);
    assert.equal(b.mode, 'busted');
  } finally { a.world.physics.free(); b.world.physics.free(); }
});

test('evasion and respawn clear permission so a later non-firearm crime cannot reopen it', () => {
  for (const ending of ['evade', 'respawn'] as const) {
    const sim = makeSim();
    try {
      sim.player.teleport([0, 0, 0], 0);
      sim.police.playerSeen = true;
      sim.step(command(Button.fire));
      assert.ok(sim.wanted.playerHasFired);
      if (ending === 'evade') {
        sim.wanted.decayTicks = 1;
        sim.police.playerSeen = false;
        sim.step(NEUTRAL);
        assert.equal(sim.wanted.stars, 0);
      } else {
        sim.player.takeDamage(500);
        sim.step(NEUTRAL);
        assert.equal(sim.wanted.playerHasFired, false, 'death stops firing immediately');
        for (let i = 0; i < 5; i++) sim.step(NEUTRAL);
        assert.equal(sim.mode, 'onFoot');
      }
      assert.equal(sim.wanted.playerHasFired, false);
      sim.crime('killOfficer', true);
      sim.step(command(Button.aim));
      sim.step(command(Button.aim));
      assert.equal(sim.policeMayFire, false);
    } finally { sim.world.physics.free(); }
  }
});

test('a nonlethal shot hitting a civilian is reported and does not depend on an officer witness', () => {
  const sim = makeSim();
  try {
    const civilian = sim.spawnCharacter('civilian-test', [30, 0, 0], 0, 100);
    sim.resolveShot('player', {origin: [0, 1, 0], end: [30, 1, 0], colliderHandle: civilian.collider.handle, headshot: false, distance: 30}, sim.weapon('pistol'));
    assert.ok(civilian.alive && civilian.health < 100);
    for (let i = 0; i < 361; i++) sim.step(NEUTRAL);
    assert.ok(sim.log.some(e => e.type === 'crime' && e.detail === 'hitPedestrian'));
    assert.equal(sim.wanted.stars, 1);
    assert.equal(sim.wanted.playerHasFired, false, 'damage resolution by itself is not an input-triggered discharge');
  } finally { sim.world.physics.free(); }
});
