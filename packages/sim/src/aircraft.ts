// Simple fixed-step flight. Collision and ground always come from the resident world, never client HUD state.
import { Button, has, TICK_SECONDS, type Command } from './commands.ts';
import { clamp, distanceXZ, moveToward, quatMul, quatYaw, rotate, wrapAngle, yawOf, type Quat, type V3 } from './math.ts';
import type { DamageState } from './vehicle.ts';
import { LIVE_REGION_XZ } from './live-grid.ts';
import { GROUP, groups, RAPIER, type StaticWorld } from './world.ts';
import { CHARACTER, FEET_TO_CENTRE } from './character.ts';

export const MALMI_AIRFIELD = { x: 4986.982, z: -8950.456 } as const;
export const MALMI_DROP_IN = { x: 4980.982, z: -8950.456 } as const;
export type AircraftKind = 'plane' | 'helicopter';
export interface AircraftDefinition {
  readonly id: string; readonly kind: AircraftKind; readonly label: string;
  readonly position: readonly [number, number]; readonly yaw: number;
  readonly seat: V3; readonly entryRadius: number;
}
export const AIRCRAFT_DEFINITIONS: readonly AircraftDefinition[] = [
  { id: 'malmi-plane', kind: 'plane', label: 'Cessna 172', position: [MALMI_AIRFIELD.x, MALMI_AIRFIELD.z], yaw: Math.PI, seat: [-0.2, 0.95, 1.3], entryRadius: 7 },
  { id: 'malmi-helicopter', kind: 'helicopter', label: 'Mi-17', position: [5009.144, -8933.758], yaw: Math.PI, seat: [0.25, 1.35, 3.2], entryRadius: 6 },
];
export interface AircraftState {
  readonly id: string; readonly kind: AircraftKind; readonly position: V3; readonly rotation: Quat;
  readonly yaw: number; readonly speed: number; readonly verticalSpeed: number;
  readonly grounded: boolean; readonly throttle: number; readonly occupied: boolean; readonly blocked: boolean;
  readonly crashed: boolean; readonly health: number; readonly damage: DamageState;
  readonly velocity: V3; readonly angularVelocity: V3;
}
const vector = (p: V3) => ({ x: p[0], y: p[1], z: p[2] });
const MAX_HEIGHT = 550;
export interface AircraftHull { readonly centre: V3; readonly half: V3 }
/** Conservative part envelopes fitted to the licensed GLBs. Rotors include their complete animated disc;
 * control-surface travel fits the wing/tail boxes. The 3 cm gear/skid skin is the floor-contact tolerance. */
export const AIRCRAFT_HULLS: Readonly<Record<AircraftKind, readonly AircraftHull[]>> = {
  plane: [
    { centre: [0, 1.35, 0.25], half: [1.12, 0.8, 3.75] },
    { centre: [0, 2.2, 0.75], half: [5.55, 0.25, 0.95] },
    { centre: [0, 1.13, -3.2], half: [1.85, 0.2, 0.9] },
    { centre: [0, 1.8, -3.3], half: [0.25, 0.75, 0.8] },
    { centre: [0.01, 1.15, 4.04], half: [1.12, 1.12, 0.25] },
    { centre: [0, 0.3, 0.7], half: [1.4, 0.27, 2.5] },
  ],
  helicopter: [
    { centre: [0, 2.15, 0.4], half: [2.05, 1.6, 4.65] },
    { centre: [0, 2.8, -7.7], half: [0.8, 1.1, 3.5] },
    { centre: [0, 4.27, 0], half: [10.7, 0.35, 10.7] },
    { centre: [0.31, 4.14, -10.99], half: [0.25, 1.8, 1.8] },
    { centre: [0, 0.4, 0.8], half: [2.02, 0.37, 2.9] },
  ],
};
function rotationOf(yaw: number, pitch: number, bank: number): Quat {
  return quatMul(quatMul(quatYaw(yaw), [Math.sin(pitch / 2), 0, 0, Math.cos(pitch / 2)]), [0, 0, Math.sin(bank / 2), Math.cos(bank / 2)]);
}
function isLevelYaw(from: Quat, to: Quat): boolean {
  return Math.abs(from[0])+Math.abs(from[2])+Math.abs(to[0])+Math.abs(to[2])<1e-12;
}
/** Shortest world-space angular velocity taking one orientation to the next in a fixed tick. */
function angularVelocityBetween(from: Quat, to: Quat): V3 {
  let delta=quatMul(to,[-from[0],-from[1],-from[2],from[3]]);
  if(delta[3]<0)delta=delta.map(v=>-v)as Quat;
  const sine=Math.hypot(delta[0],delta[1],delta[2]);
  if(sine<1e-12)return [0,0,0];
  const scale=2*Math.atan2(sine,delta[3])/(sine*TICK_SECONDS);
  return [delta[0]*scale,delta[1]*scale,delta[2]*scale];
}

