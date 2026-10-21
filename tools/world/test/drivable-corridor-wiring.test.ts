import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { RoadGraph, TerrainGrid } from '../../../packages/world-schema/src/index.ts';
import { createGroundSupportSampler } from '../lib/carriageway-grade.ts';
import { buildDistrictGround, type CachedGroundAssembly, type DistrictGroundConfig } from '../lib/district-ground.ts';
import type { DrivableCorridorPlan } from '../lib/drivable-corridors.ts';

const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'helsinki-corridor-wiring-'));
  const write = (name: string, value: unknown) => { const filename = path.join(directory, name); writeFileSync(filename, JSON.stringify(value)); return filename; };
  const osm = write('osm.json', { elements: [] });
  const osmSha = sha(readFileSync(osm));
  const ledger = write('ledger.json', { snapshots: { test: { path: 'osm.json', sha256: osmSha } } });
  const streetParts = write('parts.geojson', { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { osan_id: 'asphalt-shared', paatyyppi: 'Kevyt liikenne', alatyyppi: 'Kevyt liikenne', materiaali: 'Asfalttibetoni' }, geometry: { type: 'Polygon', coordinates: [[[0, -3], [16, -3], [16, 3], [0, 3], [0, -3]]] } }] });
  const graph: RoadGraph = { schemaVersion: 2, originId: 'test', source: { id: 'source-osm', sha256: osmSha, attribution: 'test', license: 'ODbL' }, nodes: [{id:'a',kind:'end',position:[0,0,0]},{id:'b',kind:'end',position:[16,0,0]}], connectors: [], parking: [], footways: [], lanes: [{ id: '1:0:f0', wayId: 1, name: null, highway: 'service', surface: 'asphalt', speedLimit: 5, width: 3, from: 'a', to: 'b', points: [[0, 0, 0], [8, 0, 0], [16, 0, 0]], length: 16, index: 0, count: 1 }] };
  const roads = write('roads.json', graph);
  const plan: DrivableCorridorPlan = { schemaVersion: 1, sourceHashes: { roads: sha(readFileSync(roads)), osm: osmSha, streetParts: sha(readFileSync(streetParts)) }, vehicleHalfWidthMetres: .967, marginMetres: .15,
    reviewedGeometry: { baselineRoadsSha256: sha(readFileSync(roads)), lanePointsSha256: { '1:0:f0': sha(JSON.stringify(graph.lanes[0]!.points)) } },
    corridors: [{ id: 'reviewed-driveway', wayId: 1, laneIds: ['1:0:f0'], stationsMetres: { '1:0:f0': [2, 14] }, sourcePartIds: ['asphalt-shared'], reason: 'Reviewed source asphalt driveway' }] };
  const planPath = write('plan.json', plan);
  const config: DistrictGroundConfig = { cellSize: 128, playArea: { minX: -16, maxX: 20, minZ: -16, maxZ: 16 }, curbHeight: .12,
    registerStairs: { joinDistance: .3, minSlope: .05, maxEdgeAngleDeg: 30, minFill: .8, maxWayAngleDeg: 35, riser: .16, minRiser: .08 },
    entranceTerraces: { openingRadius: 4, minRise: .2, maxFootprintDistance: 1, maxStepsDistance: 1.5, pad: 1, riser: .16, raster: .5 }, retainingWalls: { sideDistance: 2, minHeight: .5, gap: .02 },
    carriagewayGrade: { protectedArea: { minX: -100, maxX: -80, minZ: -100, maxZ: -80 }, protectedMarginMetres: 8, gridMetres: 4, maxAxisGrade: .35 },
    drivableCorridors: { plan: planPath, roads } };
  const terrain: TerrainGrid = { x0: -20, z0: -20, nx: 41, nz: 41, resolution: 1, heights: new Float32Array(1681) };
  const cache = new Map<string, CachedGroundAssembly>(), reads: string[] = [], writes: string[] = [];
  const options = { terrain, footprints: [], originProjected: [0, 0, 0], config, osmLedger: ledger, osmSnapshot: 'test', streetParts,
    groundCache: { read(key: string) { reads.push(key); return cache.has(key) ? structuredClone(cache.get(key)!) : null; }, write(key: string, value: CachedGroundAssembly) { writes.push(key); cache.set(key, structuredClone(value)); } } };
  const cleanup = () => { assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith('helsinki-corridor-wiring-')); rmSync(directory, { recursive: true, force: true }); };
  return { options, roads, graph, plan, planPath, write, reads, writes, cleanup };
}

test('district assembly applies a reviewed corridor once and caches its source-bound audit', t => {
  const f = fixture(); t.after(f.cleanup);
  const first = buildDistrictGround(f.options), second = buildDistrictGround(f.options);
  assert.equal(f.writes.length, 1); assert.equal(f.reads.length, 2); assert.equal(f.reads[0], f.reads[1]);
  assert.equal(first.carriagewayGrade!.drivableCorridors!.stats.corridors, 1);
  assert.equal(second.carriagewayGrade!.drivableCorridors!.roadsSha256, f.plan.sourceHashes.roads);
  assert.deepEqual(first.ground, second.ground);
  const support = createGroundSupportSampler([...first.ground.pieces, ...first.ground.kerbs]);
  assert.ok(Math.abs(support(8, 0)!.height) < 1e-8, 'The source shared sidewalk becomes the actual constrained driveway surface');
});

test('plan and graph content changes invalidate the same-path authored-ground cache', t => {
  const f = fixture(); t.after(f.cleanup);
  buildDistrictGround(f.options);
  const graph = { ...f.graph, lanes: f.graph.lanes.map(l => ({ ...l })) };
  graph.lanes[0]!.name = 'Reviewed source name update'; f.write('roads.json', graph);
  const updated = { ...f.plan, sourceHashes: { ...f.plan.sourceHashes, roads: sha(readFileSync(f.roads)) } };
  f.write('plan.json', updated); buildDistrictGround(f.options);
  f.write('plan.json', { ...updated, corridors: [{ ...updated.corridors[0]!, stationsMetres: { '1:0:f0': [3, 13] } }] });
  buildDistrictGround(f.options);
  assert.equal(f.writes.length, 3); assert.equal(new Set(f.writes).size, 3);
});

test('stale hashes and changed literal axes are rejected before any cache read', t => {
  const f = fixture(); t.after(f.cleanup);
  buildDistrictGround(f.options); const reads = f.reads.length;
  const graph = { ...f.graph, lanes: f.graph.lanes.map(l => ({ ...l, points: l.points.map(p => [...p]) })) };
  graph.lanes[0]!.points[1]![0] = 8.1; f.write('roads.json', graph);
  assert.throws(() => buildDistrictGround(f.options), /roads hash changed/);
  assert.equal(f.reads.length, reads);
  f.write('plan.json', { ...f.plan, sourceHashes: { ...f.plan.sourceHashes, roads: sha(readFileSync(f.roads)) } });
  assert.throws(() => buildDistrictGround(f.options), /reviewed literal geometry/);
  assert.equal(f.reads.length, reads, 'Updating a graph hash does not make an unreviewed axis eligible for a cached result');
});
