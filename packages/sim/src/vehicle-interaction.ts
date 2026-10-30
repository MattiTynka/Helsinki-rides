import { type VehicleInteractionDefinition } from '@helsinki/world-schema';
import { CHARACTER, FEET_TO_CENTRE, type Character } from './character.ts';
import { rotate, wrapAngle, type V3 } from './math.ts';
import type { Vehicle } from './vehicle.ts';
import { GROUP, groups, RAPIER, type StaticWorld } from './world.ts';

/** Shared with the authored Snow vehicle clips. +X is the driver's side, +Z is forward. */
export const VEHICLE_INTERACTION = {
  /**
   * Seconds per authored clip. The passenger and windshield exits climb across first; the flipped exits start
   * hanging upside down in the seat.
   */
  durations: { enter: 3.8, exit: 2.8, exitPassenger: 4.3, exitWindshield: 5.2, exitFlipped: 6.04, exitFlippedPassenger: 6.3, pushFront: 2.2, pushRear: 2.2, shovePerson: 1.32, shoveBody: 1.87 },
  /**
   * With the driver's door blocked by something other than a person, Snow shoves the car lengthwise from the
   * driver-side corner of its nose or tail: he stands `inset` in from the collider's side and `margin` off its end, and
   * each shove moves the car `distance` metres away from him over the `window` seconds of the clip. Shared with the
   * authored clips. After `shoves` shoves with the door still blocked he gives up.
   */
  push: { inset: 0.54, margin: 0.45, distance: 0.6, window: [0.8, 1.5], shoves: 8 },
  /**
   * A person or a body at the driver's door is shoved aside instead (no crime). Snow stands `reach` metres behind the
   * middle of whoever he shoves, facing the way they go; his hands carry them `push.distance` over `window` seconds
   * of the clip (shared with the authored clips, whose frame moves off with them), and they go on, staggering or
   * sliding, to `distance` metres over `tail` seconds. A body lies along its facing with its middle `bodyBack` metres
   * behind its root (the officer's death clip); it goes across its length from `reach` behind its middle, or, lying
   * along the car by the door, lengthwise from `endReach` behind its middle, at its head or feet. At most `shoves`
   * shoves, then the car push.
   */
  shove: {
    shovePerson: { window: [0.48, 0.9], reach: 0.8, endReach: 0.8, distance: 1.1, tail: 0.4 },
    shoveBody: { window: [0.68, 1.275], reach: 0.8, endReach: 1.5, distance: 0.85, tail: 0.3 },
    bodyBack: 0.18, shoves: 3,
  },
  stage: [1.45, 0, -0.95] as V3,
  /** Snow's heading relative to the car when the entry starts and when an exit ends (driver side). */
  entryYaw: -12 * Math.PI / 180,
  exitYaw: -35 * Math.PI / 180,
  /** After kicking out the windshield and sliding off the bonnet: feet in front of the car, facing away from it. */
  windshieldStage: [-0.3, 0, 2.75] as V3,
  windshieldYaw: 0,
  /** Share of the windshield exit at which the kick breaks the glass. */
  windshieldBreak: 2.46 / 5.2,
  /**
   * A car on its roof: where Snow stands behind the door's swing after crawling out and shutting it, as car-local X
   * and Z (the ground is the roof plane), and his heading relative to the car's forward axis there (driver side; the
   * passenger side mirrors).
   */
  flippedStage: [1.52, -0.88] as const,
  flippedYaw: 14 * Math.PI / 180,
  /** Car up-axis Y above which the upright clips play, and below which the flipped ones do. */
  uprightUp: 0.9,
  flippedUp: -0.7,
  approachTimeout: 12,
  stoppedSpeed: 0.3,
  /** The renderer blends out any remaining offset, so the walk-up only needs to get close. */
  arrivalRadius: 0.2,
  arrivalYaw: 40 * Math.PI / 180,
} as const;

