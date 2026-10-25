// Verify the integrated world and supplied Snow data independently of the asset authoring report.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { parseGlb, transformPoint, worldMatrices } from './glb.ts';

const suppliedSourceSha256 = '94b5759cea7c95b07028ed2482f7d747c13efa727796d84153a3a0e6f62f3123';
const approvedCollarPatchSha256 = '7d62ef73e14dc6c4bb98777cd386dc070f8730b1e10638b2e6cde05681e7900e';
const approvedCollarPatchContentSha256 = '922d2d7aedf0a90069a93ca311b18dfe3987e37cd7c51d440fb2f6b21e64a2d7';
const approvedHiddenPatchSha256 = 'bc0394d2301e5a13b800621cea676016dfdc7735270f259ee7cb254d9bf53825';
const approvedHiddenPatchContentSha256 = 'b2f02df72d670c554c313321215c424cb5cbb0ff68e015c11ecaa2dc51a7aa77';
const sha = b => createHash('sha256').update(b).digest('hex');

function element(source, accessorIndex, vertex) {
  const a = source.json.accessors[accessorIndex], view = source.json.bufferViews[a?.bufferView];
  assert.ok(a && view && view.buffer === 0 && !a.sparse && !a.normalized, `Unsupported source accessor ${accessorIndex}`);
  const width = { SCALAR: 1, VEC3: 3, VEC4: 4, MAT4: 16 }[a.type];
  const component = { 5121: [1, 'readUInt8'], 5123: [2, 'readUInt16LE'], 5125: [4, 'readUInt32LE'], 5126: [4, 'readFloatLE'] }[a.componentType];
  assert.ok(width && component && Number.isInteger(vertex) && vertex >= 0 && vertex < a.count, 'Invalid accessor element');
  const [size, method] = component, length = size * width;
  const offset = (view.byteOffset ?? 0) + (a.byteOffset ?? 0) + vertex * (view.byteStride ?? length);
  assert.ok(offset + length <= (view.byteOffset ?? 0) + view.byteLength && offset + length <= source.bin.length, 'Accessor element out of range');
  const data = Buffer.from(source.bin.buffer, source.bin.byteOffset, source.bin.byteLength);
  return { values: Array.from({ length: width }, (_, i) => data[method](offset + i * size)), offset, length, size, componentType: a.componentType, bufferView: a.bufferView };
}

const subtract = (a, b) => a.map((v, i) => v - b[i]);
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
function multiply(a, b) {
  return Array.from({ length: 16 }, (_, i) => {
    const row = i % 4, column = Math.floor(i / 4);
    return [0, 1, 2, 3].reduce((sum, k) => sum + a[k * 4 + row] * b[column * 4 + k], 0);
  });
}
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function bindPositionReader(source, skinIndex) {
  const skin = source.json.skins[skinIndex], worlds = worldMatrices(source.json);
  const jointMatrices = skin.joints.map((node, i) => multiply(worlds.get(node), element(source, skin.inverseBindMatrices, i).values));
  return (primitive, vertex) => {
    const point = element(source, primitive.attributes.POSITION, vertex).values;
    const joints = element(source, primitive.attributes.JOINTS_0, vertex).values;
    const weights = element(source, primitive.attributes.WEIGHTS_0, vertex).values, result = [0, 0, 0];
    for (let k = 0; k < 4; k++) if (weights[k]) transformPoint(jointMatrices[joints[k]], point).forEach((p, axis) => result[axis] += p * weights[k]);
    return result;
  };
}

