import assert from 'node:assert/strict';
import test from 'node:test';
import type { RoadGraph, TerrainGrid } from '../../../packages/world-schema/src/index.ts';
import { createGroundSupportSampler } from '../lib/carriageway-grade.ts';
import { applyDrivableCorridors, resolveDrivableCorridors, type DrivableCorridorPlan } from '../lib/drivable-corridors.ts';
import { bbox, pointInPolygon, type LocalPolygon, type Pt } from '../lib/geometry.ts';
import { buildGround, type GroundPiece } from '../lib/ground.ts';

const hashes = { roads: 'a'.repeat(64), osm: 'b'.repeat(64), streetParts: 'c'.repeat(64) };
const keep = { minX: -100, maxX: -80, minZ: -100, maxZ: -80 };
function polygon(id: string, ring: Pt[], main = 'Kevyt liikenne', sub = 'Kevyt liikenne'): LocalPolygon {
  return { id, rings: [ring], bbox: bbox([ring]), properties: { paatyyppi: main, alatyyppi: sub, materiaali: 'Asfalttibetoni' } };
}
const shared = polygon('reviewed-asphalt', [[0, -3], [16, -3], [16, 3], [0, 3]]);
const graph: RoadGraph = { schemaVersion: 2, originId: 'test', source: { id: 'source-osm', sha256: hashes.osm, attribution: 'test', license: 'ODbL' }, nodes: [], connectors: [], parking: [], footways: [], lanes: [{ id: '1:0:f0', wayId: 1, name: null, highway: 'living_street', surface: 'asphalt', speedLimit: 5, width: 3, from: 'a', to: 'b', points: [[0, 0, 0], [8, 0, 0], [16, 0, 0]], length: 16, index: 0, count: 1 }] };
const plan: DrivableCorridorPlan = { schemaVersion: 1, sourceHashes: hashes, vehicleHalfWidthMetres: .967, marginMetres: .15,
  corridors: [{ id: 'shared-axis', wayId: 1, laneIds: ['1:0:f0'], stationsMetres: { '1:0:f0': [2, 14] }, sourcePartIds: [shared.id], reason: 'Retained public living street on surveyed shared asphalt' }] };
function resolve(overrides: Partial<Parameters<typeof resolveDrivableCorridors>[1]> = {}, selectedPlan = plan) {
  return resolveDrivableCorridors(selectedPlan, { roads: graph, parts: [shared], sourceHashes: hashes, protectedArea: keep, protectedMarginMetres: 8, foundations: [], ...overrides });
}

test('a reviewed corridor keeps exact source finish and bounded retained-lane stations', () => {
  const input = JSON.stringify({ graph, shared }), result = resolve();
  assert.equal(result.parts.length, 1);
  for (const [i, expected] of [.883, -1.117, 15.117, 1.117].entries()) assert.ok(Math.abs(result.parts[0]!.bbox[i]! - expected) < 1e-12);
  assert.equal(result.parts[0]!.properties['materiaali'], 'Asfalttibetoni');
  assert.equal(result.parts[0]!.properties['corridorSourcePartId'], shared.id);
  assert.equal(result.records[0]!.widthProbes, 3 * 50);
  assert.equal(JSON.stringify({ graph, shared }), input, 'Road graph and registered source must remain immutable');
});

test('both graph content and its OSM binding fail closed before resolving a corridor', () => {
  assert.throws(() => resolve({ sourceHashes: { ...hashes, roads: 'd'.repeat(64) } }), /roads hash changed/);
  assert.throws(() => resolve({ roads: { ...graph, source: { ...graph.source, sha256: 'e'.repeat(64) } } }), /reviewed OSM/);
  assert.throws(() => resolve({}, { ...plan, corridors: [{ ...plan.corridors[0]!, wayId: 2 }] }), /changed source way/);
  assert.throws(() => resolve({}, { ...plan, corridors: [{ ...plan.corridors[0]!, stationsMetres: { '1:0:f0': [2, 20] } }] }), /bounded interval/);
});

