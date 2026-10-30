import { containsSupportedArea, pointAlong, polylineLength, type RoadGraph, type Vec3 } from '@helsinki/world-schema';
import { CHARACTER, CHARACTER_SKIN, CLIMB, FEET_TO_CENTRE, JUMP, type Character, type CharacterClip } from './character.ts';
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
/** How fast (m/s) a knocked-down body held up by the rim of its capsule on an edge slides off it. */
const KNOCKDOWN_EDGE_SLIDE = 1;
/** Any bullet kills a civilian outright; the knockdown that gets up again is for car bumps. */
export const CIVILIAN_BULLETS_LETHAL = true;
export const PEDESTRIANS = {
  target: 8, spawnMin: 24, spawnMax: 108, retireDistance: 180,
  walkAcceleration: 2, turnAlignment: 0.12,
  refreshTicks: 2 * TICK_HZ, birthsPerRefresh: 2, attemptsPerRefresh: 40,
  spacing: 7, groundCheckTicks: 6, retryTicks: 8 * TICK_HZ,
  corpseMinimumTicks: 30 * TICK_HZ, corpseMaximumTicks: 180 * TICK_HZ, corpseRetireDistance: 60,
} as const;
/** Stepping around what routes do not know about: posts, parked cars, people, facades wider than OSM assumed. */
export const PEDESTRIAN_STEERING = {
  lookahead: 0.9, probe: 0.55, maxOffset: 1.2, relaxPerLookahead: 0.08, detourDegrees: [20, 35, 50], sideStepDegrees: 80, gapStep: 0.4,
  blockedProbeTicks: 3, reverseAfterTicks: TICK_HZ, stuckTicks: TICK_HZ, stuckProgress: 0.15, stallSpeed: 0.15, stallTicks: 15, stallDetourTicks: 40,
  badRouteReversals: 3, badRouteWindowTicks: 30 * TICK_HZ, badRouteBlockedTicks: 10 * TICK_HZ, badRouteTicks: 5 * 60 * TICK_HZ,
  strandedRetireDistance: 48, spanReach: 9, spanStep: 1.5, spanSide: 0.6, spanChecksPerRefresh: 4,
  wallHeight: 0.45, wallPush: 0.25, turnShort: 0.5, limitTicks: 2 * 60 * TICK_HZ, minimumSpan: 8,
} as const;
/**
 * Gunfire within `shotRadius`, or someone hurt within `casualtyRadius`, sends walkers along their route away from it:
 * running, or sprinting when it happened within `sprintRadius`. The speeds are the civilian run and sprint clips' own.
 */
export const CIVILIAN_PANIC = {
  shotRadius: 45, casualtyRadius: 25, sprintRadius: 20, ticks: 8 * TICK_HZ, runSpeed: 3.6, sprintSpeed: 5, acceleration: 6, turnRate: 6, flipMargin: 1,
  standNearShooter: 15, birthQuietRadius: 40, birthQuietTicks: 5 * TICK_HZ, calmTicks: TICK_HZ,
} as const;
/**
 * A fleeing walker jumps what stands in its way, `minHeight` (above what the controller steps up) to `CLIMB.maxHeight`
 * above its feet: up to `JUMP.normalHeight - CLIMB.clearMargin` the jump clears it, above that the hands grab the edge and
 * pull over. It takes off once the face is `lead` seconds ahead at its speed, taken as at least `minimumSpeed` so one
 * standing at the face jumps too (plus the capsule and `margin`). The face may stand up to 60° off its way, but it jumps
 * square to it, and only where the face stands square across the capsule's width to within `square` metres, so that the
 * controller has nothing to slide it along while the face holds it back. It jumps only where support within
 * `levelTolerance` of its route's level, neither higher nor lower anywhere under the capsule's width, covers every spot
 * along that line it can come down on at the speed it jumps at: from `landing` metres past the face, or from its
 * earliest touchdown where that is nearer (held back by the face, onto support the tolerance above the route, with
 * `earlyTicks` less flight than predicted), to its farthest touchdown, unhindered, onto support at the route's level
 * (lower support it reaches later, but no farther), and `stop` metres beyond; a top it climbs so ends short of
 * `landing`. The probes, each the capsule's full width, lie no farther apart than that width, and a jump that needs more
 * than `probes` of them is not taken. Nor is one whose path
 * meets static geometry other than the jumped obstacle where the walker is meant to touch it (its face while held back,
 * its top), or a person or car standing in it at the decision: the space the capsule sweeps, out to the controller's
 * `contact` margin past the skin (within which it grounds on what is under its feet), from take-off over the top, down
 * to the farthest touchdown and `stop` beyond, at every height the walker's feet can have along the way (up to `ride`
 * higher than the jump alone takes them, where the capsule rides up over the top's edge). The obstacle itself counts
 * short of the face and `clearance` above the top; everything else counts throughout, below the top too from where the
 * face holds the walker back to past the far side, except that ground, kerbs and terrain count only where they rise
 * more than `supportRise` above the support the walker is on there: the take-off ground before the face, the lowest
 * support checked where it comes down beyond. A falling capsule rides over an edge that low; one higher catches its
 * rounded bottom, pushes it sideways and can hold it up in the air on the edge. It is checked in at most
 * 2 · `descents` + `probes` + 5 capsule casts, and the obstacle's far side, `farDepth` below its top, with one ray. It
 * runs straight on at that speed, whatever a later shot raises its flee speed to, no farther than the farthest
 * touchdown, until it is back down at its route's level or `timeoutTicks` pass. A jump that got nowhere is not tried
 * again for `cooldownTicks`.
 */
export const CIVILIAN_VAULT = {
  minHeight: 0.45, probeHeight: 0.55, lead: 0.3, margin: 0.25, minimumSpeed: 2, inset: 0.12, landing: 1.6, stop: 0.35,
  square: 0.02, earlyTicks: 4, probes: 8, contact: 0.05, clearance: 0.02, farDepth: 0.05, descents: 2, ride: 0.07, supportRise: 0.05,
  settleTicks: 6, levelTolerance: 0.4, minimumProgress: 0.6, timeoutTicks: 3 * TICK_HZ, cooldownTicks: 2 * TICK_HZ,
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
  /** Lateral offset from the route centreline kept while walking (m, along the route normal). */
  offset: number;
  /** The checked step: null follows the route, a number is a detour in degrees from the route direction. */
  detour: number | null;
  /** Route coordinate and tick at the start of the current progress window. */
  progressS: number;
  progressTick: number;
  /** Walking ticks in a row without getting up to speed: pressed against something the probe passed. */
  stallTicks: number;
  /** Ticks of the latest forced mid-route reversals, oldest first. */
  forcedReversals: number[];
  /** Route coordinates past which it does not walk: where it was forced to turn, until `limitsUntil`. */
  limits: [number, number] | null;
  limitsUntil: number;
  /** Leaky count of blocked ticks. */
  blockedTotal: number;
  /** Its route trapped it: it stands and retires once out of the player's way. */
  stranded: boolean;
  panicUntil: number;
  threat: V3 | null;
  /** Fleeing speed for this panic: a run, or a sprint when the threat was close. */
  fleeSpeed: number;
  /** A jump over something in the way: its direction (square to the face), start and tick, the speed it runs at and the touchdown checked for that speed. */
  vault: { readonly dir: readonly [number, number]; readonly start: V3; readonly tick: number; readonly speed: number; readonly landing: V3 } | null;
  vaultCooldownUntil: number;
}
type Verdict = 'clear' | 'traffic' | 'edge' | 'rough' | 'blocked';

