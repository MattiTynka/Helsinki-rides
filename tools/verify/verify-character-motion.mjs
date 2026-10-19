// Independent offline regression/motion measurements from uncompressed exported GLB bytes.
// node tools/verify/verify-character-motion.mjs --before OLD.glb --after NEW.glb --contract content/assets/character.contract.json --out data/evidence/NEW_DIR [--provenance SOURCE.json]
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const requireGame = createRequire(new URL('../../apps/game/package.json', import.meta.url));
const { Matrix4, Quaternion, Vector3 } = await import(new URL('./three.module.js', pathToFileURL(requireGame.resolve('three'))).href);
const { values } = parseArgs({ options: {
  before: { type: 'string' }, after: { type: 'string' }, out: { type: 'string' },
  contract: { type: 'string', default: 'content/assets/character.contract.json' }, provenance: { type: 'string' },
} });
if (!values.before || !values.after || !values.out) throw new Error('--before, --after and --out are required');
if (existsSync(values.out)) throw new Error(`${values.out} exists; evidence directories are never overwritten`);
mkdirSync(values.out, { recursive: true });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const contractBytes = readFileSync(values.contract);
const contract = JSON.parse(contractBytes.toString('utf8'));
const MOVEMENT = new Set(['walk', 'run', 'sprint']);
// Chosen before inspecting the candidate. Quality thresholds are diagnostic, separately from regression gates.
const TOLERANCES = {
  geometryNumeric: 1e-6, restMatrix: 1e-5, unchangedPositionM: 1e-5, unchangedAngleDeg: 0.01,
  loopPositionM: 0.001, loopAngleDeg: 0.25, hipsHorizontalExcursionM: 0.15,
  seamLinearVelocityMps: 0.5, seamAngularVelocityDegps: 180,
  shoePenetrationM: 0.015, inferredContactHeightM: 0.025, inferredContactVerticalMps: 0.25,
  inferredContactMinSeconds: 0.08, inferredContactDriftM: 0.05,
};
const SAMPLE_HZ = 120;
// The ToeBase joint represents the metatarsal/ball pivot. A fixed 5 cm fore/aft band across a bounded 12 cm
// shoe width samples that pad, including a low-poly sole's perimeter instead of requiring interior vertices.
const BALL_MARKER_HALF_LENGTH_M = 0.025;
const BALL_MARKER_HALF_WIDTH_M = 0.06;
const checks = [];
function check(id, pass, detail) { checks.push({ id, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${id}: ${detail}`); }
function assert(test, message) { if (!test) throw new Error(message); }
const COMPONENTS = { 5120: [1, 'getInt8'], 5121: [1, 'getUint8'], 5122: [2, 'getInt16'], 5123: [2, 'getUint16'], 5125: [4, 'getUint32'], 5126: [4, 'getFloat32'] };
const SIZES = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const finite = array => array.every(Number.isFinite);
const deg = radians => radians * 180 / Math.PI;
const rounded = value => Math.round(value * 1e8) / 1e8;
const canonical = value => JSON.stringify(sortKeys(value));
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])]));
  return value;
}
function maxDifference(a, b) {
  if (a.length !== b.length) return Infinity;
  let max = 0;
  for (let i = 0; i < a.length; i++) { if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) return Infinity; max = Math.max(max, Math.abs(a[i] - b[i])); }
  return max;
}
function normalizeComponent(value, componentType) {
  if (componentType === 5120) return Math.max(value / 127, -1);
  if (componentType === 5121) return value / 255;
  if (componentType === 5122) return Math.max(value / 32767, -1);
  if (componentType === 5123) return value / 65535;
  if (componentType === 5125) return value / 4294967295;
  return value;
}

function loadGlb(file) {
  const bytes = readFileSync(file);
  assert(bytes.length >= 20 && bytes.readUInt32LE(0) === 0x46546c67 && bytes.readUInt32LE(4) === 2, `${file}: expected GLB 2`);
  assert(bytes.readUInt32LE(8) === bytes.length, `${file}: incorrect GLB length`);
  let json, binary;
  for (let offset = 12; offset < bytes.length;) {
    assert(offset + 8 <= bytes.length, 'truncated chunk header');
    const length = bytes.readUInt32LE(offset), type = bytes.readUInt32LE(offset + 4);
    assert(offset + 8 + length <= bytes.length && length % 4 === 0, 'truncated or unaligned chunk');
    const chunk = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === 0x4e4f534a) { assert(!json, 'duplicate JSON chunk'); json = JSON.parse(chunk.toString('utf8')); }
    if (type === 0x004e4942) { assert(!binary, 'duplicate BIN chunk'); binary = chunk; }
    offset += 8 + length;
  }
  assert(json && binary, 'GLB must contain JSON and BIN');
  assert((json.buffers?.length ?? 0) === 1 && !json.buffers[0].uri && json.buffers[0].byteLength <= binary.length, 'only one embedded buffer is supported');
  assert(!(json.extensionsRequired ?? []).some(name => ['KHR_draco_mesh_compression', 'EXT_meshopt_compression'].includes(name)), 'compressed mesh data is outside this verifier');
  assert(!(json.bufferViews ?? []).some(view => view.extensions?.EXT_meshopt_compression), 'meshopt bufferView is outside this verifier');
  const cache = new Map();
  function viewBytes(index) {
    const view = json.bufferViews?.[index];
    assert(view && (view.buffer ?? 0) === 0, `invalid bufferView ${index}`);
    const offset = view.byteOffset ?? 0;
    assert(offset >= 0 && view.byteLength >= 0 && offset + view.byteLength <= json.buffers[0].byteLength, `bufferView ${index} out of bounds`);
    return binary.subarray(offset, offset + view.byteLength);
  }
  function accessor(index) {
    if (cache.has(index)) return cache.get(index);
    const a = json.accessors?.[index];
    assert(a && COMPONENTS[a.componentType] && SIZES[a.type], `unsupported accessor ${index}`);
    assert(Number.isInteger(a.count) && a.count >= 0 && a.count <= 10000000, `invalid accessor count ${index}`);
    const [width, method] = COMPONENTS[a.componentType], size = SIZES[a.type];
    const dimension = a.type.startsWith('MAT') ? Number(a.type.slice(3)) : 0;
    const columnStride = dimension ? Math.ceil(dimension * width / 4) * 4 : 0;
    const offsets = Array.from({ length: size }, (_, i) => dimension ? Math.floor(i / dimension) * columnStride + (i % dimension) * width : i * width);
    const elementBytes = dimension ? dimension * columnStride : size * width;
    const out = new Float64Array(a.count * size);
    const read = (data, byteOffset, count, stride, writeAt) => {
      assert(byteOffset >= 0 && stride >= elementBytes && (!count || byteOffset + (count - 1) * stride + elementBytes <= data.byteLength), `accessor ${index} out of bounds`);
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      for (let row = 0; row < count; row++) for (let col = 0; col < size; col++) {
        const raw = view[method](byteOffset + row * stride + offsets[col], true);
        out[writeAt(row) * size + col] = a.normalized ? normalizeComponent(raw, a.componentType) : raw;
      }
    };
    if (a.bufferView !== undefined) {
      const bv = json.bufferViews[a.bufferView];
      read(viewBytes(a.bufferView), a.byteOffset ?? 0, a.count, bv.byteStride ?? elementBytes, row => row);
    }
    if (a.sparse) {
      const sparse = a.sparse;
      assert(sparse.count <= a.count && [5121, 5123, 5125].includes(sparse.indices.componentType), 'invalid sparse accessor');
      const [iw, im] = COMPONENTS[sparse.indices.componentType];
      const ib = viewBytes(sparse.indices.bufferView), io = sparse.indices.byteOffset ?? 0;
      assert(io + sparse.count * iw <= ib.length, 'sparse indices out of bounds');
      const iv = new DataView(ib.buffer, ib.byteOffset, ib.byteLength);
      const rows = Array.from({ length: sparse.count }, (_, i) => iv[im](io + i * iw, true));
      assert(rows.every((row, i) => row < a.count && (i === 0 || row > rows[i - 1])), 'sparse indices must increase within accessor');
      read(viewBytes(sparse.values.bufferView), sparse.values.byteOffset ?? 0, sparse.count, elementBytes, row => rows[row]);
    }
    assert(finite(out), `nonfinite accessor ${index}`);
    const result = { values: out, size, count: a.count, type: a.type, componentType: a.componentType, normalized: a.normalized ?? false };
    cache.set(index, result);
    return result;
  }
  const nodes = json.nodes ?? [];
  const names = nodes.map((node, i) => node.name ?? `#${i}`);
  assert(new Set(names).size === names.length, 'node names must be unique for semantic comparison');
  const byName = new Map(names.map((name, i) => [name, i]));
  const parents = new Array(nodes.length).fill(-1);
  for (let i = 0; i < nodes.length; i++) for (const child of nodes[i].children ?? []) {
    assert(Number.isInteger(child) && child >= 0 && child < nodes.length && parents[child] === -1, 'invalid child or multiple parents');
    parents[child] = i;
  }
  const rest = nodes.map(node => {
    const p = new Vector3(), q = new Quaternion(), s = new Vector3();
    if (node.matrix) new Matrix4().fromArray(node.matrix).decompose(p, q, s);
    else { p.fromArray(node.translation ?? [0, 0, 0]); q.fromArray(node.rotation ?? [0, 0, 0, 1]); s.fromArray(node.scale ?? [1, 1, 1]); }
    assert(finite([...p, ...q, ...s]), 'nonfinite rest transform');
    return { p, q, s };
  });
  const clips = new Map();
  for (const animation of json.animations ?? []) {
    assert(animation.name && !clips.has(animation.name), 'animations require unique names');
    let duration = 0;
    const keys = new Set();
    const tracks = animation.channels.map(channel => {
      const sampler = animation.samplers[channel.sampler], target = channel.target;
      assert(sampler && Number.isInteger(target.node) && nodes[target.node], 'invalid animation target');
      assert(['translation', 'rotation', 'scale'].includes(target.path), `unsupported animation path ${target.path}`);
      assert(!nodes[target.node].matrix, 'animated matrix nodes are outside the glTF TRS contract');
      const key = `${names[target.node]}/${target.path}`;
      assert(!keys.has(key), `duplicate channel ${key}`); keys.add(key);
      const input = accessor(sampler.input), output = accessor(sampler.output);
      const interpolation = sampler.interpolation ?? 'LINEAR';
      assert(['LINEAR', 'STEP', 'CUBICSPLINE'].includes(interpolation), `unsupported interpolation ${interpolation}`);
      assert(input.size === 1 && input.count > 0 && input.values.every((t, i) => t >= 0 && (i === 0 || t > input.values[i - 1])), 'invalid animation time sequence');
      assert(output.size === (target.path === 'rotation' ? 4 : 3) && output.count === input.count * (interpolation === 'CUBICSPLINE' ? 3 : 1), 'animation output shape mismatch');
      duration = Math.max(duration, input.values[input.count - 1]);
      return { node: target.node, path: target.path, input, output, interpolation };
    });
    clips.set(animation.name, { name: animation.name, duration, tracks });
  }
  function sampleTrack(track, time) {
    const times = track.input.values, size = track.output.size, data = track.output.values;
    const cubic = track.interpolation === 'CUBICSPLINE';
    const value = (row, section = 1) => Array.from(data.subarray((cubic ? row * 3 + section : row) * size, (cubic ? row * 3 + section : row) * size + size));
    if (time <= times[0]) return value(0);
    if (time >= times[times.length - 1]) return value(times.length - 1);
    let left = 0, right = times.length - 1;
    while (right - left > 1) { const middle = (left + right) >> 1; if (times[middle] <= time) left = middle; else right = middle; }
    const a = value(left), b = value(right);
    if (track.interpolation === 'STEP') return a;
    const dt = times[right] - times[left], u = (time - times[left]) / dt;
    if (cubic) {
      const outTangent = value(left, 2), inTangent = value(right, 0), u2 = u * u, u3 = u2 * u;
      const result = a.map((v, i) => (2 * u3 - 3 * u2 + 1) * v + (u3 - 2 * u2 + u) * dt * outTangent[i] + (-2 * u3 + 3 * u2) * b[i] + (u3 - u2) * dt * inTangent[i]);
      return track.path === 'rotation' ? new Quaternion().fromArray(result).normalize().toArray() : result;
    }
    return track.path === 'rotation' ? new Quaternion().fromArray(a).slerp(new Quaternion().fromArray(b), u).normalize().toArray() : a.map((v, i) => v + (b[i] - v) * u);
  }
  function pose(clip, time) {
    const local = rest.map(item => ({ p: item.p.clone(), q: item.q.clone(), s: item.s.clone() }));
    for (const track of clip?.tracks ?? []) {
      const target = local[track.node], result = sampleTrack(track, time);
      if (track.path === 'translation') target.p.fromArray(result);
      if (track.path === 'rotation') target.q.fromArray(result).normalize();
      if (track.path === 'scale') target.s.fromArray(result);
    }
    const worlds = new Array(nodes.length), visiting = new Set();
    function world(i) {
      if (worlds[i]) return worlds[i];
      assert(!visiting.has(i), 'cyclic node hierarchy'); visiting.add(i);
      const transform = new Matrix4().compose(local[i].p, local[i].q, local[i].s);
      worlds[i] = parents[i] < 0 ? transform : world(parents[i]).clone().multiply(transform);
      visiting.delete(i); return worlds[i];
    }
    for (let i = 0; i < nodes.length; i++) world(i);
    const positions = worlds.map(matrix => new Vector3().setFromMatrixPosition(matrix));
    const rotations = worlds.map(matrix => { const p = new Vector3(), q = new Quaternion(), s = new Vector3(); matrix.decompose(p, q, s); return q.normalize(); });
    return { worlds, positions, rotations };
  }
  return { file, bytes, json, binary, accessor, viewBytes, names, byName, parents, rest, clips, pose, sha256: hash(bytes) };
}

function materialsOf(glb) {
  const images = (glb.json.images ?? []).map(image => {
    assert(image.bufferView !== undefined && !image.uri, 'external images are outside this verifier');
    return { name: image.name ?? null, mimeType: image.mimeType ?? null, sha256: hash(glb.viewBytes(image.bufferView)) };
  });
  const textures = (glb.json.textures ?? []).map(texture => ({
    image: images[texture.source], sampler: glb.json.samplers?.[texture.sampler] ?? {}, extensions: texture.extensions ?? {},
  }));
  function remap(value, key = '') {
    if (Array.isArray(value)) return value.map(item => remap(item));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, name === 'index' && key.endsWith('Texture') ? textures[item] : remap(item, name)]));
  }
  return { images: images.toSorted((a, b) => canonical(a).localeCompare(canonical(b))), materials: (glb.json.materials ?? []).map(material => remap(material)), textures };
}
function compareRest(before, after) {
  check('node-set', canonical([...before.names].sort()) === canonical([...after.names].sort()), `${before.names.length} → ${after.names.length} named nodes`);
  let maxRest = 0, parentsEqual = true;
  const aRest = before.pose(null, 0), bRest = after.pose(null, 0);
  for (const [name, ai] of before.byName) {
    const bi = after.byName.get(name);
    if (bi === undefined) { parentsEqual = false; maxRest = Infinity; continue; }
    parentsEqual &&= (before.names[before.parents[ai]] ?? null) === (after.names[after.parents[bi]] ?? null);
    maxRest = Math.max(maxRest, maxDifference(aRest.worlds[ai].elements, bRest.worlds[bi].elements));
  }
  check('rest-hierarchy', parentsEqual && maxRest <= TOLERANCES.restMatrix, `parents equal ${parentsEqual}, max world-matrix delta ${maxRest}`);
  let skinMax = 0;
  const skinReports = [];
  const meshNodes = before.json.nodes.map((node, index) => ({ node, index })).filter(({ node }) => node.skin !== undefined);
  for (const { node, index } of meshNodes) {
    const nextNode = after.json.nodes[after.byName.get(before.names[index])];
    const a = before.json.skins[node.skin], b = after.json.skins[nextNode?.skin];
    if (!a || !b) { skinMax = Infinity; continue; }
    const an = a.joints.map(j => before.names[j]), bn = b.joints.map(j => after.names[j]);
    const sameJoints = canonical([...an].sort()) === canonical([...bn].sort());
    check(`skin-joints-${before.names[index]}`, sameJoints && contract.skeleton.joints.every(name => bn.includes(name)), `${an.length} → ${bn.length} joints; contract joints present`);
    const am = a.inverseBindMatrices === undefined ? null : before.accessor(a.inverseBindMatrices).values;
    const bm = b.inverseBindMatrices === undefined ? null : after.accessor(b.inverseBindMatrices).values;
    let delta = sameJoints ? 0 : Infinity;
    for (let i = 0; i < an.length; i++) {
      const j = bn.indexOf(an[i]);
      const ai = am ? Array.from(am.subarray(i * 16, i * 16 + 16)) : new Matrix4().elements;
      const bi = bm && j >= 0 ? Array.from(bm.subarray(j * 16, j * 16 + 16)) : new Matrix4().elements;
      delta = Math.max(delta, maxDifference(ai, bi));
    }
    skinMax = Math.max(skinMax, delta); skinReports.push({ mesh: before.names[index], inverseBindMaxDelta: delta });
  }
  check('inverse-bind-matrices', skinMax <= TOLERANCES.restMatrix, `max delta ${skinMax}`);
  return { maxRestMatrixDelta: maxRest, skinReports };
}
function compareGeometry(before, after) {
  const differences = [], aMaterials = materialsOf(before), bMaterials = materialsOf(after);
  const afterRest = after.pose(null, 0), boundsMin = new Vector3(Infinity, Infinity, Infinity), boundsMax = new Vector3(-Infinity, -Infinity, -Infinity);
  check('embedded-images', canonical(aMaterials.images) === canonical(bMaterials.images), `${aMaterials.images.length} → ${bMaterials.images.length} embedded image payloads`);
  check('materials', canonical(aMaterials.materials.map(canonical).sort()) === canonical(bMaterials.materials.map(canonical).sort()), `${aMaterials.materials.length} → ${bMaterials.materials.length} semantic materials`);
  const meshNames = glb => glb.json.nodes.filter(node => node.mesh !== undefined).map(node => node.name).sort();
  if (canonical(meshNames(before)) !== canonical(meshNames(after))) differences.push('mesh-bearing node set differs');
  let maxAttributeDelta = 0, primitives = 0, vertices = 0;
  for (let ai = 0; ai < before.json.nodes.length; ai++) {
    const aNode = before.json.nodes[ai]; if (aNode.mesh === undefined) continue;
    const bi = after.byName.get(before.names[ai]), bNode = after.json.nodes[bi];
    const am = before.json.meshes[aNode.mesh], bm = after.json.meshes[bNode?.mesh];
    if (!bm || am.primitives.length !== bm.primitives.length) { differences.push(`${before.names[ai]} primitive count differs`); continue; }
    if (canonical(am.weights ?? []) !== canonical(bm.weights ?? [])) differences.push('mesh morph weights differ');
    for (let pi = 0; pi < am.primitives.length; pi++) {
      const a = am.primitives[pi], b = bm.primitives[pi], label = `${before.names[ai]}/${pi}`; primitives++;
      if ((a.mode ?? 4) !== (b.mode ?? 4)) differences.push(`${label} topology mode differs`);
      if (a.targets || b.targets) throw new Error('morph target meshes require a separate verifier');
      if (canonical(aMaterials.materials[a.material]) !== canonical(bMaterials.materials[b.material])) differences.push(`${label} material assignment differs`);
      const attrs = Object.keys(a.attributes).sort();
      if (canonical(attrs) !== canonical(Object.keys(b.attributes).sort())) { differences.push(`${label} attribute set differs`); continue; }
      vertices += before.accessor(a.attributes.POSITION).count;
      const afterPositions = after.accessor(b.attributes.POSITION);
      for (let vertex = 0; vertex < afterPositions.count; vertex++) {
        const point = new Vector3().fromArray(afterPositions.values, vertex * 3).applyMatrix4(afterRest.worlds[bi]);
        boundsMin.min(point); boundsMax.max(point);
      }
      for (const name of attrs.filter(name => !/^(JOINTS|WEIGHTS)_/.test(name))) {
        const aa = before.accessor(a.attributes[name]), ba = after.accessor(b.attributes[name]);
        const delta = aa.type === ba.type ? maxDifference(aa.values, ba.values) : Infinity;
        maxAttributeDelta = Math.max(maxAttributeDelta, delta);
        if (delta > TOLERANCES.geometryNumeric) differences.push(`${label}/${name} max delta ${delta}`);
      }
      const indices = (glb, primitive) => primitive.indices === undefined ? Array.from({ length: glb.accessor(primitive.attributes.POSITION).count }, (_, i) => i) : glb.accessor(primitive.indices).values;
      if (maxDifference(indices(before, a), indices(after, b)) !== 0) differences.push(`${label} indices differ`);
      const jointSets = attrs.filter(name => name.startsWith('JOINTS_'));
      function influenceRows(glb, node, primitive) {
        const skin = glb.json.skins[node.skin];
        const count = glb.accessor(primitive.attributes.POSITION).count;
        const rows = Array.from({ length: count }, () => new Map());
        for (const jointSet of jointSets) {
          const weightSet = jointSet.replace('JOINTS_', 'WEIGHTS_');
          assert(primitive.attributes[weightSet] !== undefined && skin, 'skin influence pair missing');
          const j = glb.accessor(primitive.attributes[jointSet]), w = glb.accessor(primitive.attributes[weightSet]);
          assert(j.count === count && w.count === count && j.size === w.size, 'skin influence shape mismatch');
          for (let vertex = 0; vertex < count; vertex++) for (let slot = 0; slot < j.size; slot++) {
            const weight = w.values[vertex * w.size + slot]; if (weight === 0) continue;
            const joint = glb.names[skin.joints[j.values[vertex * j.size + slot]]];
            assert(joint, 'invalid skin joint index'); rows[vertex].set(joint, (rows[vertex].get(joint) ?? 0) + weight);
          }
        }
        return rows;
      }
      if (jointSets.length) {
        const ar = influenceRows(before, aNode, a), br = influenceRows(after, bNode, b);
        if (ar.length !== br.length) differences.push(`${label} skin vertex count differs`);
        else for (let vertex = 0; vertex < ar.length; vertex++) {
          const joints = new Set([...ar[vertex].keys(), ...br[vertex].keys()]);
          if ([...joints].some(joint => Math.abs((ar[vertex].get(joint) ?? 0) - (br[vertex].get(joint) ?? 0)) > TOLERANCES.geometryNumeric)) { differences.push(`${label} vertex ${vertex} skin weights differ`); break; }
        }
      }
    }
  }
  check('geometry-and-skin-weights', differences.length === 0, `${primitives} primitives, ${vertices} vertices, max attribute delta ${maxAttributeDelta}; ${differences.slice(0, 4).join('; ') || 'unchanged'}`);
  const height = boundsMax.y - boundsMin.y;
  check('metre-scale-and-ground', height >= contract.heightMeters.min && height <= contract.heightMeters.max && Math.abs(boundsMin.y) <= 0.02, `bind height ${height} m, lowest vertex Y ${boundsMin.y} m`);
  return { primitives, vertices, maxAttributeDelta, bindBounds: { min: boundsMin.toArray(), max: boundsMax.toArray(), heightM: height }, differences: differences.slice(0, 100) };
}