// Attribute splits duplicate shirt vertices at UV/normal seams. Only exactly equal original
// POSITION tuples share ownership; proximity welding could incorrectly close a neckline.
export function garmentDonorOwnership(positions, triangles) {
  const keys = positions.map(p => p.join(',')), owners = new Map(), incident = new Map();
  const key = (a, b) => [keys[a], keys[b]].sort().join('|');
  for (const triangle of triangles) for (let i = 0; i < 3; i++) {
    const a = triangle[i], b = triangle[(i + 1) % 3], edge = key(a, b);
    assert.notEqual(keys[a], keys[b], 'Degenerate geometric garment edge');
    owners.set(edge, (owners.get(edge) ?? 0) + 1);
    for (const vertex of [keys[a], keys[b]]) {
      if (!incident.has(vertex)) incident.set(vertex, new Set());
      incident.get(vertex).add(edge);
    }
  }
  return (triangle, barycentric) => {
    const epsilon = 1e-7;
    assert.ok(barycentric.length === 3 && barycentric.every(v => Number.isFinite(v) && v >= -epsilon && v <= 1 + epsilon), 'Donor barycentrics lie outside the original triangle');
    assert.ok(Math.abs(barycentric.reduce((a, b) => a + b, 0) - 1) <= 1e-6, 'Donor barycentric sum is not one');
    const zeros = [0, 1, 2].filter(i => barycentric[i] <= epsilon);
    if (!zeros.length) return { kind: 'triangle-interior' };
    if (zeros.length === 1) {
      const edge = triangle.filter((_, i) => i !== zeros[0]);
      assert.equal(owners.get(key(...edge)), 2, 'Donor touches an open or nonmanifold garment boundary edge');
      return { kind: 'internal-edge', edge, owners: 2 };
    }
    assert.equal(zeros.length, 2, 'Invalid garment donor vertex');
    const vertex = triangle.find((_, i) => !zeros.includes(i));
    const counts = [...incident.get(keys[vertex])].map(edge => owners.get(edge));
    assert.ok(counts.length >= 3 && counts.every(n => n === 2), 'Donor touches an open or nonmanifold garment boundary vertex');
    return { kind: 'internal-vertex', vertex, incidentEdgeOwners: counts };
  };
}

