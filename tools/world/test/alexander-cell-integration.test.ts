import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { encodeCollisionBundle, parseCollisionBundle } from '../../../packages/world-schema/src/index.ts';
import { addCellMonument } from '../add_cell_monument.ts';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const writeJson = (p: string, v: unknown) => writeFileSync(p, JSON.stringify(v));
async function fixture() {
  const work = path.resolve('data/work'); mkdirSync(work, { recursive: true });
  const folder = mkdtempSync(path.join(work, 'alexander-integration-test-'));
  const cells = path.join(folder, 'cells'), monument = path.join(folder, 'monument'); mkdirSync(cells); mkdirSync(monument);
  async function glb(name: string) {
    const d = new Document(), b = d.createBuffer(), scene = d.createScene(name + '-scene');
    const positions = d.createAccessor().setType('VEC3').setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1])).setBuffer(b);
    const indices = d.createAccessor().setType('SCALAR').setArray(new Uint16Array([0, 2, 1])).setBuffer(b);
    const material = d.createMaterial(name + '-material');
    const texture = d.createTexture(name + '-texture').setImage(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1sAAAAASUVORK5CYII=', 'base64')).setMimeType('image/png');
    material.setBaseColorTexture(texture);
    const uv = d.createAccessor().setType('VEC2').setArray(new Float32Array([0, 0, 1, 0, 0, 1])).setBuffer(b);
    const mesh = d.createMesh(name + '-mesh').addPrimitive(d.createPrimitive().setAttribute('POSITION', positions).setAttribute('TEXCOORD_0', uv).setIndices(indices).setMaterial(material));
    if (name === 'existing') mesh.listPrimitives()[0]!.setAttribute('NORMAL', d.createAccessor().setType('VEC3').setArray(new Int8Array([0, 127, 0, 0, 127, 0, 0, 127, 0])).setNormalized(true).setBuffer(b));
    const parent = d.createNode(name + '-parent').setTranslation([3, 2, 1]);
    parent.addChild(d.createNode(name + '-node').setMesh(mesh).setTranslation([0, 1, 0])); scene.addChild(parent); d.getRoot().setDefaultScene(scene);
    return new NodeIO().writeBinary(d);
  }
  const v = await glb('existing'), a = await glb('monument'); writeFileSync(path.join(cells, 'visual.glb'), v); writeFileSync(path.join(monument, 'monument.glb'), a);
  const col = encodeCollisionBundle({ originId: 'test-origin', frame: 'X-east,Y-up,Z-south', cell: 'c_p00_p00', surfaceTags: ['ground'] }, [{ id: 'existing', group: 'ground', ref: null, positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]), indices: new Uint32Array([0, 2, 1]), triangleTags: new Uint16Array([0]) }]);
  writeFileSync(path.join(cells, 'collision.hcol'), col); const support = Buffer.from('unchanged support terrain'); writeFileSync(path.join(cells, 'runtime-terrain.bin'), support);
  const descriptor = { id: 'c_p00_p00', cx: 0, cz: 0, boundsXZ: [0, 0, 128, 128], visual: { lod0: { path: 'visual.glb', bytes: v.length, sha256: sha(v), triangles: 1, drawCalls: 1, atlases: 0, textureBytesEstimate: 6 } }, collision: { path: 'collision.hcol', bytes: col.length, sha256: sha(col), triangles: 1 }, buildingIds: [], buildings: [], sourceTiles: [] };
  writeJson(path.join(cells, 'cells.json'), { originId: 'test-origin', cells: [descriptor] });
  writeJson(path.join(cells, 'report.json'), { inputs: {}, supportTerrain: { path: 'runtime-terrain.bin', sha256: sha(support) }, cells: [{ cell: descriptor.id, drawCalls: 1, triangles: 1, glbBytes: v.length, ktx2Bytes: 1, textureTexels: 1, collisionTriangles: 1 }], totals: { drawCalls: 1, ktx2Bytes: 1, textureTexels: 1, uniqueTextures: 1, residentTextureMiBEstimate: 1 }, budgets: { pass: true, drawCallsPerCellLimit: 20, residentTextureLimitMiB: 160, residencyMode: 'entire-release' } });
  writeJson(path.join(monument, 'placement.json'), { id: 'test-monument', originId: 'test-origin', source: { sha256: 'source-proof' } });
  writeJson(path.join(monument, 'build-report.json'), { output: { file: 'monument.glb', sha256: sha(a) }, triangles: 1, drawCalls: 1, textures: [{ dimensions: [1, 1], bytes: 1 }], residentBytesEstimate: 6 });
  writeJson(path.join(monument, 'granite-collider.json'), { id: 'test-monument', sourceSha256: 'source-proof', positions: [0, 0, 0, 1, 0, 0, 0, 0, 1], indices: [0, 2, 1] });
  return { folder, cells, monument, support, originalCollision: col, originalVisual: v, cleanup: () => { const resolved = path.resolve(folder); assert.ok(resolved.startsWith(work + path.sep) && path.basename(resolved).startsWith('alexander-integration-test-')); rmSync(resolved, { recursive: true }); } };
}

test('monument merge retains both nested scene roots, original collision and support while updating counts', async () => {
  const f = await fixture();
  try {
    const proof = await addCellMonument(f.cells, f.monument); assert.equal(proof.status, 'PASS');
    assert.equal(proof.cellAfter.visual.lod0.triangles, 2); assert.equal(proof.cellAfter.visual.lod0.drawCalls, 2); assert.equal(proof.cellAfter.collision.triangles, 2);
    assert.deepEqual(readFileSync(path.join(f.cells, 'runtime-terrain.bin')), f.support);
    const collision = parseCollisionBundle(readFileSync(path.join(f.cells, 'collision.hcol'))); assert.equal(collision.colliders.length, 2); assert.deepEqual(collision.colliders[0], parseCollisionBundle(f.originalCollision).colliders[0]);
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
    const doc = await io.readBinary(readFileSync(path.join(f.cells, 'visual.glb'))); const visible: string[] = [];
    doc.getRoot().getDefaultScene()!.traverse(n => { if (n.getMesh()) visible.push(n.getName()); }); assert.deepEqual(visible, ['existing-node', 'monument-node']);
    assert.ok(doc.getRoot().listExtensionsRequired().some(e => e.extensionName === 'KHR_mesh_quantization'), 'Normalized BYTE normals require quantization declaration');
    assert.deepEqual(readFileSync(path.join(f.cells, 'alexander-integration/before.lod0.glb')), Buffer.from(f.originalVisual));
    await assert.rejects(addCellMonument(f.cells, f.monument), /already integrated/);
  } finally { f.cleanup(); }
});

test('monument integration rejects changed source hashes before modifying any cell payload', async () => {
  const f = await fixture();
  try {
    writeFileSync(path.join(f.cells, 'visual.glb'), Buffer.from('unexpected bytes'));
    await assert.rejects(addCellMonument(f.cells, f.monument), /Expected values to be strictly equal/);
    assert.equal(existsSync(path.join(f.cells, 'alexander-integration')), false);
    assert.deepEqual(readFileSync(path.join(f.cells, 'collision.hcol')), Buffer.from(f.originalCollision));
    await assert.rejects(addCellMonument('apps/game/public/world/current', f.monument), /Only unpublished builds/);
  } finally { f.cleanup(); }
});