/** Native ground on the recorded level, with complete capsule-width support; never a heightfield fallback. */
export function pedestrianGround(world: StaticWorld, point: Vec3, excludeBody?: RAPIER.RigidBody): V3 | null {
  const probe = groundProbe(world, point, excludeBody);
  return typeof probe === 'string' ? null : probe;
}

/**
 * The ground test with its reason: support ends (`edge`), uneven (`rough`), or a body in the way (`blocked`). Given
 * `lows`, a probe that finds support also adds the lowest support its rays met to it.
 */
function groundProbe(world: StaticWorld, point: Vec3, excludeBody?: RAPIER.RigidBody, lows?: number[]): V3 | 'edge' | 'rough' | 'blocked' {
  const [x, expectedY, z] = point, area = world.gameplay.playArea, t = world.terrain;
  if (!point.every(Number.isFinite) || !containsSupportedArea(world.gameplay, x, z, RADIUS)) return 'edge';
  const heights: number[] = [];
  let edge = false, rough = false;
  for (const [dx, dz] of [[0, 0], [RADIUS, 0], [-RADIUS, 0], [0, RADIUS], [0, -RADIUS]]) {
    const px = x + dx!, pz = z + dz!;
    if (px <= Math.max(area.minX, t.x0) || px >= Math.min(area.maxX, t.x0 + (t.nx - 1) * t.resolution)
      || pz <= Math.max(area.minZ, t.z0) || pz >= Math.min(area.maxZ, t.z0 + (t.nz - 1) * t.resolution) || !world.queryable(px, pz)) return 'edge';
    const hit = world.spawnGroundBelow(px, expectedY + 1.5, pz, 3);
    if (!hit || !hit.surface || !['ground', 'kerbs'].includes(hit.surface.group)
      || /water|sea|ocean|railway|tram/i.test(hit.surface.tag) || Math.abs(hit.y - expectedY) > 1.2
      || hit.y < world.gameplay.killHeight + 2) { edge = true; continue; }
    if (hit.normalY < 0.8) rough = true;
    heights.push(hit.y);
  }
  if (!heights.length) return 'edge';
  const high = Math.max(...heights);
  // A wall or body in the way outranks the missing support beside it: that is something to step around.
  const blocked = world.physics.intersectionWithShape({ x, y: high + CHARACTER.halfHeight + RADIUS + 0.04, z }, IDENTITY,
    new RAPIER.Capsule(CHARACTER.halfHeight, RADIUS), undefined,
    groups(GROUP.character, GROUP.static | GROUP.vehicle | GROUP.character), undefined, excludeBody);
  if (blocked) return 'blocked';
  if (edge) return 'edge';
  const low = Math.min(...heights);
  if (rough || high - low > 0.28) return 'rough';
  lows?.push(low);
  return [x, high, z];
}

const VAULT_GROUPS = new Set(['buildings', 'citymodel', 'landmarks', 'props']);

/**
 * What a walker with its feet at `feet`, running at `speed` along unit `dir` on a route at height `routeY`, would jump
 * or climb (CIVILIAN_VAULT) when it jumps at `jumpSpeed`: the direction it jumps, square to the face (`dir`), the
 * distance to the face that way, the top's height above the feet, the farthest touchdown at that speed (`landing`) and
 * the support checked from its earliest touchdown to past the farthest; null when nothing jumpable is there, it might
 * come down off support or onto support more than `levelTolerance` above or below `routeY` anywhere under the capsule's
 * width (each probe's highest and lowest ray), or static geometry of any group, a person or a car stands in the space
 * its flight sweeps (`flightClear`; ground, kerbs and terrain from `supportRise` above the support under it). Only
 * static obstacles are jumped, not walkable ground, kerbs, terrain or trees. A top too high to clear needs standing room
 * behind the edge, as the ledge grab does, so fences and poles are stepped around instead.
 */
