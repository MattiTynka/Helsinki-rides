import { containsSupportedArea, type GameplayBundle, type RoadIndex } from '@helsinki/world-schema';
import { CHARACTER } from '@helsinki/sim';

export type DropInTarget = readonly [x: number, z: number];
// Match Simulation.dropIn's CHARACTER.radius + 0.02; validate the Float32 position the body will use.
const DROP_IN_CLEARANCE = CHARACTER.radius + 0.02;
const MAX_ROAD_DISTANCE = 80;

/** Shared by the menu and placement. Addresses are building centres, not playable ground positions. */
export function resolveDropInTarget(gameplay: GameplayBundle, roads: RoadIndex, x: number, z: number): DropInTarget | null {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  const nearest = roads.nearestLane(x, z, undefined, MAX_ROAD_DISTANCE);
  if (!gameplay.supportedArea) return nearest ? [nearest.point[0], nearest.point[2]] : [x, z];
  const qualify = (px: number, pz: number): DropInTarget | null => {
    const target: DropInTarget = [Math.fround(px), Math.fround(pz)];
    return containsSupportedArea(gameplay, ...target, DROP_IN_CLEARANCE) ? target : null;
  };
  const first = nearest && qualify(nearest.point[0], nearest.point[2]);
  if (first) return first;

  // An unqualified retained lane tail may be closer than a qualified street. Consider other segment
  // projections in stable source order, without moving along a lane or crossing a coverage hole.
  let best: DropInTarget | null = null, bestDistance = Infinity;
  if (nearest) for (const lane of roads.graph.lanes) for (let i = 1; i < lane.points.length; i++) {
    const a = lane.points[i - 1]!, b = lane.points[i]!;
    if (x < Math.min(a[0], b[0]) - MAX_ROAD_DISTANCE || x > Math.max(a[0], b[0]) + MAX_ROAD_DISTANCE
      || z < Math.min(a[2], b[2]) - MAX_ROAD_DISTANCE || z > Math.max(a[2], b[2]) + MAX_ROAD_DISTANCE) continue;
    const dx = b[0] - a[0], dz = b[2] - a[2], length2 = dx * dx + dz * dz;
    const t = length2 > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[2]) * dz) / length2)) : 0;
    const px = a[0] + dx * t, pz = a[2] + dz * t, distance = Math.hypot(px - x, pz - z);
    if (distance > MAX_ROAD_DISTANCE || distance >= bestDistance) continue;
    const target = qualify(px, pz);
    if (target) { best = target; bestDistance = distance; }
  }
  return best ?? qualify(x, z);
}
