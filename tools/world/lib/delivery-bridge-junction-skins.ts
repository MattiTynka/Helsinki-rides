import assert from 'node:assert/strict';
import type {Vec3} from '../../../packages/world-schema/src/index.ts';
import type {BridgeFace} from './bridge-reconstruction.ts';
import type {JunctionFloorSource,JunctionFloorWitness} from './delivery-bridge-junction-surfaces.ts';
import {junctionFloorPerimeter} from './delivery-bridge-junction-perimeter.ts';
import {junctionFaceSha} from './delivery-bridge-junction-mouths.ts';
import {buildJunctionTravelProfile,type JunctionTravelProfile} from './delivery-bridge-junction-profile.ts';
const cross=(a:readonly number[],b:readonly number[])=>a[0]!*b[1]!-a[1]!*b[0]!;
function interval(a:Vec3,b:Vec3,points:readonly[Vec3,Vec3,Vec3]){
 const X=points.map(p=>[p[0],p[2]]),sign=Math.sign(cross([X[1]![0]!-X[0]![0]!,X[1]![1]!-X[0]![1]!],[X[2]![0]!-X[0]![0]!,X[2]![1]!-X[0]![1]!]));if(!sign)return null;
 let lo=0,hi=1;for(let i=0;i<3;i++){const p=X[i]!,q=X[(i+1)%3]!,v=(v:Vec3)=>cross([q[0]!-p[0]!,q[1]!-p[1]!],[v[0]-p[0]!,v[2]-p[1]!])*sign,A=v(a),B=v(b);if(A<0&&B<0)return null;if((A>=0)!==(B>=0)){const u=A/(A-B);if(A<0)lo=Math.max(lo,u);else hi=Math.min(hi,u);}}return lo<hi?[lo,hi]as const:null;
}
const height=(p:readonly[Vec3,Vec3,Vec3],x:number,z:number)=>{const[a,b,c]=p,den=(b[0]-a[0])*(c[2]-a[2])-(b[2]-a[2])*(c[0]-a[0]);assert.ok(den!==0);const v=((x-a[0])*(c[2]-a[2])-(z-a[2])*(c[0]-a[0]))/den,w=((b[0]-a[0])*(z-a[2])-(b[2]-a[2])*(x-a[0]))/den;return a[1]+v*(b[1]-a[1])+w*(c[1]-a[1]);};
const at=(a:Vec3,b:Vec3,u:number):Vec3=>a.map((v,k)=>Math.fround(v+(b[k]!-v)*u))as Vec3;
export interface JunctionSideEdgeJoin {
 side:'left'|'right'|'domain';row:number;interval:[number,number];newBank:[Vec3,Vec3];
 source:JunctionFloorSource['source'];edge:0|1|2;parameters:[number,number];literalOldBank:[Vec3,Vec3];
 municipalBoundary:{partId:number;ringIndex:number;edgeIndex:number;points:[[number,number],[number,number]]};
 municipalRelation:{kind:'source-boundary'|'interior-source-seam';maximumDistanceMetres:number};
 maximumLateralMetres:number;
}

/** Close only the two literal source-width side boundaries. Every endpoint
 * height comes from an actually decoded, explicitly selected UPPER face;
 * an absent bank is an error, never a heightfield/nearest-road guess. */