/** A query-qualified aircraft spawn. A height-grid edge extrapolation never authorizes spawning. */
export function aircraftGround(world: StaticWorld, x: number, z: number, ceiling = 200): number | null {
  if (!world.queryable(x, z)) return null;
  const hit = world.spawnGroundBelow(x, ceiling, z, ceiling + 60);
  return hit && hit.normalY >= 0.85 && hit.surface?.group !== 'water' && hit.surface?.tag !== 'water' ? hit.y : null;
}

/** The centre ray alone leaves a wheel/skid penetrating an uphill runway. Qualify the complete undercarriage
 * footprint and use its highest real surface. A broken seam, missing cell or large step is never taxi support. */
export function aircraftSupportGround(world: StaticWorld, kind: AircraftKind, x: number, z: number, yaw: number, ceiling = 200): number | null {
  const gear = AIRCRAFT_HULLS[kind].at(-1)!;
  const heights: number[] = [];
  for (const dx of [-1, 0, 1]) for (const dz of [-1, 0, 1]) {
    const offset = rotate(quatYaw(yaw), [gear.centre[0] + dx * gear.half[0], 0, gear.centre[2] + dz * gear.half[2]]);
    const ground = aircraftGround(world, x + offset[0], z + offset[2], ceiling);
    if (ground === null) return null;
    heights.push(ground);
  }
  const highest = Math.max(...heights);
  return highest - Math.min(...heights) <= 0.8 ? highest : null;
}

export class Aircraft {
  position: V3;
  yaw: number;
  speed = 0;
  verticalSpeed = 0;
  throttle = 0;
  grounded = true;
  occupied = false;
  blocked = false;
  crashed = false;
  health = 1;
  damage: DamageState = 'intact';
  velocityBefore: V3 = [0, 0, 0];
  /** One-shot transition consumed by the simulation, including the first physical impact tick. */
  crashPending = false;
  readonly colliders: RAPIER.Collider[] = [];
  private bank = 0;
  private pitch = 0;
  private flightAngularVelocity: V3 = [0,0,0];
  readonly body: RAPIER.RigidBody;
  readonly collider: RAPIER.Collider;
  readonly world: StaticWorld;
  readonly def: AircraftDefinition;

