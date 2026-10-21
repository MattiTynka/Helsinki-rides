import assert from 'node:assert/strict';
import{deliveryLegacyTransitionAt,type DeliveryLegacyBankTransition}from'./delivery-city-road-legacy.ts';
import {validateRoadGraph,type RoadGraph,type Vec3} from '../../../packages/world-schema/src/index.ts';
import {pointInPolygon,ringDistance} from './geometry.ts';
import type {DeliveryFloorSample} from './delivery-city-ground-sampler.ts';
import {deliveryRoadCurveKey,type RoadProtectionRectangle} from './delivery-city-road-preservation.ts';
type Mutable<T>={-readonly[K in keyof T]:Mutable<T[K]>};
export interface DeliveryBridgeRoadAuthority {
  id:string;sourceWayIds:number[];floorTag:string;
  masks:{id:string;polygon:[number,number][];boundsXZ:readonly number[]}[];
}
const inside=(p:readonly number[],r:RoadProtectionRectangle)=>p[0]!>=r[0]&&p[0]!<=r[2]&&p[2]!>=r[1]&&p[2]!<=r[3];
const inMask=(p:readonly number[],mask:DeliveryBridgeRoadAuthority['masks'][number])=>p[0]!>=mask.boundsXZ[0]!-1e-5&&p[0]!<=mask.boundsXZ[2]!+1e-5&&p[2]!>=mask.boundsXZ[1]!-1e-5&&p[2]!<=mask.boundsXZ[3]!+1e-5&&(pointInPolygon([p[0]!,p[2]!],[mask.polygon])||ringDistance([p[0]!,p[2]!],mask.polygon)<1e-5);
export function deliveryRoadAuthorityCuts(a:readonly number[],b:readonly number[],wayIds:readonly number[],authorities:readonly DeliveryBridgeRoadAuthority[]){
  const masks=authorities.filter(v=>v.sourceWayIds.some(id=>wayIds.includes(id))).flatMap(v=>v.masks).filter(m=>Math.min(a[0]!,b[0]!)<=m.boundsXZ[2]!&&Math.max(a[0]!,b[0]!)>=m.boundsXZ[0]!&&Math.min(a[2]!,b[2]!)<=m.boundsXZ[3]!&&Math.max(a[2]!,b[2]!)>=m.boundsXZ[1]!);if(!masks.length)return[];
  const dx=b[0]!-a[0]!,dz=b[2]!-a[2]!,times=[0,1],point=(t:number)=>[a[0]!+dx*t,a[1]!+(b[1]!-a[1]!)*t,a[2]!+dz*t];
  for(const mask of masks)for(let i=0;i<mask.polygon.length;i++){const p=mask.polygon[i]!,q=mask.polygon[(i+1)%mask.polygon.length]!,ex=q[0]-p[0],ez=q[1]-p[1],det=dx*ez-dz*ex;if(Math.abs(det)<1e-12)continue;const u=((p[0]-a[0]!)*ez-(p[1]-a[2]!)*ex)/det,v=((p[0]-a[0]!)*dz-(p[1]-a[2]!)*dx)/det;if(u>1e-10&&u<1-1e-10&&v>=-1e-10&&v<=1+1e-10)times.push(u);}
  times.sort((a,b)=>a-b);const unique=times.filter((t,i)=>!i||t-times[i-1]!>1e-10),inside=(t:number)=>masks.some(m=>inMask(point(t),m));return unique.slice(1,-1).filter((t,i)=>inside((unique[i]!+t)/2)!==inside((t+unique[i+2]!)/2));
}
/** An upper floor is selected by the actual qualified source way AND authored
 * ROAD footprint, never by proximity to the obsolete terrain height. */
export function selectDeliveryRoadFloor(point:readonly number[],samples:readonly DeliveryFloorSample[],sourceWayIds:readonly number[],authorities:readonly DeliveryBridgeRoadAuthority[]){
  const matched=authorities.flatMap(a=>a.sourceWayIds.some(id=>sourceWayIds.includes(id))?a.masks.filter(mask=>inMask(point,mask)).map(mask=>({authority:a,mask})):[]),upperTags=new Set([...authorities.map(a=>a.floorTag),'raised:asphalt:bridge-reconstruction']),upperTag=matched[0]?.authority.floorTag;
  assert.ok(!matched.length||matched.every(m=>m.authority.floorTag===upperTag),'Distinct bridge floor authorities overlap one source road point');
  const allowed=samples.filter(s=>s.group==='ground'&&(upperTag?s.tag===upperTag:!upperTags.has(s.tag))),levels=allowed.map(s=>s.height),spread=levels.length?Math.max(...levels)-Math.min(...levels):null;
  if(!allowed.length)return{status:matched.length?'MISSING_QUALIFIED_BRIDGE_ROAD_FLOOR':'MISSING_ACTUAL_ROAD_FLOOR',chosen:null,authorities:matched.map(m=>({id:m.authority.id,mask:m.mask.id})),spread};
  if(spread!>.5)return{status:'UNQUALIFIED_DISTINCT_NATIVE_LEVELS',chosen:null,authorities:matched.map(m=>({id:m.authority.id,mask:m.mask.id})),spread};
  const chosen=allowed.reduce((a,b)=>a.height>=b.height?a:b);return{status:upperTag?'QUALIFIED_SOURCE_BOUND_BRIDGE_FLOOR':'ACTUAL_SINGLE_LEVEL_GROUND_UPPER_ENVELOPE',chosen,authorities:matched.map(m=>({id:m.authority.id,mask:m.mask.id})),spread};
}
/** Only coordinates on the new map or exact qualified old bridge ROAD masks
 * gain new Y. Source X/Z, record IDs, topology and all old outside-mask Y stay
 * literal. Unused source nodes and unqualified minimap footways stay explicit. */
