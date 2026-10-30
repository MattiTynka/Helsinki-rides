import assert from 'node:assert/strict';
import {sourceSha256, sourceFile} from './source-files.ts';
import {decodeDeliverySimulation} from './delivery-city-payloads.ts';
import type {MeasuredGroundFace} from './delivery-measured-ground.ts';

export const TELAKKAKATU_AUTHORING_REVIEW_SHA256 = 'cc88633b459238751c4962169a9ad5accd03ab7ebc0babd1618773d3f6cc96cd';
const PROPOSAL_SHA256 = 'f20e65dab002c716ce343f79cb43ba5a76465b7678bccbdc8a7df48c72f2ba2b';
export interface AuthoredGradePin {file: string; sha256: string}
declare const authorityBrand: unique symbol;
export interface ReviewedRoadGradeAuthority {readonly [authorityBrand]: true}
interface BoundAuthority {faces: MeasuredGroundFace[]; region: readonly number[]; acceptedBounds: readonly number[]; terrainSha256: string; reviewSha256: string; proposalSha256: string; candidateCells: Map<string,string>}
const authorities = new WeakMap<object, BoundAuthority>();
const digest = (s: string) => assert.match(s, /^[a-f0-9]{64}$/);

/** Numeric validation is explicit: object subtraction or a NaN must never turn
 * a failed comparison into apparent support. The counts belong to this case. */
export function assertFiniteTelakkakatuRapierEvidence(proof: any) {
  assert.equal(proof.status, 'PASS_ACTUAL_SERIALIZED_NATIVE_RAPIER_SUPPORT_NO_SAFETY_TERRAIN_CONTACT'); assert.deepEqual(proof.failures, []);
  assert.ok(Array.isArray(proof.probes)); assert.equal(proof.probes.length, 930);
  let maximumHeightError = 0;
  for (const p of proof.probes) {
    assert.ok(Number.isFinite(p.expectedY) && Number.isFinite(p.hit?.y) && Number.isFinite(p.hit?.normalY), 'Recovery-ray heights and normal must be finite numbers');
    assert.equal(p.hit.surface?.group, 'ground'); assert.ok(p.hit.normalY >= .98 && p.hit.normalY <= 1.000001);
    const difference = Math.abs(p.expectedY-p.hit.y); assert.ok(difference <= .002, 'Recovery ray differs from actual native support'); maximumHeightError=Math.max(maximumHeightError,difference);
  }
  assert.ok(Array.isArray(proof.dynamics)); assert.equal(proof.dynamics.length, 12);
  for (const d of proof.dynamics) {assert.equal(d.fallbackWheelContacts,0); assert.ok(Number.isFinite(d.groundContacts) && d.groundContacts > 0); assert.deepEqual(d.finalWheelContacts,[true,true,true,true]);}
  assert.deepEqual(proof.body.failures, []); assert.equal(proof.body.heightToleranceMetres,.2); assert.ok(Number.isFinite(proof.body.maxHeightDeviation) && proof.body.maxHeightDeviation < .2);
  return {probes:930,suspensionProbes:12,maximumHeightError};
}

/** A literal approved hybrid-game authoring case, deliberately separate from the
 * measured-survey contract. A claimed status or arbitrary review hash grants nothing.
 * Other signed profiles need their own independently reviewed literal authority. */
