import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { encodeCollisionBundle, encodeTerrain, type GameplayBundle, type RoadGraph, type VehicleDefinition } from '@helsinki/world-schema';
import { initPhysics, StaticWorld, TICK_HZ, TICK_SECONDS, Vehicle, VEHICLE_STABILITY, type Quat, type V3 } from '../src/index.ts';

// The rollover fixture of docs/vehicle-stability-plan-2026-10-24.md (decision 0024): flat ground, one 12 cm kerb with
// its riser at x = 10 (pavement beyond), a 45° ramp 0.5 m high (x -60 .. -50, z 50 .. 200) away from the flat runs and
// a patch of 3° paving on the pavement (x 140 .. 160, z -20 .. 20) rising towards -x.
const KERB_X = 10, KERB_H = 0.12, EXT = 200, nx = 81, nz = 81, PAVING = Math.tan(3 * Math.PI / 180);
const terrain = encodeTerrain({ x0: -EXT, z0: -EXT, resolution: 5, nx, nz, heights: new Float32Array(nx * nz) });
const positions = [
  -EXT, 0, -EXT, KERB_X, 0, -EXT, KERB_X, 0, EXT, -EXT, 0, EXT, // road
  KERB_X, KERB_H, -EXT, KERB_X, KERB_H, EXT, EXT, KERB_H, -EXT, EXT, KERB_H, EXT, // riser top and pavement
  -60, 0, 50, -60, 0, EXT, -59.5, 0.5, 50, -59.5, 0.5, EXT, -50, 0.5, 50, -50, 0.5, EXT, // ramp face and top
  140, KERB_H + 20 * PAVING, -20, 140, KERB_H + 20 * PAVING, 20, 160, KERB_H, -20, 160, KERB_H, 20, // 3° paving
];
const indices = [0, 2, 1, 0, 3, 2, 1, 2, 5, 1, 5, 4, 4, 7, 6, 4, 5, 7, 8, 11, 10, 8, 9, 11, 10, 13, 12, 10, 11, 13, 14, 17, 16, 14, 15, 17];
const ground = encodeCollisionBundle({ originId: 't', frame: 'X-east,Y-up,Z-south', cell: 'fixture', surfaceTags: ['road'] }, [{
  id: 'g', group: 'ground', ref: null, positions: new Float32Array(positions), indices: new Uint32Array(indices), triangleTags: new Uint16Array(indices.length / 3),
}]);
const roads: RoadGraph = { schemaVersion: 2, originId: 't', source: { id: 'osm', sha256: 'x', attribution: 'a', license: 'ODbL' }, nodes: [], lanes: [], connectors: [], parking: [], footways: [] };

