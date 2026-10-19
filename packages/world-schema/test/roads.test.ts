import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RoadIndex, pointAlong, polylineLength, validateRoadGraph } from '../src/roads.ts';
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
