import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LaneSegmentIndex, RoadIndex, pointAlong, polylineLength, validateRoadGraph, type LaneHit } from '../src/roads.ts';
import type { RoadGraph } from '../src/types.ts';

// Two one-way lanes joined by a right turn at node n1: a (west→east along z=0) then b (south along x=20).
const graph: RoadGraph = {
  schemaVersion: 2, originId: 'o', source: { id: 'osm', sha256: 'x', attribution: 'a', license: 'ODbL' },
  nodes: [{ id: 'n0', position: [0, 0, 0], kind: 'boundary' }, { id: 'n1', position: [20, 0, 0], kind: 'junction' }, { id: 'n2', position: [20, 0, 30], kind: 'end' }],
  lanes: [
    { id: 'a', wayId: 1, name: 'A', highway: 'residential', surface: 'asphalt', speedLimit: 8, width: 3, from: 'n0', to: 'n1', points: [[0, 0, 0], [20, 0, 0]], length: 20, index: 0, count: 1 },
    { id: 'b', wayId: 2, name: 'B', highway: 'residential', surface: 'asphalt', speedLimit: 8, width: 3, from: 'n1', to: 'n2', points: [[20, 0, 0], [20, 0, 30]], length: 30, index: 0, count: 1 },
  ],
  connectors: [{ id: 'a>b', node: 'n1', from: 'a', to: 'b', turn: 'right', points: [[20, 0, 0], [20, 0, 0]], length: 0 }],
  parking: [], footways: [],
};

test('nearest lane, routing and route points on a tiny graph', () => {
  const idx = new RoadIndex(graph);
  const hit = idx.nearestLane(10, 1.5)!;
  assert.equal(hit.laneId, 'a');
  assert.ok(Math.abs(hit.s - 10) < 1e-9 && Math.abs(hit.distance - 1.5) < 1e-9);
  // Direction preference: heading east prefers lane a even from a point nearer b's start.
  assert.equal(idx.nearestLane(19, 2, [1, 0])!.laneId, 'a');
  const route = idx.route('a', 5, 'b', 10);
  assert.deepEqual(route, ['a', 'a>b', 'b']);
  assert.equal(idx.route('b', 5, 'a', 10), null, 'no way back on one-way lanes');
  const pts = idx.routePoints(route!);
  assert.deepEqual(pts.map(p => [p[0], p[2]]), [[0, 0], [20, 0], [20, 30]]);
  assert.equal(polylineLength(pts), 50);
  assert.deepEqual(pointAlong(pts, 25).point, [20, 0, 5]);
  assert.deepEqual(validateRoadGraph(graph), []);
});

/** The original linear scan, kept as the reference the segment grid must reproduce exactly. */
function linearNearest(lanes: readonly RoadGraph['lanes'][number][], x: number, z: number, heading: [number, number] | undefined, maxDistance: number): LaneHit | null {
  let best: LaneHit | null = null, bestScore = Infinity;
  for (const lane of lanes) {
    let s = 0;
    for (let i = 1; i < lane.points.length; i++) {
      const a = lane.points[i - 1]!, b = lane.points[i]!;
      const dx = b[0] - a[0], dz = b[2] - a[2], len2 = dx * dx + dz * dz;
      const t = len2 > 0 ? Math.min(1, Math.max(0, ((x - a[0]) * dx + (z - a[2]) * dz) / len2)) : 0;
      const px = a[0] + dx * t, pz = a[2] + dz * t, d = Math.hypot(px - x, pz - z);
      if (d <= maxDistance) {
        let score = d;
        if (heading && len2 > 0) { const len = Math.sqrt(len2); score += (1 - ((dx / len) * heading[0] + (dz / len) * heading[1])) * 4; }
        if (score < bestScore) { bestScore = score; best = { laneId: lane.id, s: s + Math.sqrt(len2) * t, point: [px, a[1] + (b[1] - a[1]) * t, pz], distance: d }; }
      }
      s += Math.sqrt(len2);
    }
  }
  return best;
}

test('the lane segment grid returns exactly the linear scan result, ties and edges included', () => {
  let seed = 12345;
  const random = (): number => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
  const lanes = Array.from({ length: 120 }, (_, l) => {
    const points: [number, number, number][] = [[random() * 900 - 450, random() * 10, random() * 600 - 300]];
    const steps = 1 + Math.floor(random() * 6);
    for (let i = 0; i < steps; i++) { const p = points[points.length - 1]!; points.push(i === 2 ? [p[0], p[1], p[2]] : [p[0] + random() * 80 - 40, p[1], p[2] + random() * 80 - 40]); }
    return { ...graph.lanes[0]!, id: `l${l}`, points };
  });
  // A duplicate lane makes exact ties, which must keep the first lane.
  lanes.push({ ...lanes[7]!, id: 'dup' });
  const index = new LaneSegmentIndex(lanes);
  for (let q = 0; q < 4000; q++) {
    const x = random() * 1100 - 550, z = random() * 800 - 400, a = random() * Math.PI * 2;
    const heading: [number, number] | undefined = q % 3 === 0 ? undefined : [Math.sin(a), Math.cos(a)];
    const maxDistance = [10, 20, 30, 40, 60, 80, 200, 5000][q % 8]!;
    assert.deepEqual(index.nearest(x, z, heading, maxDistance), linearNearest(lanes, x, z, heading, maxDistance));
  }
  const vertex = lanes[3]!.points[1]!;
  assert.deepEqual(index.nearest(vertex[0] + 30, vertex[2], undefined, 30), linearNearest(lanes, vertex[0] + 30, vertex[2], undefined, 30));
});
