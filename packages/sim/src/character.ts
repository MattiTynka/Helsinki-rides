// Characters (player, officers, later pedestrians): kinematic capsules moved by Rapier's character controller.
// Locomotion is in place for animation; the capsule owns world displacement (skill: gameplay animation).
import { TICK_SECONDS } from './commands.ts';
import { clamp, wrapAngle, type V3 } from './math.ts';
import { GROUP, groups, RAPIER, type StaticWorld } from './world.ts';

export const CHARACTER = { radius: 0.32, halfHeight: 0.58, height: 1.8, eye: 1.62, walk: 1.4, run: 3.6, sprint: 6.0, aimWalk: 1.6 } as const;
/** capsule centre above the feet */
export const FEET_TO_CENTRE = CHARACTER.halfHeight + CHARACTER.radius;
/**
 * The gap Rapier's controller keeps between the capsule and what it touches, where a fall or a snap leaves the feet.
 * Characters are placed at it: a capsule placed lower starts every cast inside the gap, where the edge of the ground
 * triangle next to the one underfoot reads as a slope, and a runner crossing that edge is thrown up and slowed.
 */
export const CHARACTER_SKIN = 0.03;
/** The lift of a grounded step taken again without its gravity part (see Character.move). */
const FLAT_RETRY_RISE = 1e-4;
export const JUMP = { gravity: 9.81, normalHeight: 0.9, superHeight: 2.8, doublePressSeconds: 0.28, takeoffSeconds: 0.1, landingSeconds: 0.18 } as const;
export type JumpPhase = 'grounded' | 'takeoff' | 'rise' | 'fall' | 'land' | 'climb';
export type JumpKind = 'normal' | 'super';

/**
 * Ledge climbing. A jump that brings the hands to an edge the feet cannot clear grabs it and pulls the
 * capsule up beside the wall, then over the edge. The authored climb animation uses the same path
 * (tools/blender/build_snow_jump_poses.py stores these numbers and a test compares them).
 */
export const CLIMB = {
  /** Ledge top above the feet: below this the jump lands or autosteps, above it the hands cannot pull up. */
  minHeight: 0.3, maxHeight: 1.5,
  /** A rising jump whose apex clears the edge by this much lands on it instead of grabbing. */
  clearMargin: 0.15,
  /** How far beyond the capsule surface the hands find a ledge. */
  reach: 0.18,
  /** Capsule surface to wall face while pulling up, and the standing capsule's distance past the edge. */
  wallGap: 0.06, inset: 0.12,
  /** Share of the climb spent rising beside the wall before moving over the edge. */
  riseFraction: 0.55,
  /** Feet clearance above the top while moving over the edge. */
  lift: 0.05,
  /** Duration = baseSeconds + perMetreSeconds * height. */
  baseSeconds: 0.5, perMetreSeconds: 0.5,
} as const;

/**
 * A dead body lies on its back along its facing, drawn flat at the height of its feet (Snow's and Rain's held death
 * poses, measured in the game): from its head `length[0]` behind the feet to its toes `length[1]` ahead, `halfWidth`
 * either side, in `pieces` pieces; its forearms lie out to `arms.reach` either side between `arms.along`. The ground
 * there may rise `rise` above the feet or fall `drop` below them before the body sinks into it or floats over it; the
 * body is `thickness` deep above that. A collapsing body turns toward the facing it falls along at `turnRate` rad/s.
 */
export const BODY = {
  length: [-1.05, 0.8], halfWidth: 0.25, pieces: 4, arms: { along: [-0.7, -0.15], reach: 0.7 },
  thickness: 0.35, rise: 0.07, drop: 0.12, turnRate: 8,
} as const;

/** The boxes a lying body fills about its feet: along and across its facing, half their length and width, and whether it rests on the ground there. */
const BODY_PIECES: readonly (readonly [number, number, number, number, boolean])[] = (() => {
  const [back, front] = BODY.length, half = (front - back) / BODY.pieces / 2;
  const [shoulder, waist] = BODY.arms.along, arm = (waist - shoulder) / 2, out = (BODY.arms.reach - BODY.halfWidth) / 2;
  return [
    ...Array.from({ length: BODY.pieces }, (_, i) => [back + half * (2 * i + 1), 0, half, BODY.halfWidth, true] as const),
    ...[1, -1].map(side => [shoulder + arm, side * (BODY.halfWidth + out), arm, out, false] as const),
  ];
})();

