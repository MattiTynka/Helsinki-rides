// Police (plan section 8): patrol units with a car and one officer each. Units drive the road graph (route
// following with pure pursuit), pursue directly within sight, box a stopped car in, get out to arrest a player
// on foot, and fire only when the player is armed at three stars or more. Caps per star from the tuning table.
import type { LaneHit, RoadLane, Vec3 } from '@helsinki/world-schema';
import { Character, CHARACTER } from './character.ts';
import { TICK_HZ } from './commands.ts';
import { clamp, distanceXZ, normalize, wrapAngle, type V3 } from './math.ts';
import { headingToYaw, type Simulation } from './simulation.ts';
import type { Vehicle } from './vehicle.ts';
import { fireRay } from './weapons.ts';
import { GROUP, groups, RAPIER } from './world.ts';

export type UnitState = 'patrol' | 'respond' | 'pursue' | 'boxin' | 'engage' | 'search' | 'return' | 'disabled';

export interface PoliceUnitState {
  readonly id: string;
  readonly state: UnitState;
  readonly vehicleId: string | null;
  readonly officerId: string;
  readonly seesPlayer: boolean;
  readonly onFoot: boolean;
}

const SIGHT_RANGE_CAR = 90;
const SIGHT_RANGE_FOOT = 70;
const DIRECT_PURSUIT_RANGE = 80;
const ENGAGE_RANGE = 28;
const OFFICER_HEALTH = 100;
const FIRE_INTERVAL = Math.round(1.1 * TICK_HZ);
const DESPAWN_DISTANCE = 140;
/** Lateral acceleration the AI driver allows itself (m/s²), below the tyres' grip so it never rolls. */
const AI_LATERAL_ACCEL = 7;

/** Direction of travel (yaw) of a lane at arc length `s` along it. */
function laneYawAt(lane: RoadLane, s: number): number {
  const pts = lane.points;
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!, b = pts[i]!;
    const len = Math.hypot(b[0] - a[0], b[2] - a[2]);
    if (s <= acc + len || i === pts.length - 1) return Math.atan2(b[0] - a[0], b[2] - a[2]);
    acc += len;
  }
  return 0;
}

/** Route follower with pure-pursuit steering, throttle from curvature and a stuck/reverse recovery. */
class AiDriver {
  route: Vec3[] = [];
  index = 0;
  stuckTicks = 0;
  reverseTicks = 0;
  replanTicks = 0;
  goal: V3 | null = null;

  setRoute(points: Vec3[], from: V3, forward?: V3): void {
    this.route = points;
    this.index = 0;
    this.goal = points.length ? [points[points.length - 1]![0], points[points.length - 1]![1], points[points.length - 1]![2]] : null;
    // Start at the nearest point, then skip the points behind the car: lanes come whole from the router, and a car
    // that turned round to reach a route's start behind it reversed into walls and flipped.
    let best = 0, bestD = Infinity;
    for (let i = 0; i < points.length; i++) { const d = distanceXZ(points[i]!, from); if (d < bestD) { bestD = d; best = i; } }
    if (forward) while (best < points.length - 1 && (points[best]![0] - from[0]) * forward[0] + (points[best]![2] - from[2]) * forward[2] < 0) best++;
    this.index = best;
  }

  get finished(): boolean { return this.route.length === 0 || this.index >= this.route.length; }

  /** Drive toward the route; returns true when the end is reached (within `stopDistance`). */
  drive(v: Vehicle, targetSpeed: number, stopDistance: number): boolean {
    if (this.route.length === 0) { v.input.throttle = 0; v.input.brake = 0.6; v.input.steer = 0; return true; }
    const pos = v.position;
    const speed = v.forwardSpeed;
    const lookahead = clamp(4 + Math.abs(speed) * 0.55, 5, 16);
    // Advance the index past points within the lookahead circle, and past nearby points already behind the car.
    const f = v.forward;
    const behind = (p: Vec3) => (p[0] - pos[0]) * f[0] + (p[2] - pos[2]) * f[2] < 0;
    while (this.index < this.route.length - 1 && (distanceXZ(this.route[this.index]!, pos) < lookahead || (behind(this.route[this.index]!) && distanceXZ(this.route[this.index]!, pos) < 20))) this.index++;
    const target = this.route[this.index]!;
    const end = this.route[this.route.length - 1]!;
    const remaining = distanceXZ(end, pos);
    if (remaining <= stopDistance && this.index >= this.route.length - 1) { v.input.throttle = 0; v.input.brake = 1; v.input.steer = 0; this.index = this.route.length; return true; }
    this.steerTo(v, [target[0], target[1], target[2]], targetSpeed, remaining);
    return false;
  }

