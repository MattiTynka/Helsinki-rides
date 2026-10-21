import assert from 'node:assert/strict';
import {geodeticToGk25,polylineLength} from '../../../packages/world-schema/src/index.ts';
import {deliverySha} from './delivery-city-payloads.ts';
export interface DeliveryShoreAccessProfile {
  schemaVersion:1;kind:'source-bound-shore-terminal-vehicle-trim';sourceOsmSha256:string;originId:string;originProjected:[number,number,number];
  wayId:number;endpointNodeId:number;stopNodeId:number;shoreFootwayIds:number[];coastlineWayId:number;pierWayId:number;
  forwardLaneId:string;backwardLaneId:string;reason:string;
}
/** Stop a project car at the actual dry shore junction. The mapped public
 * walking/cycling records and pier/coast source geometry remain unchanged. */
export function applyDeliveryShoreAccess(roads:any,p:DeliveryShoreAccessProfile,osmBytes:Uint8Array){
  assert.equal(p.schemaVersion,1);assert.equal(p.kind,'source-bound-shore-terminal-vehicle-trim');assert.equal(deliverySha(osmBytes),p.sourceOsmSha256);assert.ok(p.reason.length>=40);
  assert.equal(roads.originId,p.originId);assert.equal(p.originProjected.length,3);assert.ok(p.originProjected.every(Number.isFinite));
  const osm=JSON.parse(Buffer.from(osmBytes).toString()),elements=new Map<string,any>(osm.elements.map((e:any)=>[e.type+':'+e.id,e])),way=elements.get('way:'+p.wayId),coast=elements.get('way:'+p.coastlineWayId),pier=elements.get('way:'+p.pierWayId);
  assert.equal(way?.tags?.highway,'service');assert.equal(way.nodes.at(-1),p.endpointNodeId);assert.equal(way.nodes.at(-2),p.stopNodeId,'Only the last exact source edge may be trimmed');assert.equal(coast?.tags?.natural,'coastline');assert.ok(coast.nodes.includes(p.endpointNodeId));assert.equal(pier?.tags?.man_made,'pier');assert.ok(pier.nodes.includes(p.endpointNodeId));assert.equal(pier.nodes[0],pier.nodes.at(-1));
  assert.ok(p.shoreFootwayIds.length>0);for(const id of p.shoreFootwayIds){const walk=elements.get('way:'+id);assert.ok(['footway','cycleway','path','pedestrian'].includes(walk?.tags?.highway)&&walk.nodes.includes(p.stopNodeId),'The retained stop must be the actual public shore junction');}
  const nodePosition=(id:number)=>{const n=elements.get('node:'+id);assert.ok(n&&Number.isFinite(n.lat)&&Number.isFinite(n.lon));const[E,N]=geodeticToGk25(n.lat,n.lon);return[Number((E-p.originProjected[0]).toFixed(3)),Number((p.originProjected[1]-N).toFixed(3))];};
  const f=roads.lanes.find((l:any)=>l.id===p.forwardLaneId),b=roads.lanes.find((l:any)=>l.id===p.backwardLaneId);assert.ok(f&&b&&f.wayId===p.wayId&&b.wayId===p.wayId);assert.equal(f.to,'n'+p.endpointNodeId);assert.equal(b.from,f.to);assert.equal(f.from,b.to);assert.deepEqual(f.points,[...b.points].reverse());
  const endpoint=f.points.at(-1),stop=f.points.at(-2);assert.deepEqual([endpoint[0],endpoint[2]],nodePosition(p.endpointNodeId));assert.deepEqual([stop[0],stop[2]],nodePosition(p.stopNodeId));assert.ok(f.points.length>=3);const length=Number(polylineLength(f.points.slice(0,-1)).toFixed(3));
  assert.ok(!roads.lanes.some((l:any)=>l!==f&&l!==b&&(l.from===f.to||l.to===f.to)),'The trim cannot remove another motor-road connection');assert.ok(!roads.nodes.some((n:any)=>n.id==='n'+p.stopNodeId));assert.ok(roads.nodes.some((n:any)=>n.id===f.to));
  assert.ok(!(roads.parking??[]).some((q:any)=>[f.id,b.id].includes(q.laneId??q.lane)),'Parking needs separate retained-length qualification');
  const lanes=roads.lanes.map((l:any)=>l===f?{...l,to:'n'+p.stopNodeId,points:l.points.slice(0,-1),length}:l===b?{...l,from:'n'+p.stopNodeId,points:l.points.slice(1),length}:l),connectors=roads.connectors.filter((c:any)=>c.node!==f.to),nodes=roads.nodes.filter((n:any)=>n.id!==f.to).concat([{id:'n'+p.stopNodeId,position:stop,kind:'end'}]),next={...roads,lanes,connectors,nodes};
  for(const[key,value]of Object.entries(roads))if(!['lanes','connectors','nodes'].includes(key))assert.deepEqual(next[key],value);
  return{roads:next,proof:{schemaVersion:1,kind:p.kind,sourceOsmSha256:p.sourceOsmSha256,wayId:p.wayId,removedExactSourceEdge:[p.stopNodeId,p.endpointNodeId],retainedStop:p.stopNodeId,shoreFootwayIds:p.shoreFootwayIds,sourceCoastlineWay:p.coastlineWayId,sourcePierWay:p.pierWayId,forwardLane:f.id,backwardLane:b.id,beforeLength:f.length,afterLength:length,retainedLanePointArraysExact:true,publicWalkingAndOtherGraphRecordsExact:true,removedEndpointConnectors:roads.connectors.length-connectors.length,reason:p.reason}};
}