/** Presentation data of an active climb: height of the top above the feet at the grab and the grabbed edge. */
export interface ClimbView {
  readonly height: number;
  readonly duration: number;
  /** Point of the edge in front of the climber, on the wall face at the top's height. */
  readonly edge: V3;
  /** Horizontal wall normal, pointing out of the wall toward the climber. */
  readonly normal: readonly [number, number];
}

interface Climb extends ClimbView {
  readonly start: V3;
  /** Capsule axis beside the wall (x, z), and the standing feet position on the top. */
  readonly wall: readonly [number, number];
  readonly target: V3;
}

const smooth01 = (t: number): number => { const x = clamp(t, 0, 1); return x * x * (3 - 2 * x); };

/** Feet position along a climb at normalized time u: up beside the wall, then over the edge. */
export function climbPathPoint(c: Pick<Climb, 'start' | 'wall' | 'target'>, u: number): V3 {
  const r = CLIMB.riseFraction;
  const approach = smooth01(u / (r * 0.5)), rise = smooth01(u / r), over = smooth01((u - r) / (1 - r));
  const x = c.start[0] + (c.wall[0] - c.start[0]) * approach, z = c.start[2] + (c.wall[1] - c.start[2]) * approach;
  return [x + (c.target[0] - c.wall[0]) * over, c.start[1] + (c.target[1] - c.start[1]) * rise, z + (c.target[2] - c.wall[1]) * over];
}

export type CharacterClip = 'idle' | 'walk' | 'run' | 'sprint' | 'aim' | 'fire' | 'hit' | 'death' | 'drive' | 'arrested';

export class Character {
  readonly id: string;
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  readonly controller: RAPIER.KinematicCharacterController;
  /** feet position */
  position: V3;
  yaw: number;
  verticalSpeed = 0;
  grounded = true;
  jumpPhase: JumpPhase = 'grounded';
  jumpKind: JumpKind | null = null;
  /** Distance from feet to support directly below, for extending the legs before contact. */
  groundDistance: number | null = 0;
  /** Downward speed at the most recent touchdown (m/s), for landing presentation. */
  landingSpeed = 0;
  climb: Climb | null = null;
  private jumpPhaseTicks = 0;
  private jumpElapsedTicks = Infinity;
  private jumpStartY = 0;
  private jumpUpgradeAllowed = false;
  private collisionPositionDirty = false;
  health: number;
  armour = 0;
  alive = true;
  clip: CharacterClip = 'idle';
  clipTicks = 0;
  /** horizontal speed for animation blending */
  speed = 0;
  /** hidden while seated in a vehicle */
  inVehicle: string | null = null;
  hitTicks = 0;
  deathTicks = 0;
  /** The facing a dead body turns to so that it lies on level, open ground; null until chosen. */
  fallYaw: number | null = null;
  /** Authoritative fixed-step age of a terminal collapse, independent of render/view lifetime. */
  get deathElapsed(): number { return this.alive ? 0 : this.deathTicks * TICK_SECONDS; }
  lastSurface: string | null = null;
  /** AI-requested horizontal velocity for the next move (NPCs only). */
  desiredVx = 0;
  desiredVz = 0;

  get jumpPhaseTime(): number { return this.jumpPhaseTicks * TICK_SECONDS; }

  /** Includes pending input-window state so replay hashes cannot hide a divergent future boost. */
  get jumpDigest(): string {
    const c = this.climb;
    const climb = c ? `${c.duration.toFixed(5)}:${c.target.map(v => v.toFixed(5)).join(',')}` : '-';
    return `${this.grounded ? 1 : 0}:${this.verticalSpeed.toFixed(5)}:${this.jumpPhase}:${this.jumpPhaseTicks}:${this.jumpKind ?? '-'}:${this.jumpElapsedTicks}:${this.jumpUpgradeAllowed ? 1 : 0}:${this.jumpStartY.toFixed(5)}:${climb}`;
  }