export function censusJunctionSideSkins(profile:JunctionTravelProfile,sources:readonly JunctionFloorSource[],joins:readonly JunctionSideEdgeJoin[]=[]){
 const ramp=buildJunctionTravelProfile(profile,.5),n=ramp.proof.transverseKnots,rows=ramp.proof.stations,faces:BridgeFace[]=[],inventory:unknown[]=[],missing:unknown[]=[],nonArea:unknown[]=[];
 for(const s of sources)assert.equal(junctionFaceSha(s.points),s.source.orderedFloat32Sha256);
 const joinedSources=new Map<JunctionSideEdgeJoin,JunctionFloorSource>();for(const j of joins){const s=sources.find(s=>s.source.cell===j.source.cell&&s.source.collider===j.source.collider&&s.source.triangle===j.source.triangle);assert.ok(s,'Native side join references an unrelated/lower source floor');assert.deepEqual(s.source,j.source);assert.ok(j.interval[0]>=0&&j.interval[1]<=1&&j.interval[1]>j.interval[0]);assert.ok(j.parameters.every(t=>t>=0&&t<=1));assert.ok(j.edge===0||j.edge===1||j.edge===2);const E=[s.points[j.edge],s.points[(j.edge+1)%3]!]as[Vec3,Vec3];assert.deepEqual(j.literalOldBank,j.parameters.map(t=>at(...E,t)));const measured=Math.max(...j.newBank.map((p,i)=>Math.hypot(p[0]-j.literalOldBank[i]![0],p[2]-j.literalOldBank[i]![2])));assert.equal(measured,j.maximumLateralMetres,'Pinned source-native side-join span changed');assert.ok(measured<=.002,'Side join exceeds the independently bounded sub2mm source construction domain');assert.ok(Number.isSafeInteger(j.municipalBoundary.partId)&&j.municipalBoundary.points.flat().every(Number.isFinite));joinedSources.set(j,s);}
 for(const side of[0,n-1])for(let row=1;row<rows;row++){
  const a=ramp.positions[(row-1)*n+side]!,b=ramp.positions[row*n+side]!,hits=sources.flatMap(s=>{const span=interval(a,b,s.points);return span?[{s,span}]:[];}),localJoins=joins.filter(j=>j.row===row&&j.side===(side===0?'left':'right'));for(const j of localJoins)assert.deepEqual(j.newBank,j.interval.map(u=>at(a,b,u)),'Native side join attached to the wrong actual source boundary');const cuts=[...new Set([0,1,...hits.flatMap(h=>[...h.span]),...localJoins.flatMap(j=>j.interval)])].sort((a,b)=>a-b);
  for(let i=1;i<cuts.length;i++){const lo=cuts[i-1]!,hi=cuts[i]!,mid=(lo+hi)/2,A=at(a,b,lo),B=at(a,b,hi);
   if(A[0]===B[0]&&A[2]===B[2]){nonArea.push({side:side===0?'left':'right',row,rawInterval:[lo,hi],encodedPoints:[A,B],status:'EXACT_ZERO_ENCODED_XZ_INTERVAL_NO_SKIN_AREA_AUTHORITY'});continue;}
   const active=hits.filter(h=>h.span[0]<=mid&&h.span[1]>=mid).sort((a,b)=>(a.s.tag==='road:asphalt'?1:0)-(b.s.tag==='road:asphalt'?1:0)||a.s.source.triangle-b.s.source.triangle),top=active[0];
   const join=!top?localJoins.find(j=>j.interval[0]<=lo&&j.interval[1]>=hi):undefined;
   if(!top&&!join){missing.push({side:side===0?'left':'right',row,a,b,interval:[lo,hi],sourceAxis:profile.centres.map(c=>c.sourceNode)});continue;}
   const edgePoint=(u:number):Vec3=>{assert.ok(join);const s=joinedSources.get(join)!,v=(u-join.interval[0])/(join.interval[1]-join.interval[0]),t=join.parameters[0]+(join.parameters[1]-join.parameters[0])*v;return at(s.points[join.edge],s.points[(join.edge+1)%3]!,t);};
   const C:Vec3=top?[B[0],Math.fround(height(top.s.points,B[0],B[2])),B[2]]:edgePoint(hi),D:Vec3=top?[A[0],Math.fround(height(top.s.points,A[0],A[2])),A[2]]:edgePoint(lo);
   const record={side:side===0?'left':'right',row,interval:[lo,hi],newBank:[A,B],literalOldBank:[D,C],source:top?.s.source??join!.source,oldBankInterpolation:top?'literal selected decoded source plane':'literal pinned decoded source-edge parameters',sourceNativeJoin:join??null,newSkinUv:'authored concrete repeat; no original skin UV claim'};inventory.push(record);
   if(A.join(',')===D.join(',')&&B.join(',')===C.join(','))continue;
   const length=Math.hypot(B[0]-A[0],B[2]-A[2]);if(length===0){missing.push({...record,reason:'Float32 side skin interval collapsed'});continue;}
   for(const P of[[A,B,C],[A,C,D],[A,C,B],[A,D,C]]as[Vec3,Vec3,Vec3][]){const[u,v,w]=P,U=v.map((n,i)=>n-u[i]!),V=w.map((n,i)=>n-u[i]!),normal=[U[1]!*V[2]!-U[2]!*V[1]!,U[2]!*V[0]!-U[0]!*V[2]!,U[0]!*V[1]!-U[1]!*V[0]!];if(Math.hypot(...normal)===0)continue;faces.push({points:P,uvs:P.map(p=>[Math.hypot(p[0]-A[0],p[2]-A[2])/4,p[1]/4])as BridgeFace['uvs'],material:'concrete',role:'curb',collision:true});}
  }
 }
 return{faces,proof:{id:profile.id,sourceBoundaryIntervals:inventory.length,missingBankIntervals:missing,nonAreaSourceIntervals:nonArea,inventory,newHorizontalFloorAddedBySkin:false,bothWindingsRetained:true}};
}
export function buildJunctionSideSkins(profile:JunctionTravelProfile,sources:readonly JunctionFloorSource[],joins:readonly JunctionSideEdgeJoin[]=[]){const result=censusJunctionSideSkins(profile,sources,joins);assert.equal(result.proof.missingBankIntervals.length,0,'Junction side boundary has missing actual decoded upper-bank intervals: '+JSON.stringify(result.proof.missingBankIntervals));return result;}

/** Complete perimeter of the ACTUAL source-domain floor, including median
 * boundaries and both decoded end banks. A mathematical chart side has no
 * skin/cut authority when it does not coincide with this emitted perimeter. */
