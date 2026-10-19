import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TerrainGrid } from '../../../packages/world-schema/src/index.ts';
import { buildCarriagewayGrade, constrainedGrade, applyCarriagewayGrade, clipGroundForCarriageways, createGroundSupportSampler } from '../lib/carriageway-grade.ts';
import { buildGround, type GroundPiece } from '../lib/ground.ts';
import type { LocalPolygon } from '../lib/geometry.ts';

test('grade constraints preserve admissible surveyed samples and symmetrically remove isolated extrema', () => {
  const line = Array.from({ length: 9 }, (_, x) => ({ x, n: 0, raw: x * 0.1 }));
  assert.deepEqual(constrainedGrade(line, 1, 0.35), line.map(p => p.raw));
  const pit = line.map((p, i) => ({ ...p, raw: p.raw - (i === 4 ? 4 : 0) })), peak = line.map((p, i) => ({ ...p, raw: p.raw + (i === 4 ? 4 : 0) }));
  for (const source of [pit, peak]) {
    const h = constrainedGrade(source, 1, 0.35);
    for (let i = 1; i < h.length; i++) assert.ok(Math.abs(h[i]! - h[i - 1]!) <= 0.35 + 1e-9);
    assert.ok(h.some((v, i) => Math.abs(v - source[i]!.raw) > 1));
  }
});

test('a disconnected surface component cannot transfer height across an unmodelled bridge or water gap', () => {
  const nodes = [{ x: 0, n: 0, raw: 0 }, { x: 1, n: 0, raw: 0.1 }, { x: 4, n: 0, raw: 12 }, { x: 5, n: 0, raw: 12.1 }];
  assert.deepEqual(constrainedGrade(nodes, 1, 0.35), nodes.map(p => p.raw));
});

test('eligible grade excludes bridges and the accepted rectangle without changing terrain', () => {
  const terrain: TerrainGrid = { x0: -16, z0: -16, nx: 33, nz: 33, resolution: 1, heights: new Float32Array(1089) };
  const before = terrain.heights.slice();
  const poly = (id: string, x0: number, x1: number, main = 'Ajorata', sub = 'Ajorata'): LocalPolygon => ({ id, rings: [[[x0, -4], [x1, -4], [x1, 4], [x0, 4]]], bbox: [x0, -4, x1, 4], properties: { paatyyppi: main, alatyyppi: sub } });
  const grade = buildCarriagewayGrade([poly('accepted', -8, -1), poly('road', 5, 9), poly('bridge', 10, 14, 'Silta', 'Ajorata (Silta)')], terrain,
    { area: { minX: -16, maxX: 16, minZ: -16, maxZ: 16 }, protectedArea: { minX: -8, maxX: -4, minZ: -8, maxZ: 8 }, protectedMarginMetres: 4, gridMetres: 4, maxAxisGrade: 0.35 });
  assert.deepEqual(grade.parts.map(p => p.id), ['road']);
  assert.equal(grade.sample(6, 0), 0); assert.equal(grade.sample(0, 0), null);
  assert.equal(grade.stats.changedNodes, 0); assert.deepEqual(terrain.heights, before);
});

test('a wall through the source carriageway is clipped in 3D while the outside wall stays exact', () => {
  const road: LocalPolygon = { id: 'road', rings: [[[0, -2], [4, -2], [4, 2], [0, 2]]], bbox: [0, -2, 4, 2], properties: {} };
  const wall: GroundPiece = { cell: 'c_p00_p00', finish: 'slabs', level: 'raised', tag: 'wall', positions: [-2, 0, 0, 6, 0, 0, 6, 3, 0, -2, 3, 0], uvs: [0, 0, 8, 0, 8, 3, 0, 3], indices: [0, 1, 2, 0, 2, 3] };
  const far: GroundPiece = { ...wall, positions: wall.positions.map((v, i) => i % 3 === 2 ? 10 : v) };
  const result = clipGroundForCarriageways([wall, far], [road]);
  assert.equal(result.pieces[1], far);
  for (const piece of result.pieces.slice(0, 1)) for (let i = 0; i < piece.indices.length; i += 3) {
    const center = [0, 1, 2].reduce((sum, k) => sum + piece.positions[piece.indices[i + k]! * 3]!, 0) / 3;
    assert.ok(center <= 1e-8 || center >= 4 - 1e-8, 'no wall slab remains across the drivable footprint');
  }
  assert.deepEqual(wall.positions, [-2, 0, 0, 6, 0, 0, 6, 3, 0, -2, 3, 0]);
});