export type VehicleSide = 'driver' | 'passenger';
/** The door Snow leaves by, or the broken-out windshield when both doors are blocked. */
export type VehicleExitRoute = VehicleSide | 'windshield';
export type VehicleClip = keyof typeof VEHICLE_INTERACTION.durations;
export type VehiclePushClip = 'pushFront' | 'pushRear';
export type VehicleShoveClip = 'shovePerson' | 'shoveBody';

export interface VehicleInteractionState {
  readonly vehicleId: string;
  /**
   * `push`: shoving the car clear of whatever blocks the driver's door, before walking back to it; `shove`: shoving a
   * person or a body aside from it. A shove clip's frame is Snow's own position and heading, not the car's.
   */
  readonly stage: 'approach' | 'push' | 'shove' | 'enter' | 'seated' | 'exit';
  /** The authored clip being played: entry (seated holds its last frame), a shove, driver exit or passenger exit. */
  readonly clip: VehicleClip;
  readonly side: VehicleExitRoute;
  /** 0..1 along the clip; each direction has its own clip, nothing plays backwards except an interrupted exit. */
  readonly progress: number;
  /** Car-local [x, z, yaw] of the walked-up position relative to the authored first entry frame. */
  readonly startOffset: readonly [number, number, number];
}

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
// These upper samples start 0.53 m above the car origin. On a car lying on its roof the same car-local points cover
// the door's swing and the gap Snow crawls through.
const DOOR_SWEEP: readonly V3[] = [[1.2, 0.85, -0.5], [1.55, 0.85, -0.15], [1.9, 0.85, 0.25], [0.9, 0.9, -0.3]];
// Over the bonnet as Snow slides out and down off the nose.
const BONNET_PATH: readonly V3[] = [[-0.3, 1.4, 1.0], [-0.3, 1.35, 1.6], [-0.3, 1.2, 2.2]];

/** The Lumi GT's cabin, which the original clips were authored in. */
export const LUMI_INTERACTION: VehicleInteractionDefinition = {
  poses: 'lumi-gt', stage: VEHICLE_INTERACTION.stage, windshieldStage: VEHICLE_INTERACTION.windshieldStage,
  flippedStage: [...VEHICLE_INTERACTION.flippedStage], doorSweep: DOOR_SWEEP, bonnetPath: BONNET_PATH,
};

/** The car's own fitted ways in and out, or the Lumi GT's. */
export function vehicleInteractionOf(v: Vehicle): VehicleInteractionDefinition {
  return v.def.interaction ?? LUMI_INTERACTION;
}

/** The standing point beside the door on either side. */
export function vehicleStage(v: Vehicle, side: VehicleSide): V3 {
  const [x, y, z] = vehicleInteractionOf(v).stage;
  return side === 'driver' ? [x, y, z] : [-x, y, z];
}

/** Car-local X of the walk along the driver's side, clear of the chassis. */
function sideWalk(v: Vehicle): number {
  return Math.max(vehicleInteractionOf(v).stage[0]!, v.def.collider.halfExtents[0] + CHARACTER.radius + 0.24);
}

/** From wherever Snow is to the corner he shoves from. Null when there is no clear way. */
export function vehiclePushRoute(world: StaticWorld, v: Vehicle, p: Character, clip: VehiclePushClip): V3[] | null {
  return routeRound(world, v, p, vehiclePushStage(v, clip));
}

/** Back from the corner to the door after a shove; whatever blocked the door is now ahead of or behind it. */
export function vehicleReturnRoute(world: StaticWorld, v: Vehicle, p: Character): V3[] | null {
  return routeRound(world, v, p, vehicleInteractionOf(v).stage as V3);
}

/**
 * A clear walk from where Snow is to a car-local point beside the car: straight there, or out to a ring round the car,
 * along it the shorter way or else the longer (round the passenger's side when a wall lines the driver's) and in, the
 * ring wider out when neither way is clear. He walks straight to the furthest point of a way he can reach, so that
 * wedged between the car and a wall he need not step out to the ring first. Null when no way is.
 */
