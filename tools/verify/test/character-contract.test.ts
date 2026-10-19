import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Document } from '@gltf-transform/core';
import { checkCharacter, imageDimensions, skinnedBounds, type CharacterContract } from '../lib/character-contract.ts';

const contract: CharacterContract = {
  fps: 30, feetAtOrigin: true, heightMeters: { min: 1.7, max: 1.9 },
  skeleton: { root: 'root', joints: ['root', 'hand'], parents: { hand: 'root' }, maxJoints: 2, maxInfluencesPerVertex: 4 },
  sockets: [{ node: 'socket', parentJoint: 'hand' }], clips: [{ name: 'idle', seconds: 2, movementSpeed: 0 }],
  clipDurationToleranceSeconds: .001,
  budgets: { player: { triangles: 10, materials: 1, fileBytes: 100000, textureMaxSize: 1024, textureMaxSizeByUsage: { baseColor: 1024, other: 512 } } },
};

function fixture() {
  const document = new Document(), scene = document.createScene(), buffer = document.createBuffer();
  document.getRoot().setDefaultScene(scene);
  const root = document.createNode('root'), hand = document.createNode('hand'), socket = document.createNode('socket');
  scene.addChild(root); root.addChild(hand); hand.addChild(socket);
  const skin = document.createSkin().addJoint(root).addJoint(hand);
  const accessor = (type: 'VEC3' | 'VEC4' | 'SCALAR', array: Float32Array<ArrayBuffer> | Uint16Array<ArrayBuffer>) => document.createAccessor().setBuffer(buffer).setType(type).setArray(array);
  const addMesh = (name: string, positions: number[]) => {
    const count = positions.length / 3;
    const primitive = document.createPrimitive().setAttribute('POSITION', accessor('VEC3', new Float32Array(positions)))
      .setAttribute('JOINTS_0', accessor('VEC4', new Uint16Array(count * 4)))
      .setAttribute('WEIGHTS_0', accessor('VEC4', new Float32Array(Array.from({ length: count * 4 }, (_, i) => i % 4 === 0 ? 1 : 0))));
    const node = document.createNode(name).setMesh(document.createMesh().addPrimitive(primitive)).setSkin(skin);
    scene.addChild(node); return { node, primitive };
  };
  const body = addMesh('body', [-.1, .7, 0, .1, .7, 0, 0, 1.5, 0]);
  const shoes = addMesh('shoes', [-.1, 0, 0, .1, 0, 0, 0, .1, 0]);
  const hair = addMesh('hair', [-.1, 1.7, 0, .1, 1.7, 0, 0, 1.8, 0]);
  const input = accessor('SCALAR', new Float32Array([0, 2]));
  const output = accessor('VEC3', new Float32Array(6));
  const sampler = document.createAnimationSampler().setInput(input).setOutput(output);
  document.createAnimation('idle').addSampler(sampler).addChannel(document.createAnimationChannel().setSampler(sampler).setTargetNode(root).setTargetPath('translation'));
  return { document, scene, root, hand, socket, body, shoes, hair, input, accessor };
}

test('height uses actual positions from every skinned mesh and all transform corners', async () => {
  const f = fixture();
  const bounds = skinnedBounds(f.document);
  assert.equal(bounds.meshes, 3); assert.equal(bounds.min[1], 0); assert.ok(Math.abs(bounds.max[1]! - 1.8) < 1e-6);
  assert.ok((await checkCharacter(f.document, contract, 'player', 500)).every(check => check.pass));
  // The body alone still satisfies the old first-mesh bounds, but a late hair node becomes oversized.
  f.hair.node.setTranslation([0, 1, 0]);
  assert.equal((await checkCharacter(f.document, contract, 'player', 500)).find(c => c.id === 'height')?.pass, false);
  f.hair.node.setTranslation([0, 0, 0]);
  f.body.primitive.getAttribute('POSITION')!.setArray(new Float32Array([-2, 2, 0, 2, -2, 0, 2, 2, 0]));
  f.body.node.setRotation([0, 0, Math.sin(Math.PI / 8), Math.cos(Math.PI / 8)]);
  assert.ok(skinnedBounds(f.document).max[1]! > 2.8); // Transforming only min and max misses this vertex.
});