function poseDifference(a, b, before, after, names) {
  let position = 0, angle = 0;
  for (const name of names) {
    const i = before.byName.get(name), j = after.byName.get(name);
    if (i === undefined || j === undefined) return { position: Infinity, angle: Infinity };
    position = Math.max(position, a.positions[i].distanceTo(b.positions[j]));
    angle = Math.max(angle, deg(a.rotations[i].angleTo(b.rotations[j])));
  }
  return { position, angle };
}
function compareOtherClips(before, after) {
  const expected = contract.clips.map(clip => clip.name);
  check('clip-set', expected.every(name => after.clips.has(name)) && canonical([...before.clips.keys()].sort()) === canonical([...after.clips.keys()].sort()), [...after.clips.keys()].join(', '));
  const reports = [];
  for (const name of expected.filter(name => !MOVEMENT.has(name))) {
    const a = before.clips.get(name), b = after.clips.get(name);
    if (!a || !b) { check(`unchanged-${name}`, false, 'missing clip'); continue; }
    const times = new Set([0, a.duration, b.duration]);
    for (let tick = 0; tick <= Math.ceil(Math.max(a.duration, b.duration) * SAMPLE_HZ); tick++) times.add(Math.min(tick / SAMPLE_HZ, Math.max(a.duration, b.duration)));
    for (const track of [...a.tracks, ...b.tracks]) for (const time of track.input.values) times.add(time);
    let maxPosition = 0, maxAngle = 0, maxMatrix = 0;
    for (const time of times) {
      const ap = before.pose(a, time), bp = after.pose(b, time);
      const d = poseDifference(ap, bp, before, after, before.names);
      maxPosition = Math.max(maxPosition, d.position); maxAngle = Math.max(maxAngle, d.angle);
      for (const nodeName of before.names) if (after.byName.has(nodeName)) maxMatrix = Math.max(maxMatrix, maxDifference(ap.worlds[before.byName.get(nodeName)].elements, bp.worlds[after.byName.get(nodeName)].elements));
    }
    const pass = Math.abs(a.duration - b.duration) <= 1e-6 && maxPosition <= TOLERANCES.unchangedPositionM && maxAngle <= TOLERANCES.unchangedAngleDeg && maxMatrix <= TOLERANCES.restMatrix;
    check(`unchanged-${name}`, pass, `${times.size} samples, max position ${maxPosition} m, angle ${maxAngle}°, matrix ${maxMatrix}`);
    reports.push({ name, beforeSeconds: a.duration, afterSeconds: b.duration, samples: times.size, maxPositionDeltaM: maxPosition, maxAngleDeltaDeg: maxAngle, maxMatrixDelta: maxMatrix, pass });
  }
  return reports;
}

