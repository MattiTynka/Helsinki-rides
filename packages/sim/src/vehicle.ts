// Vehicles: one dynamic cuboid chassis per car with Rapier's raycast vehicle controller (plan section 6). Driver
// input is either the player's command or a police AI steering target. Damage states follow the definition.
import type { VehicleDefinition } from '@helsinki/world-schema';
import { TICK_SECONDS } from './commands.ts';
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
      .setMassProperties(m, { x: def.centreOfMass[0], y: def.centreOfMass[1], z: def.centreOfMass[2] }, inertia, { x: 0, y: 0, z: 0, w: 1 })
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
    this.controller = world.physics.createVehicleController(this.body);
    this.controller.indexUpAxis = 1;
    // The 0.21 bindings expose the forward-axis setter under this name.
    this.controller.setIndexForwardAxis = 2;
    const s = def.suspension;
    // The raycast vehicle scales the spring by the chassis mass, so the static compression under the car's own
    // weight is g / (wheels * stiffness); the connection point is raised so the hub rests at the socket height.
    const staticCompression = 9.81 / (def.wheels.length * s.stiffness);
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
      this.controller.setWheelMaxSuspensionForce(i, def.massKg * 9.81 * 2.5);
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

  step(world: StaticWorld, filter: (c: RAPIER.Collider) => boolean): void {
    const def = this.def;
    this.velocityBefore = this.velocity;
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
    def.wheels.forEach((w, i) => {
      this.controller.setWheelSteering(i, w.steer ? this.steerAngle : 0);
      this.controller.setWheelEngineForce(i, w.drive ? engineForce / driven : 0);
      let b = brake;
      if (this.input.handbrake && w.handbrake) b = Math.max(b, def.brakes.handbrakeN);
      // The raycast vehicle's brake is the maximum friction impulse per step (Bullet semantics), not a force:
      // passed as newtons it stopped the car from 22 m/s in 0.08 s and pole-vaulted it over its front wheels.
      this.controller.setWheelBrake(i, b * TICK_SECONDS);
      if (this.input.handbrake && w.handbrake) this.controller.setWheelFrictionSlip(i, def.tyres.frictionSlip * 0.45);
      else this.controller.setWheelFrictionSlip(i, def.tyres.frictionSlip);
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
    this.controller.updateVehicle(TICK_SECONDS, undefined, groups(GROUP.vehicle, GROUP.static), filter);
    def.wheels.forEach((_w, i) => {
      this.wheelContact[i] = this.controller.wheelIsInContact(i) ?? false;
      this.wheelSuspension[i] = this.controller.wheelSuspensionLength(i) ?? def.suspension.restLength;
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
