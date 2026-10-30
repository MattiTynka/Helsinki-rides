import test from 'node:test';
import assert from 'node:assert/strict';
import {assertBridgeLevelClosure, type BridgeLevel, type BridgeLevelWitness, type NativeLowerWitness} from '../lib/bridge-level-closure.ts';
import {buildExtraBridgeDeck, type ExtraBridgeDeckProfile} from '../lib/delivery-extra-bridges-mesh.ts';
import {splitBridgeFaces} from '../lib/bridge-reconstruction.ts';
import {sourceSha256} from '../lib/source-files.ts';
import type {RoadSupportTriangle} from '../lib/expansion-road-merge.ts';

function fixture() {
  const source = {cell: 'native', collider: 'bank', triangle: 0, sha256: 'a'.repeat(64)};
  const deck: ExtraBridgeDeckProfile = {
    surfaceMethod: 'native-bank-piecewise-planar-ruled-sections-v1', frame: {origin: [10, 20], direction: [1, 0]},
    banks: [-2, 22].map(s => ({s, segments: [
      {t0: -3, t1: 3, y0: 4, y1: 4, role: 'road', sourcePartIds: [1], source},
      {t0: 3, t1: 5, y0: 4.15, y1: 4.15, role: 'walk', sourcePartIds: [2], source},
    ]})) as ExtraBridgeDeckProfile['banks'],
    upperParts: [
      {id: 1, role: 'road', tag: 'road:asphalt', rings: [[[8, 17], [32, 17], [32, 23], [8, 23], [8, 17]]], sha256: 'b'.repeat(64)},
      {id: 2, role: 'walk', tag: 'raised:asphalt', rings: [[[8, 23], [32, 23], [32, 25], [8, 25], [8, 23]]], sha256: 'c'.repeat(64)},
    ], crownMetres: 0, deckThicknessMetres: .3, maximumGrade: .15,
  };
  const selected: Record<BridgeLevel, BridgeLevelWitness[]> = {upperRoad: [], upperWalking: [], northernLower: []};
  const actual: RoadSupportTriangle[] = [], cells = [...splitBridgeFaces(buildExtraBridgeDeck(deck).faces).keys()];
  for (const [cell, faces] of splitBridgeFaces(buildExtraBridgeDeck(deck).faces)) for (const [i, f] of faces.entries()) {
    if (f.role !== 'road' && f.role !== 'footway') continue;
    const level = f.role === 'road' ? 'upperRoad' : 'upperWalking';
    const face = {id: `serialized:${cell}:authored:${i}`, tag: level === 'upperRoad' ? 'road:asphalt:bridge-reconstruction' : 'raised:asphalt:bridge-reconstruction', points: f.points};
    actual.push(face);
    selected[level].push({...face, triangleSha256: sourceSha256(JSON.stringify(face.points)), sourcePartIds: [(f as typeof f & {sourcePartIds: number[]}).sourcePartIds[0]!]});
  }
  const lower: NativeLowerWitness = {id: 'native', cell: cells[0]!, tag: 'raised:asphalt', sourcePartIds: [3], points: [[10, 0, 23], [10, 0, 25], [12, 0, 23]]};
  const current = {...lower, id: `serialized:${lower.cell}:original:0`}; actual.push(current);
  selected.northernLower.push({...current, triangleSha256: sourceSha256(JSON.stringify(current.points))});
  return {deck, originalLower: [lower], actual, selected, cells};
}
const check = (f: ReturnType<typeof fixture>) => assertBridgeLevelClosure(f.deck, f.originalLower, f.actual, f.selected, f.cells);

test('complete reconstructed upper roles and independently pinned native lower floors pass without changing inputs', () => {
  const f = fixture(), before = structuredClone(f), proof = check(f);
  assert.deepEqual(f, before); assert.equal(proof.levels.northernLower!.faces, 1);
  assert.equal(proof.levels.upperWalking!.faces, f.selected.upperWalking.length);
});
test('actual lower HCOL cannot be rehashed into an upper role or swapped for one upper face', () => {
  for (const level of ['upperRoad', 'upperWalking'] as const) {
    const swapped = fixture(); swapped.selected[level] = structuredClone(swapped.selected.northernLower);
    assert.throws(() => check(swapped), /closure|published bridge level/);
    const single = fixture(); single.selected[level][0] = structuredClone(single.selected.northernLower[0]!);
    assert.throws(() => check(single), /published bridge level/);
  }
});
test('all roles reject omissions, additions, duplicate faces and substituted source parts', () => {
  for (const level of ['upperRoad', 'upperWalking', 'northernLower'] as const) {
    const omitted = fixture(); omitted.selected[level].pop(); assert.throws(() => check(omitted), /closure/);
    const added = fixture(); added.selected[level].push(structuredClone(added.selected[level][0]!)); assert.throws(() => check(added), /closure/);
    const parts = fixture(); parts.selected[level][0]!.sourcePartIds = [999]; assert.throws(() => check(parts), /source-part closure/);
  }
});
test('stale profile or original native lower sheet cannot authorize current geometry', () => {
  const profile = fixture(); profile.deck.banks[0].segments[1]!.y0 += .01;
  assert.throws(() => check(profile), /exist exactly once/);
  const lower = fixture(); lower.originalLower = structuredClone(lower.originalLower); lower.originalLower[0]!.points[0][1] += .01;
  assert.throws(() => check(lower), /exist exactly once/);
  const cell = fixture(); cell.cells = []; assert.throws(() => check(cell), /cells omit/);
});
