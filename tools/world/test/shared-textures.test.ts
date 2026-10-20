import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { externalizeCellImages, packGlb } from '../lib/shared-textures.ts';
import { readFacadeGlb } from '../lib/facade-glb.ts';

test('sharing a cell image keeps exact encoded pixels, material references and geometry bytes', () => {
  const bin = new Uint8Array([1, 2, 3, 4, 80, 78, 71, 7]), json = {
    asset: { version: '2.0', copyright: 'source author' }, buffers: [{ byteLength: 8 }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 4 }, { buffer: 0, byteOffset: 4, byteLength: 4 }],
    images: [{ mimeType: 'image/png', bufferView: 1 }], textures: [{ source: 0 }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
  };
  const source = packGlb(json, bin), before = source.slice(), result = externalizeCellImages(source), decoded = readFacadeGlb(result.bytes);
  assert.deepEqual(source, before);
  assert.deepEqual(new Uint8Array(decoded.bin), bin);
  assert.deepEqual(decoded.json.materials, json.materials);
  assert.deepEqual(decoded.json.textures, json.textures);
  const digest = createHash('sha256').update(bin.subarray(4)).digest('hex');
  assert.deepEqual(result.images, [{ path: `textures/${digest}.png`, sha256: digest, bytes: bin.slice(4) }]);
  assert.equal((decoded.json.images![0] as any).uri, `../textures/${digest}.png`);
  assert.equal(decoded.json.images![0]!.bufferView, undefined);
  assert.deepEqual(externalizeCellImages(result.bytes).bytes, result.bytes);
});

test('external image paths cannot introduce third-party requests or escape shared textures', () => {
  for (const uri of ['https://example.org/x.png', '../../x.png', '../textures/a.png', 'data:image/png;base64,AA']) {
    const bytes = packGlb({ asset: { version: '2.0' }, buffers: [{ byteLength: 4 }], bufferViews: [], images: [{ uri }] }, new Uint8Array(4));
    assert.throws(() => externalizeCellImages(bytes));
  }
});
