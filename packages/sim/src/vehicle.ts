// Vehicles: one dynamic cuboid chassis per car with Rapier's raycast vehicle controller (plan section 6). Driver
// input is either the player's command or a police AI steering target. Damage states follow the definition.
import { type VehicleDefinition } from '@helsinki/world-schema';
import { TICK_SECONDS } from './commands.ts';
import { interpolateVehicleCoveragePose, supportedVehicleMotionFraction, supportsVehiclePose, supportsVehicleTransition, vehicleCoverageRadius, type VehicleCoveragePose } from './coverage-footprint.ts';
import { clamp, moveToward, rotate, yawOf, type Quat, type V3 } from './math.ts';
import { GROUP, groups, RAPIER, type StaticWorld } from './world.ts';

export interface VehicleInput {
  /** -1..1 */
  throttle: number;
  /** -1..1, positive = steer left */
  steer: number;
  /** 0..1 */
  brake: number;
  handbrake: boolean;
}

export type DamageState = 'intact' | 'smoking' | 'burning' | 'wrecked';

/** Rollover guards (decision 0024); measured in docs/vehicle-stability-plan-2026-10-24.md. */
export const VEHICLE_STABILITY = {
  /** A wheel hit whose surface faces more than 60° (cos 0.5) away from the wheel ray is ignored for the tick. */
  contactCos: 0.5,
  /** Chassis up·Y below which the car counts as past 60°: no wheel forces, inverted damping. */
  tiltUp: 0.5,
  /** Angular damping while past 60°; `uprightDamping` is the constructor's value. */
  invertedDamping: 3,
  uprightDamping: 0.5,
  /** Past 60° and not yet on the roof (up·Y above `roofUp`), gravity tips the car as if its centre of mass sat this
   *  many metres higher, so a near-balanced car on its side falls back onto its wheels or over onto its roof. */
  sideSettle: 0.3,
  roofUp: -0.7,
  /** Share of the tyre side force's lever about the centre of mass that rolls the chassis (1 = physical). Rapier
   *  hard-codes 0.1, which corners flat; `restoreRoll` adds back the difference. */
  rollInfluence: 0.45,
  /** Metres by which a tyre's sidewall disc is smaller than the tyre (so a 12 cm kerb meets 2 cm of it). */
  sidewallClearance: 0.1,
} as const;

/** Rapier's private `Wheel::roll_influence`. */
const RAPIER_ROLL_INFLUENCE = 0.1;
/** Collision membership of the tyre sidewalls: their own bit, so queries for vehicles do not find them. */
const GROUP_SIDEWALL = 0x0010;

export class Vehicle {
  readonly id: string;
  readonly def: VehicleDefinition;
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  readonly skidCollider: RAPIER.Collider | null;
  readonly controller: RAPIER.DynamicRayCastVehicleController;
  // Spawned cars are parked until a player or AI driver takes control. An unbraked car on
  // Senate Square's slope rolls out of the stopped-entry window before the player arrives.
  readonly input: VehicleInput = { throttle: 0, steer: 0, brake: 1, handbrake: true };
  steerAngle = 0;
  health: number;
  damage: DamageState = 'intact';
  burnTicks = 0;
  exploded = false;
  /** entity id of the driver, if any */
  driver: string | null = null;
  readonly occupants = new Set<string>();
  /** wheel visual state */
  readonly wheelRotation: number[];
  readonly wheelSuspension: number[];
  readonly wheelContact: boolean[];
  private readonly wheelSpin: number[];
  /** Per-wheel suspension force cap, 2.5 g. */
  private readonly maxSuspensionForce: number;
  /** Tyre sidewall discs, one per wheel, and the suspension length that puts a hub at its socket. */
  private readonly sidewalls: RAPIER.Collider[];
  private readonly staticLength: number;
  lightsOn = false;
  sirenOn = false;
  /** Kicked out during a windshield exit; it stays out for the rest of the session. */
  windshieldBroken = false;
  hornTicks = 0;
  /** Velocity before the last physics step, for impact (delta-v) damage. */
  velocityBefore: V3 = [0, 0, 0];

