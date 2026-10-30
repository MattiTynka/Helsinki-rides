import test from 'node:test';
import assert from 'node:assert/strict';
import pc from 'polygon-clipping';
import type {RoadConnector,RoadLane} from '../../../packages/world-schema/src/index.ts';
import {pointInPolygon, type LocalPolygon} from '../lib/geometry.ts';
import type {RoadSourceElement, RoadSupportTriangle} from '../lib/expansion-road-merge.ts';
import {sourceSha256 as sha} from '../lib/source-files.ts';
import {qualifyReviewedTransitCrossing, qualifyReviewedTransitTurn, qualifyReviewedTransitContinuation, transitHorizontalSha256, type TransitCrossingInputs, type TransitTurnInputs, type TransitContinuationInputs} from '../lib/reviewed-transit-crossing.ts';

const hash = (v: unknown) => sha(JSON.stringify(v));
function fixture() {
  const part: LocalPolygon = {id:'41731',properties:{paatyyppi:'Ajorata',alatyyppi:'Ajorata, muu',rakenteellinen_kunnossapito:'Kaupunkiliikenne Oy(HKL)'},rings:[[[0,0],[10,0],[10,-10],[0,-10]]],bbox:[0,-10,10,0]};
  const way: RoadSourceElement = {type:'way',id:176821966,nodes:[1519889202,318467444,318467446,1519889237],tags:{highway:'residential',name:'Selkamerenkatu'}};
  const ways = new Map<number,RoadSourceElement>([[way.id,way],[928817678,{type:'way',id:928817678,nodes:[1,1519889237],tags:{highway:'tertiary'}}],[8013666,{type:'way',id:8013666,nodes:[1519889202,2],tags:{highway:'residential'}}]]);
  const lanes: RoadLane[] = ['b','f'].map(direction => ({id:`176821966:0:${direction}0`,wayId:way.id,name:'Selkamerenkatu',highway:'residential',surface:'asphalt',speedLimit:8.333,width:3,from:direction==='b'?'n1519889237':'n1519889202',to:direction==='b'?'n1519889202':'n1519889237',index:0,count:1,length:8.8,points:direction==='b'?[[1,0,.6],[1,0,9.4]]:[[1,0,9.4],[1,0,.6]]}));
  const face: RoadSupportTriangle = {id:'serialized:c_test:g:c_test:0',tag:'road:asphalt',points:[[0,0,0],[2,0,0],[0,0,10]]};
  const sourcePins = {osmSha256:'a'.repeat(64),streetPartsSha256:'b'.repeat(64),candidateRoadsSha256:hash(lanes)};
  const corridor: [number,number][] = [[0,0],[2,0],[2,10],[0,10]];
  const proposal = {osmPin:{sha256:sourcePins.osmSha256},source:{sha256:sourcePins.streetPartsSha256},crossedPart:{sha256:hash(part)},sourceWays:[...ways.values()].map(w=>({id:w.id,sha256:hash(w)})),restrictionWitnesses:[],entry:{node:'n1519889237',from:'928817678:0:f1',to:'176821966:0:b0'},corridor,crossing:pc.intersection([corridor],part.rings.map(r=>r.map(([x,n])=>[x,-n] as [number,number]))),selectedFaces:[face],audits:lanes.map(l=>({id:l.id,newEndpointTrimMetres:.6,original:l,projected:l.points,projectFailures:[],admission:{closedIntervals:[]},bodyFloor:{failures:[]}}))};
  const approvedProposalBytes = Buffer.from(JSON.stringify(proposal)), approval = sha(approvedProposalBytes);
  const world = {manifestSha256:'c'.repeat(64),cells:[{cell:'c_test',storedSha256:'d'.repeat(64),decodedSha256:'e'.repeat(64)}]};
  const input: TransitCrossingInputs = {approvedProposalBytes,sourcePins,floor:{...world,triangles:[face]},parts:[part],ways,records:lanes,review:{schemaVersion:1,kind:'source-bound-public-transit-crossing',approvedProposalSha256:approval,sourcePins,world,records:lanes.map(l=>({id:l.id,sourceRecordSha256:hash(l),horizontalSha256:transitHorizontalSha256(l.points),sourceWaySha256:hash(way)}))}};
  return {input,approval};
}
test('returns only the literal clipped crossing for named records without relabelling municipal subtype', () => {
  const {input,approval}=fixture(), result=qualifyReviewedTransitCrossing(input,approval);
  assert.deepEqual([...result.keys()].sort(),['176821966:0:b0','176821966:0:f0']);
  const p=result.get('176821966:0:b0')!.parts[0]!;
  assert.equal(p.properties.alatyyppi,'Ajorata, muu'); assert.ok(pointInPolygon([1,-5],p.rings));
  assert.ok(!pointInPolygon([8,-5],p.rings),'The rest of the transit strip must remain ineligible');
  assert.deepEqual(input.parts[0]!.bbox,[0,-10,10,0]);
});
test('rejects longitudinal/different records and off-polygon horizontal substitution', () => {
  const a=fixture(); a.input.review.records[0]!.id='928817678:0:f0';
  assert.throws(()=>qualifyReviewedTransitCrossing(a.input,a.approval),/Only the two reviewed/);
  const b=fixture(), record: RoadLane={...b.input.records[0]!,points:[[8,0,.6],[8,0,9.4]]};
  b.input.records=[record,b.input.records[1]!]; b.input.review.records[0]!.sourceRecordSha256=hash(record); b.input.review.records[0]!.horizontalSha256=transitHorizontalSha256(record.points);
  assert.throws(()=>qualifyReviewedTransitCrossing(b.input,b.approval),/horizontal geometry differs/);
});
test('rejects stale current HCOL, changed source polygon and extra schema fields', () => {
  const a=fixture(); a.input.floor.triangles=[{...a.input.floor.triangles[0]!,points:[[0,.01,0],[2,0,0],[0,0,10]]}];
  assert.throws(()=>qualifyReviewedTransitCrossing(a.input,a.approval),/floor changed/);
  const b=fixture(); b.input.parts=[{...b.input.parts[0]!,bbox:[0,-10,11,0]}];
  assert.throws(()=>qualifyReviewedTransitCrossing(b.input,b.approval),/polygon changed/);
  const c=fixture(); Object.assign(c.input.review,{allowLongitudinal:true});
  assert.throws(()=>qualifyReviewedTransitCrossing(c.input,c.approval),/Unexpected transit review field/);
});