// This exception is intentionally tied to one supplied mesh and one local, covered collar band.
// Reconstruct expected bytes from source and independently validate the garment donor; never
// skip entire weight buffer views merely because a patch refers to them.
export function expectedCollarPatch(source, patch) {
  assert.equal(patch.version, 1);
  assert.equal(patch.sourceSha256, suppliedSourceSha256);
  assert.equal(patch.meshName, 'SNOW-head_game');
  assert.equal(patch.primitive, 0);
  assert.equal(patch.jointAccessor, 42);
  assert.equal(patch.weightAccessor, 43);
  assert.ok(Array.isArray(patch.vertices) && patch.vertices.length === 89, 'The approved collar patch contains exactly 89 vertices');
  assert.deepEqual(patch.limits, { bindHeightMinMeters: 1.3, bindHeightMaxMeters: 1.45, bindMaximumDistanceMeters: .015, bindMinimumInteriorBarycentric: .02, bindMinimumInsideMeters: .0001, maximumWeights: 4, maxNormalizedSumError: .000001, sampleHz: 120, outwardSeparationToleranceMeters: .001 }, 'Approved collar limits changed');
  const mesh = source.json.meshes.find(m => m.name === patch.meshName), head = mesh?.primitives[0];
  const shirtMesh = source.json.meshes.findIndex(m => m.name === 'SNOW-shirt_game');
  const shirt = source.json.meshes[shirtMesh]?.primitives[0];
  assert.equal(head?.attributes.JOINTS_0, patch.jointAccessor);
  assert.equal(head?.attributes.WEIGHTS_0, patch.weightAccessor);
  assert.ok(shirt, 'Missing original garment donor');
  const headNode = source.json.nodes.find(n => n.mesh === source.json.meshes.indexOf(mesh));
  const shirtNode = source.json.nodes.find(n => n.mesh === shirtMesh);
  assert.equal(headNode.skin, shirtNode.skin, 'Donor uses a different skin');
  const skin = source.json.skins[headNode.skin], bindPosition = bindPositionReader(source, headNode.skin);
  const triangleKeys = new Set(), shirtTriangles = [];
  const indexCount = source.json.accessors[shirt.indices].count;
  for (let i = 0; i < indexCount; i += 3) {
    const triangle = [0, 1, 2].map(k => element(source, shirt.indices, i + k).values[0]);
    triangleKeys.add(triangle.join(',')); shirtTriangles.push(triangle);
  }
  const shirtPositions = Array.from({ length: source.json.accessors[shirt.attributes.POSITION].count }, (_, i) => element(source, shirt.attributes.POSITION, i).values);
  const ownershipOf = garmentDonorOwnership(shirtPositions, shirtTriangles);
  const expected = Buffer.from(source.bin), seen = new Set(), rows = [];
  for (const row of patch.vertices) {
    assert.ok(Number.isInteger(row.vertex) && !seen.has(row.vertex), 'Duplicate or invalid collar vertex'); seen.add(row.vertex);
    assert.ok(typeof row.reason === 'string' && row.reason.length > 0, 'Patch reason is required');
    const joints = element(source, patch.jointAccessor, row.vertex), weights = element(source, patch.weightAccessor, row.vertex);
    assert.deepEqual(row.beforeJoints, joints.values, `Vertex ${row.vertex}: original joints mismatch`);
    assert.deepEqual(row.beforeWeights, weights.values, `Vertex ${row.vertex}: original weights mismatch`);
    assert.deepEqual(row.sourceByteRanges, { joints: { offset: joints.offset, length: joints.length }, weights: { offset: weights.offset, length: weights.length } }, 'Patch byte ranges do not identify the declared vertex');
    assert.equal(joints.componentType, 5121); assert.equal(weights.componentType, 5126);
    const donor = row.donor;
    assert.equal(donor?.meshName, 'SNOW-shirt_game'); assert.equal(donor?.primitive, 0);
    assert.ok(Array.isArray(donor.triangle) && donor.triangle.length === 3 && triangleKeys.has(donor.triangle.join(',')), 'Donor is not an original shirt triangle');
    assert.ok(Array.isArray(donor.barycentric) && donor.barycentric.every(v => v >= .02), 'Donor barycentrics must be strictly inside the original triangle');
    const donorOwnership = ownershipOf(donor.triangle, donor.barycentric);
    if (row.donorOwnership) assert.deepEqual(row.donorOwnership, donorOwnership, 'Recorded garment ownership differs from original source topology');
    const point = bindPosition(head, row.vertex), points = donor.triangle.map(i => bindPosition(shirt, i));
    assert.ok(point[1] >= 1.3 && point[1] <= 1.45 && Math.abs(point[0]) <= .16 && point[2] >= -.09 && point[2] <= .115, 'Patch exceeds the covered lower-neck band');
    const clothPoint = [0, 1, 2].map(axis => points.reduce((sum, p, i) => sum + p[axis] * donor.barycentric[i], 0));
    const u = subtract(points[1], points[0]), v = subtract(points[2], points[0]);
    const cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]], length = Math.hypot(...cross);
    assert.ok(length > 0, 'Degenerate garment donor');
    const normal = cross.map(n => n / length), delta = subtract(point, clothPoint), signed = dot(delta, normal), distance = Math.hypot(...delta);
    assert.ok(signed < -.0001 && distance <= .015, 'Patch vertex is not bind-covered by a nearby shirt triangle');
    assert.ok(Number.isFinite(row.bindSignedSeparationMeters) && Math.abs(row.bindSignedSeparationMeters - signed) < 1e-6, 'Recorded bind separation mismatch');
    assert.ok(Number.isFinite(row.bindDistanceMeters) && Math.abs(row.bindDistanceMeters - distance) < 1e-6, 'Recorded bind distance mismatch');
    const donorInfluences = new Map();
    for (let i = 0; i < 3; i++) {
      const dj = element(source, shirt.attributes.JOINTS_0, donor.triangle[i]).values, dw = element(source, shirt.attributes.WEIGHTS_0, donor.triangle[i]).values;
      for (let k = 0; k < 4; k++) if (dw[k] > 0) donorInfluences.set(dj[k], (donorInfluences.get(dj[k]) ?? 0) + dw[k] * donor.barycentric[i]);
    }
    assert.ok(donorInfluences.size <= 4, 'Garment interpolation would require dropping an influence');
    const top = [...donorInfluences].sort((a, b) => b[1] - a[1] || a[0] - b[0]), total = top.reduce((sum, [, w]) => sum + w, 0);
    const expectedInfluences = new Map(top.map(([joint, w]) => [joint, Math.fround(w / total)]));
    assert.ok(Array.isArray(row.joints) && row.joints.length === 4 && Array.isArray(row.weights) && row.weights.length === 4, 'Replacement must have exactly four slots');
    const replacementInfluences = new Map();
    for (let k = 0; k < 4; k++) {
      const joint = row.joints[k], weight = row.weights[k];
      assert.ok(Number.isInteger(joint) && joint >= 0 && joint < skin.joints.length && Number.isFinite(weight) && weight >= 0 && weight <= 1, 'Invalid replacement skin tuple');
      if (weight > 0) { assert.ok(!replacementInfluences.has(joint), 'Duplicate positive joint'); replacementInfluences.set(joint, Math.fround(weight)); }
      expected.writeUInt8(joint, joints.offset + k); expected.writeFloatLE(weight, weights.offset + k * 4);
    }
    assert.equal(replacementInfluences.size, expectedInfluences.size, 'Replacement donor influence count differs');
    for (const [joint, weight] of expectedInfluences) assert.ok(Math.abs((replacementInfluences.get(joint) ?? -1) - weight) < 1e-7, 'Replacement weights differ from normalized garment interpolation');
    assert.ok(Math.abs(row.weights.reduce((a, b) => a + b, 0) - 1) < 1e-6, 'Replacement weights are not normalized');
    assert.ok(row.joints.some((j, i) => j !== joints.values[i]) || row.weights.some((w, i) => Math.fround(w) !== weights.values[i]), 'Patch row changes no data');
    rows.push({ vertex: row.vertex, sourceByteRanges: row.sourceByteRanges, donor, donorOwnership, measuredBindSignedSeparationMeters: signed, measuredBindDistanceMeters: distance });
  }
  return { expected, evidence: { scope: 'Only listed lower-neck JOINTS_0/WEIGHTS_0 tuples; original shirt barycentric donors independently reconstructed', meshName: patch.meshName, primitive: 0, jointAccessor: 42, weightAccessor: 43, vertices: rows, unchanged: ['all positions, topology, normals, UVs, materials and rest transforms', 'all unlisted skin weights and all eleven native animation tracks'], limits: ['Skin deformation of patched collar vertices can change in native clips; fresh runtime gait/aim/fire review remains required.'] } };
}

