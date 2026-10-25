import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {NodeIO} from '@gltf-transform/core';
import {ALL_EXTENSIONS} from '@gltf-transform/extensions';
import {MeshoptDecoder} from 'meshoptimizer';
import {GlbBuilder, flatNormals} from '../lib/gltf.ts';
import {readFacadeGlb} from '../lib/facade-glb.ts';
import {replaceGroundGlb} from '../lib/replace-ground-glb.ts';
import {compactGlb, isCompactedTextureUri} from '../lib/compact-glb.ts';

const align4 = (n: number) => Math.ceil(n / 4) * 4;
function pack(json: any, bin: Uint8Array): Uint8Array {
  const text = Buffer.from(JSON.stringify(json)), padded = Buffer.alloc(align4(text.length), 32); text.copy(padded);
  const output = Buffer.alloc(28 + padded.length + align4(bin.length));
  output.writeUInt32LE(0x46546c67, 0); output.writeUInt32LE(2, 4); output.writeUInt32LE(output.length, 8);
  output.writeUInt32LE(padded.length, 12); output.writeUInt32LE(0x4e4f534a, 16); padded.copy(output, 20);
  output.writeUInt32LE(align4(bin.length), 20 + padded.length); output.writeUInt32LE(0x004e4942, 24 + padded.length); output.set(bin, 28 + padded.length);
  return output;
}
async function decoder() {
  await MeshoptDecoder.ready;
  return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.decoder': MeshoptDecoder});
}
async function repairedFixture() {
  const builder = new GlbBuilder('compaction-test');
  const positions = new Float32Array([0, 0, 0, 2, 0, 0, 2, 0, 2]);
  const indices = new Uint32Array([0, 2, 1]);
  for (const name of ['test_ground_slabs', 'building']) {
    const distinctPositions = positions.map((v, i) => name === 'building' && i % 3 === 0 ? v + 10 : v);
    await builder.addMesh({name, positions: distinctPositions, indices: indices.slice(), normals: flatNormals(distinctPositions, indices), uvs: new Float32Array([0, 0, 1, 0, 1, 1]), materialName: name}, {name, unlit: false, texture: {width: 2, height: 2, data: new Uint8Array(16).fill(name === 'building' ? 100 : 200)}});
  }
  const original = await builder.toGlb('fixture', {cell: 'test', sourceLedger: ['CC BY 4.0'], profile: {socket: 'driver_hand', untouched: 6}}, 'exact');
  const io = await decoder(), doc = await io.readBinary(original), primitive = doc.getRoot().listNodes().find(n => n.getName() === 'test_ground_slabs')!.getMesh()!.listPrimitives()[0]!;
  const attributes = Object.fromEntries(primitive.listSemantics().map(s => [s, primitive.getAttribute(s)!.getArray()!.slice()])) as any;
  for (let i = 1; i < attributes.POSITION.length; i += 3) attributes.POSITION[i] = -.01;
  const replaced = await replaceGroundGlb(original, [{nodeName: 'test_ground_slabs', primitiveIndex: 0, attributes, indices: Uint32Array.from(primitive.getIndices()!.getArray()!)}]);
  const {json, bin} = readFacadeGlb(replaced), j = structuredClone(json) as any;
  j.asset.copyright = 'Original author / CC BY 4.0';
  j.nodes.push({name: 'driver_hand', extras: {runtimeSocket: true}});
  j.scenes[0].nodes.push(j.nodes.length - 1);
  j.scenes.push({name: 'other scene', nodes: [j.nodes.length - 1], extras: {retain: true}});
  // The old ground mesh is unreachable. Also make unreferenced material/image resources that must
  // be removed even though their definitions precede live resources after a normal rebuild.
  j.meshes.push(structuredClone(j.meshes[0]));
  j.materials.push({name: 'obsolete', pbrMetallicRoughness: {baseColorTexture: {index: j.textures.length}}});
  j.textures.push({source: j.images.length, sampler: j.samplers?.length ?? 0});
  j.images.push(structuredClone(j.images[0]));
  (j.samplers ??= []).push({name: 'obsolete sampler'});
  return pack(j, bin);
}
function decodedSnapshot(doc: Awaited<ReturnType<NodeIO['readBinary']>>) {
  return doc.getRoot().listNodes().map(node => ({
    name: node.getName(), matrix: node.getMatrix(), extras: node.getExtras(),
    primitives: node.getMesh()?.listPrimitives().map(p => ({
      mode: p.getMode(), indices: p.getIndices()?.getArray(),
      attributes: p.listSemantics().map(s => ({semantic: s, values: p.getAttribute(s)!.getArray(), normalized: p.getAttribute(s)!.getNormalized()})),
      material: p.getMaterial()?.getName(), image: p.getMaterial()?.getBaseColorTexture()?.getImage(),
    })),
  }));
}

