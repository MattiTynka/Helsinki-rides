// Match only bind-covered Finn lower-neck skin to its existing garment deformation.
// The original GLB is read as data. This emits a source-bound patch; it never changes the source.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const requireGame = createRequire(new URL('../../apps/game/package.json', import.meta.url));
const { Matrix4, Quaternion, Vector3, Triangle } = await import(new URL('./three.module.js', pathToFileURL(requireGame.resolve('three'))));
const { values: args } = parseArgs({ options: { source: { type: 'string' }, supplement: { type: 'string' }, out: { type: 'string' }, report: { type: 'string' } } });
if (!args.source || !args.supplement || !args.out || !args.report || existsSync(args.out) || existsSync(args.report)) throw new Error('require --source --supplement and fresh --out --report');
const SOURCE_SHA256 = '2d4516c7efc691fd544b25b5ff66d39e19a0f23a5c3b029dd44785652a9adebd';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const assert = (ok, reason) => { if (!ok) throw new Error(reason); };
const bytes = readFileSync(args.source), supplementBytes = readFileSync(args.supplement), supplement = JSON.parse(supplementBytes);
assert(hash(bytes) === SOURCE_SHA256 && supplement.sourceSha256 === SOURCE_SHA256, 'unexpected native Finn source');
assert(bytes.readUInt32LE(0) === 0x46546c67 && bytes.readUInt32LE(4) === 2 && bytes.readUInt32LE(8) === bytes.length, 'invalid GLB2');
let doc, bin, binFileOffset;
for (let at = 12; at < bytes.length;) {
  const size = bytes.readUInt32LE(at), kind = bytes.readUInt32LE(at + 4);
  assert(at + 8 + size <= bytes.length, 'truncated GLB chunk');
  if (kind === 0x4e4f534a) doc = JSON.parse(bytes.subarray(at + 8, at + 8 + size));
  if (kind === 0x004e4942) { bin = bytes.subarray(at + 8, at + 8 + size); binFileOffset = at + 8; }
  at += size + 8;
}
assert(doc && bin && doc.buffers.length === 1 && !doc.buffers[0].uri, 'expected embedded native buffer');
const view = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
const widths = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const components = { 5120: [1, 'getInt8', 127], 5121: [1, 'getUint8', 255], 5122: [2, 'getInt16', 32767], 5123: [2, 'getUint16', 65535], 5125: [4, 'getUint32', 4294967295], 5126: [4, 'getFloat32'] };
const cache = new Map();
function layout(index) {
  const a = doc.accessors[index], b = doc.bufferViews[a.bufferView];
  assert(!a.sparse && !b.extensions && (b.buffer ?? 0) === 0 && components[a.componentType] && widths[a.type], `unsupported accessor ${index}`);
  const [size, method, divisor] = components[a.componentType], width = widths[a.type];
  return { a, size, method, divisor, width, start: (b.byteOffset ?? 0) + (a.byteOffset ?? 0), stride: b.byteStride ?? size * width };
}
function accessor(index) {
  if (cache.has(index)) return cache.get(index);
  const { a, size, method, divisor, width, start, stride } = layout(index), out = [];
  for (let i = 0; i < a.count; i++) for (let k = 0; k < width; k++) {
    const value = view[method](start + i * stride + k * size, true);
    out.push(a.normalized && divisor ? Math.max(-1, value / divisor) : value);
  }
  cache.set(index, out); return out;
}
const names = new Map(doc.nodes.map((n, i) => [n.name, i])), parents = new Map();
for (let i = 0; i < doc.nodes.length; i++) for (const child of doc.nodes[i].children ?? []) { assert(!parents.has(child), 'ambiguous hierarchy'); parents.set(child, i); }
const skin = doc.skins[0], joints = skin.joints, inverseBindValues = accessor(skin.inverseBindMatrices);
assert(joints.length === 71, 'expected native71 skin');
const inverseBind = joints.map((_, i) => new Matrix4().fromArray(inverseBindValues, i * 16));
const rest = doc.nodes.map(n => { const t = new Vector3().fromArray(n.translation ?? [0, 0, 0]), q = new Quaternion().fromArray(n.rotation ?? [0, 0, 0, 1]), s = new Vector3().fromArray(n.scale ?? [1, 1, 1]); if (n.matrix) new Matrix4().fromArray(n.matrix).decompose(t, q, s); return { t, q, s }; });
function pose(tracks = [], time = 0) {
  const local = rest.map(({ t, q, s }) => ({ t: t.clone(), q: q.clone(), s: s.clone() }));
  for (const track of tracks) {
    let key = 0; while (key + 1 < track.times.length && track.times[key + 1] <= time) key++;
    const next = Math.min(key + 1, track.times.length - 1), fraction = track.interpolation === 'STEP' || next === key ? 0 : (time - track.times[key]) / (track.times[next] - track.times[key]);
    const target = local[track.node], width = track.path === 'rotation' ? 4 : 3;
    if (track.path === 'rotation') target.q.fromArray(track.values, key * width).slerp(new Quaternion().fromArray(track.values, next * width), fraction);
    else (track.path === 'translation' ? target.t : target.s).fromArray(track.values, key * width).lerp(new Vector3().fromArray(track.values, next * width), fraction);
  }
  const world = [];
  function at(i) { if (world[i]) return world[i]; const { t, q, s } = local[i], matrix = new Matrix4().compose(t, q, s); return world[i] = parents.has(i) ? at(parents.get(i)).clone().multiply(matrix) : matrix; }
  doc.nodes.forEach((_, i) => at(i));
  return joints.map((joint, i) => world[joint].clone().multiply(inverseBind[i]));
}
function mesh(meshName) {
  const node = doc.nodes[names.get(meshName)], mesh = doc.meshes[node.mesh];
  assert(node.skin === 0 && mesh.primitives.length >= 1, `expected native primitive for ${meshName}`);
  const primitive = mesh.primitives[0];
  return { meshName, primitive, positions: accessor(primitive.attributes.POSITION), joints: accessor(primitive.attributes.JOINTS_0), weights: accessor(primitive.attributes.WEIGHTS_0), indices: accessor(primitive.indices) };
}
const head = mesh('FINN-head_game'), shirt = mesh('FINN-shirt_game'), restSkin = pose();
const p = new Vector3(), transformed = new Vector3();
function skinPoint(mesh, vertex, matrices, changed) {
  p.fromArray(mesh.positions, vertex * 3); const out = new Vector3();
  const jointTuple = changed?.joints ?? mesh.joints.slice(vertex * 4, vertex * 4 + 4), weightTuple = changed?.weights ?? mesh.weights.slice(vertex * 4, vertex * 4 + 4);
  for (let k = 0; k < 4; k++) if (weightTuple[k]) out.addScaledVector(transformed.copy(p).applyMatrix4(matrices[jointTuple[k]]), weightTuple[k]);
  return out;
}
const headRest = Array.from({ length: head.positions.length / 3 }, (_, i) => skinPoint(head, i, restSkin));
const shirtRest = Array.from({ length: shirt.positions.length / 3 }, (_, i) => skinPoint(shirt, i, restSkin));
const tri = new Triangle(), closest = new Vector3(), bary = new Vector3(), normal = new Vector3();
// Conservative source-space ownership: only lower-neck points strictly behind an interior garment
// triangle qualify. Exposed neckline and face/hair vertices cannot enter this patch.
const limits = { bindHeightMinMeters: 1.30, bindHeightMaxMeters: 1.45, bindMaximumDistanceMeters: .015, bindMinimumInteriorBarycentric: .02, bindMinimumInsideMeters: .0001, maximumWeights: 4, maxNormalizedSumError: 1e-6, sampleHz: 120, outwardSeparationToleranceMeters: .001 };
const vertices = [];
for (let vertex = 0; vertex < headRest.length; vertex++) {
  const point = headRest[vertex];
  if (point.y < limits.bindHeightMinMeters || point.y > limits.bindHeightMaxMeters) continue;
  let best;
  for (let i = 0; i < shirt.indices.length; i += 3) {
    const ids = shirt.indices.slice(i, i + 3); tri.set(...ids.map(id => shirtRest[id])); tri.closestPointToPoint(point, closest);
    const distance = point.distanceTo(closest); if (distance > limits.bindMaximumDistanceMeters || (best && distance >= best.distance)) continue;
    tri.getBarycoord(closest, bary); tri.getNormal(normal);
    const signed = point.clone().sub(closest).dot(normal);
    if (Math.min(...bary.toArray()) < limits.bindMinimumInteriorBarycentric || signed > -limits.bindMinimumInsideMeters) continue;
    best = { triangle: ids, barycentric: bary.toArray(), distance, signed };
  }
  if (!best) continue;
  const combined = new Map();
  best.triangle.forEach((id, corner) => { for (let k = 0; k < 4; k++) { const joint = shirt.joints[id * 4 + k], value = shirt.weights[id * 4 + k] * best.barycentric[corner]; combined.set(joint, (combined.get(joint) ?? 0) + value); } });
  const ranked = [...combined].filter(([, weight]) => weight > 1e-8).sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  assert(ranked.length <= 4, 'garment donor exceeds source four-weight layout');
  const sum = ranked.reduce((total, [, weight]) => total + weight, 0), afterJoints = ranked.map(([joint]) => joint), afterWeights = ranked.map(([, weight]) => Math.fround(weight / sum));
  while (afterJoints.length < 4) { afterJoints.push(0); afterWeights.push(0); }
  const beforeJoints = head.joints.slice(vertex * 4, vertex * 4 + 4), beforeWeights = head.weights.slice(vertex * 4, vertex * 4 + 4), before = new Map(beforeJoints.map((joint, i) => [joint, beforeWeights[i]]));
  if (afterJoints.every((joint, i) => Math.abs((before.get(joint) ?? 0) - afterWeights[i]) < 1e-6) && [...before].every(([joint, weight]) => afterJoints.includes(joint) || weight < 1e-6)) continue;
  const sourceByteRanges = {};
  for (const [name, index] of [['joints', head.primitive.attributes.JOINTS_0], ['weights', head.primitive.attributes.WEIGHTS_0]]) { const l = layout(index); sourceByteRanges[name] = { offset: l.start + vertex * l.stride, length: l.size * 4 }; }
  vertices.push({ vertex, beforeJoints, beforeWeights, joints: afterJoints, weights: afterWeights, donor: { meshName: shirt.meshName, primitive: 0, triangle: best.triangle, barycentric: best.barycentric }, reason: 'Bind-covered lower-neck/head point follows the barycentrically corresponding existing garment surface; original Shoulder-vs-upper-arm weighting exposed skin through shirt during aim.', bindSignedSeparationMeters: best.signed, bindDistanceMeters: best.distance, sourceByteRanges });
}
assert(vertices.length > 0 && vertices.length < 150, 'unexpected collar correction scope');
const patch = { version: 1, sourceSha256: SOURCE_SHA256, meshName: head.meshName, primitive: 0, jointAccessor: head.primitive.attributes.JOINTS_0, weightAccessor: head.primitive.attributes.WEIGHTS_0, vertices, limits, sourceBinFileOffset: binFileOffset, byteRangeConvention: 'BIN-relative element ranges; add sourceBinFileOffset for original GLB file offsets', generatorSha256: hash(readFileSync(new URL(import.meta.url))) };
mkdirSync(path.dirname(args.out), { recursive: true });
writeFileSync(args.out, JSON.stringify(patch, null, 2));
console.log(JSON.stringify({ status: 'PATCH_WRITTEN_MEASUREMENTS_PENDING', out: args.out, sha256: hash(readFileSync(args.out)), vertices: vertices.length, jointAccessor: patch.jointAccessor, weightAccessor: patch.weightAccessor }));

