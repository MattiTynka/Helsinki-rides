// Police (plan section 8): patrol units with a car and one officer each. Units drive the road graph (route
// following with pure pursuit), pursue directly within sight, box a stopped car in, get out to arrest a player
// on foot, and return fire only after the player discharges a weapon in the current encounter.
// Caps per star come from the tuning table.
import { LaneSegmentIndex, pointAlong, type GameplayBundle, type LaneHit, type RoadIndex, type RoadLane, type Vec3 } from '@helsinki/world-schema';
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
/** Sight is lost on the second failed check in a row: one ray flickers on lamp posts and railings. */
const SIGHT_MISSES = 2;
/** An engaging officer holds the pistol up this long after last seeing the player. */
const AIM_HOLD_TICKS = 2 * TICK_HZ;
/** An officer on foot keeps engaging this long without sight before walking back to the car. */
const ENGAGE_GRACE_TICKS = 3 * TICK_HZ;
/** Outside police sight, but inside the player's 128m collision need ring, including the car footprint. */
export const POLICE_DISPATCH = Object.freeze({ minimumDistance: 96, maximumDistance: 124, recycleDistance: 240, abandonedVehicleDistance: 260 });
/**
 * While wanted, a unit is a local responder when it sees the player, is this close to the player or the incident, or
 * drives a planned route there no longer than `routeLength` and has moved `progress` metres within `stalledTicks`;
 * one that failed to plan `failedPlans` times, or is stuck on its route, is not.
 */