export function expectedHiddenCollarPatch(source, patch) {
  assert.equal(patch.version, 1); assert.equal(patch.sourceSha256, suppliedSourceSha256);
  assert.equal(patch.meshName, 'SNOW-head_game'); assert.equal(patch.primitive, 0); assert.equal(patch.indexAccessor, 44);
  assert.deepEqual(patch.triangles.map(t => [t.triangleIndex, t.indices]), [[11, [1320, 6, 13]], [2946, [2896, 1589, 1582]]], 'Only the two approved hidden triangles may be removed');
  assert.equal(patch.beforeIndexCount, 17616); assert.equal(patch.afterIndexCount, 17610);
  assert.deepEqual(patch.limits, { barycentricSubdivisions: 24, maximumOutwardOcclusionDistanceMeters: .015, minimumOpenGarmentBoundaryDistanceMeters: .0002, rayNumericEpsilonMeters: 1e-7, sourceBindHeightMeters: [1.3, 1.45], exactlyTwoTriangles: true }, 'Hidden-face limits changed');
  const head = source.json.meshes.find(m => m.name === patch.meshName).primitives[0];
  const shirt = source.json.meshes.find(m => m.name === 'SNOW-shirt_game').primitives[0];
  assert.equal(head.indices, 44);
  const a = source.json.accessors[44], view = source.json.bufferViews[a.bufferView];
  assert.equal(a.componentType, 5123); assert.equal(a.count, 17616); assert.equal(a.type, 'SCALAR');
  assert.equal(a.byteOffset ?? 0, 0); assert.equal(view.byteStride ?? 2, 2); assert.equal(view.byteLength, a.count * 2);
  assert.equal(source.json.accessors.filter(x => x.bufferView === a.bufferView).length, 1, 'Index exception requires a dedicated source view');
  const indices = Array.from({ length: a.count }, (_, i) => element(source, 44, i).values[0]);
  const removed = new Set(patch.triangles.map(t => t.triangleIndex));
  for (const t of patch.triangles) assert.deepEqual(indices.slice(t.triangleIndex * 3, t.triangleIndex * 3 + 3), t.indices, 'Hidden source triangle order differs');
  const retained = indices.filter((_, i) => !removed.has(Math.floor(i / 3))), packed = Buffer.alloc(retained.length * 2);
  retained.forEach((index, i) => packed.writeUInt16LE(index, i * 2));
  assert.equal(retained.length, patch.afterIndexCount); assert.equal(sha(packed), patch.retainedIndicesSha256, 'Retained index order differs from the approved patch');
  const accessor = { ...a, count: retained.length };
  if (a.min) accessor.min = [Math.min(...retained)]; if (a.max) accessor.max = [Math.max(...retained)];

  const headNode = source.json.nodes.find(n => n.mesh === source.json.meshes.findIndex(m => m.name === patch.meshName));
  const shirtNode = source.json.nodes.find(n => n.mesh === source.json.meshes.findIndex(m => m.name === 'SNOW-shirt_game'));
  assert.equal(headNode.skin, shirtNode.skin);
  const bindPosition = bindPositionReader(source, headNode.skin);
  const raw = Array.from({ length: source.json.accessors[shirt.attributes.POSITION].count }, (_, i) => element(source, shirt.attributes.POSITION, i).values);
  const points = raw.map((_, i) => bindPosition(shirt, i)), keys = raw.map(p => p.join(','));
  const shirtTriangles = Array.from({ length: source.json.accessors[shirt.indices].count / 3 }, (_, i) => [0, 1, 2].map(k => element(source, shirt.indices, i * 3 + k).values[0]));
  const edges = new Map();
  for (const ids of shirtTriangles) for (let k = 0; k < 3; k++) {
    const edge = [ids[k], ids[(k + 1) % 3]], key = edge.map(i => keys[i]).sort().join('|');
    const old = edges.get(key); if (old) old.count++; else edges.set(key, { count: 1, edge });
  }
  const boundaries = [...edges.values()].filter(e => e.count === 1).map(e => e.edge.map(i => points[i]));
  assert.ok(boundaries.length > 0, 'Source open garment boundaries must be measured');
  const distanceToBoundary = point => Math.min(...boundaries.map(([a, b]) => {
    const d = subtract(b, a), t = Math.max(0, Math.min(1, dot(subtract(point, a), d) / dot(d, d)));
    return Math.hypot(...point.map((v, i) => v - a[i] - d[i] * t));
  }));
  // Independent Moller-Trumbore intersections, not the author's Three.Ray implementation.
  const intersect = (origin, direction, ids) => {
    const [a, b, c] = ids.map(i => points[i]), e1 = subtract(b, a), e2 = subtract(c, a);
    const h = cross(direction, e2), determinant = dot(e1, h);
    if (Math.abs(determinant) < 1e-14) return null;
    const inverse = 1 / determinant, s = subtract(origin, a), u = dot(s, h) * inverse;
    if (u < -1e-10 || u > 1 + 1e-10) return null;
    const q = cross(s, e1), v = dot(direction, q) * inverse;
    if (v < -1e-10 || u + v > 1 + 1e-10) return null;
    const t = dot(e2, q) * inverse;
    return t < 0 ? null : { t, barycentric: [1 - u - v, u, v] };
  };
  const coverage = [];
  for (const row of patch.triangles) {
    const vertices = row.indices.map(i => bindPosition(head, i));
    assert.ok(vertices.every(v => v[1] >= 1.3 && v[1] <= 1.45), 'Removed triangle leaves the lower-neck band');
    const normalRaw = cross(subtract(vertices[1], vertices[0]), subtract(vertices[2], vertices[0]));
    const normal = normalRaw.map(v => v / Math.hypot(...normalRaw));
    assert.ok(normal.every(Number.isFinite), 'Removed triangle is degenerate');
    const samples = [];
    for (let a = 0; a <= 24; a++) for (let b = 0; b <= 24 - a; b++) {
      const barycentric = [a / 24, b / 24, (24 - a - b) / 24];
      const point = [0, 1, 2].map(axis => vertices.reduce((sum, p, i) => sum + p[axis] * barycentric[i], 0));
      const origin = point.map((v, i) => v - normal[i] * 1e-7);
      let nearest = null;
      for (let i = 0; i < shirtTriangles.length; i++) {
        const hit = intersect(origin, normal, shirtTriangles[i]);
        if (!hit || hit.t > .015 + 1e-7 || (nearest && nearest.t <= hit.t)) continue;
        nearest = { ...hit, triangleIndex: i };
      }
      assert.ok(nearest && nearest.t >= 1e-7, `Hidden triangle ${row.triangleIndex} sample ${a},${b} has no outward original-shirt cover`);
      const hitPoint = origin.map((v, i) => v + normal[i] * nearest.t), boundaryDistance = distanceToBoundary(hitPoint);
      assert.ok(boundaryDistance >= .0002, 'Removed face approaches an actual open garment boundary');
      samples.push({ barycentric, garmentTriangleIndex: nearest.triangleIndex, garmentBarycentric: nearest.barycentric, outwardDistanceMeters: nearest.t - 1e-7, openBoundaryDistanceMeters: boundaryDistance });
    }
    const maximumOutwardDistanceMeters = Math.max(...samples.map(s => s.outwardDistanceMeters)), minimumOpenBoundaryDistanceMeters = Math.min(...samples.map(s => s.openBoundaryDistanceMeters));
    assert.equal(samples.length, 325); assert.equal(row.coverageProof.samples, 325);
    assert.equal(row.coverageProof.includesAllVerticesAndEdges, true); assert.equal(row.coverageProof.allOriginalShirtHits, true);
    assert.ok(Math.abs(maximumOutwardDistanceMeters - row.coverageProof.maximumOutwardDistanceMeters) < 1e-9, 'Reported hidden-face cover distance differs');
    assert.ok(Math.abs(minimumOpenBoundaryDistanceMeters - row.coverageProof.minimumOpenBoundaryDistanceMeters) < 1e-9, 'Reported neckline clearance differs');
    assert.ok(normal.every((v, i) => Math.abs(v - row.coverageProof.outwardHeadNormal[i]) < 1e-9), 'Reported outward face normal differs');
    coverage.push({ triangleIndex: row.triangleIndex, indices: row.indices, maximumOutwardDistanceMeters, minimumOpenBoundaryDistanceMeters, samples });
  }
  return { accessor, bufferView: a.bufferView, packed, originalByteLength: view.byteLength, evidence: { removedTriangles: patch.triangles.map(t => ({ triangleIndex: t.triangleIndex, indices: t.indices })), originalIndexCount: a.count, retainedIndexCount: retained.length, retainedIndicesSha256: sha(packed), zeroedUnusedTailBytes: view.byteLength - packed.length, originalOpenGarmentEdges: boundaries.length, coverage, limits: '650 original-bind ray samples include every vertex and a dense edge/interior grid. This is not an analytic continuous-surface or runtime-pose guarantee; final head census and runtime visuals are separate gates.' } };
}

