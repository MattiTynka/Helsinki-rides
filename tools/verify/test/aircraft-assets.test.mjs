import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { getBounds } from '@gltf-transform/functions';
import { MeshoptDecoder } from 'meshoptimizer';
import { validateBytes } from 'gltf-validator';

const root = new URL('../../../', import.meta.url);
const contract = JSON.parse(await readFile(new URL('content/assets/aircraft.contract.json', root), 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

test('published aircraft are small embedded, valid animated GLBs with preserved articulated parts', async () => {
  await MeshoptDecoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  let total = 0;
  assert.equal(contract.source.creator, 'heyheythere');
  assert.equal(contract.source.license, 'CC-BY-4.0');
  for (const model of contract.models) {
    const bytes = await readFile(new URL(model.file, root));
    assert.equal(sha256(bytes), model.sha256);
    assert.equal(bytes.length, model.bytes);
    assert.ok(bytes.length < 1024 * 1024, 'Each aircraft stays below 1 MiB');
    total += bytes.length;
    const validation = await validateBytes(bytes, { uri: model.file });
    assert.equal(validation.issues.numErrors, 0, JSON.stringify(validation.issues.messages));
    assert.equal(validation.issues.numWarnings, 0, JSON.stringify(validation.issues.messages));
    const document = await io.readBinary(bytes), scene = document.getRoot();
    assert.deepEqual(getBounds(scene.listScenes()[0]), model.bounds);
    assert.equal(scene.listMaterials().length, model.materialCount);
    assert.deepEqual(scene.listNodes().map(node => node.getName()), model.nodes);
    assert.deepEqual(scene.listAnimations().map(animation => animation.getName()), model.animations);
    assert.ok(scene.listAnimations().some(animation => animation.getName() === 'spin'));
    assert.equal(scene.listSkins().length, 0, 'Aircraft use rigid hinges rather than deforming skins');
    for (const accessor of scene.listAccessors()) {
      assert.ok(accessor.getCount() > 0);
      assert.ok(Array.from(accessor.getArray()).every(Number.isFinite), 'Decoded mesh and animation values stay finite');
    }
    assert.equal(scene.listTextures().length, 1);
    const atlas = scene.listTextures()[0].getImage();
    assert.equal(sha256(atlas), contract.textures.sha256);
    assert.equal(atlas.length, contract.textures.encodedBytes);
    assert.equal(new DataView(atlas.buffer, atlas.byteOffset).getUint32(16), contract.textures.width);
    assert.equal(new DataView(atlas.buffer, atlas.byteOffset).getUint32(20), contract.textures.height);
    assert.equal(model.compression.applied, true);
    assert.ok(model.compression.savedBytes > 0);
    assert.equal(model.compression.animationCount, model.animations.length);
    assert.equal(model.compression.nodeCount, model.nodes.length);
    assert.equal(model.compression.compressedSha256, model.sha256);
  }
  assert.ok(total < 256 * 1024, 'Both models together stay below 256 KiB');
});
