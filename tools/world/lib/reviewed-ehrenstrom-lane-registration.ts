import assert from 'node:assert/strict';
import {decodeRoadGraph, polylineLength, type GameplayBundle, type RoadGraph, type RoadLane, type Vec3} from '../../../packages/world-schema/src/index.ts';
import {assertOutsideOnlyPolylineRepair} from './road-outside-repair.ts';
import {sourceSha256} from './source-files.ts';

export const EHRENSTROM_LANE_REGISTRATION_REVIEW_SHA256 = 'b1e0dcbb125ee1ecc4e8a9a986f63bd08582a46740685f4131f9bdac3c06f5a7';
const LANE_ID = '825173902:0:b0';
const AUTHORING_GRAPH_SHA = '5d17ad1ed1cdce86a7aba35aa9c39ee385ee440f408efb78426fb4b8b6cce4ce';
const PROJECTED_GRAPH_SHA = 'e9ef9d60f45d14eae23f24ac42762318a50fb900c4cf72723204bfb840f9d28f';
const PROJECTION_RECEIPT_SHA = '83f7cfa792d4d80d7a6efa7a40a44441f99f053da040711f3ac43a52185e759f';
const BEFORE_LANE_SHA = '75008efee13a12e3b875b95c3a1bfd90a46810e875cde63a9b31e3cc8e350043';
const REGISTERED_LANE_SHA = 'ca36f6e17f39672730802c0014fc69b940ff0210cd3a3025bb22c8c9cc6b406c';
const STREET_PARTS_SHA = '1ac1409cf70cd6c3ad1ab7139fd6f365898d5c654e499616a1892d1b669645b2';
const OSM_SHA = 'a6bf71bae890ab60b4249c8546e6b7185ce37c9ede4137e9c4aefbd9a755e65a';
type Coverage = Pick<GameplayBundle,'playArea'|'supportedArea'>;
const hash = (v: unknown) => sourceSha256(JSON.stringify(v));
const metadata = (lane: RoadLane) => {const {points: _points, length: _length, ...rest} = lane; return rest;};
const json = (bytes: Uint8Array, expected: string, cap: number) => {assert.ok(bytes.length > 0 && bytes.length <= cap); assert.equal(sourceSha256(bytes), expected, 'Reviewed new-lane input changed'); return JSON.parse(Buffer.from(bytes).toString()) as any;};

export interface ReviewedEhrenstromLaneAuthority {readonly kind: 'reviewed-ehrenstrom-new-lane'}
const authorities = new WeakMap<object,{lane: RoadLane; acceptedCoverage: Coverage; witness: object}>();
export interface EhrenstromLaneRegistrationInputs {
  reviewBytes: Uint8Array;
  registrationBytes: Uint8Array;
  projectionReceiptBytes: Uint8Array;
  authoringGraphBytes: Uint8Array;
  projectedGraphBytes: Uint8Array;
  accepted: RoadGraph;
  acceptedCoverage: Coverage;
  sourcePins: {streetPartsSha256: string; osmSha256: string};
  vehicleDefinitionsSha256: string;
}

/** One approved source-contained NEW lane placement. No authority over accepted records,
 * other roads, changed source files, bridge levels, or relaxed physical tolerances.
 * The exact four-window candidate is an authoring input, not final native admission. */
