// The fixed-step simulation (plan section 2): one Command in, one tick of player, vehicles, police and wanted
// state out. No rendering, no DOM, no Three.js. Everything the renderer needs is in `state()`; everything a
// replay needs is the seed plus the command stream.
import { type Anchor, type GameEvent, type GameplayBundle, type VehicleDefinition, type WeaponDefinition } from '@helsinki/world-schema';
import { BODY, Character, CHARACTER, FEET_TO_CENTRE, type CharacterClip, type ClimbView, type JumpKind, type JumpPhase } from './character.ts';
import { Button, has, NEUTRAL, TICK_HZ, TICK_SECONDS, type Command } from './commands.ts';
import { clamp, distanceXZ, dot, fnv1a, lengthXZ, normalize, Rng, rotate, sub, wrapAngle, yawOf, type Quat, type V3 } from './math.ts';
import { PoliceForce, type PoliceUnitState } from './police.ts';
import { ParkedCars } from './parked-cars.ts';
import { CIVILIAN_BULLETS_LETHAL, civilianVariant, Pedestrians, type PedestrianKnockdown } from './pedestrians.ts';
import { Vehicle } from './vehicle.ts';
import { WantedState, type Crime, type WantedSnapshot } from './wanted.ts';
import { fireRay, Inventory, type ShotResult } from './weapons.ts';
import { resolveAimDirection } from './aim.ts';
import { SafeSpawns } from './safe-spawn.ts';
import { VEHICLE_INTERACTION, vehicleApproachRoute, vehicleInteractionOf, vehicleDoorClearance, vehicleExitClearance, vehicleExitClips, vehicleExitRoute, vehicleExitYaw, vehicleAtPose, vehiclePosture, vehiclePushClearance, vehiclePushDirection, vehiclePushPlan, vehiclePushStage, vehiclePushTravel, vehiclePushYaw, vehicleReturnRoute, vehicleShovePlan, vehicleShoveTargetTravel, vehicleShoveTravel, type VehicleClip, type VehicleInteractionState, type VehiclePushClip, type VehicleShovePlan } from './vehicle-interaction.ts';
import { RAPIER, type StaticWorld } from './world.ts';
import { initialResidencySources, RESIDENCY, source, type ResidencyPlan, type ResidencySource } from './collision-residency.ts';
import {supportedSpawnGround}from'./spawn-ground.ts';

export type PlayerMode = 'onFoot' | 'entering' | 'driving' | 'exiting' | 'wasted' | 'busted';

export interface Shot {
  readonly shooter: string;
  readonly origin: V3;
  readonly end: V3;
  readonly hit: 'character' | 'vehicle' | 'static' | null;
  readonly hitId: string | null;
}

export interface VehicleState {
  readonly id: string;
  readonly definition: string;
  readonly position: V3;
  readonly rotation: Quat;
  readonly wheels: readonly { readonly position: V3; readonly rotation: number; readonly steer: number; readonly contact: boolean }[];
  readonly steerAngle: number;
  readonly speed: number;
  readonly forwardSpeed: number;
  readonly throttle: number;
  readonly damage: string;
  readonly health: number;
  readonly lightsOn: boolean;
  readonly sirenOn: boolean;
  readonly horn: boolean;
  readonly driver: string | null;
  readonly windshieldBroken: boolean;
}

export interface CharacterState {
  readonly knockdown?: PedestrianKnockdown | null;
  readonly id: string;
  readonly position: V3;
  readonly yaw: number;
  readonly clip: CharacterClip;
  readonly speed: number;
  readonly alive: boolean;
  /** Fixed-step seconds since lethal damage; absent only in older state consumers. */
  readonly deathElapsed?: number;
  readonly health: number;
  readonly inVehicle: string | null;
  readonly aiming: boolean;
  readonly grounded: boolean;
  readonly verticalSpeed: number;
  readonly jumpPhase: JumpPhase;
  readonly jumpPhaseTime: number;
  readonly jumpKind: JumpKind | null;
  readonly groundDistance: number | null;
  /** Downward speed at the most recent touchdown (m/s). */
  readonly landingSpeed: number;
  /** Active ledge climb (jumpPhase 'climb'). */
  readonly climb: ClimbView | null;
}

export interface PlayerState extends CharacterState {
  readonly pitch: number;
  readonly armour: number;
  readonly mode: PlayerMode;
  readonly modeTicks: number;
  readonly weapon: { readonly id: string; readonly magazine: number; readonly reserve: number; readonly reloading: boolean } | null;
  readonly nearVehicle: string | null;
  readonly recoverProgress: number;
  readonly vehicleInteraction: VehicleInteractionState | null;
}

export interface SimState {
  readonly tick: number;
  readonly time: number;
  readonly player: PlayerState;
  readonly vehicles: readonly VehicleState[];
  readonly characters: readonly CharacterState[];
  readonly police: readonly PoliceUnitState[];
  readonly wanted: WantedSnapshot;
  readonly arrestProgress: number;
  readonly screen: { readonly kind: 'wasted' | 'busted'; readonly ticksLeft: number; readonly destination: string } | null;
  readonly shots: readonly Shot[];
  readonly events: readonly GameEvent[];
}

export interface SimOptions {
  readonly seed: number;
  /** Ticks the Wasted / Busted screen stays before the respawn (default 3 s). */
  readonly screenTicks?: number;
}

const vehicleClipTicks = (clip: VehicleClip): number => Math.round(VEHICLE_INTERACTION.durations[clip] * TICK_HZ);
/**
 * A shove drives the car toward the authored travel: its speed along the axis follows the travel's rate plus this
 * gain (1/s) times the remaining error, capped, and changes by at most PUSH_ACCEL m/s² (the smoothstep peaks near
 * 7.3), so a car against a wall or another car is pushed hard but not without limit. The push holds on this long
 * past the window to settle the car on its mark before the brakes come back on.
 */
const PUSH_GAIN = 6, PUSH_MAX_SPEED = 2, PUSH_ACCEL = 12, PUSH_SETTLE = 0.2;
// Both authored death clips collapse in 1.4 s. Keep a small margin before treating their
// still-standing physics proxies as floor-level bodies in the upper doorway query only.
const GROUNDED_DEATH_CLEARANCE_TICKS = Math.ceil(1.5 * TICK_HZ);
const RECOVER_HOLD_TICKS = 45;
const RAM_FORCE_THRESHOLD = 8000;
/** A car meeting someone at this speed (m/s) or more hurts them, by `carHitDamage` health. */
const CAR_HIT_SPEED = 2.5;
const carHitDamage = (speed: number): number => (speed - 2) * 12;
const MAX_LOG = 4000;
const CRIME_DEBOUNCE_TICKS: Partial<Record<Crime, number>> = { fire: 90, shootAtPolice: 150, drawWeapon: 600, ram: 45, ramPolice: 45, takeCar: 120, hitPedestrian: 30 };

export class Simulation {
  readonly world: StaticWorld;
  readonly gameplay: GameplayBundle;
  readonly rng: Rng;
  readonly options: Required<SimOptions>;
  tick = 0;
  readonly player: Character;
  readonly inventory = new Inventory();
  readonly vehicles = new Map<string, Vehicle>();
  /** Non-player characters (officers now, pedestrians from M3). */
  readonly characters = new Map<string, Character>();
  readonly wanted: WantedState;
  readonly police: PoliceForce;
  readonly parkedCars: ParkedCars;
  readonly pedestrians: Pedestrians;
  /** Events raised this tick. */
  events: GameEvent[] = [];
  readonly log: GameEvent[] = [];
  shots: Shot[] = [];
  mode: PlayerMode = 'onFoot';
  modeTicks = 0;
  screen: { kind: 'wasted' | 'busted'; ticks: number; anchor: Anchor } | null = null;
  pitch = 0;
  aiming = false;
  lastFireTick = -100000;
  lastCommand: Command = NEUTRAL;
  recoverTicks = 0;
  private pendingVehicle: Vehicle | null = null;
  private pendingExit: V3 | null = null;
  private entryStage: 'approach' | 'push' | 'shove' | 'enter' = 'approach';
  /** With a person or a body at the driver's door: whom Snow shoves aside and how, how many so far, and where they stood. */
  private shoveAside: VehicleShovePlan | null = null;
  private shoveAsides = 0;
  private shoveFrom: V3 = [0, 0, 0];
  /** With the driver's door blocked: the corner Snow walks to and shoves from, how many shoves so far, and where the car stood when this one began. */
  private pushClip: VehiclePushClip | null = null;
  private pushShoves = 0;
  private pushOrigin: V3 = [0, 0, 0];
  private interactionTicks = 0;
  private approachRoute: V3[] = [];
  private approachWaypoint = 0;
  private exitRequested = false;
  private exitReturning = false;
  private exitClip: VehicleClip = 'exit';
  private entryOffset: [number, number, number] = [0, 0, 0];
  private readonly eventQueue: RAPIER.EventQueue;
  private readonly colliderVehicle = new Map<number, Vehicle>();
  private readonly colliderCharacter = new Map<number, Character>();
  private readonly blocksUpperDoor = (collider: RAPIER.Collider): boolean => {
    const character = this.colliderCharacter.get(collider.handle);
    return !character || character.alive || !character.grounded || character.deathTicks < GROUNDED_DEATH_CLEARANCE_TICKS;
  };
  private readonly livingPerson = (collider: RAPIER.Collider): boolean => !!this.colliderCharacter.get(collider.handle)?.alive;  private readonly ramCooldown = new Map<string, number>();
  private readonly crimeTicks = new Map<Crime, number>();
  /** Taking the same retained car again is not a second theft; retired vehicles remain collectable. */
  private readonly playerTakenVehicles = new WeakSet<Vehicle>();
  private readonly defs = new Map<string, VehicleDefinition>();
  private readonly weaponDefs = new Map<string, WeaponDefinition>();
  private vehicleSerial = 0;
  private characterSerial = 0;
  private jumpWasDown = false;
  private jumpPressed = false;
  /** Steps the player holds still after a drop-in, while Rapier registers the destination's collision. */
  private settleTicks = 0;
  private readonly safeSpawns: SafeSpawns;

