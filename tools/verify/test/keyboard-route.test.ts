import assert from 'node:assert/strict';
import test from 'node:test';
import { RoadIndex, type RoadGraph, type RoadLane, type Vec3 } from '../../../packages/world-schema/src/index.ts';
import { clippedRoutePoints, planDriveLeg } from '../lib/keyboard-route.ts';
function fixture() {
  const lane = (id: string, name: string, a: Vec3, b: Vec3): RoadLane => ({ id, name, wayId: id.charCodeAt(0), highway: 'residential', surface: 'asphalt', speedLimit: 8, width: 3, from: id + '-start', to: id + '-end', points: [a, b], length: Math.hypot(b[0] - a[0], b[2] - a[2]), index: 0, count: 1 });
  const lanes = [lane('a', 'Senate', [0, 0, 0], [0, 0, 30]), lane('b', 'Kluuvi', [0, 0, 30], [-30, 0, 30]), lane('c', 'Return', [-30, 0, 30], [-30, 0, 0]), lane('d', 'Senate', [-30, 0, 0], [0, 0, 0]), lane('e', 'Dead end', [0, 0, 30], [30, 0, 30])];
  const connectors = [[0, 1], [1, 2], [2, 3], [3, 0], [0, 4]].map(([a, b]) => ({ id: `${lanes[a!]!.id}>${lanes[b!]!.id}`, node: 'junction', from: lanes[a!]!.id, to: lanes[b!]!.id, turn: 'left' as const, points: [lanes[a!]!.points.at(-1)!, lanes[b!]!.points[0]!], length: 0 }));
  const graph: RoadGraph = { schemaVersion: 2, originId: 'test', source: { id: 'fixture', sha256: '', attribution: '', license: '' }, nodes: [], lanes, connectors, parking: [], footways: [] };
  return new RoadIndex(graph);
}
test('keyboard route trims first and final lanes and keeps corners with bounded lookahead spacing', () => {
  const r = fixture(), from = r.nearestLane(0, 12)!, to = r.nearestLane(-21, 30)!;
  const points = clippedRoutePoints(r, r.route(from.laneId, from.s, to.laneId, to.s)!, from, to);
  assert.deepEqual(points[0], [0, 0, 12]); assert.deepEqual(points.at(-1), [-21, 0, 30]); assert.ok(points.some(p => p[0] === 0 && p[2] === 30));
  for (let i = 1; i < points.length; i++) assert.ok(Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![2] - points[i - 1]![2]) <= 3.00001);
});
test('keyboard route rejects one-way traps and plans only a bounded returnable road path', () => {
  const r = fixture(), from = r.nearestLane(0, 12)!, back = r.nearestLane(0, 10)!, area = { minX: -50, maxX: 50, minZ: -10, maxZ: 40 };
  assert.throws(() => planDriveLeg(r, from, { label: 'trap', xz: [20, 30], road: 'Dead end' }, back, area), /No bounded directed road route/);
  const good = planDriveLeg(r, from, { label: 'Kluuvi', xz: [-20, 30], road: 'Kluuvi' }, back, area); assert.equal(good.target.laneId, 'b'); assert.ok(good.length > 30);
  assert.throws(() => planDriveLeg(r, from, { label: 'Kluuvi', xz: [-20, 30], road: 'Kluuvi' }, back, { ...area, minX: -25 }), /No bounded directed road route/);
});
