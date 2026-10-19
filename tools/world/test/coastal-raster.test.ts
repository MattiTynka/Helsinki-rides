import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import polygonClipping from 'polygon-clipping';
import type { TerrainGrid } from '../../../packages/world-schema/src/index.ts';
import { lowerTerrainUnderWater as publicLowerTerrainUnderWater, type CoastalMask } from '../lib/coastal-mask.ts';
import { lowerTerrainUnderWaterRaster } from '../lib/coastal-raster.ts';
import { bbox, signedArea, type LocalPolygon, type Ring } from '../lib/geometry.ts';

// Frozen independent reference from coastal-mask.ts before optimization:
// SHA-256 3d5d33b429feccd1a9c615c0fdc8fe2a21a872594314940f348a2fa6cb00c36f.
// Keep this slow polygon-per-cell implementation in the tests after the public
// API delegates, so byte-equivalence never becomes a comparison with itself.
const referenceSourceSha256 = '3d5d33b429feccd1a9c615c0fdc8fe2a21a872594314940f348a2fa6cb00c36f';
function naiveLowerTerrainUnderWater(terrain: TerrainGrid, mask: CoastalMask, floorY: number) {
  type Geometry = [number, number][][][];
  const area = (geometry: Geometry) => geometry.reduce((sum, polygon) => sum + Math.abs(signedArea(polygon[0]!)) - polygon.slice(1).reduce((holes, ring) => holes + Math.abs(signedArea(ring)), 0), 0);
  const heights = terrain.heights.slice(), r = terrain.resolution;
  for (const water of mask.water) {
    const [x0, y0, x1, y1] = water.bbox;
    const ix0 = Math.max(0, Math.floor((x0 - terrain.x0) / r)), ix1 = Math.min(terrain.nx - 2, Math.floor((x1 - terrain.x0) / r));
    const iz0 = Math.max(0, Math.floor((-y1 - terrain.z0) / r)), iz1 = Math.min(terrain.nz - 2, Math.floor((-y0 - terrain.z0) / r));
    for (let iz = iz0; iz <= iz1; iz++) for (let ix = ix0; ix <= ix1; ix++) {
      const indices = [iz * terrain.nx + ix, iz * terrain.nx + ix + 1, (iz + 1) * terrain.nx + ix, (iz + 1) * terrain.nx + ix + 1];
      if (indices.every(index => heights[index]! <= floorY)) continue;
      const x = terrain.x0 + ix * r, z = terrain.z0 + iz * r;
      const square: Ring = [[x, -z], [x + r, -z], [x + r, -z - r], [x, -z - r]];
      if (area(polygonClipping.intersection([water.rings], [[square]]) as Geometry) < 1e-7) continue;
      for (const index of indices) heights[index] = Math.min(heights[index]!, floorY);
    }
  }
  let loweredSamples = 0;
  for (let i = 0; i < heights.length; i++) if (heights[i] !== terrain.heights[i]) loweredSamples++;
  return { terrain: { ...terrain, heights }, loweredSamples };
}

function terrain(nx = 25, nz = 21, resolution = 1, x0 = -12, z0 = -10): TerrainGrid {
  return { nx, nz, resolution, x0, z0, heights: Float32Array.from({ length: nx * nz }, (_, i) => Math.sin(i * .4) * 2) };
}
const poly = (...rings: Ring[]): LocalPolygon => ({ id: 'water', rings, bbox: bbox(rings), properties: {} });
const box = (x0: number, y0: number, x1: number, y1: number): Ring => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const mask = (water: LocalPolygon[]): CoastalMask => ({ water, area: { minX: -1000, maxX: 1000, minZ: -1000, maxZ: 1000 }, sources: { coastlineWays: [], waterWays: [], waterRelations: [] }, stats: { coastlineChains: 0, openChains: 0, landRings: 0, waterArea: 0 } });

function compare(grid: TerrainGrid, water: LocalPolygon[], floor = -30) {
  const before = grid.heights.slice(), spec = mask(water);
  const reference = naiveLowerTerrainUnderWater(grid, spec, floor), actual = lowerTerrainUnderWaterRaster(grid, spec, floor);
  assert.deepEqual(new Uint8Array(actual.terrain.heights.buffer), new Uint8Array(reference.terrain.heights.buffer), 'Every Float32 byte must match the existing clipper');
  assert.equal(actual.loweredSamples, reference.loweredSamples);
  const publicResult = publicLowerTerrainUnderWater(grid, spec, floor);
  assert.deepEqual(publicResult.terrain.heights, reference.terrain.heights, 'Public API must preserve the frozen reference');
  assert.equal(publicResult.loweredSamples, reference.loweredSamples);
  assert.deepEqual(grid.heights, before, 'Source terrain must remain exact');
  return actual;
}

test('aligned cells, negative indices and terrain edges retain exact four-corner lowering', () => {
  const result = compare(terrain(), [poly(box(-8, -7, 7, 8))]);
  assert.ok(result.stats.interiorCells > 0);
  assert.ok(result.stats.exactClips < result.stats.candidateCells);
  compare(terrain(), [poly(box(-20, -30, 0, 30))]);
  compare(terrain(), [poly(box(12, -10, 13, 10))]);
  compare(terrain(), [poly(box(30, 30, 31, 31))]);
});

test('holes, reversed ring directions and a hole containing every cell centre remain exact', () => {
  const outer = box(-9.4, -8.8, 10.2, 8.6), hole = box(-4.3, -3.7, 5.1, 4.2);
  compare(terrain(), [poly(outer, hole)]);
  compare(terrain(), [poly([...outer].reverse(), [...hole].reverse())]);
  compare(terrain(3, 3, 1, 0, 0), [poly(box(0, -2, 2, 0), box(.1, -1.9, 1.9, -.1))]);
});

