import type { VehicleInteractionDefinition } from '@helsinki/world-schema';
import { CHARACTER, FEET_TO_CENTRE, type Character } from './character.ts';
import { rotate, type V3 } from './math.ts';
import type { Vehicle } from './vehicle.ts';
import { GROUP, groups, RAPIER, type StaticWorld } from './world.ts';

/** Shared with the authored Finn vehicle clips. +X is the driver's side, +Z is forward. */
export const VEHICLE_INTERACTION = {
  /**
   * Seconds per authored clip. The passenger and windshield exits climb across first; the flipped exits start
   * hanging upside down in the seat.
   */
  durations: { enter: 3.8, exit: 2.8, exitPassenger: 4.3, exitWindshield: 5.2, exitFlipped: 6.04, exitFlippedPassenger: 6.3 },
  stage: [1.45, 0, -0.95] as V3,
  /** Finn's heading relative to the car when the entry starts and when an exit ends (driver side). */
  entryYaw: -12 * Math.PI / 180,
  exitYaw: -35 * Math.PI / 180,
  /** After kicking out the windshield and sliding off the bonnet: feet in front of the car, facing away from it. */
  windshieldStage: [-0.3, 0, 2.75] as V3,
  windshieldYaw: 0,
  /** Share of the windshield exit at which the kick breaks the glass. */
  windshieldBreak: 2.46 / 5.2,
  /**
   * A car on its roof: where Finn stands behind the door's swing after crawling out and shutting it, as car-local X
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
/** The door Finn leaves by, or the broken-out windshield when both doors are blocked. */
export type VehicleExitRoute = VehicleSide | 'windshield';
export type VehicleClip = keyof typeof VEHICLE_INTERACTION.durations;

export interface VehicleInteractionState {
  readonly vehicleId: string;
  readonly stage: 'approach' | 'enter' | 'seated' | 'exit';
  /** The authored clip being played: entry (seated holds its last frame), driver exit or passenger exit. */
  readonly clip: VehicleClip;
  readonly side: VehicleExitRoute;
  /** 0..1 along the clip; each direction has its own clip, nothing plays backwards except an interrupted exit. */
  readonly progress: number;
  /** Car-local [x, z, yaw] of the walked-up position relative to the authored first entry frame. */
  readonly startOffset: readonly [number, number, number];
}

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
// These upper samples start 0.53 m above the car origin. On a car lying on its roof the same car-local points cover
// the door's swing and the gap Finn crawls through.
const DOOR_SWEEP: readonly V3[] = [[1.2, 0.85, -0.5], [1.55, 0.85, -0.15], [1.9, 0.85, 0.25], [0.9, 0.9, -0.3]];
// Over the bonnet as Finn slides out and down off the nose.
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

/** A short perimeter route avoids walking through the chassis from the far side or bonnet. */
export function vehicleApproachRoute(v: Vehicle, start: V3): V3[] {
  const dx = start[0] - v.position[0], dz = start[2] - v.position[2];
  const x = dx * Math.cos(v.yaw) - dz * Math.sin(v.yaw);
  const z = dx * Math.sin(v.yaw) + dz * Math.cos(v.yaw);
  const stage = vehicleInteractionOf(v).stage as V3;
  const side = Math.max(stage[0], v.def.collider.halfExtents[0] + CHARACTER.radius + 0.24);
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

/** Ways out in the order Finn tries them for a car in this posture. */
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

/** Finn's world heading when an exit clip ends. */
export function vehicleExitYaw(v: Vehicle, clip: VehicleClip): number {
  if (clip === 'exitWindshield') return v.yaw + VEHICLE_INTERACTION.windshieldYaw;
  if (clip === 'exit' || clip === 'exitPassenger') return v.yaw + VEHICLE_INTERACTION.exitYaw * (clip === 'exit' ? 1 : -1);
  // Upside down the car's X axis points the other way, so the heading goes through the car's actual rotation.
  const yaw = VEHICLE_INTERACTION.flippedYaw * (clip === 'exitFlipped' ? 1 : -1);
  const dir = rotate(v.rotation, [Math.sin(yaw), 0, Math.cos(yaw)]);
  return Math.atan2(dir[0], dir[2]);
}

/** Support and free space for one way out of the car, excluding this car and Finn; returns the feet position. */
export function vehicleExitClearance(world: StaticWorld, v: Vehicle, p: Character, blocksUpperDoor: ((collider: RAPIER.Collider) => boolean) | undefined, clip: VehicleClip): V3 | null {
  const route = vehicleExitRoute(clip), mirror = route === 'passenger' ? -1 : 1;
  const ia = vehicleInteractionOf(v);
  const samples = route === 'windshield' ? ia.bonnetPath as readonly V3[] : (ia.doorSweep as readonly V3[]).map(([x, y, z]) => [x * mirror, y, z] as V3);
  return exitClearance(world, v, p, blocksUpperDoor, exitStageLocal(v, clip), samples);
}

/** Validate support and the actual swept door space on one side of an upright car, excluding this car and Finn. */
export function vehicleDoorClearance(world: StaticWorld, v: Vehicle, p: Character, blocksUpperDoor?: (collider: RAPIER.Collider) => boolean, side: VehicleSide = 'driver'): V3 | null {
  return vehicleExitClearance(world, v, p, blocksUpperDoor, side === 'driver' ? 'exit' : 'exitPassenger');
}

function exitClearance(world: StaticWorld, v: Vehicle, p: Character, blocksUpperDoor: ((collider: RAPIER.Collider) => boolean) | undefined, standLocal: V3, samples: readonly V3[]): V3 | null {
  const stage = v.localToWorld(standLocal);
  const area = world.gameplay.playArea, margin = CHARACTER.radius + 0.08;
  if (stage[0] < area.minX + margin || stage[0] > area.maxX - margin || stage[2] < area.minZ + margin || stage[2] > area.maxZ - margin) return null;
  const support = world.groundBelow(stage[0], stage[1] + 0.6, stage[2], 1.2, v.body);
  if (!support || Math.abs(support.y - stage[1]) > 0.4) return null;
  const feet: V3 = [stage[0], support.y + 0.025, stage[2]];
  const filter = groups(GROUP.character, GROUP.static | GROUP.vehicle | GROUP.character);
  const blocked = (point: V3, shape: RAPIER.Shape, predicate?: (collider: RAPIER.Collider) => boolean): boolean => !!world.physics.intersectionWithShape(
    { x: point[0], y: point[1], z: point[2] }, IDENTITY, shape, undefined, filter, p.collider, v.body, predicate);
  // Keep every collider for the feet/standing destination, including bodies on the ground.
  if (blocked([feet[0], feet[1] + FEET_TO_CENTRE + 0.03, feet[2]], new RAPIER.Capsule(CHARACTER.halfHeight, CHARACTER.radius))) return null;
  // A settled corpse's unchanged standing proxy must not invent a person at door/torso height; walking collision
  // stays intact.
  for (const point of samples) {
    if (blocked(v.localToWorld(point), new RAPIER.Ball(0.32), blocksUpperDoor)) return null;
  }
  return feet;
}