export function vaultTarget(world: StaticWorld, feet: V3, dir: readonly [number, number], speed: number, jumpSpeed: number, routeY: number,
  collider?: RAPIER.Collider, body?: RAPIER.RigidBody): { dir: readonly [number, number]; distance: number; height: number; landing: V3; support: readonly V3[] } | null {
  const V = CIVILIAN_VAULT, [x, y, z] = feet, flags = RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, down = { x: 0, y: -1, z: 0 };
  const solid = groups(GROUP.character, GROUP.static), reach = CHARACTER.radius + Math.max(speed, V.minimumSpeed) * V.lead + V.margin;
  const ahead = (ox: number, oz: number, along: readonly [number, number]) => world.physics.castRayAndGetNormal(
    new RAPIER.Ray({ x: ox, y: y + V.probeHeight, z: oz }, { x: along[0], y: 0, z: along[1] }), reach, true, flags, solid, collider, body);
  const vaultable = (hit: RAPIER.RayColliderIntersection) => Math.abs(hit.normal.y) <= 0.35 && VAULT_GROUPS.has(world.surfaceAt(hit.collider.handle, null)?.group ?? '');
  // Walkable surfaces (a flight of steps, a terrain step) are run up, and a tree's trunk is not jumped.
  const way = ahead(x, z, dir);
  if (!way || !vaultable(way) || way.normal.x * dir[0] + way.normal.z * dir[1] > -0.5) return null;
  // The jump goes square to the face, so while the face holds the walker back the controller has nothing to slide it
  // along. The face must stand square across the capsule's width to within `square`, which also keeps its ends and
  // corners off the capsule.
  const flat = Math.hypot(way.normal.x, way.normal.z), jump = [-way.normal.x / flat, -way.normal.z / flat] as const;
  const face = ahead(x, z, jump), across = CHARACTER.radius + CHARACTER_SKIN;
  if (!face || !vaultable(face)) return null;
  for (const side of [-across, across]) {
    const edge = ahead(x - jump[1] * side, z + jump[0] * side, jump);
    if (!edge || Math.abs(edge.timeOfImpact - face.timeOfImpact) > V.square) return null;
  }
  // The top just inside the face; a ray that starts inside a solid means it rises past any climb.
  const inside = face.timeOfImpact + V.inset, probeY = y + CLIMB.maxHeight + 0.02;
  const top = world.physics.castRay(new RAPIER.Ray({ x: x + jump[0] * inside, y: probeY, z: z + jump[1] * inside }, down),
    CLIMB.maxHeight + 0.02 - V.minHeight, true, flags, solid, collider, body);
  if (!top || top.timeOfImpact < 1e-3) return null;
  const height = CLIMB.maxHeight + 0.02 - top.timeOfImpact, climb = height + CLIMB.clearMargin > JUMP.normalHeight;
  if (climb) {
    const stand = face.timeOfImpact + CHARACTER.radius + CLIMB.inset;
    const support = world.physics.castRayAndGetNormal(new RAPIER.Ray({ x: x + jump[0] * stand, y: y + height + 0.4, z: z + jump[1] * stand }, down),
      0.6, true, flags, solid, collider, body);
    if (!support || support.normal.y < 0.7 || Math.abs(0.4 - support.timeOfImpact) > 0.1) return null;
  }
  // Touchdowns, along `jump` from the feet. The farthest, for a run unhindered by the face: a top it clears, after take-off
  // and the jump's flight down to the route; a top it climbs, after dropping off its far side, which lies short of the
  // support checked from `landing` past the face. The continuous flight outlasts the fixed-step one by over a tick; one
  // more tick covers stepping off an edge. Support up to `levelTolerance` lower is reached later but no farther: the jump
  // drives the walker no farther than this touchdown (`vaulting`).
  const g = JUMP.gravity, rise = Math.sqrt(2 * g * JUMP.normalHeight), facing = -(face.normal.x * jump[0] + face.normal.z * jump[1]);
  const flight = (to: number) => (rise + Math.sqrt(Math.max(0, rise * rise + 2 * g * (y - to)))) / g;
  const drop = (to: number) => Math.sqrt(2 * Math.max(0, y + height - to) / g);
  const touchdown = jumpSpeed * TICK_SECONDS + (climb ? face.timeOfImpact + V.landing + jumpSpeed * drop(routeY) : jumpSpeed * (JUMP.takeoffSeconds + flight(routeY)));
  // The earliest, onto support as high as the route's level is taken to be and with `earlyTicks` less flight: a jump that
  // clears the top unhindered, or pressed against the face (as one standing there is) until its feet rise past the top;
  // a climb, dropping off where it stands up on the top. Support is checked from there or from `landing` past the face,
  // whichever is nearer.
  const early = V.earlyTicks * TICK_SECONDS, level = routeY + V.levelTolerance;
  let earliest = Math.min(touchdown, face.timeOfImpact + V.landing);
  if (rise * rise > 2 * g * height) {
    const clear = (rise - Math.sqrt(rise * rise - 2 * g * height)) / g;
    earliest = Math.min(earliest, jumpSpeed * (JUMP.takeoffSeconds + flight(level) - early),
      face.timeOfImpact - (CHARACTER.radius + CHARACTER_SKIN) / facing + jumpSpeed * Math.max(0, flight(level) - clear - early));
  }
  if (climb) earliest = Math.min(earliest, face.timeOfImpact + (CHARACTER.radius + CLIMB.inset) * facing + jumpSpeed * Math.max(0, drop(level) - early));
  // Probes no farther apart than the width each covers, from there to the farthest touchdown and `stop` past it.
  const spans = Math.max(1, Math.ceil((touchdown - earliest) / (2 * RADIUS)));
  if (spans + 2 > V.probes) return null;
  const support: V3[] = [], lows: number[] = [];
  for (let i = 0; i <= spans + 1; i++) {
    const past = i > spans ? touchdown + V.stop : earliest + (touchdown - earliest) * i / spans;
    const ground = groundProbe(world, [x + jump[0] * past, routeY, z + jump[1] * past], body, lows);
    if (typeof ground === 'string' || ground[1] > level || lows[i]! < routeY - V.levelTolerance) return null;
    support.push(ground);
  }
  if (!flightClear(world, feet, jump, face.timeOfImpact, height, climb, jumpSpeed, earliest, touchdown, support, lows, [face.collider, top.collider], collider, body)) return null;
  return { dir: jump, distance: face.timeOfImpact, height, landing: support[spans]!, support };
}

/**
 * What a walker stands on and comes down on: ground, kerbs and terrain, which the world also reports for a static
 * collider with no surface tags. In a jump's way they count where they rise `supportRise` above that support (`flightClear`).
 */
const SUPPORT_GROUPS = new Set(['ground', 'kerbs', 'terrain']);

/**
 * Whether the space a vault's capsule sweeps (CIVILIAN_VAULT) holds no static geometry, person or car but the `jumped`
 * obstacle (the colliders of its face and top) where the walker is meant to touch it, and the support it stands on and
 * comes down on. Distances run along unit `jump` from `feet`: the face at `face`, its top `height` above the feet, the
 * touchdowns from `earliest`, on the probed `support` (the lowest of which each probe met is in `lows`), to `touchdown`
 * and `stop` beyond. Each leg is a capsule cast as wide as the capsule with its skin and the controller's contact
 * margin, covering every height the feet can have there: from the ground up to the face; from the ground (or the lower
 * support) up again, where the walker is held against the face, rounds the top's edges and comes down past its far
 * side, for anything but the jumped obstacle (its face was found square across the capsule); above the top across it,
 * out to its far side; and from the lowest path down off the far side (held back by the face until the feet pass the
 * top; or off a top it came down on or climbed, kept down on the far edge until the capsule's middle is past it, then
 * falling; with `earlyTicks` more fall) to the highest (unhindered, or held back while still rising, and `ride` up the
 * edge), in straight legs, to the earliest touchdown, and from the support up from there. Ground, kerbs and terrain
 * (SUPPORT_GROUPS) count in it only from `supportRise` above the support the walker is on there, in casts of their own
 * wherever the legs reach lower: the take-off ground (the feet less the skin) up to where the face holds it back; the
 * higher of the take-off ground and the lowest support at the earliest touchdown over the obstacle and past its far
 * side; that support down to the earliest touchdown; and between each two neighbouring probes, the lowest support
 * either met, so that a step under one side of the capsule's width counts as well. People and cars count throughout, as
 * they stand at the decision; one that moves into the path after take-off is not foreseen.
 */