  get climbView(): ClimbView | null {
    const c = this.climb;
    return c ? { height: c.height, duration: c.duration, edge: c.edge, normal: c.normal } : null;
  }

  /** Called only for a distinct press. A second quick press upgrades this jump once. */
  requestJump(): 'normal' | 'super' | null {
    if (!this.alive || this.inVehicle || this.climb) return null;
    if (this.grounded && (this.jumpPhase === 'grounded' || this.jumpPhase === 'land')) {
      this.jumpKind = 'normal';
      this.jumpElapsedTicks = 0;
      this.jumpUpgradeAllowed = true;
      this.setJumpPhase('takeoff');
      return 'normal';
    }
    if (this.jumpKind !== 'normal' || !this.jumpUpgradeAllowed || this.jumpElapsedTicks * TICK_SECONDS > JUMP.doublePressSeconds) return null;
    if (this.jumpPhase !== 'takeoff' && this.jumpPhase !== 'rise') return null;
    this.jumpKind = 'super';
    this.jumpUpgradeAllowed = false;
    if (this.jumpPhase === 'rise') {
      // Add only enough energy to reach the total super-jump height, independent of tap timing.
      this.verticalSpeed = launchSpeed(Math.max(0, JUMP.superHeight - (this.position[1] - this.jumpStartY)));
    }
    return 'super';
  }

  /** Discard pending/airborne jumps at respawn, recovery, vehicle entry and incapacitation. */
  resetJump(retainAirborneMotion = false): void {
    if (!retainAirborneMotion || this.grounded) this.verticalSpeed = 0;
    this.climb = null;
    this.jumpKind = null;
    this.jumpElapsedTicks = Infinity;
    this.jumpUpgradeAllowed = false;
    this.setJumpPhase(retainAirborneMotion && !this.grounded ? this.verticalSpeed > 0 ? 'rise' : 'fall' : 'grounded');
    this.jumpPhaseTicks = 0;
  }

  private setJumpPhase(phase: JumpPhase): void {
    if (this.jumpPhase !== phase) { this.jumpPhase = phase; this.jumpPhaseTicks = 0; }
  }

  constructor(world: StaticWorld, id: string, position: V3, yaw: number, health: number) {
    this.id = id;
    this.position = [position[0], position[1] + CHARACTER_SKIN, position[2]];
    this.yaw = yaw;
    this.health = health;
    const desc = RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(position[0], this.position[1] + FEET_TO_CENTRE, position[2]);
    this.body = world.physics.createRigidBody(desc);
    // Membership: character. Filter: everything that may touch or hit a character, including bullet rays.
    this.collider = world.physics.createCollider(
      RAPIER.ColliderDesc.capsule(CHARACTER.halfHeight, CHARACTER.radius).setCollisionGroups(groups(GROUP.character, GROUP.static | GROUP.vehicle | GROUP.character | GROUP.bullet)).setFriction(0),
      this.body);
    this.controller = world.physics.createCharacterController(CHARACTER_SKIN);
    this.controller.setUp({ x: 0, y: 1, z: 0 });
    this.controller.setMaxSlopeClimbAngle(50 * Math.PI / 180);
    this.controller.setMinSlopeSlideAngle(60 * Math.PI / 180);
    this.controller.enableAutostep(0.45, 0.25, true);
    this.controller.enableSnapToGround(0.4);
    // Cars, the only dynamic bodies, are walls to a walker: the controller re-applies its impulse every tick of
    // contact, at shoulder height, so a run into a parked car's side shoved it 3.6 m and tipped it onto its side.
    this.controller.setApplyImpulsesToDynamicBodies(false);
  }

