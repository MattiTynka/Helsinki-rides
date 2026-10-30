import assert from 'node:assert/strict';
import polygonClipping from 'polygon-clipping';
import type {GameplayBundle, RoadGraph, RoadLane} from '../../../packages/world-schema/src/index.ts';
import {polylineLength} from '../../../packages/world-schema/src/index.ts';
import {loadGeoJsonPolygons} from './geometry.ts';
import {deriveRoadPhysicalEnvelope, inspectRoadAdmission, inspectRoadPhysicalSupport, RoadCollisionSupport, type RoadSupportTriangle, type RoadCoverage} from './expansion-road-merge.ts';
import {qualifyReviewedRetainedRoadRegistration, type ReviewedRetainedRoadRegistration} from './reviewed-retained-road-registration.ts';
import {sourceSha256} from './source-files.ts';

export interface RetainedRoadPin {file: string; sha256: string}
export interface RetainedRoadReviewBinding {review: RetainedRoadPin; approvedProposal: RetainedRoadPin}
interface CellPin {cell: string; storedSha256: string; decodedSha256: string}
declare const retainedAuthorityBrand: unique symbol;
export interface RetainedRoadAuthority {readonly [retainedAuthorityBrand]: true}
const authorities = new WeakMap<object, {acceptedSha256: string; coverageSha256: string; lanes: Map<string, RoadLane>}>();
const hash = (value: unknown) => sourceSha256(JSON.stringify(value));
const coverageHash = (coverage: RoadCoverage) => hash({playArea:coverage.playArea,supportedArea:coverage.supportedArea});
const exactKeys = (value: object, keys: string[]) => assert.deepEqual(Object.keys(value).sort(), keys.sort(), 'Unexpected retained registration binding field');

/** The only authority constructor derives its baseline from the literal approved
 * proposal and rechecks current source, vehicle geometry and serialized floor.
 * A caller-provided map or a deserialized receipt is never an authority token. */