export function censusJunctionDomainSkins(floorFaces:readonly BridgeFace[],sources:readonly JunctionFloorWitness[],joins:readonly JunctionSideEdgeJoin[]=[]){
 const perimeter=junctionFloorPerimeter(floorFaces),faces:BridgeFace[]=[],inventory:unknown[]=[],missing:unknown[]=[];
 for(const s of sources)assert.equal(junctionFaceSha(s.points),s.source.orderedFloat32Sha256);
 for(const j of joins){assert.equal(j.side,'domain');const s=sources.find(s=>s.source.cell===j.source.cell&&s.source.collider===j.source.collider&&s.source.triangle===j.source.triangle);assert.ok(s,'Domain join references an unrelated/lower floor');assert.deepEqual(j.source,s.source);assert.ok(j.parameters.every(u=>u>=0&&u<=1));assert.ok(j.interval[0]>=0&&j.interval[1]<=1&&j.interval[0]<j.interval[1]);assert.deepEqual(j.literalOldBank,j.parameters.map(u=>at(s.points[j.edge],s.points[(j.edge+1)%3]!,u)));const error=Math.max(...j.newBank.map((p,i)=>Math.hypot(p[0]-j.literalOldBank[i]![0],p[2]-j.literalOldBank[i]![2])));assert.equal(error,j.maximumLateralMetres);assert.ok(error<=.002,'Domain skin join exceeds the source/native construction bound');}
 for(const[index,[a,b]]of perimeter.edges.entries()){
  const hits=sources.flatMap(s=>{const span=interval(a,b,s.points);return span?[{s,span}]:[];}),local=joins.filter(j=>j.row===index+1);for(const j of local)assert.deepEqual(j.newBank,j.interval.map(u=>at(a,b,u)),'Domain skin attached to a different actual floor edge');const cuts=[...new Set([0,1,...hits.flatMap(h=>[...h.span]),...local.flatMap(j=>j.interval)])].sort((a,b)=>a-b);
  for(let i=1;i<cuts.length;i++){const lo=cuts[i-1]!,hi=cuts[i]!,mid=(lo+hi)/2,A=at(a,b,lo),B=at(a,b,hi);if(A[0]===B[0]&&A[2]===B[2])continue;const top=hits.filter(h=>h.span[0]<=mid&&h.span[1]>=mid).sort((a,b)=>(a.s.tag==='road:asphalt'?1:0)-(b.s.tag==='road:asphalt'?1:0)||a.s.source.triangle-b.s.source.triangle)[0],join=!top?local.find(j=>j.interval[0]<=lo&&j.interval[1]>=hi):undefined;
   if(!top&&!join){missing.push({side:'domain',row:index+1,interval:[lo,hi],a,b});continue;}
   const old=(u:number,p:Vec3):Vec3=>{if(top)return[p[0],Math.fround(height(top.s.points,p[0],p[2])),p[2]];assert.ok(join);const s=sources.find(s=>s.source.cell===join.source.cell&&s.source.collider===join.source.collider&&s.source.triangle===join.source.triangle)!,v=(u-join.interval[0])/(join.interval[1]-join.interval[0]);return at(s.points[join.edge],s.points[(join.edge+1)%3]!,join.parameters[0]+(join.parameters[1]-join.parameters[0])*v);},C=old(hi,B),D=old(lo,A);inventory.push({side:'domain',row:index+1,interval:[lo,hi],newBank:[A,B],literalOldBank:[D,C],source:top?.s.source??join!.source,sourceNativeJoin:join??null,newSkinUv:'authored concrete repeat; no original skin UV claim'});
   for(const P of[[A,B,C],[A,C,D],[A,C,B],[A,D,C]] as [Vec3,Vec3,Vec3][]){const[u,v,w]=P,U=v.map((n,i)=>n-u[i]!),V=w.map((n,i)=>n-u[i]!),normal=[U[1]!*V[2]!-U[2]!*V[1]!,U[2]!*V[0]!-U[0]!*V[2]!,U[0]!*V[1]!-U[1]!*V[0]!];if(Math.hypot(...normal)===0)continue;faces.push({points:P,uvs:P.map(p=>[Math.hypot(p[0]-A[0],p[2]-A[2])/4,p[1]/4])as BridgeFace['uvs'],material:'concrete',role:'curb',collision:true});}
  }
 }
 return{faces,proof:{id:'actual-source-domain',...perimeter.proof,sourceBoundaryIntervals:inventory.length,missingBankIntervals:missing,inventory,newHorizontalFloorAddedBySkin:false,bothWindingsRetained:true}};
}
export function buildJunctionDomainSkins(floorFaces:readonly BridgeFace[],sources:readonly JunctionFloorWitness[],joins:readonly JunctionSideEdgeJoin[]=[]){const result=censusJunctionDomainSkins(floorFaces,sources,joins);assert.equal(result.proof.missingBankIntervals.length,0,'Complete source-domain perimeter has missing actual upper banks: '+JSON.stringify(result.proof.missingBankIntervals));return result;}
