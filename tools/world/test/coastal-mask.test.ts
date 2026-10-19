import assert from 'node:assert/strict';
import { test } from 'node:test';
import { geodeticToGk25, type TerrainGrid } from '../../../packages/world-schema/src/index.ts';
import { buildCoastalMask, buildCoastalWaterPieces, clipCoastalGround, coastlinesToWater, lowerTerrainUnderWater, measureRegisteredBridgeCoverage, registeredBridgeDecks, type CoastalMask, type CoastalOsm } from '../lib/coastal-mask.ts';
import { bbox, pointInPolygon, signedArea, type LocalPolygon, type Ring } from '../lib/geometry.ts';
import { buildGround, type GroundPiece } from '../lib/ground.ts';

const area = { minX: -10, maxX: 10, minZ: -10, maxZ: 10 };
const waterAt = (mask: Pick<CoastalMask, 'water'>, x: number, y: number) => mask.water.some(p => pointInPolygon([x, y], p.rings));
const fromChains = (chains: Ring[]): CoastalMask => {
  const m = coastlinesToWater(chains, area);
  return { ...m, area, sources: { coastlineWays: [], waterWays: [], waterRelations: [] }, stats: { coastlineChains: chains.length, openChains: m.openChains, landRings: m.landRings, waterArea: 0 } };
};
const north: Ring = [[0, -20], [0, 20]];

test('directed coastline keeps land left and ocean right, closing only on the bounds', () => {
  const m = fromChains([north]);
  assert.equal(waterAt(m, -5, 0), false);
  assert.equal(waterAt(m, 5, 0), true);
  assert.equal(m.stats.openChains, 1);
});

test('opposing mainland and island coastlines leave an actual canal between them', () => {
  const m = fromChains([[[ -4, -20], [-4, 20]], [[4, 20], [4, -20]]]);
  assert.equal(waterAt(m, -7, 0), false);
  assert.equal(waterAt(m, 0, 0), true);
  assert.equal(waterAt(m, 7, 0), false);
  assert.equal(m.stats.landRings, 2);
});

test('closed offshore islands remain dry and clipped closed rings stitch across their source start', () => {
  const island: Ring = [[3, -2], [7, -2], [7, 2], [3, 2], [3, -2]];
  const m = fromChains([north, island]);
  assert.equal(waterAt(m, 5, 0), false);
  assert.equal(waterAt(m, 8, 0), true);
  const clipped = fromChains([[[-5, 0], [-5, -20], [20, -20], [20, 20], [-5, 20], [-5, 0]]]);
  assert.equal(waterAt(clipped, 0, 0), false);
  assert.equal(waterAt(clipped, -8, 0), true);
});

test('missing inland coastline endpoints fail rather than turning the gap into invented land', () => {
  assert.throws(() => fromChains([[[0, -20], [0, 0]]]), /incomplete coastline ends inside/);
  assert.throws(() => fromChains([[[0, -20], [0, 20]], [[2, -20], [2, 20]]]), /does not alternate/);
});

const quad = (x0: number, x1: number, y0: number, y1: number): GroundPiece => ({ cell: 'c', finish: 'yard', level: 'road', tag: 'raised:yard', positions: [x0, x0 * 0.1, -y0, x1, x1 * 0.1, -y0, x1, x1 * 0.1, -y1, x0, x0 * 0.1, -y1], uvs: [x0, y0, x1, y0, x1, y1, x0, y1], indices: [0, 1, 2, 0, 2, 3] });
const polygon = (ring: Ring): LocalPolygon => ({ id: 'deck', rings: [ring], bbox: bbox([ring]), properties: {} });

test('water clipping retains exact dry objects, removes paving and interpolates existing grade', () => {
  const dry = quad(-8, -4, -4, 4), crossing = quad(-4, 4, -4, 4), wet = quad(4, 8, -4, 4);
  const before = structuredClone([dry, crossing, wet]);
  const clipped = clipCoastalGround([dry, crossing, wet], fromChains([north]));
  assert.equal(clipped.pieces[0], dry);
  assert.equal(clipped.pieces.length, 2);
  assert.equal(clipped.clipped, 2);
  for (const p of clipped.pieces) for (let i = 0; i < p.positions.length; i += 3) {
    assert.ok(p.positions[i]! <= 1e-7);
    assert.ok(Math.abs(p.positions[i + 1]! - p.positions[i]! * 0.1) < 1e-7);
  }
  assert.deepEqual([dry, crossing, wet], before, 'no input geometry is mutated');
});

test('only a declared registered deck retains ground over the water', () => {
  const deck = polygon([[-1, -1], [8, -1], [8, 1], [-1, 1]]);
  const result = clipCoastalGround([quad(-4, 8, -4, 4)], fromChains([north]), [deck]);
  let area = 0;
  for (const p of result.pieces) for (let i = 0; i < p.indices.length; i += 3) {
    const tri = p.indices.slice(i, i + 3).map(id => [p.positions[id * 3]!, -p.positions[id * 3 + 2]!] as [number, number]);
    area += Math.abs(signedArea(tri));
  }
  assert.ok(Math.abs(area - (4 * 8 + 8 * 2)) < 1e-6);
});

test('water visuals are flat, face upward and are split into their streamed owner cells', () => {
  const pieces = buildCoastalWaterPieces(fromChains([north]), 8, -7.5);
  assert.ok(pieces.length > 1);
  let area = 0;
  for (const p of pieces) {
    for (let i = 1; i < p.positions.length; i += 3) assert.equal(p.positions[i], -7.5);
    for (let i = 0; i < p.indices.length; i += 3) {
      const tri = p.indices.slice(i, i + 3).map(id => [p.positions[id * 3]!, -p.positions[id * 3 + 2]!] as [number, number]);
      assert.ok(signedArea(tri) > 0); area += signedArea(tri);
    }
  }
  assert.ok(Math.abs(area - 200) < 1e-6);
});

