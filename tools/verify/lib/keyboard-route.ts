// Read-only lane-graph route planning for real keyboard driving harnesses.
import { RoadIndex, pointAlong, type LaneHit, type RoadGraph, type Vec3 } from '../../../packages/world-schema/src/index.ts';
export interface DriveGoal { label: string; xz: [number, number]; road: string; radius?: number }
export interface PlannedDriveLeg { goal: DriveGoal; target: LaneHit; route: string[]; points: Vec3[]; length: number; roadNames: string[] }
type Area = { minX: number; maxX: number; minZ: number; maxZ: number };
const distance = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[2] - b[2]);
function sliceLine(points: readonly Vec3[], from: number, to: number): Vec3[] {
  const result = [pointAlong(points, from).point]; let s = 0;
  for (let i = 1; i < points.length; i++) { s += distance(points[i - 1]!, points[i]!); if (s > from + 1e-5 && s < to - 1e-5) result.push(points[i]!); }
  result.push(pointAlong(points, to).point); return result;
}
export function clippedRoutePoints(index: RoadIndex, route: string[], from: LaneHit, to: LaneHit): Vec3[] {
  const points: Vec3[] = [];
  for (const [i, id] of route.entries()) {
    const lane = index.laneById.get(id), connector = index.connectorById.get(id);
    if (!lane && !connector) throw new Error(`Missing road segment ${id}`);
    const segment = lane ? sliceLine(lane.points, i === 0 ? from.s : 0, i === route.length - 1 ? to.s : lane.length) : connector!.points;
    for (const p of segment) if (!points.length || distance(points.at(-1)!, p) > 0.02) points.push(p);
  }
  // Bounded spacing lets the keyboard follower advance locally through long straight road pieces.
  const dense: Vec3[] = points.length ? [points[0]!] : [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = points[i]!, count = Math.max(1, Math.ceil(distance(a, b) / 3));
    for (let k = 1; k <= count; k++) { const t = k / count; dense.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]); }
  }
  return dense;
}
export function planDriveLeg(index: RoadIndex, from: LaneHit, goal: DriveGoal, returnTarget: LaneHit, area: Area): PlannedDriveLeg {
  const rows: (PlannedDriveLeg & { score: number })[] = [];
  for (const lane of index.graph.lanes) {
    if (lane.name !== goal.road) continue;
    const single = new RoadIndex({ ...index.graph, lanes: [lane], connectors: [] } as RoadGraph);
    const target = single.nearestLane(goal.xz[0], goal.xz[1], undefined, goal.radius ?? 45); if (!target) continue;
    const route = index.route(from.laneId, from.s, target.laneId, target.s);
    const back = index.route(target.laneId, target.s, returnTarget.laneId, returnTarget.s); if (!route || !back) continue;
    const points = clippedRoutePoints(index, route, from, target), backPoints = clippedRoutePoints(index, back, target, returnTarget);
    if ([...points, ...backPoints].some(p => p[0] < area.minX + 2 || p[0] > area.maxX - 2 || p[2] < area.minZ + 2 || p[2] > area.maxZ - 2)) continue;
    const length = points.slice(1).reduce((sum, p, i) => sum + distance(points[i]!, p), 0);
    rows.push({ goal, target, route, points, length, roadNames: [...new Set(route.map(id => index.laneById.get(id)?.name).filter((n): n is string => !!n))], score: target.distance + length * .01 });
  }
  rows.sort((a, b) => a.score - b.score);
  const best = rows[0]; if (!best) throw new Error(`No bounded directed road route to ${goal.label} with a return to Senate Square`);
  const { score: _, ...leg } = best; return leg;
}
