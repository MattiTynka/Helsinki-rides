import assert from 'node:assert/strict';
import test from 'node:test';
import {encodeCollisionBundle, parseCollisionBundle} from '../../../packages/world-schema/src/index.ts';
import {appendSupportCollision, buildSupportApproach, replaceSupportCollision, retainOutsideSupport, supportHeight, validateSupportPatch, type SupportTriangle, type TramSupportPatch} from '../lib/tram-support-repair.ts';
import type {TramGroundTriangle} from '../lib/tram-visuals.ts';

const patch: TramSupportPatch = {id: 'test-road', cell: 'c_p00_p00', boundsXZ: [0, 0, 1, 1], footprint: [[0, 0], [1, 0], [1, 1], [0, 1]], sourceNode: 'c_p00_p00_ground_asphalt', sourcePrimitive: 0, observations: [], triangles: [[[0, .1, 0], [0, .1, 1], [1, .1, 1]], [[0, .1, 0], [1, .1, 1], [1, .1, 0]]].map(t => t.map(v => v.map(Math.fround))) as SupportTriangle[]};
const mesh = (values: number[]) => ({attributes: {POSITION: Float32Array.from(values)}, components: {POSITION: 3}, normalized: {POSITION: false}, indices: Uint32Array.from({length: values.length / 3}, (_, i) => i)});
const area = (m: ReturnType<typeof mesh>) => {let sum = 0; for (let i = 0; i < m.indices.length; i += 3) {const v = [0, 1, 2].map(k => Array.from(m.attributes.POSITION.subarray(m.indices[i + k]! * 3, m.indices[i + k]! * 3 + 3))); sum += Math.abs((v[1]![0]! - v[0]![0]!) * (v[2]![2]! - v[0]![2]!) - (v[1]![2]! - v[0]![2]!) * (v[2]![0]! - v[0]![0]!)) / 2;} return sum;};
test('Bounded ground clipping partitions area and retains wholly outside triangle indices and original vertex data', () => {
  const source = mesh([-1, 0, -1, -1, 0, 2, 2, 0, 2, -1, 0, -1, 2, 0, 2, 2, 0, -1, 3, 0, 3, 3, 0, 4, 4, 0, 4]);
  const result = retainOutsideSupport(source, [patch]);
  assert.ok(Math.abs(area(result.mesh as ReturnType<typeof mesh>) - (area(source) - 1)) < 1e-6);
  assert.deepEqual(result.mesh.attributes.POSITION!.subarray(0, source.attributes.POSITION.length), source.attributes.POSITION);
  assert.deepEqual(Array.from(result.mesh.indices.slice(-3)), [6, 7, 8]);
  assert.deepEqual(result.proof.removedSourceTriangles, [0, 1]);
});
test('Known vertical wall facets inside the footprint are removed while exterior walls remain exact', () => {
  const source = mesh([.5, 0, .5, .5, 1, .5, .5, 1, .8, 2, 0, .5, 2, 1, .5, 2, 1, .8]);
  const result = retainOutsideSupport(source, [patch]);
  assert.deepEqual(result.proof.removedSourceTriangles, [0]);
  assert.deepEqual(Array.from(result.mesh.indices), [3, 4, 5]);
});
test('Unselected architecture sharing a distant primitive is never clipped', () => {
  const source = mesh([.1, 2, .1, .1, 2, .9, .9, 2, .9]);
  const result = retainOutsideSupport(source, [patch], () => false);
  assert.deepEqual(result.mesh.indices, source.indices); assert.deepEqual(result.mesh.attributes.POSITION, source.attributes.POSITION);
});
function collision() {
  const ground = {...mesh([-1, 0, -1, -1, 0, 2, 2, 0, 2, -1, 0, -1, 2, 0, 2, 2, 0, -1]), id: 'g:c_p00_p00', group: 'ground' as const, ref: null};
  const building = {id: 'building-1', group: 'buildings' as const, ref: 'source-building', positions: Float32Array.from([0, 0, 0, 0, 4, 0, 1, 4, 0]), indices: Uint32Array.from([0, 1, 2]), triangleTags: Uint16Array.from([1])};
  return encodeCollisionBundle({originId: 'test', frame: 'X-east,Y-up,Z-south', cell: 'c_p00_p00', surfaceTags: ['road:asphalt', 'wall']}, [{id: ground.id, group: ground.group, ref: null, positions: ground.attributes.POSITION, indices: ground.indices, triangleTags: Uint16Array.from([0, 0])}, building]);
}
test('Append API preserves every original collider; replacement API retains exact building collider and clips only ground', () => {
  const old = collision(), parsed = parseCollisionBundle(old), appended = parseCollisionBundle(appendSupportCollision(old, [patch]));
  assert.deepEqual(appended.colliders.slice(0, 2), parsed.colliders);
  const replaced = parseCollisionBundle(replaceSupportCollision(old, [patch]).bytes);
  assert.deepEqual(replaced.colliders[1], parsed.colliders[1]);
  assert.equal(replaced.colliders.at(-1)!.indices.length, 6);
  assert.deepEqual(replaced.colliders.at(-1)!.positions, Float32Array.from(patch.triangles.flat(2)));
});
test('Collapsed or inverted Float32 support fails instead of silently authorizing rail placement', () => {
  assert.throws(() => validateSupportPatch({...patch, triangles: [[[0, 0, 0], [0, 0, 0], [1, 0, 1]]]}));
  assert.throws(() => validateSupportPatch({...patch, triangles: [[[0, 0, 0], [1, 0, 0], [1, 0, 1]]]}));
});
test('Measured replacement creates one closed shared grid across a source step, with literal source-bound outer profile', () => {
  const low: SupportTriangle[] = [[[-3, 0, -3], [-3, 0, 3], [3, 0, 3]], [[-3, 0, -3], [3, 0, 3], [3, 0, -3]]], high: SupportTriangle[] = [[[-3, .1, -3], [-3, .1, 0], [3, .1, 0]], [[-3, .1, -3], [3, .1, 0], [3, .1, -3]]];
  const ground: TramGroundTriangle[] = [...low, ...high].map((vertices, i) => ({id: String(i), vertices, visual: {node: 'ground', primitive: 0, triangle: i}, collision: {collider: 'g', triangles: [i]}, tag: 'road:asphalt'}));
  const result = buildSupportApproach(ground, {id: 'test-transition', cell: 'c_p00_p00', origin: [0, 0], lowerDirection: [0, 1], length: 2, upperLength: 2, wheelHalfWidth: .8, returnWidth: .2, seamSearch: .01, sourceNode: 'ground', sourcePrimitive: 0});
  assert.equal(result.proof.gradeBoundPassed, true); assert.ok(result.patch.boundary!.length > 20);
  assert.ok(result.patch.triangles.some(t => Math.abs(supportHeight(t, [0, 1]) - .05) < .02));
  for (const v of result.patch.boundary!) if (v[2] === 2) assert.ok(Math.abs(v[1]) < 1e-6);
});