export function verifyNativeSnowData(sourceBytes, outputBytes, patch = null, hiddenPatch = null) {
  const source = parseGlb(sourceBytes), result = parseGlb(outputBytes);
  assert.equal(sha(sourceBytes), suppliedSourceSha256, 'Unexpected supplied Snow source');
  if (patch) {
    assert.equal(sha(JSON.stringify(patch)), approvedCollarPatchContentSha256, 'Collar patch content differs from the approved 89-vertex exception');
    assert.equal(patch.sourceBinFileOffset, source.bin.byteOffset - sourceBytes.byteOffset, 'Recorded source BIN file offset mismatch');
  }
  if (hiddenPatch) {
    assert.ok(patch, 'The hidden-face correction requires the approved collar-v1 weights');
    assert.equal(sha(JSON.stringify(hiddenPatch)), approvedHiddenPatchContentSha256, 'Hidden-face patch differs from the approved two-triangle exception');
  }
  const hidden = hiddenPatch ? expectedHiddenCollarPatch(source, hiddenPatch) : null;
  assert.deepEqual(result.json.meshes, source.json.meshes);
  assert.deepEqual(result.json.materials, source.json.materials, 'Material properties changed');
  assert.deepEqual(result.json.skins, source.json.skins);
  const expectedAccessors = structuredClone(source.json.accessors);
  if (hidden) expectedAccessors[44] = hidden.accessor;
  assert.deepEqual(result.json.accessors.slice(0, source.json.accessors.length), expectedAccessors);
  assert.deepEqual(result.json.animations.slice(0, source.json.animations.length), source.json.animations);
  const patched = patch ? expectedCollarPatch(source, patch) : null;
  const expected = patched?.expected ?? Buffer.from(source.bin), imageViews = new Set(source.json.images.map(i => i.bufferView));
  if (hidden) {
    const offset = source.json.bufferViews[hidden.bufferView].byteOffset ?? 0;
    hidden.packed.copy(expected, offset);
    expected.fill(0, offset + hidden.packed.length, offset + hidden.originalByteLength);
  }
  let sourceViews = 0, exceptionViews = 0;
  for (const [i, old] of source.json.bufferViews.entries()) {
    if (imageViews.has(i)) continue;
    const next = result.json.bufferViews[i];
    assert.ok(next, `Missing original buffer view ${i}`);
    const expectedView = { ...old, byteOffset: 0 };
    if (i === hidden?.bufferView) expectedView.byteLength = hidden.packed.length;
    assert.deepEqual({ ...next, byteOffset: 0 }, expectedView, `Native buffer view ${i} layout changed`);
    const expectedBytes = expected.subarray(old.byteOffset ?? 0, (old.byteOffset ?? 0) + old.byteLength);
    // Compare the entire original physical slot, including the zeroed now-unreferenced tail.
    assert.deepEqual(Buffer.from(result.bin.subarray(next.byteOffset ?? 0, (next.byteOffset ?? 0) + old.byteLength)), Buffer.from(expectedBytes), `Native buffer view ${i} changed outside the declared collar patch`);
    if (!Buffer.from(expectedBytes).equals(Buffer.from(source.bin.subarray(old.byteOffset ?? 0, (old.byteOffset ?? 0) + old.byteLength)))) exceptionViews++;
    sourceViews++;
  }
  for (const [i, node] of source.json.nodes.entries()) {
    const next = structuredClone(result.json.nodes[i]);
    if (next.children) next.children = next.children.filter(n => n < source.json.nodes.length);
    if (!node.children && !next.children?.length) delete next.children;
    assert.deepEqual(next, node, `Native rest node ${node.name} changed`);
  }
  return { nativeClips: source.json.animations.map(a => a.name), verifiedNonImageBufferViews: sourceViews, byteExactNonImageBufferViews: sourceViews - exceptionViews, collarExceptionBufferViews: patched ? 2 : 0, hiddenFaceExceptionBufferViews: hidden ? 1 : 0, totalClips: result.json.animations.length, collarPatch: patched?.evidence ?? null, hiddenFacePatch: hidden?.evidence ?? null };
}

