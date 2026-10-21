import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {RoadGraph,RoadLane} from '../../../packages/world-schema/src/index.ts';
import {deliveryRoadCurveKey,preserveDeliveryRoadPhysicalCurves} from '../lib/delivery-city-road-preservation.ts';
import {selectDeliveryRoadFloor,registerDeliveryRoadGraphFloors,deliveryRoadAuthorityCuts,type DeliveryBridgeRoadAuthority} from '../lib/delivery-city-road-registration.ts';
import {auditDeliveryRoadProtection} from '../lib/delivery-city-road-protection-audit.ts';
const lane=(id:string,wayId:number,points:number[][]):RoadLane=>({id,wayId,name:null,highway:'residential',surface:'asphalt',speedLimit:5,width:3,index:0,count:1,from:'n0',to:'n1',points:points as[number,number,number][],length:20});
function graph():RoadGraph{
  const lanes=[lane('8034579:0:f0',8034579,[[0,1,10],[1,1,10]]),lane('8034579:0:b0',8034579,[[1,1,10],[0,1,10]]),lane('79518605:0:f0',79518605,[[0,1,11],[1,1,11]]),lane('79518605:0:b0',79518605,[[1,1,11],[0,1,11]]),lane('100:0:f0',100,[[0,1,0],[5,6,0],[10,11,0]])];
  return{schemaVersion:2,originId:'fixture',source:{id:'source',sha256:'0'.repeat(64),attribution:'fixture',license:'fixture'},nodes:[{id:'n0',position:[0,1,0],kind:'junction'},{id:'n1',position:[15,1,0],kind:'boundary'}],lanes,connectors:[{id:'8034579:0:f0>79518605:0:f0',node:'n1',from:'8034579:0:f0',to:'79518605:0:f0',turn:'straight',points:[[1,1,10],[1,1,11]],length:1},{id:'79518605:0:b0>8034579:0:b0',node:'n0',from:'79518605:0:b0',to:'8034579:0:b0',turn:'straight',points:[[0,1,11],[0,1,10]],length:1}],parking:[],footways:[]};
}
test('accepted physical curves survive justified piece IDs and an exact clipped old/new boundary',()=>{
  const old=graph(),generated=structuredClone(old)as any;generated.lanes[4]={...generated.lanes[4],id:'100:2:f0',points:[[0,99,0],[10,99,0],[20,99,0]]};
  const result=preserveDeliveryRoadPhysicalCurves(old,generated,[-1,-1,10,20]),wire=result.roads.lanes[4]!;assert.equal(wire.id,'100:2:f0');assert.deepEqual(wire.points,[[0,1,0],[10,11,0],[20,99,0]]);assert.deepEqual(result.roads.lanes.slice(0,4),old.lanes.slice(0,4));assert.deepEqual(result.roads.connectors,old.connectors);
  assert.equal(deliveryRoadCurveKey(old.lanes[4],'lanes',new Map()),deliveryRoadCurveKey(wire,'lanes',new Map()));
  generated.lanes[0].to='missing';assert.throws(()=>preserveDeliveryRoadPhysicalCurves(old,generated,[-1,-1,10,20]),/missing node/);
});
const authority:DeliveryBridgeRoadAuthority={id:'qualified-deck',sourceWayIds:[100],floorTag:'road:asphalt:bridge-reconstruction',masks:[{id:'exact-road-triangle',polygon:[[4,-1],[6,-1],[5,1]],boundsXZ:[4,-1,6,1]}]},sample=(height:number,tag='road:asphalt')=>({height,tag,group:'ground',cell:'native',collider:'g:native'});
test('mapped upper/lower source identity selects actual floor instead of the obsolete source Y',()=>{
  const floors=[sample(1),sample(12,authority.floorTag)];assert.equal(selectDeliveryRoadFloor([5,1,0],floors,[100],[authority]).chosen!.height,12);assert.equal(selectDeliveryRoadFloor([5,12,0],floors,[200],[authority]).chosen!.height,1);
  assert.equal(selectDeliveryRoadFloor([9,1,0],floors,[100],[authority]).chosen!.height,1);assert.equal(selectDeliveryRoadFloor([5,1,0],[sample(1)],[100],[authority]).status,'MISSING_QUALIFIED_BRIDGE_ROAD_FLOOR');
  assert.equal(selectDeliveryRoadFloor([5,1,0],[sample(1),sample(8,'raised:asphalt')],[200],[authority]).status,'UNQUALIFIED_DISTINCT_NATIVE_LEVELS');assert.equal(selectDeliveryRoadFloor([5,1,0],[],[200],[authority]).chosen,null);
});
test('only new used road Y and exact old bridge masks change; source XZ/topology and unqualified minimap records remain exact',()=>{
  const g=graph(),input={...g,lanes:[{...g.lanes[4]!,points:[[0,1,0],[5,1,0],[10,1,0],[15,1,0]]as[number,number,number][]}],connectors:[],nodes:g.nodes.concat([{id:'unused',position:[15,1,4],kind:'end'}]),footways:[{id:'w200',points:[[15,1,3],[16,1,3]]as[number,number,number][]}]},options={acceptedRoads:input,protectedRectangle:[-1,-1,10,20]as const,expandedRectangle:[-1,-1,20,20]as const,authorities:[authority],sourceBridgeFootwayIds:[]},result=registerDeliveryRoadGraphFloors(input,{...options,sample:(x,z)=>z===3?[sample(1),sample(8,'raised:asphalt')]:[sample(3),sample(Math.abs(x-5)<.001?12:1,authority.floorTag)]});
  assert.deepEqual(result.roads.lanes[0]!.points,[[0,1,0],[4.5,1,0],[5,12,0],[5.5,1,0],[10,1,0],[15,3,0]]);assert.deepEqual(result.roads.footways,input.footways);assert.deepEqual(result.roads.nodes.at(-1),input.nodes.at(-1));assert.equal(result.proof.unresolvedMotorPoints.length,0);assert.equal(result.proof.unqualifiedMinimapFootways.length,2);assert.equal(result.proof.status,'ALL_USED_MOTOR_POINTS_HAVE_ACTUAL_NATIVE_FLOOR');assert.ok(input.lanes[0]!.points.every(p=>result.roads.lanes[0]!.points.some(q=>p[0]===q[0]&&p[2]===q[2])));
  const mismatched=registerDeliveryRoadGraphFloors(input,{...options,sample:()=>[sample(1),sample(12,authority.floorTag)]});assert.equal(mismatched.proof.status,'MOTOR_FLOOR_QUALIFICATION_REQUIRED');assert.equal(mismatched.proof.unresolvedMotorPoints.filter(r=>r.status==='PROTECTED_OLD_GRAPH_TO_NATIVE_BRIDGE_BANK_MISMATCH').length,2);assert.equal(mismatched.roads.lanes[0]!.points[1]![1],1);
  const audit=auditDeliveryRoadProtection(input,result.roads,options.protectedRectangle,[authority]);assert.equal(audit.status,'PASS_ALL_OUTSIDE_BRIDGE_PROTECTED_CHORDS_EXACT');
  const tilted={...input,lanes:[{...input.lanes[0]!,points:[[0,1,0],[5,12,0],[10,1,0],[15,3,0]]as[number,number,number][]}]};assert.equal(auditDeliveryRoadProtection(input,tilted,options.protectedRectangle,[authority]).status,'PROTECTED_PHYSICAL_ROAD_DIFFERENCES_REQUIRE_REVIEW');
});
test('authority cuts isolate the actual outer union rather than every internal authored triangle edge',()=>{
  const a={...authority,masks:[{id:'a',polygon:[[4,-1],[6,-1],[6,1]]as[number,number][],boundsXZ:[4,-1,6,1]},{id:'b',polygon:[[4,-1],[6,1],[4,1]]as[number,number][],boundsXZ:[4,-1,6,1]}]};
  assert.deepEqual(deliveryRoadAuthorityCuts([0,1,0],[10,1,0],[100],[a]),[.4,.6]);assert.deepEqual(deliveryRoadAuthorityCuts([0,1,0],[10,1,0],[200],[a]),[]);
});