export function readReviewedRoadGradeAuthoring(reviewPin: AuthoredGradePin, read: (pin: AuthoredGradePin, cap?: number) => Buffer) {
  assert.equal(reviewPin.sha256, TELAKKAKATU_AUTHORING_REVIEW_SHA256, 'Unapproved road-grade authoring review');
  const checked = (pin: AuthoredGradePin, cap = 32 * 1024 * 1024) => {
    assert.deepEqual(Object.keys(pin).sort(), ['file','sha256']); digest(pin.sha256);
    const bytes = read(pin, cap); assert.ok(bytes.length > 0 && bytes.length <= cap); assert.equal(sourceSha256(bytes), pin.sha256, 'Approved road-grade input changed'); return bytes;
  };
  const json = (pin: AuthoredGradePin) => JSON.parse(checked(pin).toString());
  const review = json(reviewPin);
  assert.equal(review.status, 'SOURCE_BOUND_HYBRID_ROAD_AUTHORING_ROOT_REVIEWED_PENDING_FINAL_RUNTIME');
  assert.equal(review.kind, 'bounded-current-mesh-crossfall-road-authoring');
  assert.equal(review.proposal.sha256, PROPOSAL_SHA256); assert.deepEqual(review.sourcePartIds, ['59301']); assert.equal(review.laneId, '989868959:0:f0');
  const proposal = json(review.proposal), preflight = json(review.preflight), physical = json(review.physical), impact = json(review.impact), structure = json(review.structureSeparation), rapier = json(review.rapier);
  for (const doc of [preflight,physical,impact,structure,rapier]) assert.equal(doc.proposalSha256, PROPOSAL_SHA256);
  assert.equal(preflight.status, 'PASS_EXACT_NATIVE_TO_CURRENT_DELIVERY_REBASE'); assert.deepEqual(physical.proof.failures, []);
  assert.equal(physical.proof.heightToleranceMetres, .2); assert.ok(physical.proof.maxHeightDeviation < .2);
  assert.deepEqual(impact.gradeFailures, []); assert.deepEqual(impact.tree.overlap, []); assert.ok(impact.terrain.minimumSafetyFieldClearance > 0);
  assert.equal(structure.status, 'PASS_ALL_CHANGED_NATIVE_FACE_SWEEPS_DISJOINT_STRUCTURES'); assert.deepEqual(structure.failures, []);
  assertFiniteTelakkakatuRapierEvidence(rapier);
  assert.deepEqual(proposal.sourceWorld, review.sourceWorld); assert.equal(preflight.sourceManifestSha256, review.sourceWorld.manifestSha256);
  assert.equal(proposal.authoringKind, 'bounded-measured-crossfall-under-ordinary-road-occlusion'); assert.equal(proposal.boundaryPiecewiseGeometryPreserved, true);
  assert.deepEqual(proposal.sourceParts.map((p: any) => p.id), ['59301']); assert.ok(review.authoring.maximumLateralExtension <= 2 && review.authoring.maximumNativeBoundaryTransitionRetreat < .1);
  assert.equal(review.authoring.maximumLongitudinalExtrapolation, 0); assert.equal(proposal.sourceAgreementMetres, 0);
  assert.ok(Array.isArray(review.sourceInputs) && review.sourceInputs.length === 8); for (const pin of review.sourceInputs) checked(pin, 128 * 1024 * 1024);
  assert.equal(rapier.sourceWorld.manifestSha256, review.evidenceCorrection.actualSerializedWorldSha256);
  const actualWorld = json({file:sourceFile(rapier.sourceWorld.directory,'manifest.json'),sha256:rapier.sourceWorld.manifestSha256});
  const actualTerrain = decodeDeliverySimulation(checked({file:sourceFile(rapier.sourceWorld.directory,actualWorld.terrain.path),sha256:actualWorld.terrain.sha256},64*1024*1024),actualWorld.terrain);
  assert.equal(sourceSha256(actualTerrain),rapier.terrainDecodedSha256); assert.equal(rapier.terrainDecodedSha256,impact.terrain.decodedSha256);
  const candidateCells = new Map<string,string>();
  assert.ok(Array.isArray(rapier.cells) && rapier.cells.length > 0 && rapier.cells.length <= 16);
  for (const c of rapier.cells) {
    assert.ok(!candidateCells.has(c.id)); const current = actualWorld.cells.find((cell:any)=>cell.id===c.id); assert.ok(current);
    const decoded = decodeDeliverySimulation(checked({file:sourceFile(rapier.sourceWorld.directory,current.collision.path),sha256:current.collision.sha256},64*1024*1024),current.collision);
    assert.equal(sourceSha256(decoded),c.candidateDecodedSha256,'Actual Rapier cell bytes changed'); assert.equal(c.originalDecodedSha256,c.candidateDecodedSha256);
    candidateCells.set(c.id,c.candidateDecodedSha256);
  }
  for (const c of preflight.proofs) assert.ok(candidateCells.has(c.cell),'Approved affected cell absent from actual Rapier authority');
  const opaque = Object.freeze({}) as ReviewedRoadGradeAuthority;
  authorities.set(opaque, {faces: structuredClone(preflight.changes), region: [...proposal.patchRegion], acceptedBounds: [-1792,-2304,800,768], terrainSha256: impact.terrain.decodedSha256, reviewSha256: reviewPin.sha256, proposalSha256: PROPOSAL_SHA256,candidateCells});
  return {authority: opaque, review, proposal, preflight, physical, impact, structure, rapier};
}

export function assertReviewedRoadGradeSerializedCollision(authority: ReviewedRoadGradeAuthority, cell: string, decoded: Uint8Array) {
  const bound=authorities.get(authority); assert.ok(bound,'Road-grade authority must come from the approved source reader');
  assert.equal(sourceSha256(decoded),bound.candidateCells.get(cell),'Serialized authored cell differs from the exact actual Rapier-tested collision');
}

/** Recompute changes from the producer/cache before calling. Exact literal face
 * closure prevents an approved summary from authorizing different heights or scope. */
export function assertReviewedRoadGradeFaces(authority: ReviewedRoadGradeAuthority, faces: readonly MeasuredGroundFace[], region: readonly number[], acceptedBounds: readonly number[], currentTerrainDecodedSha256: string) {
  const bound = authorities.get(authority); assert.ok(bound, 'Road-grade authority must come from the approved source reader');
  assert.deepEqual(faces, bound.faces, 'Authored road-grade faces differ from the exact approved native delta');
  assert.deepEqual(region, bound.region); assert.deepEqual(acceptedBounds, bound.acceptedBounds); assert.equal(currentTerrainDecodedSha256, bound.terrainSha256, 'Safety terrain differs from qualified actual field');
  assert.ok(region[2]! < acceptedBounds[0]! || region[0]! > acceptedBounds[2]! || region[3]! < acceptedBounds[1]! || region[1]! > acceptedBounds[3]!, 'Authored grade intersects protected accepted city');
  assert.ok(faces.length > 0 && faces.length <= 5000);
  for (const face of faces) {
    assert.ok(face.before.length === 3 && face.after.length === 3);
    for (let i = 0; i < 3; i++) {const a = face.before[i]!, b = face.after[i]!;
      assert.ok(a.length === 3 && b.length === 3 && [...a,...b].every(v => Number.isFinite(v) && Math.fround(v) === v));
      assert.equal(a[0], b[0]); assert.equal(a[2], b[2]);
      // This literal approved case is upward. A later downward case cannot enter
      // through a signed-generic escape hatch; it needs its own terrain authority.
      assert.ok(b[1] >= a[1] && b[1] - a[1] <= 1.05);
      assert.ok(a[0] >= region[0]! && a[0] <= region[2]! && a[2] >= region[1]! && a[2] <= region[3]!);
    }
  }
  return {kind: 'bounded-current-mesh-crossfall-road-authoring', reviewSha256: bound.reviewSha256, proposalSha256: bound.proposalSha256, measuredSurveyPreservationClaim: false, acceptedInteriorPreserved: true, safetyTerrainDecodedSha256: bound.terrainSha256};
}