export function prepareRetainedRoadRegistrations(bindings: readonly RetainedRoadReviewBinding[], context: {
  accepted: RoadGraph; acceptedManifestSha256: string; acceptedCoverage: RoadCoverage;
  vehicleDefinitions: GameplayBundle['vehicleDefinitions']; streetParts: RetainedRoadPin;
  originProjected: readonly number[]; selectedLaneIds: readonly string[];
  floor: {manifestSha256: string; cells: readonly CellPin[]; triangles: readonly RoadSupportTriangle[]};
  read: (pin: RetainedRoadPin, cap?: number) => Uint8Array;
}) {
  assert.ok(Array.isArray(bindings) && bindings.length > 0 && bindings.length <= 1, 'Exactly one reviewed retained registration is currently supported');
  assert.deepEqual(context.acceptedCoverage.playArea, {minX:-1792,maxX:800,minZ:-2304,maxZ:768}, 'Retained registration uses a different accepted rectangle');
  assert.equal(context.acceptedCoverage.supportedArea, undefined, 'Retained registration cannot replace an accepted polygon policy');
  const sourceBytes = context.read(context.streetParts), parts = loadGeoJsonPolygons(context.streetParts.file, context.originProjected[0]!, context.originProjected[1]!, (properties, i) => String(properties.osan_id ?? properties.id ?? i));
  const envelope = deriveRoadPhysicalEnvelope(context.vehicleDefinitions), lanes = new Map<string, RoadLane>(), witnesses = [];
  for (const binding of bindings) {
    exactKeys(binding, ['review','approvedProposal']);
    for (const pin of [binding.review,binding.approvedProposal]) {exactKeys(pin, ['file','sha256']); assert.match(pin.sha256, /^[a-f0-9]{64}$/);}
    const review = JSON.parse(Buffer.from(context.read(binding.review, 2_000_000)).toString()) as ReviewedRetainedRoadRegistration;
    const approvedProposalBytes = context.read(binding.approvedProposal, 4_000_000), proposal = JSON.parse(Buffer.from(approvedProposalBytes).toString());
    const id = review.record.id, acceptedLane = context.accepted.lanes.find(lane => lane.id === id);
    assert.ok(acceptedLane && context.selectedLaneIds.includes(id), 'Retained registration must select its exact accepted lane');
    assert.ok(!lanes.has(id), 'Duplicate retained registration');
    const registeredLane = proposal.selected.after as RoadLane;
    const cells = review.world.cells.map(pin => {
      const actual = context.floor.cells.find(cell => cell.cell === pin.cell); assert.ok(actual, 'Reviewed retained floor cell is absent');
      return {cell:actual.cell,storedSha256:actual.storedSha256,decodedSha256:actual.decodedSha256};
    });
    const triangles = context.floor.triangles.filter(triangle=>cells.some(cell=>triangle.id.startsWith(`serialized:${cell.cell}:`)));
    const qualified = qualifyReviewedRetainedRoadRegistration({review,approvedProposalBytes,acceptedManifestSha256:context.acceptedManifestSha256,streetPartsBytes:sourceBytes,vehicleDefinitionsSha256:envelope.definitionsSha256,acceptedLane,registeredLane,parts,floor:{manifestSha256:context.floor.manifestSha256,cells,triangles}});
    const part = parts.find(part => part.id === qualified.witness.sourcePartId)!;
    const polygon = part.rings.map(ring => ring.map(([x,n]) => [x,-n] as [number,number]));
    const union = polygonClipping.union(polygon, [[[-1792,-2304],[800,-2304],[800,768],[-1792,768]]]);
    const coverage: RoadCoverage = {playArea:{minX:-2816,minZ:-2304,maxX:800,maxZ:1792},supportedArea:{schemaVersion:1,regions:union.map((p,i)=>({id:'retained-source-'+i,outer:p[0]!.slice(0,-1),holes:p.slice(1).map(r=>r.slice(0,-1))}))}};
    const anchor = qualified.witness.exactSeamAnchor, start = registeredLane.points[0]!;
    const ranges: [number,number][] = [[Math.hypot(anchor[0]-start[0],anchor[2]-start[2]),polylineLength(registeredLane.points)]];
    const admission = inspectRoadAdmission(registeredLane.points,ranges,coverage,envelope);
    assert.equal(admission.closedIntervals.length,0,'Reviewed retained baseline fails current full-vehicle source admission');
    const physical = inspectRoadPhysicalSupport(id,registeredLane.points,registeredLane.width,[part.id],[part],new RoadCollisionSupport(triangles),coverage,envelope,ranges,true);
    assert.equal(physical.failureCount,0,'Reviewed retained baseline fails current serialized full-vehicle support');
    lanes.set(id,structuredClone(qualified.registeredLane));
    witnesses.push({...qualified.witness,reviewSha256:binding.review.sha256,recomputed:{definitionsSha256:envelope.definitionsSha256,closedIntervals:admission.closedIntervals.length,failureCount:physical.failureCount,maxHeightDeviation:physical.maxHeightDeviation,collisionTriangles:physical.collisionTriangles}});
  }
  context.read(context.streetParts); // Detect a moving municipal file used by the geometry loader.
  const authority = Object.freeze({}) as RetainedRoadAuthority;
  authorities.set(authority,{acceptedSha256:hash(context.accepted),coverageSha256:coverageHash(context.acceptedCoverage),lanes});
  return {authority, receipt:{schemaVersion:1,kind:'recomputed-retained-road-registrations',bindings:structuredClone(bindings),streetParts:{...context.streetParts},acceptedManifestSha256:context.acceptedManifestSha256,vehicleDefinitionsSha256:envelope.definitionsSha256,worldManifestSha256:context.floor.manifestSha256,witnesses},verifyInputs:()=>{
    context.read(context.streetParts);
    for(const binding of bindings){context.read(binding.review,2_000_000);context.read(binding.approvedProposal,4_000_000);}
  }};
}

/** Returns a detached baseline only for an opaque authority created above, the
 * same original graph and the same accepted coverage. Original accounting stays
 * with the caller; this baseline is solely for the ordinary outside-Y check. */
export function registeredRetainedRoadBaseline(authority: RetainedRoadAuthority, accepted: RoadGraph, coverage: RoadCoverage): RoadGraph {
  const qualified = authorities.get(authority); assert.ok(qualified, 'Unrecognized retained-road authority');
  assert.equal(hash(accepted),qualified.acceptedSha256,'Retained-road authority belongs to another accepted graph');
  assert.equal(coverageHash(coverage),qualified.coverageSha256,'Retained-road authority belongs to another accepted coverage');
  return {...structuredClone(accepted),lanes:accepted.lanes.map(lane=>structuredClone(qualified.lanes.get(lane.id)??lane))};
}
