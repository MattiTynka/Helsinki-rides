// Focused asset regression: requires the approved supplied Snow source and frozen collar patch.
// Run with node --test tools/verify/test/snow-preservation.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseGlb } from '../glb.ts';
import { expectedCollarPatch, expectedHiddenCollarPatch, garmentDonorOwnership, verifyNativeSnowData } from '../verify-snow-preservation.mjs';

const source = readFileSync(process.env.SNOW_SOURCE ?? 'data/raw/snow12-20261017/snow.glb');
const patch = JSON.parse(readFileSync(process.env.SNOW_COLLAR_PATCH ?? 'data/work/snow12-20261017/collar-v1/patch.json'));
const hiddenPatch = JSON.parse(readFileSync(process.env.SNOW_HIDDEN_PATCH ?? 'data/work/snow12-20261017/hidden-collar-v1/patch.json'));
const doc = parseGlb(source), expected = expectedCollarPatch(doc, patch).expected;
const binStart = doc.bin.byteOffset - source.byteOffset;
const patched = Buffer.from(source); expected.copy(patched, binStart);
const mutate = (accessorIndex, vertex = 0, byte = 0) => {
  const output = Buffer.from(patched), accessor = doc.json.accessors[accessorIndex], view = doc.json.bufferViews[accessor.bufferView];
  const width = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[accessor.type];
  const size = { 5121: 1, 5123: 2, 5125: 4, 5126: 4 }[accessor.componentType];
  output[binStart + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0) + vertex * (view.byteStride ?? width * size) + byte] ^= 1;
  return output;
};
function replaceJson(json, bin = expected) {
  const align = n => (n + 3) & ~3, text = Buffer.from(JSON.stringify(json)), length = align(text.length);
  const out = Buffer.alloc(28 + length + align(bin.length));
  out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(length, 12); out.writeUInt32LE(0x4e4f534a, 16); out.fill(0x20, 20, 20 + length); text.copy(out, 20);
  out.writeUInt32LE(align(bin.length), 20 + length); out.writeUInt32LE(0x004e4942, 24 + length); bin.copy(out, 28 + length);
  return out;
}
const hidden = expectedHiddenCollarPatch(doc, hiddenPatch), finalJson = structuredClone(doc.json), finalBin = Buffer.from(expected);
finalJson.accessors[44] = hidden.accessor;
finalJson.bufferViews[hidden.bufferView].byteLength = hidden.packed.length;
const indexOffset = doc.json.bufferViews[hidden.bufferView].byteOffset;
hidden.packed.copy(finalBin, indexOffset); finalBin.fill(0, indexOffset + hidden.packed.length, indexOffset + hidden.originalByteLength);
const final = replaceJson(finalJson, finalBin);

test('strict original preservation remains available, and the exact patch changes only two verified views', () => {
  const original = verifyNativeSnowData(source, source);
  assert.equal(original.byteExactNonImageBufferViews, 2450); assert.equal(original.collarExceptionBufferViews, 0);
  const result = verifyNativeSnowData(source, patched, patch);
  assert.equal(result.verifiedNonImageBufferViews, 2450); assert.equal(result.byteExactNonImageBufferViews, 2448);
  assert.equal(result.collarExceptionBufferViews, 2); assert.equal(result.collarPatch.vertices.length, 89);
  assert.equal(result.nativeClips.length, 11);
});

test('patch must be explicit, must actually occur, and cannot use a different source', () => {
  assert.throws(() => verifyNativeSnowData(source, patched), /changed outside/);
  assert.throws(() => verifyNativeSnowData(source, source, patch), /changed outside/);
  const wrongSource = Buffer.from(source); wrongSource[wrongSource.length - 1] ^= 1;
  assert.throws(() => verifyNativeSnowData(wrongSource, patched, patch), /Unexpected supplied Snow source/);
});