// Physics values of content/helsinki/central-expansion/gameplay.json.
const lumi: VehicleDefinition = {
  id: 'lumi-gt', label: 'Lumi GT', assetId: 'vehicle-lumi-gt', role: 'civilian', massKg: 1650, centreOfMass: [0, 0.38, 0.1],
  collider: { halfExtents: [0.94, 0.4, 2.35], centre: [0, 0.95, -0.07], skid: { halfExtents: [0.94, 0.25, 1.3], centre: [0, 0.6, -0.07] } }, wheelRadius: 0.342, wheelWidth: 0.29,
  wheels: [
    { socket: 'WHEEL_FL', position: [0.822, 0.342, 1.333], steer: true, drive: false, handbrake: false },
    { socket: 'WHEEL_FR', position: [-0.822, 0.342, 1.333], steer: true, drive: false, handbrake: false },
    { socket: 'WHEEL_RL', position: [0.822, 0.342, -1.333], steer: false, drive: true, handbrake: true },
    { socket: 'WHEEL_RR', position: [-0.822, 0.342, -1.333], steer: false, drive: true, handbrake: true },
  ],
  suspension: { restLength: 0.42, stiffness: 32, damping: 4.4, compression: 4, maxTravel: 0.3 }, tyres: { frictionSlip: 3.2, sideFriction: 1 },
  engine: { maxForceN: 9000, reverseForceN: 4500, topSpeedMs: 58, topSpeedReverseMs: 8 }, brakes: { forceN: 5200, handbrakeN: 7000 },
  steering: { maxAngleDeg: 36, highSpeedAngleDeg: 9, rateDegPerS: 140 }, aero: { dragCoefficient: 0.42, downforce: 0.6 },
  seat: { driver: [0.365, 0.598, -0.281], exits: [[1.5, 0, -0.035], [-1.5, 0, -0.035]], entryRadius: 2.4 },
  cameraChase: [0, 2.3, -7.5], health: 1000, damage: { smokeBelow: 0.3, fireBelow: 0.1, explodeAfterSeconds: 5 },
};
const patrol: VehicleDefinition = {
  ...lumi, id: 'patrol', label: 'Patrol car', assetId: 'vehicle-patrol', role: 'patrol', massKg: 1750, suspension: { ...lumi.suspension, stiffness: 30 },
  tyres: { frictionSlip: 3.4, sideFriction: 1 }, engine: { maxForceN: 8600, reverseForceN: 4500, topSpeedMs: 52, topSpeedReverseMs: 8 },
  steering: { ...lumi.steering, rateDegPerS: 150 }, aero: { dragCoefficient: 0.44, downforce: 0.6 }, health: 1200,
};
const revontuli: VehicleDefinition = {
  ...lumi, id: 'revontuli', label: 'Revontuli', assetId: 'vehicle-revontuli', massKg: 1850, centreOfMass: [0, 0.4, -0.05],
  collider: { halfExtents: [0.99, 0.325, 2.229], centre: [0, 0.875, 0.043], skid: { halfExtents: [0.99, 0.25, 1.325], centre: [0, 0.6, 0] } }, wheelRadius: 0.36, wheelWidth: 0.264,
  wheels: [
    { socket: 'WHEEL_FL', position: [0.847, 0.36, 1.355], steer: true, drive: false, handbrake: false },
    { socket: 'WHEEL_FR', position: [-0.852, 0.36, 1.355], steer: true, drive: false, handbrake: false },
    { socket: 'WHEEL_RL', position: [0.847, 0.36, -1.355], steer: false, drive: true, handbrake: true },
    { socket: 'WHEEL_RR', position: [-0.852, 0.36, -1.355], steer: false, drive: true, handbrake: true },
  ],
  engine: { maxForceN: 10500, reverseForceN: 4500, topSpeedMs: 64, topSpeedReverseMs: 8 },
  seat: { driver: [0.411, 0.516, 0.167], exits: [[1.5, 0, 0.308], [-1.5, 0, 0.308]], entryRadius: 2.4 },
};
const gameplay: GameplayBundle = {
  schemaVersion: 2, originId: 't', killHeight: -25, playArea: { minX: -EXT, maxX: EXT, minZ: -EXT, maxZ: EXT },
  player: { spawn: { position: [0, 0], headingDeg: 0 }, health: 100, armour: 0 }, vehicleDefinitions: [lumi, patrol, revontuli], vehicles: [], anchors: [], weapons: [],
  wanted: { starWeights: { takeCar: 1, ram: 0.5, ramPolice: 1, hitPedestrian: 1, drawWeapon: 0.4, fire: 1, shootAtPolice: 2, kill: 3, killOfficer: 3 }, starThresholds: [1, 2, 3, 5, 8], decaySeconds: [1, 2, 3, 4, 5], unitCaps: [0, 0, 0, 0, 0], witnessReportSeconds: [0.5, 0.5], arrest: { footRadius: 3, footSeconds: 2, boxedSeconds: 3 }, searchRadius: 60 },
  police: { spawnMinDistance: 150, initialPatrols: 0, patrolSpawns: [] }, addresses: [], landmarks: [], district: { name: 't', boundary: [] }, playerStart: { weapons: [] },
};

const degrees = (radians: number) => radians * 180 / Math.PI;
const round = (x: number) => Math.round(x * 1000) / 1000;

/** Drives one car the way `Simulation.step` does (`Vehicle.step`, then the physics step) and measures every tick. */
class Rig {
  readonly world = StaticWorld.fromBytes(terrain, roads, gameplay);
  readonly v: Vehicle;
  maxTilt = 0; maxKick = 0; turns = 0; maxY = -Infinity; reruns = 0; restY = 0;
  /** Chassis up·Y and stillness (|v| < 0.5 m/s, |w| < 0.5 rad/s) after every tick. */
  readonly samples: { up: number; still: boolean }[] = [];
  private updates = 0;

