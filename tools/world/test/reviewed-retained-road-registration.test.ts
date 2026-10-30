import test from 'node:test';
import assert from 'node:assert/strict';
import {polylineLength, type RoadLane} from '../../../packages/world-schema/src/index.ts';
import type {LocalPolygon} from '../lib/geometry.ts';
import type {RoadSupportTriangle} from '../lib/expansion-road-merge.ts';
import {sourceSha256 as sha} from '../lib/source-files.ts';
import {qualifyReviewedRetainedRoadRegistration, type RetainedRoadRegistrationInputs} from '../lib/reviewed-retained-road-registration.ts';
const hash = (value: unknown) => sha(JSON.stringify(value));
function fixture() {
  const acceptedLane: RoadLane = {id:'122961573:0:f0',wayId:122961573,from:'n1',to:'n2',index:0,count:1,width:3,length:10,points:[[-1790,2,0],[-1800,2,0]],name:'Itameri',highway:'tertiary',surface:'asphalt',speedLimit:8};
  const registeredLane: RoadLane = {...acceptedLane,points:[[-1790,2,0],[-1792,2,0],[-1796,2,-.05],[-1800,2,0]]};
  (registeredLane as {length:number}).length=polylineLength(registeredLane.points);
  const part: LocalPolygon = {id:'41721',properties:{paatyyppi:'Ajorata',alatyyppi:'Ajorata'},bbox:[-1810,-5,-1780,5],rings:[[[-1810,-5],[-1780,-5],[-1780,5],[-1810,5]]]};
  const streetPartsBytes=Buffer.from(JSON.stringify(part)),face:RoadSupportTriangle={id:'serialized:c_test:g:c_test:0',tag:'road:asphalt',points:[[-1805,2,-5],[-1805,2,5],[-1785,2,0]]};
  const acceptedManifestSha256='a'.repeat(64),vehicleDefinitionsSha256='b'.repeat(64),world={manifestSha256:'c'.repeat(64),cells:[{cell:'c_test',storedSha256:'d'.repeat(64),decodedSha256:'e'.repeat(64)}]};
  const proposal={schemaVersion:1,kind:'source-bound-outside-retained-lane-horizontal-registration-proposal',status:'SOURCE_AND_NATIVE_QUALIFIED_PENDING_PARENT_REVIEW_AND_STRICT_REPAIR_CONTRACT',acceptedManifestPin:{sha256:acceptedManifestSha256},partsPin:{sha256:sha(streetPartsBytes)},before:acceptedLane,acceptedRecordSha256:hash(acceptedLane),oldProtectedRectangle:[-1792,-2304,800,768],sourcePart:part,sourcePartSha256:hash(part),seam:{anchor:[-1792,2,0],originalSegmentIndex:0,originalSegmentFraction:.2},selected:{after:registeredLane,shift:.05,admission:{definitionsSha256:vehicleDefinitionsSha256,closedIntervals:[]},physical:{failureCount:0,maxHeightDeviation:.1}},selectedFaces:[face]};
  const approvedProposalBytes=Buffer.from(JSON.stringify(proposal)),approval=sha(approvedProposalBytes);
  const input:RetainedRoadRegistrationInputs={approvedProposalBytes,acceptedManifestSha256,streetPartsBytes,vehicleDefinitionsSha256,acceptedLane,registeredLane,parts:[part],floor:{...world,triangles:[face]},review:{schemaVersion:1,kind:'source-bound-outside-retained-lane-horizontal-registration',approvedProposalSha256:approval,acceptedManifestSha256,streetPartsSha256:sha(streetPartsBytes),vehicleDefinitionsSha256,world,record:{id:acceptedLane.id,acceptedRecordSha256:hash(acceptedLane),registeredRecordSha256:hash(registeredLane)}}};
  return {input,approval};
}
test('returns one source-bound baseline while preserving exact accepted inside and endpoint geometry',()=>{
  const {input,approval}=fixture(),result=qualifyReviewedRetainedRoadRegistration(input,approval);
  assert.equal(result.id,'122961573:0:f0');assert.deepEqual(result.registeredLane,input.registeredLane);
  assert.deepEqual(result.witness.exactSeamAnchor,[-1792,2,0]);assert.equal(result.witness.acceptedInsidePiecewiseGeometryPreserved,true);
  assert.equal(result.witness.pendingFinalSourceBodySupportAndTravel,true);assert.notEqual(result.registeredLane,input.registeredLane);
});
test('rejects a different lane, inside height or seam mutation even with refreshed review record hash',()=>{
  const a=fixture();a.input.review.record.id='other:0:f0';assert.throws(()=>qualifyReviewedRetainedRoadRegistration(a.input,a.approval),/Other retained lanes/);
  for(const index of [0,1]){const f=fixture();f.input.registeredLane={...f.input.registeredLane,points:f.input.registeredLane.points.map((p,i)=>i===index?[p[0],p[1]+.01,p[2]]:p)};f.input.review.record.registeredRecordSha256=hash(f.input.registeredLane);assert.throws(()=>qualifyReviewedRetainedRoadRegistration(f.input,f.approval),/literal reviewed geometry/);}
});
test('rejects stale raw source, current literal HCOL and changed approved proposal bytes',()=>{
  const a=fixture();a.input.streetPartsBytes=Buffer.from('changed');assert.throws(()=>qualifyReviewedRetainedRoadRegistration(a.input,a.approval),/raw municipal source/);
  const b=fixture();b.input.floor.triangles=[{...b.input.floor.triangles[0]!,points:[[-1805,2.01,-5],[-1805,2,5],[-1785,2,0]]}];assert.throws(()=>qualifyReviewedRetainedRoadRegistration(b.input,b.approval),/literal HCOL/);
  const c=fixture();c.input.approvedProposalBytes=Buffer.concat([c.input.approvedProposalBytes,Buffer.from('\n')]);assert.throws(()=>qualifyReviewedRetainedRoadRegistration(c.input,c.approval),/proposal bytes/);
});