  constructor(world: StaticWorld, options: SimOptions) {
    this.world = world;
    this.gameplay = world.gameplay;
    this.options = { seed: options.seed, screenTicks: options.screenTicks ?? 3 * TICK_HZ };
    this.rng = new Rng(options.seed);
    this.eventQueue = new RAPIER.EventQueue(true);
    for (const d of this.gameplay.vehicleDefinitions) this.defs.set(d.id, d);
    for (const w of this.gameplay.weapons) this.weaponDefs.set(w.id, w);
    this.wanted = new WantedState(this.gameplay.wanted);
    // A streamed world inserts the start's collision first (the loader fetched exactly these cells). Live squares
    // wait for the first steps, which block until their bytes arrive; construction never requires them.
    if (world.streamed) world.applyResidency(world.planResidency(initialResidencySources(this.gameplay), Infinity, { live: false }));
    // Rapier's query broadphase is empty until its first step. Prime the static world
    // before validating any spawn and before adding characters or dynamic cars.
    this.world.physics.step();
    this.world.markStepped();
    this.safeSpawns = new SafeSpawns(world);
    const spawn = this.gameplay.player.spawn;
    const start = this.safeSpawns.character(spawn.position[0], spawn.position[1], headingToYaw(spawn.headingDeg));
    this.safeSpawns.rememberInitial(start.position, start.yaw);
    this.player = new Character(world, 'player', start.position, start.yaw, this.gameplay.player.health);
    this.player.armour = this.gameplay.player.armour;
    this.colliderCharacter.set(this.player.collider.handle, this.player);
    this.resetStartingInventory();
    for (const v of this.gameplay.vehicles) this.spawnVehicle(v.id, v.definition, [v.position[0], v.position[1]], headingToYaw(v.headingDeg));
    this.police = new PoliceForce(this);
    this.police.spawnInitial();
    this.parkedCars = new ParkedCars(this);
    this.pedestrians = new Pedestrians(this, this.gameplay.civilianVariants ?? []);
  }

  // ---- entity management ----

  definition(id: string): VehicleDefinition {
    const d = this.defs.get(id);
    if (!d) throw new Error(`unknown vehicle definition ${id}`);
    return d;
  }

  weapon(id: string): WeaponDefinition {
    const w = this.weaponDefs.get(id);
    if (!w) throw new Error(`unknown weapon ${id}`);
    return w;
  }

  private resetStartingInventory(): void {
    this.inventory.stripAll();
    for (const w of this.gameplay.playerStart.weapons) this.inventory.add(this.weapon(w.id), w.reserve);
    this.inventory.select(-1);
    this.lastFireTick = -100000;
  }

  /** Ground point (feet height) at XZ from the collision world, falling back to the terrain grid. */
  groundPoint(x: number, z: number): V3 {
    const originY=this.world.groundHeight(x,z)+30,central=this.world.groundBelow(x,originY,z,80);
    const probe=supportedSpawnGround(central,x,z,(px,pz)=>this.world.spawnGroundBelow(px,originY,pz,80));
    return [x, probe ? probe.y : this.world.groundHeight(x, z), z];
  }

  spawnVehicle(id: string | null, definitionId: string, xz: [number, number], yaw: number): Vehicle {
    const def = this.definition(definitionId);
    const vid = id ?? `veh-${++this.vehicleSerial}`;
    const safe = !this.gameplay.supportedArea && this.safeSpawns.contains(xz[0], xz[1]) ? null : this.safeSpawns.vehicle(xz[0], xz[1], yaw, def);
    const g = safe?.position ?? this.groundPoint(xz[0], xz[1]);
    yaw = safe?.yaw ?? yaw;
    return this.createVehicle(vid, def, g, yaw);
  }

  /** A new local actor must have complete, clear ground here; never recover it back to Senate Square. */
  trySpawnVehicle(id: string, definitionId: string, xz: [number, number], yaw: number, expectedY: number): Vehicle | null {
    const def = this.definition(definitionId);
    const placement = this.safeSpawns.tryVehicle(xz[0], xz[1], yaw, def, expectedY);
    return placement ? this.createVehicle(id, def, placement.position, placement.yaw) : null;
  }

  private createVehicle(vid: string, def: VehicleDefinition, g: V3, yaw: number): Vehicle {
    const v = new Vehicle(this.world, vid, def, [g[0], g[1] + 0.25, g[2]], yaw);
    this.vehicles.set(vid, v);
    this.colliderVehicle.set(v.collider.handle, v);
    if (v.skidCollider) this.colliderVehicle.set(v.skidCollider.handle, v);
    return v;
  }

  /** Retiring an NPC must not retire the player's car or invalidate an entry in progress. */
  removeVehicle(v: Vehicle): boolean {
    if (this.vehicles.get(v.id) !== v || this.player.inVehicle === v.id || this.pendingVehicle === v) return false;
    this.vehicles.delete(v.id);
    this.colliderVehicle.delete(v.collider.handle);
    if (v.skidCollider) this.colliderVehicle.delete(v.skidCollider.handle);
    this.world.physics.removeVehicleController(v.controller);
    this.world.physics.removeRigidBody(v.body);
    return true;
  }

  spawnCharacter(id: string | null, position: V3, yaw: number, health: number): Character {
    const cid = id ?? `npc-${++this.characterSerial}`;
    const c = new Character(this.world, cid, position, yaw, health);
    this.characters.set(cid, c);
    this.colliderCharacter.set(c.collider.handle, c);
    return c;
  }

  removeCharacter(c: Character): void {
    this.characters.delete(c.id);
    this.colliderCharacter.delete(c.collider.handle);
    this.world.physics.removeCharacterController(c.controller);
    this.world.physics.removeRigidBody(c.body);
  }

  vehicleOf(handle: number): Vehicle | null { return this.colliderVehicle.get(handle) ?? null; }
  characterOf(handle: number): Character | null { return this.colliderCharacter.get(handle) ?? null; }

  get playerVehicle(): Vehicle | null {
    return this.player.inVehicle ? this.vehicles.get(this.player.inVehicle) ?? null : null;
  }

  /** The player's position for the police (car position while driving). */
  get playerPosition(): V3 {
    const v = this.playerVehicle;
    return v ? v.position : this.player.centre;
  }

  /** Direction of travel on the ground (unit XZ): the car's motion while it moves, otherwise the way the car or Snow faces. */
  get playerHeading(): [number, number] {
    const v = this.playerVehicle;
    const [x, z] = !v ? [Math.sin(this.player.yaw), Math.cos(this.player.yaw)]
      : Math.hypot(v.velocity[0], v.velocity[2]) > 1 ? [v.velocity[0], v.velocity[2]] : [v.forward[0], v.forward[2]];
    const length = Math.hypot(x!, z!);
    return length > 1e-6 ? [x! / length, z! / length] : [0, 1];
  }

  get playerSpeed(): number {
    const v = this.playerVehicle;
    return v ? v.speed : this.player.speed;
  }

  /** Return fire requires a real discharge this encounter. Drawing or aiming is never enough. */
  get policeMayFire(): boolean {
    return this.player.alive && this.mode === 'onFoot' && this.inventory.current >= 0 && this.wanted.playerHasFired;
  }

  emit(type: string, detail?: string, value?: number): void {
    const e: GameEvent = detail === undefined ? { tick: this.tick, type } : value === undefined ? { tick: this.tick, type, detail } : { tick: this.tick, type, detail, value };
    this.events.push(e);
  }