  /** Steer directly toward a world point (no route). */
  steerTo(v: Vehicle, target: V3, targetSpeed: number, remaining = Infinity): void {
    const pos = v.position;
    const yaw = v.yaw;
    const desiredYaw = Math.atan2(target[0] - pos[0], target[2] - pos[2]);
    const delta = wrapAngle(desiredYaw - yaw);
    const maxAngle = v.def.steering.maxAngleDeg * Math.PI / 180;
    const speed = v.forwardSpeed;
    // Stuck detection: wanting to move but not moving.
    if (this.reverseTicks > 0) {
      this.reverseTicks--;
      v.input.throttle = -1;
      v.input.steer = clamp(-delta / maxAngle, -1, 1);
      v.input.brake = 0;
      v.input.handbrake = false;
      return;
    }
    if (Math.abs(speed) < 0.4 && targetSpeed > 1) this.stuckTicks++; else this.stuckTicks = 0;
    if (this.stuckTicks > 1.5 * TICK_HZ) { this.stuckTicks = 0; this.reverseTicks = Math.round(1.2 * TICK_HZ); }
    // Slow down for sharp turns and near the goal.
    const turnFactor = 1 - clamp(Math.abs(delta) / (Math.PI / 2), 0, 1) * 0.75;
    const stopFactor = Number.isFinite(remaining) ? clamp(remaining / 12, 0.25, 1) : 1;
    const desired = targetSpeed * turnFactor * stopFactor;
    const err = desired - speed;
    if (Math.abs(delta) > Math.PI * 0.6 && Math.abs(speed) < 2) {
      // Three-point turn: reverse while steering the other way.
      v.input.throttle = -0.8;
      v.input.steer = clamp(-delta / maxAngle, -1, 1);
      v.input.brake = 0;
    } else {
      // Lock limited by lateral acceleration (v² / R with R = wheelbase / tan lock): braking hard while steering
      // 40° off at 20 m/s rolled the patrol car on the tyres' grip. The cap is relative to the vehicle's effective
      // lock at this speed, which vehicle.ts shrinks towards `highSpeedAngleDeg`.
      const st = v.def.steering;
      const tSpeed = clamp(Math.abs(speed) / Math.max(1, v.def.engine.topSpeedMs), 0, 1);
      const effMax = (st.maxAngleDeg + (st.highSpeedAngleDeg - st.maxAngleDeg) * tSpeed) * Math.PI / 180;
      const zs = v.def.wheels.map(w => w.position[2]);
      const wheelbase = Math.max(1, Math.max(...zs) - Math.min(...zs));
      const v2 = speed * speed;
      const lockCap = v2 > 1 ? clamp(Math.atan(AI_LATERAL_ACCEL * wheelbase / v2) / effMax, 0.12, 1) : 1;
      v.input.steer = clamp(delta / maxAngle * 1.3, -lockCap, lockCap);
      if (err > 0) { v.input.throttle = clamp(err / 4, 0.15, 1); v.input.brake = 0; }
      else { v.input.throttle = 0; v.input.brake = clamp(-err / 6, 0, 1); }
    }
    v.input.handbrake = false;
  }
}

export class PoliceUnit {
  readonly id: string;
  vehicle: Vehicle | null;
  readonly officer: Character;
  state: UnitState = 'patrol';
  stateTicks = 0;
  readonly driver = new AiDriver();
  sees = false;
  sightTicks = 0;
  fireTicks = 0;
  arrestTicks = 0;
  spawnIndex: number;
  searchTarget: V3 | null = null;
  /** Where the officer left the car, to walk back to. */
  parkedAt: V3 | null = null;
  firstBeatDone = false;
  stuckTicks = 0;
  approachBest = Infinity;
  sidestepTicks = 0;
  sidestepSign = 1;

  constructor(id: string, vehicle: Vehicle, officer: Character, spawnIndex: number) {
    this.id = id;
    this.vehicle = vehicle;
    this.officer = officer;
    this.spawnIndex = spawnIndex;
  }

