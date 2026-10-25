import { pointAlong, polylineLength, type RoadGraph, type Vec3 } from '@helsinki/world-schema';
import { CHARACTER, type Character, type CharacterClip } from './character.ts';
import { TICK_HZ, TICK_SECONDS } from './commands.ts';
import { clamp, distanceXZ, fnv1a, wrapAngle, type V3 } from './math.ts';
import type { Simulation } from './simulation.ts';
import { GROUP, groups, RAPIER, type StaticWorld } from './world.ts';

export const CIVILIAN_VARIANTS = ['rain-black', 'rain-white', 'snow-black', 'agent47'] as const;
export type CivilianVariant = typeof CIVILIAN_VARIANTS[number];
export interface PedestrianKnockdown {
  readonly elapsed: number;
  readonly fallSeconds: number;
  readonly holdSeconds: number;
  readonly riseSeconds: number;
}
export const CIVILIAN_KNOCKDOWN = { fallSeconds: 1.4, holdSeconds: 0.6, riseSeconds: 1.6 } as const;
export const PEDESTRIANS = {
  target: 8, spawnMin: 24, spawnMax: 108, retireDistance: 180,
  walkAcceleration: 2, turnAlignment: 0.12,
  refreshTicks: 2 * TICK_HZ, birthsPerRefresh: 2, attemptsPerRefresh: 40,
  spacing: 7, groundCheckTicks: 6, retryTicks: 8 * TICK_HZ,
  corpseMinimumTicks: 20 * TICK_HZ, corpseMaximumTicks: 120 * TICK_HZ,
} as const;

/** Explicit appearance identity: police IDs and arbitrary NPCs never become civilians accidentally. */
export function civilianVariant(id: string): CivilianVariant | null {
  for (const variant of CIVILIAN_VARIANTS) if (id.startsWith(`civilian-${variant}-`) && /^\d+$/.test(id.slice(variant.length + 10))) return variant;
  return null;
}

export interface PedestrianRoute {
  readonly id: string;
  readonly points: readonly Vec3[];
  readonly length: number;
  readonly source: 'footway' | 'street-edge';
}

interface RouteSegment { readonly a: Vec3; readonly b: Vec3; readonly s: number; readonly length: number }
const routeSegments = new WeakMap<readonly Vec3[], readonly RouteSegment[]>();
const ROUTE_PROJECTION_REACH = 2;

/** Actual route progress, without counting lateral collision corrections as forward travel. */
export function pedestrianRouteCoordinate(points: readonly Vec3[], position: Vec3, previous: number): number {
  let segments = routeSegments.get(points);
  if (!segments) {
    const compiled: RouteSegment[] = [];
    let s = 0;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!, b = points[i]!, length = Math.hypot(b[0] - a[0], b[2] - a[2]);
      if (length > 0) compiled.push({ a, b, s, length });
      s += length;
    }
    segments = compiled; routeSegments.set(points, segments);
  }
  const minS = Math.max(0, previous - ROUTE_PROJECTION_REACH), maxS = previous + ROUTE_PROJECTION_REACH;
  // Only the local arc may qualify. A nearby crossing on a distant part of the same route
  // cannot skip an endpoint, and long footways do not require a per-tick full-route search.
  let lo = 0, hi = segments.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1, segment = segments[mid]!;
    if (segment.s + segment.length < minS) lo = mid + 1; else hi = mid;
  }
  let bestS = previous, bestDistance = Infinity;
  for (let i = lo; i < segments.length; i++) {
    const segment = segments[i]!;
    if (segment.s > maxS) break;
    const { a, b, s, length } = segment, dx = b[0] - a[0], dz = b[2] - a[2];
    const t = clamp(((position[0] - a[0]) * dx + (position[2] - a[2]) * dz) / (length * length),
      Math.max(0, (minS - s) / length), Math.min(1, (maxS - s) / length));
    const coordinate = s + t * length;
    const distance = (a[0] + t * dx - position[0]) ** 2 + (a[2] + t * dz - position[2]) ** 2;
    if (distance < bestDistance || (distance === bestDistance && Math.abs(coordinate - previous) < Math.abs(bestS - previous))) {
      bestDistance = distance; bestS = coordinate;
    }
  }
  return bestS;
}

