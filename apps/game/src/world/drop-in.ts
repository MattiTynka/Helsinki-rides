import type { GameplayBundle, RoadIndex } from '@helsinki/world-schema';

export type DropInTarget = readonly [x: number, z: number];
const MAX_ROAD_DISTANCE = 80;

/** Addresses are building centres. Prefer a nearby street without imposing a geographic fence. */
export function resolveDropInTarget(_gameplay: GameplayBundle, roads: RoadIndex, x: number, z: number): DropInTarget | null {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  const nearest = roads.nearestLane(x, z, undefined, MAX_ROAD_DISTANCE);
  return nearest ? [nearest.point[0], nearest.point[2]] : [x, z];
}
