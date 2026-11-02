import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { getBounds } from '@gltf-transform/functions';
import { MeshoptDecoder } from 'meshoptimizer';
import { validateBytes } from 'gltf-validator';
import { AIRCRAFT_HULLS } from '../../../packages/sim/src/aircraft.ts';

const root = new URL('../../../', import.meta.url);
const contract = JSON.parse(await readFile(new URL('content/assets/aircraft.contract.json', root), 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

test('published aircraft are small embedded, valid animated GLBs with preserved articulated parts', async () => {
  await MeshoptDecoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  let total = 0;
  assert.equal(contract.schemaVersion, 2);
  assert.deepEqual(contract.models.map(model => model.source.creator), ['osmosikum', 'Blendsteve']);
  assert.deepEqual(contract.models.map(model => model.source.license), ['CC-BY-4.0', 'CC-BY-3.0']);
  for (const model of contract.models) {
    const bytes = await readFile(new URL(model.file, root));
    assert.equal(sha256(bytes), model.sha256);
    assert.equal(bytes.length, model.bytes);
    assert.ok(bytes.length < 2 * 1024 * 1024, 'Each aircraft stays below 2 MiB');
    assert.ok(model.triangles > 10000 && model.triangles <= 50000, 'Detailed aircraft stay within the 50K triangle budget');
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
    assert.equal(scene.listTextures().length, model.textures.length);
    for (const [index, texture] of scene.listTextures().entries()) {
      const atlas = texture.getImage(), receipt = model.textures[index];
      assert.equal(sha256(atlas), receipt.sha256);
      assert.equal(atlas.length, receipt.encodedBytes);
      assert.equal(texture.getMimeType(), 'image/png');
      assert.equal(new DataView(atlas.buffer, atlas.byteOffset).getUint32(16), receipt.width);
      assert.equal(new DataView(atlas.buffer, atlas.byteOffset).getUint32(20), receipt.height);
      assert.ok(receipt.width <= 1024 && receipt.height <= 1024, 'Web textures are at most 1K');
    }
    const pivot = model.id === 'malmi-plane' ? 'trainer_propeller' : 'helicopter_rotor_main';
    assert.ok(scene.listNodes().some(node => node.getName() === pivot));
    if (model.id === 'malmi-helicopter') {
      const hub = scene.listNodes().find(node => node.getName() === pivot);
      const centre = hub.getWorldTranslation();
      let radius = 0;
      for (const node of hub.listChildren()) {
        const matrix = node.getWorldMatrix();
        for (const primitive of node.getMesh()?.listPrimitives() ?? []) {
          const positions = primitive.getAttribute('POSITION');
          for (let i = 0; i < positions.getCount(); i++) {
            const [x,y,z] = positions.getElement(i, []);
            const worldX = matrix[0]*x+matrix[4]*y+matrix[8]*z+matrix[12];
            const worldZ = matrix[2]*x+matrix[6]*y+matrix[10]*z+matrix[14];
            radius = Math.max(radius, Math.hypot(worldX-centre[0],worldZ-centre[2]));
          }
        }
      }
      assert.ok(Math.abs(radius-10.65)<0.01, 'Mi-17 retains a full 21.3 metre main rotor');
      const envelope = AIRCRAFT_HULLS.helicopter[2];
      assert.ok(envelope.half[0]>=radius && envelope.half[2]>=radius, 'Collision covers the complete moving rotor');
      assert.ok(Math.abs(envelope.centre[1]-centre[1])<0.05, 'Rotor collider follows the new hub height');
    }
    assert.equal(model.compression.applied, true);
    assert.ok(model.compression.savedBytes > 0);
    assert.equal(model.compression.animationCount, model.animations.length);
    assert.equal(model.compression.nodeCount, model.nodes.length);
    assert.equal(model.compression.compressedSha256, model.sha256);
  }
  assert.ok(total < 4 * 1024 * 1024, 'Both detailed models together stay below 4 MiB');
});