/** Proposals only. Native support and all nearby traffic lanes must qualify before birth or movement. */
export function cityPedestrianRoutes(roads: RoadGraph): PedestrianRoute[] {
  const routes: PedestrianRoute[] = [];
  for (const footway of roads.footways) {
    if (footway.points.length < 2 || !footway.points.every(p => p.every(Number.isFinite))) continue;
    const length = polylineLength(footway.points);
    if (length >= 12) routes.push({ id: `footway:${footway.id}`, points: footway.points, length, source: 'footway' });
  }
  // Some municipal districts have street lanes but no separately mapped sidewalks. Their outside margins
  // are proposals, not invented walkable surfaces; every step still needs real ground and capsule clearance.
  for (const lane of roads.lanes) {
    if (!['residential', 'unclassified', 'service', 'tertiary', 'secondary', 'primary'].includes(lane.highway)
      || lane.index !== lane.count - 1 || !(lane.width > 0)) continue;
    for (let i = 1; i < lane.points.length; i++) {
      const a = lane.points[i - 1]!, b = lane.points[i]!, dx = b[0] - a[0], dz = b[2] - a[2], length = Math.hypot(dx, dz);
      if (length < 32 || !a.every(Number.isFinite) || !b.every(Number.isFinite)) continue;
      const offset = lane.width / 2 + 3.1, trim = 9;
      const at = (s: number): Vec3 => [a[0] + dx * s / length - dz * offset / length,
        a[1] + (b[1] - a[1]) * s / length, a[2] + dz * s / length + dx * offset / length];
      routes.push({ id: `street-edge:${lane.id}:${i}`, points: [at(trim), at(length - trim)], length: length - 2 * trim, source: 'street-edge' });
    }
  }
  return routes;
}

const RADIUS = CHARACTER.radius + 0.06;
const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const GRID = 32;
const gridKey = (x: number, z: number): string => `${Math.floor(x / GRID)},${Math.floor(z / GRID)}`;
interface TrafficSegment { readonly a: Vec3; readonly b: Vec3; readonly radius: number }
interface Slot { readonly id: string; readonly route: PedestrianRoute; readonly s: number; readonly position: Vec3 }
interface Walker {
  readonly character: Character;
  readonly slot: string;
  readonly route: PedestrianRoute;
  readonly speed: number;
  s: number;
  direction: number;
  waitUntil: number;
  blockedTicks: number;
  nextGroundTick: number;
  safeAhead: boolean;
  lastHealth: number;
  knockdownTick: number | null;
}

/** Native ground on the recorded level, with complete capsule-width support; never a heightfield fallback. */
export function pedestrianGround(world: StaticWorld, point: Vec3, excludeBody?: RAPIER.RigidBody): V3 | null {
  const [x, expectedY, z] = point, area = world.gameplay.playArea, t = world.terrain;
  if (!point.every(Number.isFinite)) return null;
  const heights: number[] = [];
  for (const [dx, dz] of [[0, 0], [RADIUS, 0], [-RADIUS, 0], [0, RADIUS], [0, -RADIUS]]) {
    const px = x + dx!, pz = z + dz!;
    if (px <= Math.max(area.minX, t.x0) || px >= Math.min(area.maxX, t.x0 + (t.nx - 1) * t.resolution)
      || pz <= Math.max(area.minZ, t.z0) || pz >= Math.min(area.maxZ, t.z0 + (t.nz - 1) * t.resolution) || !world.queryable(px, pz)) return null;
    const hit = world.spawnGroundBelow(px, expectedY + 1.5, pz, 3);
    if (!hit || hit.normalY < 0.8 || !hit.surface || !['ground', 'kerbs'].includes(hit.surface.group)
      || /water|sea|ocean|railway|tram/i.test(hit.surface.tag) || Math.abs(hit.y - expectedY) > 1.2
      || hit.y < world.gameplay.killHeight + 2) return null;
    heights.push(hit.y);
  }
  const high = Math.max(...heights);
  if (high - Math.min(...heights) > 0.28) return null;
  const blocked = world.physics.intersectionWithShape({ x, y: high + CHARACTER.halfHeight + RADIUS + 0.04, z }, IDENTITY,
    new RAPIER.Capsule(CHARACTER.halfHeight, RADIUS), undefined,
    groups(GROUP.character, GROUP.static | GROUP.vehicle | GROUP.character), undefined, excludeBody);
  return blocked ? null : [x, high, z];
}

