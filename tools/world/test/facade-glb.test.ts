import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFacadeGlb, replaceFacadeImages, type FacadeGlbJson } from '../lib/facade-glb.ts';

function fixture(overlap = false) {
  const json: FacadeGlbJson = { asset: { version: '2.0' }, buffers: [{ byteLength: 64 }, { byteLength: 12, uri: 'fallback.bin' }], bufferViews: [
    { buffer: 0, byteOffset: 0, byteLength: 8 }, { buffer: 0, byteOffset: 8, byteLength: 8 },
    { buffer: 1, byteOffset: 0, byteLength: 12, extensions: { EXT_meshopt_compression: { buffer: 0, byteOffset: 16, byteLength: 8 } } },
    { buffer: 0, byteOffset: 24, byteLength: 8 }, { buffer: 0, byteOffset: 32, byteLength: 32 },
  ], images: [{ name: 'facade0', bufferView: 1 }, { name: 'facade1', bufferView: 3 }], nodes: [{ name: 'frozen-ground', mesh: 0 }], accessors: [{ bufferView: 0 }, { bufferView: 2 }, { bufferView: 4 }] };
  if (overlap) { json.bufferViews[4]!.byteOffset = 12; json.bufferViews[4]!.byteLength = 8; }
  const text = Buffer.from(JSON.stringify(json)), padded = Buffer.alloc((text.length + 3) & ~3, 0x20); text.copy(padded);
  const bytes = Buffer.alloc(28 + padded.length + 64);
  bytes.writeUInt32LE(0x46546c67, 0); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(bytes.length, 8); bytes.writeUInt32LE(padded.length, 12); bytes.writeUInt32LE(0x4e4f534a, 16); padded.copy(bytes, 20);
  bytes.writeUInt32LE(64, 20 + padded.length); bytes.writeUInt32LE(0x004e4942, 24 + padded.length);
  for (let i = 0; i < 64; i++) bytes[28 + padded.length + i] = i;
  return bytes;
}

test('image range replacement remaps compressed geometry offsets while preserving every geometry byte', () => {
  const original = fixture(), before = readFacadeGlb(original);
  const after = readFacadeGlb(replaceFacadeImages(original, new Map([[0, new Uint8Array(12).fill(201)], [1, new Uint8Array(4).fill(202)]])));
  assert.equal(after.bin.length, before.bin.length);
  assert.equal(after.json.bufferViews[2]!.extensions!.EXT_meshopt_compression!.byteOffset, 20);
  assert.deepEqual(after.bin.subarray(20, 28), before.bin.subarray(16, 24));
  assert.deepEqual(after.bin.subarray(32), before.bin.subarray(32));
  assert.deepEqual(after.json['nodes'], before.json['nodes']);
  assert.deepEqual(after.json['accessors'], before.json['accessors']);
  assert.equal(after.json.bufferViews[1]!.byteLength, 12);
  assert.equal(after.json.bufferViews[3]!.byteLength, 4);
});

test('a non-image view overlapping a replacement is rejected instead of corrupting geometry', () => {
  assert.throws(() => replaceFacadeImages(fixture(true), new Map([[0, new Uint8Array(8)]])), /aliases a non-image/);
});