  /** Report a crime: witnessed crimes land immediately, the rest after a civilian report delay. Repeats of the
   *  same crime within its debounce window are ignored so a magazine emptied at a patrol car is one report. */
  crime(crime: Crime, witnessed = this.police.playerSeen): void {
    const window = CRIME_DEBOUNCE_TICKS[crime] ?? 0;
    const last = this.crimeTicks.get(crime) ?? -100000;
    if (this.tick - last < window) return;
    this.crimeTicks.set(crime, this.tick);
    const [lo, hi] = this.gameplay.wanted.witnessReportSeconds;
    this.wanted.report(crime, this.tick, witnessed, Math.round(this.rng.range(lo, hi) * TICK_HZ), this.events, this.playerPosition, this.playerHeading);
  }

  // ---- main loop ----

  /** Collision cells the next step inserts and removes (streamed worlds); a caller must have the inserted cells' bytes. */
  residencyPlan(): ResidencyPlan {
    return this.world.planResidency(this.collisionSources());
  }

  /** Residency sources: the player (and, during Wasted / Busted, the respawn anchor), every car and officer on foot. */
  collisionSources(): ResidencySource[] {
    const p = this.playerPosition;
    const sources = [source(p[0], p[2], RESIDENCY.player)];
    if (this.screen) sources.push(source(this.screen.anchor.position[0], this.screen.anchor.position[1], RESIDENCY.player));
    for (const v of this.vehicles.values()) sources.push(source(v.position[0], v.position[2], RESIDENCY.actor));
    for (const c of this.characters.values()) if (!c.inVehicle) sources.push(source(c.position[0], c.position[2], RESIDENCY.actor));
    return sources;
  }

  /**
   * Out-of-band relocation of the player on foot (the drop-in menu, not a command, so not replayable). A streamed
   * world inserts the destination's collision now; the player then holds still for one step while Rapier registers it.
   */
  dropIn(position: V3, yaw: number): void {
    if (!position.every(Number.isFinite) || !Number.isFinite(yaw)) throw new Error('Drop-in coordinates must be finite');
    if (this.world.streamed) {
      this.world.applyResidency(this.dropInPlan(position[0], position[2]));
      this.settleTicks = 1;
    }
    this.player.teleport(position, yaw);
  }

  /** Every cell a drop-in at XZ inserts at once, including the rings ahead of need; live squares follow with the next steps. */
  dropInPlan(x: number, z: number): ResidencyPlan {
    return this.world.planResidency([source(x, z, RESIDENCY.player), ...this.collisionSources()], Infinity, { live: false });
  }

  step(command: Command): GameEvent[] {
    this.tick++;
    this.events = [];
    this.shots = [];
    this.lastCommand = command;
    if (this.world.streamed) this.world.applyResidency(this.residencyPlan());
    this.jumpPressed = has(command.buttons, Button.jump) && !this.jumpWasDown;
    this.jumpWasDown = has(command.buttons, Button.jump);
    this.inventory.step();
    if (this.inventory.current < 0) this.wanted.clearPlayerFire();
    this.modeTicks++;

    switch (this.mode) {
      case 'onFoot': this.stepOnFoot(command); break;
      case 'entering': this.stepEntering(); break;
      case 'driving': this.stepDriving(command); break;
      case 'exiting': this.stepExiting(command); break;
      case 'wasted': case 'busted': this.stepScreen(); break;
    }

    this.police.step();
    this.parkedCars.step();
    this.pedestrians.step();
    // After their own AI: whoever Snow is shoving aside goes where he sends them.
    if (this.entryStage === 'shove' && this.shoveAside) this.carryShoved();
    // A former police unit may still reference a reserved car. Entry/exit owns its controls.
    if (this.pendingVehicle) this.holdPendingVehicle(this.pendingVehicle);
    if (this.mode === 'exiting' && this.playerVehicle) this.brakeVehicle(this.playerVehicle);

    const filter = (): boolean => true;
    for (const v of this.vehicles.values()) v.step(this.world, filter);
    for (const c of this.characters.values()) if (!c.inVehicle && (c.alive || !c.grounded)) c.move(this.world, c.alive ? c.desiredVx : 0, c.alive ? c.desiredVz : 0);

    this.world.physics.step(this.eventQueue);
    this.world.markStepped();
    this.drainContacts();

    if (this.playerVehicle) this.followVehicle();
    for (const c of this.characters.values()) if (!c.alive) c.deathTicks++;
    this.layBodies();

    this.wanted.step(this.tick, this.police.playerSeen, this.playerPosition, this.events, this.playerHeading);
    this.police.afterPhysics();
    this.checkArrest();
    this.checkKillPlane();
    if (this.player.alive && this.player.health <= 0) this.player.alive = false;
    if (!this.player.alive && this.mode !== 'wasted') this.wasted();

    this.updatePlayerClip();
    for (const e of this.events) { this.log.push(e); if (this.log.length > MAX_LOG) this.log.shift(); }
    return this.events;
  }

  private stepOnFoot(command: Command): void {
    const p = this.player;
    if (!p.alive) return;
    const yaw = command.yaw;
    this.pitch = clamp(command.pitch, -1.2, 1.2);
    const holstering = has(command.buttons, Button.holster);
    if (holstering) {
      this.inventory.select(-1);
      this.wanted.clearPlayerFire();
      this.lastFireTick = -100000;
      this.emit('holster');
    }
    // Both hands are on the ledge while climbing: no aiming, firing, reloading or steering.
    const climbing = p.jumpPhase === 'climb';
    const aiming = !holstering && !climbing && has(command.buttons, Button.aim) && this.inventory.current >= 0;
    if (aiming && !this.aiming) { this.emit('aim'); if (this.police.playerSeen) this.crime('drawWeapon', true); }
    this.aiming = aiming;
    // Holster wins simultaneous inputs; a later aim/fire command may draw the weapon again.
    if (!holstering && (has(command.buttons, Button.fire) || has(command.buttons, Button.aim)) && this.inventory.current < 0 && this.inventory.slots.length) this.inventory.select(0);
    // Movement relative to the camera yaw.
    const mag = Math.min(1, Math.hypot(command.moveX, command.moveZ));
    let vx = 0, vz = 0;
    if (mag > 0.05 && !climbing) {
      const sin = Math.sin(yaw), cos = Math.cos(yaw);
      // Three.js camera right is forward cross up. For a +Z view it points toward -X.
      const fx = sin, fz = cos, rx = -cos, rz = sin;
      const dx = fx * command.moveZ + rx * command.moveX, dz = fz * command.moveZ + rz * command.moveX;
      const dl = Math.hypot(dx, dz) || 1;
      const speed = this.aiming ? CHARACTER.aimWalk : has(command.buttons, Button.sprint) ? CHARACTER.sprint : mag < 0.5 ? CHARACTER.walk : CHARACTER.run;
      vx = dx / dl * speed; vz = dz / dl * speed;
      if (!this.aiming) p.turnToward(Math.atan2(dx, dz), 14);
    }
    if (this.aiming) p.turnToward(yaw, 20);
    if (this.jumpPressed) {
      const jump = p.requestJump();
      if (jump) this.emit(jump === 'super' ? 'superJump' : 'jump');
    }
    const settling = this.settleTicks > 0;
    if (settling) this.settleTicks--;
    else p.move(this.world, vx, vz);
    if (!settling && !climbing && (vx !== 0 || vz !== 0) && p.tryGrabLedge(this.world, vx, vz)) this.emit('climb');
    // Reload / fire.
    const handsFree = !holstering && p.jumpPhase !== 'climb';
    if (handsFree && has(command.buttons, Button.reload)) this.inventory.startReload();
    if (handsFree && has(command.buttons, Button.fire)) this.playerFire(yaw, this.pitch);
    // Enter a vehicle.
    if (has(command.buttons, Button.interact) && this.modeTicks > 10 && p.grounded && p.jumpPhase !== 'takeoff') {
      const v = this.nearestEnterableVehicle();
      if (v) this.beginEnter(v);
    }
    this.stepRecover(command, () => {
      this.recoverPlayer();
    });
  }

  private nearestEnterableVehicle(): Vehicle | null {
    let best: Vehicle | null = null, bestD = Infinity;
    for (const v of this.vehicles.values()) {
      if (v.driver || v.damage === 'wrecked' || v.up[1] < 0.9 || v.speed > VEHICLE_INTERACTION.stoppedSpeed) continue;
      const d = distanceXZ(v.position, this.player.position);
      if (d <= v.def.seat.entryRadius + 1.2 && d < bestD) { best = v; bestD = d; }
    }
    return best;
  }