test('one changed unlisted vertex in the same accepted views still fails', () => {
  const ids = new Set(patch.vertices.map(row => row.vertex));
  const unlisted = Array.from({ length: doc.json.accessors[42].count }, (_, i) => i).find(i => !ids.has(i));
  assert.notEqual(unlisted, undefined);
  for (const accessor of [42, 43]) assert.throws(() => verifyNativeSnowData(source, mutate(accessor, unlisted), patch), /changed outside/);
  assert.throws(() => verifyNativeSnowData(source, mutate(43, patch.vertices[0].vertex), patch), /changed outside/);
});

test('positions, normals, UVs, indices, inverse binds and native clip samples remain byte-exact', () => {
  const nativeClip = doc.json.animations[0].samplers[0].output;
  for (const accessor of [36, 37, 38, 44, doc.json.skins[0].inverseBindMatrices, nativeClip]) {
    assert.throws(() => verifyNativeSnowData(source, mutate(accessor), patch), /changed outside/);
  }
});

test('unchanged bytes cannot conceal edited mesh, rest, material or native clip declarations', () => {
  for (const edit of [
    j => { j.meshes[5].primitives[0].material = 1; },
    j => { j.nodes[0].translation = [1, 0, 0]; },
    j => { j.materials[0].doubleSided = !j.materials[0].doubleSided; },
    j => { j.animations[0].samplers[0].interpolation = 'STEP'; },
  ]) {
    const json = structuredClone(doc.json); edit(json);
    assert.throws(() => verifyNativeSnowData(source, replaceJson(json), patch));
  }
});

test('only the frozen 89-vertex patch content is accepted', () => {
  for (const edit of [
    p => p.vertices.pop(),
    p => { p.vertices[0].weights[0] += .0001; },
    p => { p.weightAccessor = 7; },
    p => { p.limits.bindMaximumDistanceMeters = 1; },
  ]) {
    const altered = structuredClone(patch); edit(altered);
    assert.throws(() => verifyNativeSnowData(source, patched, altered), /approved 89-vertex exception/);
  }
});

test('independent donor proof rejects wrong original tuples, ranges, triangles, barycentrics and replacement weights', () => {
  for (const [edit, error] of [
    [p => { p.vertices[0].beforeJoints[0] += 1; }, /original joints mismatch/],
    [p => { p.vertices[0].beforeWeights[0] += .01; }, /original weights mismatch/],
    [p => { p.vertices[0].sourceByteRanges.weights.offset += 4; }, /byte ranges/],
    [p => { p.vertices[0].donor.triangle = [0, 0, 0]; }, /original shirt triangle/],
    [p => { p.vertices[0].donor.barycentric = [-.01, .51, .5]; }, /strictly inside/],
    [p => { p.vertices[0].donorOwnership = { kind: 'internal-edge', edge: [0, 1], owners: 2 }; }, /Recorded garment ownership/],
    [p => { p.vertices[0].weights[0] -= .01; p.vertices[0].weights[1] += .01; }, /garment interpolation/],
    [p => { p.vertices[0].bindSignedSeparationMeters = 0; }, /bind separation mismatch/],
  ]) {
    const altered = structuredClone(patch); edit(altered);
    assert.throws(() => expectedCollarPatch(doc, altered), error);
  }
});

test('exact shared geometric edges are owned across attribute seams; open and proximity-only edges reject', () => {
  const positions = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 1, 0], [1, 0, 0]];
  const triangles = [[0, 1, 2], [4, 5, 3]], owner = garmentDonorOwnership(positions, triangles);
  assert.deepEqual(owner(triangles[0], [.00956, .49044, .5]), { kind: 'triangle-interior' });
  assert.deepEqual(owner(triangles[0], [0, .5, .5]), { kind: 'internal-edge', edge: [1, 2], owners: 2 });
  assert.throws(() => owner(triangles[0], [.5, .5, 0]), /boundary edge/);
  assert.throws(() => owner(triangles[0], [0, 1, 0]), /boundary vertex/);
  const nearlySame = structuredClone(positions); nearlySame[4][0] = 1e-9;
  assert.throws(() => garmentDonorOwnership(nearlySame, triangles)(triangles[0], [0, .5, .5]), /boundary edge/);
  assert.throws(() => garmentDonorOwnership(positions, [...triangles, triangles[1]])(triangles[0], [0, .5, .5]), /boundary edge/);
});

