import assert from 'node:assert/strict';
import type {BridgeFace} from './bridge-reconstruction.ts';
import {junctionTravelFrame,junctionTravelLengths,type JunctionTravelProfile} from './delivery-bridge-junction-profile.ts';

/** Grade proof for the emitted F32 planes, rather than an unexported chart.
 * A conservative direction envelope also bounds the whole face between its
 * sampled source frames, separating transverse crossfall from travel grade. */
export function auditJunctionDomainFaces(profile:JunctionTravelProfile,faces:readonly BridgeFace[]){
 const lengths=junctionTravelLengths(profile.centres),length=lengths.at(-1)!,cross=(a:readonly number[],b:readonly number[])=>a[0]!*b[1]!-a[1]!*b[0]!;
 const locate=(x:number,z:number)=>{let lo=0,hi=length;const value=(s:number)=>{const f=junctionTravelFrame(profile,s);return cross(f.normal,[x-f.origin[0],z-f.origin[1]]);},sign=Math.sign(value(0));for(let i=0;i<48;i++){const mid=(lo+hi)/2;if(Math.sign(value(mid))===sign)lo=mid;else hi=mid;}const s=(lo+hi)/2,f=junctionTravelFrame(profile,s);return{s,offset:(x-f.origin[0])*f.normal[0]+(z-f.origin[1])*f.normal[1],frame:f};};
 let maximumEmittedLongitudinalGrade=0,maximumConservativeLongitudinalGrade=0,maximumEmittedTransverseGrade=0;let witness:unknown=null;
 for(const [triangle,face]of faces.entries()){
  const[a,b,c]=face.points,det=(b[0]-a[0])*(c[2]-a[2])-(b[2]-a[2])*(c[0]-a[0]);assert.notEqual(det,0,'An emitted junction floor lost positive encoded area');
  const gx=((b[1]-a[1])*(c[2]-a[2])-(c[1]-a[1])*(b[2]-a[2]))/det,gz=((b[0]-a[0])*(c[1]-a[1])-(c[0]-a[0])*(b[1]-a[1]))/det,gradientNorm=Math.hypot(gx,gz),locations=[...face.points,face.points.reduce((n,p)=>n.map((v,k)=>v+p[k]!/3) as [number,number,number],[0,0,0] as [number,number,number])].map(p=>locate(p[0],p[2]));
  for(const q of locations){const f=q.frame,tx=f.axisDerivative[0]+f.normalDerivative[0]*q.offset,tz=f.axisDerivative[1]+f.normalDerivative[1]*q.offset,grade=Math.abs(gx*tx+gz*tz)/Math.hypot(tx,tz);maximumEmittedTransverseGrade=Math.max(maximumEmittedTransverseGrade,Math.abs(gx*f.normal[0]+gz*f.normal[1]));if(grade>maximumEmittedLongitudinalGrade){maximumEmittedLongitudinalGrade=grade;witness={triangle,points:face.points,station:q.s,physicalOffset:q.offset,grade,gradient:[gx,gz]};}}
  const min=Math.min(...locations.map(q=>q.s)),max=Math.max(...locations.map(q=>q.s));
  // The mapped centre axis is linear between original source nodes. The
  // normalized interpolated normal has |N'| <= |V'| / min |V|. Evaluate every
  // incident source segment, so a face at a node cannot hide a direction jump.
  for(let segment=1;segment<lengths.length;segment++){
   const lo=Math.max(min,lengths[segment-1]!),hi=Math.min(max,lengths[segment]!);if(lo>hi)continue;
   const a=profile.centres[segment-1]!,b=profile.centres[segment]!,segmentLength=lengths[segment]!-lengths[segment-1]!,normal=(j:number)=>{const a=profile.centres[Math.max(0,j-1)]!,b=profile.centres[Math.min(profile.centres.length-1,j+1)]!,d=Math.hypot(b.x-a.x,b.z-a.z);return[-(b.z-a.z)/d,(b.x-a.x)/d] as [number,number];},A=normal(segment-1),B=normal(segment),D=B.map((v,k)=>v-A[k]!),dd=D[0]!**2+D[1]!**2,u0=(lo-lengths[segment-1]!)/segmentLength,u1=(hi-lengths[segment-1]!)/segmentLength,minimumAt=dd?Math.max(u0,Math.min(u1,-(A[0]*D[0]!+A[1]*D[1]!)/dd)):u0,minimumNormalLength=Math.hypot(A[0]+D[0]!*minimumAt,A[1]+D[1]!*minimumAt),normalDerivativeBound=Math.hypot(...D)/segmentLength/minimumNormalLength;
   const origins=[lo,hi].map(s=>{const u=(s-lengths[segment-1]!)/segmentLength;return[a.x+(b.x-a.x)*u,a.z+(b.z-a.z)*u] as [number,number];}),offsetBound=Math.max(...face.points.flatMap(p=>origins.map(o=>Math.hypot(p[0]-o[0],p[2]-o[1])))),deviation=offsetBound*normalDerivativeBound;assert.ok(deviation<1,'Source-offset chart reverses its actual travel direction');
   const along=Math.abs(gx*(b.x-a.x)/segmentLength+gz*(b.z-a.z)/segmentLength),bound=(along+gradientNorm*deviation)/(1-deviation);maximumConservativeLongitudinalGrade=Math.max(maximumConservativeLongitudinalGrade,bound);
  }
 }
 assert.ok(maximumConservativeLongitudinalGrade<=profile.maximumLongitudinalGrade,'Emitted junction planes exceed the NEW longitudinal limit: '+JSON.stringify({id:profile.id,maximumEmittedLongitudinalGrade,maximumConservativeLongitudinalGrade,limit:profile.maximumLongitudinalGrade,witness}));
 return{triangles:faces.length,maximumEmittedLongitudinalGrade,maximumConservativeLongitudinalGrade,maximumEmittedTransverseGrade,witness,gradeSource:'actual emitted F32 triangle planes; complete per-face source-segment direction envelope'};
}
