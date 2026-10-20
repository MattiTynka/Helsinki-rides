import assert from 'node:assert/strict';
import test from 'node:test';
import {appendEntranceGlb, entranceTextures} from '../lib/senate-entrance-glb.ts';
import {packGlb} from '../lib/shared-textures.ts';
import {readFacadeGlb} from '../lib/facade-glb.ts';
import {entranceBox} from '../lib/senate-entrances.ts';

test('Original stone textures are deterministic PNGs with no reused photographic imagery', async () => {
  const a = await entranceTextures(), b = await entranceTextures();
  assert.equal(a.length, 2); assert.notEqual(a[0]!.sha256, a[1]!.sha256);
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(a[i], b[i]);
    assert.deepEqual(Array.from(a[i]!.bytes.subarray(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.match(a[i]!.path, /^textures\/[a-f0-9]{64}\.png$/);
  }
});
test('Entrance materials and face normals append without changing any original GLB resources or BIN bytes', async () => {
  const json = {asset: {version: '2.0'}, buffers: [{byteLength: 36}], bufferViews: [{buffer: 0, byteOffset: 0, byteLength: 36, target: 34962}], accessors: [{bufferView: 0, componentType: 5126, type: 'VEC3', count: 3, min: [0, 0, 0], max: [1, 1, 0]}],
    meshes: [{name: 'protected-building', primitives: [{attributes: {POSITION: 0}, material: 0, mode: 4}]}], materials: [{name: 'protected-building-material', pbrMetallicRoughness: {baseColorFactor: [1, .8, .6, 1]}}], nodes: [{mesh: 0, name: 'protected-building'}], scenes: [{nodes: [0]}], scene: 0};
  const originalBin = new Uint8Array(Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer), bytes = packGlb(json, originalBin);
  const piece = {...entranceBox({origin: [0, 0], uphill: [1, 0]}, 0, 1, 0, 1, 1, 0, 'entrance:test-cheek'), cell: 'c_p00_p00'};
  const result = readFacadeGlb(appendEntranceGlb(bytes, [piece], await entranceTextures())), next = result.json as any;
  assert.deepEqual(Array.from(result.bin.subarray(0, originalBin.length)), Array.from(originalBin));
  for (const key of ['nodes', 'meshes', 'materials', 'bufferViews', 'accessors'] as const) assert.deepEqual(next[key].slice(0, json[key].length), json[key]);
  assert.equal(next.nodes.length, 2); assert.equal(next.images.length, 2);
  assert.equal(next.materials[next.meshes[1].primitives[0].material].name, 'Original Senate entrance coursed-granite');
  assert.equal(next.meshes[0].name, 'protected-building');
});
