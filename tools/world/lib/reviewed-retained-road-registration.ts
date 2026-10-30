import assert from 'node:assert/strict';
import {polylineLength, type RoadLane, type Vec3} from '../../../packages/world-schema/src/index.ts';
import type {LocalPolygon} from './geometry.ts';
import type {RoadSupportTriangle} from './expansion-road-merge.ts';
import {sourceSha256} from './source-files.ts';

export const ITAMERENKATU_OUTSIDE_REGISTRATION_APPROVAL_SHA256 = 'd15a70f5420ff1e3d6521fc44b0522af30985e3c2067990c5444dceb1dfd10b6';
const RECORD_ID = '122961573:0:f0';
const PROTECTED_RECTANGLE = [-1792,-2304,800,768];
const hash = (value: unknown) => sourceSha256(JSON.stringify(value));
const keys = (value: object, expected: string[]) => assert.deepEqual(Object.keys(value).sort(), expected.sort(), 'Unexpected retained-road review field');
const digest = (value: string) => assert.match(value, /^[a-f0-9]{64}$/);
interface CellPin {cell: string; storedSha256: string; decodedSha256: string}
export interface ReviewedRetainedRoadRegistration {
  schemaVersion: 1;
  kind: 'source-bound-outside-retained-lane-horizontal-registration';
  approvedProposalSha256: string;
  acceptedManifestSha256: string;
  streetPartsSha256: string;
  vehicleDefinitionsSha256: string;
  world: {manifestSha256: string; cells: CellPin[]};
  record: {id: string; acceptedRecordSha256: string; registeredRecordSha256: string};
}
export interface RetainedRoadRegistrationInputs {
  review: ReviewedRetainedRoadRegistration;
  approvedProposalBytes: Uint8Array;
  acceptedManifestSha256: string;
  streetPartsBytes: Uint8Array;
  vehicleDefinitionsSha256: string;
  acceptedLane: RoadLane;
  registeredLane: RoadLane;
  parts: readonly LocalPolygon[];
  floor: {manifestSha256: string; cells: CellPin[]; triangles: readonly RoadSupportTriangle[]};
}

/** One reviewed outside-XZ baseline, never a generic accepted-road allowance.
 * The caller still applies the normal Y/subdivision verifier to every record,
 * checks final support/travel, and hashes changes against the ORIGINAL graph.
 * The optional authority pin exists for isolated fixtures; production uses the
 * independently reviewed literal proposal hash above. */