function routeRound(world: StaticWorld, v: Vehicle, p: Character, target: V3): V3[] | null {
  const clear = (route: V3[]): boolean => { let from = p.position; return route.every(local => { const to = v.localToWorld(local), ok = walkClear(world, p, from, to); from = to; return ok; }); };
  if (clear([target])) return [target];
  const dx = p.position[0] - v.position[0], dz = p.position[2] - v.position[2], cos = Math.cos(v.yaw), sin = Math.sin(v.yaw);
  const start: V3 = [dx * cos - dz * sin, 0, dx * sin + dz * cos], { centre, halfExtents } = v.def.collider;
  for (const wide of [0, 0.9, 1.8]) {
    const x = sideWalk(v) + wide, end = halfExtents[2] + CHARACTER.radius + 0.3 + wide;
    // Driver's side, nose, passenger's side, tail.
    const ring: V3[] = [[x, 0, centre[2] - end], [x, 0, centre[2] + end], [-x, 0, centre[2] + end], [-x, 0, centre[2] - end]];
    const edges = ring.map((a, k) => { const b = ring[(k + 1) % 4]!; return { a, b, length: Math.hypot(b[0] - a[0], b[2] - a[2]) }; });
    const at = edges.map((_, k) => edges.slice(0, k).reduce((sum, e) => sum + e.length, 0)), loop = at[3]! + edges[3]!.length;
    const onRing = (q: V3): { s: number; point: V3 } => {
      let best = { s: 0, point: ring[0]!, d: Infinity };
      edges.forEach(({ a, b, length }, k) => {
        const t = Math.min(1, Math.max(0, ((q[0] - a[0]) * (b[0] - a[0]) + (q[2] - a[2]) * (b[2] - a[2])) / (length * length)));
        const point: V3 = [a[0] + (b[0] - a[0]) * t, 0, a[2] + (b[2] - a[2]) * t], d = Math.hypot(q[0] - point[0], q[2] - point[2]);
        if (d < best.d) best = { s: at[k]! + t * length, point, d };
      });
      return best;
    };
    const from = onRing(start), to = onRing(target), ahead = (to.s - from.s + loop) % loop;
    const ways = [1, -1].map(dir => {
      const span = dir > 0 ? ahead : loop - ahead;
      const corners = ring.map((c, k) => ({ c, d: (dir * (at[k]! - from.s) + loop) % loop })).filter(({ d }) => d > 0 && d < span).sort((a, b) => a.d - b.d);
      const route = [from.point, ...corners.map(({ c }) => c), to.point, target].filter((q, i, all) => Math.hypot(q[0] - (all[i - 1] ?? start)[0], q[2] - (all[i - 1] ?? start)[2]) > 0.05);
      return { route, length: route.reduce((sum, q, i) => sum + Math.hypot(q[0] - (route[i - 1] ?? start)[0], q[2] - (route[i - 1] ?? start)[2]), 0) };
    }).sort((a, b) => a.length - b.length);
    for (const { route } of ways) for (let k = route.length - 1; k >= 0; k--) if (clear(route.slice(k))) return route.slice(k);
  }
  return null;
}

/**
 * Whether `p` can walk straight between two feet points, stepping over kerbs and round people and bodies (other than
 * `other`, who is moving out of the way).
 */
function walkClear(world: StaticWorld, p: Character, from: V3, to: V3, other?: Character): boolean {
  const lift = FEET_TO_CENTRE + 0.2, start = { x: from[0], y: from[1] + lift, z: from[2] };
  return !world.physics.castShape(start, IDENTITY, { x: to[0] - from[0], y: to[1] - from[1], z: to[2] - from[2] }, new RAPIER.Capsule(CHARACTER.halfHeight, CHARACTER.radius - 0.03),
    0, 1, true, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, groups(GROUP.character, GROUP.static | GROUP.vehicle | GROUP.character), p.collider, p.body,
    other ? collider => collider.handle !== other.collider.handle : undefined);
}

