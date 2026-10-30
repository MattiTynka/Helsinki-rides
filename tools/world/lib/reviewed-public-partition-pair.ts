import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import type {PublicPartitionPatch} from './public-partition-ground.ts';
import type {LocalPolygon} from './geometry.ts';
import type {RoadSourceElement, RoadSupportTriangle} from './expansion-road-merge.ts';

/** A single reviewed source-chain exception. These pins deliberately do not form a
 * caller-configurable tolerance or permit other public polygons to inherit approval. */
export const REVIEWED_EHRENSTROM_PAIR = Object.freeze({
  id: 'ehrenstrom-41211-41212-crossing-v5',
  proposalSha256: 'e2e0e2f07a5f2f04579a3db7519e77ccf8205fdbea7055a1bf717b3e1d1f7d8e',
  qualificationSha256: 'fa6b157009ab5b00af7bea3a9dc500075b882283a73cac1e7c172baeabe1044d',
  scopeSha256: 'bae8061492079e068ad4e266f4223f53e9ac835c543d2e8e5b6d0f61b1ba1bc1',
  nativeClosureSha256: '788c88e63b463338a160d828e10bee6f5024424b8273f30883989d82ea81483d',
  nativeClosureTriangles: 24,
  originalManifestSha256: 'a6872e68f4a96898d5a915dc99cf3cfb01ce82b4ec6f45bafb8932eb0a4032be',
  streetPartsSha256: '1ac1409cf70cd6c3ad1ab7139fd6f365898d5c654e499616a1892d1b669645b2',
  osmSha256: 'a6bf71bae890ab60b4249c8546e6b7185ce37c9ede4137e9c4aefbd9a755e65a',
});
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 768 * 1024;
const identity = Symbol('reviewed-public-partition-pair');
export interface ReviewedPublicPartitionPair {readonly id: typeof REVIEWED_EHRENSTROM_PAIR.id; readonly [identity]: true}
interface BoundReview {
  proposal: {sourceDelta: PublicPartitionPatch['sourceDelta']; physicalDomain: PublicPartitionPatch['physicalDomain'];
    triangles: PublicPartitionPatch['triangles']; boundsXZ: [number, number, number, number]; sourceArea: number};
  qualification: {sourceParts: {id: string; sourceSha256: string}[]; osm: {wayId: number; waySha256: string};
    acceptedPlayArea: {minX: number; minZ: number; maxX: number; maxZ: number}};
}
const reviews = new WeakMap<ReviewedPublicPartitionPair, BoundReview>();
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {for (const child of Object.values(value)) freeze(child); Object.freeze(value);}
  return value;
}
function parsePinned(bytes: Uint8Array, expected: string, label: string): any {
  assert.ok(bytes instanceof Uint8Array && bytes.byteLength > 0 && bytes.byteLength <= MAX_FILE_BYTES, `${label} byte limit`);
  assert.equal(sha(bytes), expected, `${label} is not the approved literal artifact`);
  // A matching approved digest binds the entire schema and values before parsing.
  try {return JSON.parse(Buffer.from(bytes).toString('utf8'));} catch {throw new Error(`${label} is invalid JSON`);}
}
export function readReviewedPublicPartitionPair(input: {
  proposalBytes: Uint8Array; qualificationBytes: Uint8Array; scopeBytes: Uint8Array;
}): ReviewedPublicPartitionPair {
  assert.deepEqual(Object.keys(input).sort(), ['proposalBytes', 'qualificationBytes', 'scopeBytes']);
  assert.ok(input.proposalBytes instanceof Uint8Array && input.qualificationBytes instanceof Uint8Array && input.scopeBytes instanceof Uint8Array, 'Review artifacts must be bytes');
  assert.ok(input.proposalBytes.byteLength + input.qualificationBytes.byteLength + input.scopeBytes.byteLength <= MAX_TOTAL_BYTES, 'Review aggregate byte limit');
  const p = parsePinned(input.proposalBytes, REVIEWED_EHRENSTROM_PAIR.proposalSha256, 'Pair proposal');
  const q = parsePinned(input.qualificationBytes, REVIEWED_EHRENSTROM_PAIR.qualificationSha256, 'Pair qualification');
  const s = parsePinned(input.scopeBytes, REVIEWED_EHRENSTROM_PAIR.scopeSha256, 'Pair crossing scope');
  assert.equal(p.manifestSha256, REVIEWED_EHRENSTROM_PAIR.originalManifestSha256);
  assert.equal(q.proposalSha256, REVIEWED_EHRENSTROM_PAIR.proposalSha256);
  assert.equal(p.scopeSha256, REVIEWED_EHRENSTROM_PAIR.scopeSha256);
  assert.deepEqual(p.sourceDelta, s.sourceGap);
  assert.deepEqual(p.physicalDomain, s.domain);
  assert.equal(p.failures.length, 0);
  assert.equal(p.sourceGapRemainingArea, 0);
  assert.equal(s.contextMetres, .25);
  assert.equal(s.allUsedCrossingSweepsCovered, true);
  assert.equal(q.inputs['../sources/raw-v2/street-parts/southwest-cumulative-20261029.geojson'], REVIEWED_EHRENSTROM_PAIR.streetPartsSha256);
  assert.equal(q.inputs['../sources/raw-v2/osm/southwest-cumulative-20261029.json'], REVIEWED_EHRENSTROM_PAIR.osmSha256);
  const review = Object.freeze({id: REVIEWED_EHRENSTROM_PAIR.id, [identity]: true as const});
  reviews.set(review, freeze({proposal: p, qualification: q}));
  return review;
}
function upwardNormal(points: RoadSupportTriangle['points']): number {
  const [a, b, c] = points, u = b.map((v, i) => v - a[i]!), v = c.map((n, i) => n - a[i]!);
  const normal = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
  return normal[1]! / Math.hypot(...normal);
}
/** Source eligibility only. The caller MUST still run the ordinary complete
 * native5mm/2mm, positive normal, physical-area and serialized preservation gates.
 * This allows only the approved source6mm/.01m2 prefilters to be superseded. */
