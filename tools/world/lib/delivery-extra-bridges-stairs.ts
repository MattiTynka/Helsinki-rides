// A municipal stair flight joins the actual reconstructed upper landing to the
// retained lower landing. Neither a photograph nor a terrain median supplies Y.
import assert from 'node:assert/strict';
import polygonClipping from 'polygon-clipping';
import {supportHeight,supportNormal,type SupportTriangle,type SupportVertex} from './tram-support-repair.ts';
import type {ExtraBridgeNativeFace} from './delivery-extra-bridges-source.ts';
import type {ExtraBridgeFace} from './delivery-extra-bridges-mesh.ts';
type Point=[number,number];
export interface ExtraBridgeStairSource {
  schemaVersion:1;kind:'municipal-native-landing-stairs-v1';bridgeId:string;partId:number;upperPartId:number;lowerPartId:number;
  cornersXZ:[Point,Point,Point,Point];northSideXZ:Point[];treads:number;maximumRiserMetres:number;
  originalFlight:{axis:Point[];width:number;steps:number;nativeReportSha256:string};
  originalFaces:{points:SupportTriangle;tag:string}[];
  reference:{url:string;observation:string};
}
export const extraStairTriangleKey=(p:SupportTriangle)=>p.map(q=>q.map(Math.fround).join(',')).sort().join('|');
const det=(p:SupportTriangle)=>(p[1][0]-p[0][0])*(p[2][2]-p[0][2])-(p[1][2]-p[0][2])*(p[2][0]-p[0][0]);
function weights(p:SupportTriangle,q:Point){const[a,b,c]=p,D=det(p);return[((b[2]-c[2])*(q[0]-c[0])+(c[0]-b[0])*(q[1]-c[2]))/D,((c[2]-a[2])*(q[0]-c[0])+(a[0]-c[0])*(q[1]-c[2]))/D];}
/** Full plane-and-area qualification also covers alternate diagonals of a
 * source vertical riser. A nearby architectural face never becomes ground. */
