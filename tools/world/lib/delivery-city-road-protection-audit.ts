import type {RoadGraph,Vec3} from '../../../packages/world-schema/src/index.ts';
import {deliveryRoadCurveKey,deliveryRoadClip,type RoadProtectionRectangle} from './delivery-city-road-preservation.ts';
import {deliveryRoadAuthorityCuts,selectDeliveryRoadFloor,type DeliveryBridgeRoadAuthority} from './delivery-city-road-registration.ts';
const epsilon=1e-7,at=(a:readonly number[],b:readonly number[],t:number)=>a.map((v,k)=>v+(b[k]!-v)*t)as Vec3;
/** Complete oriented XYZ coverage outside exact, qualified source bridge
 * domains. Endpoint retention alone cannot prove this: one changed interior
 * height otherwise tilts a long old chord outside the replacement footprint. */
export function auditDeliveryRoadProtection(old:RoadGraph,next:RoadGraph,rectangle:RoadProtectionRectangle,authorities:readonly DeliveryBridgeRoadAuthority[]){
  const oldLanes=new Map(old.lanes.map(l=>[l.id,l])),nextLanes=new Map(next.lanes.map(l=>[l.id,l])),results:Record<string,unknown>={},failures:any[]=[];
  const wayIds=(wire:any,kind:string,lanes:Map<string,any>)=>kind==='lanes'?[wire.wayId]:kind==='connectors'?[lanes.get(wire.from).wayId,lanes.get(wire.to).wayId]:[Number(wire.id.match(/^w(\d+)/)?.[1])];
  for(const kind of['lanes','connectors','footways']as const){const groups=new Map<string,{id:string;segment:number;a:Vec3;b:Vec3}[]>();for(const wire of next[kind]){const key=deliveryRoadCurveKey(wire,kind,nextLanes),list=groups.get(key)??[];for(let i=1;i<wire.points.length;i++){const a=wire.points[i-1]!,b=wire.points[i]!,range=deliveryRoadClip(a,b,rectangle);if(range)list.push({id:wire.id,segment:i-1,a:at(a,b,range[0]),b:at(a,b,range[1])});}groups.set(key,list);}
    let acceptedSegments=0,protectedPieces=0,exactPieces=0,qualifiedBridgePieces=0;
    for(const wire of old[kind])for(let segment=1;segment<wire.points.length;segment++){const A=wire.points[segment-1]!,B=wire.points[segment]!,range=deliveryRoadClip(A,B,rectangle);if(!range)continue;acceptedSegments++;const ids=wayIds(wire,kind,oldLanes),times=[range[0],...deliveryRoadAuthorityCuts(A,B,ids,authorities).filter(t=>t>range[0]&&t<range[1]),range[1]];
      for(let i=1;i<times.length;i++){const a=at(A,B,times[i-1]!),b=at(A,B,times[i]!),mid=at(a,b,.5);if(selectDeliveryRoadFloor(mid,[],ids,authorities).authorities.length){qualifiedBridgePieces++;continue;}protectedPieces++;const dx=b[0]-a[0],dz=b[2]-a[2],L2=dx*dx+dz*dz;if(L2<1e-16){exactPieces++;continue;}const intervals:number[][]=[],near=[];
        for(const c of groups.get(deliveryRoadCurveKey(wire,kind,oldLanes))??[]){const param=(p:Vec3)=>((p[0]-a[0])*dx+(p[2]-a[2])*dz)/L2,u=param(c.a),v=param(c.b);if(v<=u)continue;const lo=Math.max(0,u),hi=Math.min(1,v);if(hi<=lo)continue;const distance=(p:Vec3)=>Math.abs((p[0]-a[0])*dz-(p[2]-a[2])*dx)/Math.sqrt(L2),xz=Math.max(distance(c.a),distance(c.b));if(xz>epsilon)continue;const h=(t:number)=>a[1]+(b[1]-a[1])*t,ch=(t:number)=>c.a[1]+(c.b[1]-c.a[1])*(t-u)/(v-u),height=Math.max(Math.abs(h(lo)-ch(lo)),Math.abs(h(hi)-ch(hi)));near.push({candidate:c.id,segment:c.segment,lo,hi,xzError:xz,heightError:height});if(height<=epsilon)intervals.push([lo,hi]);}
        intervals.sort((a,b)=>a[0]!-b[0]!);let covered=0;for(const[lo,hi]of intervals){if(lo!>covered+epsilon)break;covered=Math.max(covered,hi!);}if(covered>=1-epsilon)exactPieces++;else failures.push({kind,id:wire.id,oldSegment:segment-1,sourceWayIds:ids,a,b,coveredTo:covered,near});
      }
    }results[kind]={acceptedSegments,protectedPieces,exactPieces,qualifiedBridgePieces};
  }return{kind:'complete-protected-oriented-road-chord-audit',status:failures.length?'PROTECTED_PHYSICAL_ROAD_DIFFERENCES_REQUIRE_REVIEW':'PASS_ALL_OUTSIDE_BRIDGE_PROTECTED_CHORDS_EXACT',rectangle,toleranceMetres:epsilon,results,failures};
}