function main() {
const { values } = parseArgs({ options: Object.fromEntries(['before', 'after', 'source', 'out', 'collar-patch', 'hidden-collar-patch'].map(k => [k, { type: 'string' }])) });
for (const key of ['before', 'after', 'source', 'out']) if (!values[key]) throw new Error(`--${key} required`);
if (existsSync(values.out)) throw new Error('Evidence output already exists');
const read = (dir, file) => JSON.parse(readFileSync(path.join(dir, file)));
const before = read(values.before, 'manifest.json'), after = read(values.after, 'manifest.json');
const payloads = [];
const preserve = (name, a, b) => {
  assert.ok(a && b, `${name}: missing`);
  assert.equal(a.sha256, b.sha256, `${name}: hash changed`);
  const old = readFileSync(path.join(values.before, a.path)), next = readFileSync(path.join(values.after, b.path));
  assert.deepEqual(next, old, `${name}: bytes changed`);
  assert.equal(sha(next), b.sha256, `${name}: manifest hash mismatch`);
  payloads.push({ name, bytes: next.length, sha256: b.sha256 });
};
for (const key of ['terrain', 'roads', 'gameplay', 'scenery']) preserve(key, before[key], after[key]);
assert.equal(before.cells.length, after.cells.length);
for (const cell of before.cells) {
  const next = after.cells.find(c => c.id === cell.id);
  assert.deepEqual(next, cell, `${cell.id}: descriptor changed`);
  preserve(`${cell.id}:visual`, cell.visual.lod0, next.visual.lod0);
  preserve(`${cell.id}:collision`, cell.collision, next.collision);
}
assert.equal(before.assets.length, after.assets.length);
for (const asset of before.assets) if (asset.id !== 'character-snow') preserve(asset.id, asset, after.assets.find(a => a.id === asset.id));
const asset = after.assets.find(a => a.id === 'character-snow');
assert.ok(asset && asset.sha256 !== before.assets.find(a => a.id === asset.id).sha256, 'Player asset was not replaced');
const outputBytes = readFileSync(path.join(values.after, asset.path));
assert.equal(sha(outputBytes), asset.sha256);
const sourceBytes = readFileSync(values.source);
let patch = null, patchInput = null;
if (values['collar-patch']) {
  const bytes = readFileSync(values['collar-patch']);
  assert.equal(sha(bytes), approvedCollarPatchSha256, 'Unexpected collar patch file revision');
  patch = JSON.parse(bytes); patchInput = { file: values['collar-patch'], sha256: sha(bytes) };
}
let hiddenPatch = null, hiddenPatchInput = null;
if (values['hidden-collar-patch']) {
  const bytes = readFileSync(values['hidden-collar-patch']);
  assert.equal(sha(bytes), approvedHiddenPatchSha256, 'Unexpected hidden-face patch file revision');
  hiddenPatch = JSON.parse(bytes); hiddenPatchInput = { file: values['hidden-collar-patch'], sha256: sha(bytes) };
}
const native = verifyNativeSnowData(sourceBytes, outputBytes, patch, hiddenPatch);
const report = { status: 'PASS', release: after.worldReleaseId, baseline: before.worldReleaseId, manifestSha256: sha(readFileSync(path.join(values.after, 'manifest.json'))), unchangedPayloads: payloads, source: { file: values.source, sha256: sha(sourceBytes) }, verifierSha256: sha(readFileSync(new URL(import.meta.url))), player: { sha256: asset.sha256, ...native }, approvedException: patchInput, approvedHiddenFaceException: hiddenPatchInput, preserved: ['all world visuals and collision', 'terrain, roads, gameplay and scenery', 'Rain, pistol, cars and tree assets', 'Snow positions, normals, UVs, inverse binds, rest nodes and eleven native clips', patch ? 'All skin data except the exact approved89 collar tuples' : 'All skin data', hiddenPatch ? 'Original triangle order except the exact two approved covered head triangles' : 'Original topology'], limits: patch ? ['The89 collar vertices have intentionally changed skin deformation. Native clip bytes and static positions remain exact; gait and aim/fire visuals require fresh evidence.', ...(hiddenPatch ? ['Two covered head triangles are removed. Fresh evaluated head census and runtime coverage review are required.'] : [])] : [] };
writeFileSync(values.out, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(`PASS ${payloads.length} unchanged world/other-actor payloads; ${native.byteExactNonImageBufferViews}/${native.verifiedNonImageBufferViews} native Snow views exact; ${native.collarExceptionBufferViews} weight and ${native.hiddenFaceExceptionBufferViews} index views verified against explicit exceptions; ${native.nativeClips.length} native clips exact`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
