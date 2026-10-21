import assert from 'node:assert/strict';
import type {RoadGraph,Vec3} from '../../../packages/world-schema/src/index.ts';
const key=(p:readonly number[])=>`${p[0]},${p[2]}`;
/** Dense source-XZ samples are diagnostic. They do not automatically enlarge
 * the delivered graph: exact source vertices and real authority cuts survive,
 * other knots survive only where the actual floor changes its linear profile. */
export function densifyDeliveryMotorChords(graph:RoadGraph,spacing=.5){
 assert.ok(spacing>0&&spacing<=.5);const next=structuredClone(graph)as any;
 const retained=new Map<string,Set<string>>();let added=0;
 for(const kind of ['lanes','connectors']as const)for(const wire of next[kind]){
  retained.set(kind+'/'+wire.id,new Set(wire.points.map(key)));const points:Vec3[]=[];
  for(let i=1;i<wire.points.length;i++){const a=wire.points[i-1]as Vec3,b=wire.points[i]as Vec3,n=Math.max(1,Math.ceil(Math.hypot(b[0]-a[0],b[2]-a[2])/spacing));points.push([...a]);for(let j=1;j<n;j++){points.push(a.map((v,k)=>v+(b[k]!-v)*j/n)as Vec3);added++;}}
  points.push([...(wire.points.at(-1)as Vec3)]);wire.points=points;
 }
 return{roads:next as RoadGraph,retained,added,spacing};
}
export function compactDeliveryMotorKnots(graph:RoadGraph,retained:ReadonlyMap<string,ReadonlySet<string>>,boundarySplits:readonly {kind:string;id:string;position:readonly number[]}[],tolerance=.001){
 assert.ok(tolerance>0&&tolerance<=.001);const next=structuredClone(graph)as any;let removed=0,maximumSampleError=0;
 const banks=new Map<string,Set<string>>();for(const b of boundarySplits){const id=b.kind+'/'+b.id,values=banks.get(id)??new Set<string>();values.add(key(b.position));banks.set(id,values);}
 for(const kind of ['lanes','connectors']as const)for(const wire of next[kind]){
  const p=wire.points as Vec3[],keep=new Set<number>([0,p.length-1]),id=kind+'/'+wire.id;for(let i=0;i<p.length;i++)if(retained.get(id)?.has(key(p[i]!))||banks.get(id)?.has(key(p[i]!)))keep.add(i);
  const simplify=(a:number,b:number)=>{if(b-a<2)return;const A=p[a]!,B=p[b]!,dx=B[0]-A[0],dz=B[2]-A[2],L2=dx*dx+dz*dz;let worst=0,index=-1;
   for(let i=a+1;i<b;i++){const P=p[i]!,t=L2?((P[0]-A[0])*dx+(P[2]-A[2])*dz)/L2:0,xz=Math.hypot(P[0]-(A[0]+dx*t),P[2]-(A[2]+dz*t));assert.ok(xz<1e-7,'Compaction cannot change source XZ curves');const error=Math.abs(P[1]-(A[1]+(B[1]-A[1])*t));if(error>worst){worst=error;index=i;}}
   if(worst>tolerance){keep.add(index);simplify(a,index);simplify(index,b);}else maximumSampleError=Math.max(maximumSampleError,worst);
  };
  const anchors=[...keep].sort((a,b)=>a-b);for(let i=1;i<anchors.length;i++)simplify(anchors[i-1]!,anchors[i]!);wire.points=p.filter((_,i)=>keep.has(i));removed+=p.length-wire.points.length;
 }
 return{roads:next as RoadGraph,proof:{spacingMetres:.5,maximumFloorProfileErrorMetres:maximumSampleError,toleranceMetres:tolerance,removedDiagnosticKnots:removed,sourceVerticesAndAuthorityBankCutsRetained:true,sourceXZCurvesExact:true}};
}
/** Independent apply-time invariant: a fabricated or stale plan cannot move
 * new XZ curves/topology merely because no accepted old chord covers them. */