  private beginEnter(v: Vehicle): void {
    this.player.resetJump();
    this.mode = 'entering';
    this.modeTicks = 0;
    this.pendingVehicle = v;
    this.entryStage = 'approach';
    this.pushClip = null;
    this.pushShoves = 0;
    this.shoveAside = null;
    this.shoveAsides = 0;
    this.interactionTicks = 0;
    this.approachRoute = vehicleApproachRoute(v, this.player.position);
    this.approachWaypoint = 0;
    // A blocked door sends him behind whoever is in the way, or to a corner, at once rather than into whatever lies
    // at it; from the far side it is planned again on the last leg.
    if (!vehicleDoorClearance(this.world, v, this.player, this.blocksUpperDoor)) this.planClearDoor(v);
    this.exitRequested = false;
    this.exitReturning = false;
    this.aiming = false;
    // Reserve the seat so the police do not take the same car.
    v.driver = 'player';
    this.brakeVehicle(v);
    this.emit('enterVehicle', v.id);
  }

  private stepEntering(): void {
    const v = this.pendingVehicle;
    if (!v || this.vehicles.get(v.id) !== v || v.damage === 'wrecked' || v.up[1] < 0.9) {
      this.abortVehicleEntry(); return;
    }
    this.holdPendingVehicle(v);
    const p = this.player;
    if (this.entryStage === 'approach') {
      if (this.modeTicks > VEHICLE_INTERACTION.approachTimeout * TICK_HZ) { this.abortVehicleEntry(); return; }
      const local = this.approachRoute[this.approachWaypoint] ?? vehicleInteractionOf(v).stage as V3;
      const target = v.localToWorld(local), d = distanceXZ(target, p.position);
      if (d > VEHICLE_INTERACTION.arrivalRadius) {
        const dir = normalize([target[0] - p.position[0], 0, target[2] - p.position[2]]);
        p.turnToward(Math.atan2(dir[0], dir[2]), 8);
        // Cap the last step so approaching a narrow staging point cannot oscillate around it.
        const speed = Math.min(CHARACTER.walk, d * TICK_HZ);
        p.move(this.world, dir[0] * speed, dir[2] * speed);
        return;
      }
      if (this.approachWaypoint < this.approachRoute.length - 1) {
        this.approachWaypoint++;
        p.move(this.world, 0, 0);
        // On the last leg, a blocked door sends him on now rather than into whatever lies at it; with no way to clear
        // it he gives up at once instead of standing pressed against it until the approach times out.
        if (!this.pushClip && !this.shoveAside && this.approachWaypoint === this.approachRoute.length - 1 && !vehicleDoorClearance(this.world, v, p, this.blocksUpperDoor) && !this.planClearDoor(v)) this.abortVehicleEntry();
        return;
      }
      // At the door he turns slightly toward it; at a corner to push from, square to the car's end; behind someone
      // to shove, the way they will go.
      const entryYaw = this.shoveAside ? this.shoveAside.yaw : this.pushClip ? vehiclePushYaw(v, this.pushClip) : v.yaw + VEHICLE_INTERACTION.entryYaw;
      p.turnToward(entryYaw, 8);
      p.move(this.world, 0, 0);
      if (Math.abs(wrapAngle(p.yaw - entryYaw)) > VEHICLE_INTERACTION.arrivalYaw || !p.grounded || v.speed > VEHICLE_INTERACTION.stoppedSpeed) return;
      if (this.shoveAside) { this.arriveShoveAside(v); return; }
      if (this.pushClip) {
        const stand = vehiclePushClearance(this.world, v, p, this.pushClip);
        if (!stand) { this.abortVehicleEntry(); return; }
        this.pose(v, stand, entryYaw);
        this.beginShove(v);
        this.pushShoves = 1;
        return;
      }
      const stage = vehicleDoorClearance(this.world, v, p, this.blocksUpperDoor);
      if (!stage) {
        if (!this.planClearDoor(v)) this.abortVehicleEntry();
        return;
      }
      this.pose(v, stage, entryYaw);
      this.entryStage = 'enter';
      this.interactionTicks = 0;
      return;
    }
    if ((this.entryStage === 'push' || this.entryStage === 'shove') && this.struckWhilePosed(v)) return;
    if (this.entryStage === 'push') { this.stepShove(v); return; }
    if (this.entryStage === 'shove') { this.stepShoveAside(v); return; }
    if (v.speed > 0.8 || !vehicleDoorClearance(this.world, v, p, this.blocksUpperDoor)) { this.abortVehicleEntry(); return; }
    this.interactionTicks++;
    p.speed = 0;
    p.hide();
    if (this.interactionTicks >= vehicleClipTicks('enter')) {
      this.player.inVehicle = v.id;
      this.player.hide();
      v.occupants.add('player');
      this.mode = 'driving';
      this.modeTicks = 0;
      this.pendingVehicle = null;
      this.followVehicle();
      // A reservation or interrupted approach is not a completed theft. The owner reports an unseen
      // civilian theft after the normal 3–6 second delay, including the first car of a new game.
      if (!this.playerTakenVehicles.has(v)) {
        this.playerTakenVehicles.add(v);
        this.crime('takeCar', v.def.role === 'patrol' || this.police.playerSeen);
      }
    }
  }

  /**
   * Put the hidden capsule on a clip's authored start, keeping the walk-up's error for the renderer to blend out, in
   * the clip's frame: the car's, or Snow's own heading for a shove aside.
   */
  private pose(v: Vehicle, feet: V3, yaw: number, frameYaw = v.yaw): void {
    const p = this.player, dx = p.position[0] - feet[0], dz = p.position[2] - feet[2];
    this.entryOffset = [dx * Math.cos(frameYaw) - dz * Math.sin(frameYaw), dx * Math.sin(frameYaw) + dz * Math.cos(frameYaw), wrapAngle(p.yaw - yaw)];
    p.position = feet;
    p.yaw = yaw;
    p.speed = 0;
    p.hide();
  }

  /**
   * The door is blocked: shove aside the person or body in the way (no crime, an officer included), or else shove
   * the car clear of whatever it is.
   */
  private planClearDoor(v: Vehicle): boolean {
    const plan = this.shoveAsides < VEHICLE_INTERACTION.shove.shoves ? vehicleShovePlan(this.world, v, this.player, this.blocksUpperDoor, collider => this.characterOf(collider.handle)) : null;
    this.shoveAside = plan;
    if (!plan) return this.planShove(v);
    this.pushClip = null;
    this.approachRoute = plan.route;
    this.approachWaypoint = 0;
    this.modeTicks = 0;
    return true;
  }

  /** Behind whoever he is to shove: shove them, plan again if they have moved, or go to the door if it is clear now. */
  private arriveShoveAside(v: Vehicle): void {
    const p = this.player, planned = this.shoveAside!;
    if (vehicleDoorClearance(this.world, v, p, this.blocksUpperDoor)) { this.walkToDoor(v); return; }
    // Someone walking about must not keep him re-planning past the approach timeout.
    const ticks = this.modeTicks, planOk = this.planClearDoor(v);
    this.modeTicks = ticks;
    if (!planOk) { this.abortVehicleEntry(); return; }
    const plan = this.shoveAside as VehicleShovePlan | null;
    if (!plan || plan.target !== planned.target || distanceXZ(plan.stand, p.position) > 0.35) return;
    this.pose(v, plan.stand, plan.yaw, plan.yaw);
    this.entryStage = 'shove';
    this.interactionTicks = 0;
    this.shoveAsides++;
    this.shoveFrom = plan.target.position;
    this.emit('shoveAside', plan.target.id);
  }

  /**
   * One shove aside. The clip's frame is Snow's own: his hidden capsule moves with his hands (the clip ends a stride
   * on), while whoever he shoves is carried along by `carryShoved`. Then he goes to the door if it is clear, shoves
   * the next one, or shoves the car.
   */
  private stepShoveAside(v: Vehicle): void {
    const p = this.player, { clip, stand, direction: d, yaw } = this.shoveAside!;
    this.interactionTicks++;
    const travel = vehicleShoveTravel(clip, this.interactionTicks * TICK_SECONDS);
    p.position = [stand[0] + d[0] * travel, stand[1], stand[2] + d[2] * travel];
    p.yaw = yaw;
    p.speed = 0;
    p.hide();
    if (this.interactionTicks < vehicleClipTicks(clip)) return;
    p.teleport(p.position, yaw);
    // Their own legs again: nothing of the shove's velocity carries on.
    const { target } = this.shoveAside!;
    if (target.alive) { target.desiredVx = 0; target.desiredVz = 0; }
    this.shoveAside = null;
    this.entryOffset = [0, 0, 0];
    if (vehicleDoorClearance(this.world, v, p, this.blocksUpperDoor)) { this.walkToDoor(v); return; }
    this.entryStage = 'approach';
    this.interactionTicks = 0;
    if (!this.planClearDoor(v)) this.abortVehicleEntry();
  }