  get onFoot(): boolean { return this.officer.inVehicle === null; }
  get position(): V3 { return this.onFoot || !this.vehicle ? this.officer.centre : this.vehicle.position; }

  setState(s: UnitState): void {
    if (s !== this.state) { this.state = s; this.stateTicks = 0; }
  }
}

export class PoliceForce {
  readonly sim: Simulation;
  readonly units: PoliceUnit[] = [];
  playerSeen = false;
  arrestProgress = 0;
  /** Lanes from which most of the graph is reachable; spawns and route targets snap to these. */
  readonly goodLanes: readonly RoadLane[];
  private readonly goodLaneIds: Set<string>;
  private serial = 0;
  private boxedTicks = 0;
  private footArrestTicks = 0;
  private respawnTicks = 0;

  constructor(sim: Simulation) {
    this.sim = sim;
    const roads = sim.world.roads;
    const reach = (from: string): number => {
      const seen = new Set<string>([from]);
      const q = [from];
      while (q.length) { const id = q.pop()!; for (const c of roads.outgoing.get(id) ?? []) if (!seen.has(c.to)) { seen.add(c.to); q.push(c.to); } }
      return seen.size;
    };
    const sizes = roads.graph.lanes.map(l => reach(l.id));
    const best = Math.max(0, ...sizes);
    this.goodLanes = roads.graph.lanes.filter((_l, i) => sizes[i]! >= best * 0.6);
    this.goodLaneIds = new Set(this.goodLanes.map(l => l.id));
  }

  /** Nearest well-connected lane to a point, preferring lanes that run along `heading` (unit XZ) when given. */
  nearestGoodLane(x: number, z: number, maxDistance: number, heading?: [number, number]): LaneHit | null {
    let best: LaneHit | null = null;
    let bestScore = Infinity;
    for (const lane of this.goodLanes) {
      let s = 0;
      for (let i = 1; i < lane.points.length; i++) {
        const a = lane.points[i - 1]!, b = lane.points[i]!;
        const dx = b[0] - a[0], dz = b[2] - a[2];
        const len2 = dx * dx + dz * dz;
        const t = len2 > 0 ? clamp(((x - a[0]) * dx + (z - a[2]) * dz) / len2, 0, 1) : 0;
        const px = a[0] + dx * t, pz = a[2] + dz * t;
        const d = Math.hypot(px - x, pz - z);
        if (d <= maxDistance) {
          let score = d;
          if (heading && len2 > 0) { const len = Math.sqrt(len2); score += (1 - ((dx / len) * heading[0] + (dz / len) * heading[1])) * 4; } // up to 8 m against the lane
          if (score < bestScore) { bestScore = score; best = { laneId: lane.id, s: s + Math.sqrt(len2) * t, point: [px, a[1] + (b[1] - a[1]) * t, pz], distance: d }; }
        }
        s += Math.sqrt(len2);
      }
    }
    return best;
  }

  states(): PoliceUnitState[] {
    return this.units.map(u => ({ id: u.id, state: u.state, vehicleId: u.vehicle?.id ?? null, officerId: u.officer.id, seesPlayer: u.sees, onFoot: u.onFoot }));
  }

  unitOfOfficer(characterId: string): PoliceUnit | null {
    return this.units.find(u => u.officer.id === characterId) ?? null;
  }

  unitOfVehicle(vehicleId: string): PoliceUnit | null {
    return this.units.find(u => u.vehicle?.id === vehicleId) ?? null;
  }

  spawnInitial(): void {
    for (let i = 0; i < this.sim.gameplay.police.initialPatrols; i++) this.spawnUnit();
  }

  /** Remove every unit and start over with the initial patrols (after Wasted / Busted). */
  reset(): void {
    for (const u of [...this.units]) this.removeUnit(u);
    this.playerSeen = false;
    this.arrestProgress = 0;
    this.boxedTicks = 0;
    this.footArrestTicks = 0;
    this.spawnInitial();
  }

  private cap(): number {
    const stars = this.sim.wanted.stars;
    if (stars <= 0) return this.sim.gameplay.police.initialPatrols;
    const caps = this.sim.gameplay.wanted.unitCaps;
    return caps[Math.min(stars, caps.length) - 1] ?? caps[caps.length - 1] ?? 1;
  }

