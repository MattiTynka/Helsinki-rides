import assert from 'node:assert/strict';
import {test} from 'node:test';
import {applyDeliveryRoadAccess,type DeliveryRoadAccessProfile} from '../lib/delivery-city-road-access.ts';
import {deliverySha} from '../lib/delivery-city-payloads.ts';
function fixture(){
  const osm=Buffer.from(JSON.stringify({elements:[{type:'node',id:1},{type:'node',id:2},{type:'node',id:3,tags:{barrier:'gate'}},{type:'node',id:4},{type:'way',id:10,nodes:[1,2,3],tags:{highway:'residential',motor_vehicle:'destination'}},{type:'way',id:20,nodes:[2,4],tags:{highway:'residential'}}]}));
  const lane=(id:string,wayId:number,from:string,to:string)=>({id,wayId,from,to,points:[[1,2,3],[4,5,6]],width:3});
  const roads={lanes:[lane('10:0',10,'n1','n2'),lane('10:1',10,'n2','n3'),lane('20:0',20,'n2','n4')],connectors:[{id:'stay',from:'10:0',to:'20:0',points:[[1,2,3]]},{id:'cut',from:'10:0',to:'10:1',points:[[4,5,6]]}],nodes:[{id:'n2',position:[1,2,3]}],footways:[{id:'walk',points:[[1,2,3]]}],parking:[],source:{sha256:'unaltered'}};
  const profile:DeliveryRoadAccessProfile={schemaVersion:1,kind:'source-bound-new-area-game-vehicle-exclusions',sourceOsmSha256:deliverySha(osm),cases:[{id:'reviewed-gate',wayId:10,sourceNodeSpan:[2,3],publicJunctionNodeId:2,publicConnectingWayIds:[10,20],gateNodeId:3,laneIds:['10:1'],reason:'Source gate bounds only the terminal branch; preserve its preceding public junction.'}]};return{osm,roads,profile};
}
test('vehicle gate exclusion preserves exact public branch, walking, nodes, parking and retained curves',()=>{
  const{osm,roads,profile}=fixture(),before=structuredClone(roads),result=applyDeliveryRoadAccess(roads,profile,osm);
  assert.deepEqual(result.roads,{...roads,lanes:[roads.lanes[0],roads.lanes[2]],connectors:[roads.connectors[0]]});assert.deepEqual(roads,before);assert.equal(result.proof.removedLanes,1);assert.equal(result.proof.removedConnectors,1);
});
test('source hash, actual gate, contiguous span and real public junction are mandatory',()=>{
  for(const mutate of[(p:DeliveryRoadAccessProfile)=>p.sourceOsmSha256='0'.repeat(64),(p:DeliveryRoadAccessProfile)=>p.cases[0]!.gateNodeId=2,(p:DeliveryRoadAccessProfile)=>p.cases[0]!.sourceNodeSpan=[1,3],(p:DeliveryRoadAccessProfile)=>p.cases[0]!.publicConnectingWayIds=[99],(p:DeliveryRoadAccessProfile)=>p.cases[0]!.laneIds=['10:0']]){const{osm,roads,profile}=fixture();mutate(profile);assert.throws(()=>applyDeliveryRoadAccess(roads,profile,osm));}
});
