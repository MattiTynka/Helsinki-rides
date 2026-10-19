// Remove exactly two inherited neck triangles that are fully hidden by the original shirt at bind.
// No downloaded code is executed and no source asset is changed. The parent packager applies the patch.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
const requireGame = createRequire(new URL('../../apps/game/package.json', import.meta.url));
const { Matrix4, Quaternion, Vector3, Triangle, Ray } = await import(new URL('./three.module.js', pathToFileURL(requireGame.resolve('three'))));
const { values: args } = parseArgs({ options: { source: { type: 'string' }, out: { type: 'string' }, report: { type: 'string' } } });
if (!args.source || !args.out || !args.report || existsSync(args.out) || existsSync(args.report)) throw new Error('require --source and fresh --out --report');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const assert = (ok, reason) => { if (!ok) throw new Error(reason); };
const source = readFileSync(args.source), sourceSha256 = sha(source);
assert(sourceSha256 === '2d4516c7efc691fd544b25b5ff66d39e19a0f23a5c3b029dd44785652a9adebd', 'unexpected Finn source revision');
let doc, bin;
for (let offset = 12; offset < source.length;) { const count = source.readUInt32LE(offset), kind = source.readUInt32LE(offset + 4); if (kind === 0x4e4f534a) doc = JSON.parse(source.subarray(offset + 8, offset + 8 + count)); if (kind === 0x004e4942) bin = source.subarray(offset + 8, offset + 8 + count); offset += count + 8; }
const dv = new DataView(bin.buffer, bin.byteOffset, bin.byteLength), width = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }, component = { 5121: [1, 'getUint8', 255], 5123: [2, 'getUint16', 65535], 5125: [4, 'getUint32', 4294967295], 5126: [4, 'getFloat32'] };
function accessor(index) { const a = doc.accessors[index], b = doc.bufferViews[a.bufferView]; assert(!a.sparse && !b.extensions && (b.buffer ?? 0) === 0, 'unsupported native accessor'); const [size, method, divisor] = component[a.componentType], out = []; for (let i = 0; i < a.count; i++) for (let k = 0; k < width[a.type]; k++) { const value = dv[method]((b.byteOffset ?? 0) + (a.byteOffset ?? 0) + i * (b.byteStride ?? size * width[a.type]) + k * size, true); out.push(a.normalized && divisor ? value / divisor : value); } return out; }
const parents = new Map(), names = new Map(doc.nodes.map((n, i) => [n.name, i])); doc.nodes.forEach((n, i) => (n.children ?? []).forEach(c => parents.set(c, i)));
const world = [];
function at(i) { if (world[i]) return world[i]; const n = doc.nodes[i], local = n.matrix ? new Matrix4().fromArray(n.matrix) : new Matrix4().compose(new Vector3().fromArray(n.translation ?? [0, 0, 0]), new Quaternion().fromArray(n.rotation ?? [0, 0, 0, 1]), new Vector3().fromArray(n.scale ?? [1, 1, 1])); return world[i] = parents.has(i) ? at(parents.get(i)).clone().multiply(local) : local; }
doc.nodes.forEach((_, i) => at(i));
const skin = doc.skins[0], inverse = accessor(skin.inverseBindMatrices), matrices = skin.joints.map((joint, i) => world[joint].clone().multiply(new Matrix4().fromArray(inverse, i * 16)));
function mesh(name) { const n = doc.nodes[names.get(name)], primitive = doc.meshes[n.mesh].primitives[0], raw = accessor(primitive.attributes.POSITION), js = accessor(primitive.attributes.JOINTS_0), ws = accessor(primitive.attributes.WEIGHTS_0), positions = []; for (let i = 0; i < raw.length / 3; i++) { const point = new Vector3().fromArray(raw, i * 3), result = new Vector3(); for (let k = 0; k < 4; k++) if (ws[i * 4 + k]) result.addScaledVector(point.clone().applyMatrix4(matrices[js[i * 4 + k]]), ws[i * 4 + k]); positions.push(result); } return { name, primitive, raw, positions, indices: accessor(primitive.indices) }; }
const head = mesh('FINN-head_game'), shirt = mesh('FINN-shirt_game');
assert(head.primitive.indices === 44, 'unexpected head primitive/index accessor');
const requested = [[1320, 6, 13], [2896, 1589, 1582]];
const canonical = shirt.positions.map((_, i) => shirt.raw.slice(i * 3, i * 3 + 3).join(','));
const edgeKey = (a, b) => [canonical[a], canonical[b]].sort().join('|'), counts = new Map();
for (let i = 0; i < shirt.indices.length; i += 3) for (const [a, b] of [[shirt.indices[i], shirt.indices[i + 1]], [shirt.indices[i + 1], shirt.indices[i + 2]], [shirt.indices[i + 2], shirt.indices[i]]]) { const key = edgeKey(a, b); counts.set(key, (counts.get(key) ?? 0) + 1); }
const boundaries = [];
for (let i = 0; i < shirt.indices.length; i += 3) for (const [a, b] of [[shirt.indices[i], shirt.indices[i + 1]], [shirt.indices[i + 1], shirt.indices[i + 2]], [shirt.indices[i + 2], shirt.indices[i]]]) if (counts.get(edgeKey(a, b)) === 1) boundaries.push([shirt.positions[a], shirt.positions[b]]);
const limits = { barycentricSubdivisions: 24, maximumOutwardOcclusionDistanceMeters: .015, minimumOpenGarmentBoundaryDistanceMeters: .0002, rayNumericEpsilonMeters: 1e-7, sourceBindHeightMeters: [1.30, 1.45], exactlyTwoTriangles: true };
const grid = [];
for (let a = 0; a <= limits.barycentricSubdivisions; a++) for (let b = 0; b <= limits.barycentricSubdivisions - a; b++) grid.push([a / limits.barycentricSubdivisions, b / limits.barycentricSubdivisions, (limits.barycentricSubdivisions - a - b) / limits.barycentricSubdivisions]);
const triangle = new Triangle(), normal = new Vector3(), bary = new Vector3(), hit = new Vector3(), ray = new Ray(), triangles = [], detailed = [];
function distanceSegment(point, a, b) { const d = b.clone().sub(a), f = Math.max(0, Math.min(1, point.clone().sub(a).dot(d) / d.lengthSq())); return point.distanceTo(a.clone().addScaledVector(d, f)); }
for (const requestedIndices of requested) {
  const ordinal = [];
  for (let i = 0; i < head.indices.length; i += 3) if (head.indices.slice(i, i + 3).every(index => requestedIndices.includes(index))) ordinal.push(i / 3);
  assert(ordinal.length === 1, 'expected one exact inherited target face');
  const triangleIndex = ordinal[0], indices = head.indices.slice(triangleIndex * 3, triangleIndex * 3 + 3), vertices = indices.map(i => head.positions[i]);
  assert(vertices.every(v => v.y >= limits.sourceBindHeightMeters[0] && v.y <= limits.sourceBindHeightMeters[1]), 'target extends beyond lower neck');
  triangle.set(...vertices); triangle.getNormal(normal);
  const rows = [];
  for (const sampleBarycentric of grid) {
    const point = new Vector3(); vertices.forEach((v, k) => point.addScaledVector(v, sampleBarycentric[k]));
    ray.set(point.clone().addScaledVector(normal, -limits.rayNumericEpsilonMeters), normal);
    let best;
    for (let i = 0; i < shirt.indices.length; i += 3) {
      const ids = shirt.indices.slice(i, i + 3); triangle.set(...ids.map(id => shirt.positions[id]));
      if (!ray.intersectTriangle(triangle.a, triangle.b, triangle.c, false, hit)) continue;
      const distance = hit.distanceTo(point);
      if (distance > limits.maximumOutwardOcclusionDistanceMeters || (best && best.distanceMeters <= distance)) continue;
      triangle.getBarycoord(hit, bary);
      const boundaryDistanceMeters = Math.min(...boundaries.map(([a, b]) => distanceSegment(hit, a, b)));
      best = { garmentTriangleIndex: i / 3, garmentTriangle: ids, garmentBarycentric: bary.toArray(), distanceMeters: distance, boundaryDistanceMeters };
    }
    assert(best, `head face${triangleIndex} sample${sampleBarycentric} is not occluded by original shirt`);
    assert(best.boundaryDistanceMeters >= limits.minimumOpenGarmentBoundaryDistanceMeters, `head face${triangleIndex} reaches actual open neckline boundary`);
    rows.push({ sampleBarycentric, point: point.toArray(), ...best });
  }
  const coverageProof = { samples: rows.length, includesAllVerticesAndEdges: true, allOriginalShirtHits: true, maximumOutwardDistanceMeters: Math.max(...rows.map(r => r.distanceMeters)), minimumOpenBoundaryDistanceMeters: Math.min(...rows.map(r => r.boundaryDistanceMeters)), outwardHeadNormal: normal.toArray() };
  triangles.push({ triangleIndex, indices, coverageProof }); detailed.push({ triangleIndex, indices, samples: rows });
}
const removed = new Set(triangles.map(t => t.triangleIndex)), retained = head.indices.filter((_, i) => !removed.has(Math.floor(i / 3)));
const indexAccessor = doc.accessors[44], [componentSize] = component[indexAccessor.componentType], packed = Buffer.alloc(retained.length * componentSize);
retained.forEach((index, i) => componentSize === 2 ? packed.writeUInt16LE(index, i * 2) : packed.writeUInt32LE(index, i * 4));
const patch = { version: 1, sourceSha256, meshName: head.name, primitive: 0, indexAccessor: 44, triangles, beforeIndexCount: head.indices.length, afterIndexCount: retained.length, retainedIndicesSha256: sha(packed), retainedOrder: 'original index sequence with exactly the named complete triangles filtered out', limits, generatorSha256: sha(readFileSync(new URL(import.meta.url))) };
const report = { version: 1, status: 'PASS_BIND_COVERAGE_RUNTIME_PENDING', source: { file: args.source, sha256: sourceSha256 }, patch: { file: args.out }, method: 'Each of the exact two complete head triangles is sampled on a24-subdivision barycentric grid, including every vertex and edge. An outward ray along its original bind face normal must hit the untouched original shirt within15mm. Every hit must stay at least0.2mm from the actual open garment boundary, reconstructed from exact source POSITION geometric-edge incidence. No expanded garment, pose adjustment, source-coordinate nudge or other head-face removal.', triangles: detailed, limits: 'Dense bind coverage is a bounded geometric proof, not continuous analytic coverage or current-candidate runtime acceptance. Actual exported native images, complete retained-index preservation and final evaluated census remain gates.' };
for (const file of [args.out, args.report]) mkdirSync(path.dirname(file), { recursive: true });
writeFileSync(args.out, JSON.stringify(patch, null, 2)); report.patch.sha256 = sha(readFileSync(args.out)); writeFileSync(args.report, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ status: report.status, patch: args.out, sha256: report.patch.sha256, triangles, beforeIndexCount: head.indices.length, afterIndexCount: retained.length, retainedIndicesSha256: patch.retainedIndicesSha256 }));
