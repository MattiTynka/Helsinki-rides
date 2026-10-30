import assert from 'node:assert/strict';
import {test} from 'node:test';
import {polylineLength, type RoadGraph, type RoadLane, type Vec3} from '../../../packages/world-schema/src/index.ts';
import {repairNewStraightConnectorOvershoot} from '../lib/road-connector-repair.ts';

function fixture() {
  const lane = (id: string, from: string, to: string, points: Vec3[]): RoadLane => ({id, wayId: 1, from, to, points, length: polylineLength(points), name: '', highway: 'residential', width: 3, index: 0, count: 1, surface: 'asphalt', speedLimit: 8});
  const old = lane('1:0:f0', 'n1', 'n2', [[-10, 0, 0], [0, 0, 0]]), fresh = lane('2:0:f0', 'n2', 'n3', [[-.02, 0, 0], [10, 0, 0]]);
  const accepted: RoadGraph = {schemaVersion: 2, originId: 'fixture', source: {id: 's', sha256: 'a'.repeat(64), license: 'fixture', attribution: 'fixture'}, nodes: [], lanes: [old], connectors: [], footways: [], parking: []};
  const connector = {id: old.id + '>' + fresh.id, from: old.id, to: fresh.id, node: 'n2', turn: 'straight' as const, points: [[0, 0, 0], [.1, 0, 0], [-.1, 0, 0], [-.02, 0, 0]] as Vec3[], length: .38};
  return {accepted, candidate: {...accepted, lanes: [old, fresh], connectors: [connector]}, fresh, connector};
}

test('source-identical near-coincident connector trims only new source geometry and removes reversal', () => {
  const f = fixture(), before = structuredClone(f), result = repairNewStraightConnectorOvershoot(f.accepted, f.candidate, [f.fresh.id], [f.connector.id], () => ({height: 0}));
  assert.deepEqual(f, before); assert.deepEqual(result.graph.lanes[0], f.accepted.lanes[0]);
  const connector = result.graph.connectors[0]!; assert.deepEqual(connector.points[0], f.accepted.lanes[0]!.points.at(-1)); assert.deepEqual(connector.points.at(-1), result.graph.lanes[1]!.points[0]);
  assert.ok(connector.points.every((point, i, all) => !i || point[0] > all[i - 1]![0])); assert.equal(result.witness.changes.length, 2);
  assert.equal(result.witness.junctions[0]!.trims[0]!.metres, .1);
});

test('connector repair fails closed on opposite source direction or absent physical support', () => {
  const opposite = fixture(); opposite.candidate.lanes[1] = {...opposite.fresh, points: [[-.02, 0, 0], [-10, 0, 0]]};
  assert.throws(() => repairNewStraightConnectorOvershoot(opposite.accepted, opposite.candidate, [opposite.fresh.id], [opposite.connector.id], () => ({height: 0})), /straight continuation/);
  const f = fixture(); assert.throws(() => repairNewStraightConnectorOvershoot(f.accepted, f.candidate, [f.fresh.id], [f.connector.id], () => null), /native road ground/);
});

test('ordinary junctions remain exact and unselected accepted endpoints cannot be trimmed', () => {
  const f = fixture(), long = structuredClone(f.candidate); long.lanes[1] = {...f.fresh, points: [[2, 0, 0], [10, 0, 0]]};
  const unchanged = repairNewStraightConnectorOvershoot(f.accepted, long, [f.fresh.id], [f.connector.id], () => ({height: 0})); assert.deepEqual(unchanged.graph, long); assert.deepEqual(unchanged.witness.changes, []);
  assert.throws(() => repairNewStraightConnectorOvershoot(f.accepted, f.candidate, [], [f.connector.id], () => ({height: 0})), /cannot trim accepted/);
});

test('explicit source-pinned shallow curve keeps bounded new-only trims and forward alignment', () => {
  const f = fixture(), angle = 27 * Math.PI / 180;
  f.candidate.lanes[1] = {...f.fresh, points: [[0, 0, 0], [10 * Math.cos(angle), 0, 10 * Math.sin(angle)]]};
  const empty = {...f.accepted, lanes: []};
  assert.throws(() => repairNewStraightConnectorOvershoot(empty, f.candidate, ['1:0:f0', f.fresh.id], [f.connector.id], () => ({height: 0})), /straight continuation/);
  const review = [{id: f.connector.id, maximumAngleDegrees: 28}];
  const result = repairNewStraightConnectorOvershoot(empty, f.candidate, ['1:0:f0', f.fresh.id], [f.connector.id], () => ({height: 0}), review);
  assert.equal(result.witness.junctions.length, 1); assert.deepEqual(result.witness.reviewedCurves, review);
  assert.deepEqual(result.witness.junctions[0]!.trims.map(trim => trim.metres), [.1, .1]);
  assert.throws(() => repairNewStraightConnectorOvershoot(f.accepted, f.candidate, [f.fresh.id], [f.connector.id], () => ({height: 0}), review), /newly authored source endpoints/);
  assert.throws(() => repairNewStraightConnectorOvershoot(empty, f.candidate, ['1:0:f0', f.fresh.id], [f.connector.id], () => ({height: 0}), [{...review[0]!, maximumAngleDegrees: 31}]), /Invalid bounded/);
  assert.throws(() => repairNewStraightConnectorOvershoot(empty, f.candidate, ['1:0:f0', f.fresh.id], [f.connector.id], () => null, review), /native road ground/);
});
