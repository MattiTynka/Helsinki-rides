import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildCarriagewayGrade, createGroundSupportSampler } from '../lib/carriageway-grade.ts';
import { type LocalPolygon } from '../lib/geometry.ts';
import { createRawDeckTieIn, meshRawDeckTieIn } from '../lib/raw-deck-grade.ts';

const nodes = [{ x: 0, n: 0, raw: 1 }, { x: 16, n: 0, raw: 5 }, { x: 16, n: 16, raw: 7 }, { x: 0, n: 16, raw: 3 }];
const mask: LocalPolygon = { id: 'real-deck', rings: [[[1, 1], [3, 1], [3, 3], [1, 3]]], bbox: [1, 1, 3, 3], properties: { materiaali: 'Asfalttibetoni' } };
const cells = [{ ix: 0, iy: 0, nodes: [0, 1, 2, 3] as const, polygons: [] }];

test('raw deck interpolation stays exact when ordinary node heights change', () => {
  const first = createRawDeckTieIn(nodes, cells, [0, 0, 0, 0], [mask], 16, 8);
  const second = createRawDeckTieIn(nodes, cells, [100, 100, 100, 100], [mask], 16, 8);
  for (const p of [[1, 1], [2, 2], [3, 3], [1, 2]] as const) {
    assert.equal(first.sample(p[0], p[1]), first.rawAt(p[0], p[1]));
    assert.equal(second.sample(p[0], p[1]), first.rawAt(p[0], p[1]));
  }
});

test('ordinary approaches meet the actual source boundary and fade within 8m', () => {
  const field = createRawDeckTieIn(nodes, cells, [2, 2, 2, 2], [mask], 16, 8);
  assert.equal(field.rawContains(0.5, 2), false, 'The bridge mask must never grow into an ordinary road');
  assert.ok(Math.abs(field.sample(1 - 1e-5, 2)! - field.sample(1, 2)!) < 1e-4);
  assert.equal(field.sample(12, 2), 2);
  assert.equal(field.sample(12, 12), 2);
  assert.throws(() => createRawDeckTieIn(nodes, cells, [2, 2, 2, 2], [mask], 16, 20), /4-8m/);
});

test('the opt-in field exposes the same exact deck masks and sampler used by its road mesh', () => {
  const terrain = { x0: 0, z0: -16, nx: 17, nz: 17, resolution: 1, heights: new Float32Array(289) };
  const deck: LocalPolygon = { ...mask, properties: { ...mask.properties, paatyyppi: 'Silta', alatyyppi: 'Ajorata (Silta)' } };
  const road: LocalPolygon = { id: 'ordinary-road', rings: [[[0, 0], [16, 0], [16, 16], [0, 16]]], bbox: [0, 0, 16, 16], properties: { paatyyppi: 'Ajorata', alatyyppi: 'Ajorata' } };
  const before = terrain.heights.slice();
  const field = buildCarriagewayGrade([deck, road], terrain, { area: { minX: 0, maxX: 16, minZ: -16, maxZ: 0 }, protectedArea: { minX: 100, maxX: 110, minZ: 100, maxZ: 110 }, gridMetres: 4, maxAxisGrade: 0.35, rawSourceDeckPartIds: [deck.id], rawDeckTieInMetres: 8 });
  assert.ok(field.rawDeckTieIn);
  assert.equal(field.sample, field.rawDeckTieIn.sample);
  assert.deepEqual(field.rawDeckTieIn.masks.map(p => p.id), [deck.id]);
  assert.equal(field.sample(2, 2), field.rawDeckTieIn.rawAt(2, 2));
  assert.deepEqual(terrain.heights, before);
});