  /**
   * Move with a desired horizontal velocity (m/s, world XZ). Gravity is integrated here; the controller resolves
   * collisions against static geometry and vehicles.
   */
  move(world: StaticWorld, vx: number, vz: number, filter?: (c: RAPIER.Collider) => boolean): void {
    if (this.collisionPositionDirty) {
      // Rapier does not synchronize an externally teleported body's collider until the
      // next physics step; character queries run before that step in this simulation.
      world.physics.propagateModifiedBodyPositionsToColliders();
      this.collisionPositionDirty = false;
    }
    this.jumpPhaseTicks++;
    this.jumpElapsedTicks++;
    if (this.jumpPhase === 'takeoff' && this.jumpPhaseTime >= JUMP.takeoffSeconds) {
      this.jumpStartY = this.position[1];
      this.verticalSpeed = launchSpeed(this.jumpKind === 'super' ? JUMP.superHeight : JUMP.normalHeight);
      this.grounded = false;
      this.setJumpPhase('rise');
    }
    if (this.jumpPhase === 'land' && this.jumpPhaseTime >= JUMP.landingSeconds) {
      this.jumpKind = null;
      this.setJumpPhase('grounded');
    }
    if (this.climb) { this.moveClimb(world, filter); return; }
    const wasGrounded = this.grounded;
    // Snapping and autostep are for walking. In flight they would pull the capsule onto a
    // ledge before physical contact or allow a rising capsule to climb through a ceiling.
    if (this.grounded) {
      this.controller.enableAutostep(0.45, 0.25, true);
      this.controller.enableSnapToGround(0.4);
    } else {
      this.controller.disableAutostep();
      this.controller.disableSnapToGround();
    }
    if (this.grounded && this.verticalSpeed < 0) this.verticalSpeed = 0;
    this.verticalSpeed -= JUMP.gravity * TICK_SECONDS;
    this.verticalSpeed = Math.max(this.verticalSpeed, -30);
    const desired = { x: vx * TICK_SECONDS, y: this.verticalSpeed * TICK_SECONDS, z: vz * TICK_SECONDS };
    const solid = groups(GROUP.character, GROUP.static | GROUP.vehicle | GROUP.character);
    this.controller.computeColliderMovement(this.collider, desired, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, solid, filter);
    let m = this.controller.computedMovement(), onGround = this.controller.computedGrounded();
    // Rapier takes a floor whose normal comes out a hair under vertical for a slope that the step's gravity part slides
    // down, and drops the whole step: a runner on flat ground stopped dead for single ticks. The same step a hair
    // upward never touches that floor; the snap brings it back down next tick.
    if (wasGrounded && this.verticalSpeed <= 0 && this.lostStepOnFlatFloor(desired, m)) {
      this.controller.computeColliderMovement(this.collider, { x: desired.x, y: FLAT_RETRY_RISE, z: desired.z }, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, solid, filter);
      const retry = this.controller.computedMovement();
      if (Math.hypot(retry.x, retry.z) > Math.hypot(m.x, m.z) + 1e-6) { m = retry; onGround = this.controller.computedGrounded(); }
    }
    const t = this.body.translation();
    const next = { x: t.x + m.x, y: t.y + m.y, z: t.z + m.z };
    this.body.setNextKinematicTranslation(next);
    this.grounded = this.verticalSpeed <= 0 && onGround;
    if (this.grounded && !wasGrounded) this.landingSpeed = Math.max(0, -this.verticalSpeed);
    if (this.verticalSpeed > 0 && m.y < desired.y - 0.0001) {
      for (let i = 0; i < this.controller.numComputedCollisions(); i++) {
        if ((this.controller.computedCollision(i)?.normal1.y ?? 0) < -0.2) {
          this.verticalSpeed = 0;
          this.jumpUpgradeAllowed = false;
          break;
        }
      }
    }
    if (this.grounded && this.verticalSpeed < 0) this.verticalSpeed = 0;
    this.position = [next.x, next.y - FEET_TO_CENTRE, next.z];
    this.speed = Math.hypot(m.x, m.z) / TICK_SECONDS;
    if (!this.grounded && this.jumpPhase !== 'takeoff') this.setJumpPhase(this.verticalSpeed > 0 ? 'rise' : 'fall');
    else if (this.grounded && !wasGrounded) {
      this.jumpUpgradeAllowed = false;
      this.setJumpPhase('land');
    }
    if (this.grounded) this.groundDistance = 0;
    else this.probeGroundDistance(world);
  }