/** A small local population, not one actor per map route. Distant bodies and all death bookkeeping retire. */
export class Pedestrians {
  private readonly sim: Simulation;
  private readonly variants: readonly CivilianVariant[];
  private readonly slots = new Map<string, Slot[]>();
  private readonly traffic = new Map<string, TrafficSegment[]>();
  private readonly active = new Map<string, Walker>();
  private readonly unavailableUntil = new Map<string, number>();
  private serial = 0;
  private cursor = 0;

  constructor(sim: Simulation, variants: readonly CivilianVariant[] = CIVILIAN_VARIANTS) {
    this.sim = sim;
    this.variants = [...new Set(variants)];
    if (!this.variants.length) return;
    for (const route of cityPedestrianRoutes(sim.world.roads.graph)) {
      for (let s = 4; s <= route.length - 4; s += 18) {
        const slot = { id: `${route.id}:${s}`, route, s, position: pointAlong(route.points, s).point };
        this.bucket(this.slots, gridKey(slot.position[0], slot.position[2])).push(slot);
      }
    }
    const roads = sim.world.roads.graph;
    for (const line of [...roads.lanes.map(l => ({ points: l.points, width: l.width })),
      ...roads.connectors.map(c => ({ points: c.points, width: Math.max(sim.world.roads.laneById.get(c.from)?.width ?? 3, sim.world.roads.laneById.get(c.to)?.width ?? 3) }))]) {
      for (let i = 1; i < line.points.length; i++) {
        const segment = { a: line.points[i - 1]!, b: line.points[i]!, radius: line.width / 2 + RADIUS + 0.25 };
        const { a, b, radius } = segment;
        this.eachGrid(Math.min(a[0], b[0]) - radius, Math.min(a[2], b[2]) - radius,
          Math.max(a[0], b[0]) + radius, Math.max(a[2], b[2]) + radius,
          key => this.bucket(this.traffic, key).push(segment));
      }
    }
  }

  /** Renderer uses the same fixed timeline for a fall, floor hold and smooth get-up; health stays literal. */
  knockdown(id: string): PedestrianKnockdown | null {
    const walker = this.active.get(id);
    if (!walker?.character.alive || walker.knockdownTick === null || walker.knockdownTick === undefined) return null;
    return { elapsed: (this.sim.tick - walker.knockdownTick) * TICK_SECONDS, ...CIVILIAN_KNOCKDOWN };
  }

  /** Down, or on the way down or up, from a knockdown; kept when they die there. */
  knockedDown(id: string): boolean {
    return (this.active.get(id)?.knockdownTick ?? null) !== null;
  }

  /** Include AI choices and pending timers: equal transforms alone do not imply equal next ticks. */
  digest(): string {
    const parts = [`${this.sim.options.seed}:${this.variants.join(',')}:${this.serial}:${this.cursor}`];
    for (const id of [...this.active.keys()].sort()) {
      const w = this.active.get(id)!;
      parts.push(`${id}:${w.slot}:${w.route.id}:${w.s.toFixed(6)}:${w.direction}:${w.speed.toFixed(3)}:${w.waitUntil}:${w.blockedTicks}:${w.nextGroundTick}:${Number(w.safeAhead)}:${w.lastHealth.toFixed(6)}:${w.knockdownTick ?? '-'}`);
    }
    for (const id of [...this.unavailableUntil.keys()].sort()) parts.push(`cooldown:${id}:${this.unavailableUntil.get(id)}`);
    return parts.join('|');
  }