/** A short perimeter route avoids walking through the chassis from the far side or bonnet. */
export function vehicleApproachRoute(v: Vehicle, start: V3): V3[] {
  const dx = start[0] - v.position[0], dz = start[2] - v.position[2];
  const x = dx * Math.cos(v.yaw) - dz * Math.sin(v.yaw);
  const z = dx * Math.sin(v.yaw) + dz * Math.cos(v.yaw);
  const stage = vehicleInteractionOf(v).stage as V3;
  const side = sideWalk(v);
  const rear = v.def.collider.centre[2] - v.def.collider.halfExtents[2] - CHARACTER.radius - 0.3;
  const front = v.def.collider.centre[2] + v.def.collider.halfExtents[2] + CHARACTER.radius + 0.3;
  if (x >= side - 0.12) return [[side, 0, z], stage];
  const end = z > 0 ? front : rear;
  if (z >= front - 0.2 || z <= rear + 0.2) return [[x, 0, end], [side, 0, end], stage];
  if (x < 0) return [[-side, 0, z], [-side, 0, end], [side, 0, end], stage];
  // A character close to the driver's side first steps out before moving along it.
  return [[side, 0, z], stage];
}

export type VehiclePosture = 'upright' | 'flipped';

/** Upright or lying on its roof; a car on its side or badly tilted has no authored way out. */
export function vehiclePosture(v: Vehicle): VehiclePosture | null {
  const up = v.up[1];
  return up >= VEHICLE_INTERACTION.uprightUp ? 'upright' : up <= VEHICLE_INTERACTION.flippedUp ? 'flipped' : null;
}

/** Ways out in the order Snow tries them for a car in this posture. */
export function vehicleExitClips(posture: VehiclePosture | null): readonly VehicleClip[] {
  if (posture === 'upright') return ['exit', 'exitPassenger', 'exitWindshield'];
  return posture === 'flipped' ? ['exitFlipped', 'exitFlippedPassenger'] : [];
}

export function vehicleExitRoute(clip: VehicleClip): VehicleExitRoute {
  return clip === 'exitWindshield' ? 'windshield' : clip === 'exitPassenger' || clip === 'exitFlippedPassenger' ? 'passenger' : 'driver';
}

/** Car-local feet at the end of an exit clip. A flipped car lies on its roof, so the ground is the collider top. */
function exitStageLocal(v: Vehicle, clip: VehicleClip): V3 {
  const ia = vehicleInteractionOf(v);
  if (clip === 'exitWindshield') return ia.windshieldStage as V3;
  if (clip === 'exitFlipped' || clip === 'exitFlippedPassenger') {
    const [x, z] = ia.flippedStage, roof = v.def.collider.centre[1] + v.def.collider.halfExtents[1];
    return [clip === 'exitFlipped' ? x : -x, roof, z];
  }
  return vehicleStage(v, vehicleExitRoute(clip) as VehicleSide);
}

/** Snow's world heading when an exit clip ends. */
export function vehicleExitYaw(v: Vehicle, clip: VehicleClip): number {
  if (clip === 'exitWindshield') return v.yaw + VEHICLE_INTERACTION.windshieldYaw;
  if (clip === 'exit' || clip === 'exitPassenger') return v.yaw + VEHICLE_INTERACTION.exitYaw * (clip === 'exit' ? 1 : -1);
  // Upside down the car's X axis points the other way, so the heading goes through the car's actual rotation.
  const yaw = VEHICLE_INTERACTION.flippedYaw * (clip === 'exitFlipped' ? 1 : -1);
  const dir = rotate(v.rotation, [Math.sin(yaw), 0, Math.cos(yaw)]);
  return Math.atan2(dir[0], dir[2]);
}

/**
 * Support and free space for one way out of the car, excluding this car and Snow; returns the feet position. `shift`
 * metres along the car's axis (+Z forward) asks the same of the car moved that far.
 */
