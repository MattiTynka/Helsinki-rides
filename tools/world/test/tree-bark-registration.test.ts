import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Document, NodeIO } from '@gltf-transform/core';
import { decodeTreeBarkModels, measureTreeBarkProfile, planTreeCaseSink, qualifyContinuousTreeCase, qualifyTreeBank, visibleTreeObstacles, type BarkPoint, type BarkTriangle, type TreeBarkModel } from '../lib/tree-bark-registration.ts';
import { type GroundRegistrationSupport, type RegistrationTree, type TreeSoilContext } from '../lib/tree-ground-registration.ts';

const tree: RegistrationTree = { id: 'source-id', model: 'tree-birch', position: [3, 2, 4], yaw: .4, scale: [1, 2, 1], trunkRadius: .4, colliderHeight: 3 };
const support = (height: number): GroundRegistrationSupport => ({ height, group: 'ground', tag: 'raised:grass', collider: 'g:c', cell: 'c' });
const clear: TreeSoilContext = { retainingWallIds: [], buildingIds: [], waterPointIndices: [] };
const model = (): TreeBarkModel => {
  const root: BarkPoint[] = Array.from({ length: 9 }, (_, k) => [.4 * Math.cos(k * Math.PI * 2 / 9), 0, .4 * Math.sin(k * Math.PI * 2 / 9)]);
  const triangles: BarkTriangle[] = root.flatMap((a, k) => { const b = root[(k + 1) % root.length]!, c: BarkPoint = [a[0] * .8, 2, a[2] * .8], d: BarkPoint = [b[0] * .8, 2, b[2] * .8]; return [[a, b, c], [b, d, c]] as BarkTriangle[]; });
  return { root, triangles };
};
test('explicit continuous-soil exception accepts a steep continuous profile and rejects a small-step cliff', () => {
  const sample = (points: readonly [number, number][]) => points.map(([x]) => support((x - tree.position[0]) * 1.5 + 4));
  const p = measureTreeBarkProfile(model(), tree, sample), limits = { id: tree.id, maximumRangeMetres: 1.3, maximumAdjacentStepMetres: .04, maximumPlaneResidualMetres: .01, maximumSlope: 1.6 };
  assert.equal(p.rootPoints.length, 10); assert.ok(p.gridPoints.length > 100); assert.ok(p.range![1] - p.range![0] > .6);
  assert.ok(qualifyContinuousTreeCase(p, clear, [], limits));
  const cliff = measureTreeBarkProfile(model(), tree, points => points.map(([x]) => support(x >= 3 ? 4 : 3)));
  assert.throws(() => qualifyContinuousTreeCase(cliff, clear, [], { ...limits, maximumRangeMetres: 1.5, maximumAdjacentStepMetres: .08, maximumPlaneResidualMetres: .16 }), /no longer qualified/);
  assert.throws(() => qualifyContinuousTreeCase(p, { ...clear, retainingWallIds: ['wall'] }, [], limits), /no longer qualified/);
  assert.throws(() => qualifyContinuousTreeCase(p, clear, [{ cell: 'c', node: 'c_ground_slabs', triangle: 1, vertices: model().triangles[0]!, intersections: [[3, 4, 4]] }], limits), /no longer qualified/);
});
test('explicit bank sink requires a dry centre, source-water-only missing roots and continuous dry interior', () => {
  const profile = measureTreeBarkProfile(model(), tree, points => points.map(([x]) => x > 3.15 ? null : support(.6)));
  const context = { ...clear, waterPointIndices: profile.rootSamples.flatMap((s, i) => s ? [] : [i]) }, dense = { ...clear, waterPointIndices: profile.gridSamples.flatMap((s, i) => s ? [] : [i]) };
  const q = qualifyTreeBank(profile, context, profile.rootSamples, [], 0, dense);
  assert.equal(q.target, -.02); assert.equal(q.bankBurial, .62); assert.ok(q.dryRimCount >= 5);
  const correction = planTreeCaseSink(tree, profile.rootSamples, profile.rootSamples, q.anchor, q.target, .15, 'shore-bank-sink');
  assert.equal(correction.afterY, -.02); assert.equal(correction.policy, 'shore-bank-sink');
  assert.throws(() => qualifyTreeBank(profile, context, [null, ...profile.rootSamples.slice(1)], [], 0, dense), /centre/);
  assert.throws(() => qualifyTreeBank(profile, { ...context, waterPointIndices: [] }, profile.rootSamples, [], 0, dense), /ambiguity/);
  assert.throws(() => qualifyTreeBank(profile, context, profile.rootSamples, [], 0, clear), /interior/);
  assert.throws(() => qualifyTreeBank(profile, { ...context, buildingIds: ['building'] }, profile.rootSamples, [], 0, dense), /ambiguity/);
});
test('actual bark decoder and visible triangle intersections distinguish a real facade from a remote one', async () => {
  const io = new NodeIO(), asset = new Document(), buffer = asset.createBuffer(), scene = asset.createScene(), bark = model(), points = bark.triangles.flat();
  const primitive = asset.createPrimitive().setMaterial(asset.createMaterial('tree_bark')).setAttribute('POSITION', asset.createAccessor().setType('VEC3').setArray(Float32Array.from(points.flat())).setBuffer(buffer)).setIndices(asset.createAccessor().setType('SCALAR').setArray(Uint32Array.from(points.map((_, i) => i))).setBuffer(buffer));
  scene.addChild(asset.createNode('tree-birch').setMesh(asset.createMesh().addPrimitive(primitive)));
  const decoded = await decodeTreeBarkModels(await io.writeBinary(asset)); assert.equal(decoded.get('tree-birch')!.root.length, 9);
  const wall = new Document(), wallBuffer = wall.createBuffer(), wallScene = wall.createScene();
  for (const [name, x] of [['owner_facades_0', 3], ['remote_facades_0', 10]] as const) wallScene.addChild(wall.createNode(name).setMesh(wall.createMesh().addPrimitive(wall.createPrimitive().setAttribute('POSITION', wall.createAccessor().setType('VEC3').setArray(Float32Array.from([x, 0, 3, x, 5, 3, x, 0, 5])).setBuffer(wallBuffer)).setIndices(wall.createAccessor().setType('SCALAR').setArray(Uint32Array.from([0, 1, 2])).setBuffer(wallBuffer)))));
  const hits = await visibleTreeObstacles(tree, decoded.get('tree-birch')!, .3, [.6, .6], [{ id: 'owner', bytes: await io.writeBinary(wall) }]);
  assert.ok(hits.length); assert.ok(hits.every(h => h.node === 'owner_facades_0')); assert.ok(hits.some(h => h.intersections.some(p => p[1] > .61)));
});