export function qualifyReviewedRetainedRoadRegistration(input: RetainedRoadRegistrationInputs, authoritySha256 = ITAMERENKATU_OUTSIDE_REGISTRATION_APPROVAL_SHA256) {
  const {review, acceptedLane, registeredLane, floor} = input;
  keys(review, ['schemaVersion','kind','approvedProposalSha256','acceptedManifestSha256','streetPartsSha256','vehicleDefinitionsSha256','world','record']);
  assert.equal(review.schemaVersion, 1); assert.equal(review.kind, 'source-bound-outside-retained-lane-horizontal-registration');
  digest(authoritySha256); assert.equal(review.approvedProposalSha256, authoritySha256);
  assert.ok(input.approvedProposalBytes.length > 0 && input.approvedProposalBytes.length < 4_000_000);
  assert.equal(sourceSha256(input.approvedProposalBytes), authoritySha256, 'Approved retained-road proposal bytes changed');
  const proposal = JSON.parse(Buffer.from(input.approvedProposalBytes).toString()) as any;
  assert.equal(proposal.schemaVersion, 1); assert.equal(proposal.kind, 'source-bound-outside-retained-lane-horizontal-registration-proposal');
  assert.equal(proposal.status, 'SOURCE_AND_NATIVE_QUALIFIED_PENDING_PARENT_REVIEW_AND_STRICT_REPAIR_CONTRACT');
  for (const value of [review.acceptedManifestSha256,review.streetPartsSha256,review.vehicleDefinitionsSha256]) digest(value);
  assert.equal(review.acceptedManifestSha256, input.acceptedManifestSha256); assert.equal(proposal.acceptedManifestPin.sha256, input.acceptedManifestSha256);
  assert.equal(review.streetPartsSha256, sourceSha256(input.streetPartsBytes), 'Current raw municipal source changed');
  assert.equal(proposal.partsPin.sha256, review.streetPartsSha256);
  assert.equal(review.vehicleDefinitionsSha256, input.vehicleDefinitionsSha256); assert.equal(proposal.selected.admission.definitionsSha256, input.vehicleDefinitionsSha256);
  keys(review.world, ['manifestSha256','cells']); digest(review.world.manifestSha256);
  assert.equal(review.world.manifestSha256, floor.manifestSha256, 'Retained-road final world changed');
  assert.ok(floor.cells.length > 0 && floor.cells.length <= 16 && new Set(floor.cells.map(c => c.cell)).size === floor.cells.length);
  for (const cell of floor.cells) {keys(cell, ['cell','storedSha256','decodedSha256']); digest(cell.storedSha256); digest(cell.decodedSha256);}
  assert.deepEqual(review.world.cells, floor.cells, 'Retained-road HCOL pins changed');
  keys(review.record, ['id','acceptedRecordSha256','registeredRecordSha256']); digest(review.record.acceptedRecordSha256); digest(review.record.registeredRecordSha256);
  assert.equal(review.record.id, RECORD_ID, 'Other retained lanes have no horizontal registration authority');
  assert.equal(acceptedLane.id, RECORD_ID); assert.equal(registeredLane.id, RECORD_ID);
  assert.equal(review.record.acceptedRecordSha256, hash(acceptedLane)); assert.equal(proposal.acceptedRecordSha256, hash(acceptedLane));
  assert.deepEqual(acceptedLane, proposal.before, 'Accepted source lane differs from reviewed original');
  assert.equal(review.record.registeredRecordSha256, hash(registeredLane));
  assert.deepEqual(registeredLane, proposal.selected.after, 'Registered lane differs from literal reviewed geometry');
  const {points: oldPoints, length: _oldLength, ...oldMetadata} = acceptedLane;
  const {points: newPoints, length: newLength, ...newMetadata} = registeredLane;
  assert.deepEqual(newMetadata, oldMetadata, 'Retained lane identity or metadata changed');
  assert.equal(newLength, polylineLength(newPoints));
  assert.deepEqual(proposal.oldProtectedRectangle, PROTECTED_RECTANGLE);
  assert.equal(proposal.selected.shift, .05, 'Only the reviewed 5cm outside bump is authorized');
  assert.equal(proposal.seam.originalSegmentIndex, 0); assert.ok(oldPoints.length >= 2 && newPoints.length >= 3);
  const a = oldPoints[0]!, b = oldPoints[1]!, t = (-1792 - a[0]) / (b[0] - a[0]);
  assert.ok(t > 0 && t < 1 && a[0] > -1792 && oldPoints.slice(1).every(p => p[0] < -1792));
  const anchor = a.map((v, k) => v + (b[k]! - v) * t) as unknown as Vec3;
  assert.equal(proposal.seam.originalSegmentFraction, t); assert.deepEqual(proposal.seam.anchor, anchor, 'Exact accepted XYZ seam anchor changed');
  assert.deepEqual(newPoints[0], a, 'Accepted inside endpoint changed'); assert.deepEqual(newPoints[1], anchor, 'Accepted inside interpolation changed');
  assert.ok(newPoints.slice(2).every(p => p.length === 3 && p.every(Number.isFinite) && p[0] < -1792), 'Registered points re-enter accepted geography');
  assert.deepEqual([newPoints.at(-1)![0],newPoints.at(-1)![2]], [oldPoints.at(-1)![0],oldPoints.at(-1)![2]], 'Accepted final endpoint XZ changed');
  const part = input.parts.find(p => p.id === '41721'); assert.ok(part && part.properties.alatyyppi === 'Ajorata');
  assert.equal(hash(part), proposal.sourcePartSha256, 'Reviewed public carriageway changed'); assert.deepEqual(part, proposal.sourcePart);
  assert.equal(proposal.selected.admission.closedIntervals.length, 0); assert.equal(proposal.selected.physical.failureCount, 0);
  assert.ok(proposal.selected.physical.maxHeightDeviation <= .2);
  const actual = new Map(floor.triangles.map(t => [t.id,t]));
  assert.ok(proposal.selectedFaces.length > 0 && proposal.selectedFaces.length <= 20000);
  for (const face of proposal.selectedFaces) {
    assert.ok(face.tag.startsWith('road:') && floor.cells.some(c => face.id.startsWith(`serialized:${c.cell}:`)));
    assert.deepEqual(actual.get(face.id), face, 'Reviewed retained-road literal HCOL changed');
  }
  return {id: RECORD_ID, acceptedLane: structuredClone(acceptedLane), registeredLane: structuredClone(registeredLane), witness: {
    kind: review.kind, approvedProposalSha256: authoritySha256, acceptedManifestSha256: input.acceptedManifestSha256,
    acceptedRecordSha256: hash(acceptedLane), registeredRecordSha256: hash(registeredLane), streetPartsSha256: review.streetPartsSha256,
    sourcePartId: part.id, sourcePartSha256: hash(part), protectedRectangle: PROTECTED_RECTANGLE, exactSeamAnchor: anchor,
    acceptedInsidePiecewiseGeometryPreserved: true, originalEndpointXZPreserved: true, maximumAuthoringBumpMetres: .05,
    finalWorld: review.world, literalFloorFaces: proposal.selectedFaces.map((f: RoadSupportTriangle) => ({id:f.id,sha256:hash(f)})),
    pendingFinalSourceBodySupportAndTravel: true,
  }};
}
