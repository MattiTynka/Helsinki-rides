import assert from 'node:assert/strict';
import type {RoadGraph, Vec3} from '../../../packages/world-schema/src/index.ts';
import {pointAlong, supportsSegment} from '../../../packages/world-schema/src/index.ts';
import {pointInPolygon, type LocalPolygon} from './geometry.ts';
import {RoadCollisionSupport, isPublicWalkingGroundTag, inspectRetainedPathExposure, type RoadSourceElement, type RoadCoverage} from './expansion-road-merge.ts';
import {readSerializedRoadFloor, type SerializedFloorWorld} from './serialized-road-floor.ts';
import {assertOutsideOnlyRoadGraphRepair} from './road-outside-repair.ts';
import {sourceSha256} from './source-files.ts';

export const RETAINED_WALKING_CROSSING_PROPOSAL_SHA256 = '73f7919d7b3e25cc1c095483796e0f681f84359fa51edea1d64285058778e613';
export const RETAINED_WALKING_CROSSING_PROJECTED_EXPOSURE_SHA256 = '469834031256ef93c28e1fcd893eece0ed8c8dcf2a2a3f5a5d4605b0d68da905';
const ID = 'w1533067599';
interface Pin {file: string; sha256: string}
type Footway = RoadGraph['footways'][number];
const hash = (value: unknown) => sourceSha256(JSON.stringify(value));
declare const crossingBrand: unique symbol;
export interface ReviewedRetainedWalkingCrossing {readonly [crossingBrand]: true}
const authorities = new WeakMap<object, {record: Footway; waySha256: string; intervals: [number, number][]; receipt: object}>();

/** A proposed literal game-source classification for one inherited crossing.
 * Its caller must still hold the root's exact approval before wiring/applying.
 * This returns no generic cycleway, level, floor or accepted-geometry waiver. */
