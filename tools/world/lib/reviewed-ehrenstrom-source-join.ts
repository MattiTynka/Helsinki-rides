import assert from 'node:assert/strict';
import type {RoadLane, Vec3} from '../../../packages/world-schema/src/index.ts';
import {pointInPolygon, type LocalPolygon} from './geometry.ts';
import {sourceSha256} from './source-files.ts';
import type {RoadSourceElement, RoadSupportTriangle} from './expansion-road-merge.ts';
import {assertReviewedEhrenstromLaneProjection, type ReviewedEhrenstromLaneAuthority} from './reviewed-ehrenstrom-lane-registration.ts';

const PROPOSAL_SHA = '5308a36ed1324bbacc58f028954e7487678d9c278d0311a0c59607ddca3b1ecc';
const QUALIFICATION_SHA = '30e967514c8d86d5d2189ec6587c8d603746f668597418ddec37b0e0261b5089';
const RECORD_ID = '825173902:0:b0';
const hash = (value: unknown) => sourceSha256(JSON.stringify(value));
export interface ReviewedEhrenstromSourceJoin {readonly kind:'reviewed-ehrenstrom-source-join'}
interface Data {recordSha256:string; pointsSha256:string; width:number; triangles:[number,number][][]; witness:object}
const authorities = new WeakMap<object,Data>();

/** Source membership only for the exact already-authored41240/41242 join.
 * No municipal feature is relabelled or enlarged. HCOL and .20m body gates still apply. */
export function qualifyReviewedEhrenstromSourceJoin(input:{
  proposalBytes:Uint8Array; qualificationBytes:Uint8Array;
  sourcePins:{streetPartsSha256:string;osmSha256:string};
  record:RoadLane; registrationAuthority:ReviewedEhrenstromLaneAuthority;
  sourceWay:RoadSourceElement; parts:readonly LocalPolygon[];
  floor:{manifestSha256:string;cells:readonly {cell:string;storedSha256:string;decodedSha256:string;decodedBytes:number}[];triangles:readonly RoadSupportTriangle[]};
}) {
  assert.ok(input.proposalBytes.length<4_000_000&&input.qualificationBytes.length<8_000_000);
  assert.equal(sourceSha256(input.proposalBytes),PROPOSAL_SHA,'Literal approved source-join proposal changed');
  assert.equal(sourceSha256(input.qualificationBytes),QUALIFICATION_SHA,'Literal continuous source/native qualification changed');
  const proposal=JSON.parse(Buffer.from(input.proposalBytes).toString()),qualification=JSON.parse(Buffer.from(input.qualificationBytes).toString());
  assert.equal(qualification.proposalSha256,PROPOSAL_SHA);assert.equal(qualification.status,'PASS_EXACT_PUBLIC_SOURCE_NATIVE_PARTITION_GROUND_AUTHORING_PENDING_SERIALIZATION');
  assert.equal(input.sourcePins.streetPartsSha256,qualification.streetPartsSha256,'Complete municipal source changed');assert.equal(input.sourcePins.osmSha256,qualification.osmSha256,'Complete OSM source changed');
  assert.equal(input.record.id,RECORD_ID,'No source-join permission for another road');assert.equal(input.record.wayId,825173902);
  const registration=assertReviewedEhrenstromLaneProjection(input.registrationAuthority,input.record);
  const patch=proposal.patches.find((p:any)=>p.lane===RECORD_ID),checked=qualification.qualifications.find((q:any)=>q.proof.lane===RECORD_ID);assert.ok(patch&&checked);
  assert.deepEqual(patch.sourcePartIds,['41240','41242']);assert.deepEqual(checked.proof.parts.map((p:any)=>p.id),patch.sourcePartIds);
  assert.equal(hash(input.sourceWay),checked.proof.sourceWaySha256,'Source way identity or restrictions changed');assert.equal(input.sourceWay.id,825173902);assert.equal(input.sourceWay.type,'way');
  for(const ref of checked.proof.parts){const part=input.parts.find(p=>p.id===ref.id);assert.ok(part);assert.equal(hash(part),ref.sha256,'Literal source flank changed');assert.equal(part.properties.paatyyppi,'Ajorata');assert.equal(part.properties.alatyyppi,'Ajorata');}
  assert.ok(checked.proof.minimumNormal>=.98&&checked.proof.maximumExtrapolation<=.005&&checked.proof.maximumHeightError<=.002);
  assert.equal(patch.triangles.length,138);const actual=new Map<string,RoadSupportTriangle[]>();for(const triangle of input.floor.triangles){const key=JSON.stringify(triangle.points),list=actual.get(key)??[];list.push(triangle);actual.set(key,list);}
  const native=patch.triangles.map((t:any)=>{const matches=(actual.get(JSON.stringify(t.points))??[]).filter(q=>q.id.startsWith(`serialized:${t.cell}:`)&&q.tag.startsWith('road:'));assert.ok(matches.length,'Authored join is absent from current literal HCOL');assert.ok(input.floor.cells.some(c=>c.cell===t.cell));return{cell:t.cell,pointsSha256:hash(t.points),triangles:matches.map(t=>({id:t.id,tag:t.tag,sha256:hash(t)}))};});
  const triangles=patch.triangles.map((t:any)=>t.points.map((p:Vec3)=>[p[0],p[2]] as[number,number])) as [number,number][][];
  const witness={kind:'source-only-membership-of-existing-qualified-native-partition',recordId:RECORD_ID,recordSha256:hash(input.record),sourcePartIds:patch.sourcePartIds,sourcePins:input.sourcePins,sourceWaySha256:hash(input.sourceWay),proposalSha256:PROPOSAL_SHA,qualificationSha256:QUALIFICATION_SHA,registration,
    finalFloor:{manifestSha256:input.floor.manifestSha256,cells:input.floor.cells.filter(c=>native.some((n:any)=>n.cell===c.cell))},native,geometrySha256:hash(triangles),sourceMembershipOnly:true,ordinaryHeightAndCollisionGatesUnchanged:true,
    supersedesResidualDescription:{incorrectPair:['41245','41244'],correctPair:['41240','41242'],incorrectPairLane:'825173903:0:f0',incorrectPairApproximateBounds:[384.3947,1601.4856,385.9376,1604.3855]}};
  const authority:ReviewedEhrenstromSourceJoin=Object.freeze({kind:'reviewed-ehrenstrom-source-join'});authorities.set(authority,{recordSha256:hash(input.record),pointsSha256:hash(input.record.points),width:input.record.width,triangles,witness});return{authority,witness};
}

export function reviewedEhrenstromSourceJoinContains(authority:ReviewedEhrenstromSourceJoin,recordId:string,x:number,z:number){const data=authorities.get(authority);assert.ok(data,'Unverified source-join authority');assert.equal(recordId,RECORD_ID,'Source-join authority used on another record');return data.triangles.some(ring=>pointInPolygon([x,z],[ring]));}
export function assertReviewedEhrenstromSourceJoinRecord(authority:ReviewedEhrenstromSourceJoin,id:string,points:readonly Vec3[],width:number){const data=authorities.get(authority);assert.ok(data,'Unverified source-join authority');assert.equal(id,RECORD_ID);assert.equal(hash(points),data.pointsSha256,'Reviewed source-join road geometry changed');assert.equal(width,data.width);return data.witness;}
