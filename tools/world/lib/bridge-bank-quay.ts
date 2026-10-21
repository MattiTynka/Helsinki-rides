import assert from 'node:assert/strict';
import {supportNormal,type SupportTriangle,type SupportVertex,type TramSupportPatch} from './tram-support-repair.ts';
import type {TramPoint} from './tram-visuals.ts';
import type {BridgeReplacementPatch} from './bridge-ground-replacement.ts';
import type {BridgeFace} from './bridge-reconstruction.ts';

export interface BridgeBankQuay {
 id:string;sourceCoastWayId:number;coast:TramPoint[];landWidth:number;waterY:number;kind?:'sloped-stone-revetment';toeHeight?:number;observation:string;
}
export function quayRows(q:BridgeBankQuay,sourceTriangles:readonly SupportTriangle[]=[]){
 assert.ok(q.coast.length>=2&&q.landWidth>0&&q.landWidth<=6);
 const lengths=[0];for(let i=1;i<q.coast.length;i++)lengths.push(lengths.at(-1)!+Math.hypot(q.coast[i]![0]-q.coast[i-1]![0],q.coast[i]![1]-q.coast[i-1]![1]));
 const cuts=new Set(lengths);for(let s=0;s<lengths.at(-1)!;s+=1)cuts.add(s);
 const first=q.coast[0]!,last=q.coast.at(-1)!,L=Math.hypot(last[0]-first[0],last[1]-first[1]),direction:TramPoint=[(last[0]-first[0])/L,(last[1]-first[1])/L],tangent=(_i:number)=>direction;
 for(let i=1;i<q.coast.length;i++){const a=q.coast[i-1]!,c=q.coast[i]!;assert.ok((c[0]-a[0])*direction[0]+(c[1]-a[1])*direction[1]>0,`Bank coast must progress toward its end; bound ${q.id} at a source shoreline corner instead of cutting through a reversal`);}
 const section=(s:number)=>{let i=0;while(i<lengths.length-2&&lengths[i+1]!<s)i++;const a=q.coast[i]!,c=q.coast[i+1]!,u=(s-lengths[i]!)/(lengths[i+1]!-lengths[i]!),A=tangent(i),C=tangent(i+1),d:[number,number]=[A[0]+(C[0]-A[0])*u,A[1]+(C[1]-A[1])*u],coast:[number,number]=[a[0]+(c[0]-a[0])*u,a[1]+(c[1]-a[1])*u],land:[number,number]=[coast[0]+d[1]*q.landWidth,coast[1]-d[0]*q.landWidth];return{s,coast,land,d};};
 for(let i=1;i<lengths.length;i++){const a=section(lengths[i-1]!),c=section(lengths[i]!),dx=c.land[0]-a.land[0],dz=c.land[1]-a.land[1];for(const triangle of sourceTriangles)for(let k=0;k<3;k++){const p=triangle[k]!,r=triangle[(k+1)%3]!,ex=r[0]-p[0],ez=r[2]-p[2],den=dx*ez-dz*ex;if(Math.abs(den)<1e-12)continue;const px=p[0]-a.land[0],pz=p[2]-a.land[1],u=(px*ez-pz*ex)/den,v=(px*dz-pz*dx)/den;if(u>0&&u<1&&v>=0&&v<=1)cuts.add(lengths[i-1]!+(lengths[i]!-lengths[i-1]!)*u);}}
 return[...cuts].sort((a,c)=>a-c).filter((v,i,A)=>i===0||v-A[i-1]!>.0002).map(section);
}
export function quayReplacementZones(q:BridgeBankQuay):BridgeReplacementPatch[]{
 const rows=quayRows(q);return rows.slice(1).map((c,i)=>{const a=rows[i]!,footprint=[a.coast,a.land,c.land,c.coast].map(p=>p.map(Math.fround) as TramPoint);return{id:`quay-${q.id}-${i}`,cell:'unassigned',footprint,boundsXZ:[Math.min(...footprint.map(p=>p[0])),Math.min(...footprint.map(p=>p[1])),Math.max(...footprint.map(p=>p[0])),Math.max(...footprint.map(p=>p[1]))],replaceBoundaryEdges:[3],replaceBoundarySegments:q.coast.slice(1).map((p,i)=>[q.coast[i]!.map(Math.fround) as TramPoint,p.map(Math.fround) as TramPoint] as const),triangles:[],sourceNode:`osm-coast-${q.sourceCoastWayId}`,sourcePrimitive:0,observations:[q.observation]};});
}
/** A quay follows the actual shore. The paved land edge is an original source
 * floor; the water-side wall is vertical rather than terrain draped to water. */
