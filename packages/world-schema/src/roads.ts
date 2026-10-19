// Road graph helpers shared by the sim (police routing, traffic) and the tools (validation, minimap bake).
import type { Vec3 } from './coordinates.ts';
import type { RoadConnector, RoadGraph, RoadLane } from './types.ts';

export interface LaneHit {
  readonly laneId: string;
  /** Distance along the lane polyline in metres. */
  readonly s: number;
  readonly point: Vec3;
  readonly distance: number;
}

export function polylineLength(points: readonly Vec3[]): number {
  let l = 0;
  for (let i = 1; i < points.length; i++) l += Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![2] - points[i - 1]![2]);
  return l;
}

/** Point at arc length s along a polyline (clamped), with the unit XZ tangent. */
export function pointAlong(points: readonly Vec3[], s: number): { point: Vec3; tangent: [number, number] } {
  let remaining = Math.max(0, s);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = points[i]!;
    const dx = b[0] - a[0], dz = b[2] - a[2];
    const len = Math.hypot(dx, dz);
    if (remaining <= len || i === points.length - 1) {
      const t = len > 0 ? Math.min(1, remaining / len) : 0;
      const tangent: [number, number] = len > 0 ? [dx / len, dz / len] : [0, -1];
      return { point: [a[0] + dx * t, a[1] + (b[1] - a[1]) * t, a[2] + dz * t], tangent };
    }
    remaining -= len;
  }
  const p = points[points.length - 1]!;
  return { point: [p[0], p[1], p[2]], tangent: [0, -1] };
}

export class RoadIndex {
  readonly laneById = new Map<string, RoadLane>();
  readonly connectorById = new Map<string, RoadConnector>();
  /** Outgoing connectors from the end of each lane. */
  readonly outgoing = new Map<string, RoadConnector[]>();
  readonly incoming = new Map<string, RoadConnector[]>();
  readonly graph: RoadGraph;

  constructor(graph: RoadGraph) {
    this.graph = graph;
    for (const lane of graph.lanes) this.laneById.set(lane.id, lane);
    for (const c of graph.connectors) {
      this.connectorById.set(c.id, c);
      let out = this.outgoing.get(c.from);
      if (!out) this.outgoing.set(c.from, out = []);
      out.push(c);
      let inc = this.incoming.get(c.to);
      if (!inc) this.incoming.set(c.to, inc = []);
      inc.push(c);
    }
  }

  /** Nearest lane by XZ distance to its polyline, optionally preferring lanes whose direction matches `heading` (unit XZ). */
  nearestLane(x: number, z: number, heading?: [number, number], maxDistance = 30): LaneHit | null {
    let best: LaneHit | null = null;
    let bestScore = Infinity;
    for (const lane of this.graph.lanes) {
      let s = 0;
      for (let i = 1; i < lane.points.length; i++) {
        const a = lane.points[i - 1]!, b = lane.points[i]!;
        const dx = b[0] - a[0], dz = b[2] - a[2];
        const len2 = dx * dx + dz * dz;
        const t = len2 > 0 ? Math.min(1, Math.max(0, ((x - a[0]) * dx + (z - a[2]) * dz) / len2)) : 0;
        const px = a[0] + dx * t, pz = a[2] + dz * t;
        const d = Math.hypot(px - x, pz - z);
        if (d <= maxDistance) {
          let score = d;
          if (heading && len2 > 0) {
            const len = Math.sqrt(len2);
            const dot = (dx / len) * heading[0] + (dz / len) * heading[1];
            score += (1 - dot) * 4; // up to 8 m penalty for driving against the lane
          }
          if (score < bestScore) {
            bestScore = score;
            best = { laneId: lane.id, s: s + Math.sqrt(len2) * t, point: [px, a[1] + (b[1] - a[1]) * t, pz], distance: d };
          }
        }
        s += Math.sqrt(len2);
      }
    }
    return best;
  }

  /**
   * Shortest lane route (Dijkstra over lanes and connectors) from a position on `fromLane` to a position on `toLane`.
   * Returns the ordered list of lane and connector ids, or null when unreachable.
   */
  route(fromLane: string, fromS: number, toLane: string, toS: number): string[] | null {
    if (fromLane === toLane && toS >= fromS) return [fromLane];
    const dist = new Map<string, number>();
    const prev = new Map<string, string>();
    const start = this.laneById.get(fromLane);
    if (!start || !this.laneById.has(toLane)) return null;
    dist.set(fromLane, start.length - fromS);
    const open: { id: string; d: number }[] = [{ id: fromLane, d: start.length - fromS }];
    const closed = new Set<string>();
    while (open.length) {
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (open[i]!.d < open[bi]!.d) bi = i;
      const { id, d } = open.splice(bi, 1)[0]!;
      if (closed.has(id)) continue;
      closed.add(id);
      for (const c of this.outgoing.get(id) ?? []) {
        const next = this.laneById.get(c.to);
        if (!next) continue;
        if (c.to === toLane) {
          const total = d + c.length + toS;
          if (total < (dist.get('$goal') ?? Infinity)) { dist.set('$goal', total); prev.set('$goal', c.id); prev.set(c.id, id); }
          continue;
        }
        const nd = d + c.length + next.length;
        if (nd < (dist.get(c.to) ?? Infinity)) {
          dist.set(c.to, nd);
          prev.set(c.to, c.id);
          prev.set(c.id, id);
          open.push({ id: c.to, d: nd });
        }
      }
    }
    if (!dist.has('$goal')) return null;
    const path: string[] = [toLane];
    let cursor = prev.get('$goal')!;
    while (cursor) {
      path.push(cursor);
      if (cursor === fromLane) break;
      cursor = prev.get(cursor)!;
    }
    return path.reverse();
  }

  /** Concatenated polyline for a route of lane and connector ids. */
  routePoints(route: readonly string[]): Vec3[] {
    const out: Vec3[] = [];
    for (const id of route) {
      const pts = this.laneById.get(id)?.points ?? this.connectorById.get(id)?.points ?? [];
      for (const p of pts) {
        const last = out[out.length - 1];
        if (!last || Math.hypot(last[0] - p[0], last[2] - p[2]) > 0.05) out.push(p);
      }
    }
    return out;
  }
}

export function validateRoadGraph(g: RoadGraph): string[] {
  const problems: string[] = [];
  const nodes = new Set(g.nodes.map(n => n.id));
  const lanes = new Map(g.lanes.map(l => [l.id, l]));
  for (const l of g.lanes) {
    if (!nodes.has(l.from) || !nodes.has(l.to)) problems.push(`lane ${l.id} references a missing node`);
    if (l.points.length < 2) problems.push(`lane ${l.id} has fewer than 2 points`);
    if (!(l.speedLimit > 0)) problems.push(`lane ${l.id} has no speed limit`);
    for (const p of l.points) if (!p.every(Number.isFinite)) problems.push(`lane ${l.id} has a non-finite point`);
  }
  for (const c of g.connectors) {
    if (!lanes.has(c.from) || !lanes.has(c.to)) problems.push(`connector ${c.id} references a missing lane`);
    if (c.points.length < 2) problems.push(`connector ${c.id} has fewer than 2 points`);
  }
  return problems;
}