test('a lowered road shares a 12cm curb with its sidewalk and feathers back to unchanged distant ground', () => {
  const terrain: TerrainGrid = { x0: -20, z0: -20, nx: 41, nz: 41, resolution: 1, heights: new Float32Array(1681) };
  const poly = (id: string, ring: [number, number][], main: string): LocalPolygon => ({ id, rings: [ring], bbox: [Math.min(...ring.map(p => p[0])), Math.min(...ring.map(p => p[1])), Math.max(...ring.map(p => p[0])), Math.max(...ring.map(p => p[1]))], properties: { paatyyppi: main, alatyyppi: main === 'Ajorata' ? 'Ajorata' : 'Jalkakäytävä', materiaali: 'Asfaltti' } });
  const road = poly('road', [[0, -4], [4, -4], [4, 4], [0, 4]], 'Ajorata'), sidewalk = poly('walk', [[4, -4], [10, -4], [10, 4], [4, 4]], 'Kevyt liikenne');
  const area = { minX: -16, maxX: 20, minZ: -12, maxZ: 12 };
  const old = buildGround([road, sidewalk], terrain, [], area, .12, 128, { cuts: [], surface: () => 3 });
  const grade = buildCarriagewayGrade([road, sidewalk], terrain, { area, protectedArea: { minX: -100, maxX: -90, minZ: -100, maxZ: -90 }, gridMetres: 4, maxAxisGrade: .35 });
  const fixed = applyCarriagewayGrade(old.pieces, old.kerbs, grade, 128);
  const heights = (x: number, z: number) => fixed.pieces.flatMap(p => p.positions.flatMap((_, i) => i % 3 === 0 && Math.abs(p.positions[i]! - x) < 1e-6 && Math.abs(p.positions[i + 2]! - z) < 1e-6 ? [p.positions[i + 1]!] : []));
  assert.ok(Math.abs(Math.max(...heights(4, 0)) - .12) < 1e-5);
  assert.ok(Math.abs(fixed.transitionAt(4, 0) + 3) < 1e-5);
  assert.equal(fixed.transitionAt(20, 0), 0);
  assert.ok(Math.abs(fixed.transitionAt(8, 0)) < 3 && fixed.transitionAt(8, 0) < 0);
  assert.ok(fixed.stats.maxJoinVerticalGap <= .120001);
});

test('a nearby protected rock edge cannot pull its old height across an ordinary curb', () => {
  const terrain: TerrainGrid = { x0: -20, z0: -20, nx: 41, nz: 41, resolution: 1, heights: new Float32Array(1681) };
  const poly = (id: string, ring: [number, number][], main: string, sub: string): LocalPolygon => ({ id, rings: [ring], bbox: [Math.min(...ring.map(p => p[0])), Math.min(...ring.map(p => p[1])), Math.max(...ring.map(p => p[0])), Math.max(...ring.map(p => p[1]))], properties: { paatyyppi: main, alatyyppi: sub, materiaali: 'Asfaltti' } });
  const road = poly('road', [[0, -4], [4, -4], [4, 4], [0, 4]], 'Ajorata', 'Ajorata');
  const sidewalk = poly('walk', [[4, -4], [10, -4], [10, 4], [4, 4]], 'Kevyt liikenne', 'Jalkakäytävä');
  const rock = poly('rock', [[4, -2], [10, -2], [10, 4], [4.2, 4]], 'Muut alueet', 'Avokallio');
  const area = { minX: -16, maxX: 20, minZ: -12, maxZ: 12 };
  const old = buildGround([road, sidewalk], terrain, [], area, .12, 128, { cuts: [], surface: () => 3 });
  const original = JSON.stringify(old), oldSupport = createGroundSupportSampler([...old.pieces, ...old.kerbs]);
  const grade = buildCarriagewayGrade([road, sidewalk, rock], terrain, { area, protectedArea: { minX: -100, maxX: -90, minZ: -100, maxZ: -90 }, gridMetres: 4, maxAxisGrade: .35 });
  const fixed = applyCarriagewayGrade(old.pieces, old.kerbs, grade, 128), support = createGroundSupportSampler([...fixed.pieces, ...fixed.kerbs]);
  assert.ok(Math.abs(support(4, 2.1)!.height - .12) < 1e-5, 'ordinary side follows the actual road plane right up to the rock boundary');
  assert.ok(Math.abs(support(5, 1)!.height - oldSupport(5, 1)!.height) < 1e-9, 'the protected source top is not flattened');
  assert.ok(fixed.protectedJoins.length > 0, 'a source-bound vertical side closes the rock to the changed ordinary surface');
  assert.equal(JSON.stringify(old), original, 'source pieces remain immutable');
});