  private spawnUnit(): PoliceUnit | null {
    const g = this.sim.gameplay;
    const player = this.sim.playerPosition;
    // Spawn points at least spawnMinDistance from the player; otherwise the farthest.
    const ranked = g.police.patrolSpawns.map((s, i) => ({ s, i, d: Math.hypot(s.position[0] - player[0], s.position[1] - player[2]) })).sort((a, b) => b.d - a.d);
    const far = ranked.filter(r => r.d >= g.police.spawnMinDistance);
    const used = new Set(this.units.map(u => u.spawnIndex));
    const pool = (far.length ? far : ranked).filter(r => !used.has(r.i));
    // The first patrol of a quiet city takes the first listed beat (the content's main street); later units are random.
    const first = this.units.length === 0 && this.sim.wanted.stars === 0 ? pool.find(r => r.i === 0) : undefined;
    const pick = first ?? (pool.length ? this.sim.rng.pick(pool) : ranked[0]);
    if (!pick) return null;
    // Snap to the nearest well-connected lane that runs the way the content's heading points, so the car starts on a
    // road it can route from and never has to turn round first (reversing into the Cathedral terrace flipped cars).
    let yaw = headingToYaw(pick.s.headingDeg);
    const dir: [number, number] = [Math.sin(yaw), Math.cos(yaw)];
    const roads = this.sim.world.roads;
    const lane = this.nearestGoodLane(pick.s.position[0], pick.s.position[1], 80, dir) ?? roads.nearestLane(pick.s.position[0], pick.s.position[1], dir, 40);
    let xz: [number, number] = [pick.s.position[0], pick.s.position[1]];
    if (lane) {
      xz = [lane.point[0], lane.point[2]];
      yaw = laneYawAt(roads.laneById.get(lane.laneId)!, lane.s);
    }
    const id = `police-${++this.serial}`;
    const vehicle = this.sim.spawnVehicle(`${id}-car`, 'patrol', xz, yaw);
    const officer = this.sim.spawnCharacter(`${id}-officer`, [xz[0], vehicle.position[1], xz[1]], yaw, OFFICER_HEALTH);
    officer.inVehicle = vehicle.id;
    officer.hide();
    vehicle.driver = officer.id;
    vehicle.occupants.add(officer.id);
    vehicle.lightsOn = true;
    const unit = new PoliceUnit(id, vehicle, officer, pick.i);
    this.units.push(unit);
    this.sim.emit('policeSpawn', id);
    return unit;
  }

  private removeUnit(u: PoliceUnit): void {
    const i = this.units.indexOf(u);
    if (i >= 0) this.units.splice(i, 1);
    if (u.vehicle) this.sim.removeVehicle(u.vehicle);
    this.sim.removeCharacter(u.officer);
    this.sim.emit('policeDespawn', u.id);
  }

  /** Decisions and driving/walking inputs; runs before the physics step. */
  step(): void {
    const sim = this.sim;
    const stars = sim.wanted.stars;
    // Keep the force at the cap for the current star level.
    const cap = this.cap();
    if (this.units.length < cap) {
      if (this.respawnTicks > 0) this.respawnTicks--;
      else { this.spawnUnit(); this.respawnTicks = Math.round((stars > 0 ? 2.5 : 8) * TICK_HZ); }
    }
    for (const u of this.units) {
      u.stateTicks++;
      if (u.fireTicks > 0) u.fireTicks--;
      if (!u.officer.alive) { this.officerDown(u); continue; }
      if (u.vehicle && (u.vehicle.damage === 'wrecked')) { u.vehicle.sirenOn = false; if (!u.onFoot) this.leaveCar(u); }
      this.updateSight(u);
      this.decide(u, stars);
      this.act(u, stars);
    }
    // Despawn surplus units far from the player when the heat is gone.
    if (stars === 0) {
      for (const u of [...this.units]) {
        if (this.units.length <= cap) break;
        if (distanceXZ(u.position, sim.playerPosition) > DESPAWN_DISTANCE && !u.sees) this.removeUnit(u);
      }
    }
  }

  /** Sight bookkeeping after the physics step (positions are final). */
  afterPhysics(): void {
    this.playerSeen = this.units.some(u => u.sees && u.officer.alive);
    this.updateArrest();
  }

