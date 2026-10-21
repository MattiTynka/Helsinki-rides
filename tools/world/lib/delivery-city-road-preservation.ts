import assert from 'node:assert/strict';
import {validateRoadGraph,type RoadGraph,type Vec3} from '../../../packages/world-schema/src/index.ts';
export type RoadProtectionRectangle=readonly[number,number,number,number];
type Mutable<T>={-readonly[K in keyof T]:Mutable<T[K]>};
const epsilon=1e-7;
const direction=(id:string)=>id.match(/:([fb]\d+)$/)?.[1];
export function deliveryRoadCurveKey(wire:any,kind:string,lanes:Map<string,any>){
  const laneKey=(lane:any)=>{assert.ok(lane);return lane.wayId+':'+direction(lane.id);};
  return kind==='lanes'?laneKey(wire):kind==='footways'?wire.id.split(':old-protected:')[0]:[wire.node,laneKey(lanes.get(wire.from)),laneKey(lanes.get(wire.to)),wire.turn].join('|');
}
export function deliveryRoadClip(a:readonly number[],b:readonly number[],box:RoadProtectionRectangle){
  let lo=0,hi=1;for(const[k,min,max]of[[0,box[0],box[2]],[2,box[1],box[3]]]){const d=b[k!]!-a[k!]!;if(!d){if(a[k!]!<min!||a[k!]!>max!)return null;continue;}let p=(min!-a[k!]!)/d,q=(max!-a[k!]!)/d;if(p>q)[p,q]=[q,p];lo=Math.max(lo,p);hi=Math.min(hi,q);if(lo>=hi)return null;}return[lo,hi]as const;
}
const lerp=(a:readonly number[],b:readonly number[],t:number)=>a.map((v,k)=>v+(b[k]!-v)*t)as Vec3;
/** Preserve actual oriented old XYZ chords across justified source topology
 * splits. No fake connector is introduced just to keep an old segment ID. */