  /**
   * The controller made less of the step than asked for, and at a flat-floor contact it dropped what was left: sliding on
   * a floor that flat keeps the whole horizontal part, but less than half of it went on into the next cast or the result.
   */
  private lostStepOnFlatFloor(desired: { x: number; z: number }, moved: { x: number; z: number }): boolean {
    if (Math.hypot(moved.x, moved.z) >= Math.hypot(desired.x, desired.z) - 1e-6) return false;
    const n = this.controller.numComputedCollisions();
    for (let i = 0; i < n; i++) {
      const hit = this.controller.computedCollision(i);
      if (!hit || hit.normal1.y <= 0.9999) continue;
      const left = Math.hypot(hit.translationDeltaRemaining.x, hit.translationDeltaRemaining.z);
      if (left < 1e-6) continue;
      // Each contact reports the translation applied so far and what remained when it was hit.
      const next = i + 1 < n ? this.controller.computedCollision(i + 1) : null;
      const end = next ? { x: next.translationDeltaApplied.x + next.translationDeltaRemaining.x, z: next.translationDeltaApplied.z + next.translationDeltaRemaining.z } : moved;
      if (Math.hypot(end.x - hit.translationDeltaApplied.x, end.z - hit.translationDeltaApplied.z) < left / 2) return true;
    }
    return false;
  }

  private probeGroundDistance(world: StaticWorld): void {
    const ray = new RAPIER.Ray({ x: this.position[0], y: this.position[1] + 0.08, z: this.position[2] }, { x: 0, y: -1, z: 0 });
    const hit = world.physics.castRay(ray, 6.08, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS,
      groups(GROUP.character, GROUP.static | GROUP.vehicle), this.collider, this.body);
    this.groundDistance = hit ? Math.max(0, hit.timeOfImpact - 0.08) : null;
  }

  /**
   * The player after a move, or a walker fleeing over an obstacle: while airborne in a jump and pressing toward a wall,
   * grab an edge whose top is within hand reach but which the jump will not clear. Every query is a deterministic static
   * ray or swept capsule, so a grab never starts a path through geometry.
   */
  tryGrabLedge(world: StaticWorld, dirX: number, dirZ: number): boolean {
    if (!this.alive || this.inVehicle || this.climb || this.grounded || this.jumpKind === null) return false;
    if (this.jumpPhase !== 'rise' && this.jumpPhase !== 'fall') return false;
    const len = Math.hypot(dirX, dirZ);
    if (len < 1e-6) return false;
    const dx = dirX / len, dz = dirZ / len, [fx, fy, fz] = this.position, r = CHARACTER.radius;
    const flags = RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, solid = groups(GROUP.character, GROUP.static);
    const down = { x: 0, y: -1, z: 0 };
    // The top surface just beyond the capsule, between the minimum and maximum climb heights.
    const probeY = fy + CLIMB.maxHeight + 0.02;
    const topHit = world.physics.castRayAndGetNormal(new RAPIER.Ray({ x: fx + dx * (r + CLIMB.reach), y: probeY, z: fz + dz * (r + CLIMB.reach) }, down),
      CLIMB.maxHeight + 0.02 - CLIMB.minHeight, true, flags, solid, this.collider, this.body);
    // A ray starting inside a solid means the wall continues above reach.
    if (!topHit || topHit.timeOfImpact < 1e-3 || topHit.normal.y < 0.7) return false;
    const top = probeY - topHit.timeOfImpact;
    // The ray starts a little above reach, so it also finds tops just beyond it.
    if (top - fy > CLIMB.maxHeight) return false;
    if (this.verticalSpeed > 0 && fy + this.verticalSpeed * this.verticalSpeed / (2 * JUMP.gravity) >= top + CLIMB.clearMargin) return false;
    // A wall face just below the edge, facing the climber within 60 degrees.
    const faceHit = world.physics.castRayAndGetNormal(new RAPIER.Ray({ x: fx, y: top - 0.08, z: fz }, { x: dx, y: 0, z: dz }),
      r + CLIMB.reach + 0.1, true, flags, solid, this.collider, this.body);
    if (!faceHit || Math.abs(faceHit.normal.y) > 0.35) return false;
    let nx = faceHit.normal.x, nz = faceHit.normal.z;
    const nl = Math.hypot(nx, nz);
    nx /= nl; nz /= nl;
    if (nx * dx + nz * dz > 0) { nx = -nx; nz = -nz; }
    if (nx * dx + nz * dz > -0.5) return false;
    const ex = fx + dx * faceHit.timeOfImpact, ez = fz + dz * faceHit.timeOfImpact;
    const wall: [number, number] = [ex + nx * (r + CLIMB.wallGap), ez + nz * (r + CLIMB.wallGap)];
    const tx = ex - nx * (r + CLIMB.inset), tz = ez - nz * (r + CLIMB.inset);
    // Standing support on the top where the capsule will stand (rejects thin walls and fences).
    const supportHit = world.physics.castRayAndGetNormal(new RAPIER.Ray({ x: tx, y: top + 0.4, z: tz }, down), 0.6, true, flags, solid, this.collider, this.body);
    if (!supportHit || supportHit.normal.y < 0.7 || Math.abs(0.4 - supportHit.timeOfImpact) > 0.1) return false;
    const target: V3 = [tx, top + 0.4 - supportHit.timeOfImpact + CLIMB.lift, tz];
    // Swept clearance, slightly slimmer than the capsule so the touched wall itself does not count.
    const shape = new RAPIER.Capsule(CHARACTER.halfHeight, r - 0.03), rotation = { x: 0, y: 0, z: 0, w: 1 };
    const blockers = groups(GROUP.character, GROUP.static | GROUP.vehicle);
    const raised = { x: wall[0], y: target[1] + FEET_TO_CENTRE, z: wall[1] };
    const sweeps: [{ x: number; y: number; z: number }, { x: number; y: number; z: number }][] = [
      [{ x: fx, y: fy + FEET_TO_CENTRE, z: fz }, raised],
      [raised, { x: tx, y: raised.y, z: tz }],
    ];
    for (const [from, to] of sweeps) {
      const hit = world.physics.castShape(from, rotation, { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z }, shape, 0, 1, true, flags, blockers, this.collider, this.body);
      if (hit) return false;
    }
    const height = top - fy;
    this.climb = { height, duration: CLIMB.baseSeconds + CLIMB.perMetreSeconds * height, edge: [ex, top, ez], normal: [nx, nz],
      start: [fx, fy, fz], wall, target };
    this.verticalSpeed = 0;
    this.jumpUpgradeAllowed = false;
    this.setJumpPhase('climb');
    return true;
  }