export function vehicleExitClearance(world: StaticWorld, v: Vehicle, p: Character, blocksUpperDoor: ((collider: RAPIER.Collider) => boolean) | undefined, clip: VehicleClip, shift = 0): V3 | null {
  const route = vehicleExitRoute(clip), mirror = route === 'passenger' ? -1 : 1;
  const ia = vehicleInteractionOf(v);
  const samples = route === 'windshield' ? ia.bonnetPath as readonly V3[] : (ia.doorSweep as readonly V3[]).map(([x, y, z]) => [x * mirror, y, z] as V3);
  return exitClearance(world, v, p, blocksUpperDoor, exitStageLocal(v, clip), samples, shift);
}

/** Validate support and the actual swept door space on one side of an upright car, excluding this car and Snow. */
export function vehicleDoorClearance(world: StaticWorld, v: Vehicle, p: Character, blocksUpperDoor?: (collider: RAPIER.Collider) => boolean, side: VehicleSide = 'driver', shift = 0): V3 | null {
  return vehicleExitClearance(world, v, p, blocksUpperDoor, side === 'driver' ? 'exit' : 'exitPassenger', shift);
}

/** Where Snow stands to shove the car from its nose or tail, car-local, on the driver's side. */
export function vehiclePushStage(v: Vehicle, clip: VehiclePushClip): V3 {
  const { halfExtents, centre } = v.def.collider, { inset, margin } = VEHICLE_INTERACTION.push;
  return [halfExtents[0] - inset, 0, centre[2] + (clip === 'pushFront' ? 1 : -1) * (halfExtents[2] + margin)];
}

/** Snow's world heading at the corner he shoves from: along the car's axis, facing it. */
export function vehiclePushYaw(v: Vehicle, clip: VehiclePushClip): number {
  return wrapAngle(v.yaw + (clip === 'pushFront' ? Math.PI : 0));
}

/** The car's car-local Z direction under a shove: one on the nose moves it back. */
export function vehiclePushDirection(clip: VehiclePushClip): 1 | -1 {
  return clip === 'pushFront' ? -1 : 1;
}

/** How far a shove has moved the car `seconds` into its clip: a smoothstep over the push window. */
export function vehiclePushTravel(seconds: number): number {
  const { distance, window: [from, to] } = VEHICLE_INTERACTION.push;
  const s = Math.min(1, Math.max(0, (seconds - from) / (to - from)));
  return distance * s * s * (3 - 2 * s);
}

/** Support and room to stand at the corner Snow shoves from; returns the feet position. */
export function vehiclePushClearance(world: StaticWorld, v: Vehicle, p: Character, clip: VehiclePushClip): V3 | null {
  return exitClearance(world, v, p, undefined, vehiclePushStage(v, clip), []);
}

/**
 * The shove that frees a blocked driver's door, or null when there is none or a living person is what blocks it (a
 * body on the ground is an obstacle like a post): the corner (the tail first) whose fewest shoves, at most
 * `push.shoves`, leave the door clear, with room for the car all the way there, for Snow to stand at the corner and a
 * way for him to walk there from the door.
 */
export function vehiclePushPlan(world: StaticWorld, v: Vehicle, p: Character, blocksUpperDoor: (collider: RAPIER.Collider) => boolean, livingPerson: (collider: RAPIER.Collider) => boolean): { clip: VehiclePushClip; route: V3[] } | null {
  if (exitClearance(world, v, p, blocksUpperDoor, exitStageLocal(v, 'exit'), vehicleInteractionOf(v).doorSweep as readonly V3[], 0, undefined, collider => !livingPerson(collider))) return null;
  const { distance, shoves } = VEHICLE_INTERACTION.push, open = { pushRear: true, pushFront: true };
  for (let n = 1; n <= shoves; n++) {
    for (const clip of ['pushRear', 'pushFront'] as const) {
      const shift = vehiclePushDirection(clip) * n * distance;
      // Not only where the shoves end: the chassis is far longer than one shove, so whatever it would pass through on
      // the way meets it after one of the shoves before.
      if (open[clip] && !vehiclePathClear(world, v, shift)) open[clip] = false;
      if (!open[clip] || !vehiclePushClearance(world, v, p, clip) || !vehicleDoorClearance(world, v, p, blocksUpperDoor, 'driver', shift)) continue;
      const route = vehiclePushRoute(world, v, p, clip);
      if (route) return { clip, route };
    }
  }
  return null;
}

