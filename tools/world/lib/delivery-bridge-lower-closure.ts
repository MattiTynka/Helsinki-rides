import assert from 'node:assert/strict';
import polygonClipping from 'polygon-clipping';
import earcut from 'earcut';
import {extraBridgeLocal,extraBridgeWorld,type ExtraBridgeFrame,type ExtraBridgeNativeFace} from './delivery-extra-bridges-source.ts';
import type {ExtraBridgeFace} from './delivery-extra-bridges-mesh.ts';
import {sourcePartsForTriangle,type LayeredSourcePart} from './layered-bridge-source.ts';
import {supportHeight,supportNormal,type SupportTriangle,type SupportVertex} from './tram-support-repair.ts';
import {sourceSha256} from './source-files.ts';
type Pair=[number,number];
const ring=(points:readonly Pair[]):polygonClipping.Polygon=>[[...points.map(p=>[...p]as Pair),[...points[0]!]as Pair]];
const area=(g:polygonClipping.MultiPolygon)=>g.reduce((s,p)=>s+p.reduce((n,r,i)=>n+(i?-1:1)*Math.abs(r.reduce((a,u,j)=>{const v=r[(j+1)%r.length]!;return a+u[0]*v[1]-u[1]*v[0];},0))/2,0),0);
const footprint=(p:SupportTriangle)=>ring(p.map(v=>[v[0],v[2]]));
export interface LowerBridgeClosureInput {
  sourcePart:LayeredSourcePart;frame:ExtraBridgeFrame;gateStations:readonly[number,number];
  native:readonly ExtraBridgeNativeFace[];upperFloors:readonly SupportTriangle[];
  deckThicknessMetres:number;gateThicknessMetres:number;
}
/** Original gameplay closures, never a claim that municipal gates exist. No
 * native height is replaced and no hidden floor is manufactured. The explicit
 * walls occupy only the air between actual native ground and authored soffit. */