export function qualifyReviewedEhrenstromLaneRegistration(input: EhrenstromLaneRegistrationInputs) {
  const review = json(input.reviewBytes, EHRENSTROM_LANE_REGISTRATION_REVIEW_SHA256, 2_000_000);
  assert.equal(review.status, 'SOURCE_BOUND_HYBRID_SIGNED_ROAD_AUTHORING_ROOT_REVIEWED_PENDING_FINAL_SERIALIZATION_AND_RUNTIME');
  assert.equal(review.laneId, LANE_ID);
  const registration = json(input.registrationBytes, review.horizontalRegistration.proposal.sha256, 4_000_000);
  assert.equal(registration.status, 'LOCAL_SOURCE_REGISTRATION_ALL_THREE_ENVELOPES_AND_NATIVE_FLOOR_PASS');
  assert.equal(input.sourcePins.streetPartsSha256, STREET_PARTS_SHA, 'Current complete municipal source changed');
  assert.equal(input.sourcePins.osmSha256, OSM_SHA, 'Current complete OSM source changed');
  assert.equal(registration.inputs['../sources/raw-v2/street-parts/southwest-cumulative-20261029.geojson'], input.sourcePins.streetPartsSha256);
  assert.equal(input.vehicleDefinitionsSha256, registration.physicalProof.vehicleEnvelope.definitionsSha256, 'Vehicle definition set changed');
  assert.equal(registration.sourcePart.id, '41236'); assert.equal(registration.sourcePart.properties.paatyyppi, 'Ajorata'); assert.equal(registration.sourcePart.properties.alatyyppi, 'Ajorata');
  assert.equal(registration.sourcePart.sha256, '289b156d24a4471dbe269b43fe1e6edc12864f93afa0144a1357aa6f7785db53');
  const receipt = json(input.projectionReceiptBytes, PROJECTION_RECEIPT_SHA, 16_000_000);
  assert.equal(receipt.originalCandidateRoads.sha256, AUTHORING_GRAPH_SHA); assert.equal(receipt.projectedCandidateRoads.sha256, PROJECTED_GRAPH_SHA);
  json(input.authoringGraphBytes, AUTHORING_GRAPH_SHA, 64_000_000); json(input.projectedGraphBytes, PROJECTED_GRAPH_SHA, 64_000_000);
  const authoring = decodeRoadGraph(input.authoringGraphBytes), projected = decodeRoadGraph(input.projectedGraphBytes), sourceLane = authoring.lanes.find(l => l.id === LANE_ID), before = projected.lanes.find(l => l.id === LANE_ID), registered = registration.candidateLane as RoadLane;
  assert.ok(sourceLane && before); assert.ok(!input.accepted.lanes.some(l => l.id === LANE_ID), 'Approved new placement cannot replace an accepted lane');
  assert.equal(hash(before), BEFORE_LANE_SHA); assert.equal(hash(registered), REGISTERED_LANE_SHA); assert.equal(review.horizontalRegistration.candidateLaneSha256, REGISTERED_LANE_SHA);
  assert.deepEqual(input.acceptedCoverage.playArea, {minX:-1792,minZ:-2304,maxX:800,maxZ:768});
  assertOutsideOnlyPolylineRepair(sourceLane.points, before.points, input.acceptedCoverage);
  assert.deepEqual(metadata(sourceLane), metadata(before)); assert.deepEqual(metadata(registered), metadata(before));
  for (const index of [0, -1]) {const a: Vec3 = before.points.at(index)!, b: Vec3 = registered.points.at(index)!; assert.deepEqual([b[0],b[2]], [a[0],a[2]], 'Reviewed lane endpoint XZ changed');}
  assert.equal(registered.length, polylineLength(registered.points));
  assert.ok(registered.points.length >= 2 && registered.points.length <= 10000 && registered.points.every(p => p.length === 3 && p.every(Number.isFinite) && p[2] > 768));
  assert.equal(review.horizontalRegistration.windows.length, 4);
  assert.ok(review.horizontalRegistration.windows.every((w: any) => w.window.length === 2 && w.window[0] < w.window[1] && w.maximumLateralShiftMetres > 0 && w.maximumLateralShiftMetres <= .115));
  const witness = {kind:'source-bound-reviewed-new-lane-registration', laneId:LANE_ID, rootReviewSha256:EHRENSTROM_LANE_REGISTRATION_REVIEW_SHA256, registrationSha256:sourceSha256(input.registrationBytes), sourcePins:input.sourcePins, vehicleDefinitionsSha256:input.vehicleDefinitionsSha256,
    sourceAuthoringGraphSha256:AUTHORING_GRAPH_SHA, originalProjectedGraphSha256:PROJECTED_GRAPH_SHA, projectionAncestrySha256:PROJECTION_RECEIPT_SHA,
    sourceLaneSha256:hash(sourceLane), priorProjectedLaneSha256:BEFORE_LANE_SHA, registeredLaneSha256:REGISTERED_LANE_SHA, windows:review.horizontalRegistration.windows,
    acceptedRecordsUnaffected:true, endpointXZAndMetadataPreserved:true, pendingFinalSerializedHeightSourceBodyAndRuntimeGates:true};
  const authority: ReviewedEhrenstromLaneAuthority = Object.freeze({kind:'reviewed-ehrenstrom-new-lane'});
  authorities.set(authority,{lane:structuredClone(registered),acceptedCoverage:structuredClone(input.acceptedCoverage),witness});
  return {authority, registeredLane:structuredClone(registered), originalSourceLane:structuredClone(sourceLane), witness};
}

/** Vertical projection may subdivide the approved XZ trace but cannot add a trim or shift. */
export function assertReviewedEhrenstromLaneProjection(authority: ReviewedEhrenstromLaneAuthority, projected: RoadLane) {
  const data = authorities.get(authority); assert.ok(data, 'Unverified new-lane registration authority');
  assert.equal(projected.id, LANE_ID); assert.deepEqual(metadata(projected), metadata(data.lane));
  assert.equal(projected.length, data.lane.length, 'Projection changes approved lane length metadata');
  assertOutsideOnlyPolylineRepair(data.lane.points, projected.points, data.acceptedCoverage);
  return {...data.witness, finalLaneSha256:hash(projected), approvedPiecewiseXZPreserved:true};
}