test('compaction removes appended obsolete resources and proves exact active decoded geometry, textures and metadata', async () => {
  const source = await repairedFixture(), saved = source.slice(), io = await decoder();
  const result = compactGlb(source), before = readFacadeGlb(source), after = readFacadeGlb(result.bytes);
  assert.deepEqual(source, saved, 'Input must never be mutated');
  assert.ok(result.receipt.savedBytes > 0);
  assert.ok(result.receipt.resources.meshes.after < result.receipt.resources.meshes.before);
  assert.ok(result.receipt.resources.accessors.after < result.receipt.resources.accessors.before);
  assert.equal(result.receipt.resources.materials.after, 2);
  assert.equal(result.receipt.resources.textures.after, 2);
  assert.equal(result.receipt.resources.images.after, 2);
  assert.equal(result.receipt.resources.samplers.after, result.receipt.resources.samplers.before - 1);
  assert.deepEqual(decodedSnapshot(await io.readBinary(result.bytes)), decodedSnapshot(await io.readBinary(source)));
  assert.deepEqual(after.json.extras, before.json.extras);
  assert.deepEqual(after.json.asset, before.json.asset);
  assert.deepEqual(after.json.scenes, before.json.scenes);
  assert.equal((after.json.nodes as any[]).at(-1).name, 'driver_hand');
  assert.equal(result.receipt.images.length, 2);
  assert.ok(result.receipt.images.every(i => /^[a-f0-9]{64}$/.test(i.sha256!)));
  assert.deepEqual(compactGlb(result.bytes).bytes, result.bytes, 'Compaction must be byte-idempotent');
  const validator = await import('gltf-validator'), report = await validator.validateBytes(result.bytes);
  assert.equal(report.issues.numErrors, 0, JSON.stringify(report.issues.messages));
});

function animatedRawFixture() {
  const pieces: Uint8Array[] = [new Uint8Array(32).fill(215)], views: any[] = [];
  let cursor = 32;
  const append = (array: Float32Array | Uint16Array | Uint8Array, properties: any = {}) => {
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    const index = views.length;
    views.push({buffer: 0, byteOffset: cursor, byteLength: bytes.length, ...properties});
    pieces.push(bytes, new Uint8Array(align4(bytes.length) - bytes.length)); cursor += align4(bytes.length);
    return index;
  };
  // Two attribute views overlap exactly and are interleaved. Their aliasing and raw values must
  // survive interval merging rather than copying a separate buffer for each accessor.
  const vertices = append(new Float32Array([0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0]), {byteStride: 24, target: 34962});
  const normals = views.length; views.push({...views[vertices]});
  const indices = append(new Uint16Array([0, 2, 1]), {target: 34963});
  const joints = append(new Uint8Array(12), {target: 34962});
  const weights = append(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), {target: 34962});
  const ibm = append(new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]));
  const time = append(new Float32Array([0, 1]));
  const translation = append(new Float32Array([0, 0, 0, 0, 1, 0]));
  const sparseIndices = append(new Uint8Array([1]));
  const sparseValues = append(new Float32Array([.5, .5, .5]));
  const bin = Buffer.concat(pieces);
  const json = {
    asset: {version: '2.0', copyright: 'Test author'}, buffers: [{byteLength: bin.length}], bufferViews: views,
    accessors: [
      {bufferView: vertices, componentType: 5126, type: 'VEC3', count: 3, min: [0, 0, 0], max: [1, 0, 1]},
      {bufferView: normals, byteOffset: 12, componentType: 5126, type: 'VEC3', count: 3},
      {bufferView: indices, componentType: 5123, type: 'SCALAR', count: 3},
      {bufferView: joints, componentType: 5121, type: 'VEC4', count: 3},
      {bufferView: weights, componentType: 5126, type: 'VEC4', count: 3},
      {bufferView: ibm, componentType: 5126, type: 'MAT4', count: 1},
      {bufferView: time, componentType: 5126, type: 'SCALAR', count: 2, min: [0], max: [1]},
      {bufferView: translation, componentType: 5126, type: 'VEC3', count: 2},
      {componentType: 5126, type: 'VEC3', count: 3, min: [0, 0, 0], max: [.5, .5, .5], sparse: {count: 1, indices: {bufferView: sparseIndices, componentType: 5121}, values: {bufferView: sparseValues}}},
    ],
    meshes: [{name: 'skin', weights: [0], primitives: [{attributes: {POSITION: 0, NORMAL: 1, JOINTS_0: 3, WEIGHTS_0: 4}, indices: 2, targets: [{POSITION: 8}]}]}],
    nodes: [{name: 'Snow', mesh: 0, skin: 0}, {name: 'root', children: [2]}, {name: 'hand_socket', extras: {profile: 'keep'}}],
    skins: [{name: 'rig', joints: [1], skeleton: 1, inverseBindMatrices: 5}],
    animations: [{name: 'jump', samplers: [{input: 6, output: 7, interpolation: 'LINEAR'}], channels: [{sampler: 0, target: {node: 1, path: 'translation'}}]}],
    scenes: [{nodes: [0, 1]}], scene: 0, extras: {profile: {bones: ['root', 'hand_socket']}},
  };
  return pack(json, bin);
}