test('concave channels with multiple separated holes produce every scanline span', () => {
  const outer: Ring = [[-10, -8], [10, -8], [10, 8], [4, 8], [4, -3], [-4, -3], [-4, 8], [-10, 8]];
  compare(terrain(), [poly(outer, box(-8.6, -1.2, -5.8, 4.3), box(5.1, -2.2, 8.7, 5.4))]);
});

test('separate, overlapping and tangential polygons do not aggregate subthreshold areas', () => {
  compare(terrain(), [poly(box(-8, -5, 2, 7)), poly(box(-1, -7, 9, 5)), poly(box(9, -7, 10, 5))]);
  const result = compare(terrain(3, 3, 1, 0, -1), [poly(box(0, 0, 4e-8, 1)), poly(box(.1, 0, .1 + 4e-8, 1))]);
  assert.equal(result.loweredSamples, 0, 'The reference applies the threshold per polygon, not their union');
});

test('skinny diagonal and corner slivers are never lost by centre-only filling', () => {
  compare(terrain(), [poly([[-11.8, -9.6], [11.6, 9.7], [11.60001, 9.7], [-11.79999, -9.6]])]);
  compare(terrain(), [poly([[-9.9, -9.73], [10.13, 9.81], [-9.86, -9.73]])]);
  compare(terrain(), [poly([[-8, -8], [8, 8], [-8, 8]])]);
});

test('an inherited polygon-clipping output-ring failure remains a visible error', () => {
  const grid = terrain(), spec = mask([poly([[-9.99, -9.99], [10.01, 10.01], [-9.99, -9.98]])]);
  assert.throws(() => naiveLowerTerrainUnderWater(grid, spec, -30), /Unable to complete output ring/);
  assert.throws(() => publicLowerTerrainUnderWater(grid, spec, -30), /Unable to complete output ring/);
  assert.throws(() => lowerTerrainUnderWaterRaster(grid, spec, -30), /Unable to complete output ring/);
});

test('microscopic cell areas and exact clipping threshold retain the existing >= comparison', () => {
  const equalThreshold = compare(terrain(3, 3, 1, 0, -2), [poly(box(0, 0, 1e-7, 1))]);
  assert.ok(equalThreshold.loweredSamples > 0, 'Exact 1e-7 intersections are accepted by the reference');
  const tooSmall = compare(terrain(11, 11, 1e-4, 0, 0), [poly(box(0, -.001, .001, 0))]);
  assert.equal(tooSmall.loweredSamples, 0);
  compare(terrain(11, 11, .00032, 1234, -500), [poly(box(1234, 499.9968, 1234.0032, 500))]);
});

test('already-low samples and mixed elevations remain byte exact', () => {
  const grid = terrain();
  for (let i = 0; i < grid.heights.length; i += 3) grid.heights[i] = -40;
  for (let i = 1; i < grid.heights.length; i += 7) grid.heights[i] = -30;
  compare(grid, [poly(box(-8.3, -5.8, 10.1, 7.4))]);
});

test('deterministic random translated and rotated polygons match the reference', () => {
  let seed = 20261018;
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 2 ** 32; };
  for (let trial = 0; trial < 70; trial++) {
    const cx = random() * 18 - 9, cy = random() * 14 - 7, radiusX = .001 + random() * 12, radiusY = .001 + random() * 10;
    const angle = random() * Math.PI, count = 3 + Math.floor(random() * 14), ring: Ring = [];
    for (let i = 0; i < count; i++) {
      const theta = i / count * Math.PI * 2, x = Math.cos(theta) * radiusX, y = Math.sin(theta) * radiusY;
      ring.push([cx + x * Math.cos(angle) - y * Math.sin(angle), cy + x * Math.sin(angle) + y * Math.cos(angle)]);
    }
    compare(terrain(25, 21, trial % 3 === 0 ? .73 : 1), [poly(ring)]);
  }
});

test('small and medium benchmarks preserve all bytes while reducing exact clips', () => {
  const baseline = createHash('sha256').update(readFileSync(new URL('../lib/coastal-mask.ts', import.meta.url))).digest('hex');
  const rows = [];
  for (const [label, size, vertices] of [['small', 45, 32], ['medium', 260, 128]] as const) {
    const ring: Ring = Array.from({ length: vertices }, (_, i) => { const angle = i / vertices * 2 * Math.PI; return [Math.cos(angle) * size * .43, Math.sin(angle) * size * .38]; });
    const grid = terrain(size + 1, size + 1, 1, -size / 2, -size / 2), spec = mask([poly(ring)]);
    const t0 = performance.now(), reference = naiveLowerTerrainUnderWater(grid, spec, -30), referenceMs = performance.now() - t0;
    const t1 = performance.now(), actual = lowerTerrainUnderWaterRaster(grid, spec, -30), rasterMs = performance.now() - t1;
    assert.deepEqual(actual.terrain.heights, reference.terrain.heights); assert.equal(actual.loweredSamples, reference.loweredSamples);
    assert.ok(actual.stats.exactClips < actual.stats.candidateCells / 2, 'Only the narrow boundary should require exact clipping');
    rows.push({ label, vertices, gridCells: size * size, referenceMs, rasterMs, speedup: referenceMs / rasterMs, byteExact: true, ...actual.stats });
  }
  console.log(JSON.stringify({ benchmark: 'coastal-raster', baselineSha256: referenceSourceSha256, publicModuleSha256: baseline, rows }));
});