const nativeClips = doc.animations.map(animation => ({ name: animation.name, kind: 'native', tracks: animation.channels.map(channel => { const sampler = animation.samplers[channel.sampler]; assert(['LINEAR', 'STEP'].includes(sampler.interpolation ?? 'LINEAR'), 'unsupported source animation interpolation'); return { node: channel.target.node, path: channel.target.path, times: accessor(sampler.input), values: accessor(sampler.output), interpolation: sampler.interpolation ?? 'LINEAR' }; }) }));
const supplementalClips = supplement.clips.map(clip => ({ name: clip.name, kind: 'supplemental', tracks: clip.tracks.map(t => ({ ...t, node: names.get(t.node), interpolation: 'LINEAR' })) }));
const posedDonor = new Vector3();
const measurements = [];
for (const clip of [...nativeClips, ...supplementalClips]) {
  const duration = Math.max(...clip.tracks.map(t => t.times.at(-1))), steps = Math.ceil(duration * limits.sampleHz);
  let beforeMax = -Infinity, afterMax = -Infinity, maxWeightSumError = 0, worst;
  for (let step = 0; step <= steps; step++) {
    const time = step / steps * duration, matrices = pose(clip.tracks, time);
    for (const change of vertices) {
      const corners = change.donor.triangle.map(i => skinPoint(shirt, i, matrices)); tri.set(...corners); tri.getNormal(normal); posedDonor.set(0, 0, 0); corners.forEach((point, k) => posedDonor.addScaledVector(point, change.donor.barycentric[k]));
      const before = skinPoint(head, change.vertex, matrices).sub(posedDonor).dot(normal), after = skinPoint(head, change.vertex, matrices, change).sub(posedDonor).dot(normal);
      beforeMax = Math.max(beforeMax, before); if (after > afterMax) { afterMax = after; worst = { vertex: change.vertex, time, beforeMeters: before, afterMeters: after }; }
      maxWeightSumError = Math.max(maxWeightSumError, Math.abs(change.weights.reduce((a, b) => a + b, 0) - 1));
    }
  }
  measurements.push({ name: clip.name, kind: clip.kind, duration, samples: steps + 1, vertices: vertices.length, beforeMaxSignedMeters: beforeMax, afterMaxSignedMeters: afterMax, maxWeightSumError, worst, pass: afterMax <= limits.outwardSeparationToleranceMeters && maxWeightSumError < limits.maxNormalizedSumError });
}
const report = { version: 1, status: measurements.every(m => m.pass) ? 'PASS_NUMERICAL_RUNTIME_PENDING' : 'RETHINK', source: { file: args.source, sha256: SOURCE_SHA256 }, supplement: { file: args.supplement, sha256: hash(supplementBytes) }, patch: { file: args.out, sha256: hash(readFileSync(args.out)), vertices: vertices.length }, generatorSha256: patch.generatorSha256, method: 'Original native71 bone hierarchy and inverse binds; native11 animation tracks and supplemental6 local TRS evaluated at120Hz with linear/step interpolation and quaternion slerp. Signed skin-to-corresponding-shirt-triangle distance uses rest-bound barycentric donor; this is a local collar penetration/contact check, not a whole-body garment intersection census.', measurements, unchanged: ['All source POSITION/NORMAL/TANGENT/TEXCOORD/index payloads', 'Rest hierarchy and inverse-bind matrices', 'All original eleven animation channels/samplers', 'Every other mesh and all unlisted weights'], limits: 'Runtime pose images, directional upper-body masking and transitions remain required.' };
mkdirSync(path.dirname(args.report), { recursive: true }); writeFileSync(args.report, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ status: report.status, report: args.report, measurements }));
if (report.status !== 'PASS_NUMERICAL_RUNTIME_PENDING') process.exitCode = 2;