  /** Whoever Snow shoves goes where his hands and then their own stagger take them; someone living reels meanwhile. */
  private carryShoved(): void {
    const { clip, target: c, direction: d } = this.shoveAside!, { window: [, to], tail } = VEHICLE_INTERACTION.shove[clip];
    const seconds = this.interactionTicks * TICK_SECONDS;
    if (this.characters.get(c.id) !== c || c.inVehicle || seconds > to + tail + TICK_SECONDS) return;
    const travel = vehicleShoveTargetTravel(clip, seconds), from = this.shoveFrom;
    const vx = clamp((from[0] + d[0] * travel - c.position[0]) * TICK_HZ, -4, 4), vz = clamp((from[2] + d[2] * travel - c.position[2]) * TICK_HZ, -4, 4);
    if (c.alive) {
      c.desiredVx = vx; c.desiredVz = vz;
      c.hitTicks = Math.max(c.hitTicks, 2);
      if (c.clip !== 'hit') { c.clip = 'hit'; c.clipTicks = 0; }
    } else if (c.grounded) c.move(this.world, vx, vz);
  }

  /** On to the door from wherever he is now. */
  private walkToDoor(v: Vehicle): void {
    this.entryStage = 'approach';
    this.shoveAside = null;
    this.pushClip = null;
    this.interactionTicks = 0;
    this.entryOffset = [0, 0, 0];
    this.approachRoute = vehicleApproachRoute(v, this.player.position);
    this.approachWaypoint = 0;
    this.modeTicks = 0;
  }

  /** Something other than a person blocks the door: walk round to a corner and shove the car clear of it. */
  private planShove(v: Vehicle): boolean {
    const plan = vehiclePushPlan(this.world, v, this.player, this.blocksUpperDoor, this.livingPerson);
    if (!plan) return false;
    this.pushClip = plan.clip;
    this.approachRoute = plan.route;
    this.approachWaypoint = 0;
    this.modeTicks = 0;
    return true;
  }

  private beginShove(v: Vehicle): void {
    this.entryStage = 'push';
    this.interactionTicks = 0;
    this.pushOrigin = v.position;
    this.emit('vehiclePush', v.id);
  }

  /** Whether a shove is moving the car now, with its brakes off. */
  private get shoving(): boolean {
    if (this.entryStage !== 'push') return false;
    const seconds = this.interactionTicks * TICK_SECONDS, [from, to] = VEHICLE_INTERACTION.push.window;
    return seconds > from && seconds <= to + PUSH_SETTLE;
  }

  /** The car Snow is getting into stays braked, except while a shove moves it. */
  private holdPendingVehicle(v: Vehicle): void {
    if (!this.shoving) { this.brakeVehicle(v); return; }
    v.input.throttle = 0; v.input.steer = 0; v.input.brake = 0; v.input.handbrake = false;
  }

  /**
   * One shove. Snow rides the car's frame at his corner while the clip plays, and over the push window the car is
   * driven along its axis toward the authored travel. Then he steps back into the world and walks to the door if it
   * is clear now, shoves again, or gives up after the last shove.
   */
  private stepShove(v: Vehicle): void {
    const p = this.player, clip = this.pushClip!;
    this.interactionTicks++;
    if (this.shoving) {
      const seconds = this.interactionTicks * TICK_SECONDS, dir = rotate(v.rotation, [0, 0, vehiclePushDirection(clip)]);
      const target = vehiclePushTravel(seconds), rate = (vehiclePushTravel(seconds + TICK_SECONDS) - target) * TICK_HZ;
      const speed = clamp(rate + PUSH_GAIN * (target - dot(sub(v.position, this.pushOrigin), dir)), 0, PUSH_MAX_SPEED);
      const impulse = v.body.mass() * clamp(speed - dot(v.velocity, dir), -PUSH_ACCEL * TICK_SECONDS, PUSH_ACCEL * TICK_SECONDS);
      v.body.applyImpulse({ x: dir[0] * impulse, y: dir[1] * impulse, z: dir[2] * impulse }, true);
    }
    const stand = v.localToWorld(vehiclePushStage(v, clip));
    p.position = stand;
    p.yaw = vehiclePushYaw(v, clip);
    p.speed = 0;
    p.hide();
    // Rammed or rolling away: stop pushing.
    if (v.speed > PUSH_MAX_SPEED + 1) { this.abortVehicleEntry(); return; }
    if (this.interactionTicks < vehicleClipTicks(clip)) return;
    if (vehicleDoorClearance(this.world, v, p, this.blocksUpperDoor)) {
      // The clip ends standing at the corner: step back into the world there and walk to the door.
      const feet = vehiclePushClearance(this.world, v, p, clip);
      const safe = feet ? { position: feet, yaw: p.yaw } : this.safeSpawns.nearbyCharacter(stand[0], stand[2], p.yaw, p.body);
      p.teleport(safe.position, safe.yaw);
      this.entryStage = 'approach';
      this.approachRoute = (feet && vehicleReturnRoute(this.world, v, p)) || vehicleApproachRoute(v, p.position);
      this.pushClip = null;
      this.interactionTicks = 0;
      this.entryOffset = [0, 0, 0];
      this.approachWaypoint = 0;
      this.modeTicks = 0;
      return;
    }
    if (this.pushShoves >= VEHICLE_INTERACTION.push.shoves) { this.abortVehicleEntry(); return; }
    // Each shove ends in the pose the next begins with.
    this.pushShoves++;
    this.entryOffset = [0, 0, 0];
    this.beginShove(v);
  }

  /**
   * A push or shove hides Snow's capsule, so a car reaching the place he is shown in strikes him here as a contact
   * would (`drainContacts`): he takes the hit, lets go and is put back on clear ground.
   */
  private struckWhilePosed(v: Vehicle): boolean {
    const p = this.player, striker = vehicleAtPose(this.world, v, p.position, collider => this.colliderVehicle.get(collider.handle) ?? null);
    if (!striker || striker.speed < CAR_HIT_SPEED) return false;
    const key = `character:${striker.id}|${p.id}`;
    if (!this.ramCooldown.has(key)) {
      this.ramCooldown.set(key, this.tick);
      p.takeDamage(carHitDamage(striker.speed));
    }
    this.cancelVehicleEntry();
    this.mode = 'onFoot';
    this.modeTicks = 0;
    return true;
  }

  private cancelVehicleEntry(): void {
    // Once posing starts the capsule is hidden. Every interruption must restore supported collision.
    if (this.pendingVehicle && this.entryStage !== 'approach') {
      const safe = this.safeSpawns.nearbyCharacter(this.player.position[0], this.player.position[2], this.player.yaw, this.player.body);
      this.player.teleport(safe.position, safe.yaw);
    }
    if (this.pendingVehicle?.driver === 'player') this.pendingVehicle.driver = null;
    this.pendingVehicle = null;
    this.entryStage = 'approach';
    this.pushClip = null;
    this.pushShoves = 0;
    this.shoveAside = null;
    this.shoveAsides = 0;
    this.interactionTicks = 0;
    this.approachRoute = [];
    this.approachWaypoint = 0;
    this.exitRequested = false;
    this.exitReturning = false;
    this.entryOffset = [0, 0, 0];
  }

  private abortVehicleEntry(): void {
    const id = this.pendingVehicle?.id;
    this.cancelVehicleEntry();
    this.mode = 'onFoot';
    this.modeTicks = 0;
    this.emit('vehicleEntryBlocked', id);
  }

  private brakeVehicle(v: Vehicle): void {
    v.input.throttle = 0; v.input.steer = 0; v.input.brake = 1; v.input.handbrake = true;
  }

  private stepDriving(command: Command): void {
    const v = this.playerVehicle;
    if (!v) { this.mode = 'onFoot'; return; }
    this.pitch = clamp(command.pitch, -1.2, 1.2);
    v.input.throttle = clamp(command.moveZ, -1, 1);
    v.input.steer = clamp(-command.moveX, -1, 1);
    v.input.brake = 0;
    v.input.handbrake = has(command.buttons, Button.handbrake);
    if (has(command.buttons, Button.horn) && v.hornTicks === 0) { v.hornTicks = 20; this.emit('horn', v.id); }
    if (has(command.buttons, Button.interact) && this.modeTicks > 10) this.exitRequested = true;
    if (this.exitRequested) {
      this.brakeVehicle(v);
      if (v.speed <= VEHICLE_INTERACTION.stoppedSpeed) this.beginExit(v);
    }
    this.stepRecover(command, () => this.recoverVehicle(v));
  }