  step(): void {
    const sim = this.sim, player = sim.playerPosition;
    for (const [id, walker] of this.active) {
      const c = walker.character, distance = distanceXZ(c.position, player);
      if (sim.characters.get(id) !== c) { this.active.delete(id); continue; }
      if (distance > PEDESTRIANS.retireDistance || c.position[1] < sim.gameplay.killHeight
        || (!c.alive && c.deathTicks > PEDESTRIANS.corpseMinimumTicks && (distance > 40 || c.deathTicks > PEDESTRIANS.corpseMaximumTicks))) {
        sim.removeCharacter(c); this.active.delete(id);
        this.unavailableUntil.set(walker.slot, sim.tick + PEDESTRIANS.retryTicks);
        sim.emit('civilianDespawn', id); continue;
      }
      this.walk(walker);
    }
    if (sim.tick % PEDESTRIANS.refreshTicks !== 1) return;
    for (const [id, until] of this.unavailableUntil) if (until <= sim.tick) this.unavailableUntil.delete(id);
    if (sim.mode === 'busted' || sim.mode === 'wasted' || this.active.size >= PEDESTRIANS.target || !this.variants.length) return;
    const candidates: Slot[] = [], r = PEDESTRIANS.spawnMax;
    this.eachGrid(player[0] - r, player[2] - r, player[0] + r, player[2] + r, key => {
      for (const slot of this.slots.get(key) ?? []) {
        const d = distanceXZ(slot.position, player);
        if (d >= PEDESTRIANS.spawnMin && d <= r && !this.unavailableUntil.has(slot.id)) candidates.push(slot);
      }
    });
    candidates.sort((a, b) => Number(a.route.source === 'street-edge') - Number(b.route.source === 'street-edge')
      || distanceXZ(a.position, player) - distanceXZ(b.position, player) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    let born = 0;
    for (let attempt = 0; attempt < Math.min(candidates.length, PEDESTRIANS.attemptsPerRefresh)
      && born < PEDESTRIANS.birthsPerRefresh && this.active.size < PEDESTRIANS.target; attempt++) {
      const slot = candidates[(this.cursor + attempt) % candidates.length]!;
      if ([...sim.characters.values()].some(c => distanceXZ(c.position, slot.position) < PEDESTRIANS.spacing)) continue;
      const ground = pedestrianGround(sim.world, slot.position);
      if (!ground || !this.clearTraffic(ground)) { this.unavailableUntil.set(slot.id, sim.tick + PEDESTRIANS.retryTicks); continue; }
      const hash = Number.parseInt(fnv1a(`${sim.options.seed}:${slot.id}:${this.serial}`), 16);
      const direction = hash % 2 ? 1 : -1, variant = this.variants[((this.serial + sim.options.seed) >>> 0) % this.variants.length]!;
      const tangent = pointAlong(slot.route.points, slot.s).tangent;
      const c = sim.spawnCharacter(`civilian-${variant}-${++this.serial}`, ground, Math.atan2(tangent[0] * direction, tangent[1] * direction), 100);
      this.active.set(c.id, { character: c, slot: slot.id, route: slot.route, s: slot.s, direction,
        speed: 1.05 + hash % 29 / 100, waitUntil: sim.tick + hash % 90, blockedTicks: 0, nextGroundTick: 0, safeAhead: false,
        lastHealth: c.health, knockdownTick: null });
      sim.emit('civilianSpawn', c.id); born++;
    }
    this.cursor += PEDESTRIANS.attemptsPerRefresh;
  }

  private walk(w: Walker): void {
    const c = w.character, sim = this.sim;
    c.desiredVx = 0; c.desiredVz = 0;
    if (!c.alive) { this.clip(c, 'death'); return; }
    if (c.health < w.lastHealth) {
      // Repeated hits while falling never rewind the pose. A hit during get-up reverses from that
      // same collapse sample instead of snapping to the standing start of the animation.
      if (w.knockdownTick === null) w.knockdownTick = sim.tick;
      else {
        const elapsed = (sim.tick - w.knockdownTick) * TICK_SECONDS;
        const { fallSeconds, holdSeconds, riseSeconds } = CIVILIAN_KNOCKDOWN;
        if (elapsed >= fallSeconds + holdSeconds) {
          const collapse = 1 - clamp((elapsed - fallSeconds - holdSeconds) / riseSeconds, 0, 1);
          w.knockdownTick = sim.tick - Math.round(collapse * fallSeconds * TICK_HZ);
        }
      }
      w.lastHealth = c.health;
    }
    if (w.knockdownTick !== null) {
      const duration = (CIVILIAN_KNOCKDOWN.fallSeconds + CIVILIAN_KNOCKDOWN.holdSeconds + CIVILIAN_KNOCKDOWN.riseSeconds) * TICK_HZ;
      if (sim.tick - w.knockdownTick < duration) { c.hitTicks = 0; this.clip(c, 'death'); return; }
      w.knockdownTick = null; w.waitUntil = sim.tick + 20; w.nextGroundTick = 0;
    }
    if (c.hitTicks > 0) { c.hitTicks--; this.clip(c, 'hit'); return; }
    if (sim.tick < w.waitUntil) { this.clip(c, 'idle'); return; }
    w.s = clamp(pedestrianRouteCoordinate(w.route.points, c.position, w.s), 0.8, w.route.length - 0.8);
    const distanceToTurn = Math.max(0, w.direction > 0 ? w.route.length - 1 - w.s : w.s - 1);
    const speedStep = PEDESTRIANS.walkAcceleration * TICK_SECONDS;
    if (distanceToTurn <= 0.005 && c.speed <= speedStep) {
      this.reverse(w); this.clip(c, 'idle'); return;
    }
    const target = pointAlong(w.route.points, clamp(w.s + w.direction * 0.9, 0, w.route.length)).point;
    const dx = target[0] - c.position[0], dz = target[2] - c.position[2], distance = Math.hypot(dx, dz);
    if (distance < 0.08) { this.reverse(w); this.clip(c, 'idle'); return; }
    const yaw = Math.atan2(dx, dz);
    c.turnToward(yaw, 3.2);
    const aligned = Math.abs(wrapAngle(yaw - c.yaw)) < PEDESTRIANS.turnAlignment;
    if (sim.tick >= w.nextGroundTick) {
      w.nextGroundTick = sim.tick + PEDESTRIANS.groundCheckTicks;
      const ahead: V3 = [c.position[0] + dx / distance * 0.55, target[1], c.position[2] + dz / distance * 0.55];
      const ground = pedestrianGround(sim.world, ahead, c.body);
      w.safeAhead = !!ground && this.clearTraffic(ground) && Math.abs(ground[1] - c.position[1]) < 0.4;
    }
    if (!w.safeAhead || !aligned) { w.blockedTicks++; this.clip(c, 'idle'); }
    else {
      // Brake before a planned endpoint. Clamp both directions of the speed change so the
      // final discrete steps settle without a hard stop; obstacle/support failures still stop now.
      const turnSpeed = Math.sqrt(2 * PEDESTRIANS.walkAcceleration * distanceToTurn);
      const speed = Math.max(0, c.speed - speedStep, Math.min(w.speed, c.speed + speedStep, turnSpeed));
      c.desiredVx = dx / distance * speed; c.desiredVz = dz / distance * speed;
      if (c.speed < 0.08) w.blockedTicks++; else w.blockedTicks = 0;
      this.clip(c, 'walk');
    }
    if (w.blockedTicks > 2 * TICK_HZ) this.reverse(w);
  }

  private reverse(w: Walker): void {
    w.direction *= -1; w.waitUntil = this.sim.tick + 30 + Number.parseInt(fnv1a(`${w.character.id}:${this.sim.tick}`), 16) % 120;
    w.blockedTicks = 0; w.nextGroundTick = 0; w.safeAhead = false;
  }

  private clip(c: Character, clip: CharacterClip): void {
    if (c.clip !== clip) { c.clip = clip; c.clipTicks = 0; } else c.clipTicks++;
  }

  private clearTraffic(point: Vec3): boolean {
    for (const { a, b, radius } of this.traffic.get(gridKey(point[0], point[2])) ?? []) {
      const dx = b[0] - a[0], dz = b[2] - a[2], length2 = dx * dx + dz * dz;
      const t = length2 ? clamp(((point[0] - a[0]) * dx + (point[2] - a[2]) * dz) / length2, 0, 1) : 0;
      if (Math.abs(point[1] - (a[1] + (b[1] - a[1]) * t)) < 2
        && Math.hypot(point[0] - a[0] - dx * t, point[2] - a[2] - dz * t) < radius) return false;
    }
    return true;
  }

  private bucket<T>(map: Map<string, T[]>, key: string): T[] {
    let bucket = map.get(key); if (!bucket) map.set(key, bucket = []); return bucket;
  }

  private eachGrid(minX: number, minZ: number, maxX: number, maxZ: number, visit: (key: string) => void): void {
    for (let z = Math.floor(minZ / GRID); z <= Math.floor(maxZ / GRID); z++)
      for (let x = Math.floor(minX / GRID); x <= Math.floor(maxX / GRID); x++) visit(`${x},${z}`);
  }
}