test('an exact donor vertex requires every incident edge to be closed', () => {
  const positions = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const triangles = [[0, 1, 2], [0, 3, 1], [0, 2, 3], [1, 3, 2]];
  assert.deepEqual(garmentDonorOwnership(positions, triangles)(triangles[0], [1, 0, 0]), { kind: 'internal-vertex', vertex: 0, incidentEdgeOwners: [2, 2, 2] });
  assert.throws(() => garmentDonorOwnership(positions, triangles.slice(0, 2))(triangles[0], [1, 0, 0]), /boundary vertex/);
});

test('the exact two-face exception preserves all retained indices and proves650 source shirt-ray hits', () => {
  const result = verifyNativeSnowData(source, final, patch, hiddenPatch);
  assert.equal(result.byteExactNonImageBufferViews, 2447); assert.equal(result.hiddenFaceExceptionBufferViews, 1);
  assert.equal(result.hiddenFacePatch.retainedIndexCount, 17610); assert.equal(result.hiddenFacePatch.zeroedUnusedTailBytes, 12);
  assert.deepEqual(result.hiddenFacePatch.coverage.map(t => t.samples.length), [325, 325]);
  assert.ok(result.hiddenFacePatch.coverage.every(t => t.maximumOutwardDistanceMeters < .002425 && t.minimumOpenBoundaryDistanceMeters > .00964));
  assert.throws(() => verifyNativeSnowData(source, final, patch));
  assert.throws(() => verifyNativeSnowData(source, final, null, hiddenPatch), /requires the approved collar/);
});

test('retained-index edits, extra removals, descriptor changes and nonzero unused tails reject', () => {
  for (const mutate of [
    (j, b) => { b[indexOffset] ^= 1; },
    (j, b) => { b[indexOffset + hidden.packed.length] = 1; },
    j => { j.accessors[44].count -= 3; },
    j => { j.bufferViews[hidden.bufferView].byteLength += 2; },
    (j, b) => { const triangle = Buffer.from(b.subarray(indexOffset, indexOffset + 6)); b.copyWithin(indexOffset, indexOffset + 6, indexOffset + 12); triangle.copy(b, indexOffset + 6); },
  ]) {
    const json = structuredClone(finalJson), bin = Buffer.from(finalBin); mutate(json, bin);
    assert.throws(() => verifyNativeSnowData(source, replaceJson(json, bin), patch, hiddenPatch));
  }
});

test('hidden-face identity and geometric coverage cannot be supplied as unchecked claims', () => {
  const changed = structuredClone(hiddenPatch); changed.triangles[0].triangleIndex = 12;
  assert.throws(() => verifyNativeSnowData(source, final, patch, changed), /approved two-triangle exception/);
  assert.throws(() => expectedHiddenCollarPatch(doc, changed), /Only the two approved/);
  const falseCoverage = structuredClone(hiddenPatch); falseCoverage.triangles[0].coverageProof.maximumOutwardDistanceMeters = 0;
  assert.throws(() => expectedHiddenCollarPatch(doc, falseCoverage), /cover distance differs/);
  const noShirtCover = { ...doc, bin: Buffer.from(doc.bin) };
  const pos = doc.json.accessors[78], view = doc.json.bufferViews[pos.bufferView];
  for (let i = 0; i < pos.count; i++) noShirtCover.bin.writeFloatLE(5, (view.byteOffset ?? 0) + i * 12 + 2 * 4);
  assert.throws(() => expectedHiddenCollarPatch(noShirtCover, hiddenPatch), /no outward original-shirt cover/);
});