  private beginExit(v: Vehicle): void {
    this.exitRequested = false;
    this.exitReturning = false;
    this.pendingExit = null;
    // The driver's door first. When it is boxed in, Snow climbs across and leaves by the passenger door; with both
    // doors blocked he kicks out the windshield. On a car lying on its roof he crawls out of either door.
    for (const clip of vehicleExitClips(vehiclePosture(v))) {
      this.pendingExit = vehicleExitClearance(this.world, v, this.player, this.blocksUpperDoor, clip);
      this.exitClip = clip;
      if (this.pendingExit) break;
    }
    if (!this.pendingExit) { this.squeezeOut(v); return; }
    this.mode = 'exiting';
    this.modeTicks = 0;
    this.interactionTicks = 0;
    this.brakeVehicle(v);
    this.emit('exitVehicle', v.id);
  }

  private stepExiting(command: Command): void {
    const v = this.playerVehicle;
    if (!v) { this.mode = 'onFoot'; return; }
    this.stepRecover(command, () => this.recoverVehicle(v));
    if (this.mode !== 'exiting') return;
    this.brakeVehicle(v);
    // If the car is hit, rolls over or the way out becomes blocked, unwind the exit into the seat.
    // The hidden capsule never materialises inside the new obstruction.
    const posture = this.exitClip === 'exitFlipped' || this.exitClip === 'exitFlippedPassenger' ? 'flipped' : 'upright';
    const feet = vehiclePosture(v) === posture && v.speed <= VEHICLE_INTERACTION.stoppedSpeed ? vehicleExitClearance(this.world, v, this.player, this.blocksUpperDoor, this.exitClip) : null;
    if (!feet) this.exitReturning = true;
    if (this.exitReturning) {
      this.interactionTicks = Math.max(0, this.interactionTicks - 1);
      if (this.interactionTicks === 0) {
        this.mode = 'driving'; this.modeTicks = 0; this.pendingExit = null; this.exitReturning = false;
        this.emit('vehicleExitBlocked', v.id);
      }
      return;
    }
    if (!feet) return;
    this.pendingExit = feet;
    this.interactionTicks++;
    // The glass stays broken if the exit is interrupted afterwards.
    if (this.exitClip === 'exitWindshield' && !v.windshieldBroken && this.interactionTicks >= Math.round(VEHICLE_INTERACTION.windshieldBreak * vehicleClipTicks('exitWindshield'))) {
      v.windshieldBroken = true;
      this.emit('windshieldBreak', v.id);
    }
    if (this.interactionTicks >= vehicleClipTicks(this.exitClip)) {
      this.leaveVehicle(v);
      // Each clip ends with Snow standing where its authored last frame puts him.
      this.player.teleport(feet, vehicleExitYaw(v, this.exitClip));
    }
  }

  private leaveVehicle(v: Vehicle): void {
    v.driver = null;
    v.occupants.delete('player');
    v.input.handbrake = true;
    this.player.inVehicle = null;
    this.mode = 'onFoot';
    this.modeTicks = 0;
    this.pendingExit = null;
    this.interactionTicks = 0;
  }

  /**
   * Last resort when no authored way out is clear, or the car lies on its side: Snow is put on the nearest clear
   * ground. There is no clip for it, so he appears there.
   */
  private squeezeOut(v: Vehicle): void {
    const safe = this.safeSpawns.nearbyCharacter(v.position[0], v.position[2], v.yaw);
    this.leaveVehicle(v);
    this.player.teleport(safe.position, safe.yaw);
    this.emit('vehicleExitSqueezed', v.id);
  }

  private followVehicle(): void {
    const v = this.playerVehicle!;
    const seat = v.localToWorld(v.def.seat.driver);
    this.player.position = [seat[0], seat[1] - 0.45, seat[2]];
    this.player.yaw = v.yaw;
    this.player.speed = v.speed;
    this.player.hide();
  }

  private stepRecover(command: Command, action: () => void): void {
    if (has(command.buttons, Button.recover)) {
      this.recoverTicks++;
      if (this.recoverTicks === RECOVER_HOLD_TICKS) { action(); this.emit('recover'); }
    } else this.recoverTicks = 0;
  }

  recoverVehicle(v: Vehicle): void {
    if (this.pendingVehicle === v) this.abortVehicleEntry();
    if (this.playerVehicle === v && this.mode === 'exiting') { this.mode = 'driving'; this.modeTicks = 0; this.interactionTicks = 0; this.pendingExit = null; this.exitReturning = false; }
    this.exitRequested = false;
    const safe = this.safeSpawns.vehicle(v.position[0], v.position[2], v.yaw, v.def, v.body, true);
    const g = safe.position;
    v.place([g[0], g[1] + 0.3, g[2]], safe.yaw);
    v.input.throttle = 0; v.input.steer = 0; v.input.brake = 1; v.input.handbrake = true;
    if (this.playerVehicle === v) this.followVehicle();
  }

  private recoverPlayer(): void {
    const p = this.player;
    const safe = this.safeSpawns.character(p.position[0], p.position[2], p.yaw, p.body, true);
    this.cancelVehicleEntry();
    if (this.mode === 'entering' || this.mode === 'exiting') { this.mode = 'onFoot'; this.modeTicks = 0; }
    this.pendingExit = null;
    p.teleport(safe.position, safe.yaw);
  }

  private playerFire(yaw: number, pitch: number): void {
    const w = this.inventory.weapon;
    if (!w || w.cooldownTicks > 0 || w.reloadTicks > 0) return;
    if (w.magazine <= 0) { this.inventory.startReload(); return; }
    w.magazine--;
    w.cooldownTicks = Math.max(1, Math.round(TICK_HZ * 60 / w.def.roundsPerMinute));
    this.lastFireTick = this.tick;
    this.wanted.recordPlayerShot();
    const cp = Math.cos(pitch);
    const origin = this.player.eye;
    const dir = resolveAimDirection(this.world, origin, [Math.sin(yaw) * cp, Math.sin(pitch), Math.cos(yaw) * cp], this.lastCommand.aimRay, w.def.rangeMeters, this.player.body);
    const shot = fireRay(this.world, this.rng, origin, dir, w.def, this.player.body, (handle, point) => this.isHeadshot(handle, point));
    this.resolveShot('player', shot, w.def);
    this.emit('fire', w.def.id);
    const witnessed = this.police.playerSeen;
    this.crime('fire', witnessed);
  }

  isHeadshot(handle: number, point: V3): boolean {
    const c = this.colliderCharacter.get(handle);
    return !!c && point[1] > c.position[1] + CHARACTER.height - 0.3;
  }

  /** Apply a shot's damage and record it for the renderer; returns what was hit. */
  resolveShot(shooter: string, shot: ShotResult, def: WeaponDefinition): Shot {
    let hit: Shot['hit'] = null, hitId: string | null = null;
    if (shot.colliderHandle !== null) {
      const c = this.colliderCharacter.get(shot.colliderHandle);
      const v = this.colliderVehicle.get(shot.colliderHandle);
      if (c) {
        hit = 'character'; hitId = c.id;
        const wasAlive = c.alive;
        const dmg = CIVILIAN_BULLETS_LETHAL && civilianVariant(c.id) !== null ? c.health
          : def.damage * (shot.headshot ? def.headshotMultiplier : 1) * (shooter === 'player' ? 1 : 0.55);
        c.takeDamage(dmg);
        if (shooter === 'player') {
          const officer = this.police.unitOfOfficer(c.id);
          if (officer) this.crime('shootAtPolice', true);
          else if (wasAlive && c !== this.player) this.crime('hitPedestrian');
          if (wasAlive && !c.alive) { this.emit('kill', c.id); this.crime(officer ? 'killOfficer' : 'kill', !!officer || this.police.playerSeen); }
        }
      } else if (v) {
        hit = 'vehicle'; hitId = v.id;
        v.applyDamage(def.damage * 1.5);
        if (shooter === 'player' && v.def.role === 'patrol') this.crime('shootAtPolice', true);
      } else hit = 'static';
    }
    if (shooter === 'player' && hit !== 'character' && hit !== 'vehicle') {
      // Near misses count as shooting at the police.
      for (const u of this.police.units) {
        const target = u.officer.inVehicle ? u.vehicle?.position ?? u.officer.centre : u.officer.centre;
        if (segmentDistance(shot.origin, shot.end, target) < 2.0) { this.crime('shootAtPolice', true); break; }
      }
    }
    const s: Shot = { shooter, origin: shot.origin, end: shot.end, hit, hitId };
    this.shots.push(s);
    return s;
  }