test('direct joint/socket parents are checked independently from name presence', async () => {
  const f = fixture(); f.scene.addChild(f.hand); f.root.addChild(f.socket);
  const result = await checkCharacter(f.document, contract, 'player', 500);
  assert.equal(result.find(c => c.id === 'skeleton')?.pass, true);
  assert.equal(result.find(c => c.id === 'joint-parents')?.pass, false);
  assert.equal(result.find(c => c.id === 'socket')?.pass, false);
});

test('second weight sets cannot hide a fifth influence or non-unit weights', async () => {
  const f = fixture(), p = f.body.primitive;
  p.getAttribute('WEIGHTS_0')!.setArray(new Float32Array([.2,.2,.2,.2, 1,0,0,0, 1,0,0,0]));
  p.setAttribute('JOINTS_1', f.accessor('VEC4', new Uint16Array(12)));
  p.setAttribute('WEIGHTS_1', f.accessor('VEC4', new Float32Array([.2,0,0,0, 0,0,0,0, 0,0,0,0])));
  let result = await checkCharacter(f.document, contract, 'player', 500);
  assert.equal(result.find(c => c.id === 'skin-weights')?.pass, false);
  p.getAttribute('WEIGHTS_1')!.setArray(new Float32Array(12));
  result = await checkCharacter(f.document, contract, 'player', 500);
  assert.equal(result.find(c => c.id === 'skin-weights')?.pass, false);
});

test('clip names alone do not accept a truncated duration', async () => {
  const f = fixture(); f.input.setArray(new Float32Array([0, 1.5]));
  const result = await checkCharacter(f.document, contract, 'player', 500);
  assert.equal(result.find(c => c.id === 'clips')?.pass, true);
  assert.equal(result.find(c => c.id === 'clip-duration:idle')?.pass, false);
});

function ktx(width: number, height: number) {
  const data = new Uint8Array(80); data.set([0xab,0x4b,0x54,0x58,0x20,0x32,0x30,0xbb,0x0d,0x0a,0x1a,0x0a]);
  const header = new DataView(data.buffer); header.setUint32(20,width,true); header.setUint32(24,height,true); header.setUint32(36,1,true);
  return data;
}

test('KTX2 header dimensions enforce distinct base-color and linear-map budgets', async () => {
  assert.deepEqual(await imageDimensions(ktx(1024,512)), { width:1024, height:512, format:'ktx2' });
  await assert.rejects(imageDimensions(ktx(1024,512).slice(0,50)), /Truncated/);
  const f = fixture(), texture = f.document.createTexture().setImage(ktx(1024,1024)).setMimeType('image/ktx2');
  const material = f.document.createMaterial().setBaseColorTexture(texture); f.body.primitive.setMaterial(material);
  assert.equal((await checkCharacter(f.document, contract, 'player', 500)).find(c => c.id === 'texture:0')?.pass, true);
  material.setNormalTexture(texture);
  assert.equal((await checkCharacter(f.document, contract, 'player', 500)).find(c => c.id === 'texture:0')?.pass, false);
});

test('native Finn and Rain contracts resolve separately without changing legacy authoring budgets', () => {
  const shared = JSON.parse(readFileSync('content/assets/character.contract.json','utf8')) as CharacterContract;
  assert.equal(shared.skeleton.joints.length, 22); assert.equal(shared.skeleton.maxJoints, 64);
  assert.equal(shared.budgets.npc?.triangles, 14000); assert.equal(shared.budgets.npc?.materials, 4); assert.equal(shared.budgets.npc?.textureMaxSize, 512);
  assert.equal(shared.variants?.find(v => v.id === 'character-rain')?.contract, 'content/assets/character-rain-native.contract.json');
  assert.equal(shared.variants?.find(v => v.id === 'character-snow')?.contract, 'content/assets/character-finn.contract.json');
  const finn = JSON.parse(readFileSync('content/assets/character-finn.contract.json','utf8')) as CharacterContract;
  assert.equal(finn.skeleton.joints.length, 71); assert.equal(finn.clips.length,17);
  const rain = JSON.parse(readFileSync('content/assets/character-rain-native.contract.json','utf8')) as CharacterContract;
  assert.equal(rain.skeleton.joints.length, 70); assert.equal(rain.clips.length,17);
  assert.ok(rain.skeleton.joints.includes('DEF-Pelvis'));
  assert.ok(!finn.skeleton.joints.includes('DEF-Pelvis'));
});
