import assert from 'node:assert/strict';
import {buildExtraBridgeDeck, type ExtraBridgeDeckProfile} from './delivery-extra-bridges-mesh.ts';
import {splitBridgeFaces} from './bridge-reconstruction.ts';
import type {RoadSupportTriangle} from './expansion-road-merge.ts';
import {sourceSha256} from './source-files.ts';
import {reviewedBridgeWalkingSeamFaces, type ReviewedBridgeWalkingSeam} from './reviewed-bridge-walking-seam.ts';

export type BridgeLevel = 'upperRoad' | 'upperWalking' | 'northernLower';
export interface BridgeLevelWitness extends RoadSupportTriangle {
  triangleSha256: string;
  sourcePartIds: number[];
}
export interface NativeLowerWitness extends RoadSupportTriangle {cell: string; sourcePartIds: number[]}
const key = (cell: string, face: RoadSupportTriangle) => cell + '|' + face.tag + '|' + sourceSha256(JSON.stringify(face.points));

/** A caller's current-HCOL selection is evidence of existence, not of level.
 * Reconstruct the complete upper role closure from the published profile and
 * require the lower role to retain its independently pinned native sheets. */
export function assertBridgeLevelClosure(
  deck: ExtraBridgeDeckProfile,
  originalLower: readonly NativeLowerWitness[],
  actual: readonly RoadSupportTriangle[],
  selected: Record<BridgeLevel, readonly BridgeLevelWitness[]>,
  selectedCells: readonly string[],
  additions: readonly ReviewedBridgeWalkingSeam[] = [],
) {
  const split = splitBridgeFaces(buildExtraBridgeDeck(deck).faces);
  const cells = [...split.keys()].sort();
  assert.ok(new Set(selectedCells).size === selectedCells.length && cells.every(cell => selectedCells.includes(cell)), 'Bridge level cells omit or duplicate the reconstructed floor closure');
  const expected: Record<BridgeLevel, Map<string, {cell: string; face: RoadSupportTriangle; sourcePartIds: number[]}>> = {
    upperRoad: new Map(), upperWalking: new Map(), northernLower: new Map(),
  };
  for (const [cell, faces] of split) for (const face of faces) {
    if (!face.collision || (face.role !== 'road' && face.role !== 'footway')) continue;
    const level = face.role === 'road' ? 'upperRoad' : 'upperWalking';
    const reconstructed = {id: '', tag: level === 'upperRoad' ? 'road:asphalt:bridge-reconstruction' : 'raised:asphalt:bridge-reconstruction', points: face.points};
    const identity = key(cell, reconstructed);
    assert.ok(!expected[level].has(identity), 'Ambiguous duplicate reconstructed bridge floor');
    expected[level].set(identity, {cell, face: reconstructed, sourcePartIds: (face as typeof face & {sourcePartIds: number[]}).sourcePartIds});
  }
  for (const face of originalLower) {
    assert.ok(cells.includes(face.cell), 'Native lower authority lies outside the bridge cells');
    const identity = key(face.cell, face);
    assert.ok(!expected.northernLower.has(identity), 'Ambiguous duplicate original lower floor');
    expected.northernLower.set(identity, {cell: face.cell, face, sourcePartIds: face.sourcePartIds});
  }
  for (const authority of additions) {
    const addition = reviewedBridgeWalkingSeamFaces(authority);
    for (const face of addition.faces) {
      assert.ok(cells.includes(face.cell), 'Reviewed walking addition is outside the original bridge cells');
      const reconstructed = {id: '', tag: 'raised:asphalt:bridge-reconstruction', points: face.points};
      const identity = key(face.cell, reconstructed);
      assert.ok(!expected.upperWalking.has(identity), 'Duplicate reviewed walking addition');
      expected.upperWalking.set(identity, {cell: face.cell, face: reconstructed, sourcePartIds: addition.sourcePartIds});
    }
  }
  const actualByKey = new Map<string, RoadSupportTriangle[]>();
  for (const face of actual) {
    const cell = cells.find(cell => face.id.startsWith('serialized:' + cell + ':'));
    if (!cell) continue;
    const identity = key(cell, face), list = actualByKey.get(identity) ?? [];
    list.push(face); actualByKey.set(identity, list);
  }
  const closure: Record<string, {faces: number; sha256: string}> = {};
  for (const level of ['upperRoad', 'upperWalking', 'northernLower'] as const) {
    assert.ok(expected[level].size > 0, 'Published bridge role has no source-qualified floor: ' + level);
    const wanted = new Map<string, {face: RoadSupportTriangle; sourcePartIds: number[]}>();
    for (const entry of expected[level].values()) {
      const matches = actualByKey.get(key(entry.cell, entry.face));
      assert.equal(matches?.length, 1, 'Published bridge role must exist exactly once in final HCOL: ' + level);
      wanted.set(matches![0]!.id, {face: matches![0]!, sourcePartIds: entry.sourcePartIds});
    }
    assert.equal(selected[level].length, wanted.size, 'Bridge role closure has omitted or additional faces: ' + level);
    const seen = new Set<string>();
    for (const face of selected[level]) {
      const source = wanted.get(face.id);
      assert.ok(source && !seen.has(face.id), 'Selected face is not in its published bridge level: ' + level);
      seen.add(face.id);
      assert.deepEqual(face.points, source.face.points, 'Bridge role literal geometry changed');
      assert.equal(face.tag, source.face.tag, 'Bridge role surface changed');
      assert.equal(face.triangleSha256, sourceSha256(JSON.stringify(source.face.points)));
      assert.deepEqual(face.sourcePartIds, source.sourcePartIds, 'Bridge role source-part closure changed');
    }
    closure[level] = {faces: wanted.size, sha256: sourceSha256(JSON.stringify([...wanted].sort(([a], [b]) => a.localeCompare(b))))};
  }
  return {schemaVersion: 1, method: 'published-profile-reconstruction-and-pinned-native-lower-closure', cells, levels: closure};
}