function turnFixture() {
  const base=fixture(),baseProposal=JSON.parse(Buffer.from(base.input.approvedProposalBytes).toString()),crossingLane=base.input.records[0]!;
  const approach: RoadLane={...crossingLane,id:'928817678:0:f1',wayId:928817678,from:'n1',to:'n1519889237',points:[[-1,0,.2],[1,0,.2]],length:2};
  const record: RoadConnector={id:'928817678:0:f1>176821966:0:b0',from:approach.id,to:crossingLane.id,node:'n1519889237',turn:'left',points:[[1,0,.2],[1,0,.6]],length:.4};
  const corridor: [number,number][]=[[0,0],[2,0],[2,3],[0,3]],proposal={originalProposalPin:{sha256:base.approval},source:{sha256:base.input.sourcePins.streetPartsSha256},sourcePart:{sha256:hash(base.input.parts[0])},sourceWayWitnesses:baseProposal.sourceWays,restrictionWitnesses:[],parameters:{approachTrimMetres:3,ordinaryLaneAuthoringReserveMetres:.275,crossingLaneUnchanged:true},fromAdmission:{closedIntervals:[]},turnAdmission:{closedIntervals:[]},fromPhysical:{failureCount:0},turnPhysical:{failureCount:0},after:{lane:approach,connector:record},corridor,crossing:pc.intersection([corridor],base.input.parts[0]!.rings.map(r=>r.map(([x,n])=>[x,-n] as [number,number]))),literalFaces:base.input.floor.triangles};
  const approvedProposalBytes=Buffer.from(JSON.stringify(proposal)),approval=sha(approvedProposalBytes),ref=(r:RoadLane|RoadConnector)=>({id:r.id,sourceRecordSha256:hash(r),horizontalSha256:transitHorizontalSha256(r.points)});
  const input:TransitTurnInputs={approvedProposalBytes,baseCrossingProposalBytes:base.input.approvedProposalBytes,sourcePins:base.input.sourcePins,floor:base.input.floor,parts:base.input.parts,ways:base.input.ways,record,approach,crossingLane,review:{schemaVersion:1,kind:'source-bound-public-transit-turn',approvedProposalSha256:approval,baseCrossingProposalSha256:base.approval,sourcePins:base.input.sourcePins,world:base.input.review.world,record:ref(record),approach:ref(approach),crossingLane:ref(crossingLane)}};
  return{input,approval,baseApproval:base.approval};
}
test('separately approved entry turn gets only its own clipped source intersection',()=>{
  const f=turnFixture(),result=qualifyReviewedTransitTurn(f.input,f.approval,f.baseApproval);
  assert.deepEqual([...result.keys()],[f.input.record.id]);const part=result.get(f.input.record.id)!.parts[0]!;
  assert.equal(part.properties.alatyyppi,'Ajorata, muu');assert.ok(pointInPolygon([1,-2],part.rings));assert.ok(!pointInPolygon([8,-2],part.rings));
});
test('turn approval rejects another connector, off-polygon geometry and stale source/floor',()=>{
  const a=turnFixture();a.input.record={...a.input.record,id:'928817678:0:f0>176821966:0:b0'};assert.throws(()=>qualifyReviewedTransitTurn(a.input,a.approval,a.baseApproval),/Other connectors/);
  const b=turnFixture();b.input.record={...b.input.record,points:[[8,0,.2],[8,0,.6]]};b.input.review.record.sourceRecordSha256=hash(b.input.record);b.input.review.record.horizontalSha256=transitHorizontalSha256(b.input.record.points);assert.throws(()=>qualifyReviewedTransitTurn(b.input,b.approval,b.baseApproval),/horizontal geometry changed/);
  const c=turnFixture();c.input.floor.triangles=[{...c.input.floor.triangles[0]!,points:[[0,.01,0],[2,0,0],[0,0,10]]}];assert.throws(()=>qualifyReviewedTransitTurn(c.input,c.approval,c.baseApproval),/literal HCOL changed/);
  const d=turnFixture();d.input.parts=[{...d.input.parts[0]!,bbox:[0,-10,11,0]}];assert.throws(()=>qualifyReviewedTransitTurn(d.input,d.approval,d.baseApproval));
});

