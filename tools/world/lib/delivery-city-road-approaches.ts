import assert from 'node:assert/strict';
import type {RoadGraph,Vec3} from '../../../packages/world-schema/src/index.ts';
import {geodeticToGk25} from '../../../packages/world-schema/src/index.ts';
import {deliveryRoadAuthorityCuts,selectDeliveryRoadFloor,type DeliveryBridgeRoadAuthority} from './delivery-city-road-registration.ts';
export interface ReviewedRoadApproach {bridge:string;wayId:number;connectedWayId:number;sharedNodeId:number}
interface OsmWay {type:'way';id:number;nodes:number[];tags?:Record<string,string>}
interface OsmNode {type:'node';id:number;lat:number;lon:number}
const inside=(p:Vec3,a:DeliveryBridgeRoadAuthority)=>selectDeliveryRoadFloor(p,[],a.sourceWayIds,[a]).authorities.length>0;
function intervals(graph:RoadGraph,id:number,a:DeliveryBridgeRoadAuthority){
 const result:{lane:string;segment:number;from:number;to:number;lengthMetres:number}[]=[];
 for(const l of graph.lanes)if(l.wayId===id)for(let i=1;i<l.points.length;i++){
  const A=l.points[i-1]!,B=l.points[i]!,times=[0,...deliveryRoadAuthorityCuts(A,B,a.sourceWayIds,[a]),1];
  for(let j=1;j<times.length;j++){const from=times[j-1]!,to=times[j]!,mid=A.map((v,k)=>v+(B[k]!-v)*(from+to)/2)as Vec3;if(inside(mid,a)){const lengthMetres=Math.hypot(B[0]-A[0],B[2]-A[2])*(to-from);if(lengthMetres>1e-6)result.push({lane:l.id,segment:i-1,from,to,lengthMetres});}}
 }return result;
}
/** Only named, reviewed ordinary continuations can extend an upper authority.
 * Shared source endpoint identity and a positive encoded ROAD intersection are
 * necessary. Mere coincident XZ, source Y or a nearby upper sample is not. */
export function qualifyDeliveryRoadApproaches(authorities:readonly DeliveryBridgeRoadAuthority[],graph:RoadGraph,osm:{elements:unknown[]},origin:readonly number[],reviewed:readonly ReviewedRoadApproach[]){
 const ways=new Map(osm.elements.filter((e:any)=>e.type==='way').map(e=>[(e as OsmWay).id,e as OsmWay])),nodes=new Map(osm.elements.filter((e:any)=>e.type==='node').map(e=>[(e as OsmNode).id,e as OsmNode])),next=structuredClone(authorities)as DeliveryBridgeRoadAuthority[],proof:any[]=[];
 for(const r of reviewed){assert.ok(Number.isSafeInteger(r.wayId)&&Number.isSafeInteger(r.connectedWayId)&&Number.isSafeInteger(r.sharedNodeId));const a=next.find(a=>a.id===r.bridge);assert.ok(a,'Unknown bridge approach authority');assert.ok(a.sourceWayIds.includes(r.connectedWayId),'Approach must connect to an already qualified source way');assert.ok(!a.sourceWayIds.includes(r.wayId),'Redundant approach authority');const w=ways.get(r.wayId),c=ways.get(r.connectedWayId),n=nodes.get(r.sharedNodeId);assert.ok(w&&c&&n,'Missing actual OSM approach identity');
  assert.ok([w.nodes[0],w.nodes.at(-1)].includes(r.sharedNodeId)&&[c.nodes[0],c.nodes.at(-1)].includes(r.sharedNodeId),'Approach needs literal shared source endpoint identity');assert.ok(!w.tags?.tunnel&&w.tags?.location!=='underground','Underground source cannot qualify an upper approach');const [E,N]=geodeticToGk25(n.lat,n.lon),position:Vec3=[E-origin[0]!,0,-(N-origin[1]!)];assert.ok(inside(position,a),'Shared source node lies outside authored ROAD floor');const overlap=intervals(graph,r.wayId,a);assert.ok(overlap.length,'Approach has no positive actual source-lane ROAD intersection');a.sourceWayIds.push(r.wayId);proof.push({...r,sharedSourcePositionXZ:[position[0],position[2]],sourceTags:w.tags??{},connectedSourceTags:c.tags??{},actualLaneMaskIntervals:overlap,qualification:'Reviewed source endpoint identity and exact ROAD footprint; actual native floor and bank qualification still required by registration.'});
 }return{authorities:next,proof};
}
/** Proposal-only census. These records never authorize a floor by themselves. */
export function censusDeliveryRoadApproaches(authorities:readonly DeliveryBridgeRoadAuthority[],graph:RoadGraph,osm:{elements:unknown[]},origin:readonly number[]){
 const ways=osm.elements.filter((e:any)=>e.type==='way')as OsmWay[],nodes=new Map(osm.elements.filter((e:any)=>e.type==='node').map(e=>[(e as OsmNode).id,e as OsmNode])),used=new Set(graph.lanes.map(l=>l.wayId)),result:any[]=[];
 for(const a of authorities)for(const c of ways.filter(w=>a.sourceWayIds.includes(w.id)))for(const nodeId of [c.nodes[0],c.nodes.at(-1)]){const n=nodes.get(nodeId!);if(!n)continue;const[E,N]=geodeticToGk25(n.lat,n.lon),p:Vec3=[E-origin[0]!,0,-(N-origin[1]!)];if(!inside(p,a))continue;for(const w of ways)if(used.has(w.id)&&!a.sourceWayIds.includes(w.id)&&[w.nodes[0],w.nodes.at(-1)].includes(nodeId)){const overlap=intervals(graph,w.id,a);if(overlap.length)result.push({bridge:a.id,wayId:w.id,connectedWayId:c.id,sharedNodeId:nodeId,sourceTags:w.tags??{},actualLaneMaskIntervals:overlap,status:'PROPOSAL_ONLY_EXPLICIT_SOURCE_REVIEW_REQUIRED'});}}
 return result;
}