function angularVelocity(a, b, dt) {
  const delta = b.clone().multiply(a.clone().invert()).normalize();
  if (delta.w < 0) delta.set(-delta.x, -delta.y, -delta.z, -delta.w);
  const sin = Math.hypot(delta.x, delta.y, delta.z);
  return sin < 1e-10 ? new Vector3() : new Vector3(delta.x, delta.y, delta.z).multiplyScalar(2 * Math.atan2(sin, delta.w) / (sin * dt));
}
function velocitySeam(glb, first, next, previous, last, dt, joints) {
  let linear = 0, angular = 0, linearJoint = null, angularJoint = null;
  for (const joint of joints) {
    const j = glb.byName.get(joint); assert(j !== undefined, `missing ${joint}`);
    const outgoing = next.positions[j].clone().sub(first.positions[j]).divideScalar(dt);
    const incoming = last.positions[j].clone().sub(previous.positions[j]).divideScalar(dt);
    const linearDelta = outgoing.distanceTo(incoming);
    const outgoingAngular = angularVelocity(first.rotations[j], next.rotations[j], dt);
    const incomingAngular = angularVelocity(previous.rotations[j], last.rotations[j], dt);
    const angularDelta = deg(outgoingAngular.distanceTo(incomingAngular));
    if (linearDelta > linear) { linear = linearDelta; linearJoint = joint; }
    if (angularDelta > angular) { angular = angularDelta; angularJoint = joint; }
  }
  return { linearVelocityMismatchMps: linear, angularVelocityMismatchDegps: angular, linearJoint, angularJoint };
}
function validateBoundaryMeasurement() {
  const probe = { byName: new Map([['Probe', 0]]) };
  const pose = (fn, t) => ({ positions: [new Vector3(fn(t), 0, 0)], rotations: [new Quaternion()] });
  const curves = { smoothCosine: t => 2 * Math.cos(2 * Math.PI * t), c0Triangle: t => t <= 0.5 ? t : 1 - t };
  const results = Object.fromEntries(Object.entries(curves).map(([name, fn]) => [name, [1 / 120, 1e-3, 1e-5, 1e-6].map(epsilon => ({ epsilonSeconds: epsilon,
    ...velocitySeam(probe, pose(fn, 0), pose(fn, epsilon), pose(fn, 1 - epsilon), pose(fn, 1), epsilon, ['Probe']) }))]));
  assert(results.smoothCosine[0].linearVelocityMismatchMps > TOLERANCES.seamLinearVelocityMps, 'known cosine must expose the acceleration contamination in 120Hz chords');
  assert(results.smoothCosine.at(-1).linearVelocityMismatchMps < 0.001, 'smooth periodic derivative must converge at the seam');
  assert(Math.abs(results.c0Triangle.at(-1).linearVelocityMismatchMps - 2) < 1e-6, 'a real C0-only velocity kink must remain detected');
  return { status: 'PASS', reason: '120Hz chords average acceleration; the actual one-sided derivatives converge for a smooth periodic curve, while a genuine C0-only kink remains. Both curves exercise the same velocity helper as GLB measurements.',
    curves: { smoothCosine: 'x(t)=2*cos(2*pi*t), duration1s; exact seam velocity0 on both sides', c0Triangle: 'x(t)=t for t<=.5, else1-t; duration1s; exact seam mismatch2m/s' }, results };
}
function footVertices(glb) {
  const groups = { Left: [], Right: [] }, rest = glb.pose(null, 0);
  for (let nodeIndex = 0; nodeIndex < glb.json.nodes.length; nodeIndex++) {
    const node = glb.json.nodes[nodeIndex]; if (node.mesh === undefined || node.skin === undefined) continue;
    const skin = glb.json.skins[node.skin];
    const inverse = skin.inverseBindMatrices === undefined ? skin.joints.map(() => new Matrix4()) : skin.joints.map((_, i) => new Matrix4().fromArray(glb.accessor(skin.inverseBindMatrices).values, i * 16));
    for (const primitive of glb.json.meshes[node.mesh].primitives) {
      const pos = glb.accessor(primitive.attributes.POSITION), joints = glb.accessor(primitive.attributes.JOINTS_0), weights = glb.accessor(primitive.attributes.WEIGHTS_0);
      for (let vertex = 0; vertex < pos.count; vertex++) {
        const position = new Vector3().fromArray(pos.values, vertex * 3);
        const influences = [];
        for (let slot = 0; slot < joints.size; slot++) {
          const weight = weights.values[vertex * weights.size + slot], localJoint = joints.values[vertex * joints.size + slot];
          if (weight > 0) influences.push({ joint: skin.joints[localJoint], inverse: inverse[localJoint], weight });
        }
        const bindPosition = influences.reduce((sum, influence) => sum.add(position.clone().applyMatrix4(influence.inverse).applyMatrix4(rest.worlds[influence.joint]).multiplyScalar(influence.weight)), new Vector3());
        for (const side of ['Left', 'Right']) {
          const footWeight = influences.filter(influence => [`${side}Foot`, `${side}ToeBase`].includes(glb.names[influence.joint])).reduce((sum, influence) => sum + influence.weight, 0);
          if (footWeight >= 0.5 && bindPosition.y <= 0.12) groups[side].push({ position, influences, bindPosition });
        }
      }
    }
  }
  for (const side of ['Left', 'Right']) {
    const vertices = groups[side], minY = Math.min(...vertices.map(vertex => vertex.bindPosition.y));
    const sole = vertices.filter(vertex => vertex.bindPosition.y <= minY + 0.01);
    const minZ = Math.min(...sole.map(vertex => vertex.bindPosition.z)), maxZ = Math.max(...sole.map(vertex => vertex.bindPosition.z));
    const ball = rest.positions[glb.byName.get(`${side}ToeBase`)];
    assert(ball, `missing ${side}ToeBase ball pivot`);
    groups[side] = { vertices, sole, ballBindProjectionXZ: [ball.x, ball.z],
      heel: sole.filter(vertex => vertex.bindPosition.z <= minZ + 0.2 * (maxZ - minZ)),
      ball: sole.filter(vertex => Math.abs(vertex.bindPosition.x - ball.x) <= BALL_MARKER_HALF_WIDTH_M && Math.abs(vertex.bindPosition.z - ball.z) <= BALL_MARKER_HALF_LENGTH_M),
      toe: sole.filter(vertex => vertex.bindPosition.z >= maxZ - 0.2 * (maxZ - minZ)),
    };
  }
  return groups;
}
function skinPoint(vertex, pose) {
  return vertex.influences.reduce((sum, influence) => sum.add(vertex.position.clone().applyMatrix4(influence.inverse).applyMatrix4(pose.worlds[influence.joint]).multiplyScalar(influence.weight)), new Vector3());
}
function inferContacts(points, dt, speed, diagnostics) {
  const contacts = points.map((point, i) => {
    const previous = points[Math.max(0, i - 1)], next = points[Math.min(points.length - 1, i + 1)];
    const vertical = Math.abs(next.y - previous.y) / ((i === 0 || i === points.length - 1 ? 1 : 2) * dt);
    return Math.abs(point.y) <= TOLERANCES.inferredContactHeightM && vertical <= TOLERANCES.inferredContactVerticalMps;
  });
  const runs = [];
  for (let i = 0; i < contacts.length;) {
    if (!contacts[i]) { i++; continue; }
    const start = i; while (i + 1 < contacts.length && contacts[i + 1]) i++;
    const end = i++;
    runs.push({ start, end });
  }
  // A stance can cross the clip seam. Join its two pieces before applying the minimum duration.
  if (runs.length > 1 && runs[0].start === 0 && runs[runs.length - 1].end === points.length - 1) {
    const first = runs.shift(), last = runs.pop();
    runs.push({ start: last.start, end: last.end + first.end });
  }
  if (diagnostics) {
    diagnostics.minimumMarkerY = Math.min(...points.map(point => point.y));
    diagnostics.maximumMarkerY = Math.max(...points.map(point => point.y));
    diagnostics.longestHeightAndVelocityQualifiedSeconds = Math.max(0, ...runs.map(run => (run.end - run.start) * dt));
    diagnostics.candidateIntervalsBeforeMinimumDuration = runs.map(run => ({ startSeconds: run.start * dt, endSeconds: run.end * dt, seconds: (run.end - run.start) * dt }));
  }
  const intervals = [];
  const at = index => points[index <= points.length - 1 ? index : index - (points.length - 1)];
  for (const { start, end } of runs) {
    if ((end - start) * dt < TOLERANCES.inferredContactMinSeconds) continue;
    const origin = at(start).clone().add(new Vector3(0, 0, speed * start * dt));
    let maxDrift = 0;
    for (let j = start; j <= end; j++) {
      const point = at(j).clone().add(new Vector3(0, 0, speed * j * dt));
      maxDrift = Math.max(maxDrift, Math.hypot(point.x - origin.x, point.z - origin.z));
    }
    intervals.push({ startSeconds: start * dt, endSeconds: end * dt, wrapsSeam: end >= points.length, seconds: (end - start) * dt, maxHorizontalDriftM: maxDrift });
  }
  return intervals;
}
function measureMovement(glb, name, feet) {
  const clip = glb.clips.get(name), speed = contract.clips.find(item => item.name === name)?.movementSpeed;
  assert(clip && clip.duration > 0 && Number.isFinite(speed) && speed > 0, `invalid locomotion clip/speed ${name}`);
  const n = Math.ceil(clip.duration * SAMPLE_HZ), dt = clip.duration / n;
  const poses = Array.from({ length: n + 1 }, (_, i) => glb.pose(clip, i * dt));
  const closure = poseDifference(poses[0], poses[n], glb, glb, contract.skeleton.joints);
  check(`${name}-loop-closure`, closure.position <= TOLERANCES.loopPositionM && closure.angle <= TOLERANCES.loopAngleDeg, `${closure.position} m, ${closure.angle}° at ${SAMPLE_HZ} Hz`);
  // A first/last 120Hz chord includes ordinary acceleration. Sample the actual exported interpolation close
  // to each boundary to distinguish that from a tangent mismatch, and retain the old chord diagnostic.
  const chord = velocitySeam(glb, poses[0], poses[1], poses[n - 1], poses[n], dt, contract.skeleton.joints);
  const boundaryEpsilon = Math.min(1e-5, clip.duration / 1000), fineEpsilon = boundaryEpsilon / 10;
  const boundary = velocitySeam(glb, poses[0], glb.pose(clip, boundaryEpsilon), glb.pose(clip, clip.duration - boundaryEpsilon), poses[n], boundaryEpsilon, contract.skeleton.joints);
  const fineBoundary = velocitySeam(glb, poses[0], glb.pose(clip, fineEpsilon), glb.pose(clip, clip.duration - fineEpsilon), poses[n], fineEpsilon, contract.skeleton.joints);
  const cubic = clip.tracks.some(track => track.interpolation === 'CUBICSPLINE');
  const extraTimes = new Set();
  if (cubic) {
    // Cover the spaces between dense keys too: key-only sole fitting cannot bound cubic overshoot.
    for (let i = 0; i < n; i++) extraTimes.add((i + 0.5) * dt);
    for (const track of clip.tracks.filter(track => track.interpolation === 'CUBICSPLINE')) {
      for (let i = 1; i < track.input.count; i++) extraTimes.add((track.input.values[i - 1] + track.input.values[i]) / 2);
    }
  }
  const extraPoses = [...extraTimes].toSorted((a, b) => a - b).map(time => glb.pose(clip, time));
  const hips = glb.byName.get(contract.skeleton.root), restHip = glb.pose(null, 0).positions[hips];
  const hipMax = Math.max(...[...poses, ...extraPoses].map(pose => Math.hypot(pose.positions[hips].x - restHip.x, pose.positions[hips].z - restHip.z)));
  check(`${name}-in-place`, hipMax <= TOLERANCES.hipsHorizontalExcursionM, `Hips horizontal displacement from bind pose ≤ ${hipMax} m`);
  const footReports = {};
  let penetration = Infinity;
  for (const side of ['Left', 'Right']) {
    const foot = feet[side];
    const heelPoints = [], ballPoints = [], toePoints = [], minY = [];
    for (const pose of poses) {
      const evaluated = foot.vertices.map(vertex => skinPoint(vertex, pose));
      minY.push(Math.min(...evaluated.map(point => point.y)));
      for (const [kind, target] of [['heel', heelPoints], ['ball', ballPoints], ['toe', toePoints]]) target.push(foot[kind].reduce((sum, vertex) => sum.add(skinPoint(vertex, pose)), new Vector3()).divideScalar(foot[kind].length || 1));
    }
    for (const pose of extraPoses) minY.push(Math.min(...foot.vertices.map(vertex => skinPoint(vertex, pose).y)));
    const markerDiagnostics = { heel: {}, ball: {}, toe: {} };
    const heelContacts = foot.heel.length ? inferContacts(heelPoints, dt, speed, markerDiagnostics.heel) : [];
    const ballContacts = foot.ball.length ? inferContacts(ballPoints, dt, speed, markerDiagnostics.ball) : [];
    const toeContacts = foot.toe.length ? inferContacts(toePoints, dt, speed, markerDiagnostics.toe) : [];
    const intervals = [...heelContacts, ...ballContacts, ...toeContacts];
    const minimumY = Math.min(...minY); penetration = Math.min(penetration, minimumY);
    const maxDrift = Math.max(0, ...intervals.map(interval => interval.maxHorizontalDriftM));
    footReports[side] = { shoeVertices: foot.vertices.length, soleVertices: foot.sole.length, heelMarkers: foot.heel.length, ballMarkers: foot.ball.length, toeMarkers: foot.toe.length,
      ballBindProjectionXZ: foot.ballBindProjectionXZ, ballMarkerHalfWidthM: BALL_MARKER_HALF_WIDTH_M, ballMarkerHalfLengthM: BALL_MARKER_HALF_LENGTH_M,
      markerDiagnostics,
      minimumShoeY: minimumY, maximumMinimumShoeY: Math.max(...minY), maxInferredContactDriftM: maxDrift,
      heelContacts, ballContacts, toeContacts, status: !intervals.length || minimumY < -TOLERANCES.shoePenetrationM || maxDrift > TOLERANCES.inferredContactDriftM ? 'RETHINK' : 'PASS',
    };
  }
  const quality = Object.values(footReports).every(foot => foot.status === 'PASS') && fineBoundary.linearVelocityMismatchMps <= TOLERANCES.seamLinearVelocityMps && fineBoundary.angularVelocityMismatchDegps <= TOLERANCES.seamAngularVelocityDegps ? 'PASS' : 'RETHINK';
  return { name, seconds: clip.duration, movementSpeedMps: speed, sampleHz: SAMPLE_HZ, samples: poses.length, exactSampleDt: dt,
    loopPositionErrorM: closure.position, loopAngleErrorDeg: closure.angle,
    seamLinearVelocityMismatchMps: fineBoundary.linearVelocityMismatchMps, seamLinearJoint: fineBoundary.linearJoint,
    seamAngularVelocityMismatchDegps: fineBoundary.angularVelocityMismatchDegps, seamAngularJoint: fineBoundary.angularJoint,
    seamBoundaryDerivative: { method: 'one-sided derivatives of actual exported interpolation; 1 microsecond is authoritative, 10 microseconds checks convergence',
      epsilonSeconds: boundaryEpsilon, coarse: boundary, fineEpsilonSeconds: fineEpsilon, fine: fineBoundary,
      linearConvergenceDeltaMps: Math.abs(boundary.linearVelocityMismatchMps - fineBoundary.linearVelocityMismatchMps),
      angularConvergenceDeltaDegps: Math.abs(boundary.angularVelocityMismatchDegps - fineBoundary.angularVelocityMismatchDegps) },
    seam120HzChord: { ...chord, sampleDtSeconds: dt, meaning: 'first/last chord-average velocity difference includes ordinary seam acceleration; diagnostic only' },
    shoeHeightSampling: { approximateHz: cubic ? 240 : SAMPLE_HZ, baseSamples: poses.length, extraInterKeySamples: extraPoses.length, actualCubicKeyMidpointsIncluded: cubic, contactSampleHz: SAMPLE_HZ },
    hipsHorizontalMaxFromBindM: hipMax, footQuality: quality, feet: footReports,
    samplesSummary: poses.map((pose, i) => ({ t: rounded(i * dt), hips: pose.positions[hips].toArray().map(rounded),
      leftFoot: pose.positions[glb.byName.get('LeftFoot')].toArray().map(rounded), rightFoot: pose.positions[glb.byName.get('RightFoot')].toArray().map(rounded) })),
  };
}