  private updateSight(u: PoliceUnit): void {
    const sim = this.sim;
    if (!sim.player.alive || sim.mode === 'wasted' || sim.mode === 'busted') { u.sees = false; return; }
    // Stagger ray casts: each unit checks every 3 ticks.
    if ((sim.tick + u.spawnIndex) % 3 !== 0) return;
    const eye: V3 = u.onFoot ? u.officer.eye : [u.vehicle!.position[0], u.vehicle!.position[1] + 1.3, u.vehicle!.position[2]];
    const target = sim.playerVehicle ? [sim.playerVehicle.position[0], sim.playerVehicle.position[1] + 0.9, sim.playerVehicle.position[2]] as V3 : sim.player.head;
    const range = u.onFoot ? SIGHT_RANGE_FOOT : SIGHT_RANGE_CAR;
    const dx = target[0] - eye[0], dy = target[1] - eye[1], dz = target[2] - eye[2];
    const dist = Math.hypot(dx, dy, dz);
    if (dist > range) { u.sees = false; return; }
    const ray = new RAPIER.Ray({ x: eye[0], y: eye[1], z: eye[2] }, { x: dx / dist, y: dy / dist, z: dz / dist });
    const hit = sim.world.physics.castRay(ray, dist - 0.5, true, undefined, groups(GROUP.bullet, GROUP.static), undefined, u.vehicle?.body);
    u.sees = !hit;
    if (u.sees) u.sightTicks = sim.tick;
  }

  private decide(u: PoliceUnit, stars: number): void {
    const sim = this.sim;
    const playerPos = sim.playerPosition;
    const d = distanceXZ(u.position, playerPos);
    const playerOnFoot = !sim.playerVehicle;
    const lastSeen = sim.wanted.lastSeen;
    if (stars === 0) {
      if (u.state !== 'patrol' && u.state !== 'return') u.setState('patrol');
      return;
    }
    if (u.onFoot) {
      // Officers on foot engage while the player is near, otherwise walk back to the car.
      if (playerOnFoot && (u.sees || d < 12) && d < ENGAGE_RANGE * 1.6) u.setState('engage');
      else u.setState('return');
      return;
    }
    if (u.sees) {
      if (playerOnFoot && d < ENGAGE_RANGE) u.setState('engage');
      else if (!playerOnFoot && sim.playerSpeed < 3 && d < 18 && stars <= 2) u.setState('boxin');
      else u.setState('pursue');
    } else if (lastSeen) {
      if (u.state === 'pursue' && sim.tick - u.sightTicks < 3 * TICK_HZ) return; // keep chasing briefly
      u.setState(sim.wanted.searching && distanceXZ(u.position, lastSeen) < 25 ? 'search' : 'respond');
    } else u.setState('respond');
  }

  private act(u: PoliceUnit, stars: number): void {
    const sim = this.sim;
    const v = u.vehicle;
    if (v) v.sirenOn = stars > 0 && u.state !== 'patrol' && u.state !== 'return' && !u.onFoot;
    switch (u.state) {
      case 'patrol': this.patrol(u); break;
      case 'respond': this.driveTo(u, sim.wanted.lastSeen ?? sim.playerPosition, 20, 6); break;
      case 'pursue': this.pursue(u); break;
      case 'boxin': this.boxIn(u); break;
      case 'search': this.search(u); break;
      case 'engage': this.engage(u, stars); break;
      case 'return': this.returnToCar(u); break;
      case 'disabled': break;
    }
  }

  // ---- behaviours ----

  private patrol(u: PoliceUnit): void {
    const v = u.vehicle;
    if (!v || u.onFoot) { this.returnToCar(u); return; }
    const sim = this.sim;
    if (u.driver.finished || u.driver.replanTicks <= 0) {
      const lanes = this.goodLanes.length ? this.goodLanes : sim.world.roads.graph.lanes;
      if (!u.firstBeatDone) {
        // A fresh patrol first drives the length of its own street (the beat), then roams at random.
        u.firstBeatDone = true;
        const here = sim.world.roads.nearestLane(v.position[0], v.position[2], undefined, 30);
        const name = here ? sim.world.roads.laneById.get(here.laneId)!.name : null;
        let best: RoadLane | null = null, bestD = 0;
        for (const l of lanes) {
          if (!name || l.name !== name) continue;
          const d = distanceXZ(l.points[l.points.length - 1]!, v.position);
          if (d > bestD) { bestD = d; best = l; }
        }
        if (best) { const p = best.points[best.points.length - 1]!; this.plan(u, [p[0], p[1], p[2]]); }
      }
      if (u.driver.finished) {
        for (let tries = 0; tries < 8; tries++) {
          const lane = sim.rng.pick(lanes);
          const p = lane.points[lane.points.length - 1]!;
          if (distanceXZ(p, v.position) < 40) continue;
          if (this.plan(u, [p[0], p[1], p[2]])) break;
        }
      }
      u.driver.replanTicks = 20 * TICK_HZ;
    }
    u.driver.replanTicks--;
    const lane = this.laneSpeed(v);
    u.driver.drive(v, lane, 4);
  }

