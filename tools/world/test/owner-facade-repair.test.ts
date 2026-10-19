import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Document, NodeIO } from '@gltf-transform/core';
import { cloneFacadeCandidate, facadeAtlasCacheKey, facadeImageBinding, facadeSha, matchOwnerFacade, proveFacadeIndexPreservation, proveSelectedPixelChanges, replaceBoundOwnerImages, verifyFacadeSourceCorners } from '../lib/owner-facade-repair.ts';
import { readFacadeGlb } from '../lib/facade-glb.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
function fixture(merged = false, drift = 0) {
  const doc = new Document(), buffer = doc.createBuffer(), scene = doc.createScene();
  const add = (name: string, x: number, colour: number) => {
    const image = Uint8Array.from(png); image[40] = colour;
    const texture = doc.createTexture('c_m12_p01_facades_0').setImage(image).setMimeType('image/png');
    const material = doc.createMaterial().setBaseColorTexture(texture);
    const positions = doc.createAccessor().setType('VEC3').setArray(new Float32Array([x, 0, 0, x + 1, 0, 0, x, 1, 0])).setBuffer(buffer);
    const uv = doc.createAccessor().setType('VEC2').setArray(new Float32Array([.125, .125, .625, .125, .125, .625])).setBuffer(buffer);
    const indices = doc.createAccessor().setType('SCALAR').setArray(new Uint32Array([0, 1, 2])).setBuffer(buffer);
    const mesh = doc.createMesh().addPrimitive(doc.createPrimitive().setAttribute('POSITION', positions).setAttribute('TEXCOORD_0', uv).setIndices(indices).setMaterial(material));
    scene.addChild(doc.createNode(name).setMesh(mesh));
  };
  if (merged) add('c_m12_p01_facades_0', 10, 1);
  add(merged ? 'append:c_m12_p01_facades_0' : 'c_m12_p01_facades_0', drift, 2);
  return doc;
}

test('numeric owner mapping selects the appended image despite duplicate atlas names; unrelated bytes and JSON remain exact', async () => {
  const io = new NodeIO(), owner = fixture(), final = fixture(true), a = await io.writeBinary(owner), b = await io.writeBinary(final);
  const ownerImage = facadeImageBinding(a, 'c_m12_p01_facades_0');
  const match = matchOwnerFacade(a, owner, b, final, 'c_m12_p01_facades_0', ownerImage.sha256);
  assert.equal(match.finalBinding.imageIndex, 1); assert.equal(match.finalBinding.nodeName, 'append:c_m12_p01_facades_0');
  const oldUnrelated = facadeImageBinding(b, 'c_m12_p01_facades_0'), replacement = Buffer.concat([ownerImage.bytes, Buffer.from([1, 2, 3, 4])]);
  const repaired = replaceBoundOwnerImages(b, [{ binding: match.finalBinding, originalEncoded: ownerImage.bytes, replacement }]);
  assert.deepEqual(facadeImageBinding(repaired, 'c_m12_p01_facades_0').bytes, oldUnrelated.bytes);
  assert.deepEqual(facadeImageBinding(repaired, 'append:c_m12_p01_facades_0').bytes, replacement);
  const before = readFacadeGlb(b), after = readFacadeGlb(repaired);
  for (const key of ['nodes', 'meshes', 'materials', 'textures', 'accessors', 'scenes']) assert.deepEqual(after.json[key], before.json[key]);
  assert.throws(() => replaceBoundOwnerImages(b, [{ binding: match.finalBinding, originalEncoded: oldUnrelated.bytes, replacement }]), /negative control/);
});

test('owner image hash or actual geometry mismatch fails before replacement', async () => {
  const io = new NodeIO(), owner = fixture(), changed = fixture(true, .125), a = await io.writeBinary(owner), b = await io.writeBinary(changed);
  const image = facadeImageBinding(a, 'c_m12_p01_facades_0');
  assert.throws(() => matchOwnerFacade(a, owner, b, changed, 'c_m12_p01_facades_0', '0'.repeat(64)), /pinned owner image/);
  assert.throws(() => matchOwnerFacade(a, owner, b, changed, 'c_m12_p01_facades_0', image.sha256), /correspondence must be unique/);
});

test('source position/UV correspondence rejects a shifted atlas layout even with the same source page', () => {
  const node = fixture().getRoot().listNodes()[0]!, part = { texture: 5, positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), uvs: new Float32Array([0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]) };
  const placements = new Map([['t5', { atlas: 0, x: 16, y: 16, w: 64, h: 64 }]]);
  assert.equal(verifyFacadeSourceCorners(node, [part], placements, 0, [128, 128]).corners, 3);
  assert.throws(() => verifyFacadeSourceCorners(node, [part], new Map([['t5', { ...placements.get('t5')!, x: 20 }]]), 0, [128, 128]), /corner\/UV mismatch/);
});

