import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Document, NodeIO, type Primitive} from '@gltf-transform/core';
import {ALL_EXTENSIONS, EXTMeshoptCompression, KHRMaterialsUnlit} from '@gltf-transform/extensions';
import {MeshoptDecoder, MeshoptEncoder} from 'meshoptimizer';
import {validateBytes} from 'gltf-validator';
import {optimizeCityLods, optimizeExactCityMesh} from '../lib/optimize-city-lods.ts';

async function io() {
  await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready]);
  return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.decoder': MeshoptDecoder, 'meshopt.encoder': MeshoptEncoder});
}
function grid(size = 12, hole = false) {
  const positions: number[] = [], uv: number[] = [], ids: number[] = [];
  for (let z = 0; z <= size; z++) for (let x = 0; x <= size; x++) {positions.push(x, 0, z); uv.push(x / 3, z / 3);}
  for (let z = 0; z < size; z++) for (let x = 0; x < size; x++) {
    if (hole && x >= 4 && x <= 7 && z >= 4 && z <= 7) continue;
    const a = z * (size + 1) + x, b = a + 1, c = a + size + 1, d = c + 1;
    ids.push(a, c, b, b, c, d);
  }
  return {positions: Float32Array.from(positions), uv: Float32Array.from(uv), ids: Uint32Array.from(ids)};
}
async function fixture(options: {hole?: boolean; duplicate?: boolean; reverse?: boolean; blend?: boolean; doubleSided?: boolean; unlit?: boolean; architecture?: boolean; transform?: boolean; texture?: boolean} = {}) {
  const doc = new Document(), buffer = doc.createBuffer(), scene = doc.createScene(), ground = grid(12, options.hole);
  const mat = doc.createMaterial('ground').setDoubleSided(options.doubleSided ?? true).setAlphaMode(options.blend ? 'BLEND' : 'OPAQUE');
  if (options.unlit !== false) mat.setExtension('KHR_materials_unlit', doc.createExtension(KHRMaterialsUnlit).createUnlit());
  if (options.texture) mat.setBaseColorTexture(doc.createTexture('licensed-original').setImage(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jFz8AAAAASUVORK5CYII=', 'base64')).setMimeType('image/png'));
  const make = (far: boolean) => {
    const d = far ? new Document() : doc, b = far ? d.createBuffer() : buffer, s = far ? d.createScene() : scene;
    const m = far ? d.createMaterial('distant').setDoubleSided(options.doubleSided ?? true).setAlphaMode(options.blend ? 'BLEND' : 'OPAQUE') : mat;
    if (far && options.unlit !== false) m.setExtension('KHR_materials_unlit', d.createExtension(KHRMaterialsUnlit).createUnlit());
    let ids = Array.from(ground.ids);
    if (options.duplicate) ids = ids.flatMap((_, i) => i % 3 ? [] : [...ids.slice(i, i + 3), ...ids.slice(i, i + 3)]);
    if (options.reverse) ids.push(...Array.from(ground.ids).flatMap((_, i) => i % 3 ? [] : [ground.ids[i]!, ground.ids[i + 2]!, ground.ids[i + 1]!]));
    const pos = [...ground.positions], attributes = far ? Array(ground.positions.length).fill(.3) : Array.from(ground.uv);
    if (far && options.architecture) {const id = pos.length / 3; pos.push(2, 4, 2, 3, 4, 2, 2, 4, 3); attributes.push(.7, .1, .2, .7, .1, .2, .7, .1, .2); ids.push(id, id + 1, id + 2);}
    const p = d.createPrimitive().setAttribute('POSITION', d.createAccessor().setType('VEC3').setBuffer(b).setArray(Float32Array.from(pos))).setIndices(d.createAccessor().setType('SCALAR').setBuffer(b).setArray(Uint32Array.from(ids))).setMaterial(m);
    p.setAttribute(far ? 'COLOR_0' : 'TEXCOORD_0', d.createAccessor().setType(far ? 'VEC3' : 'VEC2').setBuffer(b).setArray(Float32Array.from(attributes)));
    const n = d.createNode(far ? 'cell' : 'cell_ground_slabs').setMesh(d.createMesh(far ? 'cell' : 'cell_ground_slabs').addPrimitive(p));
    if (options.transform) n.setTranslation([1, 0, 0]);
    s.addChild(n);
    d.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({method: EXTMeshoptCompression.EncoderMethod.QUANTIZE});
    return d;
  };
  const writer = await io();
  return {lod0: await writer.writeBinary(make(false)), lod2: await writer.writeBinary(make(true)), boundsXZ: [0, 0, 12, 12] as const};
}
const points = (p: Primitive) => {
  const a = p.getAttribute('POSITION')!, ids = p.getIndices()!.getArray()!;
  return Array.from(ids, i => a.getElement(i, []).join(','));
};
function edges(p: Primitive) {
  const vertices = points(p), map = new Map<string, number>();
  for (let i = 0; i < vertices.length; i += 3) for (let k = 0; k < 3; k++) {const key = [vertices[i + k], vertices[i + (k + 1) % 3]].sort().join('|'); map.set(key, (map.get(key) ?? 0) + 1);}
  return [...map].filter(([, count]) => count !== 2).map(([key, count]) => `${key}:${count}`).sort();
}
async function primitive(bytes: Uint8Array) {return (await (await io()).readBinary(bytes)).getRoot().listMeshes()[0]!.listPrimitives()[0]!;}

test('planar grid gains real intermediate and far LODs with exact vertices, UVs and cell border', async () => {
  const input = await fixture(), original = input.lod0.slice(), result = await optimizeCityLods(input);
  assert.deepEqual(input.lod0, original, 'Source bytes must remain untouched');
  assert.ok(result.lod1);
  assert.ok(result.stats.mid.afterTriangles < result.stats.mid.beforeTriangles * .5);
  assert.ok(result.stats.far.afterTriangles < result.stats.far.beforeTriangles * .5);
  const before = await primitive(input.lod0), after = await primitive(result.lod1);
  assert.deepEqual(edges(after), edges(before));
  const source = new Map<string, number[]>();
  for (let i = 0; i < before.getAttribute('POSITION')!.getCount(); i++) source.set(before.getAttribute('POSITION')!.getElement(i, []).join(','), before.getAttribute('TEXCOORD_0')!.getElement(i, []));
  for (let i = 0; i < after.getAttribute('POSITION')!.getCount(); i++) assert.deepEqual(after.getAttribute('TEXCOORD_0')!.getElement(i, []), source.get(after.getAttribute('POSITION')!.getElement(i, []).join(',')), 'No retained attribute may be moved or interpolated');
  assert.equal(after.getAttribute('POSITION')!.getComponentType(), 5126);
  assert.ok(result.stats.mid.maxMeasuredDeviationMetres <= .001);
  assert.equal((await validateBytes(result.lod1)).issues.numErrors, 0);
});

test('ground hole outline and unrelated horizontal architecture survive merged far simplification', async () => {
  const input = await fixture({hole: true, architecture: true}), result = await optimizeCityLods(input);
  assert.ok(result.lod1);
  assert.deepEqual(edges(await primitive(result.lod1)), edges(await primitive(input.lod0)));
  const far = await primitive(result.lod2), p = far.getAttribute('POSITION')!, ids = far.getIndices()!.getArray()!;
  const architecture = Array.from(ids).filter(i => p.getElement(i, [])[1] === 4);
  assert.equal(architecture.length, 3, 'Horizontal roof/facade triangle must remain exact');
  assert.equal(result.stats.far.boundaryPreserved, true);
});

test('zero-error near cleanup discards identical winding only and preserves source vertex values', async () => {
  const input = await fixture({duplicate: true, reverse: true}), result = await optimizeExactCityMesh(input.lod0);
  assert.equal(result.stats.beforeTriangles, 864);
  assert.equal(result.stats.afterTriangles, 576, 'Forward duplicate is removed, reverse face is kept');
  assert.equal(result.stats.maxMeasuredDeviationMetres, 0);
  assert.equal(result.stats.maxAttributeDeviation, 0);
  assert.equal(result.stats.primitives[0]!.duplicateTrianglesRemoved, 288);
  const before = new Set(points(await primitive(input.lod0))), after = new Set(points(await primitive(result.bytes)));
  assert.deepEqual(after, before);
});

test('far reverse duplicate removal requires opaque unlit double-sided material', async () => {
  const allowed = await optimizeCityLods(await fixture({reverse: true}));
  assert.equal(allowed.stats.far.primitives[0]!.duplicateTrianglesRemoved, 288);
  for (const options of [{doubleSided: false}, {unlit: false}, {blend: true}]) {
    const result = await optimizeCityLods(await fixture({reverse: true, ...options}));
    assert.equal(result.stats.far.primitives[0]!.duplicateTrianglesRemoved, 0, JSON.stringify(options));
  }
});

test('blended surfaces retain repeated triangles and transformed cells return original bytes', async () => {
  const blended = await fixture({duplicate: true, blend: true}), exact = await optimizeExactCityMesh(blended.lod0);
  assert.deepEqual(exact.bytes, blended.lod0);
  const blendedLods = await optimizeCityLods(blended);
  assert.equal(blendedLods.lod1, null); assert.deepEqual(blendedLods.lod2, blended.lod2);
  const transformed = await fixture({transform: true}), result = await optimizeCityLods(transformed);
  assert.equal(result.lod1, null); assert.deepEqual(result.lod2, transformed.lod2);
});

test('active licensed texture bytes remain exact in a simplified intermediate asset', async () => {
  const input = await fixture({texture: true}), result = await optimizeCityLods(input);
  assert.ok(result.lod1);
  const reader = await io(), before = await reader.readBinary(input.lod0), after = await reader.readBinary(result.lod1);
  assert.equal(after.getRoot().listTextures()[0]!.getName(), 'licensed-original');
  assert.deepEqual(after.getRoot().listTextures()[0]!.getImage(), before.getRoot().listTextures()[0]!.getImage());
});

test('exact cleanup preserves coincident triangles with different UV seams', async () => {
  const input = await fixture(), reader = await io(), doc = await reader.readBinary(input.lod0), p = doc.getRoot().listMeshes()[0]!.listPrimitives()[0]!, oldPositions = p.getAttribute('POSITION')!, oldUvs = p.getAttribute('TEXCOORD_0')!, oldIndices = p.getIndices()!;
  const values = Array.from(oldPositions.getArray()!), uvs = Array.from(oldUvs.getArray()!), ids = Array.from(oldIndices.getArray()!), offset = oldPositions.getCount();
  for (let k = 0; k < 3; k++) {values.push(...oldPositions.getElement(ids[k]!, [])); uvs.push(...oldUvs.getElement(ids[k]!, []).map(v => v + 1));}
  p.setAttribute('POSITION', doc.createAccessor().setBuffer(doc.getRoot().listBuffers()[0]!).setType('VEC3').setArray(Float32Array.from(values)));
  p.setAttribute('TEXCOORD_0', doc.createAccessor().setBuffer(doc.getRoot().listBuffers()[0]!).setType('VEC2').setArray(Float32Array.from(uvs)));
  p.setIndices(doc.createAccessor().setBuffer(doc.getRoot().listBuffers()[0]!).setType('SCALAR').setArray(Uint32Array.from([...ids, offset, offset + 1, offset + 2])));
  const bytes = await reader.writeBinary(doc), result = await optimizeExactCityMesh(bytes);
  assert.equal(result.stats.afterTriangles, 289); assert.deepEqual(result.bytes, bytes);
});

test('simplified stair treads and vertical risers retain every crease vertex and never become ramps', async () => {
  const reader = await io(), positions: number[] = [], uvs: number[] = [], ids: number[] = [];
  function quad(a: number[], b: number[], c: number[]) {
    const start = positions.length / 3;
    for (let v = 0; v <= 4; v++) for (let u = 0; u <= 12; u++) {
      positions.push(...a.map((value, k) => value + (b[k]! - value) * u / 12 + (c[k]! - value) * v / 4)); uvs.push(u / 3, v / 4);
    }
    for (let v = 0; v < 4; v++) for (let u = 0; u < 12; u++) {const p = start + v * 13 + u; ids.push(p, p + 13, p + 1, p + 1, p + 13, p + 14);}
  }
  for (let step = 0; step < 8; step++) {
    quad([0, step * .2, step], [12, step * .2, step], [0, step * .2, step + 1]);
    quad([0, step * .2, step + 1], [12, step * .2, step + 1], [0, (step + 1) * .2, step + 1]);
  }
  async function bytes(far: boolean) {
    const d = new Document(), b = d.createBuffer(), m = d.createMaterial().setDoubleSided(true).setExtension('KHR_materials_unlit', d.createExtension(KHRMaterialsUnlit).createUnlit());
    const p = d.createPrimitive().setMaterial(m).setAttribute('POSITION', d.createAccessor().setBuffer(b).setType('VEC3').setArray(Float32Array.from(positions))).setIndices(d.createAccessor().setBuffer(b).setType('SCALAR').setArray(Uint32Array.from(ids)));
    p.setAttribute(far ? 'COLOR_0' : 'TEXCOORD_0', d.createAccessor().setBuffer(b).setType(far ? 'VEC3' : 'VEC2').setArray(far ? new Float32Array(positions.length).fill(.3) : Float32Array.from(uvs)));
    d.createScene().addChild(d.createNode(far ? 'cell' : 'cell_ground_slabs').setMesh(d.createMesh(far ? 'cell' : 'cell_ground_slabs').addPrimitive(p)));
    d.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({method: EXTMeshoptCompression.EncoderMethod.QUANTIZE}); return reader.writeBinary(d);
  }
  const input = {lod0: await bytes(false), lod2: await bytes(true), boundsXZ: [0, 0, 12, 8] as const}, result = await optimizeCityLods(input);
  assert.ok(result.lod1); assert.ok(result.stats.mid.afterTriangles < result.stats.mid.beforeTriangles);
  for (const output of [result.lod1, result.lod2]) {
    const p = await primitive(output), pointsAfter = new Set(points(p)), pos = p.getAttribute('POSITION')!, indices = p.getIndices()!.getArray()!;
    for (let step = 0; step < 8; step++) for (let x = 0; x <= 12; x++) for (const corner of [[x, step * .2, step], [x, step * .2, step + 1], [x, (step + 1) * .2, step + 1]]) assert.ok(pointsAfter.has(corner.map(Math.fround).join(',')), `Missing protected stair corner ${corner}`);
    for (let t = 0; t < indices.length; t += 3) {
      const vertices = [0, 1, 2].map(k => pos.getElement(indices[t + k]!, []));
      const horizontal = vertices.every(v => v[1] === vertices[0]![1]), vertical = vertices.every(v => v[2] === vertices[0]![2]);
      assert.ok(horizontal || vertical, 'A stair tread or riser was replaced by a diagonal ramp');
    }
    assert.equal((await validateBytes(output)).issues.numErrors, 0);
  }
});

test('invalid cell bounds fail before changing an input', async () => {
  const input = await fixture();
  await assert.rejects(optimizeCityLods({...input, boundsXZ: [0, 0, 0, 12]}), /Invalid cell bounds/);
});
