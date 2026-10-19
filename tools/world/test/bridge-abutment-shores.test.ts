import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveBridgeEndBanks, type SourceBridgeAxis } from '../lib/bridge-abutment-shores.ts';
import { qualifyCoastalShoreSeals, type ShoreAuthoritySegment, type ShoreMesh } from '../lib/coastal-shore-seals.ts';
import { meshVerticalSeals } from '../lib/vertical-seal-mesh.ts';
import type { LocalPolygon } from '../lib/geometry.ts';

const box = (id: string, x0: number, z0: number, x1: number, z1: number, properties: Record<string, unknown> = {}): LocalPolygon => ({ id, properties, bbox: [x0, -z1, x1, -z0], rings: [[[x0, -z1], [x1, -z1], [x1, -z0], [x0, -z0]]] });
const water = [box('source-water', -100, -100, 100, 0)];
const shore: ShoreAuthoritySegment[] = [{ id: 'actual-bank', a: [0, 0], b: [10, 0], drySide: 1 }];
const deck = box('survey-bridge', 2, -5, 8, 2, { paatyyppi: 'Silta', alatyyppi: 'Ajorata (Silta)', alueen_nimi: 'Street' });
const dry = box('ordinary-dry-street', 2, 2, 8, 10, { paatyyppi: 'Ajorata', alatyyppi: 'Ajorata', alueen_nimi: 'Street' });
const axis: SourceBridgeAxis = { way: 100, nodes: [1, 2], points: [[5, 0], [5, -4]] };
const top: ShoreMesh = { cell: 'cell', primitiveName: 'ground_asphalt', primitiveIndex: 0, positions: Float32Array.from([-1, 2, -4, 11, 2, -4, 5, 2, 4]), indices: Uint32Array.from([0, 2, 1]) };
const derive = (axes = [axis], parts = [deck, dry]) => deriveBridgeEndBanks(axes, parts, shore, water);

test('an exact water-to-land bridge endpoint binds only its real bank and adjacent source dry component', () => {
  const r = derive(); assert.equal(r.banks.length, 1); const bank = r.banks[0]!;
  assert.equal(bank.lo, .2); assert.equal(bank.hi, .8); assert.deepEqual(bank.bridgeWays, [100]); assert.deepEqual(bank.deckPartIds, ['survey-bridge']); assert.deepEqual(bank.dryPartIds, ['ordinary-dry-street']);
  assert.equal(bank.proofs[0]!.endpointShoreDistanceMetres, 0); assert.deepEqual(bank.proofs[0]!.dryAdjacency[0]!.shared.map(p => p[1]), [-2, -2]);
});

test('source midspan, side perimeters, piers and a deck without an actual matching axis cannot authorize a bank', () => {
  assert.equal(derive([{ ...axis, points: [[5, -2], [5, -4]] }]).banks.length, 0);
  assert.equal(derive([axis], [{ ...deck, properties: { man_made: 'pier' } }, dry]).banks.length, 0);
  assert.equal(derive([{ ...axis, points: [[1, 0], [1, -4]] }]).banks.length, 0);
  assert.equal(derive([{ ...axis, points: [[5, 0], [5, 4]] }]).banks.length, 0);
});

test('a nearby disconnected street or wet-side shared boundary is not source dry adjacency', () => {
  assert.equal(derive([axis], [deck, { ...dry, rings: dry.rings.map(r => r.map(([x, y]) => [x, y - .01] as [number, number])), bbox: [2, -10.01, 8, -2.01] }]).banks.length, 0);
  assert.equal(derive([axis], [deck, box('wet-street', 2, -10, 8, -5, dry.properties)]).banks.length, 0);
  assert.equal(derive([axis], [deck, { ...deck, id: 'overlapping-source-footprint', properties: dry.properties }]).banks.length, 0);
});

test('duplicate source ways and a canonical bend are partitioned without overlapping bank authority', () => {
  const source = [{ ...shore[0]!, b: [5, 0] as [number, number] }, { ...shore[0]!, id: 'next-bank-piece', a: [5, 0] as [number, number] }], r = deriveBridgeEndBanks([axis, { ...axis, way: 101, nodes: [3, 4] }], [deck, dry], source, water);
  assert.equal(r.banks.length, 2); assert.ok(r.banks.every(b => b.bridgeWays.length === 2)); assert.equal(r.stats.bankLengthMetres, 6);
});

test('accepted land and its configured margin receive no endpoint bank authority', () => {
  const r = deriveBridgeEndBanks([axis], [deck, dry], shore, water, { protectedArea: { minX: 9, maxX: 10, minZ: 0, maxZ: 2 }, protectedMarginMetres: 1 });
  assert.equal(r.banks.length, 0); assert.ok(r.rejected.some(r => r.reason === 'accepted-protected-margin'));
});

test('only explicit endpoint authority closes an equal-height crossing deck; all old arrays remain exact', () => {
  const before = { positions: new Float32Array(top.positions), indices: new Uint32Array(top.indices) }, banks = derive().banks;
  assert.equal(qualifyCoastalShoreSeals([top], shore, [deck], 0).seals.length, 0);
  const r = qualifyCoastalShoreSeals([top], shore, [deck], 0, { bridgeEndBanks: banks, bridgeEndBanksOnly: true }); assert.ok(r.seals.length);
  assert.ok(r.seals.every(s => s.source.bridgeEndBankIds?.length && s.source.structuralAbutment && [...s.top, ...s.bottom].every(p => p[0] >= 2 && p[0] <= 8 && p[2] === 0)));
  assert.deepEqual(top.positions, before.positions); assert.deepEqual(top.indices, before.indices);
  const meshed = meshVerticalSeals(r.seals.map(s => ({ ...s, polygon: [[s.top[0], s.top[1], s.bottom[1], s.bottom[0]]], section: [[[0, s.top[0][1]], [Math.hypot(s.top[1][0] - s.top[0][0], s.top[1][2] - s.top[0][2]), s.top[1][1]], [Math.hypot(s.top[1][0] - s.top[0][0], s.top[1][2] - s.top[0][2]), s.bottom[1][1]], [0, s.bottom[0][1]]]] })));
  assert.equal(meshed.stats.maximumNormalY, 0); assert.ok(meshed.indices.length > 0);
});

test('existing solid bank coverage is subtracted instead of creating a new veneer', () => {
  const wall: ShoreMesh = { ...top, primitiveName: 'ground_slabs', positions: Float32Array.from([2, 2, 0, 8, 2, 0, 2, 1, 0, 8, 1, 0]), indices: Uint32Array.from([0, 1, 2, 1, 3, 2]) }, banks = derive().banks;
  const r = qualifyCoastalShoreSeals([top, wall], shore, [deck], 0, { bridgeEndBanks: banks, bridgeEndBanksOnly: true }); assert.ok(r.seals.length); assert.ok(r.seals.every(s => s.top.every(p => p[1] === 1) && s.bottom.every(p => p[1] === 0)));
});

test('empty optional endpoint authority leaves the prior qualifier output unchanged', () => {
  assert.deepEqual(qualifyCoastalShoreSeals([top], shore, [deck], 0), qualifyCoastalShoreSeals([top], shore, [deck], 0, { bridgeEndBanks: [] }));
  assert.equal(qualifyCoastalShoreSeals([top], shore, [deck], 0, { bridgeEndBanksOnly: true }).seals.length, 0);
});