test('clipping the margin is allowed only if the full physical vehicle still fits', () => {
  const narrow = polygon(shared.id, [[0, -1], [16, -1], [16, 1], [0, 1]]);
  const result = resolve({ parts: [narrow] });
  for (const [i, expected] of [.883, -1, 15.117, 1].entries()) assert.ok(Math.abs(result.parts[0]!.bbox[i]! - expected) < 1e-12);
  const tooNarrow = polygon(shared.id, [[0, -.95], [16, -.95], [16, .95], [0, .95]]);
  assert.throws(() => resolve({ parts: [tooNarrow] }), /physical vehicle strip lacks/);
  const holed = { ...shared, rings: [...shared.rings, [[7, -.05], [7.02, -.05], [7.02, .05], [7, .05]] as Pt[]] };
  assert.throws(() => resolve({ parts: [holed] }), /physical vehicle strip lacks/, 'Even a narrow source hole between probe stations must be rejected');
});

test('ordinary carriageway approaches stay outside the authored exception footprint', () => {
  const reviewed = polygon(shared.id, [[4, -3], [12, -3], [12, 3], [4, 3]]);
  const road = polygon('ordinary-road', [[0, -4], [16, -4], [16, 4], [0, 4]], 'Ajorata', 'Ajorata');
  const result = resolve({ parts: [reviewed, road] });
  assert.deepEqual(result.parts[0]!.bbox, [4, -1.117, 12, 1.117]);
  assert.equal(pointInPolygon([3, 0], result.parts[0]!.rings), false);
});

test('actual source walls, stairs, rock, bushes, buildings and accepted ground cannot become roads', () => {
  for (const [main, sub] of [['Varusteet', 'Tukimuuri'], ['Kevyt liikenne', 'Portaat'], ['Muut alueet', 'Avokallio'], ['Puut, pensaat ja köynnökset', 'Pensasryhmät/massaistutukset'], ['Silta', 'Ajorata (Silta)']]) {
    const protectedPart = polygon('real-source-protection', [[7, -.5], [9, -.5], [9, .5], [7, .5]], main, sub);
    assert.throws(() => resolve({ parts: [shared, protectedPart] }), /protected source/);
  }
  const foundation = polygon('real-building', [[7, -.5], [9, -.5], [9, .5], [7, .5]]);
  assert.throws(() => resolve({ foundations: [foundation] }), /protected source real-building/);
  assert.throws(() => resolve({ protectedArea: { minX: 5, maxX: 10, minZ: -1, maxZ: 1 } }), /accepted-district/);
  const bridge = polygon(shared.id, shared.rings[0]!, 'Silta', 'Ajorata (Silta)');
  assert.throws(() => resolve({ parts: [bridge] }), /Only reviewed shared surfaces/);
});

test('a raw companion is protected even when its source class is ordinary Ajorata', () => {
  const companion = polygon('exact-raw-companion', [[7, -.5], [9, -.5], [9, .5], [7, .5]], 'Ajorata', 'Ajorata');
  assert.throws(() => resolve({ parts: [shared, companion], rawDeckPartIds: [companion.id] }), /protected source exact-raw-companion/);
});

test('the combined field carries ordinary-road joins across the entire tyre strip', () => {
  const terrain: TerrainGrid = { x0: -20, z0: -20, nx: 41, nz: 41, resolution: 1, heights: new Float32Array(1681) };
  for (let iz = 0; iz < terrain.nz; iz++) for (let ix = 0; ix < terrain.nx; ix++) {
    const x = terrain.x0 + ix; terrain.heights[iz * terrain.nx + ix] = .1 * x + (x === 8 ? 3 : 0);
  }
  const ordinary = polygon('ordinary', [[-16, -3], [8, -3], [8, 3], [-16, 3]], 'Ajorata', 'Ajorata');
  const sharedEnd = { ...polygon(shared.id, [[8, -3], [20, -3], [20, 3], [8, 3]]), properties: { ...shared.properties, materiaali: 'Nupukivi' } };
  const old = buildGround([ordinary, sharedEnd], terrain, [], { minX: -16, maxX: 20, minZ: -16, maxZ: 16 }, .12, 128);
  const result = applyDrivableCorridors(old.pieces, old.kerbs, resolve({ parts: [ordinary, sharedEnd] }), terrain,
    { area: { minX: -16, maxX: 20, minZ: -16, maxZ: 16 }, protectedArea: keep, protectedMarginMetres: 8, gridMetres: 4, maxAxisGrade: .35 }, 128, []);
  const support = createGroundSupportSampler([...result.pieces, ...result.kerbs]);
  for (const across of [-.967, 0, .967]) {
    let previous: number | null = null;
    for (let x = 6; x <= 10; x += .125) {
      const current = support(x, across)?.height; assert.ok(current !== undefined);
      if (previous !== null) assert.ok(Math.abs(current - previous) < .1, 'Shared boundary cannot create a new abrupt road step');
      previous = current;
    }
  }
  assert.ok(result.roads.some(p => p.finish === 'setts'), 'Reviewed paving keeps the original source finish');
});