  private drainContacts(): void {
    // Contact cooldowns are useful for only half a second; retired city actors must not leave history here.
    for (const [key, tick] of this.ramCooldown) if (this.tick - tick >= 30) this.ramCooldown.delete(key);
    this.eventQueue.drainContactForceEvents(e => {
      const h1 = e.collider1(), h2 = e.collider2();
      const force = e.maxForceMagnitude();
      if (force < RAM_FORCE_THRESHOLD) return;
      const v1 = this.colliderVehicle.get(h1), v2 = this.colliderVehicle.get(h2);
      if (!v1 && !v2) return;
      // Damage follows the speed change of the impact, not the contact force, so leaning on a wall is harmless.
      const dv = Math.max(v1?.deltaV ?? 0, v2?.deltaV ?? 0);
      if (dv < 1.0) return;
      const damage = clamp((dv - 1.0) * 28, 0, 400);
      if (v1) v1.applyDamage(damage * (v2 ? 1 : 0.7));
      if (v2) v2.applyDamage(damage * (v1 ? 1 : 0.7));
      const key = v1 && v2 ? `${v1.id}|${v2.id}` : `${(v1 ?? v2)!.id}|static`;
      const last = this.ramCooldown.get(key) ?? -1000;
      if (this.tick - last < 30) return;
      this.ramCooldown.set(key, this.tick);
      const pv = this.playerVehicle;
      if (pv && (v1 === pv || v2 === pv)) {
        const other = v1 === pv ? v2 : v1;
        if (other) {
          const police = other.def.role === 'patrol';
          this.emit(police ? 'ramPolice' : 'ram', other.id, Math.round(dv * 10) / 10);
          this.crime(police ? 'ramPolice' : 'ram', police || this.police.playerSeen);
        } else this.emit('crash', 'static', Math.round(dv * 10) / 10);
      }
    });
    this.eventQueue.drainCollisionEvents((h1, h2, started) => {
      if (!started) return;
      const v = this.colliderVehicle.get(h1) ?? this.colliderVehicle.get(h2);
      const c = this.colliderCharacter.get(h1) ?? this.colliderCharacter.get(h2);
      if (!v || !c || !c.alive || c.inVehicle) return;
      // A kinematic person can stop a dynamic car within the solver. Its final speed then hides a real
      // impact (8 m/s in, 1 m/s out). Kinematic velocity is prescribed and is not changed by that impulse.
      const before = v.velocityBefore, characterVelocity = c.body.linvel();
      if (Math.hypot(before[0], before[2]) < CAR_HIT_SPEED) return; // walking into a parked/creeping car is harmless
      const speed = Math.hypot(before[0] - characterVelocity.x, before[2] - characterVelocity.z);
      if (speed < CAR_HIT_SPEED) return;
      // Chassis and skid colliders, or a rapidly restarting contact, describe one impact on this person.
      const key = `character:${v.id}|${c.id}`;
      if (this.ramCooldown.has(key)) return;
      this.ramCooldown.set(key, this.tick);
      const wasAlive = c.alive;
      c.takeDamage(carHitDamage(speed));
      const officer = this.police.unitOfOfficer(c.id);
      if (c === this.player) return;
      if (v.driver === 'player') {
        this.emit('hitCharacter', c.id, Math.round(speed));
        if (officer) this.crime('ramPolice', true); else this.crime('hitPedestrian');
        if (wasAlive && !c.alive) { this.emit('kill', c.id); this.crime(officer ? 'killOfficer' : 'kill', !!officer || this.police.playerSeen); }
      }
    });
  }

  private checkArrest(): void {
    if (this.mode === 'wasted' || this.mode === 'busted' || !this.player.alive) return;
    if (this.police.arrestProgress >= 1) this.busted();
  }

  private checkKillPlane(): void {
    const kill = this.gameplay.killHeight;
    const pv = this.playerVehicle;
    // Geographic coverage qualifies automatic spawns, not traversal. Recover only an
    // actual fall or invalid physics state, never a crossing of an invisible XZ fence.
    const outside = (p: V3): boolean => !p.every(Number.isFinite) || p[1] < kill;
    if (pv && outside(pv.position)) { this.recoverVehicle(pv); this.emit('killPlane', pv.id); }
    else if (!pv && outside(this.player.position)) {
      this.recoverPlayer();
      this.emit('killPlane', 'player');
    }
    for (const v of this.vehicles.values()) if (v !== pv && outside(v.position)) this.recoverVehicle(v);
  }

  private wasted(): void {
    this.cancelVehicleEntry();
    this.player.resetJump(true);
    const anchor = this.gameplay.anchors.find(a => a.kind === 'hospital')!;
    this.mode = 'wasted';
    this.modeTicks = 0;
    this.screen = { kind: 'wasted', ticks: this.options.screenTicks, anchor };
    this.aiming = false;
    this.wanted.clearPlayerFire();
    const v = this.playerVehicle;
    if (v) { v.driver = null; v.occupants.delete('player'); v.input.throttle = 0; v.input.brake = 1; }
    this.emit('wasted', anchor.destinationName);
  }

  private busted(): void {
    this.cancelVehicleEntry();
    this.player.resetJump(true);
    const anchor = this.gameplay.anchors.find(a => a.kind === 'police')!;
    this.mode = 'busted';
    this.modeTicks = 0;
    this.screen = { kind: 'busted', ticks: this.options.screenTicks, anchor };
    this.aiming = false;
    this.wanted.clearPlayerFire();
    const v = this.playerVehicle;
    if (v) { v.driver = null; v.occupants.delete('player'); v.input.throttle = 0; v.input.brake = 1; v.input.handbrake = true; }
    this.player.clip = 'arrested';
    this.emit('busted', anchor.destinationName, this.wanted.stars);
  }

  private stepScreen(): void {
    const s = this.screen;
    if (!s) { this.mode = 'onFoot'; return; }
    // Incapacitation cancels control and jump upgrades, not gravity. An airborne body
    // continues to collide and fall while the reaction screen is displayed. It counts as grounded a few centimetres up
    // on the tick it lands, so it keeps moving through the landing until the next tick's snap has set it down.
    if (!this.player.inVehicle && (!this.player.grounded || this.player.jumpPhase === 'land')) this.player.move(this.world, 0, 0);
    s.ticks--;
    if (s.ticks > 0) return;
    const p = this.player;
    const safe = this.safeSpawns.character(s.anchor.position[0], s.anchor.position[1], headingToYaw(s.anchor.headingDeg), p.body);
    p.inVehicle = null;
    p.alive = true;
    p.health = this.gameplay.player.health;
    p.deathTicks = 0;
    p.fallYaw = null;
    p.hitTicks = 0;
    if (s.kind === 'wasted') p.armour = 0;
    this.resetStartingInventory();
    this.recoverTicks = 0;
    this.pendingExit = null;
    this.jumpWasDown = false;
    this.jumpPressed = false;
    p.teleport(safe.position, safe.yaw);
    this.wanted.clear();
    this.police.reset();
    this.mode = 'onFoot';
    this.modeTicks = 0;
    this.emit('respawn', s.anchor.id);
    this.screen = null;
  }

  /**
   * A body is drawn lying flat at its feet. As it collapses it turns to fall along level, open ground, chosen once it
   * stands on something; a pedestrian already knocked down when killed stays as they lie.
   */
  private layBodies(): void {
    for (const c of [this.player, ...this.characters.values()]) {
      if (c.alive || c.inVehicle) continue;
      if (c.fallYaw === null && c.grounded) c.fallYaw = this.pedestrians.knockedDown(c.id) ? c.yaw : c.chooseFall(this.world);
      if (c.fallYaw !== null) c.turnToward(c.fallYaw, BODY.turnRate);
    }
  }

  private updatePlayerClip(): void {
    const p = this.player;
    let clip: CharacterClip;
    if (!p.alive) clip = 'death';
    else if (this.mode === 'busted') clip = 'arrested';
    else if (this.mode === 'driving' || this.mode === 'exiting') clip = 'drive';
    else if (this.mode === 'entering') clip = this.entryStage !== 'approach' || p.speed < 0.2 ? 'idle' : 'walk';
    else if (p.hitTicks > 0) clip = 'hit';
    else if (this.tick - this.lastFireTick < 8) clip = 'fire';
    else if (this.aiming) clip = 'aim';
    else if (p.speed > 4.8) clip = 'sprint';
    else if (p.speed > 2.4) clip = 'run';
    else if (p.speed > 0.2) clip = 'walk';
    else clip = 'idle';
    if (clip !== p.clip) { p.clip = clip; p.clipTicks = 0; } else p.clipTicks++;
    if (p.hitTicks > 0) p.hitTicks--;
  }

  // ---- output ----