export function buildSourceBoundLowerClosure(input:LowerBridgeClosureInput){
 assert.ok(input.gateThicknessMetres>=.08&&input.gateThicknessMetres<=.2);assert.ok(input.deckThicknessMetres>=.25&&input.deckThicknessMetres<=1.2);
 const local=input.sourcePart.rings.map(r=>r.map(p=>extraBridgeLocal(input.frame,p))),points=local.flat(),range=[Math.min(...points.map(p=>p[0])),Math.max(...points.map(p=>p[0]))],width=[Math.min(...points.map(p=>p[1]))-1,Math.max(...points.map(p=>p[1]))+1],span=range[1]!-range[0]!;
 assert.ok(input.gateStations[0]<input.gateStations[1]&&input.gateStations[1]-input.gateStations[0]>5);
 assert.ok(input.gateStations[0]>range[0]!&&input.gateStations[0]<range[0]!+span*.3&&input.gateStations[1]<range[1]!&&input.gateStations[1]>range[1]!-span*.3,'Closures must bracket the hidden interval at opposite source approaches');
 const native=input.native.filter(f=>['ground','kerbs'].includes(f.group)&&sourcePartsForTriangle(f.points,[input.sourcePart],f.tag).length&&(()=>{try{return supportNormal(f.points)[1]>0;}catch{return false;}})());
 assert.ok(native.length&&input.upperFloors.length);
 const faces:ExtraBridgeFace[]=[],gates=[];
 const emit=(p:readonly SupportVertex[],normal:readonly number[],colour:[number,number,number])=>{for(let i=1;i<p.length-1;i++){let triangle=p.slice(0,1).concat([p[i]!,p[i+1]!]).map(v=>v.map(Math.fround))as SupportTriangle;let n;try{n=supportNormal(triangle);}catch{continue;}if(n.reduce((s,v,k)=>s+v*normal[k]!,0)<0)triangle=[triangle[0],triangle[2],triangle[1]];faces.push({points:triangle,role:'railing',material:'steel',sourcePartIds:[input.sourcePart.id],colour,collision:true,uvs:triangle.map(v=>[v[0]/2,v[1]/2])as ExtraBridgeFace['uvs']});}};
 for(const station of input.gateStations){
  const h=input.gateThicknessMetres/2,localStrip=polygonClipping.intersection([local],[ring([[station-h,width[0]!],[station+h,width[0]!],[station+h,width[1]!],[station-h,width[1]!]])]),domain=localStrip.map(p=>p.map(r=>r.map(([s,t])=>extraBridgeWorld(input.frame,s,t))));assert.ok(area(domain)>0);
  const candidates=native.filter(f=>polygonClipping.intersection(domain,[footprint(f.points)]).length),coverage=polygonClipping.union(...candidates.map(f=>footprint(f.points))as[polygonClipping.Polygon,...polygonClipping.Polygon[]]);
  const missing=polygonClipping.difference(domain,coverage);
  // Source ring coordinates and native ownership share the established 0.25mm
  // Float32 boundary envelope. Only boundary fragments may be absent, never an
  // interior floor hole. The actual emitted gate follows native coverage.
  for(const polygon of missing)for(const r of polygon)for(const q of r){const st=extraBridgeLocal(input.frame,q);assert.ok(Math.min(...local.flatMap(r=>r.slice(1).map((b,i)=>{const a=r[i]!,x=b[0]-a[0],z=b[1]-a[1],d=x*x+z*z,t=d?Math.max(0,Math.min(1,((st[0]-a[0])*x+(st[1]-a[1])*z)/d)):0;return Math.hypot(st[0]-a[0]-x*t,st[1]-a[1]-z*t);})))<=.00025,'Closure has an unsupported interior foundation');}
  const nativeDomain=polygonClipping.intersection(domain,coverage),roof=polygonClipping.union(...input.upperFloors.map(footprint)as[polygonClipping.Polygon,...polygonClipping.Polygon[]]);const roofGap=polygonClipping.difference(nativeDomain,roof);assert.equal(area(roofGap),0,`Closure must meet actual upper soffit over its complete width at ${station}: ${JSON.stringify(roofGap.map(p=>p.map(r=>r.map(v=>extraBridgeLocal(input.frame,v)))))}`);
  const pieces=[],start=faces.length;let maximumNativeAboveSoffit=-Infinity;
  for(const floor of candidates)for(const upper of input.upperFloors){const overlap=polygonClipping.intersection(nativeDomain,[footprint(floor.points)],[footprint(upper)]);if(!overlap.length||area(overlap)===0)continue;
   for(const polygon of overlap){const flat:number[]=[],holes:number[]=[];for(const[i,r]of polygon.entries()){if(i)holes.push(flat.length/2);for(const p of r.slice(0,-1))flat.push(...p);}const ids=earcut(flat,holes),bottom=(p:Pair)=>supportHeight(floor.points,p)-.1,top=(p:Pair)=>supportHeight(upper,p)-input.deckThicknessMetres+.01;
    // Slab/ground overlap already closes the space. Embed at most10mm into the
    // actual soffit; the wall can never extend through the upper walking floor.
    const row=(p:Pair,high:boolean):SupportVertex=>[p[0],high?top(p):Math.min(bottom(p),top(p)-.01),p[1]];
    for(let i=0;i<ids.length;i+=3){const p=ids.slice(i,i+3).map(k=>[flat[k*2]!,flat[k*2+1]!]as Pair);emit(p.map(v=>row(v,true)),[0,1,0],[.9,.52,.08]);emit(p.slice().reverse().map(v=>row(v,false)),[0,-1,0],[.9,.52,.08]);}
    for(const r of polygon)for(let i=1;i<r.length;i++){const a=r[i-1]!,b=r[i]!;maximumNativeAboveSoffit=Math.max(maximumNativeAboveSoffit,supportHeight(floor.points,a)-(supportHeight(upper,a)-input.deckThicknessMetres));emit([row(a,false),row(b,false),row(b,true),row(a,true)],[b[1]-a[1],0,a[0]-b[0]],[.9,.52,.08]);}
    pieces.push({native:{cell:floor.cell,collider:floor.collider,triangle:floor.triangle,sha256:sourceSha256(JSON.stringify(floor.points))},upperSha256:sourceSha256(JSON.stringify(upper)),polygon});
   }
  }
  assert.ok(pieces.length&&faces.length>start);assert.ok(maximumNativeAboveSoffit<input.deckThicknessMetres-.05,'Retained native approach intrudes into the upper walking floor');gates.push({station,domain,nativeDomain,sourceBoundaryRoundoffOnly:missing,maximumNativeAboveSoffit,triangles:faces.length-start,pieces});
 }
 return{faces,proof:{status:'SOURCE_NATIVE_AND_SOFFIT_BOUND_CLOSURE_GEOMETRY_PENDING_MOTION',sourcePartId:input.sourcePart.id,sourcePartSha256:sourceSha256(JSON.stringify(input.sourcePart)),frame:input.frame,gateThicknessMetres:input.gateThicknessMetres,foundationEmbedMetres:.1,soffitEmbedMetres:.01,nativeFloorsUnmodified:true,upperFloorUnmodified:true,authoredGameplayClosureNotSurveyedGate:true,gates}};
}