export function preserveDeliveryRoadPhysicalCurves(accepted:RoadGraph,generated:RoadGraph,box:RoadProtectionRectangle){
  assert.deepEqual(validateRoadGraph(accepted),[]);assert.deepEqual(validateRoadGraph(generated),[]);
  const next=structuredClone(generated)as Mutable<RoadGraph>,oldLanes=new Map(accepted.lanes.map(l=>[l.id,l])),newLanes=new Map(next.lanes.map(l=>[l.id,l])),proofs:any[]=[];
  const physicalIds={lanes:['8034579:0:f0','8034579:0:b0','79518605:0:f0','79518605:0:b0'],connectors:['8034579:0:f0>79518605:0:f0','79518605:0:b0>8034579:0:b0']};
  for(const kind of['lanes','connectors']as const)for(const id of physicalIds[kind]){const old=accepted[kind].find(p=>p.id===id),i=next[kind].findIndex(p=>p.id===id);assert.ok(old&&i>=0,'Known accepted physical correction missing');const current=next[kind][i]!;assert.deepEqual({...current,points:old.points,length:old.length},old,'Accepted physical correction topology/metadata changed');(next[kind]as any[])[i]=structuredClone(old);}
  // The old construction segment remains physically usable only within the
  // protected old map; its new-vintage continuation is deliberately excluded.
  for(const old of accepted.footways.filter(w=>!next.footways.some(p=>p.id===w.id))){assert.equal(old.id,'w23815853','An unexpected accepted footway disappeared');let component:Vec3[]=[],number=0;const finish=()=>{if(component.length>1)next.footways.push({...old,id:number++?old.id+':old-protected:'+number:old.id,points:component});component=[];};for(let i=1;i<old.points.length;i++){const a=old.points[i-1]!,b=old.points[i]!,range=deliveryRoadClip(a,b,box);if(!range){finish();continue;}const p=range[0]===0?[...a]as Vec3:lerp(a,b,range[0]),q=range[1]===1?[...b]as Vec3:lerp(a,b,range[1]);if(component.length&&Math.hypot(component.at(-1)![0]-p[0],component.at(-1)![2]-p[2])>epsilon)finish();if(!component.length)component.push(p);component.push(q);}finish();}
  for(const kind of['lanes','connectors','footways']as const){const groups=new Map<string,{a:Vec3;b:Vec3;id:string;segment:number}[]>();for(const old of accepted[kind]){const key=deliveryRoadCurveKey(old,kind,oldLanes),rows=groups.get(key)??[];for(let i=1;i<old.points.length;i++)if(deliveryRoadClip(old.points[i-1]!,old.points[i]!,box))rows.push({a:old.points[i-1]!,b:old.points[i]!,id:old.id,segment:i-1});groups.set(key,rows);}
    for(const wire of next[kind]){const literal=accepted[kind].find(old=>old.id===wire.id);if(literal&&literal.points.length===wire.points.length&&literal.points.every((p,i)=>p[0]===wire.points[i]![0]&&p[2]===wire.points[i]![2]&&p[0]>=box[0]&&p[0]<=box[2]&&p[2]>=box[1]&&p[2]<=box[3])){wire.points=structuredClone(literal.points)as Vec3[];continue;}const matches=groups.get(deliveryRoadCurveKey(wire,kind,newLanes));if(!matches?.length)continue;const points:Vec3[]=[],original=wire.points;
      for(let i=0;i<original.length-1;i++){const a=original[i]!,b=original[i+1]!,range=deliveryRoadClip(a,b,box),times=[0,...(range?range.filter(t=>t>epsilon&&t<1-epsilon):[])];if(i===original.length-2)times.push(1);for(const t of[...new Set(times)].sort((a,b)=>a-b)){const p=t===0?[...a]as Vec3:t===1?[...b]as Vec3:lerp(a,b,t);if(p[0]>=box[0]-epsilon&&p[0]<=box[2]+epsilon&&p[2]>=box[1]-epsilon&&p[2]<=box[3]+epsilon){const heights:{y:number;id:string;segment:number}[]=[];for(const old of matches){const dx=old.b[0]-old.a[0],dz=old.b[2]-old.a[2],L2=dx*dx+dz*dz;if(L2<1e-16||dx*(b[0]-a[0])+dz*(b[2]-a[2])<=0||Math.abs(dx*(b[2]-a[2])-dz*(b[0]-a[0]))/Math.sqrt(L2)>epsilon)continue;const u=((p[0]-old.a[0])*dx+(p[2]-old.a[2])*dz)/L2,transverse=Math.abs((p[0]-old.a[0])*dz-(p[2]-old.a[2])*dx)/Math.sqrt(L2);if(u<-epsilon||u>1+epsilon||transverse>epsilon)continue;heights.push({y:Math.abs(u)<epsilon?old.a[1]:Math.abs(u-1)<epsilon?old.b[1]:old.a[1]+(old.b[1]-old.a[1])*u,id:old.id,segment:old.segment});}if(heights.length&&!heights.some(h=>h.y===p[1])){assert.ok(heights.every(v=>Math.abs(v.y-heights[0]!.y)<=epsilon),'Accepted physical chord heights disagree '+JSON.stringify({kind,id:wire.id,p,heights}));if(p[1]!==heights[0]!.y)proofs.push({kind,id:wire.id,positionXZ:[p[0],p[2]],beforeY:p[1],afterY:heights[0]!.y,source:heights[0]});p[1]=heights[0]!.y;}}
        if(!points.length||points.at(-1)!.some((v,k)=>v!==p[k]))points.push(p);
      }}wire.points=points;
    }
  }assert.deepEqual(validateRoadGraph(next),[]);return{roads:next,proof:{kind:'accepted-oriented-physical-road-chord-preservation',rectangle:box,knownPhysicalCorrections:physicalIds,heightBindings:proofs}};
}