  constructor(def: VehicleDefinition, position: V3, yaw: number) {
    this.world.addCell('fixture', ground);
    this.v = new Vehicle(this.world, def.id, def, position, yaw);
    const c = this.v.controller, update = c.updateVehicle.bind(c);
    c.updateVehicle = (...args: Parameters<typeof update>) => { this.updates++; update(...args); };
  }

  tick(): void {
    const v = this.v, up0 = v.up, w0 = v.body.angvel();
    this.updates = 0;
    v.step(this.world, () => true);
    const w1 = v.body.angvel();
    this.maxKick = Math.max(this.maxKick, Math.hypot(w1.x - w0.x, w1.y - w0.y, w1.z - w0.z));
    checkGuards(v, up0, this.updates);
    if (this.updates > 1) this.reruns++;
    this.world.physics.step();
    const up = v.up, f = v.forward, w = v.body.angvel(), l = v.body.linvel();
    this.maxTilt = Math.max(this.maxTilt, degrees(Math.acos(Math.min(1, Math.max(-1, up[1])))));
    this.maxY = Math.max(this.maxY, v.position[1]);
    this.turns += (w.x * f[0] + w.y * f[1] + w.z * f[2]) * TICK_SECONDS / (2 * Math.PI);
    this.samples.push({ up: up[1], still: Math.hypot(l.x, l.y, l.z) < 0.5 && Math.hypot(w.x, w.y, w.z) < 0.5 });
  }

  /** Two seconds parked (the constructor's braked input); the statistics start afterwards. */
  settle(): this {
    for (let i = 0; i < 120; i++) this.tick();
    Object.assign(this, { maxTilt: 0, maxKick: 0, turns: 0, maxY: -Infinity, reruns: 0, restY: this.v.position[1] });
    this.samples.length = 0;
    return this;
  }

  release(position: V3, rotation: Quat, linvel: V3, angvel: V3): this {
    const b = this.v.body;
    b.setTranslation({ x: position[0], y: position[1], z: position[2] }, true);
    b.setRotation({ x: rotation[0], y: rotation[1], z: rotation[2], w: rotation[3] }, true);
    b.setLinvel({ x: linvel[0], y: linvel[1], z: linvel[2] }, true);
    b.setAngvel({ x: angvel[0], y: angvel[1], z: angvel[2] }, true);
    return this;
  }

  /** Speed-holding throttle towards `target` m/s (coasting when null), no brake. */
  drive(ticks: number, target: number | null, steer = (_t: number) => 0, handbrake = (_t: number) => false): this {
    const input = this.v.input;
    for (let i = 0; i < ticks; i++) {
      const t = i / TICK_HZ;
      input.brake = 0; input.handbrake = handbrake(t); input.steer = steer(t);
      input.throttle = target === null ? 0 : Math.min(1, Math.max(0, (target - this.v.forwardSpeed) * 0.8));
      this.tick();
    }
    return this;
  }

  /** First tick of a 30-tick window on the roof (up·Y < -0.7) and still on every tick, or -1. */
  roofRestTick(): number {
    let run = 0;
    for (let i = 0; i < this.samples.length; i++) {
      const s = this.samples[i]!;
      run = s.up < -0.7 && s.still ? run + 1 : 0;
      if (run === 30) return i - 29;
    }
    return -1;
  }

  free(): void { this.world.physics.free(); }
}

/** Rules A-D as seen from outside after one `Vehicle.step` from chassis up `up`: damping by orientation, caps restored,
 *  at most one rerun, and no user torque but rule D's, which is zero up to 60° and on the roof. */
function checkGuards(v: Vehicle, up: V3, updates: number): void {
  const tilted = up[1] < VEHICLE_STABILITY.tiltUp;
  assert.equal(v.body.angularDamping(), tilted ? VEHICLE_STABILITY.invertedDamping : VEHICLE_STABILITY.uprightDamping);
  assert.ok(tilted ? updates === 1 : updates === 1 || updates === 2, `${updates} controller updates in one tick`);
  const cap = tilted ? 0 : v.def.massKg * 9.81 * 2.5;
  v.def.wheels.forEach((_w, i) => assert.equal(v.controller.wheelMaxSuspensionForce(i), cap));
  const torque = v.body.userTorque();
  if (!tilted || up[1] <= VEHICLE_STABILITY.roofUp) {
    assert.ok(torque.x === 0 && torque.y === 0 && torque.z === 0, `torque ${JSON.stringify(torque)} at up·Y ${up[1]}`);
  } else {
    const k = VEHICLE_STABILITY.sideSettle * v.def.massKg * 9.81;
    assert.ok(Math.abs(torque.x - k * up[2]) < 0.01 && torque.y === 0 && Math.abs(torque.z + k * up[0]) < 0.01, `torque ${JSON.stringify(torque)} at up ${up}`);
  }
}