  constructor(world: StaticWorld, id: string, def: VehicleDefinition, position: V3, yaw: number) {
    this.id = id;
    this.def = def;
    this.health = def.health;
    const q = [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)] as Quat;
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(position[0], position[1], position[2])
      .setRotation({ x: q[0], y: q[1], z: q[2], w: q[3] })
      .setLinearDamping(0.05).setAngularDamping(0.5).setCanSleep(false);
    this.body = world.physics.createRigidBody(bodyDesc);
    const he = def.collider.halfExtents, c = def.collider.centre;
    // Asset frame is +X left; Rapier/runtime is right-handed with +X east, so no mirroring is needed: the chassis
    // is symmetric. Centre of mass sits low for stability.
    // Box inertia about the centre of mass (I = m/3 * (b² + c²) per axis).
    const m = def.massKg;
    const inertia = { x: m / 3 * (he[1] * he[1] + he[2] * he[2]), y: m / 3 * (he[0] * he[0] + he[2] * he[2]), z: m / 3 * (he[0] * he[0] + he[1] * he[1]) };
    const colliderDesc = RAPIER.ColliderDesc.cuboid(he[0], he[1], he[2])
      .setTranslation(c[0], c[1], c[2])
      // Rapier reads the centre of mass in the collider's frame, which is translated by c.
      .setMassProperties(m, { x: def.centreOfMass[0] - c[0], y: def.centreOfMass[1] - c[1], z: def.centreOfMass[2] - c[2] }, inertia, { x: 0, y: 0, z: 0, w: 1 })
      .setFriction(0.4).setRestitution(0.05)
      .setCollisionGroups(groups(GROUP.vehicle, GROUP.all))
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS | RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
      .setContactForceEventThreshold(8000);
    this.collider = world.physics.createCollider(colliderDesc, this.body);
    // Optional skid box between the axles: massless, same groups and events as the body box.
    const skid = def.collider.skid;
    this.skidCollider = skid ? world.physics.createCollider(
      RAPIER.ColliderDesc.cuboid(skid.halfExtents[0], skid.halfExtents[1], skid.halfExtents[2])
        .setTranslation(skid.centre[0], skid.centre[1], skid.centre[2]).setDensity(0)
        .setFriction(0.4).setRestitution(0.05)
        .setCollisionGroups(groups(GROUP.vehicle, GROUP.all))
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS | RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
        .setContactForceEventThreshold(8000), this.body) : null;
    // Tyre sidewalls: a massless disc in each wheel, `sidewallClearance` smaller than the tyre so it clears level
    // ground, that only static geometry touches. The ray wheels cannot meet a kerb sideways; a sidewall can, so a car
    // sliding sideways into one trips over it, while a tyre rolling at a kerb rides up its rounded edge.
    this.sidewalls = def.wheels.map(w =>
      world.physics.createCollider(
        RAPIER.ColliderDesc.cylinder(def.wheelWidth / 2, def.wheelRadius - VEHICLE_STABILITY.sidewallClearance)
          .setTranslation(w.position[0], w.position[1], w.position[2])
          .setRotation({ x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 })
          .setDensity(0).setFriction(0).setRestitution(0.05)
          .setCollisionGroups(groups(GROUP_SIDEWALL, GROUP.static)), this.body));
    this.controller = world.physics.createVehicleController(this.body);
    this.controller.indexUpAxis = 1;
    // The 0.21 bindings expose the forward-axis setter under this name.
    this.controller.setIndexForwardAxis = 2;
    const s = def.suspension;
    // The raycast vehicle scales the spring by the chassis mass, so the static compression under the car's own
    // weight is g / (wheels * stiffness); the connection point is raised so the hub rests at the socket height.
    const staticCompression = 9.81 / (def.wheels.length * s.stiffness);
    this.maxSuspensionForce = def.massKg * 9.81 * 2.5;
    this.staticLength = s.restLength - staticCompression;
    def.wheels.forEach((w, i) => {
      // The raycast vehicle's rolling direction is normal × axle; with +Y up an axle of -X rolls along +Z (the
      // asset's forward), and a positive steering angle turns left.
      this.controller.addWheel({ x: w.position[0], y: w.position[1] + s.restLength - staticCompression, z: w.position[2] }, { x: 0, y: -1, z: 0 }, { x: -1, y: 0, z: 0 }, s.restLength, def.wheelRadius);
      this.controller.setWheelSuspensionStiffness(i, s.stiffness);
      this.controller.setWheelSuspensionCompression(i, s.compression);
      this.controller.setWheelSuspensionRelaxation(i, s.damping);
      this.controller.setWheelMaxSuspensionTravel(i, s.maxTravel);
      this.controller.setWheelFrictionSlip(i, def.tyres.frictionSlip);
      this.controller.setWheelSideFrictionStiffness(i, def.tyres.sideFriction);
      this.controller.setWheelMaxSuspensionForce(i, this.maxSuspensionForce);
    });
    this.wheelRotation = def.wheels.map(() => 0);
    this.wheelSuspension = def.wheels.map(() => s.restLength);
    this.wheelContact = def.wheels.map(() => false);
    this.wheelSpin = def.wheels.map(() => 0);
  }

  get position(): V3 { const t = this.body.translation(); return [t.x, t.y, t.z]; }
  get rotation(): Quat { const r = this.body.rotation(); return [r.x, r.y, r.z, r.w]; }
  get yaw(): number { return yawOf(this.rotation); }
  get forward(): V3 { return rotate(this.rotation, [0, 0, 1]); }
  get up(): V3 { return rotate(this.rotation, [0, 1, 0]); }
  get velocity(): V3 { const v = this.body.linvel(); return [v.x, v.y, v.z]; }
  /** Signed speed along the car's forward axis, m/s. */
  get forwardSpeed(): number { const f = this.forward, v = this.velocity; return f[0] * v[0] + f[1] * v[1] + f[2] * v[2]; }
  get wheelsInContact(): number { return this.wheelContact.filter(Boolean).length; }
  get upright(): boolean { return this.up[1] > 0.5; }

  /** Asset-local point to world. */
  localToWorld(p: V3): V3 {
    const r = rotate(this.rotation, p), t = this.position;
    return [r[0] + t[0], r[1] + t[1], r[2] + t[2]];
  }

  /** Hub position (asset-local) of wheel i from the controller's current suspension length. */
  wheelLocal(i: number): V3 {
    const w = this.def.wheels[i]!, s = this.def.suspension;
    const top = w.position[1] + s.restLength - 9.81 / (this.def.wheels.length * s.stiffness);
    return [w.position[0], top - (this.wheelSuspension[i] ?? s.restLength), w.position[2]];
  }

  /** Horizontal speed, m/s. */
  get speed(): number { const v = this.velocity; return Math.hypot(v[0], v[2]); }

  /** Speed change over the last physics step, m/s (impact strength). */
  get deltaV(): number {
    const v = this.velocity, b = this.velocityBefore;
    return Math.hypot(v[0] - b[0], v[1] - b[1], v[2] - b[2]);
  }

  /** Keep a complete swept footprint inside qualified coverage, including a narrow gap between safe endpoints. */
  get coveragePose(): VehicleCoveragePose { return { position: this.position, rotation: this.rotation, steerAngle: this.steerAngle }; }

  supportedByCoverage(world: StaticWorld): boolean {
    return !world.gameplay.supportedArea || supportsVehiclePose(world.gameplay, this.def, this.position, this.rotation, this.steerAngle);
  }

  constrainToSupportedArea(world: StaticWorld, before: VehicleCoveragePose): void {
    if (!world.gameplay.supportedArea) return;
    const after = this.coveragePose, fraction = supportedVehicleMotionFraction(world.gameplay, this.def, before, after);
    if (fraction === 1) return;
    // Genuine invalid physics states belong to the existing recovery check. A
    // precision retreat cannot certify a non-finite position or orientation.
    if (!after.position.every(Number.isFinite) || !after.rotation.every(Number.isFinite) || Math.hypot(...after.rotation) < 1e-12) return;
    // A tangential move can have far less inward clearance than its travel-distance
    // backoff. Certify Rapier's actual Float32 pose, including quaternion rounding,
    // rather than allowing a supported double-precision endpoint to trigger recovery.
    const startedSupported = supportsVehiclePose(world.gameplay, this.def, before.position, before.rotation, before.steerAngle);
    const rotationUnchanged = before.rotation.every((value, i) => value === after.rotation[i]);
    const apply = (pose: VehicleCoveragePose): boolean => {
      const q = rotationUnchanged ? after.rotation : pose.rotation;
      this.body.setTranslation({ x: pose.position[0], y: after.position[1], z: pose.position[2] }, true);
      // setRotation normalizes even a previously returned Float32 quaternion.
      // Preserve an already matching physical orientation without rewriting it.
      const current = this.rotation;
      if (q.some((value, i) => value !== current[i])) this.body.setRotation({ x: q[0], y: q[1], z: q[2], w: q[3] }, true);
      this.steerAngle = pose.steerAngle ?? 0;
      return !startedSupported || supportsVehicleTransition(world.gameplay, this.def, before, this.coveragePose);
    };
    let retainedFraction = fraction, certified = false;
    for (let attempt = 0; attempt <= 24; attempt++) {
      const pose = retainedFraction === 0 ? before : interpolateVehicleCoveragePose(before, after, retainedFraction);
      if (apply(pose)) { certified = true; break; }
      if (retainedFraction === 0) break;
      retainedFraction = attempt < 23 ? retainedFraction / 2 : 0;
    }
    if (!certified) {
      // A restored prior quaternion may itself round differently. Search only
      // nearby representable translations, in nearest-first order, and certify
      // the complete path from the real prior pose to each actual readback.
      // The body extent sets a precision floor near the coordinate origin.
      const radius = vehicleCoverageRadius(this.def);
      const quantum = (coordinate: number) => 2 ** (Math.floor(Math.log2(Math.max(1, Math.abs(coordinate), radius))) - 23);
      const qx = quantum(before.position[0]), qz = quantum(before.position[2]);
      const candidates: { x: number; z: number; distance: number }[] = [];
      for (let x = -8; x <= 8; x++) for (let z = -8; z <= 8; z++) if (x || z) {
        candidates.push({ x: Math.fround(before.position[0] + x * qx), z: Math.fround(before.position[2] + z * qz), distance: (x * qx) ** 2 + (z * qz) ** 2 });
      }
      candidates.sort((a, b) => a.distance - b.distance || a.x - b.x || a.z - b.z);
      for (const candidate of candidates) {
        if (apply({ position: [candidate.x, after.position[1], candidate.z], rotation: before.rotation, steerAngle: before.steerAngle })) { certified = true; break; }
      }
      if (!certified) throw new Error('No certified vehicle pose within the bounded Float32 precision retreat');
    }
    this.def.wheels.forEach((wheel, i) => this.controller.setWheelSteering(i, wheel.steer ? this.steerAngle : 0));
    const velocity = this.body.linvel();
    this.body.setLinvel({ x: 0, y: velocity.y, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    world.physics.propagateModifiedBodyPositionsToColliders();
  }

  step(world: StaticWorld, filter: (c: RAPIER.Collider) => boolean): void {
    const def = this.def;
    this.velocityBefore = this.velocity;
    // Past 60° the car settles instead of rolling on, and its wheel rays, which then point sideways at kerb tops,
    // stairs and walls, push nothing (decision 0024, rules B to D). Orientation alone decides, on the ground or in
    // the air: a car past 60° in flight is damped and tipped too, while a level jump is untouched.
    const up = this.up;
    const tilted = up[1] < VEHICLE_STABILITY.tiltUp;
    this.body.setAngularDamping(tilted ? VEHICLE_STABILITY.invertedDamping : VEHICLE_STABILITY.uprightDamping);
    const speed = this.forwardSpeed;
    const absSpeed = Math.abs(speed);
    // Steering: rate-limited, reduced at speed.
    const t = clamp(absSpeed / Math.max(1, def.engine.topSpeedMs), 0, 1);
    const maxAngle = (def.steering.maxAngleDeg + (def.steering.highSpeedAngleDeg - def.steering.maxAngleDeg) * t) * Math.PI / 180;
    const target = clamp(this.input.steer, -1, 1) * maxAngle;
    this.steerAngle = moveToward(this.steerAngle, target, def.steering.rateDegPerS * Math.PI / 180 * TICK_SECONDS);
    const wrecked = this.damage === 'wrecked';
    const throttle = wrecked ? 0 : clamp(this.input.throttle, -1, 1);
    const driven = def.wheels.filter(w => w.drive).length || 1;
    let engineForce = 0;
    if (throttle > 0) engineForce = speed < def.engine.topSpeedMs ? def.engine.maxForceN * throttle * (1 - 0.6 * t * t) : 0;
    else if (throttle < 0) engineForce = speed > 1.0 ? 0 : (speed > -def.engine.topSpeedReverseMs ? def.engine.reverseForceN * throttle : 0);
    // Throttle against the direction of travel acts as a brake.
    let brake = clamp(this.input.brake, 0, 1) * def.brakes.forceN;
    if (throttle < 0 && speed > 1.0) brake = Math.max(brake, def.brakes.forceN * -throttle);
    if (throttle === 0 && this.input.brake === 0 && absSpeed > 0.2) brake = Math.max(brake, def.brakes.forceN * 0.03); // rolling resistance
    const slips: number[] = [];
    def.wheels.forEach((w, i) => {
      this.controller.setWheelSteering(i, w.steer ? this.steerAngle : 0);
      this.controller.setWheelEngineForce(i, w.drive ? engineForce / driven : 0);
      let b = brake;
      if (this.input.handbrake && w.handbrake) b = Math.max(b, def.brakes.handbrakeN);
      // The raycast vehicle's brake is the maximum friction impulse per step (Bullet semantics), not a force:
      // passed as newtons it stopped the car from 22 m/s in 0.08 s and pole-vaulted it over its front wheels.
      this.controller.setWheelBrake(i, b * TICK_SECONDS);
      slips[i] = this.input.handbrake && w.handbrake ? def.tyres.frictionSlip * 0.45 : def.tyres.frictionSlip;
      this.controller.setWheelFrictionSlip(i, tilted ? 0 : slips[i]!);
      this.controller.setWheelMaxSuspensionForce(i, tilted ? 0 : this.maxSuspensionForce);
    });
    // Aerodynamic drag and a little downforce. Rapier keeps user forces until they are reset, so clear first.
    this.body.resetForces(true);
    this.body.resetTorques(true);
    const v = this.velocity;
    const vlen = Math.hypot(v[0], v[1], v[2]);
    if (vlen > 0.1) {
      const drag = def.aero.dragCoefficient * vlen * vlen;
      this.body.addForce({ x: -v[0] / vlen * drag, y: -v[1] / vlen * drag - def.aero.downforce * vlen * vlen, z: -v[2] / vlen * drag }, true);
    }
    if (tilted && up[1] > VEHICLE_STABILITY.roofUp) {
      // Rule D: torque = sideSettle × m g × (up × ∓Y), which turns the up axis back towards +Y while up·Y > 0 and on
      // towards -Y below, so the car falls off its side to the nearer rest: its wheels or its roof.
      const k = (up[1] > 0 ? -1 : 1) * VEHICLE_STABILITY.sideSettle * def.massKg * 9.81;
      this.body.addTorque({ x: k * up[2], y: 0, z: -k * up[0] }, true);
    }
    if (tilted) this.controller.updateVehicle(TICK_SECONDS, undefined, groups(GROUP.vehicle, GROUP.static), filter);
    else {
      this.updateWheels(filter, slips);
      this.restoreRoll();
    }
    def.wheels.forEach((_w, i) => {
      this.wheelContact[i] = this.controller.wheelIsInContact(i) ?? false;
      this.wheelSuspension[i] = this.controller.wheelSuspensionLength(i) ?? def.suspension.restLength;
      // The sidewall follows its hub, which sits at the socket when the spring carries the static load.
      const w = def.wheels[i]!;
      this.sidewalls[i]!.setTranslationWrtParent({ x: w.position[0], y: w.position[1] + this.staticLength - this.wheelSuspension[i]!, z: w.position[2] });
      // Roll from travelled distance; spin freely when airborne.
      const ds = speed * TICK_SECONDS;
      this.wheelSpin[i] = this.wheelContact[i] ? ds / def.wheelRadius : this.wheelSpin[i]! * 0.98;
      this.wheelRotation[i] = (this.wheelRotation[i]! + this.wheelSpin[i]!) % (Math.PI * 2);
    });
    if (this.hornTicks > 0) this.hornTicks--;
    // Damage states
    if (!wrecked) {
      const frac = this.health / def.health;
      this.damage = frac <= 0 ? 'wrecked' : frac < def.damage.fireBelow ? 'burning' : frac < def.damage.smokeBelow ? 'smoking' : 'intact';
    }
    if (this.damage === 'burning' || this.damage === 'wrecked') {
      this.burnTicks++;
      if (this.damage === 'burning' && this.burnTicks > def.damage.explodeAfterSeconds * 60) { this.health = 0; this.damage = 'wrecked'; this.exploded = true; }
    }
    void world;
  }

  /**
   * Controller update with the wheel-contact filter (decision 0024, rule A). The controller divides the spring by the
   * hit's normal·ray (clipped at 0.1) and lets the tyre grip with that uncapped spring, so a wheel ray on a kerb riser
   * or a grazing landing kicked the chassis by several rad/s in one tick. After the update, a hit on a surface facing
   * more than 60° away from the ray is ignored (no spring, no grip) and a wheel whose spring exceeds the cap grips
   * only as hard as the capped load; if any wheel was marked, the chassis velocities are restored and the update runs
   * once more with those overrides. At most two updates per tick; the rerun sees the same state, so it is deterministic.
   */
  private updateWheels(filter: (c: RAPIER.Collider) => boolean, slips: readonly number[]): void {
    const c = this.controller, filterGroups = groups(GROUP.vehicle, GROUP.static);
    const linvel = this.body.linvel(), angvel = this.body.angvel();
    c.updateVehicle(TICK_SECONDS, undefined, filterGroups, filter);
    const down = rotate(this.rotation, [0, -1, 0]);
    const marked: number[] = [];
    this.def.wheels.forEach((_w, i) => {
      if (!c.wheelIsInContact(i)) return;
      const n = c.wheelContactNormal(i), force = c.wheelSuspensionForce(i) ?? 0;
      if (n && -(n.x * down[0] + n.y * down[1] + n.z * down[2]) < VEHICLE_STABILITY.contactCos) {
        c.setWheelMaxSuspensionForce(i, 0);
        c.setWheelFrictionSlip(i, 0);
        marked.push(i);
      } else if (force > this.maxSuspensionForce) {
        c.setWheelFrictionSlip(i, slips[i]! * this.maxSuspensionForce / force);
        marked.push(i);
      }
    });
    if (marked.length === 0) return;
    this.body.setLinvel(linvel, true);
    this.body.setAngvel(angvel, true);
    c.updateVehicle(TICK_SECONDS, undefined, filterGroups, filter);
    for (const i of marked) c.setWheelMaxSuspensionForce(i, this.maxSuspensionForce);
  }

  /**
   * Rapier applies each wheel's side impulse at the contact point pulled along the chassis up axis to within
   * `RAPIER_ROLL_INFLUENCE` of the centre of mass's height, which takes away nine tenths of the body roll and weight
   * shift in corners and slides. This adds the angular impulse of the missing lever up to `rollInfluence`.
   */
  private restoreRoll(): void {
    const c = this.controller, up = this.up, com = this.body.worldCom(), q = this.rotation;
    const share = VEHICLE_STABILITY.rollInfluence - RAPIER_ROLL_INFLUENCE;
    let lx = 0, ly = 0, lz = 0;
    this.def.wheels.forEach((_w, i) => {
      const impulse = c.wheelSideImpulse(i) ?? 0, p = c.wheelContactPoint(i);
      if (!c.wheelIsInContact(i) || impulse === 0 || !p) return;
      // The world axle as the controller builds it: the chassis axle turned about the up axis by the steering angle.
      const a = rotate(q, [-1, 0, 0]), s = c.wheelSteering(i) ?? 0, cos = Math.cos(s), sin = Math.sin(s);
      const ua = up[0] * a[0] + up[1] * a[1] + up[2] * a[2];
      const axle = [0, 1, 2].map(k => a[k]! * cos + (up[(k + 1) % 3]! * a[(k + 2) % 3]! - up[(k + 2) % 3]! * a[(k + 1) % 3]!) * sin + up[k]! * ua * (1 - cos));
      // Lever: share × (up·(contact − centre of mass)) along up; angular impulse = lever × (axle × impulse).
      const h = share * (up[0] * (p.x - com.x) + up[1] * (p.y - com.y) + up[2] * (p.z - com.z));
      lx += h * (up[1] * axle[2]! - up[2] * axle[1]!) * impulse;
      ly += h * (up[2] * axle[0]! - up[0] * axle[2]!) * impulse;
      lz += h * (up[0] * axle[1]! - up[1] * axle[0]!) * impulse;
    });
    if (lx !== 0 || ly !== 0 || lz !== 0) this.body.applyTorqueImpulse({ x: lx, y: ly, z: lz }, true);
  }

  applyDamage(amount: number): void {
    if (this.damage === 'wrecked') return;
    this.health = Math.max(0, this.health - amount);
  }

  /** Teleport (recovery): place upright at a position and yaw, zero velocities. */
  place(position: V3, yaw: number): void {
    this.body.setTranslation({ x: position[0], y: position[1], z: position[2] }, true);
    this.body.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true);
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }
}