/** How far Snow's shove frame, his feet and his hands have moved `seconds` into a shove clip: a smoothstep over its window. */
export function vehicleShoveTravel(clip: VehicleShoveClip, seconds: number): number {
  const [from, to] = VEHICLE_INTERACTION.shove[clip].window;
  const s = Math.min(1, Math.max(0, (seconds - from) / (to - from)));
  return VEHICLE_INTERACTION.push.distance * s * s * (3 - 2 * s);
}

/** How far whoever is shoved has gone: carried by the hands, then on to the full distance, slowing. */
export function vehicleShoveTargetTravel(clip: VehicleShoveClip, seconds: number): number {
  const { window: [, to], distance, tail } = VEHICLE_INTERACTION.shove[clip], hands = VEHICLE_INTERACTION.push.distance;
  if (seconds <= to) return vehicleShoveTravel(clip, seconds);
  const s = Math.min(1, (seconds - to) / tail);
  return hands + (distance - hands) * (1 - (1 - s) * (1 - s));
}

export interface VehicleShovePlan {
  readonly clip: VehicleShoveClip;
  readonly target: Character;
  /** World direction (unit, level) the target goes and Snow faces. */
  readonly direction: V3;
  /** Snow's feet when the clip starts, and his heading. */
  readonly stand: V3;
  readonly yaw: number;
  /** Car-local walk to the stand. */
  readonly route: V3[];
}

/**
 * Shoving aside a person or a body that keeps the driver's door shut, or null when the door is shut by something else
 * too (a wall, a car, a post: that is the car push) or no shove has room. The one nearest the door goes first: a
 * person out from the car or along it, a body across its length; the ground ahead must take them, they must end clear
 * of the door, and Snow needs ground and room behind them and a way to walk there.
 */