export function extraStairCoplanarCovered(p:SupportTriangle,sources:readonly SupportTriangle[]){
  let n:SupportVertex;try{n=supportNormal(p);}catch{return false;}const drop=n.map(Math.abs).indexOf(Math.max(...n.map(Math.abs))),project=(q:SupportVertex)=>q.filter((_,i)=>i!==drop)as Point,ring=p.map(project);let remaining:Point[][][]= [[ring]];
  for(const source of sources){let m:SupportVertex;try{m=supportNormal(source);}catch{continue;}if(Math.abs(n.reduce((s,v,i)=>s+v*m[i]!,0))<.999999)continue;if(source.some(q=>Math.abs(q.reduce((s,v,i)=>s+(v-p[0][i]!)*n[i]!,0))>.00001))continue;remaining=polygonClipping.difference(remaining,[[source.map(project)]])as Point[][][];if(!remaining.length)return true;}
  const area=(r:Point[])=>Math.abs(r.reduce((s,q,i)=>{const t=r[(i+1)%r.length]!;return s+q[0]*t[1]-t[0]*q[1];},0))/2;
  return remaining.reduce((sum,p)=>sum+p.reduce((s,r,i)=>s+(i?-1:1)*area(r),0),0)<1e-8;
}
function edge(a:Point,b:Point,faces:readonly ExtraBridgeNativeFace[]){
  const at=(t:number):Point=>[a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t],spans:{lo:number;hi:number;face:ExtraBridgeNativeFace}[]=[];
  for(const face of faces){if(Math.abs(det(face.points))<1e-9)continue;let normal:SupportVertex;try{normal=supportNormal(face.points);}catch{continue;}if(normal[1]<=.3)continue;const A=weights(face.points,a),B=weights(face.points,b),wa=[A[0]!,A[1]!,1-A[0]!-A[1]!],wb=[B[0]!,B[1]!,1-B[0]!-B[1]!];const tolerance=.00008*Math.max(...[0,1,2].map(i=>Math.hypot(face.points[i]![0]-face.points[(i+1)%3]![0],face.points[i]![2]-face.points[(i+1)%3]![2])))/Math.abs(det(face.points));let lo=0,hi=1;
    for(let k=0;k<3;k++){const value=wa[k]!,slope=wb[k]!-value;if(Math.abs(slope)<1e-14){if(value< -tolerance){lo=1;hi=0;}continue;}const crossing=(-tolerance-value)/slope;if(slope>0)lo=Math.max(lo,crossing);else hi=Math.min(hi,crossing);}for(const axis of[0,1]){const min=Math.min(...face.points.map(p=>p[axis===0?0:2]))-.00008,max=Math.max(...face.points.map(p=>p[axis===0?0:2]))+.00008,delta=b[axis]!-a[axis]!;if(Math.abs(delta)<1e-12){if(a[axis]!<min||a[axis]!>max){lo=1;hi=0;}}else{const t0=(min-a[axis]!)/delta,t1=(max-a[axis]!)/delta;lo=Math.max(lo,Math.min(t0,t1));hi=Math.min(hi,Math.max(t0,t1));}}if(hi>=lo-1e-7&&hi>=-.0002&&lo<=1.0002)spans.push({lo:Math.max(0,lo),hi:Math.min(1,hi),face});
  }
  const cuts=[0,1,...spans.flatMap(s=>[s.lo,s.hi])].sort((a,b)=>a-b).filter((v,i,a)=>!i||v-a[i-1]!>1e-8),segments=[];
  for(let i=1;i<cuts.length;i++){const lo=cuts[i-1]!,hi=cuts[i]!,middle=(lo+hi)/2,cover=spans.filter(s=>middle>=s.lo-.0002&&middle<=s.hi+.0002).sort((a,b)=>supportHeight(b.face.points,at(middle))-supportHeight(a.face.points,at(middle)));assert.ok(cover.length,`Actual landing edge unsupported:${lo}..${hi}, faces=${faces.length}, edge=${a}/${b}, spans=${JSON.stringify(spans.map(s=>[s.lo,s.hi]))}`);const f=cover[0]!.face;segments.push({lo,hi,y0:supportHeight(f.points,at(lo)),y1:supportHeight(f.points,at(hi)),source:{cell:f.cell,collider:f.collider,triangle:f.triangle,key:extraStairTriangleKey(f.points)}});}
  assert.ok(segments.length);return segments;
}
export function buildExtraBridgeStair(source:ExtraBridgeStairSource,upper:readonly ExtraBridgeNativeFace[],lower:readonly ExtraBridgeNativeFace[]){
  assert.equal(source.kind,'municipal-native-landing-stairs-v1');assert.equal(source.schemaVersion,1);assert.ok(source.treads>=2&&source.treads<=8&&Number.isInteger(source.treads));assert.ok(source.maximumRiserMetres<=.2&&source.maximumRiserMetres>=.08);assert.match(source.originalFlight.nativeReportSha256,/^[a-f0-9]{64}$/);assert.ok(source.originalFaces.length>10&&source.originalFaces.every(f=>['stairs','stairs-join'].includes(f.tag)));
  const axis=source.originalFlight.axis;assert.equal(axis.length,2);assert.ok(source.originalFlight.width>0&&source.originalFlight.width<10&&Number.isInteger(source.originalFlight.steps)&&source.originalFlight.steps>0&&source.originalFlight.steps<=50);const origin=axis[0]!,end=axis[1]!,dx=end[0]-origin[0],dz=origin[1]-end[1],length=Math.hypot(dx,dz);assert.ok(length>.2&&length<20);for(const face of source.originalFaces)for(const p of face.points){const along=((p[0]-origin[0])*dx+(p[2]+origin[1])*dz)/length,across=(-(p[0]-origin[0])*dz+(p[2]+origin[1])*dx)/length;assert.ok(Math.max(-along,along-length,Math.abs(across)-source.originalFlight.width/2)<=.00008,'Original stair identity escapes its registered source flight');}
  const[A,B,C,D]=source.cornersXZ.map(p=>p.map(Math.fround)as Point)as[Point,Point,Point,Point],top=edge(A,B,upper),bottom=edge(D,C,lower),cuts=[0,1,...top.flatMap(s=>[s.lo,s.hi]),...bottom.flatMap(s=>[s.lo,s.hi])].sort((a,b)=>a-b).filter((v,i,a)=>!i||v-a[i-1]!>1e-8),faces:ExtraBridgeFace[]=[],collapsed:SupportTriangle[]=[],joins=[];
  const northKnots=source.northSideXZ.map(p=>({p:p.map(Math.fround)as Point,u:((p[0]-A[0])*(D[0]-A[0])+(p[1]-A[1])*(D[1]-A[1]))/((D[0]-A[0])**2+(D[1]-A[1])**2)}));northKnots[0]!.u=0;northKnots[northKnots.length-1]!.u=1;const north=(u:number):Point=>{const i=Math.min(northKnots.length-2,Math.max(0,northKnots.findIndex((p,i)=>i+1<northKnots.length&&u<=northKnots[i+1]!.u+1e-9)));const a=northKnots[i]!,b=northKnots[i+1]!,t=(u-a.u)/(b.u-a.u);return[a.p[0]+(b.p[0]-a.p[0])*t,a.p[1]+(b.p[1]-a.p[1])*t];};
  const H=(segments:typeof top,t:number)=>{const s=segments.find(s=>t>=s.lo-1e-8&&t<=s.hi+1e-8);assert.ok(s);return s.y0+(s.y1-s.y0)*(t-s.lo)/(s.hi-s.lo);},point=(u:number,v:number,y:number):SupportVertex=>[Math.fround(north(u)[0]*(1-v)+(B[0]+(C[0]-B[0])*u)*v),Math.fround(y),Math.fround(north(u)[1]*(1-v)+(B[1]+(C[1]-B[1])*u)*v)],height=(k:number,v:number)=>H(top,v)+(H(bottom,v)-H(top,v))*k/(source.treads-1);
  let minimumRiser=Infinity,maximumRiser=0;for(const v of cuts){const rise=(H(top,v)-H(bottom,v))/(source.treads-1);assert.ok(rise>0&&rise<=source.maximumRiserMetres,`Landing levels cannot form the declared descending stair:${rise}, v=${v}, top=${H(top,v)}, bottom=${H(bottom,v)}`);minimumRiser=Math.min(minimumRiser,rise);maximumRiser=Math.max(maximumRiser,rise);joins.push({v,upper:H(top,v),lower:H(bottom,v)});}
  const emit=(p:SupportTriangle,role:'footway'|'bank')=>{assert.ok(p.flat().every(Number.isFinite));const u=p[1].map((v,i)=>v-p[0][i]!),v=p[2].map((v,i)=>v-p[0][i]!),cross=[u[1]!*v[2]!-u[2]!*v[1]!,u[2]!*v[0]!-u[0]!*v[2]!,u[0]!*v[1]!-u[1]!*v[0]!];if(Math.hypot(...cross)<=1e-12){collapsed.push(p);return;}const n=supportNormal(p);if(role==='footway'&&n[1]<0)[p[1],p[2]]=[p[2],p[1]];faces.push({points:p,uvs:p.map(p=>[p[0]/1.2,-p[2]/1.2])as[[number,number],[number,number],[number,number]],role,material:'concrete',collision:true,sourcePartIds:[source.partId],colour:[.49,.48,.45]});};
  for(let k=0;k<source.treads;k++)for(let i=1;i<cuts.length;i++){const rows=[k/source.treads,...northKnots.map(p=>p.u).filter(u=>u>k/source.treads+1e-9&&u<(k+1)/source.treads-1e-9),(k+1)/source.treads];for(let j=1;j<rows.length;j++){const v0=cuts[i-1]!,v1=cuts[i]!,u0=rows[j-1]!,u1=rows[j]!,a=point(u0,v0,height(k,v0)),b=point(u1,v0,height(k,v0)),c=point(u1,v1,height(k,v1)),d=point(u0,v1,height(k,v1));emit([a,b,c],'footway');emit([a,c,d],'footway');if(k&&j===1){const e=point(u0,v0,height(k-1,v0)),f=point(u0,v1,height(k-1,v1));emit([a,d,f],'bank');emit([a,f,e],'bank');emit([a,f,d],'bank');emit([a,e,f],'bank');}}}
  // Source-native flight side walls close the stair volume without adding a
  // horizontal lower floor or touching the adjacent retained footway.
  const sideBottom=Math.min(...source.originalFaces.flatMap(f=>f.points.map(p=>p[1])))-.03;
  for(const v of[0,1])for(let k=0;k<source.treads;k++){const rows=[k/source.treads,...northKnots.map(p=>p.u).filter(u=>u>k/source.treads+1e-9&&u<(k+1)/source.treads-1e-9),(k+1)/source.treads];for(let j=1;j<rows.length;j++){const u0=rows[j-1]!,u1=rows[j]!,a=point(u0,v,height(k,v)),b=point(u1,v,height(k,v)),c=point(u1,v,sideBottom),d=point(u0,v,sideBottom);emit([a,b,c],'bank');emit([a,c,d],'bank');emit([a,c,b],'bank');emit([a,d,c],'bank');}}
  return{faces,proof:{sourcePartId:source.partId,upperPartId:source.upperPartId,lowerPartId:source.lowerPartId,top,bottom,joins,minimumRiser,maximumRiser,treads:source.treads,sourceFlightReferenceOnly:true,landingHeightsFromActualHCOL:true,collapsedAtFloat32Precision:collapsed}};
}



