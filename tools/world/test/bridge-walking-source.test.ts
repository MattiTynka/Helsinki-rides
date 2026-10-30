import test from 'node:test';
import assert from 'node:assert/strict';
import type {Vec3} from '../../../packages/world-schema/src/index.ts';
import {bbox, pointInPolygon, type LocalPolygon} from '../lib/geometry.ts';
import {clipReviewedBridgeWalkingSources, prepareReviewedBridgeWalkingSource, reviewedBridgeWalkingParts, reviewedBridgeWalkingGapContains} from '../lib/bridge-walking-source.ts';
const part = (id: string, subtype = 'Jalankulkualue (Silta)'): LocalPolygon => {
  const rings: [number, number][][] = [[[0, 0], [10, 0], [10, -10], [0, -10]]];
  return {id, properties: {paatyyppi: 'Silta', alatyyppi: subtype}, rings, bbox: bbox(rings)};
};
const face = {points: [[1, 3, 1], [1, 3, 5], [5, 3, 1]] as Vec3[], sourcePartIds: [10]};
test('walking source is only its own pedestrian bridge polygon intersected with assigned upper faces', () => {
  const source = part('10'), result = clipReviewedBridgeWalkingSources([source], [face]);
  assert.equal(result.length, 1); assert.deepEqual(result[0]!.properties, source.properties);
  assert.ok(pointInPolygon([2, -2], result[0]!.rings));
  assert.ok(!pointInPolygon([8, -2], result[0]!.rings));
  assert.ok(!pointInPolygon([4, -4], result[0]!.rings));
  assert.deepEqual(source.rings, part('10').rings);
});
test('vehicle, cycle and another source part receive no pedestrian bridge permission', () => {
  assert.deepEqual(clipReviewedBridgeWalkingSources([part('10', 'Ajorata (Silta)'), part('10', 'Erotettu pyörätie (Silta)'), part('11')], [face]), []);
  assert.deepEqual(clipReviewedBridgeWalkingSources([part('10')], [{...face, sourcePartIds: [11]}]), []);
});
test('walking source authority cannot be transferred to another record or fabricated', () => {
  const prepared = prepareReviewedBridgeWalkingSource({recordId: 'w123', parts: [part('10')], faces: [face]});
  assert.equal(reviewedBridgeWalkingParts(prepared.authority, 'w123', '10').length, 1);
  assert.equal(reviewedBridgeWalkingGapContains(prepared.authority, 'w123', ['10'], 2, 2), false);
  assert.throws(() => reviewedBridgeWalkingParts(prepared.authority, 'w124', '10'));
  assert.throws(() => reviewedBridgeWalkingParts({} as typeof prepared.authority, 'w123', '10'));
  assert.throws(() => prepareReviewedBridgeWalkingSource({recordId: 'w123', parts: [part('10')], faces: [face], additions: [{authority: {} as never, profileBytes: new Uint8Array(), baseProfileBytes: new Uint8Array()}]}));
  const detached = reviewedBridgeWalkingParts(prepared.authority, 'w123', '10'); detached[0]!.rings[0]![0]![0] = 999;
  assert.notEqual(reviewedBridgeWalkingParts(prepared.authority, 'w123', '10')[0]!.rings[0]![0]![0], 999);
});