export function vehicleShovePlan(world: StaticWorld, v: Vehicle, p: Character, blocksUpperDoor: (collider: RAPIER.Collider) => boolean, characterOf: (collider: RAPIER.Collider) => Character | null): VehicleShovePlan | null {
  const ia = vehicleInteractionOf(v), standLocal = exitStageLocal(v, 'exit'), sweep = ia.doorSweep as readonly V3[];
  const isOther = (collider: RAPIER.Collider): boolean => { const c = characterOf(collider); return !!c && c !== p; };
  if (!exitClearance(world, v, p, blocksUpperDoor, standLocal, sweep, 0, undefined, collider => !isOther(collider))) return null;
  const stage = v.localToWorld(standLocal);
  const blockers = new Set<Character>();
  world.physics.intersectionsWithShape({ x: stage[0], y: stage[1] + 1, z: stage[2] }, IDENTITY, new RAPIER.Ball(3), collider => {
    const c = characterOf(collider);
    if (c && c !== p && !c.inVehicle && !exitClearance(world, v, p, blocksUpperDoor, standLocal, sweep, 0, undefined, other => other.handle === c.collider.handle)) blockers.add(c);
    return true;
  }, undefined, groups(GROUP.character, GROUP.character));
  const order = [...blockers].sort((a, b) => Math.hypot(a.position[0] - stage[0], a.position[2] - stage[2]) - Math.hypot(b.position[0] - stage[0], b.position[2] - stage[2]) || (a.id < b.id ? -1 : 1));
  const out = rotate(v.rotation, [1, 0, 0]), along = rotate(v.rotation, [0, 0, 1]);
  const level = (d: V3): V3 => { const n = Math.hypot(d[0], d[2]); return [d[0] / n, 0, d[2] / n]; };
  const doorPoints = [stage, ...sweep.map(point => v.localToWorld(point))];
  for (const target of order) {
    const clip: VehicleShoveClip = target.alive ? 'shovePerson' : 'shoveBody', spec = VEHICLE_INTERACTION.shove[clip];
    const facing: V3 = [Math.sin(target.yaw), 0, Math.cos(target.yaw)];
    const middle: V3 = target.alive ? target.position : [target.position[0] - facing[0] * VEHICLE_INTERACTION.shove.bodyBack, target.position[1], target.position[2] - facing[2] * VEHICLE_INTERACTION.shove.bodyBack];
    const outward = (d: V3): number => d[0] * out[0] + d[2] * out[2];
    const directions: V3[] = target.alive
      ? ([out, [out[0] - along[0], 0, out[2] - along[2]], [out[0] + along[0], 0, out[2] + along[2]], [-along[0], 0, -along[2]], along] as V3[]).map(level)
      : [...([[facing[2], 0, -facing[0]], [-facing[2], 0, facing[0]]] as V3[]).sort((a, b) => outward(b) - outward(a)), facing, [-facing[0], 0, -facing[2]]];
    for (const [i, d] of directions.entries()) {
      const reach = !target.alive && i >= 2 ? spec.endReach : spec.reach;
      const end: V3 = [target.position[0] + d[0] * spec.distance, target.position[1], target.position[2] + d[2] * spec.distance];
      // Clear of the door's stand (and, for someone standing, of its swing) where they end up.
      const reachDoor = (point: V3, i: number): boolean => (i === 0 || blocksUpperDoor(target.collider)) && Math.hypot(point[0] - end[0], point[2] - end[2]) < CHARACTER.radius * 2 + 0.05;
      if (doorPoints.some(reachDoor)) continue;
      if (!standingRoom(world, end, target, p) || !walkClear(world, target, target.position, end, p)) continue;
      const feet: V3 = [middle[0] - d[0] * reach, middle[1], middle[2] - d[2] * reach];
      const stand = standingRoom(world, feet, p, target);
      const finish: V3 | null = stand && [stand[0] + d[0] * VEHICLE_INTERACTION.push.distance, stand[1], stand[2] + d[2] * VEHICLE_INTERACTION.push.distance];
      if (!stand || !finish || !walkClear(world, p, stand, finish, target)) continue;
      const route = shoveRoute(world, v, p, stand);
      if (route) return { clip, target, direction: d, stand, yaw: Math.atan2(d[0], d[2]), route };
    }
  }
  return null;
}

/** Ground at about the height of `feet` with room for `who` to stand there, ignoring `other`; returns the feet. */
function standingRoom(world: StaticWorld, feet: V3, who: Character, other: Character): V3 | null {
  const support = world.groundBelow(feet[0], feet[1] + 0.6, feet[2], 1.2);
  if (!support || Math.abs(support.y - feet[1]) > 0.4) return null;
  const at: V3 = [feet[0], support.y + 0.025, feet[2]];
  return world.physics.intersectionWithShape({ x: at[0], y: at[1] + FEET_TO_CENTRE + 0.03, z: at[2] }, IDENTITY, new RAPIER.Capsule(CHARACTER.halfHeight, CHARACTER.radius),
    undefined, groups(GROUP.character, GROUP.static | GROUP.vehicle | GROUP.character), who.collider, who.body, collider => collider.handle !== other.collider.handle) ? null : at;
}

/**
 * Round the car as for the door, then to the stand behind whoever he shoves, swinging out wide round them when the
 * nearer way is not clear (they are in the way of the walk until they are shoved); null when no way is.
 */
