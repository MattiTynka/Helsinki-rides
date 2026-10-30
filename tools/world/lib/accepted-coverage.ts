import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {gunzipSync} from 'node:zlib';
import {MAX_SIMULATION_PAYLOAD_BYTES, parseCollisionBundle, validateWorldManifest, type WorldManifest} from '../../../packages/world-schema/src/index.ts';
import {readSourceFile, sourceFile, sourceSha256, writeSourceJson} from './source-files.ts';

export interface AcceptedCoverageOptions {source: string; expectedManifestSha256: string; out: string}

function readManifest(source: string, expected: string) {
  assert.match(expected, /^[a-f0-9]{64}$/, 'Expected manifest digest is required');
  const bytes = fs.readFileSync(sourceFile(source, 'manifest.json'));
  assert.equal(sourceSha256(bytes), expected, 'Accepted manifest changed');
  const manifest = JSON.parse(bytes.toString('utf8')) as WorldManifest;
  assert.deepEqual(validateWorldManifest(manifest), [], 'Invalid accepted world manifest');
  assert.ok(manifest.cells.length > 0 && manifest.cells.length <= 10000, 'Accepted cell count outside bounds');
  return manifest;
}

/** Coverage boxes follow actual collision extents. Owner boxes and building identity remain separate. */
export function prepareAcceptedCoverage(options: AcceptedCoverageOptions) {
  const source = fs.realpathSync(options.source), out = path.resolve(options.out);
  assert.ok(out !== source && !out.startsWith(source + path.sep) && !source.startsWith(out + path.sep), 'Coverage input/output overlap');
  assert.ok(!fs.existsSync(out), 'Fresh coverage output directory required');
  const manifest = readManifest(source, options.expectedManifestSha256);
  const owners = new Map<string, {id: string; ownerCell: string; recordSha256: string}>();
  const references = new Map<string, string[]>();
  for (const cell of manifest.cells) {
    assert.match(cell.id, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
    assert.ok(Number.isSafeInteger(cell.cx) && Number.isSafeInteger(cell.cz));
    assert.deepEqual(cell.boundsXZ, [cell.cx * manifest.cellSize, cell.cz * manifest.cellSize, (cell.cx + 1) * manifest.cellSize, (cell.cz + 1) * manifest.cellSize], 'Non-grid owner bounds');
    assert.ok(Array.isArray(cell.buildingIds) && new Set(cell.buildingIds).size === cell.buildingIds.length, 'Invalid building references');
    for (const id of cell.buildingIds) {
      assert.ok(typeof id === 'string' && id.length > 0 && id.length <= 512);
      const cells = references.get(id) ?? []; cells.push(cell.id); references.set(id, cells);
    }
    for (const building of cell.buildings) {
      assert.equal(building.cell, cell.id, 'Building owner differs from containing cell');
      assert.ok(cell.buildingIds.includes(building.id), 'Owner record is not referenced by its cell');
      assert.ok(!owners.has(building.id), 'Duplicate building owner');
      owners.set(building.id, {id: building.id, ownerCell: cell.id, recordSha256: sourceSha256(JSON.stringify(building))});
    }
  }
  assert.deepEqual([...references.keys()].sort(), [...owners.keys()].sort(), 'Building reference has no unique owner');
  fs.mkdirSync(path.join(out, 'collision'), {recursive: true});
  const cells = [], checks = [];
  let totalDecodedBytes = 0, maxDecodedBytes = 0;
  for (const cell of manifest.cells) {
    const ref = cell.collision, encoded = readSourceFile(source, ref);
    const decoded = ref.compression === 'gzip' ? gunzipSync(encoded, {maxOutputLength: MAX_SIMULATION_PAYLOAD_BYTES}) : encoded;
    assert.ok(decoded.length <= MAX_SIMULATION_PAYLOAD_BYTES);
    if (ref.compression) {
      assert.equal(decoded.length, ref.decodedBytes, 'Decoded collision length mismatch');
      assert.equal(sourceSha256(decoded), ref.decodedSha256, 'Decoded collision digest mismatch');
    }
    // Copy into aligned storage before interpreting HCOL typed-array slices.
    const bundle = parseCollisionBundle(Uint8Array.from(decoded));
    assert.equal(bundle.header.cell, cell.id, 'Collision cell mismatch');
    assert.equal(bundle.header.originId, manifest.origin.id, 'Collision origin mismatch');
    assert.equal(bundle.header.frame, 'X-east,Y-up,Z-south');
    const actual = [Infinity, Infinity, -Infinity, -Infinity];
    let triangles = 0, groundTriangles = 0, kerbTriangles = 0;
    const colliderIds = new Set<string>();
    for (const collider of bundle.colliders) {
      assert.ok(!colliderIds.has(collider.id), 'Duplicate collider ID'); colliderIds.add(collider.id);
      assert.equal(collider.positions.length % 3, 0);
      assert.equal(collider.indices.length % 3, 0);
      assert.equal(collider.triangleTags.length, collider.indices.length / 3);
      assert.ok(collider.positions.every(Number.isFinite), 'Nonfinite collider position');
      assert.ok(collider.indices.every(index => index < collider.positions.length / 3), 'Collision index out of range');
      assert.ok(collider.triangleTags.every(tag => tag < bundle.header.surfaceTags.length), 'Collision tag out of range');
      if (collider.group === 'buildings' || collider.group === 'citymodel') assert.ok(collider.ref !== null && owners.has(collider.ref), 'Building collider has no accepted owner');
      for (let i = 0; i < collider.positions.length; i += 3) {
        actual[0] = Math.min(actual[0]!, collider.positions[i]!); actual[1] = Math.min(actual[1]!, collider.positions[i + 2]!);
        actual[2] = Math.max(actual[2]!, collider.positions[i]!); actual[3] = Math.max(actual[3]!, collider.positions[i + 2]!);
      }
      triangles += collider.indices.length / 3;
      if (collider.group === 'ground') groundTriangles += collider.indices.length / 3;
      if (collider.group === 'kerbs') kerbTriangles += collider.indices.length / 3;
    }
    assert.equal(triangles, ref.triangles, 'Collision triangle count mismatch');
    const bounds = ref.boundsXZ;
    assert.ok(bounds && bounds.length === 4 && bounds.every(Number.isFinite), 'Recorded collision extent required');
    if (actual.every(Number.isFinite)) assert.ok(actual[0]! >= bounds[0] && actual[1]! >= bounds[1] && actual[2]! <= bounds[2] && actual[3]! <= bounds[3], 'Recorded collision extent misses geometry');
    const file = `collision/${cell.id}.bin`, digest = sourceSha256(decoded);
    fs.writeFileSync(sourceFile(out, file), decoded, {flag: 'wx'});
    cells.push({id: cell.id, cx: cell.cx, cz: cell.cz, boundsXZ: bounds, sourceOwnerBoundsXZ: cell.boundsXZ,
      collision: {path: file, sha256: digest, bytes: decoded.length, triangles, boundsXZ: bounds}});
    checks.push({cell: cell.id, encodedSource: ref, sourceOwnerBoundsXZ: cell.boundsXZ, coverageQueryBoundsXZ: bounds,
      actualBoundsXZ: actual.every(Number.isFinite) ? actual : null, decodedSha256: digest, decodedBytes: decoded.length, groundTriangles, kerbTriangles});
    totalDecodedBytes += decoded.length; maxDecodedBytes = Math.max(maxDecodedBytes, decoded.length);
  }
  // Rebind after reading every payload; a moving input may not produce a successful receipt.
  readManifest(source, options.expectedManifestSha256);
  const index = writeSourceJson(out, 'cells.json', {schemaVersion: 1, kind: 'accepted-ground-coverage-proxy-only', originId: manifest.origin.id,
    cellSize: manifest.cellSize, cells, note: 'Private ground subtraction index; collision extents are query bounds, not cell ownership or a publishable world.'});
  const buildings = writeSourceJson(out, 'accepted-building-owners.json', {schemaVersion: 1, acceptedManifestSha256: options.expectedManifestSha256,
    buildings: [...owners.values()].sort((a, b) => a.id.localeCompare(b.id)).map(owner => ({...owner, referencedByCells: references.get(owner.id)!.sort()}))});
  const receipt = {schemaVersion: 1, status: 'PASS_ACCEPTED_COLLISION_COVERAGE', source: {manifestSha256: options.expectedManifestSha256, worldReleaseId: manifest.worldReleaseId, cells: manifest.cells.length},
    output: {indexSha256: index.sha256, buildingOwnersSha256: buildings.sha256}, buildingOwners: owners.size,
    totalDecodedBytes, maxDecodedBytes, capPerDecodedPayload: MAX_SIMULATION_PAYLOAD_BYTES,
    collisionBytesAndTypedArraysExact: true, sourceOwnershipUnmodified: true, checks,
    sourceRefs: manifest.cells.map(cell => ({id: cell.id, collision: cell.collision})),
    producerSha256: sourceSha256(fs.readFileSync(import.meta.filename))};
  writeSourceJson(out, 'coverage-adapter.json', receipt);
  return receipt;
}

export function verifyAcceptedCoverage(options: {source: string; expectedManifestSha256: string; coverage: string}) {
  const manifest = readManifest(options.source, options.expectedManifestSha256);
  const receipt = JSON.parse(fs.readFileSync(sourceFile(options.coverage, 'coverage-adapter.json'), 'utf8'));
  assert.equal(receipt.status, 'PASS_ACCEPTED_COLLISION_COVERAGE');
  assert.equal(receipt.source.manifestSha256, options.expectedManifestSha256);
  assert.equal(receipt.source.cells, manifest.cells.length);
  const indexBytes = fs.readFileSync(sourceFile(options.coverage, 'cells.json'));
  assert.equal(sourceSha256(indexBytes), receipt.output.indexSha256, 'Coverage index drift');
  assert.equal(sourceSha256(fs.readFileSync(sourceFile(options.coverage, 'accepted-building-owners.json'))), receipt.output.buildingOwnersSha256, 'Owner index drift');
  const index = JSON.parse(indexBytes.toString('utf8'));
  assert.equal(index.cells.length, manifest.cells.length);
  for (const cell of manifest.cells) {
    assert.deepEqual(receipt.sourceRefs.find((ref: {id: string}) => ref.id === cell.id)?.collision, cell.collision, 'Coverage collision authority differs');
    const proxy = index.cells.find((entry: {id: string}) => entry.id === cell.id);
    assert.ok(proxy, 'Coverage cell missing');
    const raw = readSourceFile(options.coverage, proxy.collision);
    assert.equal(sourceSha256(raw), cell.collision.decodedSha256 ?? cell.collision.sha256, 'Coverage decoded bytes differ from accepted collision');
    readSourceFile(options.source, cell.collision);
  }
  return {status: 'PASS_ACCEPTED_COVERAGE_REBOUND', cells: manifest.cells.length, manifestSha256: options.expectedManifestSha256, indexSha256: receipt.output.indexSha256};
}