  /** Follow the climb path through the controller, so nothing that appeared since the grab is penetrated. */
  private moveClimb(world: StaticWorld, filter?: (c: RAPIER.Collider) => boolean): void {
    const c = this.climb!;
    const u = Math.min(1, this.jumpPhaseTime / c.duration);
    this.turnToward(Math.atan2(-c.normal[0], -c.normal[1]), 16);
    const goal = climbPathPoint(c, u);
    this.controller.disableAutostep();
    this.controller.disableSnapToGround();
    const desired = { x: goal[0] - this.position[0], y: goal[1] - this.position[1], z: goal[2] - this.position[2] };
    this.controller.computeColliderMovement(this.collider, desired, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, groups(GROUP.character, GROUP.static | GROUP.vehicle | GROUP.character), filter);
    const m = this.controller.computedMovement();
    const t = this.body.translation();
    const next = { x: t.x + m.x, y: t.y + m.y, z: t.z + m.z };
    this.body.setNextKinematicTranslation(next);
    this.position = [next.x, next.y - FEET_TO_CENTRE, next.z];
    this.speed = Math.hypot(m.x, m.z) / TICK_SECONDS;
    this.verticalSpeed = 0;
    this.grounded = false;
    if (Math.hypot(goal[0] - this.position[0], goal[1] - this.position[1], goal[2] - this.position[2]) > 0.2) {
      // Something now blocks the path: let go and fall.
      this.climb = null;
      this.setJumpPhase('fall');
    } else if (u >= 1) {
      this.climb = null;
      this.grounded = true;
      this.jumpKind = null;
      this.landingSpeed = 0;
      this.setJumpPhase('grounded');
    }
    if (this.grounded) this.groundDistance = 0;
    else this.probeGroundDistance(world);
  }