test('constrained corridor grade removes a procedural wall projection and preserves a real wall and foundation', () => {
  const terrain: TerrainGrid = { x0: -20, z0: -20, nx: 41, nz: 41, resolution: 1, heights: new Float32Array(1681) };
  const sourceWall = polygon('real-wall', [[5, 2], [11, 2], [11, 2.25], [5, 2.25]], 'Varusteet', 'Tukimuuri');
  const foundation = polygon('building', [[6, 3], [10, 3], [10, 5], [6, 5]]);
  const broadShared = polygon(shared.id, [[-16, -16], [20, -16], [20, 16], [-16, 16]]);
  const old = buildGround([broadShared], terrain, [], { minX: -16, maxX: 20, minZ: -16, maxZ: 16 }, .12, 128, { cuts: [], surface: () => 3 });
  const wall: GroundPiece = { cell: 'c_p00_m01', finish: 'slabs', level: 'raised', tag: 'wall', positions: [5, 0, -2.1, 11, 0, -2.1, 11, 4, -2.1, 5, 4, -2.1], uvs: [0, 0, 6, 0, 6, 4, 0, 4], indices: [0, 1, 2, 0, 2, 3] };
  const projection: GroundPiece = { ...wall, positions: [5, 0, 0, 11, 0, 0, 11, 4, 0, 5, 4, 0] };
  const pieces = [...old.pieces, wall, projection], before = JSON.stringify(pieces), beforeSupport = createGroundSupportSampler(pieces);
  const resolved = resolve({ parts: [broadShared, sourceWall], foundations: [foundation] });
  const output = applyDrivableCorridors(pieces, old.kerbs, resolved, terrain, { area: { minX: -16, maxX: 20, minZ: -16, maxZ: 16 }, protectedArea: keep, protectedMarginMetres: 8, gridMetres: 4, maxAxisGrade: .35 }, 128, [foundation]);
  const support = createGroundSupportSampler([...output.pieces, ...output.kerbs]);
  for (let x = 2.25; x < 14; x += .25) for (const z of [-.967, 0, .967]) assert.ok(Math.abs(support(x, z)!.height) < 1e-6, 'The physical driving strip must be continuously supported at the source-derived road level');
  assert.ok(Math.abs(support(8, -2.15)!.height - beforeSupport(8, -2.15)!.height) < 1e-10, 'Real source-wall top stays at its existing height');
  assert.ok(Math.abs(support(8, -3.01)!.height - beforeSupport(8, -3.01)!.height) < 1e-10, 'Building-adjacent foundation support stays pinned');
  for (const p of output.pieces.filter(p => p.tag === 'wall')) for (let i = 0; i < p.indices.length; i += 3) {
    const xs = [0, 1, 2].map(k => p.positions[p.indices[i + k]! * 3]!);
    const zs = [0, 1, 2].map(k => p.positions[p.indices[i + k]! * 3 + 2]!);
    assert.ok(Math.abs(zs.reduce((a, b) => a + b, 0) / 3) > .967 || Math.max(...xs) <= 2 || Math.min(...xs) >= 14, 'Procedural wall projection cannot remain inside the driving strip');
  }
  assert.equal(JSON.stringify(pieces), before, 'Source ground arrays remain immutable');
});