function flightClear(world: StaticWorld, feet: V3, jump: readonly [number, number], face: number, height: number, climb: boolean, jumpSpeed: number,
  earliest: number, touchdown: number, support: readonly V3[], lows: readonly number[], jumped: readonly RAPIER.Collider[], collider?: RAPIER.Collider,
  body?: RAPIER.RigidBody): boolean {
  const V = CIVILIAN_VAULT, [x, y, z] = feet, g = JUMP.gravity, rise = Math.sqrt(2 * g * JUMP.normalHeight), early = V.earlyTicks * TICK_SECONDS;
  const flags = RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, solid = groups(GROUP.character, GROUP.static);
  // The legs meet what the controller moves the walker against: people and cars as well, which have no static surface.
  const movement = groups(GROUP.character, GROUP.static | GROUP.vehicle | GROUP.character);
  const underfoot = (c: RAPIER.Collider) => SUPPORT_GROUPS.has(world.surfaceAt(c.handle, null)?.group ?? '');
  const other = (c: RAPIER.Collider) => !underfoot(c), any = () => true;
  const obstacle = (c: RAPIER.Collider) => jumped.some(j => j.handle === c.handle);
  const touch = CHARACTER.radius + CHARACTER_SKIN, reach = touch + V.contact, top = height + CHARACTER_SKIN, hold = face - touch;
  const lift = climb ? CLIMB.lift : 0, ground = Math.min(...support.map(p => p[1])) + CHARACTER_SKIN - y;
  // Feet heights above the take-off, a time into the flight launched at full speed at the end of the take-off.
  const flight = (t: number) => rise * t - g * t * t / 2;
  const launch = Math.min(jumpSpeed * (JUMP.takeoffSeconds + TICK_SECONDS), hold), time = (s: number) => Math.max(0, s - launch) / jumpSpeed;
  // Held back by the face until its feet pass the top, a walker is that much longer in the air at every point after.
  const clear = top < JUMP.normalHeight ? (rise - Math.sqrt(rise * rise - 2 * g * top)) / g : Infinity;
  const held = Math.max(0, clear - time(hold));
  // The far side, just below the top; found on something else, or not at all, only the top's near part is counted on.
  const back = world.physics.castRay(new RAPIER.Ray({ x: x + jump[0] * earliest, y: y + height - V.farDepth, z: z + jump[1] * earliest },
    { x: -jump[0], y: 0, z: -jump[1] }), earliest - face, true, flags, solid, collider, body, other);
  const far = back && obstacle(back.collider) ? Math.max(face + V.inset, earliest - back.timeOfImpact) : face + V.inset;
  // A held jump that comes back down to the top's height short of the far side lands on it and drops off it, as a climb does.
  const lands = climb || launch + jumpSpeed * ((rise + Math.sqrt(rise * rise - 2 * g * top)) / g - held) <= far + reach;
  const drop = (s: number) => top - g * ((s - far) / jumpSpeed) ** 2 / 2;
  // Walking off it, the controller keeps the capsule down on the far edge until its middle is past, then it falls.
  const slip = (s: number) => height - CHARACTER.radius - g * (Math.max(0, s - far - touch) / jumpSpeed + early) ** 2 / 2;
  const low = (s: number) => Math.max(ground, climb ? slip(s) : Math.min(flight(time(s) + held + early), lands ? slip(s) : Infinity));
  const high = (a: number, b: number, floor: number) => Math.max(flight(clamp(rise / g, time(a), time(b) + held)) + V.ride, floor) + CHARACTER_SKIN;
  // One leg: the capsule's middle from `a` to `b`, its feet from `low0` to `low1` and up to `upper` above them.
  const sweep = (a: number, b: number, low0: number, low1: number, upper: number, counts = other) => {
    if (b <= a) return true;
    const span = Math.max(0, upper - Math.min(low0, low1));
    return !world.physics.castShape({ x: x + jump[0] * a, y: y + low0 + FEET_TO_CENTRE + span / 2, z: z + jump[1] * a }, IDENTITY,
      { x: jump[0] * (b - a), y: low1 - low0, z: jump[1] * (b - a) }, new RAPIER.Capsule(CHARACTER.halfHeight + span / 2, reach), 0, 1, true,
      flags, movement, collider, body, counts);
  };
  // Feet at which the swept capsule's bottom is `clearance` above the top, and its first middle clear of the far side.
  const above = height + V.clearance + reach - CHARACTER.radius, past = far + reach + V.clearance, front = Math.max(0, hold - V.contact - V.clearance);
  // Feet at which the swept capsule's bottom is `supportRise` above support at `level` (from the feet), and the lowest
  // support each probe met, from the feet.
  const onto = (level: number) => level + V.supportRise + reach - CHARACTER.radius, levels = lows.map(l => l - y);
  const takeoff = onto(-CHARACTER_SKIN), beyond = onto(Math.max(-CHARACTER_SKIN, levels[0]!)), landing = onto(levels[0]!);
  const below = Math.min(0, ground), up = high(0, hold, top + lift), over = Math.max(above, high(front, past, top + lift));
  const lying = (c: RAPIER.Collider) => underfoot(c) && !obstacle(c);
  if (!sweep(0, front, 0, 0, up) || !sweep(0, hold, takeoff, takeoff, up, lying)) return false;
  if (!sweep(front, past, below, below, over, c => !obstacle(c) && other(c)) || !sweep(hold, past, beyond, beyond, over, lying)) return false;
  if (!sweep(hold, past, above, above, Math.max(above, high(hold, past, top + lift)), any)) return false;
  for (let i = 0; i < V.descents; i++) {
    const a = past + (earliest - past) * i / V.descents, b = past + (earliest - past) * (i + 1) / V.descents, l0 = low(a), l1 = low(b);
    const upper = high(a, b, lands ? drop(a) : 0);
    if (!(Math.min(l0, l1) >= landing ? sweep(a, b, l0, l1, upper, any) : sweep(a, b, l0, l1, upper) && sweep(a, b, landing, landing, upper, underfoot))) return false;
  }
  const from = Math.max(past, earliest), end = touchdown + V.stop, spans = support.length - 2;
  if (!sweep(from, end, ground, ground, high(from, end, lands ? drop(from) : 0))) return false;
  const probe = (i: number) => i > spans ? end : earliest + (touchdown - earliest) * i / spans;
  for (let i = 0; i <= spans; i++) {
    const a = Math.max(from, probe(i)), b = probe(i + 1), floor = onto(Math.min(levels[i]!, levels[i + 1]!));
    if (!sweep(a, b, floor, floor, high(a, b, lands ? drop(a) : 0), underfoot)) return false;
  }
  return true;
}

