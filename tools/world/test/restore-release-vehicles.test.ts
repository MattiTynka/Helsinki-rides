import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { FileRef, GameplayBundle, VehicleDefinition, WorldManifest } from '../../../packages/world-schema/src/index.ts';
import { restoreReleaseVehicles } from '../restore-release-vehicles.ts';

const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
type PublishedManifest = WorldManifest & { publicationFiles: FileRef[]; customPreservedField: { revision: string } };
function payload(root: string, name: string, text: string): FileRef {
  const bytes = Buffer.from(text), target = path.join(root, name);
  mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, bytes);
  return { path: name, bytes: bytes.length, sha256: hash(bytes) };
}
function definition(id: string): VehicleDefinition {
  return { id, label: id, assetId: `vehicle-${id}`, massKg: 1000, wheels: [{}, {}, {}], collider: { halfExtents: [1, 1, 2] },
    engine: { topSpeedMs: 30 }, seat: { entryRadius: 2, exits: [[2, 0, 0]] } } as unknown as VehicleDefinition;
}
function world(root: string, historical = false): { manifest: PublishedManifest; gameplay: GameplayBundle } {
  mkdirSync(root);
  const revision = historical ? 'historical' : 'current', ids = historical ? ['lumi', 'revontuli', 'kaamos'] : ['lumi'];
  const gameplay = {
    schemaVersion: 2, originId: 'helsinki-native', killHeight: -90, playArea: { minX: -500, maxX: 500, minZ: -500, maxZ: 500 },
    player: { spawn: { position: [historical ? 4 : 32, 8], headingDeg: 90 }, health: 100, armour: 7 },
    vehicleDefinitions: ids.map(definition), vehicles: ids.map((id, i) => ({ id: `${id}-parked`, definition: id, position: [i * 20, 10], headingDeg: 100 + i, occupied: false })),
    anchors: [{ id: 'hospital', kind: 'hospital', destinationName: 'hospital' }, { id: 'police', kind: 'police', destinationName: 'police' }],
    weapons: [{ id: 'pistol' }], wanted: { starThresholds: [1, 2, 3, 4, 5], unitCaps: [1, 2, 3, 4, 5] },
    police: { patrolSpawns: [{ position: [1, 1] }, { position: [2, 2] }] }, addresses: [{ label: revision, position: [1, 1], headingDeg: 9 }],
    landmarks: [], district: { name: revision, boundary: [] }, playerStart: { weapons: [] },
  } as unknown as GameplayBundle;
  const visual = (name: string) => ({ ...payload(root, `cells/${name}.${revision}.glb`, `${name}-${revision}`), triangles: 2, drawCalls: 1, atlases: 0, textureBytesEstimate: 0 });
  const manifest: PublishedManifest = {
    schemaVersion: 2, worldReleaseId: `${revision}-original`, status: 'PILOT', builtAt: '2026-10-19T00:00:00Z',
    origin: { id: 'helsinki-native', originProjected: [1, 2, 3] }, coordinateFrame: { crs: 'EPSG:3879', heightDatum: 'N2000', runtimeAxes: 'X-east,Y-up,Z-south', units: 'meter' },
    cellSize: 128, boundsRuntimeXZ: [-500, -500, 500, 500],
    cells: Array.from({ length: historical ? 1 : 2 }, (_, i) => ({
      id: `cell-${i}`, cx: i, cz: 0, boundsXZ: [i * 128, 0, (i + 1) * 128, 128], visual: { lod0: visual(`cell-${i}`), lod2: visual(`cell-${i}-coarse`) },
      collision: { ...payload(root, `cells/cell-${i}.${revision}.hcol`, `collision-${i}-${revision}`), triangles: 1 }, buildings: [], buildingIds: [], sourceTiles: [revision],
    })),
    terrain: { ...payload(root, 'terrain.bin', `${revision}-terrain`), x0: 0, z0: 0, resolution: 1, nx: 2, nz: 2 }, roads: payload(root, 'roads.json', `${revision}-roads`),
    gameplay: payload(root, 'gameplay.original.json', JSON.stringify(gameplay)),
    assets: ids.map(id => ({ id: `vehicle-${id}`, kind: 'vehicle', ...payload(root, `assets/${id}.${revision}.glb`, `${id}-${revision}-asset`) })),
    simulation: { engine: 'native', version: revision, tickHz: 60 }, sources: [{ id: 'source', title: revision, url: 'https://example.org/', license: 'CC BY 4.0', attribution: revision }],
    attribution: [revision], lighting: 'lit-facades', publicationFiles: [payload(root, 'publication/license.md', `${revision}-license`)], customPreservedField: { revision },
  };
  writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest));
  return { manifest, gameplay };
}
function scratch() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'helsinki-restore-vehicles-'));
  const source = path.join(root, 'current'), vehicleSource = path.join(root, 'old'), out = path.join(root, 'fresh');
  const current = world(source), old = world(vehicleSource, true);
  return { root, source, vehicleSource, out, current, old, options: { source, vehicleSource, out, vehicles: ['revontuli', 'kaamos'], release: 'fresh-with-vehicles', report: path.join(root, 'receipt.json') } };
}
function snapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory)) {
      const file = path.join(directory, name);
      if (lstatSync(file).isDirectory()) visit(file);
      else result[path.relative(root, file)] = hash(readFileSync(file));
    }
  };
  visit(root); return result;
}
function saveManifest(root: string, manifest: PublishedManifest): void { writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest)); }
function saveGameplay(root: string, manifest: PublishedManifest, gameplay: GameplayBundle): void {
  Object.assign(manifest, { gameplay: payload(root, manifest.gameplay.path, JSON.stringify(gameplay)) }); saveManifest(root, manifest);
}