test('pixel proof rejects any unselected RGB or alpha change and records only actual changed texels', () => {
  const before = { width: 8, height: 8, data: new Uint8Array(8 * 8 * 4).fill(255) }, after = { ...before, data: Uint8Array.from(before.data) };
  after.data[(3 * 8 + 2) * 4] = 0;
  assert.deepEqual(proveSelectedPixelChanges(before, after, [[2, 3, 3, 4]]).bounds, [2, 3, 3, 4]);
  assert.throws(() => proveSelectedPixelChanges(before, after, [[0, 0, 2, 3]]), /outside selected/);
  after.data[(3 * 8 + 2) * 4 + 3] = 0;
  assert.throws(() => proveSelectedPixelChanges(before, after, [[2, 3, 3, 4]]), /alpha changed/);
});

test('atlas cache identity binds dimensions, actual RGBA and encoder version', () => {
  const image = { width: 2, height: 2, data: new Uint8Array(16) }, key = facadeAtlasCacheKey(image, 'encoder1');
  assert.notEqual(key, facadeAtlasCacheKey({ ...image, width: 1, height: 4 }, 'encoder1'));
  assert.notEqual(key, facadeAtlasCacheKey(image, 'encoder2'));
  const changed = Uint8Array.from(image.data); changed[0] = 1;
  assert.notEqual(key, facadeAtlasCacheKey({ ...image, data: changed }, 'encoder1'));
});

test('index proof rejects dropped distant tiers or changed collision metadata, allowing only selected LOD0 bytes/hash', () => {
  const original = { originId: 'frozen', cells: [{ id: 'a', visual: { lod0: { bytes: 10, sha256: 'old', path: 'a.glb', triangles: 10 }, lod1: { sha256: 'low' }, lod2: { sha256: 'distant' } }, collision: { sha256: 'hcol' } }] };
  const candidate: any = structuredClone(original); candidate.cells[0].visual.lod0.bytes = 12; candidate.cells[0].visual.lod0.sha256 = 'new';
  assert.equal(proveFacadeIndexPreservation(original, candidate, new Set(['a'])).protectedIndexSemanticsExact, true);
  const missingTier = structuredClone(candidate); delete missingTier.cells[0].visual.lod2;
  assert.throws(() => proveFacadeIndexPreservation(original, missingTier, new Set(['a'])), /protected index/);
  const wrongCollision = structuredClone(candidate); wrongCollision.cells[0].collision.sha256 = 'changed';
  assert.throws(() => proveFacadeIndexPreservation(original, wrongCollision, new Set(['a'])), /protected index/);
});

test('fresh candidate changes only selected LOD0/index/report while LOD1/2, HCOL, terrain and scenery stay byte exact', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-facade-')), base = path.join(root, 'base'), out = path.join(root, 'out');
  try {
    fs.mkdirSync(path.join(base, 'cells'), { recursive: true });
    for (const file of ['cells/c0.glb', 'cells/c0.lod1.glb', 'cells/c0.lod2.glb', 'cells/c0.hcol', 'runtime-terrain.bin', 'scenery.json', 'cells.json', 'report.json']) fs.writeFileSync(path.join(base, file), `frozen ${file}`);
    const newGlb = Buffer.from('new facade image only'), inventory = cloneFacadeCandidate(base, out, new Map([['cells/c0.glb', newGlb], ['cells.json', Buffer.from('new index')], ['report.json', Buffer.from('new report')]]));
    assert.equal(inventory.filter(i => !i.byteExact).length, 3);
    assert.equal(fs.readFileSync(path.join(base, 'cells/c0.glb'), 'utf8'), 'frozen cells/c0.glb');
    for (const file of ['cells/c0.lod1.glb', 'cells/c0.lod2.glb', 'cells/c0.hcol', 'runtime-terrain.bin', 'scenery.json']) assert.equal(facadeSha(fs.readFileSync(path.join(out, file))), facadeSha(fs.readFileSync(path.join(base, file))));
    assert.throws(() => cloneFacadeCandidate(base, out, new Map()), /fresh/);
    assert.throws(() => cloneFacadeCandidate(base, path.join(root, 'escaped'), new Map([['../outside', newGlb]])), /escapes source/);
  } finally { fs.rmSync(root, { recursive: true }); }
});