const LOCAL_RESPONSE = Object.freeze({ distance: 150, routeLength: 400, failedPlans: 2, progress: 10, stalledTicks: 6 * TICK_HZ });
/** A search first drives this many legs of this length along the reported direction of travel. */
const SEARCH_LEGS = 3;
const SEARCH_LEG_LENGTH = 50;
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
  /** Last requested destination survives a failed route, so retries can wait unless it moves. */
  requestedGoal: V3 | null = null;
  /** Failed plans in a row toward the current requested destination. */
  failedPlans = 0;
  /** Where the car was when it last moved `LOCAL_RESPONSE.progress` metres toward the current destination, and when. */
  progressAt: V3 | null = null;
  progressTick = 0;

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

  /** Distance still to drive along the route from `from`. */
  remainingLength(from: V3): number {
    if (this.finished) return 0;
    let total = distanceXZ(from, this.route[this.index]!);
    for (let i = this.index + 1; i < this.route.length; i++) total += distanceXZ(this.route[i - 1]!, this.route[i]!);
    return total;
  }

  /** Drive toward the route; returns true when the end is reached (within `stopDistance`). */
  drive(v: Vehicle, targetSpeed: number, stopDistance: number): boolean {
    if (this.finished) { v.input.throttle = 0; v.input.brake = 0.6; v.input.steer = 0; return true; }
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
  /** Consecutive failed sight checks; `sees` turns false at SIGHT_MISSES. */
  sightMisses = 0;
  /** Tick until which an engaging officer keeps the aimed posture. */
  aimUntil = -1;
  /** Holding the aimed posture this tick; published as the officer's aiming state. */
  aiming = false;
  fireTicks = 0;
  arrestTicks = 0;
  spawnIndex: number;
  searchTarget: V3 | null = null;
  /** Incident point the current search started from, and the search legs driven so far. */
  searchFrom: V3 | null = null;
  searchLegs = 0;
  /** Local incident point when dispatched; never follows an unseen player's subsequent movement. */
  dispatchTarget: V3 | null = null;
  /** Direction of travel reported with the dispatch incident. */
  dispatchHeading: readonly [number, number] | null = null;
  dispatchSeenTick = -1;
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

interface WellConnected { readonly lanes: readonly RoadLane[]; readonly index: LaneSegmentIndex }
const wellConnected = new WeakMap<RoadIndex, WellConnected>();

/**
 * Lanes from which at least 60% of the largest reachable set is reachable, in graph order. The reachable-set sizes are
 * exact (strongly connected components, then component bitsets in reverse topological order) and computed once per
 * road index: a breadth-first search from every lane took seconds on the full city graph.
 */
export function wellConnectedLanes(roads: RoadIndex): WellConnected {
  let result = wellConnected.get(roads);
  if (!result) {
    const sizes = reachableCounts(roads);
    const best = Math.max(0, ...sizes);
    const lanes = roads.graph.lanes.filter((_l, i) => sizes[i]! >= best * 0.6);
    result = { lanes, index: new LaneSegmentIndex(lanes) };
    wellConnected.set(roads, result);
  }
  return result;
}

const enterable = new WeakMap<RoadIndex, ReadonlySet<string>>();

/**
 * Lanes reachable from at least 60% of the largest set of lanes that reach any one lane: where a route can end. A lane
 * no connector leads into (a mapping gap; 927 of the city's 8604 lanes) can be routed from but never to.
 */
export function enterableLanes(roads: RoadIndex): ReadonlySet<string> {
  let result = enterable.get(roads);
  if (!result) {
    const sizes = reachableCounts(roads, true);
    const best = Math.max(0, ...sizes);
    result = new Set(roads.graph.lanes.filter((_l, i) => sizes[i]! >= best * 0.6).map(l => l.id));
    enterable.set(roads, result);
  }
  return result;
}

/** For each lane, the number of distinct graph nodes reachable along connectors (or, `reverse`, reaching it), itself included. */
export function reachableCounts(roads: RoadIndex, reverse = false): number[] {
  const ids = new Map<string, number>();
  const node = (id: string): number => { let i = ids.get(id); if (i === undefined) ids.set(id, i = ids.size); return i; };
  for (const lane of roads.graph.lanes) node(lane.id);
  const edges: number[][] = [];
  if (reverse) for (const [to, connectors] of roads.incoming) { const t = node(to); for (const c of connectors) (edges[t] ??= []).push(node(c.from)); }
  else for (const [from, connectors] of roads.outgoing) { const f = node(from); for (const c of connectors) (edges[f] ??= []).push(node(c.to)); }
  const n = ids.size;
  // Iterative Tarjan: components complete in reverse topological order (every successor component first).
  const order = new Int32Array(n).fill(-1), low = new Int32Array(n), component = new Int32Array(n).fill(-1);
  const stack: number[] = [], onStack = new Uint8Array(n), members: number[][] = [];
  let counter = 0;
  for (let root = 0; root < n; root++) {
    if (order[root] !== -1) continue;
    const frames: [number, number][] = [[root, 0]];
    order[root] = low[root] = counter++; stack.push(root); onStack[root] = 1;
    while (frames.length) {
      const frame = frames[frames.length - 1]!, v = frame[0], out = edges[v] ?? [];
      if (frame[1] < out.length) {
        const w = out[frame[1]++]!;
        if (order[w] === -1) { order[w] = low[w] = counter++; stack.push(w); onStack[w] = 1; frames.push([w, 0]); }
        else if (onStack[w]) low[v] = Math.min(low[v]!, order[w]!);
        continue;
      }
      frames.pop();
      if (frames.length) { const parent = frames[frames.length - 1]![0]; low[parent] = Math.min(low[parent]!, low[v]!); }
      if (low[v] === order[v]) {
        const list: number[] = [];
        let w: number;
        do { w = stack.pop()!; onStack[w] = 0; component[w] = members.length; list.push(w); } while (w !== v);
        members.push(list);
      }
    }
  }
  const words = Math.ceil(members.length / 32);
  const reach = members.map(() => new Uint32Array(words));
  const counts = new Float64Array(members.length);
  for (let c = 0; c < members.length; c++) {
    const bits = reach[c]!;
    bits[c >>> 5] = bits[c >>> 5]! | (1 << (c & 31));
    for (const v of members[c]!) for (const w of edges[v] ?? []) {
      const d = component[w]!;
      if (d === c) continue;
      const other = reach[d]!;
      for (let i = 0; i < words; i++) bits[i] = bits[i]! | other[i]!;
    }
    let total = 0;
    for (let i = 0; i < words; i++) for (let word = bits[i]!; word !== 0; word = (word & (word - 1)) >>> 0) total += members[(i << 5) + 31 - Math.clz32(word & -word)]!.length;
    counts[c] = total;
  }
  return roads.graph.lanes.map(lane => counts[component[ids.get(lane.id)!]!]!);
}

/**
 * Where a patrol starts from a content spawn: snapped to the nearest well-connected lane that runs the way the
 * content's heading points, so the car starts on a road it can route from and never has to turn round first
 * (reversing into the Cathedral terrace flipped cars).
 */
export function patrolSpawnPlacement(roads: RoadIndex, spawn: GameplayBundle['police']['patrolSpawns'][number]): { xz: [number, number]; yaw: number } {
  let yaw = headingToYaw(spawn.headingDeg);
  const dir: [number, number] = [Math.sin(yaw), Math.cos(yaw)];
  const lane = wellConnectedLanes(roads).index.nearest(spawn.position[0], spawn.position[1], dir, 80) ?? roads.nearestLane(spawn.position[0], spawn.position[1], dir, 40);
  let xz: [number, number] = [spawn.position[0], spawn.position[1]];
  if (lane) {
    xz = [lane.point[0], lane.point[2]];
    yaw = laneYawAt(roads.laneById.get(lane.laneId)!, lane.s);
  }
  return { xz, yaw };
}

/** Keep grade-separated roads distinct; nearest XZ alone can select the road beneath a bridge. Only `accept` lanes, if given. */
function laneAtLevel(roads: RoadIndex, position: V3, distance: number, heading?: [number, number], accept?: ReadonlySet<string>): LaneHit | null {
  const nearest = roads.nearestLane(position[0], position[2], heading, distance);
  if (nearest && Math.abs(nearest.point[1] - position[1]) <= 3 && (!accept || accept.has(nearest.laneId))) return nearest;
  // The ordinary spatial query is sufficient almost everywhere. Only stacked/off-road cases and unaccepted lanes need this scan.
  let best: LaneHit | null = null, score = Infinity;
  for (const lane of roads.graph.lanes) {
    if (accept && !accept.has(lane.id)) continue;
    let s = 0;
    for (let i = 1; i < lane.points.length; i++) {
      const a = lane.points[i - 1]!, b = lane.points[i]!, dx = b[0] - a[0], dz = b[2] - a[2], length = Math.hypot(dx, dz);
      const t = length ? clamp(((position[0] - a[0]) * dx + (position[2] - a[2]) * dz) / (length * length), 0, 1) : 0;
      const point: Vec3 = [a[0] + dx * t, a[1] + (b[1] - a[1]) * t, a[2] + dz * t], d = distanceXZ(point, position);
      const rank = d + (heading && length ? (1 - (dx * heading[0] + dz * heading[1]) / length) * 4 : 0);
      if (d <= distance && Math.abs(point[1] - position[1]) <= 3 && rank < score) { score = rank; best = { laneId: lane.id, s: s + length * t, point, distance: d }; }
      s += length;
    }
  }
  return best;
}

/** Where a route to `position` ends: the nearest lane at its level that routes can reach, else the nearest at all. */
function destinationLane(roads: RoadIndex, position: V3, distance: number): LaneHit | null {
  return laneAtLevel(roads, position, distance, undefined, enterableLanes(roads)) ?? laneAtLevel(roads, position, distance);
}

function connectedLaneIds(roads: RoadIndex, start: string, reverse: boolean): Set<string> {
  const reached = new Set([start]), queue = [start], edges = reverse ? roads.incoming : roads.outgoing;
  for (let i = 0; i < queue.length; i++) for (const edge of edges.get(queue[i]!) ?? []) {
    const next = reverse ? edge.from : edge.to;
    if (roads.laneById.has(next) && !reached.has(next)) { reached.add(next); queue.push(next); }
  }
  return reached;
}

export interface PoliceDispatchCandidate { readonly laneId: string; readonly s: number; readonly point: Vec3; readonly yaw: number }

/**
 * Local graph candidates only: points between `minimumDistance` and the dispatch maximum from `player`, on lanes that
 * lead to the response destination, never past it on its own lane. Physical support, residency and occupancy are
 * checked again when spawning. The destination is where routes end (`destinationLane`). When the lanes leading there
 * give no candidate (a small enterable piece beside an isolated street), the plain nearest lane at the level is
 * sampled instead, if it differs, and `plan()` then routes the car to the lane it can reach. At most two sampling passes
 * per call, each one reverse lane search, one lane filter and 72 nearest-lane queries, plus one nearest-lane lookup.
 * Spawning also samples the nearest lane when every preferred candidate is rejected (`dispatchPasses`).
 */
export function policeDispatchCandidates(roads: RoadIndex, player: V3, minimumDistance: number = POLICE_DISPATCH.minimumDistance): PoliceDispatchCandidate[] {
  const [preferred, nearest] = dispatchPasses(roads, player, minimumDistance);
  return preferred.length ? preferred : nearest();
}

/**
 * The two sampling passes of `policeDispatchCandidates`: the candidates toward the destination routes end on, and a
 * function that samples toward the plain nearest lane at the level only when called (none when that lane is the same).
 */
function dispatchPasses(roads: RoadIndex, player: V3, minimumDistance: number): [PoliceDispatchCandidate[], () => PoliceDispatchCandidate[]] {
  const preferred = destinationLane(roads, player, 70);
  if (!preferred) return [[], () => []];
  return [dispatchCandidatesTo(roads, player, preferred, minimumDistance), () => {
    const nearest = laneAtLevel(roads, player, 70);
    return nearest && (nearest.laneId !== preferred.laneId || nearest.s !== preferred.s) ? dispatchCandidatesTo(roads, player, nearest, minimumDistance) : [];
  }];
}

/** One sampling pass of `policeDispatchCandidates` toward `target`. */
function dispatchCandidatesTo(roads: RoadIndex, player: V3, target: LaneHit, minimumDistance: number): PoliceDispatchCandidate[] {
  const reachable = connectedLaneIds(roads, target.laneId, true), radius = POLICE_DISPATCH.maximumDistance;
  const lanes = roads.graph.lanes.filter(l => reachable.has(l.id) && l.length >= 8 && l.points.some((p, i) => {
    const a = l.points[Math.max(0, i - 1)]!;
    return Math.min(a[0], p[0]) <= player[0] + radius + 18 && Math.max(a[0], p[0]) >= player[0] - radius - 18
      && Math.min(a[2], p[2]) <= player[2] + radius + 18 && Math.max(a[2], p[2]) >= player[2] - radius - 18;
  }));
  const index = new LaneSegmentIndex(lanes), result: PoliceDispatchCandidate[] = [];
  for (const r of [radius - 4, minimumDistance + 4, (minimumDistance + radius) / 2]) for (let i = 0; i < 24; i++) {
    const angle = i * Math.PI / 12, dx = Math.sin(angle), dz = Math.cos(angle);
    const hit = index.nearest(player[0] + dx * r, player[2] + dz * r, [-dx, -dz], 18);
    if (!hit) continue;
    const lane = roads.laneById.get(hit.laneId)!, s = clamp(hit.s, 4, lane.length - 4), { point, tangent } = pointAlong(lane.points, s), d = distanceXZ(point, player);
    if (d < minimumDistance || d > radius || (lane.id === target.laneId && s > target.s)) continue;
    if (result.some(c => distanceXZ(c.point, point) < 8)) continue;
    result.push({ laneId: lane.id, s, point, yaw: Math.atan2(tangent[0], tangent[1]) });
  }
  return result;
}

export class PoliceForce {
  readonly sim: Simulation;
  readonly units: PoliceUnit[] = [];
  playerSeen = false;
  arrestProgress = 0;
  /** Historical content/inspection query; local dispatch does not discard smaller districts. */
  readonly goodLanes: readonly RoadLane[];
  private serial = 0;
  private boxedTicks = 0;
  private footArrestTicks = 0;
  private respawnTicks = 0;
  /** Cars protected by player ownership/entry outlive their retired unit, but still need bounded retirement. */
  private readonly retainedVehicles = new Map<string, Vehicle>();

  constructor(sim: Simulation) {
    this.sim = sim;
    this.goodLanes = wellConnectedLanes(sim.world.roads).lanes;
  }

  /** Nearest well-connected lane to a point, preferring lanes that run along `heading` (unit XZ) when given. */
  nearestGoodLane(x: number, z: number, maxDistance: number, heading?: [number, number]): LaneHit | null {
    return wellConnectedLanes(this.sim.world.roads).index.nearest(x, z, heading, maxDistance);
  }

  states(): PoliceUnitState[] {
    return this.units.map(u => ({ id: u.id, state: u.state, vehicleId: u.vehicle?.id ?? null, officerId: u.officer.id, seesPlayer: u.sees, onFoot: u.onFoot }));
  }

  /**
   * Failed requests, retry deadlines, sight memory, a held aim, and where a search started and leads and the dispatch
   * incident and its heading affect later ticks even while every car is stopped.
   */
  routingDigest(): string {
    const point = (p: readonly number[] | null) => p?.map(n => n.toFixed(3)).join(',') ?? '-';
    return [...this.units].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(u =>
      `${u.id}:${point(u.driver.requestedGoal)}:${u.driver.replanTicks}:${u.driver.failedPlans}:${point(u.driver.progressAt)}:${u.driver.progressTick}:${u.searchLegs}:${Number(u.sees)}:${u.sightMisses}:${u.aimUntil}`
      + `:${u.sightTicks}:${point(u.searchFrom)}:${point(u.searchTarget)}:${point(u.dispatchTarget)}:${point(u.dispatchHeading)}`).join('|');
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
    this.respawnTicks = 0;
    this.spawnInitial();
  }

  private cap(): number {
    const stars = this.sim.wanted.stars;
    if (stars <= 0) return this.sim.gameplay.police.initialPatrols;
    const caps = this.sim.gameplay.wanted.unitCaps;
    return caps[Math.min(stars, caps.length) - 1] ?? caps[caps.length - 1] ?? 1;
  }

  /**
   * A new unit on a qualified placement: in the ring, behind the view, clear of cars and physically supported. The
   * preferred candidates are tried first, from one random start in their order. Only when none qualifies are the plain
   * nearest lane's candidates sampled and tried the same way, without the placements already tried; that pass alone may
   * draw a second random start. At most two sampling passes and 144 placements per attempt. Null when none qualifies;
   * a unit being replaced is removed only once its replacement car exists.
   */
  private spawnUnit(replace?: PoliceUnit): PoliceUnit | null {
    const player = this.sim.playerPosition;
    const incident = this.sim.wanted.stars > 0 ? this.sim.wanted.lastSeen : player;
    if (!incident) return null;
    // Responders enter at the inner edge of the ring, as close as sight allows; the content's larger
    // distance is for patrols that are not answering an incident.
    const minimum = this.sim.wanted.stars > 0 ? POLICE_DISPATCH.minimumDistance
      : clamp(this.sim.gameplay.police.spawnMinDistance, POLICE_DISPATCH.minimumDistance, POLICE_DISPATCH.maximumDistance - 12);
    const [preferred, nearest] = dispatchPasses(this.sim.world.roads, incident, minimum);
    const id = `police-${this.serial + 1}`;
    let vehicle: Vehicle | null = null, yaw = 0;
    const viewYaw = this.sim.tick ? this.sim.lastCommand.yaw : this.sim.player.yaw;
    for (let pass = 0; pass < 2 && !vehicle; pass++) {
      const candidates = pass === 0 ? preferred : nearest().filter(c => !preferred.some(p => p.laneId === c.laneId && p.s === c.s));
      // Rotate a deterministic candidate order; rejection never falls back to an unqualified coordinate.
      const first = candidates.length ? Math.floor(this.sim.rng.range(0, candidates.length)) : 0;
      for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[(first + i) % candidates.length]!;
        const playerDistance = distanceXZ(candidate.point, player);
        // The player's true position only controls visibility/residency, never the response destination.
        // An obsolete remote incident must not create a distant unit that immediately recycles again.
        if (playerDistance < minimum || playerDistance > POLICE_DISPATCH.recycleDistance) continue;
        // New cars enter from behind the view, rather than materializing on the street being watched.
        if ((candidate.point[0] - player[0]) * Math.sin(viewYaw) + (candidate.point[2] - player[2]) * Math.cos(viewYaw) > 0) continue;
        if ([...this.sim.vehicles.values()].some(v => distanceXZ(v.position, candidate.point) < 12)) continue;
        vehicle = this.sim.trySpawnVehicle(`${id}-car`, 'patrol', [candidate.point[0], candidate.point[2]], candidate.yaw, candidate.point[1]);
        if (vehicle) { yaw = candidate.yaw; break; }
      }
    }
    if (!vehicle) return null;
    this.serial++;
    // The replacement is already physically qualified. Never delete an old unit merely because a local cell is late.
    if (replace) this.removeUnit(replace);
    const officer = this.sim.spawnCharacter(`${id}-officer`, vehicle.position, yaw, OFFICER_HEALTH);
    officer.inVehicle = vehicle.id;
    officer.hide();
    vehicle.driver = officer.id;
    vehicle.occupants.add(officer.id);
    vehicle.lightsOn = true;
    const unit = new PoliceUnit(id, vehicle, officer, this.serial);
    if (this.sim.wanted.stars > 0) {
      unit.dispatchTarget = [...incident];
      unit.dispatchHeading = this.sim.wanted.lastSeenHeading;
      unit.dispatchSeenTick = this.sim.wanted.lastSeenTick;
    }
    this.units.push(unit);
    this.sim.emit('policeSpawn', id);
    return unit;
  }

  private removeUnit(u: PoliceUnit): void {
    const i = this.units.indexOf(u);
    if (i >= 0) this.units.splice(i, 1);
    if (u.vehicle) {
      if (!this.sim.removeVehicle(u.vehicle) && this.sim.vehicles.get(u.vehicle.id) === u.vehicle) this.retainedVehicles.set(u.vehicle.id, u.vehicle);
      else this.retainedVehicles.delete(u.vehicle.id);
    }
    this.sim.removeCharacter(u.officer);
    this.sim.emit('policeDespawn', u.id);
  }

  /**
   * While wanted: whether this unit answers the incident soon. A unit that cannot route there (one-way cuts, bridges,
   * district edges), only by a long detour, or is stuck on the way leaves a theft unanswered, so the force replaces it
   * with a local responder.
   */
  private respondsLocally(u: PoliceUnit): boolean {
    const sim = this.sim, incident = u.dispatchTarget ?? sim.wanted.lastSeen;
    if (u.state === 'disabled') return false;
    if (u.sees || !incident || !u.vehicle || u.onFoot || u.state !== 'respond') return true;
    if (distanceXZ(u.position, sim.playerPosition) <= LOCAL_RESPONSE.distance || distanceXZ(u.position, incident) <= LOCAL_RESPONSE.distance) return true;
    // Not planned toward this incident yet: its next respond tick decides.
    if (!u.driver.requestedGoal || distanceXZ(u.driver.requestedGoal, incident) > 15) return true;
    if (u.driver.goal === null) return u.driver.failedPlans < LOCAL_RESPONSE.failedPlans;
    return u.driver.remainingLength(u.vehicle.position) <= LOCAL_RESPONSE.routeLength && sim.tick - u.driver.progressTick <= LOCAL_RESPONSE.stalledTicks;
  }

  private canRetireFarUnit(u: PoliceUnit, distance: number): boolean {
    const sim = this.sim;
    return !u.sees && distanceXZ(u.position, sim.playerPosition) > distance
      && (!u.vehicle || u.vehicle.id === sim.player.inVehicle || u.vehicle.id === sim.vehicleInteraction?.vehicleId
        || distanceXZ(u.vehicle.position, sim.playerPosition) > distance);
  }

  private retireAbandonedVehicles(): void {
    for (const [id, vehicle] of this.retainedVehicles) {
      const sim = this.sim;
      if (sim.vehicles.get(id) !== vehicle) { this.retainedVehicles.delete(id); continue; }
      if (vehicle.driver || vehicle.occupants.size || sim.player.inVehicle === id || sim.vehicleInteraction?.vehicleId === id) continue;
      const p = vehicle.position, distance = distanceXZ(p, sim.playerPosition);
      const t = sim.world.terrain, b = sim.gameplay.playArea;
      const inside = p[0] >= Math.max(b.minX, t.x0) && p[0] <= Math.min(b.maxX, t.x0 + (t.nx - 1) * t.resolution)
        && p[2] >= Math.max(b.minZ, t.z0) && p[2] <= Math.min(b.maxZ, t.z0 + (t.nz - 1) * t.resolution);
      // An off-map body can retire sooner, but a car visible beside the map edge must not pop away.
      if (distance <= POLICE_DISPATCH.abandonedVehicleDistance && (inside || distance <= DESPAWN_DISTANCE)) continue;
      if (sim.removeVehicle(vehicle)) this.retainedVehicles.delete(id);
    }
  }

  /** Decisions and driving/walking inputs; runs before the physics step. */
  step(): void {
    const sim = this.sim;
    const stars = sim.wanted.stars;
    this.retireAbandonedVehicles();
    // Keep the force at the cap for the current star level.
    const cap = this.cap();
    if (this.respawnTicks > 0) this.respawnTicks--;
    if (this.respawnTicks === 0 && cap > 0) {
      // A wanted player always gets a local responder: with none, the farthest unit out of sight is replaced.
      const player = sim.playerPosition;
      const remote = stars > 0 && !this.units.some(u => this.respondsLocally(u))
        ? this.units.filter(u => this.canRetireFarUnit(u, LOCAL_RESPONSE.distance))
          .sort((a, b) => distanceXZ(b.position, player) - distanceXZ(a.position, player))[0]
        : undefined;
      const stale = this.units.find(u => this.canRetireFarUnit(u, POLICE_DISPATCH.recycleDistance)) ?? remote;
      if (this.units.length < cap || stale) {
        const spawned = this.spawnUnit(this.units.length >= cap ? stale : undefined);
        this.respawnTicks = Math.round((spawned ? stars > 0 ? 2.5 : 8 : .25) * TICK_HZ);
      }
    }
    for (const u of [...this.units]) {
      u.stateTicks++;
      u.aiming = false;
      if (u.fireTicks > 0) u.fireTicks--;
      if (!u.officer.alive) { this.officerDown(u); continue; }
      if (u.vehicle && (u.vehicle.damage === 'wrecked')) { u.vehicle.sirenOn = false; if (!u.onFoot) this.leaveCar(u); }
      this.updateSight(u);
      this.decide(u, stars);
      this.act(u, stars);
    }
    // A lower wanted cap retires only surplus units already outside sight.
    if (this.units.length > cap) {
      for (const u of [...this.units]) {
        if (this.units.length <= cap) break;
        if (this.canRetireFarUnit(u, DESPAWN_DISTANCE)) this.removeUnit(u);
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
    if (!sim.player.alive || sim.mode === 'wasted' || sim.mode === 'busted') { u.sees = false; u.sightMisses = 0; return; }
    // Stagger ray casts: each unit checks every 3 ticks.
    if ((sim.tick + u.spawnIndex) % 3 !== 0) return;
    const eye: V3 = u.onFoot ? u.officer.eye : [u.vehicle!.position[0], u.vehicle!.position[1] + 1.3, u.vehicle!.position[2]];
    const pv = sim.playerVehicle;
    // A post can cover the head alone; the chest is a second look before this check counts as a miss.
    const targets: V3[] = pv ? [[pv.position[0], pv.position[1] + 0.9, pv.position[2]]] : [sim.player.head, sim.player.centre];
    const range = u.onFoot ? SIGHT_RANGE_FOOT : SIGHT_RANGE_CAR;
    if (targets.some(target => this.clearLine(u, eye, target, range))) { u.sees = true; u.sightMisses = 0; u.sightTicks = sim.tick; }
    else if (++u.sightMisses >= SIGHT_MISSES) u.sees = false;
  }

  private clearLine(u: PoliceUnit, eye: V3, target: V3, range: number): boolean {
    const dx = target[0] - eye[0], dy = target[1] - eye[1], dz = target[2] - eye[2];
    const dist = Math.hypot(dx, dy, dz);
    if (dist > range) return false;
    const ray = new RAPIER.Ray({ x: eye[0], y: eye[1], z: eye[2] }, { x: dx / dist, y: dy / dist, z: dz / dist });
    return !this.sim.world.physics.castRay(ray, dist - 0.5, true, undefined, groups(GROUP.bullet, GROUP.static), undefined, u.vehicle?.body);
  }

  private decide(u: PoliceUnit, stars: number): void {
    const sim = this.sim;
    const playerPos = sim.playerPosition;
    const d = distanceXZ(u.position, playerPos);
    const playerOnFoot = !sim.playerVehicle;
    if (stars === 0) {
      u.dispatchTarget = null;
      if (u.state !== 'patrol' && u.state !== 'return') u.setState('patrol');
      return;
    }
    if (u.dispatchTarget && (u.sees || sim.wanted.lastSeenTick > u.dispatchSeenTick)) {
      u.dispatchTarget = null;
      u.searchTarget = null;
      u.driver.replanTicks = 0;
    }
    const lastSeen = u.dispatchTarget ?? sim.wanted.lastSeen;
    if (u.onFoot) {
      // Officers on foot engage while the player is near, otherwise walk back to the car. An engaged officer
      // keeps engaging through a few seconds unseen, so a lamp post in between does not turn them round.
      const engaged = u.state === 'engage' && sim.tick - u.sightTicks < ENGAGE_GRACE_TICKS;
      if (playerOnFoot && (u.sees || d < 12 || engaged) && d < ENGAGE_RANGE * 1.6) u.setState('engage');
      else u.setState('return');
      return;
    }
    if (u.sees) {
      if (playerOnFoot && d < ENGAGE_RANGE) u.setState('engage');
      else if (!playerOnFoot && sim.playerSpeed < 3 && d < 18 && stars <= 2) u.setState('boxin');
      else u.setState('pursue');
    } else if (lastSeen) {
      if (u.state === 'pursue' && sim.tick - u.sightTicks < 3 * TICK_HZ) return; // keep chasing briefly
      // A search goes on around the point it started from, legs included; a newer incident elsewhere ends it.
      const continuing = u.state === 'search' && u.searchFrom !== null && distanceXZ(u.searchFrom, lastSeen) < 25;
      const searching = sim.wanted.searching && (continuing || distanceXZ(u.position, lastSeen) < 25);
      if (searching && u.state !== 'search') { u.searchFrom = [...lastSeen]; u.searchLegs = 0; u.searchTarget = null; }
      u.setState(searching ? 'search' : 'respond');
    } else u.setState('patrol');
  }

  private act(u: PoliceUnit, stars: number): void {
    const sim = this.sim;
    const v = u.vehicle;
    if (v) v.sirenOn = stars > 0 && u.state !== 'patrol' && u.state !== 'return' && !u.onFoot;
    switch (u.state) {
      case 'patrol': this.patrol(u); break;
      case 'respond': this.driveTo(u, u.dispatchTarget ?? sim.wanted.lastSeen ?? u.position, 20, 6); break;
      case 'pursue': this.pursue(u); break;
      case 'boxin': this.boxIn(u); break;
      case 'search': this.search(u); break;
      case 'engage': this.engage(u); break;
      case 'return': this.returnToCar(u); break;
      case 'disabled': break;
    }
  }

  // ---- behaviours ----

  private patrol(u: PoliceUnit): void {
    const v = u.vehicle;
    if (!v || u.onFoot) { this.returnToCar(u); return; }
    const sim = this.sim;
    // A reached destination starts the next beat immediately. An empty failed plan has no
    // goal and must wait: retrying eight city routes on every 60 Hz tick caused stalls.
    if ((u.driver.finished && u.driver.goal !== null) || u.driver.replanTicks <= 0) {
      const here = laneAtLevel(sim.world.roads, v.position, 30, [v.forward[0], v.forward[2]]);
      const reachable = here ? connectedLaneIds(sim.world.roads, here.laneId, false) : new Set<string>();
      const lanes = sim.world.roads.graph.lanes.filter(l => reachable.has(l.id) && distanceXZ(l.points[l.points.length - 1]!, v.position) <= 350);
      if (!u.firstBeatDone) {
        // A fresh patrol first drives the length of its own street (the beat), then roams at random.
        u.firstBeatDone = true;
        const name = here ? sim.world.roads.laneById.get(here.laneId)!.name : null;
        let best: RoadLane | null = null, bestD = 0;
        for (const l of lanes) {
          if (!name || l.name !== name) continue;
          const d = distanceXZ(l.points[l.points.length - 1]!, v.position);
          if (d > bestD) { bestD = d; best = l; }
        }
        if (best) { const p = best.points[best.points.length - 1]!; this.plan(u, [p[0], p[1], p[2]]); }
      }
      if (u.driver.finished && lanes.length) {
        for (let tries = 0; tries < 8; tries++) {
          const lane = sim.rng.pick(lanes);
          const p = lane.points[lane.points.length - 1]!;
          if (distanceXZ(p, v.position) < 40) continue;
          if (this.plan(u, [p[0], p[1], p[2]])) break;
        }
      }
      // No candidates must also clear the previous completed goal, otherwise it bypasses
      // the cooldown on the next tick just like a newly completed successful route.
      if (u.driver.finished) u.driver.setRoute([], v.position);
      u.driver.replanTicks = (u.driver.finished ? 2 : 20) * TICK_HZ;
    }
    u.driver.replanTicks--;
    const lane = this.laneSpeed(v);
    u.driver.drive(v, lane, 4);
  }

  private driveTo(u: PoliceUnit, target: V3, speed: number, stopDistance: number): boolean {
    const v = u.vehicle;
    if (!v || u.onFoot) { this.returnToCar(u); return false; }
    if (u.driver.replanTicks <= 0 || !u.driver.requestedGoal || distanceXZ(u.driver.requestedGoal, target) > 15) {
      this.plan(u, target);
      u.driver.replanTicks = 2 * TICK_HZ;
    }
    u.driver.replanTicks--;
    const arrived = u.driver.drive(v, speed, stopDistance);
    if (!u.driver.progressAt || distanceXZ(v.position, u.driver.progressAt) > LOCAL_RESPONSE.progress) {
      u.driver.progressAt = [...v.position]; u.driver.progressTick = this.sim.tick;
    }
    return arrived;
  }

  private pursue(u: PoliceUnit): void {
    const v = u.vehicle;
    if (!v || u.onFoot) { this.returnToCar(u); return; }
    const sim = this.sim;
    const target = u.sees ? sim.playerPosition : u.dispatchTarget ?? sim.wanted.lastSeen ?? u.position;
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
    const centre = u.dispatchTarget ?? sim.wanted.lastSeen ?? u.position;
    if (!u.searchTarget || u.driver.finished || u.driver.replanTicks <= 0) {
      const r = sim.gameplay.wanted.searchRadius;
      const spin = sim.rng.range(0, Math.PI * 2), reach = sim.rng.range(r * 0.3, r);
      const heading = u.dispatchTarget ? u.dispatchHeading : sim.wanted.lastSeenHeading;
      // A report says which way the suspect went: drive that way first, nearest first and within 30° of it,
      // then search around the point. The unseen player's true position is never used.
      const along = heading !== null && u.searchLegs < SEARCH_LEGS;
      const a = along ? Math.atan2(heading[0], heading[1]) + (spin / Math.PI - 1) * Math.PI / 6 : spin;
      const rr = along ? SEARCH_LEG_LENGTH * (u.searchLegs + 1) : reach;
      u.searchLegs++;
      const lane = sim.world.roads.nearestLane(centre[0] + Math.sin(a) * rr, centre[2] + Math.cos(a) * rr, undefined, 60);
      u.searchTarget = lane ? [lane.point[0], lane.point[1], lane.point[2]] : [centre[0], centre[1], centre[2]];
      this.plan(u, u.searchTarget);
      u.driver.replanTicks = 12 * TICK_HZ;
    }
    u.driver.replanTicks--;
    u.driver.drive(v, 12, 5);
  }

  private engage(u: PoliceUnit): void {
    const sim = this.sim;
    if (!u.onFoot) { this.leaveCar(u); return; }
    const officer = u.officer;
    const player = sim.player;
    const target = player.position;
    const d = distanceXZ(officer.position, target);
    const dir = normalize([target[0] - officer.position[0], 0, target[2] - officer.position[2]]);
    officer.turnToward(Math.atan2(dir[0], dir[2]), 10);
    const shooting = sim.policeMayFire;
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
    // Aim is an upper-body overlay: native locomotion still uses measured speed for the moving legs.
    // The pistol stays up between shots and through short sight losses; it lowers on surrender, after
    // AIM_HOLD_TICKS unseen, or out of pistol range.
    if (!shooting) u.aimUntil = -1;
    else if (u.sees) u.aimUntil = sim.tick + AIM_HOLD_TICKS;
    u.aiming = shooting && sim.tick < u.aimUntil && d < 40;
    officer.clip = u.aiming ? 'aim' : speed > 4.8 ? 'sprint' : speed > 2 ? 'run' : speed !== 0 ? 'walk' : 'idle';
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

  /**
   * Route the unit's car to `target`, ending on `destinationLane()`; when no route reaches that lane, on the nearest
   * lane at the target's level that this car's lane leads to. At most two route searches and one pass over the lanes
   * reachable from the car. A failure leaves an empty route (the car brakes) and counts toward `failedPlans`.
   */
  private plan(u: PoliceUnit, target: V3): boolean {
    const v = u.vehicle;
    if (!v) return false;
    if (!u.driver.requestedGoal || distanceXZ(u.driver.requestedGoal, target) > 15) {
      u.driver.failedPlans = 0; u.driver.progressAt = [...v.position]; u.driver.progressTick = this.sim.tick;
    }
    u.driver.requestedGoal = [...target];
    const roads = this.sim.world.roads;
    const f = v.forward;
    const from = laneAtLevel(roads, v.position, 40, [f[0], f[2]]);
    let to = destinationLane(roads, target, 70);
    if (from && to) {
      let route = roads.route(from.laneId, from.s, to.laneId, to.s);
      if (!route) {
        // The nearest enterable lane can lie in a part of the network this car cannot reach, beside a smaller or
        // one-way piece that it can: end on the nearest lane of those this car's lane leads to. The same lane and
        // offset as the failed search would fail again, so it is not searched twice.
        const near = laneAtLevel(roads, target, 70, undefined, connectedLaneIds(roads, from.laneId, false));
        if (near && (near.laneId !== to.laneId || near.s !== to.s)) { to = near; route = roads.route(from.laneId, from.s, to.laneId, to.s); }
      }
      if (route) {
        const pts = roads.routePoints(route.slice(0, -1));
        // routePoints returns whole lanes: leaving the last lane intact drove past the target, then doubled back.
        const lastLane = roads.laneById.get(to.laneId)!;
        let s = 0;
        for (let i = 0; i < lastLane.points.length; i++) {
          if (i) s += distanceXZ(lastLane.points[i - 1]!, lastLane.points[i]!);
          if (s >= to.s) break;
          pts.push(lastLane.points[i]!);
        }
        pts.push([to.point[0], to.point[1], to.point[2]]);
        u.driver.setRoute(pts, v.position, v.forward);
        u.driver.failedPlans = 0;
        return true;
      }
    }
    // A missing connector is not permission to drive across the intervening water, wall or road level.
    u.driver.setRoute([], v.position, v.forward);
    u.driver.failedPlans++;
    return false;
  }

  private laneSpeed(v: Vehicle): number {
    const f = v.forward;
    const lane = this.sim.world.roads.nearestLane(v.position[0], v.position[2], [f[0], f[2]], 20);
    return lane ? clamp(this.sim.world.roads.laneById.get(lane.laneId)!.speedLimit, 6, 14) : 8;
  }
}