let report;
try {
  const measurementValidation = validateBoundaryMeasurement();
  const before = loadGlb(values.before), after = loadGlb(values.after);
  for (const glb of [before, after]) {
    // Decode every accessor so hidden malformed/nonfinite attributes cannot pass an untouched-pose comparison.
    for (let i = 0; i < (glb.json.accessors?.length ?? 0); i++) glb.accessor(i);
  }
  const rest = compareRest(before, after), geometry = compareGeometry(before, after), unchangedClips = compareOtherClips(before, after);
  const feet = footVertices(after);
  const movement = [...MOVEMENT].map(name => measureMovement(after, name, feet));
  const regressionStatus = checks.every(item => item.pass) ? 'PASS' : 'FAIL';
  const footQuality = movement.every(clip => clip.footQuality === 'PASS') ? 'PASS' : 'RETHINK';
  let provenance = null;
  if (values.provenance) {
    const bytes = readFileSync(values.provenance);
    provenance = { path: path.resolve(values.provenance), sha256: hash(bytes), contents: JSON.parse(bytes.toString('utf8')) };
  }
  report = { status: regressionStatus === 'FAIL' ? 'FAIL' : footQuality, regressionStatus, footQuality,
    checkedAt: new Date().toISOString(), sampleHz: SAMPLE_HZ, tolerances: TOLERANCES, measurementValidation,
    before: { path: path.resolve(values.before), bytes: before.bytes.length, sha256: before.sha256, asset: before.json.asset },
    after: { path: path.resolve(values.after), bytes: after.bytes.length, sha256: after.sha256, asset: after.json.asset },
    contract: { path: path.resolve(values.contract), sha256: hash(contractBytes) }, provenance,
    methodology: {
      decoder: 'Independent GLB 2 parser; embedded uncompressed buffer/accessors, component types, offsets, strides, normalized integers, sparse replacements and matrix column padding. FK uses the game-pinned Three math. Animation supports LINEAR quaternion slerp, STEP and normalized component Hermite CUBICSPLINE.',
      regression: 'Geometry attributes/indices decoded numerically; skin influences compared by joint name and weight; embedded image bytes hashed; material texture references resolved semantically. All named nodes/parent/rest-world matrices and inverse binds compared. Seven nonlocomotion clips compared at every key time and 120Hz world poses/matrices.',
      footDetection: 'Shoe candidates have ≥0.5 summed influence from the side Foot/ToeBase and bind-world Y≤0.12 m. Sole vertices lie within 0.01 m of each foot minimum; rear/front 20% form fixed heel/distal-toe markers. A third ball marker family contains sole vertices in a fixed band centered on bind ToeBase projection: ±0.025 m fore/aft and ±0.06 m lateral, following the declared +Z-forward axes. This 5 cm metatarsal band spans the shoe width so a coarse sole represented by perimeter vertices still has samples beneath the ball pivot; an interior circular patch need not contain any mesh vertices. All three families are reported, and maximum drift includes every detected family. Actual vertices are skinned by jointWorld × inverseBind. Contact intervals are inferred where marker |Y|≤0.025 m and |vertical speed|≤0.25 m/s for ≥0.08 s, without using horizontal speed. Horizontal drift adds +Z × contract movementSpeed × time. Floor is the explicit flat Y=0 test surface.',
      boundaryVelocity: 'Authoritative seam velocity uses one-sided derivatives of the actual exported interpolation at1microsecond with10microsecond convergence comparison. The previous120Hz first/last chord differences remain under seam120HzChord because ordinary acceleration contaminates them. The0.5m/s and180deg/s thresholds are unchanged. Known smooth-cosine and genuine triangle-kink curves independently validate this distinction in measurementValidation.',
      interKeyShoes: 'Cubic clips also skin shoes on an approximately240Hz grid and at every cubic-key midpoint; minimum sole height includes these samples so120Hz keyed floor fits cannot hide cubic overshoot. Contact intervals continue using the same120Hz samples and thresholds.',
      limits: 'Automatically inferred contacts are not authored contact annotations; zero detected intervals means RETHINK. Marker centroids can miss local sole detail, so minimum height uses all selected shoe vertices. Adding a ball family addresses forefoot support coverage without changing any height, velocity, duration, drift or penetration tolerance. This does not verify terrain contact, runtime blending, turn behavior, appearance, or licensor provenance beyond supplied asset metadata/provenance. Boundary derivative measurements do not prove continuous acceleration, and finite inter-key sampling is not an analytic bound on cubic extrema.',
    }, checks, rest, geometry, unchangedClips, movement,
  };
} catch (error) {
  report = { status: 'FAIL', checkedAt: new Date().toISOString(), error: error instanceof Error ? error.stack : String(error), checks, tolerances: TOLERANCES };
}
writeFileSync(path.join(values.out, 'character-motion.json'), JSON.stringify(report, (_key, value) => typeof value === 'number' && !Number.isFinite(value) ? String(value) : value, 1) + '\n');
console.log(`${report.status}: regression ${report.regressionStatus ?? 'FAIL'}, foot quality ${report.footQuality ?? 'UNMEASURED'}; ${values.out}`);
process.exitCode = report.status === 'FAIL' ? 1 : report.status === 'RETHINK' ? 2 : 0;