const halfTrack = (def: VehicleDefinition) => Math.abs(def.wheels[0]!.position[0]);
function kerbClip(def: VehicleDefinition, angleDeg: number): Rig {
  const yaw = angleDeg * Math.PI / 180, r = new Rig(def, [KERB_X - halfTrack(def) - 1.5, 0.1, -180], yaw).settle();
  r.v.body.setLinvel({ x: 21 * Math.sin(yaw), y: 0, z: 21 * Math.cos(yaw) }, true);
  return r.drive(600, 21);
}
function kerbWobble(def: VehicleDefinition): Rig {
  const r = new Rig(def, [KERB_X - halfTrack(def) - 0.03, 0.1, -150], 0).settle();
  r.v.body.setLinvel({ x: 0, y: 0, z: 21 }, true);
  return r.drive(480, 21, t => 0.05 * Math.sin(2 * Math.PI * t / 1.2));
}
const rolled = (deg: number): Quat => [0, 0, Math.sin(deg * Math.PI / 360), Math.cos(deg * Math.PI / 360)];

before(initPhysics);

test('the rollover guard constants are the plan values', () => {
  assert.deepEqual({ ...VEHICLE_STABILITY }, { contactCos: 0.5, tiltUp: 0.5, invertedDamping: 3, uprightDamping: 0.5, sideSettle: 0.3, roofUp: -0.7 });
});

for (const def of [lumi, patrol, revontuli]) {
  test(`${def.label} drifting into a 12 cm kerb at 21 m/s or running along it stays level and keeps its speed`, t => {
    const runs = [...[2, 3, 4].map(angle => [`drift ${angle}°`, kerbClip(def, angle)] as const), ['wobble 3 cm', kerbWobble(def)] as const];
    const rows = runs.map(([run, r]) => ({ run, maxTilt: round(r.maxTilt), maxKick: round(r.maxKick), reruns: r.reruns, up: round(r.v.up[1]), speed: round(r.v.speed) }));
    runs.forEach(([, r]) => r.free());
    t.diagnostic(JSON.stringify(rows));
    for (const row of rows) {
      assert.ok(row.maxTilt <= 12, `${row.run}: max tilt ${row.maxTilt}°`);
      assert.ok(row.maxKick <= 1, `${row.run}: one-tick kick ${row.maxKick} rad/s`);
      assert.ok(row.up > 0.5 && row.speed > 15, `${row.run}: ends on its wheels above 15 m/s (up ${row.up}, ${row.speed} m/s)`);
    }
    assert.ok(rows.some(row => row.reruns > 0), 'the contact filter reran the controller at the kerb');
  });
}

test('a Lumi GT landing rolled 110° with 8 rad/s and 15 m/s sideways comes to rest on its roof', t => {
  const r = new Rig(lumi, [-120, 1.45, 0], 0).release([-120, 1.45, 0], rolled(110), [-15, 0, 0], [0, 0, 8]).drive(480, null);
  const rest = r.roofRestTick(), turns = r.turns;
  r.free();
  t.diagnostic(JSON.stringify({ roofRestSeconds: round(rest / TICK_HZ), turns: round(turns) }));
  assert.ok(rest >= 0 && rest <= 3 * TICK_HZ, `on its roof and at rest by 3 s (from tick ${rest})`);
  assert.ok(Math.abs(turns) <= 0.5, `${turns} roll turns`);
});

test('a Lumi GT tumbling with 12 rad/s of roll and 14 m/s sideways ends on its roof', t => {
  const r = new Rig(lumi, [-120, 1, -100], 0).release([-120, 1, -100], [0, 0, 0, 1], [-14, 0, 10], [3, 2, 12]).drive(600, null);
  // The first tick from which the car stays on its roof to the end of the ten-second run.
  const onRoof = r.samples.findLastIndex(s => s.up >= -0.7) + 1, turns = r.turns;
  r.free();
  t.diagnostic(JSON.stringify({ onRoofFromSeconds: round(onRoof / TICK_HZ), turns: round(turns) }));
  assert.ok(onRoof <= 3 * TICK_HZ, `on its roof for good by 3 s (from tick ${onRoof})`);
  assert.ok(Math.abs(turns) <= 0.6, `${turns} roll turns`);
});

