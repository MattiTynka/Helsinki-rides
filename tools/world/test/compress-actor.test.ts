import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Document, NodeIO} from '@gltf-transform/core';
import {ALL_EXTENSIONS} from '@gltf-transform/extensions';
import {MeshoptDecoder} from 'meshoptimizer';
import {compressActor} from '../lib/compress-actor.ts';
import {readFacadeGlb} from '../lib/facade-glb.ts';

async function fixture() {
  const doc = new Document(), buffer = doc.createBuffer('source-actor');
  const accessor = (name: string, type: 'SCALAR' | 'VEC2' | 'VEC3' | 'VEC4' | 'MAT4', array: Float32Array<ArrayBuffer> | Uint16Array<ArrayBuffer> | Uint8Array<ArrayBuffer>) => doc.createAccessor(name).setBuffer(buffer).setType(type).setArray(array);
  const positions = new Float32Array(900), normals = new Float32Array(900), joints = new Uint8Array(1200), weights = new Float32Array(1200);
  for (let i = 0; i < 300; i++) {positions.set([i % 3, 0, i % 2], i * 3); normals.set([0, 1, 0], i * 3); weights[i * 4] = 1;}
  positions[0] = -0; // Lossless must preserve float bit patterns, including signed zero.
  const primitive = doc.createPrimitive().setAttribute('POSITION', accessor('body_position', 'VEC3', positions))
    .setAttribute('NORMAL', accessor('body_normal', 'VEC3', normals))
    .setAttribute('TEXCOORD_0', accessor('body_uv', 'VEC2', new Float32Array(600)))
    .setAttribute('JOINTS_0', accessor('body_joints', 'VEC4', joints))
    .setAttribute('WEIGHTS_0', accessor('body_weights', 'VEC4', weights))
    .setIndices(accessor('body_indices', 'SCALAR', Uint16Array.from({length: 3000}, (_, i) => i % 300)));
  const image = doc.createTexture('accepted_texture').setMimeType('image/png').setImage(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1ioAAAAASUVORK5CYII=', 'base64'));
  primitive.setMaterial(doc.createMaterial('accepted_material').setBaseColorTexture(image).setExtras({source: 'accepted texture'}));
  const mesh = doc.createMesh('accepted_body').addPrimitive(primitive).setExtras({profileHash: 'accepted-profile'});
  const root = doc.createNode('rig_root'), socket = doc.createNode('driver_hand_socket').setExtras({seatPose: 'unchanged'}); root.addChild(socket);
  const ibm = accessor('bind_pose', 'MAT4', new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]));
  const skin = doc.createSkin('accepted_rig').setSkeleton(root).addJoint(root).setInverseBindMatrices(ibm);
  const body = doc.createNode('Snow').setMesh(mesh).setSkin(skin);
  doc.createScene('game').addChild(root).addChild(body);
  doc.getRoot().setExtras({source: 'CC BY 4.0', motionProfile: {boneNames: ['rig_root'], socket: 'driver_hand_socket'}});
  for (const name of ['idle', 'run', 'jump', 'car_entry']) {
    const times = Float32Array.from({length: 120}, (_, i) => i / 60), rotations = new Float32Array(480);
    for (let i = 0; i < 120; i++) rotations.set([0, Math.sin(i / 200), 0, Math.cos(i / 200)], i * 4);
    const sampler = doc.createAnimationSampler().setInput(accessor(`${name}_time`, 'SCALAR', times)).setOutput(accessor(`${name}_rotation`, 'VEC4', rotations)).setInterpolation('LINEAR');
    const channel = doc.createAnimationChannel().setTargetNode(root).setTargetPath('rotation').setSampler(sampler);
    doc.createAnimation(name).addSampler(sampler).addChannel(channel).setExtras({rootMotion: false, sourceClip: name});
  }
  return new NodeIO().writeBinary(doc);
}
async function io() {
  await MeshoptDecoder.ready;
  return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.decoder': MeshoptDecoder});
}
function rawArray(array: NonNullable<ReturnType<ReturnType<Document['createAccessor']>['getArray']>>) {
  return Buffer.from(array.buffer, array.byteOffset, array.byteLength);
}

test('actor Meshopt compression retains every decoded accessor bit, hierarchy, skin, clip and source binding', async () => {
  const source = await fixture(), snapshot = source.slice(), result = await compressActor(source);
  assert.equal(result.receipt.applied, true);
  assert.ok(result.receipt.savedBytes > 0 && result.bytes.length < source.length);
  assert.ok(result.receipt.compressedViews > 0);
  assert.equal(result.receipt.images.length, 1); assert.match(result.receipt.images[0]!.sha256!, /^[a-f0-9]{64}$/);
  assert.equal(result.receipt.animationCount, 4); assert.equal(result.receipt.skinCount, 1);
  assert.deepEqual(source, snapshot, 'Source GLB may never be mutated');
  const reader = await io(), a = await reader.readBinary(source), b = await reader.readBinary(result.bytes);
  assert.deepEqual(b.getRoot().listTextures()[0]!.getImage(), a.getRoot().listTextures()[0]!.getImage());
  assert.equal(b.getRoot().listAccessors().length, a.getRoot().listAccessors().length);
  for (const [i, accessor] of a.getRoot().listAccessors().entries()) {
    const after = b.getRoot().listAccessors()[i]!;
    assert.equal(after.getName(), accessor.getName()); assert.equal(after.getType(), accessor.getType());
    assert.equal(after.getComponentType(), accessor.getComponentType()); assert.equal(after.getNormalized(), accessor.getNormalized());
    assert.deepEqual(rawArray(after.getArray()!), rawArray(accessor.getArray()!), `Accessor ${accessor.getName()} float/integer bits must stay exact`);
  }
  const before = readFacadeGlb(source).json as any, after = readFacadeGlb(result.bytes).json as any;
  for (const key of ['asset', 'accessors', 'nodes', 'scenes', 'scene', 'skins', 'animations', 'meshes', 'materials', 'textures', 'samplers', 'extras']) assert.deepEqual(after[key], before[key], `${key} changed`);
  assert.equal(after.nodes.find((n: any) => n.name === 'driver_hand_socket').extras.seatPose, 'unchanged');
  assert.ok(after.bufferViews.filter((view: any) => view.extensions?.EXT_meshopt_compression).every((view: any) => !view.extensions.EXT_meshopt_compression.filter));
  const validator = await import('gltf-validator'), report = await validator.validateBytes(result.bytes);
  assert.equal(report.issues.numErrors, 0, JSON.stringify(report.issues.messages));
});

test('already compressed actors remain byte exact and incompressible tiny sources are retained', async () => {
  const source = await fixture(), compressed = await compressActor(source), repeated = await compressActor(compressed.bytes);
  assert.equal(repeated.receipt.applied, false); assert.equal(repeated.receipt.reason, 'already-compressed');
  assert.deepEqual(repeated.bytes, compressed.bytes); assert.notEqual(repeated.bytes, compressed.bytes);
  const doc = new Document(), buffer = doc.createBuffer();
  const positions = doc.createAccessor().setBuffer(buffer).setType('VEC3').setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]));
  const mesh = doc.createMesh().addPrimitive(doc.createPrimitive().setAttribute('POSITION', positions));
  doc.createScene().addChild(doc.createNode().setMesh(mesh));
  const tiny = await new NodeIO().writeBinary(doc), result = await compressActor(tiny);
  assert.equal(result.receipt.reason, 'no-smaller-representation'); assert.equal(result.receipt.savedBytes, 0); assert.deepEqual(result.bytes, tiny);
});