  constructor(world: StaticWorld, def: AircraftDefinition, groundY: number) {
    this.world = world; this.def = def;
    this.position = [def.position[0], aircraftSupportGround(world, def.kind, def.position[0], def.position[1], def.yaw) ?? groundY, def.position[1]];
    this.yaw = def.yaw;
    this.body = world.physics.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(...this.position));
    this.collider = this.attachHull(AIRCRAFT_HULLS[def.kind][0]!);
    for (const hull of AIRCRAFT_HULLS[def.kind].slice(1)) this.attachHull(hull);
    this.placeBody();
  }
  get id(): string { return this.def.id; }
  get rotation(): Quat {
    if (this.crashed) { const q=this.body.rotation(); return [q.x,q.y,q.z,q.w]; }
    return rotationOf(this.yaw, this.pitch, this.bank);
  }
  get velocity(): V3 { if(this.crashed){const v=this.body.linvel();return [v.x,v.y,v.z];}return [Math.sin(this.yaw)*this.speed,this.verticalSpeed,Math.cos(this.yaw)*this.speed]; }
  get angularVelocity(): V3 { const v=this.body.angvel();return this.crashed?[v.x,v.y,v.z]:[...this.flightAngularVelocity]; }
  get deltaV(): number { const v=this.velocity;return Math.hypot(...v.map((n,i)=>n-this.velocityBefore[i]!)); }
  get seat(): V3 { const p = rotate(this.rotation, this.def.seat); return p.map((v, i) => v + this.position[i]!) as V3; }
  state(): AircraftState { return { id: this.id, kind: this.def.kind, position: [...this.position], rotation: this.rotation, yaw: this.yaw, speed: this.speed, verticalSpeed: this.verticalSpeed, grounded: this.grounded, throttle: this.throttle, occupied: this.occupied, blocked: this.blocked, crashed:this.crashed,health:this.health,damage:this.damage,velocity:this.velocity,angularVelocity:this.angularVelocity }; }
  near(position: V3): boolean { return !this.crashed && this.grounded && this.speed < 2 && Math.abs(position[1] - this.position[1]) < 2 && distanceXZ(position, this.position) <= this.def.entryRadius; }

  step(command: Command): void {
    this.blocked = false;
    if (!this.occupied || this.crashed) return;
    const plane = this.def.kind === 'plane', dt = TICK_SECONDS;
    // Plane throttle persists when W is released; S reduces it. Helicopters stop and hover on release.
    if (plane) this.throttle = clamp(this.throttle + command.moveZ * dt * 0.45, 0, 1);
    else this.throttle = clamp(command.moveZ, -0.45, 1);
    const boost = has(command.buttons, Button.sprint);
    const targetSpeed = this.throttle * (plane ? boost ? 80 : 58 : boost ? 48 : 30);
    const nextSpeed = moveToward(this.speed, targetSpeed, (plane ? 8 : 12) * dt);
    const nextYaw = wrapAngle(this.yaw - command.moveX * (plane ? this.grounded ? 0.45 : 0.7 : 1.0) * dt);
    const climb = (has(command.buttons, Button.ascend) ? 1 : 0) - (has(command.buttons, Button.descend) ? 1 : 0);
    const liftReady = !plane || nextSpeed >= 18;
    const support=aircraftSupportGround(this.world,this.def.kind,this.position[0],this.position[2],this.yaw,this.position[1]+0.05);
    // The arcade descent control includes a landing flare. Abrupt terrain/obstacle impacts still retain their
    // real sink velocity; holding descend over a runway is an ordinary landing, not a mandatory crash.
    const descendingRate=support!==null&&this.position[1]-support<6?-2:-7;
    const targetVertical = climb > 0 && liftReady ? plane ? 10 : 9 : climb < 0 ? descendingRate : plane && !this.grounded && nextSpeed < 16 ? descendingRate : 0;
    const nextVertical = moveToward(this.verticalSpeed, targetVertical, 8 * dt);
    const candidate: V3 = [this.position[0] + Math.sin(nextYaw) * nextSpeed * dt, clamp(this.position[1] + nextVertical * dt, -40, MAX_HEIGHT), this.position[2] + Math.cos(nextYaw) * nextSpeed * dt];
    const [x0, z0, x1, z1] = LIVE_REGION_XZ;
    const clearance = plane ? 8 : 15;
    if (candidate[0] < x0 + clearance || candidate[0] > x1 - clearance || candidate[2] < z0 + clearance || candidate[2] > z1 - clearance || ![-clearance,0,clearance].every(dx => [-clearance,0,clearance].every(dz => this.world.queryable(candidate[0] + dx, candidate[2] + dz)))) {
      this.blocked = true; this.speed = 0; this.verticalSpeed = 0; this.flightAngularVelocity=[0,0,0]; return;
    }
    // Ground is a real resident static surface. It can raise a taxiing aircraft over gently sloping pavement,
    // but never pulls a flying aircraft through buildings or snaps it to a roof above its current height.
    const ground = aircraftSupportGround(this.world, this.def.kind, candidate[0], candidate[2], nextYaw, this.position[1] + (this.grounded ? 2 : 0.05));
    let landed = false;
    if (ground !== null && candidate[1] <= ground + 0.08 && nextVertical <= 0.1) {
      if(!this.grounded&&nextVertical < -4){this.crash([Math.sin(nextYaw)*nextSpeed,nextVertical,Math.cos(nextYaw)*nextSpeed]);return;}
      candidate[1] = ground; landed = true;
    }
    if (this.grounded && !liftReady && ground !== null) { candidate[1] = ground; landed = true; }
    const levelling = this.grounded || (nextVertical <= 0 && ground !== null && candidate[1] - ground < 3);
    let nextBank = moveToward(this.bank, levelling ? 0 : command.moveX * (plane ? 0.38 : 0.18), dt);
    let nextPitch = moveToward(this.pitch, levelling ? 0 : -nextVertical * 0.018, dt);
    const oldRotation = this.rotation;
    let nextRotation = rotationOf(nextYaw, nextPitch, nextBank);
    // Capture before the sweep retry rewrites intended angles and before applying a clipped pose. Euler deltas
    // are local axes; the quaternion delta is the world angular velocity Rapier needs at any impact fraction.
    const intendedAngularVelocity=angularVelocityBetween(oldRotation,nextRotation);
    const intendedLevelYaw=isLevelYaw(oldRotation,nextRotation);
    let fraction = this.sweepFraction(candidate, oldRotation, nextRotation, Math.abs(wrapAngle(nextYaw - this.yaw)) + Math.abs(nextPitch - this.pitch) + Math.abs(nextBank - this.bank));
    // A rotation blocked near the ground must still allow a vertical escape. Retry translation at the current
    // orientation; keep every visual angle frozen so the rejected wing/rotor cannot turn through the obstruction.
    let appliedYaw = nextYaw;
    let rotationBlocked = false;
    if (fraction < 0.001) {
      const translation = this.sweepFraction(candidate, oldRotation, oldRotation, 0);
      if (translation > fraction) { fraction = translation; appliedYaw = this.yaw; nextPitch = this.pitch; nextBank = this.bank; nextRotation = oldRotation; rotationBlocked = true; }
    }
    this.position = candidate.map((v, i) => this.position[i]! + (v - this.position[i]!) * fraction) as V3;
    this.yaw = wrapAngle(this.yaw + wrapAngle(appliedYaw - this.yaw) * fraction);
    this.grounded = landed && fraction > 0.999;
    this.speed = fraction < 0.999 ? 0 : nextSpeed;
    this.verticalSpeed = fraction < 0.999 || this.grounded ? 0 : nextVertical;
    this.blocked = rotationBlocked || fraction < 0.999;
    if (fraction < 0.999) this.throttle = 0;
    this.bank += (nextBank - this.bank) * fraction;
    this.pitch += (nextPitch - this.pitch) * fraction;
    this.placeBody();
    this.flightAngularVelocity=angularVelocityBetween(oldRotation,this.rotation);
    // The angular enclosure can touch a graded runway while the real gear remains clear. The existing
    // translation-only levelling retry is support, whereas a blocked airborne bank is a hull strike.
    const runwayRotationRetry=!intendedLevelYaw&&ground!==null&&this.position[1]-ground<3;
    if((rotationBlocked&&!runwayRotationRetry)||fraction<0.999){
      this.crash([Math.sin(nextYaw)*nextSpeed,nextVertical,Math.cos(nextYaw)*nextSpeed],intendedAngularVelocity);
    }
  }

  /** A real hull strike hands the same pose to Rapier. No flight forces or orientation correction follow. */
  crash(velocity:V3=this.velocity,angularVelocity:V3=this.flightAngularVelocity):void {
    if(this.crashed)return;
    this.placeBody();
    this.crashed=true;this.crashPending=true;this.grounded=false;this.blocked=true;this.throttle=0;
    this.body.setBodyType(RAPIER.RigidBodyType.Dynamic,true);this.body.enableCcd(true);
    this.body.setLinearDamping(0.12);this.body.setAngularDamping(0.65);
    for(const c of this.colliders)c.setCollisionGroups(groups(GROUP.vehicle,GROUP.all));
    this.body.setLinvel(vector(velocity),true);this.body.setAngvel(vector(angularVelocity),true);
    this.velocityBefore=[...velocity];
    this.applyDamage(Math.max(0.12,(Math.hypot(...velocity)-2)*0.012));
  }
  beforePhysics():void { if(this.crashed)this.velocityBefore=this.velocity;else if(!this.occupied)this.flightAngularVelocity=[0,0,0]; }
  afterPhysics():void {
    if(!this.crashed)return;
    const p=this.body.translation();this.position=[p.x,p.y,p.z];this.yaw=yawOf(this.rotation);
    const v=this.velocity;this.speed=Math.hypot(v[0],v[2]);this.verticalSpeed=v[1];
    let contact=false;
    for(const c of this.colliders)this.world.physics.contactPairsWith(c,other=>{if(other.parent()?.handle!==this.body.handle)contact=true;});
    this.grounded=contact&&Math.abs(v[1])<0.3;
  }
  applyDamage(amount:number):void {
    this.health=clamp(this.health-Math.max(0,amount),0,1);
    this.damage=this.health===0?'wrecked':this.health<0.25?'burning':this.health<0.65?'smoking':'intact';
  }

  /** Only dismount onto a flat, unobstructed surface beside the parked aircraft. */
  exitPoint(): V3 | null {
    if (!this.grounded || Math.abs(this.speed) >= 2 || Math.abs(this.verticalSpeed) > 0.2 || Math.hypot(...this.angularVelocity)>0.3) return null;
    const offsets=[1,-1].map(side=>rotate(quatYaw(this.yaw),[side*(this.def.kind==='plane'?6.6:3),0,0]));
    if(this.crashed){
      // A rotor or wing can lie across the ordinary door exit after a rollover. Search beyond the full
      // physical envelope, still requiring real flat ground and a clear standing volume at the destination.
      for(const axis of [0,2]as const)for(const sign of [1,-1]){
        let reach=0;
        for(const h of AIRCRAFT_HULLS[this.def.kind])for(const dx of [-1,1])for(const dy of [-1,1])for(const dz of [-1,1]){
          const corner=rotate(this.rotation,[h.centre[0]+dx*h.half[0],h.centre[1]+dy*h.half[1],h.centre[2]+dz*h.half[2]]);
          reach=Math.max(reach,sign*corner[axis]);
        }
        const offset:V3=[0,0,0];offset[axis]=sign*(reach+CHARACTER.radius+0.3);offsets.push(offset);
      }
    }
    for (const offset of offsets) {
      const x = this.position[0] + offset[0], z = this.position[2] + offset[2];
      const y = aircraftGround(this.world, x, z, this.position[1] + 1);
      const exitHeight=this.crashed?Math.max(...AIRCRAFT_HULLS[this.def.kind].map(h=>h.centre[1]+h.half[1]))+0.6:0.6;
      if (y === null || Math.abs(y - this.position[1]) > exitHeight) continue;
      // A box encloses the actual standing capsule. It also avoids the capsule/large-triangle near-parallel
      // false positives seen on runway grades, while conservatively retaining every wall/person obstruction.
      const hit = this.world.physics.intersectionWithShape({ x, y: y + FEET_TO_CENTRE + 0.06, z }, { x: 0, y: 0, z: 0, w: 1 }, new RAPIER.Cuboid(CHARACTER.radius, FEET_TO_CENTRE, CHARACTER.radius), undefined, groups(GROUP.character, GROUP.static | GROUP.vehicle | GROUP.character), undefined, this.crashed?undefined:this.body);
      if (!hit) return [x, y, z];
    }
    return null;
  }
  recover(): boolean {
    const [x, z] = this.def.position, ground = aircraftSupportGround(this.world, this.def.kind, x, z, this.def.yaw);
    if (ground === null) return false;
    this.crashed=false;this.crashPending=false;this.health=1;this.damage='intact';
    this.flightAngularVelocity=[0,0,0];
    this.body.setBodyType(RAPIER.RigidBodyType.KinematicPositionBased,true);this.body.setLinvel({x:0,y:0,z:0},true);this.body.setAngvel({x:0,y:0,z:0},true);
    for(const c of this.colliders)c.setCollisionGroups(groups(GROUP.vehicle,GROUP.vehicle|GROUP.character|GROUP.bullet));
    this.position = [x, ground, z]; this.yaw = this.def.yaw; this.speed = 0; this.verticalSpeed = 0; this.throttle = 0;
    this.grounded = true; this.blocked = false; this.bank = 0; this.pitch = 0; this.placeBody(); return true;
  }
  digest(): string { return JSON.stringify([this.id, this.position, this.yaw, this.speed, this.verticalSpeed, this.throttle, this.grounded, this.occupied, this.bank, this.pitch,this.crashed,this.health,this.damage,this.rotation,this.velocity,this.angularVelocity,this.body.isSleeping()]); }
  private attachHull(hull: AircraftHull): RAPIER.Collider {
    const mass=this.def.kind==='plane'?1100:7500,he=AIRCRAFT_HULLS[this.def.kind][0]!.half;
    const desc=RAPIER.ColliderDesc.cuboid(...hull.half).setTranslation(...hull.centre).setDensity(0)
      .setFriction(0.55).setRestitution(0.05).setCollisionGroups(groups(GROUP.vehicle, GROUP.vehicle | GROUP.character | GROUP.bullet))
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS|RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(8000);
    // Only the fuselage carries mass: the conservative rotor-disc envelope must not dominate inertia.
    if(!this.colliders.length)desc.setMassProperties(mass,{x:0,y:0,z:0},{x:mass/3*(he[1]**2+he[2]**2),y:mass/3*(he[0]**2+he[2]**2),z:mass/3*(he[0]**2+he[1]**2)},{x:0,y:0,z:0,w:1});
    const collider=this.world.physics.createCollider(desc,this.body);this.colliders.push(collider);return collider;
  }
  private sweepFraction(candidate: V3, fromRotation: Quat, toRotation: Quat, angularTravel: number): number {
    let fraction = 1;
    const yawOnly=isLevelYaw(fromRotation,toRotation);
    for (const hull of AIRCRAFT_HULLS[this.def.kind]) {
      const a = rotate(fromRotation, hull.centre), b = rotate(toRotation, hull.centre);
      const from = this.position.map((v, i) => v + a[i]!) as V3;
      const delta = candidate.map((v, i) => v + b[i]! - from[i]!) as V3;
      const length = Math.hypot(...delta);
      // The oriented box's farthest point moves at most radius * angle. Expanding every local axis by that
      // distance encloses every intermediate orientation, while the centre's chord needs the curvature margin.
      const margin = Math.hypot(...hull.half) * angularTravel + Math.hypot(...hull.centre) * angularTravel * angularTravel / 8;
      // A level yaw turn preserves every point's height. Growing Y for that motion consumed the gear/nose's
      // 3 cm ground skin on Malmi's real uneven runway, producing a spurious impact at zero taxi speed.
      // Keep the full horizontal enclosure and ordinary static/vehicle queries: a real wing/wall strike blocks.
      const verticalMargin=yawOnly?0:margin;
      const shape = new RAPIER.Cuboid(hull.half[0] + margin, hull.half[1] + verticalMargin, hull.half[2] + margin);
      const q = { x: fromRotation[0], y: fromRotation[1], z: fromRotation[2], w: fromRotation[3] };
      if (length < 1e-9) {
        if (angularTravel && this.world.physics.intersectionWithShape(vector(from), q, shape, undefined, groups(GROUP.vehicle, GROUP.static|GROUP.vehicle), undefined, this.body)) fraction = 0;
        continue;
      }
      const hit = this.world.physics.castShape(vector(from), q, vector(delta), shape, 0.003, 1, true, undefined, groups(GROUP.vehicle, GROUP.static|GROUP.vehicle), undefined, this.body);
      if (hit) {
        // Rapier can report TOI 0 against nearly parallel runway triangles even when the gear is separated.
        // Independently certify the ENTIRE swept volume with an enclosing oriented box. This neither ignores
        // the floor collider nor trusts its tag: any real ground, wall or post inside that volume still blocks.
        const localDelta = rotate([-fromRotation[0], -fromRotation[1], -fromRotation[2], fromRotation[3]], delta);
        const swept = new RAPIER.Cuboid(hull.half[0] + margin + Math.abs(localDelta[0]) / 2 + 0.003,
          hull.half[1] + verticalMargin + Math.abs(localDelta[1]) / 2 + 0.003, hull.half[2] + margin + Math.abs(localDelta[2]) / 2 + 0.003);
        const centre = from.map((v, i) => v + delta[i]! / 2) as V3;
        if (!this.world.physics.intersectionWithShape(vector(centre), q, swept, undefined, groups(GROUP.vehicle, GROUP.static|GROUP.vehicle), undefined, this.body)) continue;
        fraction = Math.min(fraction, Math.max(0, hit.time_of_impact - 0.005 / length));
      }
    }
    return fraction;
  }
  private placeBody(): void {
    const p = vector(this.position), q = this.rotation, rotation = { x: q[0], y: q[1], z: q[2], w: q[3] };
    this.body.setTranslation(p, true); this.body.setNextKinematicTranslation(p);
    this.body.setRotation(rotation, true); this.body.setNextKinematicRotation(rotation);
  }
}