/** A small local population, not one actor per map route. Distant bodies and all death bookkeeping retire. */
export class Pedestrians {
  private readonly sim: Simulation;
  private readonly variants: readonly CivilianVariant[];
  private readonly slots = new Map<string, Slot[]>();
  private readonly traffic = new Map<string, TrafficSegment[]>();
  private readonly active = new Map<string, Walker>();
  private readonly unavailableUntil = new Map<string, number>();
  /** Routes that trapped a walker: no births on them until the stored tick. */
  private readonly badRoutes = new Map<string, number>();
  private lastShotTick = -1e9;
  private lastShotPosition: V3 | null = null;
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
    const point = (p: readonly number[] | null) => p ? p.map(n => n.toFixed(4)).join(',') : '-';
    const parts = [`${this.sim.options.seed}:${this.variants.join(',')}:${this.serial}:${this.cursor}:${this.lastShotTick}:${point(this.lastShotPosition)}`];
    for (const id of [...this.active.keys()].sort()) {
      const w = this.active.get(id)!;
      parts.push(`${id}:${w.slot}:${w.route.id}:${w.s.toFixed(6)}:${w.direction}:${w.speed.toFixed(3)}:${w.waitUntil}:${w.blockedTicks}:${w.nextGroundTick}:${Number(w.safeAhead)}:${w.lastHealth.toFixed(6)}:${w.knockdownTick ?? '-'}`
        + `:${w.offset.toFixed(6)}:${w.detour ?? '-'}:${w.progressS.toFixed(6)}:${w.progressTick}:${w.stallTicks}:${w.forcedReversals.join(',')}:${w.limits?.map(n => n.toFixed(6)).join(',') ?? '-'}:${w.limitsUntil}:${w.blockedTotal}:${Number(w.stranded)}:${w.panicUntil}:${point(w.threat)}`
        + `:${w.fleeSpeed}:${w.vault ? `${point(w.vault.dir)}/${point(w.vault.start)}/${w.vault.tick}/${w.vault.speed}/${point(w.vault.landing)}` : '-'}:${w.vaultCooldownUntil}`);
    }
    for (const id of [...this.unavailableUntil.keys()].sort()) parts.push(`cooldown:${id}:${this.unavailableUntil.get(id)}`);
    for (const id of [...this.badRoutes.keys()].sort()) parts.push(`bad:${id}:${this.badRoutes.get(id)}`);
    return parts.join('|');
  }

  step(): void {
    const sim = this.sim, player = sim.playerPosition;
    this.notice();
    for (const [id, walker] of this.active) {
      const c = walker.character, distance = distanceXZ(c.position, player);
      if (sim.characters.get(id) !== c) { this.active.delete(id); continue; }
      if (distance > PEDESTRIANS.retireDistance || c.position[1] < sim.gameplay.killHeight
        || (!c.alive && c.deathTicks > PEDESTRIANS.corpseMinimumTicks && (distance > PEDESTRIANS.corpseRetireDistance || c.deathTicks > PEDESTRIANS.corpseMaximumTicks))
        || (c.alive && walker.stranded && sim.tick >= walker.panicUntil && distance > PEDESTRIAN_STEERING.strandedRetireDistance)) {
        sim.removeCharacter(c); this.active.delete(id);
        this.unavailableUntil.set(walker.slot, sim.tick + PEDESTRIANS.retryTicks);
        sim.emit('civilianDespawn', id); continue;
      }
      this.walk(walker);
    }
    if (sim.tick % PEDESTRIANS.refreshTicks !== 1) return;
    for (const [id, until] of this.unavailableUntil) if (until <= sim.tick) this.unavailableUntil.delete(id);
    for (const [id, until] of this.badRoutes) if (until <= sim.tick) this.badRoutes.delete(id);
    if (sim.mode === 'busted' || sim.mode === 'wasted' || this.active.size >= PEDESTRIANS.target || !this.variants.length) return;
    // Nobody walks into a street where shots were just fired.
    const quiet = sim.tick - this.lastShotTick < CIVILIAN_PANIC.birthQuietTicks ? this.lastShotPosition : null;
    const candidates: Slot[] = [], r = PEDESTRIANS.spawnMax;
    this.eachGrid(player[0] - r, player[2] - r, player[0] + r, player[2] + r, key => {
      for (const slot of this.slots.get(key) ?? []) {
        const d = distanceXZ(slot.position, player);
        if (d >= PEDESTRIANS.spawnMin && d <= r && !this.unavailableUntil.has(slot.id) && !this.badRoutes.has(slot.route.id)
          && !(quiet && distanceXZ(slot.position, quiet) < CIVILIAN_PANIC.birthQuietRadius)) candidates.push(slot);
      }
    });
    candidates.sort((a, b) => Number(a.route.source === 'street-edge') - Number(b.route.source === 'street-edge')
      || distanceXZ(a.position, player) - distanceXZ(b.position, player) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    let born = 0, spans = 0;
    for (let attempt = 0; attempt < Math.min(candidates.length, PEDESTRIANS.attemptsPerRefresh)
      && born < PEDESTRIANS.birthsPerRefresh && this.active.size < PEDESTRIANS.target; attempt++) {
      const slot = candidates[(this.cursor + attempt) % candidates.length]!;
      if ([...sim.characters.values()].some(c => distanceXZ(c.position, slot.position) < PEDESTRIANS.spacing)) continue;
      const ground = pedestrianGround(sim.world, slot.position);
      if (!ground || !this.clearTraffic(ground)) { this.unavailableUntil.set(slot.id, sim.tick + PEDESTRIANS.retryTicks); continue; }
      if (spans++ >= PEDESTRIAN_STEERING.spanChecksPerRefresh) break;
      if (!this.openSpan(slot)) { this.unavailableUntil.set(slot.id, sim.tick + PEDESTRIANS.retryTicks); continue; }
      const hash = Number.parseInt(fnv1a(`${sim.options.seed}:${slot.id}:${this.serial}`), 16);
      const direction = hash % 2 ? 1 : -1, variant = this.variants[((this.serial + sim.options.seed) >>> 0) % this.variants.length]!;
      const tangent = pointAlong(slot.route.points, slot.s).tangent;
      const c = sim.spawnCharacter(`civilian-${variant}-${++this.serial}`, ground, Math.atan2(tangent[0] * direction, tangent[1] * direction), 100);
      this.active.set(c.id, { character: c, slot: slot.id, route: slot.route, s: slot.s, direction,
        speed: 1.05 + hash % 29 / 100, waitUntil: sim.tick + hash % 90, blockedTicks: 0, nextGroundTick: 0, safeAhead: false,
        lastHealth: c.health, knockdownTick: null, offset: 0, detour: null, progressS: slot.s, progressTick: sim.tick, stallTicks: 0,
        forcedReversals: [], limits: null, limitsUntil: 0, blockedTotal: 0, stranded: false, panicUntil: 0, threat: null,
        fleeSpeed: CIVILIAN_PANIC.runSpeed, vault: null, vaultCooldownUntil: 0 });
      sim.emit('civilianSpawn', c.id); born++;
    }
    this.cursor += PEDESTRIANS.attemptsPerRefresh;
  }

  /** This tick's shots (the player's and the police's) and casualties: walkers near either take flight. */
  private notice(): void {
    const sim = this.sim, threats: V3[] = [], casualties: { id: string; at: V3 }[] = [];
    for (const shot of sim.shots) { threats.push(shot.origin); this.lastShotTick = sim.tick; this.lastShotPosition = [...shot.origin]; }
    for (const [id, w] of this.active) if (w.character.health < w.lastHealth) casualties.push({ id, at: w.character.position });
    if (!threats.length && !casualties.length) return;
    for (const [id, w] of this.active) {
      const c = w.character;
      if (!c.alive || w.knockdownTick !== null || c.health < w.lastHealth) continue;
      let threat: V3 | null = null, nearest = Infinity;
      for (const t of threats) { const d = distanceXZ(t, c.position); if (d <= CIVILIAN_PANIC.shotRadius && d < nearest) { nearest = d; threat = t; } }
      for (const k of casualties) {
        const d = distanceXZ(k.at, c.position);
        if (k.id !== id && d <= CIVILIAN_PANIC.casualtyRadius && d < nearest) { nearest = d; threat = k.at; }
      }
      if (threat) this.panic(w, threat, nearest);
    }
  }

  private panic(w: Walker, threat: V3, distance: number): void {
    const sim = this.sim, c = w.character, fresh = sim.tick >= w.panicUntil;
    const speed = distance <= CIVILIAN_PANIC.sprintRadius ? CIVILIAN_PANIC.sprintSpeed : CIVILIAN_PANIC.runSpeed;
    w.fleeSpeed = fresh ? speed : Math.max(w.fleeSpeed, speed);
    w.panicUntil = sim.tick + CIVILIAN_PANIC.ticks;
    w.threat = [threat[0], threat[1], threat[2]];
    // Away along the route; a threat roughly abeam does not flip a walker already running.
    const { tangent } = pointAlong(w.route.points, w.s);
    const away = (c.position[0] - threat[0]) * tangent[0] + (c.position[2] - threat[2]) * tangent[1];
    if (Math.abs(away) > CIVILIAN_PANIC.flipMargin && Math.sign(away) !== w.direction) {
      w.direction = Math.sign(away); w.detour = null; w.safeAhead = false; w.nextGroundTick = 0;
    }
    w.waitUntil = Math.min(w.waitUntil, sim.tick); w.blockedTicks = 0;
    if (fresh) sim.emit('civilianPanic', c.id);
  }

  private walk(w: Walker): void {
    const c = w.character, sim = this.sim, S = PEDESTRIAN_STEERING;
    c.desiredVx = 0; c.desiredVz = 0;
    if (!c.alive) { this.abandonJump(w); w.lastHealth = c.health; this.clip(c, 'death'); return; }
    if (c.health < w.lastHealth) {
      // Repeated hits while falling never rewind the pose. A hit during get-up reverses from that
      // same collapse sample instead of snapping to the standing start of the animation.
      if (w.knockdownTick === null) { w.knockdownTick = sim.tick; this.abandonJump(w); }
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
      if (sim.tick - w.knockdownTick < duration) { c.hitTicks = 0; this.clip(c, 'death'); this.slideOffEdge(c); return; }
      w.knockdownTick = null; w.waitUntil = sim.tick + 20; w.nextGroundTick = 0;
    }
    if (c.hitTicks > 0) { c.hitTicks--; this.clip(c, 'hit'); return; }
    const panicking = sim.tick < w.panicUntil;
    if (!panicking && w.threat) {
      // Out of danger: catch breath, then walk on the way they fled.
      w.threat = null;
      w.waitUntil = sim.tick + CIVILIAN_PANIC.calmTicks + Number.parseInt(fnv1a(`${c.id}:calm:${sim.tick}`), 16) % CIVILIAN_PANIC.calmTicks;
    }
    // A jump that ends this tick hands straight back to route following, which checks the support ahead.
    if (w.vault) { this.vaulting(w); if (w.vault) return; }
    if ((w.stranded && !panicking) || sim.tick < w.waitUntil) { this.hold(w); this.clip(c, 'idle'); return; }
    w.s = clamp(pedestrianRouteCoordinate(w.route.points, c.position, w.s), 0.8, w.route.length - 0.8);
    if (w.limits && sim.tick >= w.limitsUntil) w.limits = null;
    // Turn points learnt from bumping an obstacle hold back a calm walk; a fleeing one runs on and jumps it or stops at it.
    const [low, high] = (panicking ? null : w.limits) ?? [0, w.route.length];
    const distanceToTurn = Math.max(0, w.direction > 0 ? high - 1 - w.s : w.s - 1 - low);
    const acceleration = panicking ? CIVILIAN_PANIC.acceleration : PEDESTRIANS.walkAcceleration;
    const speedStep = acceleration * TICK_SECONDS;
    // A fleeing walker stands at an end rather than turn back toward the gun, unless the gun is right there.
    const turn = !panicking || this.shooterNear(w);
    if (distanceToTurn <= 0.005 && c.speed <= speedStep) {
      if (turn) this.reverse(w, false);
      this.hold(w); this.clip(c, 'idle'); return;
    }
    const ahead = pointAlong(w.route.points, clamp(w.s + w.direction * S.lookahead, 0, w.route.length));
    if (Math.hypot(ahead.point[0] - c.position[0], ahead.point[2] - c.position[2]) < 0.08) {
      if (turn) this.reverse(w, false);
      this.hold(w); this.clip(c, 'idle'); return;
    }
    if (panicking && this.vaultOver(w, ahead)) { this.vaulting(w); return; }
    const step = this.steer(w, ahead, panicking);
    const yaw = Math.atan2(step[0], step[1]);
    c.turnToward(yaw, panicking ? CIVILIAN_PANIC.turnRate : 3.2);
    const aligned = Math.abs(wrapAngle(yaw - c.yaw)) < PEDESTRIANS.turnAlignment;
    if (!w.safeAhead) { w.blockedTicks++; w.blockedTotal++; this.hold(w); this.clip(c, 'idle'); }
    else if (!aligned) { this.hold(w); this.clip(c, 'idle'); }
    else {
      // Brake before a planned endpoint. Clamp both directions of the speed change so the
      // final discrete steps settle without a hard stop; obstacle/support failures still stop now.
      const turnSpeed = Math.sqrt(2 * acceleration * distanceToTurn);
      const speed = Math.max(0, c.speed - speedStep, Math.min(panicking ? w.fleeSpeed : w.speed, c.speed + speedStep, turnSpeed));
      c.desiredVx = step[0] * speed; c.desiredVz = step[1] * speed;
      if (c.speed < 0.08) w.blockedTicks++; else w.blockedTicks = 0;
      if (c.speed < S.stallSpeed && distanceToTurn > 0.5) w.stallTicks++; else w.stallTicks = 0;
      if (sim.tick % 10 === 0 && w.blockedTotal > 0) w.blockedTotal--;
      // Route progress, not speed: a capsule sliding along a wall moves without getting anywhere.
      if (sim.tick - w.progressTick >= S.stuckTicks) {
        if (Math.abs(w.s - w.progressS) < S.stuckProgress && distanceToTurn > 1) w.blockedTicks = S.reverseAfterTicks + 1;
        w.progressS = w.s; w.progressTick = sim.tick;
      }
      this.clip(c, panicking ? this.fleeClip(w) : 'walk');
    }
    if (w.blockedTicks > S.reverseAfterTicks) {
      if (turn) this.reverse(w, !panicking && distanceToTurn > 1);
      else w.blockedTicks = 0;
    }
    if (!panicking && w.blockedTotal >= S.badRouteBlockedTicks) this.strand(w);
  }

  /**
   * This tick's step direction (unit XZ). The step is probed on a cadence; when the way along the route is blocked,
   * a parallel step and then wider side-steps are tried. `safeAhead` false means every checked step is blocked.
   */
  private steer(w: Walker, ahead: ReturnType<typeof pointAlong>, panicking: boolean): readonly [number, number] {
    const c = w.character, sim = this.sim, S = PEDESTRIAN_STEERING;
    const here = pointAlong(w.route.points, w.s), normal = [here.tangent[1], -here.tangent[0]] as const;
    // A push-out by the controller (a post, a facade) moves the body off the line: walk on parallel from
    // there instead of steering back into whatever pushed it, drifting back to the line while it is clear.
    w.offset = clamp((c.position[0] - here.point[0]) * normal[0] + (c.position[2] - here.point[2]) * normal[1], -S.maxOffset, S.maxOffset);
    // Brushing a post or a facade at body height: lean off it rather than back toward the line through it.
    let push = 0;
    for (let i = 0; i < c.controller.numComputedCollisions(); i++) {
      const k = c.controller.computedCollision(i);
      if (k && Math.abs(k.normal1.y) < 0.3 && k.witness1.y - c.position[1] > S.wallHeight) push += k.normal1.x * normal[0] + k.normal1.z * normal[1];
    }
    const lateral = Math.abs(push) > 1e-3 ? clamp(w.offset + Math.sign(push) * S.wallPush, -S.maxOffset, S.maxOffset)
      : w.offset - clamp(w.offset, -S.relaxPerLookahead, S.relaxPerLookahead);
    const forward = [here.tangent[0] * w.direction, here.tangent[1] * w.direction] as const;
    const direction = (detour: number | null): readonly [number, number] => {
      if (detour === null) {
        const dx = ahead.point[0] + ahead.tangent[1] * lateral - c.position[0], dz = ahead.point[2] - ahead.tangent[0] * lateral - c.position[2];
        const d = Math.hypot(dx, dz);
        return d > 1e-6 ? [dx / d, dz / d] : forward;
      }
      const yaw = Math.atan2(forward[0], forward[1]) + detour * Math.PI / 180;
      return [Math.sin(yaw), Math.cos(yaw)];
    };
    // A stall (a lip or slope the controller cannot take although the probe passed) fails the current step.
    const failed = w.stallTicks >= S.stallTicks ? w.detour : undefined;
    if (sim.tick >= w.nextGroundTick || failed !== undefined) {
      if (failed !== undefined) w.stallTicks = 0;
      const verdict = failed === null ? 'blocked' : this.check(w, direction(null), ahead.point[1]);
      let chosen: number | null | undefined = verdict === 'clear' ? null : undefined;
      // Support ending and roads are where a walk turns; walls, posts, cars and people are stepped around.
      if (verdict === 'blocked' || verdict === 'rough') {
        const lateralOf = (d: number) => { const v = direction(d); return v[0] * normal[0] + v[1] * normal[1]; };
        const past = new Map<number, number>();
        const wayPast = (side: number) => {
          if (!past.has(side)) past.set(side, this.wayPast(w, forward, normal, ahead.point[1], side));
          return past.get(side)!;
        };
        // The side-step already taken while it stays clear; then parallel, then wider steps on the side it took, so a
        // walker at a post does not dither across its front. Without one, the side back toward the centreline, or
        // from the line, the side where the way past opens nearer.
        const off = Math.abs(w.offset) > 0.05;
        const side = w.detour ? Math.sign(lateralOf(w.detour)) : off ? -Math.sign(w.offset) : wayPast(-1) < wayPast(1) ? -1 : 1;
        const candidates: number[] = w.detour !== null ? [w.detour] : [];
        if (off && w.detour !== 0) candidates.push(0);
        for (const degrees of [...S.detourDegrees, S.sideStepDegrees]) {
          const pair = [degrees, -degrees].map(d => ({ d, lateral: lateralOf(d) })).sort((a, b) => (b.lateral - a.lateral) * side);
          for (const { d, lateral } of pair) if (d !== w.detour && Math.abs(w.offset + lateral * S.probe) <= S.maxOffset) candidates.push(d);
        }
        // Stepping out nearly sideways is for getting past something narrow: never along a wall that closes the way.
        const allowed = (d: number) => Math.abs(d) !== S.sideStepDegrees
          || (Math.abs(w.offset + lateralOf(d) * S.probe) <= S.maxOffset && wayPast(Math.sign(lateralOf(d))) < Infinity);
        for (const d of candidates) if (d !== failed && allowed(d) && this.check(w, direction(d), ahead.point[1]) === 'clear') { chosen = d; break; }
      }
      w.safeAhead = chosen !== undefined;
      if (chosen !== undefined) w.detour = chosen;
      // The probe passed where the body stalled, so a side-step chosen after a stall is kept a while before the line is tried again.
      w.nextGroundTick = sim.tick + (failed !== undefined && w.safeAhead ? S.stallDetourTicks
        : w.safeAhead && w.detour === null && !panicking ? PEDESTRIANS.groundCheckTicks : S.blockedProbeTicks);
    }
    return direction(w.detour);
  }

  private check(w: Walker, step: readonly [number, number], y: number): Verdict {
    const c = w.character, S = PEDESTRIAN_STEERING;
    const probe = groundProbe(this.sim.world, [c.position[0] + step[0] * S.probe, y, c.position[2] + step[1] * S.probe], c.body);
    if (typeof probe === 'string') return probe;
    if (!this.clearTraffic(probe)) return 'traffic';
    return Math.abs(probe[1] - c.position[1]) < 0.4 ? 'clear' : 'edge';
  }

  /**
   * How far off the route line, on `side` of it (+1 along the route normal, -1 against it), a step parallel to the route
   * clears what is ahead: Infinity when nothing within maxOffset does.
   */
  private wayPast(w: Walker, forward: readonly [number, number], normal: readonly [number, number], y: number, side: number): number {
    const S = PEDESTRIAN_STEERING;
    for (let lateral = S.gapStep; lateral <= S.maxOffset + 1e-9; lateral += S.gapStep) {
      const reach = (side * lateral - w.offset) / S.probe;
      if (this.check(w, [forward[0] + normal[0] * reach, forward[1] + normal[1] * reach], y) === 'clear') return lateral;
    }
    return Infinity;
  }

  /** False when a step within reach of the slot fails even with a side-step: a walker born there would bump into it. */
  private openSpan(slot: Slot): boolean {
    const S = PEDESTRIAN_STEERING;
    for (const side of [-1, 1]) {
      for (let k = 1; k * S.spanStep <= S.spanReach; k++) {
        const s = slot.s + side * k * S.spanStep;
        // A route end, a road or the end of support is where a walk turns anyway.
        if (s < 0.8 || s > slot.route.length - 0.8) break;
        const { point, tangent } = pointAlong(slot.route.points, s);
        const probe = groundProbe(this.sim.world, point);
        if (typeof probe !== 'string') { if (this.clearTraffic(probe)) continue; break; }
        if (probe === 'edge') break;
        const sidestep = [-1, 1].some(d => {
          const ground = pedestrianGround(this.sim.world, [point[0] + tangent[1] * d * S.spanSide, point[1], point[2] - tangent[0] * d * S.spanSide]);
          return !!ground && this.clearTraffic(ground);
        });
        if (!sidestep) return false;
      }
    }
    return true;
  }

  private fleeClip(w: Walker, speed = w.fleeSpeed): CharacterClip {
    return speed >= CIVILIAN_PANIC.sprintSpeed ? 'sprint' : 'run';
  }

  /**
   * Whether something jumpable stands just ahead on the way the walker flees, with support where it comes down at its
   * flee speed, jumping square to the face; if so, take off, keeping that direction, speed and touchdown for the jump.
   * Only static obstacles are jumped, never cars or people; a person or car standing in the jump's path refuses it.
   */
  private vaultOver(w: Walker, ahead: ReturnType<typeof pointAlong>): boolean {
    const c = w.character, sim = this.sim;
    if (!c.grounded || c.jumpPhase !== 'grounded' || sim.tick < w.vaultCooldownUntil) return false;
    const dx = ahead.point[0] - c.position[0], dz = ahead.point[2] - c.position[2], d = Math.hypot(dx, dz);
    if (d < 1e-6) return false;
    const dir = [dx / d, dz / d] as const, speed = Math.max(w.fleeSpeed, CIVILIAN_PANIC.runSpeed);
    const target = vaultTarget(sim.world, c.position, dir, c.speed, speed, ahead.point[1], c.collider, c.body);
    if (!target || !target.support.every(p => this.clearTraffic(p))) return false;
    if (!c.requestJump()) return false;
    w.vault = { dir: target.dir, start: [c.position[0], c.position[1], c.position[2]], tick: sim.tick, speed, landing: target.landing };
    sim.emit('civilianVault', c.id);
    return true;
  }

  /**
   * Straight on over the obstacle, square to its face, at the speed its touchdown was checked for, whatever a later shot
   * raised the flee speed to, and no farther than that touchdown: grab its edge if the jump falls short, and once down at
   * the route's level, stop driving and hand back to route following and its own support checks.
   */
  private vaulting(w: Walker): void {
    const c = w.character, sim = this.sim, V = CIVILIAN_VAULT, vault = w.vault!;
    c.turnToward(Math.atan2(vault.dir[0], vault.dir[1]), CIVILIAN_PANIC.turnRate * 2);
    if (c.jumpPhase === 'rise' || c.jumpPhase === 'fall') c.tryGrabLedge(sim.world, vault.dir[0], vault.dir[1]);
    const along = (p: V3) => (p[0] - vault.start[0]) * vault.dir[0] + (p[2] - vault.start[2]) * vault.dir[1];
    const progress = along(c.position), speed = Math.min(vault.speed, Math.max(0, along(vault.landing) - progress) * TICK_HZ);
    c.desiredVx = vault.dir[0] * speed; c.desiredVz = vault.dir[1] * speed;
    this.clip(c, this.fleeClip(w, vault.speed));
    const elapsed = sim.tick - vault.tick, down = c.grounded && (c.jumpPhase === 'grounded' || c.jumpPhase === 'land');
    if (elapsed < V.settleTicks || !(down || elapsed >= V.timeoutTicks)) return;
    w.s = clamp(pedestrianRouteCoordinate(w.route.points, c.position, w.s), 0.8, w.route.length - 0.8);
    const level = Math.abs(c.position[1] - pointAlong(w.route.points, w.s).point[1]) < V.levelTolerance;
    if (!level && elapsed < V.timeoutTicks) return;
    this.endVault(w, progress < V.minimumProgress || !level);
  }

  /** Hand a finished jump back to route following; one that `failed` is not tried again for `cooldownTicks`. */
  private endVault(w: Walker, failed: boolean): void {
    if (failed) w.vaultCooldownUntil = this.sim.tick + CIVILIAN_VAULT.cooldownTicks;
    w.character.desiredVx = 0; w.character.desiredVz = 0;
    w.vault = null; w.detour = null; w.safeAhead = false; w.nextGroundTick = 0; w.blockedTicks = 0;
    this.hold(w);
  }

  /**
   * Knocked down or killed: a jump not yet off the ground, a rise or a ledge climb stops at once, and the body drops from
   * where it was hit under gravity, with no horizontal drive, onto whatever is below. A fall already under way goes on.
   * The vault ends as a failed one, so a walker that gets up again follows its route rather than the old jump. Once the
   * jump is over this does nothing.
   */
  private abandonJump(w: Walker): void {
    const c = w.character;
    if (c.climb || c.jumpPhase === 'takeoff' || (!c.grounded && c.verticalSpeed > 0)) c.resetJump();
    if (w.vault) this.endVault(w, true);
  }

  /**
   * A body dropped straight down can come down with the rim of its capsule on an edge and its feet over a drop deeper
   * than route following steps down (`levelTolerance`): the controller holds it up there on nothing. While knocked down
   * it slides off, away from the edge, until it falls clear onto what is below: about the capsule's radius at most. Standing
   * on flat ground costs no query; on any other support one ray a tick.
   */
  private slideOffEdge(c: Character): void {
    for (let i = 0; i < c.controller.numComputedCollisions(); i++) {
      const n = c.controller.computedCollision(i)?.normal1, out = n ? Math.hypot(n.x, n.z) : 0;
      if (!n || n.y < 0.2 || out < 1e-3) continue;
      const tolerance = CIVILIAN_VAULT.levelTolerance;
      if (this.sim.world.spawnGroundBelow(c.position[0], c.position[1] + CHARACTER_SKIN, c.position[2], tolerance + CHARACTER_SKIN)) return;
      c.desiredVx = n.x / out * KNOCKDOWN_EDGE_SLIDE; c.desiredVz = n.z / out * KNOCKDOWN_EDGE_SLIDE;
      return;
    }
  }

  private shooterNear(w: Walker): boolean {
    return !!w.threat && distanceXZ(w.threat, w.character.position) < CIVILIAN_PANIC.standNearShooter;
  }

  /** Standing still on purpose is not being stuck. */
  private hold(w: Walker): void {
    w.progressS = w.s; w.progressTick = this.sim.tick; w.stallTicks = 0;
  }

  private reverse(w: Walker, forced: boolean): void {
    const sim = this.sim, S = PEDESTRIAN_STEERING;
    w.direction *= -1; w.waitUntil = sim.tick + 30 + Number.parseInt(fnv1a(`${w.character.id}:${sim.tick}`), 16) % 120;
    w.blockedTicks = 0; w.nextGroundTick = 0; w.safeAhead = false; w.detour = null;
    if (!forced) return;
    // Next time it turns short of here, as at a route end, instead of walking into the same thing again.
    const [low, high] = w.limits ?? [0, w.route.length];
    w.limits = w.direction < 0 ? [low, Math.min(high, w.s + S.turnShort)] : [Math.max(low, w.s - S.turnShort), high];
    w.limitsUntil = sim.tick + S.limitTicks;
    if (w.limits[1] - w.limits[0] < S.minimumSpan) { this.strand(w); return; }
    w.forcedReversals.push(sim.tick);
    if (w.forcedReversals.length > S.badRouteReversals) w.forcedReversals.shift();
    if (w.forcedReversals.length === S.badRouteReversals && sim.tick - w.forcedReversals[0]! <= S.badRouteWindowTicks) this.strand(w);
  }

  /** A route that keeps trapping walkers: no births on it for a while, and this walker stands until it can retire. */
  private strand(w: Walker): void {
    if (w.stranded) return;
    w.stranded = true;
    this.badRoutes.set(w.route.id, this.sim.tick + PEDESTRIAN_STEERING.badRouteTicks);
    this.sim.emit('civilianStranded', w.character.id);
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
