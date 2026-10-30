import assert from 'node:assert/strict';
import polygonClipping from 'polygon-clipping';
import type {Vec3} from '../../../packages/world-schema/src/index.ts';
import {bbox, pointInPolygon, type LocalPolygon} from './geometry.ts';
import {sourceSha256} from './source-files.ts';
import {reviewedBridgeWalkingSeamFaces, readBridgeWalkingSeamProfile, type ReviewedBridgeWalkingSeam} from './reviewed-bridge-walking-seam.ts';

type Face = {points: readonly Vec3[]; sourcePartIds: readonly number[]};
const pedestrianBridgeSubtypes = new Set(['Jalankulkualue (Silta)', 'Erotettu jalkakäytävä (Silta)']);
const hash = (value: unknown) => sourceSha256(JSON.stringify(value));

/** The caller has already verified complete published-profile level closure.
 * Each source polygon is clipped to only the faces assigned to that source
 * part, preserving its municipal classification and excluding cycle bands. */
export function clipReviewedBridgeWalkingSources(parts: readonly LocalPolygon[], faces: readonly Face[]): LocalPolygon[] {
  assert.ok(faces.length > 0 && faces.length <= 10000);
  return parts.flatMap(part => {
    if (part.properties.paatyyppi !== 'Silta' || !pedestrianBridgeSubtypes.has(String(part.properties.alatyyppi))) return [];
    const selected = faces.filter(face => face.sourcePartIds.includes(Number(part.id)));
    if (!selected.length) return [];
    let sheet: polygonClipping.MultiPolygon = [];
    for (let i = 0; i < selected.length; i += 64) sheet = polygonClipping.union(sheet, ...selected.slice(i, i + 64).map(face => {
      assert.ok(face.points.length === 3 && face.points.every(p => p.every(Number.isFinite)));
      return [face.points.map(p => [p[0], -p[2]] as [number, number])];
    }));
    return polygonClipping.intersection(part.rings, sheet).map(p => {
      const rings = p.map(r => r.slice(0, -1));
      return {id: part.id, properties: structuredClone(part.properties), rings, bbox: bbox(rings)};
    });
  });
}

declare const sourceBrand: unique symbol;
export interface ReviewedBridgeWalkingSource {readonly [sourceBrand]: true}
const sources = new WeakMap<object, {recordId: string; parts: LocalPolygon[]; gaps: polygonClipping.MultiPolygon; gapPartIds: string[]}>();

/** Called only for the exact selected upperWalking record after the common
 * source/graph/profile/final-HCOL loader succeeds. A seam gap additionally needs
 * its opaque geometric authority and literal approved public profile. */
export function prepareReviewedBridgeWalkingSource(input: {
  recordId: string; parts: readonly LocalPolygon[]; faces: readonly Face[];
  additions?: readonly {authority: ReviewedBridgeWalkingSeam; profileBytes: Uint8Array; baseProfileBytes: Uint8Array}[];
}) {
  assert.match(input.recordId, /^w\d+$/);
  const parts = clipReviewedBridgeWalkingSources(input.parts, input.faces);
  let gaps: polygonClipping.MultiPolygon = [];
  const gapPartIds = new Set<string>();
  const seamReceipts = [];
  for (const addition of input.additions ?? []) {
    const bound = reviewedBridgeWalkingSeamFaces(addition.authority);
    if (input.recordId !== 'w' + bound.sourceWayId) continue;
    const profile = readBridgeWalkingSeamProfile(addition.profileBytes, addition.baseProfileBytes);
    assert.deepEqual(bound.faces, profile.faces);
    assert.ok(bound.sourcePartIds.every(id => parts.some(p => p.id === String(id))), 'Walking seam lacks both exact clipped pedestrian source parts');
    const available = new Set(input.faces.map(face => hash(face.points)));
    assert.ok(bound.faces.every(face => available.has(hash(face.points))), 'Walking source seam is not in the selected complete upper floor');
    const working = profile.rawSourceGap.map(p => p.map(r => r.map(([x, z]) => [x, -z] as [number, number])));
    gaps = polygonClipping.union(gaps, working);
    for (const id of bound.sourcePartIds) gapPartIds.add(String(id));
    seamReceipts.push({profileSha256: sourceSha256(addition.profileBytes), sourceWayId: bound.sourceWayId, sourcePartIds: bound.sourcePartIds, exactRawSourceGapSha256: hash(profile.rawSourceGap)});
  }
  const token = Object.freeze({}) as ReviewedBridgeWalkingSource;
  sources.set(token, {recordId: input.recordId, parts: structuredClone(parts), gaps: structuredClone(gaps), gapPartIds: [...gapPartIds]});
  return {authority: token, receipt: {kind: 'exact-pedestrian-bridge-source-intersection', recordId: input.recordId, sourcePartHashes: input.parts.filter(p => parts.some(q => p.id === q.id)).map(p => ({id: p.id, sha256: hash(p)})), clippedParts: parts.map(p => ({id: p.id, sha256: hash(p)})), selectedFaceSha256: hash(input.faces), seams: seamReceipts}};
}

export function reviewedBridgeWalkingParts(authority: ReviewedBridgeWalkingSource, recordId: string, partId: string): LocalPolygon[] {
  const source = sources.get(authority); assert.ok(source && source.recordId === recordId, 'Walking source authority belongs to another record');
  return structuredClone(source.parts.filter(p => p.id === partId));
}

export function reviewedBridgeWalkingGapContains(authority: ReviewedBridgeWalkingSource, recordId: string, declaredPartIds: readonly string[], x: number, z: number): boolean {
  const source = sources.get(authority); assert.ok(source && source.recordId === recordId, 'Walking gap authority belongs to another record');
  assert.ok(Number.isFinite(x) && Number.isFinite(z));
  return source.gapPartIds.every(id => declaredPartIds.includes(id)) && source.gaps.some(p => pointInPolygon([x, -z], p));
}