export function qualifyReviewedPublicPartitionPair(
  patch: PublicPartitionPatch, parts: readonly LocalPolygon[], ways: ReadonlyMap<number, RoadSourceElement>,
  floor: readonly RoadSupportTriangle[], accepted: readonly [number, number, number, number], review: ReviewedPublicPartitionPair,
  currentSourcePins: {readonly streetPartsSha256: string; readonly osmSha256: string},
) {
  const bound = reviews.get(review); assert.ok(bound, 'Pair review was not loaded from approved pinned bytes');
  // A matching selected pair/way is insufficient: a refreshed source could add a
  // third median, private feature or restriction relation in the reviewed gap.
  // Callers supply hashes of their actually read raw inputs, not historical pins.
  assert.deepEqual(Object.keys(currentSourcePins).sort(), ['osmSha256', 'streetPartsSha256']);
  assert.equal(currentSourcePins.streetPartsSha256, REVIEWED_EHRENSTROM_PAIR.streetPartsSha256, 'Whole municipal source changed since pair conflict review');
  assert.equal(currentSourcePins.osmSha256, REVIEWED_EHRENSTROM_PAIR.osmSha256, 'Whole OSM source changed since public-access review');
  const {proposal: p, qualification: q} = bound;
  assert.ok(patch.lane === '80326984:0:f0' || patch.lane === '80326984:0:b0', 'Unreviewed lane for pair exception');
  assert.deepEqual(patch.sourcePartIds, ['41211', '41212'], 'Unreviewed source pair');
  assert.deepEqual(patch.sourceDelta, p.sourceDelta, 'Source gap differs from the reviewed crossing scope');
  assert.deepEqual(patch.physicalDomain, p.physicalDomain, 'Physical domain differs from the reviewed source scope');
  assert.deepEqual(patch.triangles, p.triangles, 'Proposed native faces differ from the approved proposal');
  const old = q.acceptedPlayArea;
  assert.deepEqual(accepted, [old.minX, old.minZ, old.maxX, old.maxZ], 'Accepted authority differs from the reviewed baseline');
  const b = p.boundsXZ;
  assert.ok(b[2] < accepted[0] || b[0] > accepted[2] || b[3] < accepted[1] || b[1] > accepted[3], 'Reviewed pair overlaps accepted authority');
  for (const expected of q.sourceParts) {
    const found = parts.filter(part => part.id === expected.id); assert.equal(found.length, 1, 'Source pair owner must be unique');
    assert.equal(sha(JSON.stringify(found[0])), expected.sourceSha256, 'Reviewed municipal source geometry or metadata changed');
  }
  const way = ways.get(q.osm.wayId); assert.ok(way);
  assert.equal(sha(JSON.stringify(way)), q.osm.waySha256, 'Reviewed public OSM way changed');
  // Include every nearby low-slope road face, not just the chosen nearest face.
  // Changed/missing levels and additional local faces invalidate this sealed closure.
  const local = floor.filter(t => t.tag.startsWith('road:') && upwardNormal(t.points) > .98
    && Math.min(...t.points.map(p => p[0])) <= b[2] + .02 && Math.max(...t.points.map(p => p[0])) >= b[0] - .02
    && Math.min(...t.points.map(p => p[2])) <= b[3] + .02 && Math.max(...t.points.map(p => p[2])) >= b[1] - .02)
    .map(t => ({id: t.id, tag: t.tag, points: t.points})).sort((a, b) => a.id.localeCompare(b.id, 'en'));
  assert.equal(local.length, REVIEWED_EHRENSTROM_PAIR.nativeClosureTriangles, 'Reviewed native triangle closure changed');
  assert.equal(new Set(local.map(t => t.id)).size, local.length, 'Duplicate native triangle identity');
  assert.equal(sha(JSON.stringify(local)), REVIEWED_EHRENSTROM_PAIR.nativeClosureSha256, 'Reviewed native face bytes changed');
  return {
    schemaVersion: 1, kind: 'literal-reviewed-public-partition-pair', id: review.id,
    proposalSha256: REVIEWED_EHRENSTROM_PAIR.proposalSha256,
    qualificationSha256: REVIEWED_EHRENSTROM_PAIR.qualificationSha256,
    scopeSha256: REVIEWED_EHRENSTROM_PAIR.scopeSha256,
    originalManifestSha256: REVIEWED_EHRENSTROM_PAIR.originalManifestSha256,
    nativeClosureSha256: REVIEWED_EHRENSTROM_PAIR.nativeClosureSha256, nativeClosureTriangles: local.length,
    sourcePartIds: [...patch.sourcePartIds], lane: patch.lane, sourceGapArea: p.sourceArea,
    currentSourcePins: {...currentSourcePins},
    sourceEligibilityOnly: true, physicalGatesRequired: 'existing common-native5mm/affine2mm/normal0.98/physical-area0.05m2',
  } as const;
}