export function registerDeliveryRoadGraphFloors(roads:RoadGraph,options:{acceptedRoads:RoadGraph;protectedRectangle:RoadProtectionRectangle;expandedRectangle:RoadProtectionRectangle;authorities:readonly DeliveryBridgeRoadAuthority[];sourceBridgeFootwayIds:readonly number[];legacyTransitions?:readonly DeliveryLegacyBankTransition[];sample:(x:number,z:number)=>DeliveryFloorSample[]}){
  assert.deepEqual(validateRoadGraph(roads),[]);const next=structuredClone(roads)as Mutable<RoadGraph>,lanes=new Map(roads.lanes.map(l=>[l.id,l])),nodeWays=new Map<string,Set<number>>(),rows:any[]=[],unresolved:any[]=[],footwayUnqualified:any[]=[],preserved:Record<string,number>={},boundarySplits:any[]=[];
  for(const l of roads.lanes)for(const id of[l.from,l.to]){const ids=nodeWays.get(id)??new Set<number>();ids.add(l.wayId);nodeWays.set(id,ids);}
  const accepted=options.acceptedRoads,acceptedLanes=new Map(accepted.lanes.map(l=>[l.id,l])),acceptedCurves=new Map<string,ReadonlyArray<ReadonlyArray<number>>[]>();for(const kind of['lanes','connectors','footways']as const)for(const wire of accepted[kind]){const key=kind+'/'+deliveryRoadCurveKey(wire,kind,acceptedLanes),curves=acceptedCurves.get(key)??[];acceptedCurves.set(key,[...curves,wire.points]);}
  const oldCoverage=(kind:string,item:any,p:Vec3)=>{if(!inside(p,options.protectedRectangle))return false;if(kind==='nodes'){const n=accepted.nodes.find(n=>n.id===item.id);return!!n&&n.position[0]===p[0]&&n.position[2]===p[2];}if(kind==='parking')return accepted.parking.some(q=>q.id===item.id&&q.points.some(v=>v[0]===p[0]&&v[2]===p[2]));const curves=acceptedCurves.get(kind+'/'+deliveryRoadCurveKey(item,kind,lanes))??[];return curves.some(points=>points.slice(1).some((b,i)=>{const a=points[i]!,dx=b[0]!-a[0]!,dz=b[2]!-a[2]!,L2=dx*dx+dz*dz;if(!L2)return Math.hypot(p[0]-a[0]!,p[2]-a[2]!)<1e-7;const t=((p[0]-a[0]!)*dx+(p[2]-a[2]!)*dz)/L2;return t>=-1e-7&&t<=1+1e-7&&Math.abs((p[0]-a[0]!)*dz-(p[2]-a[2]!)*dx)/Math.sqrt(L2)<1e-7;}));};
  const idsFor=(kind:string,item:any)=>kind==='lanes'?[item.wayId]:kind==='connectors'?[lanes.get(item.from)!.wayId,lanes.get(item.to)!.wayId]:kind==='nodes'?[...nodeWays.get(item.id)??[]]:kind==='footways'?[Number(item.id.match(/^w(\d+)/)?.[1])]:[];
  const cache=new Map<string,DeliveryFloorSample[]>();let selected=0;
  for(const kind of['lanes','connectors','parking','nodes','footways']as const)for(const item of next[kind]){if(kind==='parking'&&accepted.parking.some(p=>p.id===item.id)){assert.deepEqual(item,accepted.parking.find(p=>p.id===item.id),'Old parking must first bind exact accepted-record authority');preserved.parking=(preserved.parking??0)+(item as any).points.length;continue;}const wayIds=idsFor(kind,item),bankIndices=new Set<number>();let points:Vec3[]=kind==='nodes'?[(item as any).position]:(item as any).points;
    if(kind==='lanes'||kind==='connectors'||kind==='footways'){const expanded:Vec3[]=[];for(let i=1;i<points.length;i++){const a=points[i-1]!,b=points[i]!;expanded.push([...a]);for(const t of deliveryRoadAuthorityCuts(a,b,wayIds,options.authorities)){const p=a.map((v,k)=>v+(b[k]!-v)*t)as Vec3;bankIndices.add(expanded.length);expanded.push(p);boundarySplits.push({kind,id:item.id,sourceSegment:i-1,t,position:[...p]});}}expanded.push([...points.at(-1)!]);points=expanded;(item as any).points=points;}
    const matchingMasks=options.authorities.filter(a=>a.sourceWayIds.some(id=>wayIds.includes(id))).flatMap(a=>a.masks),inAuthority=(p:readonly number[])=>matchingMasks.some(m=>inMask(p,m));
    for(const[i,p]of points.entries())if(inAuthority(p)){
      const neighbors=[points[i-1],points[i+1]].filter((p):p is Vec3=>!!p);if(neighbors.some(q=>!inAuthority(p.map((v,k)=>(v+q[k]!)/2))))bankIndices.add(i);
      // Also protect an original endpoint/shared graph node on an authored
      // union boundary. The 1mm probe only classifies native Float32 edges;
      // it never grows a floor or permits an outside-coordinate mutation.
      if([0,1,2,3,4,5,6,7].some(k=>!inAuthority([p[0]+Math.cos(k*Math.PI/4)*.001,p[1],p[2]+Math.sin(k*Math.PI/4)*.001])))bankIndices.add(i);
    }
    for(const[index,p]of(points as Vec3[]).entries()){const old=[...p]as Vec3,bridge=options.authorities.some(a=>a.sourceWayIds.some(id=>wayIds.includes(id))&&a.masks.some(m=>inMask(p,m))),protectedPoint=oldCoverage(kind,item,p);
      if(!inside(p,options.expandedRectangle)||protectedPoint&&!bridge||kind==='nodes'&&!nodeWays.has(item.id)){preserved[kind]=(preserved[kind]??0)+1;continue;}
      if(kind==='footways'&&!bridge&&wayIds.some(id=>options.sourceBridgeFootwayIds.includes(id))){footwayUnqualified.push({kind,id:item.id,index,before:old,sourceWayIds:wayIds,status:'SOURCE_BRIDGE_FOOTWAY_REQUIRES_OWN_QUALIFIED_LEVEL',sourceYRetained:true});continue;}
      const key=p[0]+','+p[2];let samples=cache.get(key);if(!samples){samples=options.sample(p[0],p[2]);cache.set(key,samples);}const result=selectDeliveryRoadFloor(p,samples,wayIds,options.authorities),row={kind,id:item.id,index,sourceWayIds:wayIds,before:old,protectedPoint,...result};selected++;
      if(!result.chosen){(kind==='footways'?footwayUnqualified:unresolved).push(row);continue;}
      const legacy=deliveryLegacyTransitionAt(kind,item.id,p,result.chosen.height,options.legacyTransitions??[]);if(legacy){p[1]=legacy.afterY;rows.push({...row,status:'DECLARED_LEGACY_NAVIGATION_TRANSITION_NOT_NATIVE_FLOOR_REGISTRATION',afterY:p[1],legacyNavigation:legacy,physicalFloorY:result.chosen.height,floorRegistrationSuccessCredit:0});continue;}
      if(protectedPoint&&bankIndices.has(index)){const delta=result.chosen.height-p[1];if(Math.abs(delta)>.001){unresolved.push({...row,status:'PROTECTED_OLD_GRAPH_TO_NATIVE_BRIDGE_BANK_MISMATCH',bankDeltaMetres:delta});continue;}rows.push({...row,afterY:p[1],preserveExactOutsideChord:true,bankDeltaMetres:delta,maximumBankRegistrationDifferenceMetres:.001});continue;}
      p[1]=result.chosen.height;assert.equal(p[0],old[0]);assert.equal(p[2],old[2]);if(protectedPoint)assert.ok(result.authorities.length,'An accepted old Y changed outside exact source-bound bridge ROAD authority');rows.push({...row,afterY:p[1]});
    }
  }
  assert.deepEqual(validateRoadGraph(next),[]);return{roads:next,proof:{kind:'actual-native-road-floor-registration',status:unresolved.length?'MOTOR_FLOOR_QUALIFICATION_REQUIRED':'ALL_USED_MOTOR_POINTS_HAVE_ACTUAL_NATIVE_FLOOR',protectedRectangle:options.protectedRectangle,expandedRectangle:options.expandedRectangle,originalSourceXZVerticesAndHorizontalCurvesExact:true,recordIdsAndFromToTopologyExact:true,boundarySplits,selectedPoints:selected,registeredPoints:rows.length,registeredNativeFloorPoints:rows.filter(r=>!r.legacyNavigation).length,declaredLegacyNavigationPoints:rows.filter(r=>r.legacyNavigation).length,preservedPoints:preserved,unresolvedMotorPoints:unresolved,unqualifiedMinimapFootways:footwayUnqualified,rows,scope:'Exact actual encoded native HCOL ground only. No heightfield fallback, nearest stacked-layer guess or invented surface. Unqualified minimap-only footway Y and unused source nodes remain literal and explicitly listed.'}};
}
