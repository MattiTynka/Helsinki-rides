import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {gzipSync} from 'node:zlib';
import {test} from 'node:test';
import {encodeCollisionBundle} from '../../../packages/world-schema/src/index.ts';
import {prepareAcceptedCoverage, verifyAcceptedCoverage} from '../lib/accepted-coverage.ts';
import {sourceSha256} from '../lib/source-files.ts';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'accepted-coverage-')), source = path.join(root, 'source'), out = path.join(root, 'out');
  fs.mkdirSync(source);
  const decoded = encodeCollisionBundle({originId: 'test', frame: 'X-east,Y-up,Z-south', cell: 'c0', surfaceTags: ['ground']}, [{id: 'ground', group: 'ground', ref: null,
    positions: Float32Array.from([-3, 0, 0, 128, 0, 0, 128, 0, 128]), indices: Uint32Array.from([0, 2, 1]), triangleTags: Uint16Array.from([0])}]);
  const stored = gzipSync(decoded); fs.writeFileSync(path.join(source, 'collision.gz'), stored);
  const ref = {path: 'unused.bin', bytes: 1, sha256: '0'.repeat(64)};
  const manifest: any = {schemaVersion: 2, worldReleaseId: 'test', origin: {id: 'test', originProjected: [0, 0, 0]}, cellSize: 128, boundsRuntimeXZ: [0, 0, 128, 128],
    cells: [{id: 'c0', cx: 0, cz: 0, boundsXZ: [0, 0, 128, 128], visual: {lod0: ref}, collision: {path: 'collision.gz', bytes: stored.length, sha256: sourceSha256(stored), compression: 'gzip',
      decodedBytes: decoded.length, decodedSha256: sourceSha256(decoded), boundsXZ: [-3, 0, 128, 128], triangles: 1}, buildingIds: [], buildings: []}],
    terrain: {...ref, resolution: 1}, roads: ref, gameplay: ref, assets: [], sources: [{id: 'test'}], attribution: ['test'], lighting: 'lit-facades'};
  const save = () => {const bytes = Buffer.from(JSON.stringify(manifest)); fs.writeFileSync(path.join(source, 'manifest.json'), bytes); return sourceSha256(bytes);};
  return {root, source, out, manifest, save, decoded};
}

test('any manifest cell count produces exact decoded HCOL and separate owner/query bounds', t => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, {recursive: true, force: true})); const expected = f.save();
  const receipt = prepareAcceptedCoverage({source: f.source, out: f.out, expectedManifestSha256: expected});
  assert.equal(receipt.source.cells, 1); assert.equal(receipt.status, 'PASS_ACCEPTED_COLLISION_COVERAGE');
  const index = JSON.parse(fs.readFileSync(path.join(f.out, 'cells.json'), 'utf8'));
  assert.deepEqual(index.cells[0].sourceOwnerBoundsXZ, [0, 0, 128, 128]); assert.deepEqual(index.cells[0].boundsXZ, [-3, 0, 128, 128]);
  assert.deepEqual(fs.readFileSync(path.join(f.out, index.cells[0].collision.path)), Buffer.from(f.decoded));
  assert.equal(verifyAcceptedCoverage({source: f.source, coverage: f.out, expectedManifestSha256: expected}).status, 'PASS_ACCEPTED_COVERAGE_REBOUND');
  assert.throws(() => prepareAcceptedCoverage({source: f.source, out: f.out, expectedManifestSha256: expected}), /Fresh/);
  const corrupted = fs.readFileSync(path.join(f.out, index.cells[0].collision.path)); corrupted[corrupted.length - 1] = corrupted[corrupted.length - 1]! ^ 1;
  fs.writeFileSync(path.join(f.out, index.cells[0].collision.path), corrupted);
  assert.throws(() => verifyAcceptedCoverage({source: f.source, coverage: f.out, expectedManifestSha256: expected}), /SHA-256/);
});

test('coverage rejects incomplete ownership and collision extent or digest drift', t => {
  for (const change of [(m: any) => m.cells[0].buildingIds.push('missing'), (m: any) => m.cells[0].collision.boundsXZ[0] = 0,
    (m: any) => m.cells[0].collision.decodedSha256 = 'f'.repeat(64), (m: any) => m.cells[0].collision.path = '../collision.gz']) {
    const f = fixture(); t.after(() => fs.rmSync(f.root, {recursive: true, force: true})); change(f.manifest);
    assert.throws(() => prepareAcceptedCoverage({source: f.source, out: f.out, expectedManifestSha256: f.save()}));
  }
});

test('coverage treats a building with references in adjacent cells as one owner', t => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, {recursive: true, force: true}));
  f.manifest.cells[0].buildingIds = ['building'];
  f.manifest.cells[0].buildings = [{id: 'building', cell: 'c0', match: 'matched'}];
  const next = structuredClone(f.manifest.cells[0]); next.id = 'c1'; next.cx = 1; next.boundsXZ = [128, 0, 256, 128]; next.buildings = [];
  const bytes = encodeCollisionBundle({originId: 'test', frame: 'X-east,Y-up,Z-south', cell: 'c1', surfaceTags: ['ground']}, []);
  fs.writeFileSync(path.join(f.source, 'c1.bin'), bytes); next.collision = {path: 'c1.bin', bytes: bytes.length, sha256: sourceSha256(bytes), triangles: 0, boundsXZ: next.boundsXZ};
  f.manifest.cells.push(next);
  const receipt = prepareAcceptedCoverage({source: f.source, out: f.out, expectedManifestSha256: f.save()});
  assert.equal(receipt.buildingOwners, 1);
  const owners = JSON.parse(fs.readFileSync(path.join(f.out, 'accepted-building-owners.json'), 'utf8'));
  assert.deepEqual(owners.buildings[0].referencedByCells, ['c0', 'c1']);
});
