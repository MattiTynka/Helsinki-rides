import assert from 'node:assert/strict';
import {test} from 'node:test';
import {geodeticToGk25,polylineLength} from '../../../packages/world-schema/src/index.ts';
import {applyDeliveryShoreAccess,type DeliveryShoreAccessProfile} from '../lib/delivery-city-shore-access.ts';
import {deliverySha} from '../lib/delivery-city-payloads.ts';
function fixture(){
  const nodes=Array.from({length:8},(_,i)=>({type:'node',id:i+1,lat:60+(i*.0001),lon:24.9})),originProjected=[...geodeticToGk25(nodes[0]!.lat,nodes[0]!.lon),0] as[number,number,number],point=(i:number)=>{const[E,N]=geodeticToGk25(nodes[i-1]!.lat,nodes[i-1]!.lon);return[Number((E-originProjected[0]).toFixed(3)),0,Number((originProjected[1]-N).toFixed(3))] as[number,number,number];};
  const elements:any[]=[...nodes,{type:'way',id:10,nodes:[1,2,3],tags:{highway:'service'}},{type:'way',id:20,nodes:[2,4],tags:{highway:'footway'}},{type:'way',id:30,nodes:[7,3,8],tags:{natural:'coastline'}},{type:'way',id:40,nodes:[3,5,6,3],tags:{man_made:'pier'}}],osm=Buffer.from(JSON.stringify({elements})),points=[point(1),point(2),point(3)],f={id:'forward',wayId:10,from:'n1',to:'n3',points,length:polylineLength(points)},b={...f,id:'backward',from:'n3',to:'n1',points:[...points].reverse()},roads={originId:'fixture',lanes:[f,b],nodes:[{id:'n1',position:point(1),kind:'end'},{id:'n3',position:point(3),kind:'end'}],connectors:[{id:'wet-u-turn',node:'n3',from:f.id,to:b.id,points:[point(3)]}],parking:[],footways:[{id:'public-pier-access',points:[point(2),point(3)]}],source:{raw:'literal'}};
  const profile:DeliveryShoreAccessProfile={schemaVersion:1,kind:'source-bound-shore-terminal-vehicle-trim',sourceOsmSha256:deliverySha(osm),originId:'fixture',originProjected,wayId:10,endpointNodeId:3,stopNodeId:2,shoreFootwayIds:[20],coastlineWayId:30,pierWayId:40,forwardLaneId:f.id,backwardLaneId:b.id,reason:'Keep the supported public shore junction while removing only the final vehicle edge onto the mapped pier.'};return{roads,profile,osm,elements};
}
test('shore trim retains exact dry lane prefixes and public walking, and removes the wet U-turn',()=>{
  const{roads,profile,osm}=fixture(),before=structuredClone(roads),result=applyDeliveryShoreAccess(roads,profile,osm);assert.deepEqual(roads,before);
  assert.deepEqual(result.roads.lanes[0].points,roads.lanes[0]!.points.slice(0,-1));assert.deepEqual(result.roads.lanes[1].points,roads.lanes[1]!.points.slice(1));assert.deepEqual(result.roads.footways,roads.footways);assert.equal(result.roads.lanes[0].to,'n2');assert.equal(result.roads.lanes[1].from,'n2');assert.deepEqual(result.roads.connectors,[]);assert.deepEqual(result.roads.nodes.at(-1),{id:'n2',position:roads.lanes[0]!.points[1],kind:'end'});
});
test('a nearby named shore is insufficient without exact endpoint coastline, pier and public walking topology',()=>{
  for(const change of[(j:any[])=>j.find(e=>e.id===30).nodes=[7,8],(j:any[])=>j.find(e=>e.id===40).tags.man_made='building',(j:any[])=>j.find(e=>e.id===20).nodes=[1,4],(j:any[])=>j.find(e=>e.id===10).nodes=[2,1,3]]){const f=fixture();change(f.elements);const osm=Buffer.from(JSON.stringify({elements:f.elements}));f.profile.sourceOsmSha256=deliverySha(osm);assert.throws(()=>applyDeliveryShoreAccess(f.roads,f.profile,osm));}
  const f=fixture();f.roads.lanes.push({...f.roads.lanes[0]!,id:'other-motor-junction'});assert.throws(()=>applyDeliveryShoreAccess(f.roads,f.profile,f.osm),/another motor-road/);
});