  get vehicleInteraction(): VehicleInteractionState | null {
    if (this.mode === 'entering' && this.pendingVehicle) {
      const clip = this.entryStage === 'push' ? this.pushClip! : this.entryStage === 'shove' ? this.shoveAside!.clip : 'enter';
      return {
        vehicleId: this.pendingVehicle.id, stage: this.entryStage, clip, side: 'driver',
        progress: this.entryStage === 'approach' ? 0 : this.interactionTicks / vehicleClipTicks(clip),
        startOffset: this.entryOffset,
      };
    }
    if (this.player.inVehicle && this.mode === 'exiting') return {
      vehicleId: this.player.inVehicle, stage: 'exit', clip: this.exitClip, side: vehicleExitRoute(this.exitClip),
      progress: this.interactionTicks / vehicleClipTicks(this.exitClip), startOffset: [0, 0, 0],
    };
    if (this.player.inVehicle && this.mode === 'driving') return {
      vehicleId: this.player.inVehicle, stage: 'seated', clip: 'enter', side: 'driver', progress: 1, startOffset: [0, 0, 0],
    };
    return null;
  }

  private get exitDigest(): string {
    return this.exitClip === 'exit' ? 'driver' : this.exitClip === 'exitPassenger' ? 'passenger' : this.exitClip;
  }

  private get vehicleInteractionDigest(): string {
    const state = this.vehicleInteraction;
    return `${state?.vehicleId ?? '-'}:${state?.stage ?? '-'}:${state?.clip ?? '-'}:${this.interactionTicks}:${this.approachWaypoint}:${this.modeTicks}:${this.exitRequested ? 1 : 0}:${this.exitReturning ? 1 : 0}:${this.exitDigest}:${r3(this.entryOffset)}:${this.approachRoute.map(r3).join(';')}:${this.pushClip ?? '-'}:${this.pushShoves}:${r3(this.pushOrigin)}:${this.shoveAside ? `${this.shoveAside.clip}/${this.shoveAside.target.id}/${r3(this.shoveAside.stand)}/${r3(this.shoveAside.direction)}` : '-'}:${this.shoveAsides}:${r3(this.shoveFrom)}`;
  }

  state(): SimState {
    const p = this.player;
    const w = this.inventory.weapon;
    const vehicles: VehicleState[] = [];
    for (const v of this.vehicles.values()) {
      vehicles.push({
        id: v.id, definition: v.def.id, position: v.position, rotation: v.rotation,
        wheels: v.def.wheels.map((wd, i) => ({ position: v.wheelLocal(i), rotation: v.wheelRotation[i]!, steer: wd.steer ? v.steerAngle : 0, contact: v.wheelContact[i]! })),
        steerAngle: v.steerAngle, speed: v.speed, forwardSpeed: v.forwardSpeed, throttle: v.input.throttle, damage: v.damage, health: v.health,
        lightsOn: v.lightsOn, sirenOn: v.sirenOn, horn: v.hornTicks > 0, driver: v.driver, windshieldBroken: v.windshieldBroken,
      });
    }
    const characters: CharacterState[] = [];
    for (const c of this.characters.values()) {
      characters.push({ ...characterState(c), aiming: this.police.unitOfOfficer(c.id)?.aiming ?? false, knockdown: this.pedestrians.knockdown(c.id) });
    }
    const near = this.mode === 'onFoot' ? this.nearestEnterableVehicle() : null;
    return {
      tick: this.tick, time: this.tick / TICK_HZ,
      player: {
        ...characterState(p), aiming: this.aiming, pitch: this.pitch, armour: p.armour, mode: this.mode, modeTicks: this.modeTicks,
        weapon: w ? { id: w.def.id, magazine: w.magazine, reserve: w.reserve, reloading: w.reloadTicks > 0 } : null,
        nearVehicle: near ? near.id : null, recoverProgress: Math.min(1, this.recoverTicks / RECOVER_HOLD_TICKS),
        vehicleInteraction: this.vehicleInteraction,
      },
      vehicles, characters, police: this.police.states(), wanted: this.wanted.snapshot(), arrestProgress: this.police.arrestProgress,
      screen: this.screen ? { kind: this.screen.kind, ticksLeft: this.screen.ticks, destination: this.screen.anchor.destinationName } : null,
      shots: this.shots, events: this.events,
    };
  }

  /** One-line digest of the dynamic state (player, vehicles, characters) for locating replay divergences. */
  digest(): string {
    const parts: string[] = [`t${this.tick}`, this.mode, r3(this.player.position), String(Math.round(this.player.health)), `w${this.wanted.stars}/${r2(this.wanted.heat)}/${this.wanted.playerHasFired ? 'fired' : 'quiet'}`, `jump:${this.player.jumpDigest}:${this.jumpWasDown ? 1 : 0}`, `vehicle:${this.vehicleInteractionDigest}`];
    for (const id of [...this.vehicles.keys()].sort()) { const v = this.vehicles.get(id)!; parts.push(`${id}:${r3(v.position)}:${r2(v.yaw)}:${Math.round(v.health)}:${this.playerTakenVehicles.has(v) ? 'taken' : 'untaken'}`); }
    for (const id of [...this.characters.keys()].sort()) { const c = this.characters.get(id)!; parts.push(`${id}:${r3(c.position)}:${Math.round(c.health)}:${c.inVehicle ?? '-'}:${c.jumpDigest}:death${c.deathTicks}`); }
    parts.push(`police:${this.police.units.map(u => `${u.id}=${u.state}`).join(',')}`);
    parts.push(`policeRoutes:${this.police.routingDigest()}`);
    parts.push(`pedestrians:${this.pedestrians.digest()}`);
    parts.push(`wanted:${this.wanted.digest()}`);
    parts.push(`contacts:${[...this.ramCooldown].sort(([a], [b]) => a.localeCompare(b)).map(([id, tick]) => `${id}:${tick}`).join(",")}`);
    return parts.join(' ');
  }

  /** Order-independent digest of the dynamic state, for replay comparisons. */
  hash(): string {
    const parts: string[] = [String(this.tick), this.mode, r3(this.player.position), r2(this.player.yaw), String(Math.round(this.player.health)), String(this.wanted.stars), r2(this.wanted.heat), String(this.wanted.playerHasFired), this.player.jumpDigest, String(this.jumpWasDown), this.vehicleInteractionDigest];
    const ids = [...this.vehicles.keys()].sort();
    for (const id of ids) { const v = this.vehicles.get(id)!; parts.push(id, r3(v.position), r2(v.yaw), String(Math.round(v.health)), String(this.playerTakenVehicles.has(v))); }
    const cids = [...this.characters.keys()].sort();
    for (const id of cids) { const c = this.characters.get(id)!; parts.push(id, r3(c.position), String(Math.round(c.health)), c.inVehicle ?? '-', c.jumpDigest, String(c.deathTicks)); }
    parts.push(`policeRoutes:${this.police.routingDigest()}`);
    parts.push(`pedestrians:${this.pedestrians.digest()}`);
    parts.push(`wanted:${this.wanted.digest()}`);
    parts.push(`contacts:${[...this.ramCooldown].sort(([a], [b]) => a.localeCompare(b)).map(([id, tick]) => `${id}:${tick}`).join(",")}`);
    return fnv1a(parts.join('|'));
  }
}

function characterState(c: Character): CharacterState {
  return {
    id: c.id, position: c.position, yaw: c.yaw, clip: c.clip, speed: c.speed, alive: c.alive, deathElapsed: c.deathElapsed, health: c.health, inVehicle: c.inVehicle, aiming: false,
    grounded: c.grounded, verticalSpeed: c.verticalSpeed, jumpPhase: c.jumpPhase, jumpPhaseTime: c.jumpPhaseTime, jumpKind: c.jumpKind, groundDistance: c.groundDistance,
    landingSpeed: c.landingSpeed, climb: c.climbView,
  };
}

const r3 = (v: V3): string => `${v[0].toFixed(3)},${v[1].toFixed(3)},${v[2].toFixed(3)}`;
const r2 = (x: number): string => x.toFixed(2);

export function headingToYaw(headingDeg: number): number {
  return wrapAngle(Math.PI - headingDeg * Math.PI / 180);
}

export function yawToHeading(yaw: number): number {
  let h = (Math.PI - yaw) * 180 / Math.PI;
  while (h < 0) h += 360;
  while (h >= 360) h -= 360;
  return h;
}

/** Distance from point p to segment ab in 3D. */
export function segmentDistance(a: V3, b: V3, p: V3): number {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
  const l2 = abx * abx + aby * aby + abz * abz;
  const t = l2 > 0 ? clamp(((p[0] - a[0]) * abx + (p[1] - a[1]) * aby + (p[2] - a[2]) * abz) / l2, 0, 1) : 0;
  return Math.hypot(a[0] + abx * t - p[0], a[1] + aby * t - p[1], a[2] + abz * t - p[2]);
}

export { yawOf, lengthXZ, FEET_TO_CENTRE };