  /**
   * The facing for a body to fall along: the one nearest its own, in 15° steps either way, where it lies on level
   * ground clear of walls, kerbs and cars; otherwise the one with the fewest blocked or unsupported pieces.
   */
  chooseFall(world: StaticWorld): number {
    const [x, y, z] = this.position, flags = RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, down = { x: 0, y: -1, z: 0 };
    const slabs = BODY_PIECES.map(([, , along, across]) => new RAPIER.Cuboid(across, BODY.thickness / 2, along));
    let best = { yaw: this.yaw, failed: Infinity };
    for (const step of [0, ...Array.from({ length: 11 }, (_, i) => [i + 1, -i - 1]).flat(), 12]) {
      const yaw = wrapAngle(this.yaw + step * Math.PI / 12), sin = Math.sin(yaw), cos = Math.cos(yaw);
      const rotation = { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) };
      let failed = 0;
      BODY_PIECES.forEach(([along, across, , , rests], i) => {
        const px = x + sin * along + cos * across, pz = z + cos * along - sin * across;
        const blocked = world.physics.intersectionWithShape({ x: px, y: y + BODY.rise + BODY.thickness / 2, z: pz }, rotation, slabs[i]!, flags,
          groups(GROUP.character, GROUP.static | GROUP.vehicle), this.collider, this.body);
        const unsupported = rests && !world.physics.castRay(new RAPIER.Ray({ x: px, y: y + BODY.rise, z: pz }, down), BODY.rise + BODY.drop, true, flags,
          groups(GROUP.character, GROUP.static), this.collider, this.body);
        if (blocked || unsupported) failed++;
      });
      if (failed < best.failed) best = { yaw, failed };
      if (!failed) break;
    }
    return best.yaw;
  }

  /** Face a yaw gradually (rad/s rate). */
  turnToward(yaw: number, rate = 12): void {
    const d = wrapAngle(yaw - this.yaw);
    const step = clamp(d, -rate * TICK_SECONDS, rate * TICK_SECONDS);
    this.yaw = wrapAngle(this.yaw + step);
  }

  teleport(position: V3, yaw: number): void {
    this.position = [position[0], position[1] + CHARACTER_SKIN, position[2]];
    this.yaw = yaw;
    this.resetJump();
    this.grounded = false;
    this.groundDistance = null;
    const centre = { x: position[0], y: this.position[1] + FEET_TO_CENTRE, z: position[2] };
    this.body.setNextKinematicTranslation(centre);
    this.body.setTranslation(centre, true);
    this.collisionPositionDirty = true;
  }

  /** Hide the capsule far away while seated so it neither collides nor blocks the car. */
  hide(): void {
    this.resetJump();
    this.grounded = false;
    this.groundDistance = null;
    this.body.setTranslation({ x: 0, y: -1000, z: 0 }, true);
    this.body.setNextKinematicTranslation({ x: 0, y: -1000, z: 0 });
  }

  get centre(): V3 { return [this.position[0], this.position[1] + FEET_TO_CENTRE, this.position[2]]; }
  get eye(): V3 { return [this.position[0], this.position[1] + CHARACTER.eye, this.position[2]]; }
  get head(): V3 { return [this.position[0], this.position[1] + 1.68, this.position[2]]; }

  /** Returns the damage actually applied after armour. */
  takeDamage(amount: number): number {
    if (!this.alive) return 0;
    let remaining = amount;
    if (this.armour > 0) { const absorbed = Math.min(this.armour, remaining * 0.7); this.armour -= absorbed; remaining -= absorbed; }
    this.health = Math.max(0, this.health - remaining);
    this.hitTicks = 20;
    if (this.health <= 0) {
      this.alive = false;
      this.deathTicks = 0;
      // Vehicle contacts resolve after NPC AI. Publish a terminal pose immediately, even
      // when there is no further AI tick before the next rendered snapshot.
      this.clip = 'death';
      this.clipTicks = 0;
      this.desiredVx = 0; this.desiredVz = 0; this.speed = 0;
      this.resetJump(true);
    }
    return remaining;
  }
}

/** Half a gravity step compensates semi-implicit integration without changing its collision sweep. */
function launchSpeed(height: number): number {
  return Math.sqrt(2 * JUMP.gravity * height) + JUMP.gravity * TICK_SECONDS / 2;
}