function continuationFixture(){
  const base=fixture(),baseProposal=JSON.parse(Buffer.from(base.input.approvedProposalBytes).toString()),crossingLane=base.input.records[0]!;
  const original:RoadLane={...crossingLane,id:'8013666:0:b0',wayId:8013666,from:'n1519889202',to:'n2',points:[[1,0,9.4],[1,0,13.4]],length:4};
  const ordinaryLane:RoadLane={...original,points:[[1,0,10.4],[1,0,13.4]],length:3};
  const record:RoadConnector={id:'176821966:0:b0>8013666:0:b0',from:crossingLane.id,to:ordinaryLane.id,node:'n1519889202',turn:'straight',points:[[1,0,9.4],[1,0,10.4]],length:1};
  const proposal={kind:'public-crossing-south-continuation-proposal',basePin:{sha256:base.approval},osmPin:{sha256:base.input.sourcePins.osmSha256},sourcePin:{sha256:base.input.sourcePins.streetPartsSha256},sourcePart:{sha256:hash(base.input.parts[0])},sourceWays:[176821966,8013666].map(id=>({id,sha256:hash(base.input.ways.get(id))})),restrictions:[],additionalTransitArea:[],crossing:baseProposal.crossing,original:{from:crossingLane,to:original},selected:{trim:1,after:{connector:record,to:ordinaryLane},admission:{closedIntervals:[]},toAdmission:{closedIntervals:[]},physical:{failureCount:0},toPhysical:{failureCount:0}},selectedFaces:base.input.floor.triangles};
  const approvedProposalBytes=Buffer.from(JSON.stringify(proposal)),approval=sha(approvedProposalBytes),ref=(r:RoadLane|RoadConnector)=>({id:r.id,sourceRecordSha256:hash(r),horizontalSha256:transitHorizontalSha256(r.points)});
  const input:TransitContinuationInputs={approvedProposalBytes,baseCrossingProposalBytes:base.input.approvedProposalBytes,sourcePins:base.input.sourcePins,floor:base.input.floor,parts:base.input.parts,ways:base.input.ways,record,crossingLane,ordinaryLane,review:{schemaVersion:1,kind:'source-bound-public-transit-continuation',approvedProposalSha256:approval,baseCrossingProposalSha256:base.approval,sourcePins:base.input.sourcePins,world:base.input.review.world,record:ref(record),crossingLane:ref(crossingLane),ordinaryLane:ref(ordinaryLane)}};
  return{input,approval,baseApproval:base.approval};
}
test('south continuation grants the original clipped polygon only to its exact connector',()=>{
  const f=continuationFixture(),result=qualifyReviewedTransitContinuation(f.input,f.approval,f.baseApproval);
  assert.deepEqual([...result.keys()],[f.input.record.id]);assert.ok(!result.has(f.input.ordinaryLane.id));
  assert.equal(result.get(f.input.record.id)!.parts[0]!.properties.alatyyppi,'Ajorata, muu');
  assert.ok(!pointInPolygon([8,-5],result.get(f.input.record.id)!.parts[0]!.rings));
});
test('south continuation rejects another connector, changed XZ, source and current native floor',()=>{
  const a=continuationFixture();a.input.record={...a.input.record,id:'other>8013666:0:b0'};assert.throws(()=>qualifyReviewedTransitContinuation(a.input,a.approval,a.baseApproval),/Other connectors/);
  const b=continuationFixture();b.input.record={...b.input.record,points:[[8,0,9.4],[8,0,10.4]]};b.input.review.record.sourceRecordSha256=hash(b.input.record);b.input.review.record.horizontalSha256=transitHorizontalSha256(b.input.record.points);assert.throws(()=>qualifyReviewedTransitContinuation(b.input,b.approval,b.baseApproval),/horizontal geometry/);
  const c=continuationFixture();c.input.floor.triangles=[{...c.input.floor.triangles[0]!,points:[[0,.01,0],[2,0,0],[0,0,10]]}];assert.throws(()=>qualifyReviewedTransitContinuation(c.input,c.approval,c.baseApproval),/literal HCOL/);
  const d=continuationFixture();d.input.ways=new Map(d.input.ways);(d.input.ways as Map<number,RoadSourceElement>).set(8013666,{...d.input.ways.get(8013666)!,tags:{highway:'residential',access:'private'}});assert.throws(()=>qualifyReviewedTransitContinuation(d.input,d.approval,d.baseApproval),/source way/);
});
