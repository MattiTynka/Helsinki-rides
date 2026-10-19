// Independent numeric checks of the native Finn supplement, without Blender or a GLB importer.
// node tools/verify/verify-finn-gameplay-supplement.mjs --source source.glb --supplement supplement.json --out NEW.json
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const requireGame = createRequire(new URL('../../apps/game/package.json', import.meta.url));
const { Matrix4, Quaternion, Vector3 } = await import(new URL('./three.module.js', pathToFileURL(requireGame.resolve('three'))));
const { values: args } = parseArgs({ options: { source: { type: 'string' }, supplement: { type: 'string' }, out: { type: 'string' } } });
if (!args.source || !args.supplement || !args.out || existsSync(args.out)) throw new Error('require --source, --supplement and fresh --out');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sourceBytes = readFileSync(args.source), supplementBytes = readFileSync(args.supplement);
const supplement = JSON.parse(supplementBytes);
const assert = (condition, detail) => { if (!condition) throw new Error(detail); };
assert(sourceBytes.readUInt32LE(0) === 0x46546c67 && sourceBytes.readUInt32LE(4) === 2 && sourceBytes.readUInt32LE(8) === sourceBytes.length, 'invalid GLB2 source');
let doc, binary;
for (let offset = 12; offset < sourceBytes.length;) {
  const count = sourceBytes.readUInt32LE(offset), kind = sourceBytes.readUInt32LE(offset + 4);
  const chunk = sourceBytes.subarray(offset + 8, offset + 8 + count);
  if (kind === 0x4e4f534a) doc = JSON.parse(chunk);
  if (kind === 0x004e4942) binary = chunk;
  offset += count + 8;
}
assert(doc && binary && sha(sourceBytes) === supplement.sourceSha256, 'source revision mismatch');
const view = new DataView(binary.buffer, binary.byteOffset, binary.byteLength);
const sizes = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const components = { 5120: [1, 'getInt8', 127], 5121: [1, 'getUint8', 255], 5122: [2, 'getInt16', 32767], 5123: [2, 'getUint16', 65535], 5125: [4, 'getUint32', 4294967295], 5126: [4, 'getFloat32'] };
function accessor(index) {
  const a = doc.accessors[index], b = doc.bufferViews[a.bufferView];
  assert(!a.sparse && (b.buffer ?? 0) === 0 && !b.extensions, `unsupported accessor ${index}`);
  const [size, read, divisor] = components[a.componentType], width = sizes[a.type], stride = b.byteStride ?? size * width;
  const begin = (b.byteOffset ?? 0) + (a.byteOffset ?? 0), out = [];
  for (let i = 0; i < a.count; i++) for (let k = 0; k < width; k++) {
    let number = view[read](begin + i * stride + k * size, true);
    if (a.normalized && divisor) number = Math.max(-1, number / divisor);
    out.push(number);
  }
  return out;
}
const names = new Map(doc.nodes.map((node, i) => [node.name, i]));
const parents = new Map();
for (let i = 0; i < doc.nodes.length; i++) for (const child of doc.nodes[i].children ?? []) { assert(!parents.has(child), 'multiple parents'); parents.set(child, i); }
const restTRS = doc.nodes.map(node => {
  const t = new Vector3().fromArray(node.translation ?? [0, 0, 0]);
  const q = new Quaternion().fromArray(node.rotation ?? [0, 0, 0, 1]);
  const s = new Vector3().fromArray(node.scale ?? [1, 1, 1]);
  if (node.matrix) new Matrix4().fromArray(node.matrix).decompose(t, q, s);
  return { t, q, s };
});
const nativeJoints = doc.skins[0].joints, jointSet = new Set(nativeJoints);
assert(nativeJoints.length === 71 && jointSet.size === 71, 'expected native71 joints');
const inverseBindArray = accessor(doc.skins[0].inverseBindMatrices);
const inverseBind = nativeJoints.map((_, i) => new Matrix4().fromArray(inverseBindArray, i * 16));
const durations = { aim: 1, fire: .25, hit: .5, death: 1.4, drive: 2, arrested: 2 };
const loopNames = new Set(['aim', 'drive', 'arrested']);
const splitNames = nativeJoints.filter(i => /(?:UpperArm_2|Forearm_2|Thigh_2|Knee_2)/.test(doc.nodes[i].name));
const checks = [], report = {};
function check(id, pass, detail) { checks.push({ id, pass, detail }); assert(pass, `${id}: ${detail}`); }
function evaluate(clip, time) {
  const local = restTRS.map(({ t, q, s }) => ({ t: t.clone(), q: q.clone(), s }));
  for (const track of clip?.tracks ?? []) {
    let key = 0;
    while (key + 1 < track.times.length && track.times[key + 1] <= time) key++;
    const next = Math.min(key + 1, track.times.length - 1);
    const fraction = next === key ? 0 : (time - track.times[key]) / (track.times[next] - track.times[key]);
    const value = local[names.get(track.node)];
    if (track.path === 'rotation') value.q.fromArray(track.values, key * 4).slerp(new Quaternion().fromArray(track.values, next * 4), fraction);
    else value.t.fromArray(track.values, key * 3).lerp(new Vector3().fromArray(track.values, next * 3), fraction);
  }
  const matrices = local.map(({ t, q, s }) => new Matrix4().compose(t, q, s)), world = [];
  function at(i) { if (!world[i]) world[i] = parents.has(i) ? at(parents.get(i)).clone().multiply(matrices[i]) : matrices[i].clone(); return world[i]; }
  for (let i = 0; i < matrices.length; i++) at(i);
  return { local, matrices, world };
}
const rest = evaluate(null, 0), vertices = [];
for (const node of doc.nodes) if (node.mesh !== undefined) for (const p of doc.meshes[node.mesh].primitives) {
  const positions = accessor(p.attributes.POSITION), joints = accessor(p.attributes.JOINTS_0), weights = accessor(p.attributes.WEIGHTS_0);
  vertices.push({ mesh: node.name, positions, joints, weights });
}
function skinnedBounds(pose, selected = vertices) {
  const skin = nativeJoints.map((joint, i) => pose.world[joint].clone().multiply(inverseBind[i]));
  let minY = Infinity, maxY = -Infinity;
  const p = new Vector3(), transformed = new Vector3(), sum = new Vector3();
  for (const { positions, joints, weights } of selected) for (let i = 0; i < positions.length / 3; i++) {
    p.fromArray(positions, i * 3); sum.set(0, 0, 0);
    for (let k = 0; k < 4; k++) if (weights[i * 4 + k]) sum.addScaledVector(transformed.copy(p).applyMatrix4(skin[joints[i * 4 + k]]), weights[i * 4 + k]);
    minY = Math.min(minY, sum.y); maxY = Math.max(maxY, sum.y);
  }
  return { minY, maxY };
}
check('six-clips', supplement.clips.length === 6 && new Set(supplement.clips.map(c => c.name)).size === 6 && supplement.clips.every(c => c.name in durations), 'six unique required gameplay clips');
for (const clip of supplement.clips) {
  const keys = new Set(); let maxQuaternionNormError = 0;
  for (const track of clip.tracks) {
    assert(names.has(track.node) && jointSet.has(names.get(track.node)) && track.node !== 'root', 'track must target a native deform bone');
    const id = `${track.node}/${track.path}`; assert(!keys.has(id), 'duplicate track'); keys.add(id);
    assert(track.path === 'rotation' || (track.path === 'translation' && track.node === 'DEF-Hips'), 'only native rotations and Hips translation allowed');
    assert(track.times.length >= 2 && track.times[0] === 0 && Math.abs(track.times.at(-1) - durations[clip.name]) < 1e-10, 'incorrect duration');
    assert(track.times.every((t, i) => Number.isFinite(t) && (i === 0 || t > track.times[i - 1])), 'nonmonotonic sample times');
    const width = track.path === 'rotation' ? 4 : 3;
    assert(track.values.length === track.times.length * width && track.values.every(Number.isFinite), 'invalid track values');
    if (width === 4) for (let i = 0; i < track.values.length; i += 4) maxQuaternionNormError = Math.max(maxQuaternionNormError, Math.abs(Math.hypot(...track.values.slice(i, i + 4)) - 1));
  }
  check(`${clip.name}-tracks`, keys.size === 71 && keys.has('DEF-Hips/translation'), '70 native rotations plus one Hips translation');
  check(`${clip.name}-unit-quaternions`, maxQuaternionNormError < 2e-6, `${maxQuaternionNormError}`);
  let maxBoneLengthError = 0, maxSplitLocalAngleRad = 0, minShoeY = Infinity;
  const shoeVertices = vertices.filter(v => v.mesh.startsWith('FINN-shoes_'));
  const steps = Math.ceil(durations[clip.name] * 120);
  for (let step = 0; step <= steps; step++) {
    const pose = evaluate(clip, step / steps * durations[clip.name]);
    for (const i of nativeJoints) if (parents.has(i) && doc.nodes[i].name !== 'DEF-Hips') {
      const parent = parents.get(i);
      const length = new Vector3().setFromMatrixPosition(pose.world[i]).distanceTo(new Vector3().setFromMatrixPosition(pose.world[parent]));
      const restLength = new Vector3().setFromMatrixPosition(rest.world[i]).distanceTo(new Vector3().setFromMatrixPosition(rest.world[parent]));
      maxBoneLengthError = Math.max(maxBoneLengthError, Math.abs(length - restLength));
    }
    for (const i of splitNames) maxSplitLocalAngleRad = Math.max(maxSplitLocalAngleRad, pose.local[i].q.angleTo(restTRS[i].q));
    minShoeY = Math.min(minShoeY, skinnedBounds(pose, shoeVertices).minY);
  }
  check(`${clip.name}-bone-lengths`, maxBoneLengthError < 1e-5, `max rest length error ${maxBoneLengthError}m at120Hz`);
  check(`${clip.name}-split-rest`, maxSplitLocalAngleRad < 1e-5, `max split-segment local rotation deviation ${maxSplitLocalAngleRad}rad`);
  const first = evaluate(clip, 0), last = evaluate(clip, durations[clip.name]);
  const loopError = Math.max(...nativeJoints.flatMap(i => first.world[i].elements.map((v, k) => Math.abs(v - last.world[i].elements[k]))));
  if (loopNames.has(clip.name)) check(`${clip.name}-loop`, loopError < 1e-5, `world-matrix closure ${loopError}`);
  report[clip.name] = { duration: durations[clip.name], samples: clip.tracks[0].times.length, tracks: keys.size, maxQuaternionNormError, maxBoneLengthErrorMeters: maxBoneLengthError, maxSplitLocalAngleRad, loopWorldMatrixError: loopError, allShoeVerticesMinYAt120Hz: minShoeY, startSkinnedBounds: skinnedBounds(first), endSkinnedBounds: skinnedBounds(last) };
}
const aim = evaluate(supplement.clips.find(c => c.name === 'aim'), 0), socketReport = {};
for (const socket of supplement.sockets) {
  assert(names.has(socket.parent) && jointSet.has(names.get(socket.parent)), 'invalid socket parent');
  const local = new Matrix4().compose(new Vector3().fromArray(socket.translation), new Quaternion().fromArray(socket.rotation), new Vector3().fromArray(socket.scale ?? [1, 1, 1]));
  const matrix = aim.world[names.get(socket.parent)].clone().multiply(local);
  socketReport[socket.name] = { parent: socket.parent, aimWorldPosition: new Vector3().setFromMatrixPosition(matrix).toArray(), aimForward: new Vector3(0, 0, 1).transformDirection(matrix).toArray(), aimUp: new Vector3(0, 1, 0).transformDirection(matrix).toArray() };
}
check('hand-socket-axis', new Vector3().fromArray(socketReport.SOCKET_HAND_R.aimForward).distanceTo(new Vector3(0, 0, 1)) < 1e-5 && new Vector3().fromArray(socketReport.SOCKET_HAND_R.aimUp).distanceTo(new Vector3(0, 1, 0)) < 1e-5, 'reference aim +Z barrel/+Y up from independently reconstructed local tracks');
const result = { version: 1, status: 'PASS_NUMERICAL_RUNTIME_PENDING', source: args.source, sourceSha256: sha(sourceBytes), supplement: args.supplement, supplementSha256: sha(supplementBytes), verifierSha256: sha(readFileSync(new URL(import.meta.url))), checks, clips: report, sockets: socketReport, limits: 'All shoe vertices sampled at120Hz; start/end whole-body skinned bounds are diagnostics only. Pistol contact, seated vehicle anchors, death floor contact, upper-body masks and actual transitions require runtime visual review.' };
writeFileSync(args.out, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ status: result.status, checks: checks.length, clips: report, sockets: socketReport }));