test('vehicle restoration preserves the entire current city and gameplay while adding only selected historical vehicles', async () => {
  const f = scratch();
  try {
    const beforeCurrent = snapshot(f.source), beforeOld = snapshot(f.vehicleSource);
    const pointer = path.join(f.root, 'current.json'); writeFileSync(pointer, '{"release":"keep-this"}');
    const receipt = await restoreReleaseVehicles(f.options);
    const output = JSON.parse(readFileSync(path.join(f.out, 'manifest.json'), 'utf8')) as PublishedManifest;
    const merged = JSON.parse(readFileSync(path.join(f.out, output.gameplay.path), 'utf8')) as GameplayBundle;
    const omitChanged = ({ worldReleaseId: _id, builtAt: _time, gameplay: _gameplay, assets: _assets, ...rest }: WorldManifest) => rest;
    assert.deepEqual(omitChanged(output), omitChanged(f.current.manifest));
    assert.equal(output.cells.length, 2, 'historical city has only one cell and must never replace the expanded current city');
    assert.deepEqual(output.assets.slice(0, f.current.manifest.assets.length), f.current.manifest.assets);
    assert.deepEqual(merged, { ...f.current.gameplay, vehicleDefinitions: [...f.current.gameplay.vehicleDefinitions, ...f.old.gameplay.vehicleDefinitions.slice(1)], vehicles: [...f.current.gameplay.vehicles, ...f.old.gameplay.vehicles.slice(1)] });
    for (const [file, digest] of Object.entries(beforeCurrent)) {
      if (file === 'manifest.json' || file === f.current.manifest.gameplay.path) continue;
      assert.equal(hash(readFileSync(path.join(f.out, file))), digest, file);
    }
    assert.deepEqual(snapshot(f.source), beforeCurrent); assert.deepEqual(snapshot(f.vehicleSource), beforeOld);
    assert.equal(readFileSync(pointer, 'utf8'), '{"release":"keep-this"}');
    assert.match(output.gameplay.path, /^gameplay\.[a-f0-9]{12}\.json$/);
    assert.equal(receipt.manifestSha256, hash(readFileSync(path.join(f.out, 'manifest.json'))));
    assert.equal(receipt.sourceManifestSha256, beforeCurrent['manifest.json']);
    assert.deepEqual(receipt.addedSpawnIds, ['revontuli-parked', 'kaamos-parked']);
    assert.ok(receipt.linkedPayloads > 0); assert.ok(statSync(path.join(f.out, output.terrain.path)).nlink >= 2);
    assert.deepEqual(JSON.parse(readFileSync(f.options.report, 'utf8')), receipt);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

for (const kind of ['cell', 'publication', 'selected-asset', 'historical-gameplay'] as const) test(`tampered ${kind} payload is rejected before any output is created`, async () => {
  const f = scratch();
  try {
    const [root, ref] = kind === 'cell' ? [f.source, f.current.manifest.cells[0]!.visual.lod0]
      : kind === 'publication' ? [f.source, f.current.manifest.publicationFiles[0]!]
        : kind === 'selected-asset' ? [f.vehicleSource, f.old.manifest.assets[1]!]
          : [f.vehicleSource, f.old.manifest.gameplay];
    const bytes = readFileSync(path.join(root, ref.path)); bytes[0] = bytes[0]! ^ 1; writeFileSync(path.join(root, ref.path), bytes);
    await assert.rejects(restoreReleaseVehicles(f.options), /SHA-256 verification failed/);
    assert.equal(existsSync(f.out), false); assert.equal(existsSync(f.options.report), false);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

for (const kind of ['definition', 'spawn', 'asset', 'payload-path', 'duplicate-donor'] as const) test(`conflicting ${kind} IDs or payload paths are rejected without overwriting the current world`, async () => {
  const f = scratch();
  try {
    if (kind === 'definition') saveGameplay(f.source, f.current.manifest, { ...f.current.gameplay, vehicleDefinitions: [...f.current.gameplay.vehicleDefinitions, definition('revontuli')] });
    if (kind === 'spawn') saveGameplay(f.source, f.current.manifest, { ...f.current.gameplay, vehicles: [{ ...f.current.gameplay.vehicles[0]!, id: 'revontuli-parked' }] });
    if (kind === 'asset') { Object.assign(f.current.manifest.assets[0]!, { id: 'vehicle-revontuli' }); saveManifest(f.source, f.current.manifest); }
    if (kind === 'payload-path') {
      const ref = payload(f.vehicleSource, f.current.manifest.assets[0]!.path, 'different-selected-vehicle');
      Object.assign(f.old.manifest.assets[1]!, ref); saveManifest(f.vehicleSource, f.old.manifest);
    }
    if (kind === 'duplicate-donor') saveGameplay(f.vehicleSource, f.old.manifest, { ...f.old.gameplay, vehicleDefinitions: [...f.old.gameplay.vehicleDefinitions, f.old.gameplay.vehicleDefinitions[1]!] });
    const before = snapshot(f.source);
    await assert.rejects(restoreReleaseVehicles(f.options), /already exists|conflict|Duplicate/);
    assert.equal(existsSync(f.out), false); assert.deepEqual(snapshot(f.source), before);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('different origins, absent assets and unsafe publication paths fail before writing a derivative', async () => {
  for (const kind of ['origin', 'asset', 'path']) {
    const f = scratch();
    try {
      if (kind === 'origin') Object.assign(f.old.manifest.origin, { originProjected: [5, 6, 7] });
      if (kind === 'asset') Object.assign(f.old.manifest, { assets: [f.old.manifest.assets[0], f.old.manifest.assets[2]] });
      if (kind === 'path') Object.assign(f.current.manifest.publicationFiles[0]!, { path: '../escape' });
      saveManifest(f.vehicleSource, f.old.manifest); saveManifest(f.source, f.current.manifest);
      await assert.rejects(restoreReleaseVehicles(f.options), /different world origin|asset is missing|Unsafe payload/);
      assert.equal(existsSync(f.out), false);
    } finally { rmSync(f.root, { recursive: true, force: true }); }
  }
});

test('pre-existing outputs and reports are never overwritten', async () => {
  const f = scratch();
  try {
    mkdirSync(f.out); writeFileSync(path.join(f.out, 'keep.txt'), 'keep');
    await assert.rejects(restoreReleaseVehicles(f.options), /already exists/);
    assert.equal(readFileSync(path.join(f.out, 'keep.txt'), 'utf8'), 'keep');
    const another = path.join(f.root, 'another'); writeFileSync(f.options.report, 'keep-report');
    await assert.rejects(restoreReleaseVehicles({ ...f.options, out: another }), /Report must be a fresh/);
    assert.equal(existsSync(another), false); assert.equal(readFileSync(f.options.report, 'utf8'), 'keep-report');
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('symbolic links and Windows junctions are rejected instead of following payloads', () => {
  const f = scratch();
  try {
    const link = path.join(f.root, 'linked-source');
    symlinkSync(f.source, link, process.platform === 'win32' ? 'junction' : 'dir');
    return assert.rejects(restoreReleaseVehicles({ ...f.options, source: link }), /symbolic links or junctions/)
      .finally(() => rmSync(f.root, { recursive: true, force: true }));
  } catch (error) {
    rmSync(f.root, { recursive: true, force: true }); throw error;
  }
});