test('raw mesh positions, indices and UVs do not depend on ordinary heights', () => {
  const localNodes = [{ x: 0, n: 0, raw: 1 }, { x: 4, n: 0, raw: 5 }, { x: 4, n: 4, raw: 7 }, { x: 0, n: 4, raw: 3 }];
  const cell = { ix: 0, iy: 0, nodes: [0, 1, 2, 3] as const, polygons: [{ source: mask.id, rings: mask.rings }] };
  const make = (ordinary: number[]) => meshRawDeckTieIn({ parts: [mask], cells: [cell], stats: { gridMetres: 4 }, rawDeckTieIn: createRawDeckTieIn(localNodes, [cell], ordinary, [mask], 4, 8) }, 128, () => []);
  assert.deepEqual(make([0, 0, 0, 0]), make([100, 100, 100, 100]));
});

interface Fixture {
  nodes: { x: number; n: number; raw: number; height: number }[];
  constrained: number[];
  cells: { ix: number; iy: number; nodes: [number, number, number, number]; polygons: { source: string; rings: [number, number][][] }[] }[];
  parts: LocalPolygon[];
  masks: LocalPolygon[];
  pairs: { lane: string; a: { x: number; n: number }; b: { x: number; n: number }; before: number }[];
}
const fixture = JSON.parse(readFileSync(new URL('./fixtures/raw-deck-grade.json', import.meta.url), 'utf8')) as Fixture;
function fixtureMesh() {
  const rawDeckTieIn = createRawDeckTieIn(fixture.nodes, fixture.cells, fixture.constrained, fixture.masks, 4, 8);
  const pieces = meshRawDeckTieIn({ parts: fixture.parts, cells: fixture.cells, stats: { gridMetres: 4 }, rawDeckTieIn }, 128, () => []);
  const rounded = pieces.map(p => ({ ...p, positions: p.positions.map(Math.fround), uvs: p.uvs.map(Math.fround) }));
  return { field: rawDeckTieIn, pieces: rounded, support: createGroundSupportSampler(rounded) };
}

test('all ten measured source-road and exact tyre-offset steps pass after Float32 meshing', () => {
  const { support } = fixtureMesh();
  assert.equal(fixture.pairs.length, 10);
  for (const pair of fixture.pairs) {
    assert.ok(pair.before > 0.35, 'Fixture must retain the original failing source pair');
    const a = support(pair.a.x, -pair.a.n), b = support(pair.b.x, -pair.b.n);
    assert.ok(a && b, `${pair.lane} must keep both wheel support samples`);
    assert.ok(Math.abs(a.height - b.height) <= 0.35, `${pair.lane} retains an abrupt step`);
  }
});

test('the actual source bridge and two tiny companions retain raw surface and texture coordinates', () => {
  const { field, pieces, support } = fixtureMesh();
  let probes = 0;
  for (const source of fixture.masks) for (let x = source.bbox[0] + 0.125; x < source.bbox[2]; x += 0.25) for (let n = source.bbox[1] + 0.125; n < source.bbox[3]; n += 0.25) {
    if (!field.rawContains(x, n)) continue;
    const expected = field.rawAt(x, n), actual = support(x, -n);
    assert.ok(expected !== null && actual, `Raw source ${source.id} must remain supported`);
    assert.ok(Math.abs(expected - actual.height) < 0.001, `Raw source ${source.id} moved beyond Float32 precision`);
    probes++;
  }
  assert.ok(probes >= 2487);
  let rawVertices = 0;
  for (const piece of pieces) for (let i = 0; i < piece.positions.length; i += 3) {
    const x = piece.positions[i]!, n = -piece.positions[i + 2]!;
    if (!field.rawContains(x, n)) continue;
    const scale = piece.finish === 'asphalt' ? 6 : ['setts', 'cobble'].includes(piece.finish) ? 2 : piece.finish === 'gravel' ? 4 : 3;
    assert.ok(Math.abs(piece.uvs[i / 3 * 2]! - x / scale) < Math.max(2e-5, Math.abs(x / scale) * 2 ** -23));
    assert.ok(Math.abs(piece.uvs[i / 3 * 2 + 1]! - n / scale) < Math.max(2e-5, Math.abs(n / scale) * 2 ** -23));
    rawVertices++;
  }
  assert.ok(rawVertices > 0);
});
