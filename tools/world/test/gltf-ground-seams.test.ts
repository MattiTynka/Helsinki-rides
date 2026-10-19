import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { validateBytes } from 'gltf-validator';
import { GlbBuilder } from '../lib/gltf.ts';

test('different ground materials and cells retain exact shared edge vertices after GLB compression', async () => {
  const builders = [new GlbBuilder('ground-west'), new GlbBuilder('ground-east')];
  const shared = [[0.12345, 3.45678, -10.321], [0.12345, 3.45678, 40.123]];
  for (const [cell, builder] of builders.entries()) {
    for (const [name, tip] of [['stairs', [-80.123 - cell * 128, 8.7654, 5]], ['yard', [119.876 + cell * 128, -2.7654, -50]]] as const) {
      await builder.addMesh({ name, materialName: name, positions: Float32Array.from([...shared[0]!, ...shared[1]!, ...tip]), indices: new Uint32Array([0, 1, 2]) }, { name, unlit: false });
    }
  }
  await MeshoptDecoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  const docs = await Promise.all(builders.map(async builder => {
    const bytes = await builder.toGlb('test', undefined, 'exact');
    const validation = await validateBytes(bytes, { maxIssues: 100 });
    assert.equal(validation.issues.numErrors, 0, JSON.stringify(validation.issues.messages));
    return io.readBinary(bytes);
  }));
  const worldPositions = docs.flatMap(doc => doc.getRoot().listNodes()).filter(n => n.getMesh()).map(n => {
    const m = n.getWorldMatrix(), p = n.getMesh()!.listPrimitives()[0]!.getAttribute('POSITION')!;
    return Array.from({ length: p.getCount() }, (_, i) => {
      const v = p.getElement(i, []);
      return [m[0]! * v[0]! + m[4]! * v[1]! + m[8]! * v[2]! + m[12]!, m[1]! * v[0]! + m[5]! * v[1]! + m[9]! * v[2]! + m[13]!, m[2]! * v[0]! + m[6]! * v[1]! + m[10]! * v[2]! + m[14]!];
    });
  });
  assert.equal(worldPositions.length, 4);
  for (const point of shared) {
    const nearest = worldPositions.map(vertices => vertices.toSorted((a, b) => Math.hypot(...a.map((v, i) => v - point[i]!)) - Math.hypot(...b.map((v, i) => v - point[i]!)))[0]!);
    for (const decoded of nearest) assert.deepEqual(decoded, point.map(Math.fround), 'all materials and cells must retain the authored Float32 edge exactly');
  }
});