test('raw interleaved views, sparse morphs, skinning, animations and named sockets remain exact', async () => {
  const source = animatedRawFixture(), result = compactGlb(source), a = readFacadeGlb(source), b = readFacadeGlb(result.bytes);
  assert.ok(result.receipt.savedBytes > 0, 'Unreferenced physical prefix is removed');
  assert.equal(b.json.bufferViews[0]!.byteOffset, b.json.bufferViews[1]!.byteOffset, 'Shared view aliasing must remain');
  assert.deepEqual(b.json.nodes, a.json.nodes); assert.deepEqual(b.json.skins, a.json.skins); assert.deepEqual(b.json.animations, a.json.animations);
  const io = await decoder(), before = await io.readBinary(source), after = await io.readBinary(result.bytes);
  assert.deepEqual(decodedSnapshot(after), decodedSnapshot(before));
  assert.deepEqual(after.getRoot().listSkins()[0]!.getInverseBindMatrices()!.getArray(), before.getRoot().listSkins()[0]!.getInverseBindMatrices()!.getArray());
  assert.deepEqual(after.getRoot().listAnimations()[0]!.listSamplers()[0]!.getOutput()!.getArray(), before.getRoot().listAnimations()[0]!.listSamplers()[0]!.getOutput()!.getArray());
  assert.deepEqual(after.getRoot().listMeshes()[0]!.listPrimitives()[0]!.listTargets()[0]!.getAttribute('POSITION')!.getArray(), before.getRoot().listMeshes()[0]!.listPrimitives()[0]!.listTargets()[0]!.getAttribute('POSITION')!.getArray());
  const validator = await import('gltf-validator'), report = await validator.validateBytes(result.bytes);
  assert.equal(report.issues.numErrors, 0, JSON.stringify(report.issues.messages));
});

test('meshopt views sharing encoded streams and virtual fallback ranges preserve both aliases', async () => {
  const source = await repairedFixture(), parsed = readFacadeGlb(source), json = structuredClone(parsed.json) as any;
  const node = json.nodes.find((n: any) => n.name === 'building'), mesh = structuredClone(json.meshes[node.mesh]);
  const primitive = mesh.primitives[0], oldAccessor = json.accessors[primitive.attributes.POSITION];
  const oldView = oldAccessor.bufferView, newView = json.bufferViews.length;
  assert.ok(json.bufferViews[oldView].extensions.EXT_meshopt_compression);
  json.bufferViews.push(structuredClone(json.bufferViews[oldView]));
  primitive.attributes.POSITION = json.accessors.length;
  json.accessors.push({...structuredClone(oldAccessor), bufferView: newView});
  json.nodes.push({name: 'shared-stream-copy', mesh: json.meshes.length});
  json.scenes[0].nodes.push(json.nodes.length - 1); json.meshes.push(mesh);
  const input = pack(json, parsed.bin), result = compactGlb(input), output = readFacadeGlb(result.bytes).json as any;
  const oldEntry = result.receipt.bufferViews.find(v => v.originalIndex === oldView)!;
  const newEntry = result.receipt.bufferViews.find(v => v.originalIndex === newView)!;
  assert.ok(oldEntry && newEntry);
  assert.equal(oldEntry.compressedSha256, newEntry.compressedSha256);
  const a = output.bufferViews[oldEntry.compactedIndex], b = output.bufferViews[newEntry.compactedIndex];
  assert.equal(a.byteOffset, b.byteOffset);
  assert.equal(a.extensions.EXT_meshopt_compression.byteOffset, b.extensions.EXT_meshopt_compression.byteOffset);
  const io = await decoder(); assert.deepEqual(decodedSnapshot(await io.readBinary(result.bytes)), decodedSnapshot(await io.readBinary(input)));
});

