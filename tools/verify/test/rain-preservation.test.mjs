import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseGlb } from '../glb.ts';
import { verifyNativeRainData } from '../verify-rain-preservation.mjs';

const source = readFileSync('data/raw/rain-native-20261017/rain.glb');
const original = parseGlb(source), sourceJson = original.json;
const json = structuredClone(sourceJson);
for (const name of ['aim', 'fire', 'hit', 'death', 'drive', 'arrested']) json.animations.push({ ...structuredClone(sourceJson.animations[0]), name });
for (const [name, parent] of [['SOCKET_HAND_R', 'DEF-Hand.R'], ['SOCKET_HEAD', 'DEF-Head']]) {
  const index = json.nodes.length;
  json.nodes.push({ name, translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
  (json.nodes.find(node => node.name === parent).children ??= []).push(index);
}
for (const scene of json.scenes) scene.extras = { characterProfile: { id: 'rain-native-v1', upperBodyRoot: 'DEF-Spine1', phaseGroup: 'left-strike' } };
function pack(document, bin = original.bin) {
  const align = n => (n + 3) & ~3, text = Buffer.from(JSON.stringify(document)), length = align(text.length);
  const result = Buffer.alloc(28 + length + align(bin.length));
  result.writeUInt32LE(0x46546c67, 0); result.writeUInt32LE(2, 4); result.writeUInt32LE(result.length, 8);
  result.writeUInt32LE(length, 12); result.writeUInt32LE(0x4e4f534a, 16); result.fill(0x20, 20, 20 + length); text.copy(result, 20);
  result.writeUInt32LE(align(bin.length), 20 + length); result.writeUInt32LE(0x004e4942, 24 + length); Buffer.from(bin).copy(result, 28 + length);
  return result;
}
const valid = pack(json);

test('Rain preservation permits only the declared gameplay additions without a mesh or motion exception', () => {
  const result = verifyNativeRainData(source, valid);
  assert.equal(result.nativeJoints, 70); assert.equal(result.sourceNodes, 87);
  assert.equal(result.byteExactNonImageBufferViews, 2436);
  assert.equal(result.originalAccessors, 2436);
  assert.equal(result.nativeClips.length, 11); assert.equal(result.appendedClips.length, 6);
  assert.deepEqual(result.approvedGeometrySkinMotionExceptions, []);
});

test('one changed attribute, skin tuple, index, inverse bind or original animation sample is rejected', () => {
  const attributes = new Map();
  for (const mesh of sourceJson.meshes) for (const primitive of mesh.primitives) {
    for (const [name, index] of Object.entries(primitive.attributes)) if (!attributes.has(name)) attributes.set(name, index);
    if (primitive.indices !== undefined && !attributes.has('indices')) attributes.set('indices', primitive.indices);
  }
  attributes.set('inverse-bind', sourceJson.skins[0].inverseBindMatrices);
  attributes.set('native-time', sourceJson.animations[0].samplers[0].input);
  attributes.set('native-pose', sourceJson.animations[0].samplers[0].output);
  assert.ok(attributes.has('JOINTS_0') && attributes.has('WEIGHTS_0') && attributes.has('POSITION') && attributes.has('NORMAL') && attributes.has('TEXCOORD_0'));
  for (const [name, index] of attributes) {
    const bin = Buffer.from(original.bin), accessor = sourceJson.accessors[index], view = sourceJson.bufferViews[accessor.bufferView];
    bin[(view.byteOffset ?? 0) + (accessor.byteOffset ?? 0)] ^= 1;
    assert.throws(() => verifyNativeRainData(source, pack(json, bin)), /bytes changed; no geometry\/skin\/motion exceptions/, name);
  }
});

test('unchanged binary payloads cannot conceal changed rest, mesh, material or animation declarations', () => {
  for (const edit of [
    j => { j.meshes[0].primitives[0].material = (j.meshes[0].primitives[0].material + 1) % j.materials.length; },
    j => { j.nodes[0].translation = [20, 0, 0]; },
    j => { j.materials[0].doubleSided = !j.materials[0].doubleSided; },
    j => { j.animations[0].samplers[0].interpolation = 'STEP'; },
    j => { j.skins[0].joints.reverse(); },
    j => { j.accessors[0].normalized = true; },
    j => { j.bufferViews[0].byteStride = 32; },
    j => { j.scenes[0].nodes = []; },
  ]) {
    const changed = structuredClone(json); edit(changed);
    assert.throws(() => verifyNativeRainData(source, pack(changed)));
  }
});

test('source identity is pinned and supplemental sockets cannot smuggle altered geometry or hierarchy', () => {
  const wrongSource = Buffer.from(source); wrongSource[wrongSource.length - 1] ^= 1;
  assert.throws(() => verifyNativeRainData(wrongSource, valid), /Unexpected supplied Rain source/);
  for (const edit of [
    j => { j.nodes[sourceJson.nodes.length].mesh = 0; },
    j => { j.nodes[sourceJson.nodes.length].scale = [2, 2, 2]; },
    j => { j.nodes[0].children ??= []; j.nodes[0].children.push(sourceJson.nodes.length); },
    j => { j.nodes.push({ name: 'unapproved_skin_repair', mesh: 0 }); },
    j => { j.animations.push({ ...j.animations[0], name: 'unapproved_native_replacement' }); },
  ]) {
    const changed = structuredClone(json); edit(changed);
    assert.throws(() => verifyNativeRainData(source, pack(changed)));
  }
});

test('texture re-encoding cannot swap original material images or texture samplers', () => {
  for (const edit of [
    j => { j.textures[0].extensions.EXT_texture_webp.source = 1; },
    j => { j.images[0].bufferView = j.images[1].bufferView; },
    j => { j.samplers[0].wrapS = 33071; },
  ]) {
    const changed = structuredClone(json); edit(changed);
    assert.throws(() => verifyNativeRainData(source, pack(changed)));
  }
});