  private driveTo(u: PoliceUnit, target: V3, speed: number, stopDistance: number): boolean {
    const v = u.vehicle;
    if (!v || u.onFoot) { this.returnToCar(u); return false; }
    if (u.driver.replanTicks <= 0 || !u.driver.goal || distanceXZ(u.driver.goal, target) > 15) {
      this.plan(u, target);
      u.driver.replanTicks = 2 * TICK_HZ;
    }
    u.driver.replanTicks--;
    return u.driver.drive(v, speed, stopDistance);
  }

  private pursue(u: PoliceUnit): void {
    const v = u.vehicle;
    if (!v || u.onFoot) { this.returnToCar(u); return; }
    const sim = this.sim;
    const target = sim.playerPosition;
    const d = distanceXZ(v.position, target);
    if (d < DIRECT_PURSUIT_RANGE && u.sees) {
      // Direct pursuit: aim a little ahead of the target car.
      const pv = sim.playerVehicle;
      const lead: V3 = pv ? [target[0] + pv.velocity[0] * 0.6, target[1], target[2] + pv.velocity[2] * 0.6] : target;
      const speed = pv ? clamp(pv.speed + 6, 8, 30) : 10;
      u.driver.steerTo(v, lead, speed, d);
      if (d < 7) { v.input.throttle = 0; v.input.brake = 0.8; }
      u.driver.replanTicks = 0;
    } else this.driveTo(u, target, 26, 6);
  }

  private boxIn(u: PoliceUnit): void {
    const v = u.vehicle;
    const pv = this.sim.playerVehicle;
    if (!v || u.onFoot || !pv) { u.setState('pursue'); return; }
    // Park nose-to-nose or nose-to-tail depending on which side we approach from.
    const f = pv.forward;
    const ahead: V3 = [pv.position[0] + f[0] * 6.5, pv.position[1], pv.position[2] + f[2] * 6.5];
    const behind: V3 = [pv.position[0] - f[0] * 6.5, pv.position[1], pv.position[2] - f[2] * 6.5];
    const others = this.units.filter(o => o !== u && o.state === 'boxin' && o.vehicle);
    const targetAhead = others.length === 0 ? distanceXZ(v.position, ahead) <= distanceXZ(v.position, behind) : others.every(o => distanceXZ(o.vehicle!.position, ahead) > distanceXZ(o.vehicle!.position, behind));
    const target = targetAhead ? ahead : behind;
    const d = distanceXZ(v.position, target);
    if (d < 2.0) { v.input.throttle = 0; v.input.brake = 1; v.input.handbrake = true; v.input.steer = 0; }
    else u.driver.steerTo(v, target, clamp(d, 3, 10), d);
  }

  private search(u: PoliceUnit): void {
    const v = u.vehicle;
    if (!v || u.onFoot) { this.returnToCar(u); return; }
    const sim = this.sim;
    const centre = sim.wanted.lastSeen ?? sim.playerPosition;
    if (!u.searchTarget || u.driver.finished || u.driver.replanTicks <= 0) {
      const r = sim.gameplay.wanted.searchRadius;
      const a = sim.rng.range(0, Math.PI * 2), rr = sim.rng.range(r * 0.3, r);
      const lane = sim.world.roads.nearestLane(centre[0] + Math.sin(a) * rr, centre[2] + Math.cos(a) * rr, undefined, 60);
      u.searchTarget = lane ? [lane.point[0], lane.point[1], lane.point[2]] : [centre[0], centre[1], centre[2]];
      this.plan(u, u.searchTarget);
      u.driver.replanTicks = 12 * TICK_HZ;
    }
    u.driver.replanTicks--;
    u.driver.drive(v, 12, 5);
  }