test('material extension references are remapped and safe content-addressed image URIs preserve metadata', async () => {
  const source = await repairedFixture(), parsed = readFacadeGlb(source), json = structuredClone(parsed.json) as any;
  // Prefix every texture/image/sampler with a dead item to require non-identity remapping.
  json.images.unshift({...json.images[0], name: 'dead image'}); json.textures.unshift({source: 0});
  for (const texture of json.textures.slice(1)) { if (texture.source !== undefined) texture.source++; if (texture.extensions?.KHR_texture_basisu) texture.extensions.KHR_texture_basisu.source++; }
  for (const material of json.materials) if (material.pbrMetallicRoughness?.baseColorTexture) material.pbrMetallicRoughness.baseColorTexture.index++;
  const imageHash = createHash('sha256').update('safe texture').digest('hex'), uri = `../textures/${imageHash}.ktx2`;
  const imageId = json.images.length; json.images.push({uri, mimeType: 'image/ktx2', extras: {license: 'CC BY 4.0'}});
  const textureId = json.textures.length; json.textures.push({extensions: {KHR_texture_basisu: {source: imageId}}});
  json.materials[0].extensions = {KHR_materials_clearcoat: {clearcoatTexture: {index: textureId, texCoord: 1, extensions: {KHR_texture_transform: {offset: [.2, .3]}}}}, KHR_materials_specular: {specularColorTexture: {index: textureId}}};
  const result = compactGlb(pack(json, parsed.bin)), output = readFacadeGlb(result.bytes).json as any;
  const material = output.materials.find((m: any) => m.name === json.materials[0].name);
  const texture = output.textures[material.extensions.KHR_materials_clearcoat.clearcoatTexture.index];
  assert.equal(output.images[texture.extensions.KHR_texture_basisu.source].uri, uri);
  assert.deepEqual(output.images[texture.extensions.KHR_texture_basisu.source].extras, {license: 'CC BY 4.0'});
  assert.equal(material.extensions.KHR_materials_specular.specularColorTexture.index, material.extensions.KHR_materials_clearcoat.clearcoatTexture.index);
  assert.deepEqual(material.extensions.KHR_materials_clearcoat.clearcoatTexture.extensions.KHR_texture_transform.offset, [.2, .3]);
  assert.ok(result.receipt.images.some(image => image.uri === uri));
});

test('unsupported references and unsafe external paths fail before emitting a candidate', async () => {
  const source = await repairedFixture(), {json, bin} = readFacadeGlb(source);
  const mutate = (change: (j: any) => void) => {const j = structuredClone(json); change(j); return () => compactGlb(pack(j, bin));};
  assert.throws(mutate(j => j.extensionsUsed.push('VENDOR_unknown')), /Unsupported GLB extension/);
  assert.throws(mutate(j => j.meshes[0].primitives[0].extensions = {VENDOR_unknown: {bufferView: 0}}), /Unsupported GLB extension/);
  assert.throws(mutate(j => j.buffers[0].uri = 'https://example.org/model.bin'), /External buffers/);
  assert.throws(mutate(j => j.nodes[0].mesh = 999), /Missing meshes/);
  assert.throws(mutate(j => {const view = j.bufferViews.find((v: any) => v.extensions?.EXT_meshopt_compression); view.extensions.EXT_meshopt_compression.byteOffset = bin.length;}), /exceeds its buffer/);
  for (const uri of ['https://example.org/a.ktx2', 'data:image/png;base64,eA==', '/textures/a.ktx2', '..\\textures\\a.ktx2', '../../textures/a.ktx2', '../textures/abc.ktx2', `../textures/${'a'.repeat(64)}.ktx2?x=1`]) {
    assert.equal(isCompactedTextureUri(uri), false);
    assert.throws(mutate(j => {j.images[0].uri = uri; delete j.images[0].bufferView;}), /Unsupported external texture URI/);
  }
  assert.equal(isCompactedTextureUri(`textures/${'a'.repeat(64)}.png`), true);
});