export function buildBridgeBankQuay(q:BridgeBankQuay,height:(x:number,z:number)=>number,deckBelow:(x:number,z:number)=>number|undefined,sourceTriangles:readonly SupportTriangle[]=[]):BridgeFace[]{
 const rows=quayRows(q,sourceTriangles),faces:BridgeFace[]=[],point=(p:TramPoint,y:number)=>[Math.fround(p[0]),Math.fround(y),Math.fround(p[1])] as SupportVertex;
 const emit=(points:SupportVertex[],role:BridgeFace['role'],material:BridgeFace['material'],normal:number[])=>{for(let i=1;i<points.length-1;i++){let t=[points[0]!,points[i]!,points[i+1]!] as SupportTriangle;let n:SupportVertex;try{n=supportNormal(t);}catch{continue;}if(n.reduce((s,v,k)=>s+v*normal[k]!,0)<0)t=[t[0],t[2],t[1]];faces.push({points:t,role,material,collision:true,uvs:t.map(p=>material==='asphalt'?[p[0]/4,p[2]/4]:[Math.hypot(p[0]-rows[0]!.coast[0],p[2]-rows[0]!.coast[1])/4,p[1]/2]) as BridgeFace['uvs']});}};
 for(let i=1;i<rows.length;i++){
  const a=rows[i-1]!,c=rows[i]!,ya=height(...a.land),yc=height(...c.land);assert.ok(Number.isFinite(ya)&&Number.isFinite(yc),'Quay land edge needs actual source paving support');
  const coastA=q.kind==='sloped-stone-revetment'?q.waterY+(q.toeHeight??.35):ya,coastC=q.kind==='sloped-stone-revetment'?q.waterY+(q.toeHeight??.35):yc;
  emit([point(a.coast,coastA),point(a.land,Math.min(ya,deckBelow(...a.land)??Infinity)),point(c.land,Math.min(yc,deckBelow(...c.land)??Infinity)),point(c.coast,coastC)],q.kind==='sloped-stone-revetment'?'bank':'footway',q.kind==='sloped-stone-revetment'?'revetment':'asphalt',[0,1,0]);
  const topA=Math.min(coastA,deckBelow(...a.coast)??Infinity),topC=Math.min(coastC,deckBelow(...c.coast)??Infinity);
  emit([point(a.coast,q.waterY-.5),point(c.coast,q.waterY-.5),point(c.coast,topC),point(a.coast,topA)],'soffit','granite',[-a.d[1],0,a.d[0]]);
  // Closed masonry returns meet the retained bank at the two bounded cuts.
  for(const row of[i===1?a:null,i===rows.length-1?c:null])if(row){const y=height(...row.land),dx=row.land[0]-row.coast[0],dz=row.land[1]-row.coast[1],knots=new Set([0,1]);for(const triangle of sourceTriangles)for(let k=0;k<3;k++){const p=triangle[k]!,r=triangle[(k+1)%3]!,ex=r[0]-p[0],ez=r[2]-p[2],den=dx*ez-dz*ex;if(Math.abs(den)<1e-12)continue;const px=p[0]-row.coast[0],pz=p[2]-row.coast[1],u=(px*ez-pz*ex)/den,v=(px*dz-pz*dx)/den;if(u>0&&u<1&&v>=0&&v<=1)knots.add(u);}const T=[...knots].sort((a,c)=>a-c).filter((v,i,A)=>i===0||v-A[i-1]!>.00001);for(let j=1;j<T.length;j++){const p=[row.coast[0]+dx*T[j-1]!,row.coast[1]+dz*T[j-1]!] as TramPoint,r=[row.coast[0]+dx*T[j]!,row.coast[1]+dz*T[j]!] as TramPoint,rawP=height(...p),rawR=height(...r),oldP=Number.isFinite(rawP)?rawP:T[j-1]===0?q.waterY-.5:rawP,oldR=Number.isFinite(rawR)?rawR:T[j]===0?q.waterY-.5:rawR;assert.ok(Number.isFinite(oldP)&&Number.isFinite(oldR),`Quay end must meet its actual source bank:${q.id}:${p}:${oldP}:${r}:${oldR}`);emit([point(p,Math.min(oldP,q.waterY-.5)),point(r,Math.min(oldR,q.waterY-.5)),point(r,Math.max(oldR,q.kind==='sloped-stone-revetment'?q.waterY+(q.toeHeight??.35)+(y-q.waterY-(q.toeHeight??.35))*T[j]!:y)),point(p,Math.max(oldP,q.kind==='sloped-stone-revetment'?q.waterY+(q.toeHeight??.35)+(y-q.waterY-(q.toeHeight??.35))*T[j-1]!:y))],'soffit','granite',[(row.s===0?-1:1)*row.d[0],0,(row.s===0?-1:1)*row.d[1]]);}}

 }
 return faces;
}
