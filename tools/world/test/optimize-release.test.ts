import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { Document, NodeIO } from '@gltf-transform/core';
import { KHRMaterialsUnlit } from '@gltf-transform/extensions';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function mesh(coarse: boolean): Promise<Uint8Array> {
  const doc = new Document(), buffer = doc.createBuffer(), unlit = doc.createExtension(KHRMaterialsUnlit);
  const material = doc.createMaterial('ground').setDoubleSided(true).setExtension('KHR_materials_unlit', unlit.createUnlit());
  if (!coarse) material.setBaseColorTexture(doc.createTexture('pixel').setMimeType('image/png').setImage(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')));
  const positions = doc.createAccessor().setBuffer(buffer).setType('VEC3').setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]));
  const indices = doc.createAccessor().setBuffer(buffer).setType('SCALAR').setArray(new Uint16Array([0, 2, 1, 0, 2, 1]));
  const primitive = doc.createPrimitive().setAttribute('POSITION', positions).setIndices(indices).setMaterial(material);
  primitive.setAttribute(coarse ? 'COLOR_0' : 'TEXCOORD_0', doc.createAccessor().setBuffer(buffer).setType(coarse ? 'VEC3' : 'VEC2').setArray(new Float32Array(coarse ? [1, 1, 1, 1, 1, 1, 1, 1, 1] : [0, 0, 1, 0, 0, 1])));
  doc.createScene().addChild(doc.createNode('c_p00_p00_ground_slabs').setMesh(doc.createMesh('c_p00_p00_ground_slabs').addPrimitive(primitive)));
  doc.getRoot().getAsset().copyright = 'Synthetic CC0 fixture';
  return new NodeIO().registerExtensions([KHRMaterialsUnlit]).writeBinary(doc);
}

test('release optimization keeps its baseline immutable, shares images and restores exact physics bytes', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'helsinki-optimize-')), source = path.join(temp, 'source'), output = path.join(temp, 'output');
  fs.mkdirSync(source);
  try {
    const payload = (name: string, bytes: Uint8Array) => {
      const file = path.join(source, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
      return { path: name, bytes: bytes.length, sha256: hash(bytes) };
    };
    const near = payload('cells/near.glb', await mesh(false)), far = payload('cells/far.glb', await mesh(true));
    const collision = payload('cells/cell.hcol', new Uint8Array(4096).fill(7)), terrain = payload('terrain.bin', new Uint8Array(16384).fill(2));
    const roads = payload('roads.json', Buffer.from('{"edges":[]}')), gameplay = payload('gameplay.json', Buffer.from('{"unchanged":true}'));
    const asset = payload('assets/pistol.glb', await mesh(false));
    const visual = (ref: typeof near, atlases: number) => ({ ...ref, triangles: 2, drawCalls: 1, atlases, textureBytesEstimate: atlases * 8 });
    const manifest = { schemaVersion: 2, worldReleaseId: 'synthetic-original', status: 'PILOT', builtAt: '2026-01-01T00:00:00Z', coordinateFrame: { crs: 'EPSG:3879', heightDatum: 'N2000', runtimeAxes: 'X-east,Y-up,Z-south', units: 'meter' }, origin: { id: 'synthetic', originProjected: [0, 0, 0] }, cellSize: 128, boundsRuntimeXZ: [0, 0, 128, 128], cells: [{ id: 'c_p00_p00', cx: 0, cz: 0, boundsXZ: [0, 0, 128, 128], visual: { lod0: visual(near, 1), lod2: visual(far, 0) }, collision: { ...collision, triangles: 2 }, buildings: [], buildingIds: [], sourceTiles: [] }], terrain: { ...terrain, resolution: 1, nx: 64, nz: 64, x0: 0, z0: 0 }, roads, gameplay, assets: [{ ...asset, id: 'prop-pistol', kind: 'prop' }], sources: [{ id: 'synthetic', title: 'Synthetic', url: 'https://example.org/', license: 'CC0', attribution: 'Synthetic' }], attribution: ['Synthetic'], lighting: 'unlit-facades', simulation: { engine: 'synthetic', version: '1', tickHz: 60 } };
    const manifestBytes = Buffer.from(JSON.stringify(manifest)); fs.writeFileSync(path.join(source, 'manifest.json'), manifestBytes);
    const args = ['tools/world/optimize_release.ts', '--source', source, '--out', output, '--release', 'synthetic-optimized', '--report', path.join(temp, 'receipt.json')];
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 60000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(fs.readFileSync(path.join(source, 'manifest.json')), manifestBytes);
    const optimized = JSON.parse(fs.readFileSync(path.join(output, 'manifest.json'), 'utf8'));
    assert.equal(optimized.cells.length, 1); assert.deepEqual(optimized.cells[0].boundsXZ, [0, 0, 128, 128]);
    assert.equal(optimized.cells[0].visual.lod0.triangles, 1, 'only an identical redundant triangle is removed');
    assert.equal(optimized.sharedTextures.length, 1);
    const image = optimized.sharedTextures[0], imageBytes = fs.readFileSync(path.join(output, image.path));
    assert.equal(hash(imageBytes), image.sha256); assert.equal(path.basename(image.path, '.png'), image.sha256);
    for (const [before, after] of [[terrain, optimized.terrain], [collision, optimized.cells[0].collision]]) {
      assert.equal(after.compression, 'gzip');
      assert.deepEqual(gunzipSync(fs.readFileSync(path.join(output, after.path))), fs.readFileSync(path.join(source, before.path)));
      assert.equal(after.decodedSha256, before.sha256);
    }
    assert.deepEqual(optimized.roads, roads); assert.deepEqual(optimized.gameplay, gameplay);
    assert.ok(fs.existsSync(path.join(source, near.path)));
    const second = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 60000, windowsHide: true });
    assert.notEqual(second.status, 0, 'existing outputs must never be overwritten');
  } finally {
    assert.ok(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(temp).startsWith('helsinki-optimize-'));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