export function assertDeliveryRoadSourceCurves(source:RoadGraph,next:RoadGraph){
 const sameXZ=(a:readonly number[],b:readonly number[])=>a[0]===b[0]&&a[2]===b[2];
 const metadata=(g:RoadGraph)=>{const n={...g}as any;for(const k of ['lanes','connectors','parking','nodes','footways'])delete n[k];return n;};assert.deepEqual(metadata(next),metadata(source),'Source graph metadata/origin changed');
 for(const kind of ['lanes','connectors','parking','nodes','footways']as const){assert.equal(next[kind].length,source[kind].length,'Source road record count changed');for(let i=0;i<source[kind].length;i++){const before=source[kind][i]as any,after=next[kind][i]as any,strip=(v:any)=>{const n={...v};delete n.points;delete n.position;return n;};assert.deepEqual(strip(after),strip(before),'Source road IDs/metadata/topology changed');if(kind==='nodes'){assert.ok(sameXZ(before.position,after.position),'Source node XZ changed');continue;}
   const points=before.points as Vec3[],output=after.points as Vec3[];let index=0;assert.ok(output.length&&sameXZ(points[0]!,output[0]!),'Source curve start moved');
   for(let s=1;s<points.length;s++){const a=points[s-1]!,b=points[s]!,dx=b[0]-a[0],dz=b[2]-a[2],L2=dx*dx+dz*dz;let prior=0;assert.ok(sameXZ(output[index]!,a),'Source horizontal vertex omitted');while(++index<output.length&&!sameXZ(output[index]!,b)){const p=output[index]!,t=L2?((p[0]-a[0])*dx+(p[2]-a[2])*dz)/L2:0;assert.ok(L2>0&&t>prior&&t<1&&Math.hypot(p[0]-(a[0]+dx*t),p[2]-(a[2]+dz*t))<1e-7,'New road knot is outside oriented source XZ chord');prior=t;}assert.ok(index<output.length,'Source horizontal vertex omitted');}
   assert.equal(index,output.length-1,'New road curve extends beyond source');
  }}
 return{sourceXZVerticesRetained:true,completeOrientedSourceXZCurvesExact:true,recordIdsMetadataAndTopologyExact:true};
}

/** Independent full dense-witness check. Repeated XZ on a loopback connector
 * must match its ordered occurrence rather than an earlier crossing chord. */
export function auditCompactedDeliveryMotorProfile(dense:RoadGraph,compact:RoadGraph){
 let witnesses=0,maximumErrorMetres=0;
 for(const kind of ['lanes','connectors']as const){const byId=new Map(compact[kind].map(w=>[w.id,w]));for(const wire of dense[kind]){const output=byId.get(wire.id);assert.ok(output,'Compacted motor wire missing');let segment=0,prior=0;for(const P of wire.points){let found=false;for(let i=segment;i<output.points.length-1;i++){const A=output.points[i]!,B=output.points[i+1]!,dx=B[0]-A[0],dz=B[2]-A[2],L2=dx*dx+dz*dz;if(!L2){if(P[0]===A[0]&&P[2]===A[2]&&P[1]===A[1]){found=true;segment=i;prior=0;break;}continue;}const t=((P[0]-A[0])*dx+(P[2]-A[2])*dz)/L2;if(i===segment&&t<prior-1e-7||t< -1e-7||t>1+1e-7||Math.abs((P[0]-A[0])*dz-(P[2]-A[2])*dx)/Math.sqrt(L2)>1e-7)continue;const error=Math.abs(P[1]-(A[1]+(B[1]-A[1])*Math.max(0,Math.min(1,t))));assert.ok(error<=.001000000001,'Compacted motor chord fails an actual dense floor witness');maximumErrorMetres=Math.max(maximumErrorMetres,error);found=true;segment=i;prior=t;break;}assert.ok(found,'Dense motor floor witness missing from ordered output XZ chord');witnesses++;}}}
 return{kind:'independent-complete-dense-motor-profile-audit',witnesses,maximumErrorMetres,toleranceMetres:.001,orderedRepeatedXZOccurrencesPreserved:true};
}