export function readReviewedRetainedWalkingCrossing(proposalPin: Pin, input: {
  accepted: RoadGraph; current: RoadGraph; acceptedCoverage: RoadCoverage;
  world: SerializedFloorWorld; coverage: RoadCoverage;
  sourcePins: {osmSha256: string; streetPartsSha256: string};
  osm: {elements: RoadSourceElement[]}; parts: readonly LocalPolygon[];
  projectedExposureReview?: Pin;
  read: (pin: Pin, cap?: number) => Uint8Array;
}) {
  assert.equal(proposalPin.sha256, RETAINED_WALKING_CROSSING_PROPOSAL_SHA256, 'Unreviewed retained walking crossing');
  const pins: {pin: Pin; cap: number}[] = [];
  const read = (pin: Pin, cap = 64 * 1024 * 1024) => {assert.deepEqual(Object.keys(pin).sort(), ['file', 'sha256']); const bytes = input.read(pin, cap); assert.ok(bytes.length > 0 && bytes.length <= cap); assert.equal(sourceSha256(bytes), pin.sha256); pins.push({pin: structuredClone(pin), cap}); return bytes;};
  const proposal = JSON.parse(Buffer.from(read(proposalPin, 4 * 1024 * 1024)).toString());
  assert.equal(proposal.id, ID); assert.equal(proposal.requestedScope.recordId, ID); assert.equal(proposal.requestedScope.sourcePartId, '492089');
  assert.deepEqual(input.accepted.footways.find(r => r.id === ID), proposal.accepted.record, 'Original crossing changed');
  assert.deepEqual(input.current.footways.find(r => r.id === ID), proposal.accepted.record, 'Current crossing changed');
  assert.deepEqual(input.acceptedCoverage.playArea, {minX: -1792, maxX: 800, minZ: -2304, maxZ: 768});
  assert.ok(!input.acceptedCoverage.supportedArea);
  const record = proposal.projected.record as Footway;
  assert.equal(hash(record), proposal.projected.sha256);
  const historicalMask = JSON.parse(Buffer.from(read(proposal.mask, 2_000_000)).toString());
  const maskCoverage = (mask: typeof historicalMask): RoadCoverage => ({playArea: mask.qualification.expanded, supportedArea: mask.supportedArea});
  let intervals = proposal.exactExposedIntervals as [number, number][];
  let projectedExposureReceipt: {reviewSha256: string; historicalMaskSha256: string; finalMaskSha256: string; originalIntervals: [number, number][]; projectedIntervals: [number, number][]; identicalBoundaryPoint: Vec3; noToleranceOrAdditionalGeometry: true} | undefined;
  if (input.projectedExposureReview) {
    assert.equal(input.projectedExposureReview.sha256, RETAINED_WALKING_CROSSING_PROJECTED_EXPOSURE_SHA256, 'Unreviewed projected crossing exposure');
    const review = JSON.parse(Buffer.from(read(input.projectedExposureReview, 65536)).toString());
    assert.equal(review.kind, 'literal-retained-crossing-projected-station-review'); assert.equal(review.recordId, ID);
    assert.equal(review.proposal.sha256, proposalPin.sha256); assert.deepEqual(review.historicalMask, proposal.mask);
    assert.equal(review.originalRecordSha256, proposal.accepted.sha256); assert.equal(review.projectedRecordSha256, proposal.projected.sha256);
    read(review.historicalApproval, 65536);
    assert.equal(review.finalMask.sha256, '1200b9fe57f38c4a51fd0c536455817ffe0640b102727fd40b551cebb3ea4c80');
    const finalMask = JSON.parse(Buffer.from(read(review.finalMask, 2_000_000)).toString());
    const qualification = JSON.parse(Buffer.from(read(review.finalMaskQualificationProof, 65536)).toString());
    assert.equal(qualification.qualified.sha256, review.finalMask.sha256);
    assert.equal(finalMask.qualification.status, 'PASS_SOURCE_QUALIFIED_SUPPORTED_AREA');
    assert.deepEqual(input.coverage, maskCoverage(finalMask), 'Projected crossing requires the exact reviewed final mask');
    assert.deepEqual(review.originalExposedIntervals, proposal.exactExposedIntervals);
    assert.deepEqual(review.projectedExposedIntervals, [[0, 3.5184507496267696]]);
    const exposures = [];
    for (const [name, mask] of [['historical', historicalMask], ['final', finalMask]] as const) for (const [role, actual] of [['original', proposal.accepted.record as Footway], ['projected', record]] as const) {
      const result = inspectRetainedPathExposure([actual], input.acceptedCoverage, maskCoverage(mask));
      assert.deepEqual(result[0]?.intervals, role === 'original' ? review.originalExposedIntervals : review.projectedExposedIntervals);
      exposures.push({mask: name, role, result});
    }
    assert.deepEqual(exposures, review.exposures, 'Literal crossing station arithmetic changed');
    // Subdivision changes station summation, not the approved physical endpoint.
    // This branch admits one literal result, never an epsilon around either one.
    const originalEnd = pointAlong(proposal.accepted.record.points, review.originalExposedIntervals[0][1]).point;
    const projectedEnd = pointAlong(record.points, review.projectedExposedIntervals[0][1]).point;
    assert.deepEqual(originalEnd, projectedEnd, 'Projected crossing changes the physical boundary');
    assert.deepEqual(projectedEnd, record.points[15]); assert.equal(projectedEnd[0], -1792);
    assert.deepEqual(review.boundary, {originalPoint: originalEnd, projectedPoint: projectedEnd, projectedVertexIndex: 15, literalProjectedVertex: record.points[15], identicalXZ: true});
    intervals = review.projectedExposedIntervals;
    projectedExposureReceipt = {reviewSha256: input.projectedExposureReview.sha256, historicalMaskSha256: review.historicalMask.sha256, finalMaskSha256: review.finalMask.sha256, originalIntervals: review.originalExposedIntervals, projectedIntervals: intervals, identicalBoundaryPoint: projectedEnd, noToleranceOrAdditionalGeometry: true};
  } else {
    assert.deepEqual(input.coverage, maskCoverage(historicalMask), 'Historical crossing requires its exact reviewed mask; final projected exposure needs its separate review');
  }
  const coverageSnapshot = structuredClone(input.coverage);
  const repaired = {...input.accepted, footways: input.accepted.footways.map(r => r.id === ID ? record : r)};
  assertOutsideOnlyRoadGraphRepair(input.accepted, repaired, input.acceptedCoverage);
  read(proposal.sourcePins.osm); read(proposal.sourcePins.streetParts);
  assert.deepEqual(input.sourcePins, {osmSha256: proposal.sourcePins.osm.sha256, streetPartsSha256: proposal.sourcePins.streetParts.sha256});
  const way = input.osm.elements.find(w => w.type === 'way' && w.id === 1533067599); assert.ok(way);
  assert.equal(hash(way), proposal.waySha256); assert.deepEqual(way.nodes, [25238865, 1062485403]);
  assert.deepEqual(way.tags, {bicycle: 'yes', highway: 'cycleway', lit: 'yes', surface: 'asphalt'});
  for (const ref of proposal.adjacentWays) {const actual = input.osm.elements.find(w => w.type === 'way' && w.id === ref.way.id); assert.equal(hash(actual), ref.sha256);}
  const part = input.parts.find(p => p.id === '492089'); assert.ok(part); assert.equal(hash(part), proposal.municipalPartSha256);
  assert.equal(part.properties.paatyyppi, 'Ajorata'); assert.equal(part.properties.alatyyppi, 'Ajorata'); assert.equal(part.properties.alueen_nimi, 'Santakatu');
  const floor = readSerializedRoadFloor(input.world, [-1800, 738, -1780, 752], input.accepted.originId);
  const closure = (cells: typeof floor.receipt.cells) => cells.map(c => ({cell: c.cell, decodedSha256: c.decodedSha256, decodedBytes: c.decodedBytes}));
  assert.deepEqual(closure(floor.receipt.cells), closure(proposal.floorClosure.cells), 'Complete crossing collision closure changed');
  const faces = new Map(floor.triangles.map(t => [t.id, t]));
  assert.equal(proposal.literalFloors.length, 3); for (const face of proposal.literalFloors) assert.deepEqual(faces.get(face.id), face, 'Crossing literal native face changed');
  assert.deepEqual(proposal.exactExposedIntervals, [[0, 3.5184507496267843]]);
  const support = new RoadCollisionSupport(floor.triangles, isPublicWalkingGroundTag);
  const capsuleWitnesses = (ranges: readonly (readonly [number, number])[]) => {
    const witnesses = [];
    for (const [from, to] of ranges) for (let i = 0, n = Math.max(1, Math.ceil((to - from) / .125)); i <= n; i++) {
      const station = from + (to - from) * i / n, point = pointAlong(record.points, station).point;
      if (i) {const previous = pointAlong(record.points, from + (to - from) * (i - 1) / n).point; assert.ok(supportsSegment(input.coverage, [Math.fround(previous[0]), Math.fround(previous[2])], [Math.fround(point[0]), Math.fround(point[2])], .38));}
      for (let j = -1; j < 32; j++) {
        const x = point[0] + (j < 0 ? 0 : Math.cos(j * Math.PI / 16) * .38), z = point[2] + (j < 0 ? 0 : Math.sin(j * Math.PI / 16) * .38), hit = support.at(x, point[1], z);
        assert.ok(hit && pointInPolygon([x, -z], part.rings), 'Crossing capsule leaves exact public carriageway or native support');
        witnesses.push({station, point: [x, point[1], z] as Vec3, hit});
      }
    }
    return witnesses;
  };
  const witnesses = capsuleWitnesses(proposal.exactExposedIntervals);
  assert.deepEqual(witnesses, proposal.physical.witnesses);
  const projectedWitnesses = projectedExposureReceipt ? capsuleWitnesses(intervals) : undefined;
  const receipt = {kind: 'literal-retained-public-carriageway-crossing-source', proposalSha256: proposalPin.sha256, recordId: ID, acceptedRecordSha256: proposal.accepted.sha256, projectedRecordSha256: proposal.projected.sha256, sourcePins: input.sourcePins, sourceWaySha256: proposal.waySha256, sourcePartId: part.id, sourcePartSha256: proposal.municipalPartSha256, intervals, ...(projectedExposureReceipt ? {projectedExposure: {...projectedExposureReceipt, nativeCapsuleWitnesses: projectedWitnesses!.length, nativeCapsuleWitnessesSha256: hash(projectedWitnesses)}} : {}), currentWorldManifestSha256: input.world.manifestSha256, localDecodedCollisionClosure: closure(floor.receipt.cells), classification: 'reviewed-game-source-only-not-a-legal-access-determination', noOtherRecordOrIntervalPermission: true};
  const authority = Object.freeze({}) as ReviewedRetainedWalkingCrossing;
  authorities.set(authority, {record: structuredClone(record), waySha256: proposal.waySha256, intervals: structuredClone(intervals), receipt: structuredClone(receipt)});
  return {authority, record: structuredClone(record), receipt, verifyInputs: () => {for (const {pin, cap} of pins) {const bytes = input.read(pin, cap); assert.ok(bytes.length > 0 && bytes.length <= cap); assert.equal(sourceSha256(bytes), pin.sha256);} assert.deepEqual(input.coverage, coverageSnapshot, 'Reviewed crossing mask changed after construction'); assert.deepEqual(readSerializedRoadFloor(input.world, [-1800, 738, -1780, 752], input.accepted.originId).receipt, floor.receipt);}};
}

/** Only an exact newly exposed interval may consume this source classification.
 * Whole-record route admission or another source way remains ineligible. */
export function assertReviewedRetainedWalkingCrossing(authority: ReviewedRetainedWalkingCrossing, record: Footway, way: RoadSourceElement, intervals: readonly (readonly [number, number])[]) {
  const bound = authorities.get(authority); assert.ok(bound, 'Unverified retained crossing authority');
  assert.deepEqual(record, bound.record, 'Retained crossing projected geometry changed'); assert.equal(hash(way), bound.waySha256); assert.deepEqual(intervals, bound.intervals, 'Crossing source authority cannot extend beyond its exact new exposure');
  return structuredClone(bound.receipt);
}