  private engage(u: PoliceUnit, stars: number): void {
    const sim = this.sim;
    if (!u.onFoot) { this.leaveCar(u); return; }
    const officer = u.officer;
    const player = sim.player;
    const target = player.position;
    const d = distanceXZ(officer.position, target);
    const dir = normalize([target[0] - officer.position[0], 0, target[2] - officer.position[2]]);
    officer.turnToward(Math.atan2(dir[0], dir[2]), 10);
    const armed = sim.playerArmed;
    const shooting = stars >= 3 && armed;
    // Keep distance while shooting, close in to arrest otherwise.
    const standoff = shooting ? 9 : 2.2;
    let speed = 0;
    if (d > standoff + 0.5) speed = d > 12 ? CHARACTER.sprint : CHARACTER.run;
    else if (d < standoff - 1.5 && shooting) speed = -CHARACTER.walk;
    // Blocked (a car between us): sidestep for a while, alternating sides.
    if (speed > 0 && d > standoff + 0.5) {
      if (d > u.approachBest - 0.05) u.stuckTicks++; else { u.stuckTicks = 0; u.approachBest = d; }
      if (u.stuckTicks > 45) { u.stuckTicks = 0; u.sidestepTicks = 70; u.sidestepSign = -u.sidestepSign; }
    } else { u.stuckTicks = 0; u.approachBest = d; }
    let mx = dir[0], mz = dir[2];
    if (u.sidestepTicks > 0) { u.sidestepTicks--; mx = dir[2] * u.sidestepSign * 0.9 + dir[0] * 0.3; mz = -dir[0] * u.sidestepSign * 0.9 + dir[2] * 0.3; }
    officer.desiredVx = mx * speed;
    officer.desiredVz = mz * speed;
    officer.clip = speed > 4.8 ? 'sprint' : speed > 2 ? 'run' : speed !== 0 ? 'walk' : shooting ? 'aim' : 'idle';
    if (shooting && u.sees && u.fireTicks === 0 && d < 40) {
      u.fireTicks = FIRE_INTERVAL + Math.round(sim.rng.range(0, 12));
      const def = sim.weapon('pistol');
      const origin = officer.eye;
      const aim = normalize([target[0] - origin[0], player.position[1] + 1.2 - origin[1], target[2] - origin[2]]);
      const shot = fireRay(sim.world, sim.rng, origin, aim, { ...def, spreadDeg: 3.0 }, officer.body, (h, p) => sim.isHeadshot(h, p));
      sim.resolveShot(officer.id, shot, def);
      officer.clip = 'fire';
      sim.emit('policeFire', u.id);
    }
  }

  private returnToCar(u: PoliceUnit): void {
    const v = u.vehicle;
    const officer = u.officer;
    if (!v || v.damage === 'wrecked') {
      // No car to return to: stand down and despawn when out of sight.
      officer.desiredVx = 0; officer.desiredVz = 0; officer.clip = 'idle';
      if (!u.sees && distanceXZ(officer.position, this.sim.playerPosition) > 60) this.removeUnit(u);
      return;
    }
    if (!u.onFoot) { u.setState(this.sim.wanted.stars > 0 ? 'respond' : 'patrol'); return; }
    const door = v.localToWorld([v.def.seat.exits[0]![0], 0, v.def.seat.exits[0]![2]]);
    const d = distanceXZ(officer.position, door);
    if (d < 1.2 && v.driver === null) {
      officer.inVehicle = v.id;
      officer.hide();
      v.driver = officer.id;
      v.occupants.add(officer.id);
      v.input.handbrake = false;
      officer.desiredVx = 0; officer.desiredVz = 0;
      u.setState(this.sim.wanted.stars > 0 ? 'respond' : 'patrol');
      return;
    }
    const dir = normalize([door[0] - officer.position[0], 0, door[2] - officer.position[2]]);
    officer.turnToward(Math.atan2(dir[0], dir[2]), 10);
    const speed = d > 10 ? CHARACTER.sprint : CHARACTER.run;
    officer.desiredVx = dir[0] * speed;
    officer.desiredVz = dir[2] * speed;
    officer.clip = speed > 4.8 ? 'sprint' : 'run';
  }