test('a Lumi GT lying still on its side across 3° paving, roof uphill, tips onto its roof and rests within 3 s', t => {
  // Laid on the patch at x = 150 (roll 87°), 5 mm clear of it, with its centre of mass inside the roof-side edge.
  const tilt = 3 * Math.PI / 180, position: V3 = [150 + 0.945 * Math.sin(tilt), KERB_H + 10 * PAVING + 0.945 * Math.cos(tilt), 0];
  const r = new Rig(lumi, position, 0).release(position, rolled(87), [0, 0, 0], [0, 0, 0]).drive(480, null);
  const rest = r.roofRestTick();
  r.free();
  t.diagnostic(JSON.stringify({ roofRestSeconds: round(rest / TICK_HZ) }));
  assert.ok(rest >= 0 && rest <= 3 * TICK_HZ, `on its roof and at rest by 3 s (from tick ${rest})`);
});

test('a Lumi GT dropped on its roof with 9 rad/s and a 12 m/s slide stays there and rests within 2 s', t => {
  const r = new Rig(lumi, [-120, 1.5, 0], 0).release([-120, 1.5, 0], rolled(180), [12, 0, 0], [0, 0, 9]).drive(480, null);
  const rest = r.roofRestTick(), highestUp = Math.max(...r.samples.map(s => s.up));
  r.free();
  t.diagnostic(JSON.stringify({ roofRestSeconds: round(rest / TICK_HZ), highestUp: round(highestUp) }));
  assert.ok(highestUp < -0.7, `on its roof (up·Y < -0.7) on every tick after release (highest up ${highestUp})`);
  assert.ok(rest >= 0 && rest <= 2 * TICK_HZ, `at rest on its roof by 2 s (from tick ${rest})`);
});

test('flat-ground cornering is unchanged: full-lock step steer at 22 m/s and a handbrake turn at 25 m/s stay level', t => {
  const steer = new Rig(lumi, [-120, 0.1, -150], 0).settle();
  steer.v.body.setLinvel({ x: 0, y: 0, z: 22 }, true);
  steer.drive(300, 22, s => s < 0.2 ? 0 : 1);
  const turn = new Rig(lumi, [-120, 0.1, -150], 0).settle();
  turn.v.body.setLinvel({ x: 0, y: 0, z: 25 }, true);
  turn.drive(360, null, s => s < 0.2 ? 0 : s < 1.2 ? 1 : 0, s => s >= 0.2 && s < 1.2);
  const rows = [['step steer', steer], ['handbrake turn', turn]].map(([run, r]) => ({ run, maxTilt: round((r as Rig).maxTilt), reruns: (r as Rig).reruns }));
  steer.free(); turn.free();
  t.diagnostic(JSON.stringify(rows));
  for (const row of rows) assert.ok(row.maxTilt <= 5, `${row.run}: max tilt ${row.maxTilt}°`);
});

test('the 45° ramp stays live: a Lumi GT at 12 m/s hops as high as before', t => {
  // Peak height as the plan's harness measures it: the highest chassis origin Y after settling (flat ground at Y = 0).
  const r = new Rig(lumi, [-90, 0.1, 100], Math.PI / 2).settle();
  r.v.body.setLinvel({ x: 12, y: 0, z: 0 }, true);
  r.drive(360, 12);
  const { maxY, restY, reruns } = r;
  r.free();
  t.diagnostic(JSON.stringify({ peakY: round(maxY), restY: round(restY), gainOverRest: round(maxY - restY), reruns }));
  assert.ok(Math.abs(maxY - 1.94) <= 0.194, `peak ${maxY} m within 10 % of 1.94 m`);
});

test('the guarded kerb run is deterministic', () => {
  const pose = () => { const r = kerbClip(lumi, 3), p = { position: r.v.position, rotation: r.v.rotation }; r.free(); return p; };
  assert.deepEqual(pose(), pose());
});