test('water safety field stays below recovery height, source terrain and remote dry samples stay exact', () => {
  const terrain: TerrainGrid = { x0: -10, z0: -10, nx: 21, nz: 21, resolution: 1, heights: new Float32Array(441).fill(3) };
  const before = terrain.heights.slice();
  const result = lowerTerrainUnderWater(terrain, fromChains([north]), -30);
  assert.ok(result.loweredSamples > 0);
  for (let z = 0; z < 21; z++) for (let x = 0; x < 21; x++) assert.equal(result.terrain.heights[z * 21 + x], x < 10 ? 3 : -30);
  assert.deepEqual(terrain.heights, before);
});

test('water holes remain dry in the derived safety field', () => {
  const m = fromChains([north]);
  const rings: Ring[] = [[[1, -8], [9, -8], [9, 8], [1, 8]], [[3, -4], [3, 4], [7, 4], [7, -4]]];
  const mask: CoastalMask = { ...m, water: [{ id: 'hole', rings, bbox: bbox(rings), properties: {} }] };
  const terrain: TerrainGrid = { x0: -10, z0: -10, nx: 21, nz: 21, resolution: 1, heights: new Float32Array(441).fill(3) };
  const result = lowerTerrainUnderWater(terrain, mask, -30);
  assert.equal(result.terrain.heights[10 * 21 + 15], 3);
  assert.equal(result.terrain.heights[10 * 21 + 12], -30);
});

test('projected OSM assembly retains source IDs and rejects an incomplete water relation', () => {
  const [e, n] = geodeticToGk25(60.17, 24.95);
  const osm: CoastalOsm = { elements: [{ type: 'node', id: 1, lat: 60.16, lon: 24.95 }, { type: 'node', id: 2, lat: 60.18, lon: 24.95 }, { type: 'way', id: 3, nodes: [1, 2], tags: { natural: 'coastline' } }] };
  const options = { area: { minX: -100, maxX: 100, minZ: -100, maxZ: 100 }, originProjected: [e, n, 7.5] };
  const m = buildCoastalMask(osm, options);
  assert.deepEqual(m.sources.coastlineWays, [3]);
  assert.equal(waterAt(m, 50, 0), true);
  assert.throws(() => buildCoastalMask({ elements: [...osm.elements, { type: 'relation', id: 4, tags: { type: 'multipolygon', natural: 'water' }, members: [{ type: 'way', ref: 99, role: 'outer' }] }] }, options), /missing member ways/);
});

test('registered bridges preserve source polygon footprints, never a guessed road width', () => {
  const [e, n] = geodeticToGk25(60.17, 24.95);
  const osm: CoastalOsm = { elements: [{ type: 'node', id: 1, lat: 60.17, lon: 24.9498 }, { type: 'node', id: 2, lat: 60.17, lon: 24.9502 }, { type: 'way', id: 3, nodes: [1, 2], tags: { bridge: 'yes', highway: 'footway' } }, { type: 'way', id: 4, nodes: [1, 2], tags: { bridge: 'yes', highway: 'corridor', indoor: 'yes' } }] };
  const deck = { ...polygon([[-20, -2], [20, -2], [20, 2], [-20, 2]]), properties: { paatyyppi: 'Kevyt liikenne' } };
  const remote = { ...polygon([[30, -2], [40, -2], [40, 2], [30, 2]]), id: 'remote', properties: { paatyyppi: 'Ajorata' } };
  const result = registeredBridgeDecks(osm, [deck, remote], [e, n, 7.5]);
  assert.deepEqual(result.polygons, [deck]);
  assert.deepEqual(result.matches, [{ way: 3, parts: ['deck'] }]);
  assert.equal(measureRegisteredBridgeCoverage(osm, 3, result.polygons, [e, n, 7.5], { minOffset: -1, maxOffset: 1 }).pass, true);
  assert.equal(measureRegisteredBridgeCoverage(osm, 3, result.polygons, [e, n, 7.5], { minOffset: -3, maxOffset: 3 }).pass, false);
});

test('surveyed road and footbridge deck classes produce the actual supported surface', () => {
  const terrain: TerrainGrid = { x0: -10, z0: -10, nx: 21, nz: 21, resolution: 1, heights: new Float32Array(441).fill(3) };
  const road = { ...polygon([[-8, -8], [-4, -8], [-4, -4], [-8, -4]]), id: 'road', properties: { paatyyppi: 'Silta', alatyyppi: 'Ajorata (Silta)', materiaali: 'Asfalttibetoni' } };
  const foot = { ...polygon([[4, 4], [8, 4], [8, 8], [4, 8]]), id: 'foot', properties: { paatyyppi: 'Silta', alatyyppi: 'Kevyt liikenne (Silta)', materiaali: 'Asfalttibetoni' } };
  const unsupported = { ...polygon([[-8, 4], [-4, 4], [-4, 8], [-8, 8]]), id: 'wall', properties: { paatyyppi: 'Silta', alatyyppi: 'Reunapalkki', materiaali: 'Betoni' } };
  const result = buildGround([road, foot, unsupported], terrain, [], area, 0.12, 128);
  assert.equal(result.stats.polygons, 2);
  assert.ok(result.pieces.some(p => p.tag === 'road:asphalt'));
  assert.ok(result.pieces.some(p => p.tag === 'raised:asphalt'));
});