function shoveRoute(world: StaticWorld, v: Vehicle, p: Character, stand: V3): V3[] | null {
  const [qx, qy, qz, qw] = v.rotation, t = v.position;
  const local = rotate([-qx, -qy, -qz, qw], [stand[0] - t[0], stand[1] - t[1], stand[2] - t[2]]), legs = vehicleApproachRoute(v, p.position).slice(0, -1);
  const wide = (x: number): V3 => [Math.max(local[0], sideWalk(v)) + x, 0, local[2]];
  for (const route of [[...legs, local], [local], [...legs, wide(0.9), local], [wide(0.9), local], [...legs, wide(1.8), local]]) {
    let from = p.position;
    if (route.every(point => { const to = v.localToWorld(point), clear = walkClear(world, p, from, to); from = to; return clear; })) return route;
  }
  return null;
}

/**
 * The car other than `v` that reaches the capsule Snow is shown in with his feet at `feet`. A push or shove hides his
 * own capsule, so passing traffic would otherwise go through him.
 */
export function vehicleAtPose(world: StaticWorld, v: Vehicle, feet: V3, vehicleOf: (collider: RAPIER.Collider) => Vehicle | null): Vehicle | null {
  let found: Vehicle | null = null;
  world.physics.intersectionsWithShape({ x: feet[0], y: feet[1] + FEET_TO_CENTRE, z: feet[2] }, IDENTITY, new RAPIER.Capsule(CHARACTER.halfHeight, CHARACTER.radius), collider => {
    found = vehicleOf(collider);
    return !found;
  }, undefined, groups(GROUP.character, GROUP.vehicle), undefined, v.body);
  return found;
}

/** Whether the car's collider moved `shift` metres along its axis meets no wall or other car. */
function vehiclePathClear(world: StaticWorld, v: Vehicle, shift: number): boolean {
  const { halfExtents: [hx, hy, hz], centre: [cx, cy, cz] } = v.def.collider, [x, y, z] = v.localToWorld([cx, cy, cz + shift]), [qx, qy, qz, qw] = v.rotation;
  return !world.physics.intersectionWithShape({ x, y, z }, { x: qx, y: qy, z: qz, w: qw }, new RAPIER.Cuboid(hx, hy, hz), undefined,
    groups(GROUP.vehicle, GROUP.static | GROUP.vehicle), undefined, v.body);
}

/**
 * `mask` is the collision groups that count as blocking and `counts` drops single colliders from every check: a check
 * without the living tells a person in the way from a wall, a car or a body.
 */
function exitClearance(world: StaticWorld, v: Vehicle, p: Character, blocksUpperDoor: ((collider: RAPIER.Collider) => boolean) | undefined, standLocal: V3, samples: readonly V3[], shift = 0, mask = GROUP.static | GROUP.vehicle | GROUP.character, counts?: (collider: RAPIER.Collider) => boolean): V3 | null {
  const moved = ([x, y, z]: V3): V3 => v.localToWorld([x, y, z + shift]);
  const stage = moved(standLocal);
  const support = world.groundBelow(stage[0], stage[1] + 0.6, stage[2], 1.2, v.body);
  if (!support || Math.abs(support.y - stage[1]) > 0.4) return null;
  const feet: V3 = [stage[0], support.y + 0.025, stage[2]];
  const filter = groups(GROUP.character, mask);
  const blocked = (point: V3, shape: RAPIER.Shape, predicate?: (collider: RAPIER.Collider) => boolean): boolean => !!world.physics.intersectionWithShape(
    { x: point[0], y: point[1], z: point[2] }, IDENTITY, shape, undefined, filter, p.collider, v.body,
    counts ? collider => counts(collider) && (!predicate || predicate(collider)) : predicate);
  // Keep every collider for the feet/standing destination, including bodies on the ground.
  if (blocked([feet[0], feet[1] + FEET_TO_CENTRE + 0.03, feet[2]], new RAPIER.Capsule(CHARACTER.halfHeight, CHARACTER.radius))) return null;
  // A settled corpse's unchanged standing proxy must not invent a person at door/torso height; walking collision
  // stays intact.
  for (const point of samples) {
    if (blocked(moved(point), new RAPIER.Ball(0.32), blocksUpperDoor)) return null;
  }
  return feet;
}