  private leaveCar(u: PoliceUnit): void {
    const v = u.vehicle;
    if (!v || u.onFoot) return;
    if (v.speed > 1.5) { v.input.throttle = 0; v.input.brake = 1; v.input.handbrake = true; v.input.steer = 0; return; }
    const exit = v.localToWorld(v.def.seat.exits[0]!);
    const probe = this.sim.world.groundBelow(exit[0], exit[1] + 1.5, exit[2], 6, v.body);
    const officer = u.officer;
    officer.inVehicle = null;
    officer.teleport([exit[0], probe ? probe.y : exit[1], exit[2]], v.yaw);
    v.driver = null;
    v.occupants.delete(officer.id);
    v.input.throttle = 0; v.input.brake = 1; v.input.handbrake = true;
    v.sirenOn = false;
    u.parkedAt = v.position;
    this.sim.emit('officerExit', u.id);
  }

  private officerDown(u: PoliceUnit): void {
    if (u.state !== 'disabled') { u.setState('disabled'); if (u.vehicle) { u.vehicle.sirenOn = false; u.vehicle.input.throttle = 0; u.vehicle.input.brake = 1; } }
    u.officer.desiredVx = 0; u.officer.desiredVz = 0;
    u.officer.clip = 'death';
    u.sees = false;
    // Body and car stay for a while, then the unit is recycled.
    if (u.officer.deathTicks > 20 * TICK_HZ && distanceXZ(u.position, this.sim.playerPosition) > 50) this.removeUnit(u);
  }

  // ---- arrest ----

  private updateArrest(): void {
    const sim = this.sim;
    const t = sim.gameplay.wanted.arrest;
    const stars = sim.wanted.stars;
    let progress = 0;
    if (stars > 0 && sim.player.alive && (sim.mode === 'onFoot' || sim.mode === 'driving')) {
      if (sim.mode === 'onFoot') {
        const firing = sim.tick - sim.lastFireTick < TICK_HZ;
        const near = this.units.some(u => u.onFoot && u.officer.alive && distanceXZ(u.officer.position, sim.player.position) <= t.footRadius);
        this.footArrestTicks = near && !firing ? this.footArrestTicks + 1 : 0;
        progress = this.footArrestTicks / (t.footSeconds * TICK_HZ);
        this.boxedTicks = 0;
      } else if (stars <= 2) {
        const pv = sim.playerVehicle!;
        const needed = Math.min(2, this.cap());
        const adjacent = this.units.filter(u => !u.onFoot && u.officer.alive && u.vehicle && distanceXZ(u.vehicle.position, pv.position) <= 6.5).length;
        this.boxedTicks = adjacent >= needed && pv.speed < 1 ? this.boxedTicks + 1 : 0;
        progress = this.boxedTicks / (t.boxedSeconds * TICK_HZ);
        this.footArrestTicks = 0;
      }
    } else { this.footArrestTicks = 0; this.boxedTicks = 0; }
    this.arrestProgress = Math.min(1, progress);
  }

  // ---- helpers ----

  private plan(u: PoliceUnit, target: V3): boolean {
    const v = u.vehicle;
    if (!v) return false;
    const roads = this.sim.world.roads;
    const f = v.forward;
    const fromAny = roads.nearestLane(v.position[0], v.position[2], [f[0], f[2]], 40);
    const from = fromAny && this.goodLaneIds.has(fromAny.laneId) ? fromAny : this.nearestGoodLane(v.position[0], v.position[2], 60) ?? fromAny;
    const to = this.nearestGoodLane(target[0], target[2], 70) ?? roads.nearestLane(target[0], target[2], undefined, 60);
    if (from && to) {
      const route = roads.route(from.laneId, from.s, to.laneId, to.s);
      if (route) {
        const pts = roads.routePoints(route);
        // Trim the end of the last lane after the target's projection.
        pts.push([to.point[0], to.point[1], to.point[2]]);
        u.driver.setRoute(pts, v.position, v.forward);
        return true;
      }
    }
    u.driver.setRoute([[v.position[0], v.position[1], v.position[2]], [target[0], target[1], target[2]]], v.position, v.forward);
    return false;
  }

  private laneSpeed(v: Vehicle): number {
    const f = v.forward;
    const lane = this.sim.world.roads.nearestLane(v.position[0], v.position[2], [f[0], f[2]], 20);
    return lane ? clamp(this.sim.world.roads.laneById.get(lane.laneId)!.speedLimit, 6, 14) : 8;
  }
}
