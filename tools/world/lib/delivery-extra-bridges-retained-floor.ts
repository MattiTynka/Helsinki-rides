// Recover an individually pinned native lower surface after an upper bridge cut.
// A coincident upper floor never substitutes for the source's lower level.
import assert from 'node:assert/strict';
import earcut from 'earcut';
import polygonClipping from 'polygon-clipping';
import {supportHeight,type SupportTriangle} from './tram-support-repair.ts';
import type {ExtraBridgeNativeFace} from './delivery-extra-bridges-source.ts';
import {pointInPolygon,ringDistance,segmentDistance} from './geometry.ts';
type Point=[number,number];
const area=(p:SupportTriangle)=>Math.abs((p[1][0]-p[0][0])*(p[2][2]-p[0][2])-(p[1][2]-p[0][2])*(p[2][0]-p[0][0]))/2;
const projected=(p:SupportTriangle)=>[p.map(q=>[q[0],q[2]]as Point)];
const overlaps=(a:SupportTriangle,b:SupportTriangle)=>Math.min(...a.map(p=>p[0]))<=Math.max(...b.map(p=>p[0]))&&Math.max(...a.map(p=>p[0]))>=Math.min(...b.map(p=>p[0]))&&Math.min(...a.map(p=>p[2]))<=Math.max(...b.map(p=>p[2]))&&Math.max(...a.map(p=>p[2]))>=Math.min(...b.map(p=>p[2]));
export interface RestoredNativeLowerFace {points:SupportTriangle;source:ExtraBridgeNativeFace}
/** Exact native kerb discontinuities can be open in the original authored mesh.
 * Close only a reviewed parking boundary, joining its real lower and raised
 * planes. This never manufactures a horizontal surface or joins an upper deck. */
export function closeNativeLowerKerbEdges(options:{restored:readonly RestoredNativeLowerFace[];retained:readonly ExtraBridgeNativeFace[];domain:Point[][];maximumRise:number;visibleVerticalKeys?:ReadonlySet<string>}){
  assert.ok(options.maximumRise>0&&options.maximumRise<=.25);
  const key=(P:SupportTriangle)=>P.map(p=>p.map(Math.fround).join(',')).sort().join('|');
  const walkable=(P:SupportTriangle)=>{const[a,b,c]=P,u=b.map((v,i)=>v-a[i]!),v=c.map((n,i)=>n-a[i]!),normal=[u[1]!*v[2]!-u[2]!*v[1]!,u[2]!*v[0]!-u[0]!*v[2]!,u[0]!*v[1]!-u[1]!*v[0]!];return normal[1]!>0&&normal[1]!/Math.hypot(...normal)>=.5;};
  const source=options.restored.filter(f=>walkable(f.points)),positive=options.retained.filter(f=>f.group==='ground'&&walkable(f.points)&&f.tag.startsWith('raised:')&&!f.tag.endsWith(':bridge-reconstruction')),vertical=options.retained.filter(f=>area(f.points)<1e-8&&(!options.visibleVerticalKeys||options.visibleVerticalKeys.has(key(f.points))));
  const rows:{points:SupportTriangle;source:ExtraBridgeNativeFace;upperSource:ExtraBridgeNativeFace}[]=[],proofs:any[]=[],boundaryCensus:any[]=[],collapsedNativeReturns:SupportTriangle[]=[],emitted=new Set<string>();
  const inside=(T:SupportTriangle,p:Point,tolerance=0)=>{const[a,b,c]=T,D=(b[2]-c[2])*(a[0]-c[0])+(c[0]-b[0])*(a[2]-c[2]);if(Math.abs(D)<1e-10)return false;const u=((b[2]-c[2])*(p[0]-c[0])+(c[0]-b[0])*(p[1]-c[2]))/D,v=((c[2]-a[2])*(p[0]-c[0])+(a[0]-c[0])*(p[1]-c[2]))/D;return u>=-1e-7&&v>=-1e-7&&u+v<=1+1e-7||tolerance>0&&ringDistance(p,projected(T)[0]!)<=tolerance;};
  // Intersect the one-sided normal ray with the actual native triangle.
  // A fixed two-centimetre probe can jump over a thin triangulated corner.
  // The existing 0.25mm source/native registration allowance stays unchanged.
  const sideProbe=(T:SupportTriangle,p:Point,d:Point):Point|null=>{
    if(!inside(T,p,.00025))return null;
    const[a,b,c]=T,D=(b[2]-c[2])*(a[0]-c[0])+(c[0]-b[0])*(a[2]-c[2]);if(Math.abs(D)<1e-10)return null;
    const weights=(q:Point)=>{const u=((b[2]-c[2])*(q[0]-c[0])+(c[0]-b[0])*(q[1]-c[2]))/D,v=((c[2]-a[2])*(q[0]-c[0])+(a[0]-c[0])*(q[1]-c[2]))/D;return[u,v,1-u-v];},w=weights(p),q=weights([p[0]+d[0],p[1]+d[1]]);let lo=0,hi=Infinity;
    for(let k=0;k<3;k++){const slope=q[k]!-w[k]!;if(Math.abs(slope)<1e-12){if(w[k]!< -1e-10)return null;continue;}const crossing=-w[k]!/slope;if(slope>0)lo=Math.max(lo,crossing);else hi=Math.min(hi,crossing);}
    if(!(hi>lo)||lo>.00025)return null;const t=Math.min(.02,lo+(hi-lo)/2);if(!(t>=lo&&t<=hi))return null;return[p[0]+d[0]*t,p[1]+d[1]*t];
  };
  const boundaries:{a:Point;b:Point;upperSide?:Point;source?:{cell:string;collider:string;triangle:number}}[]=options.domain.flatMap(r=>r.map((a,k)=>({a,b:r[(k+1)%r.length]!}))),nativeEdges=new Map<string,{a:Point;b:Point;upperSide:Point;source:ExtraBridgeNativeFace;triangles:Set<string>}>();
  for(const f of positive)for(let k=0;k<3;k++){const A=f.points[k]!,B=f.points[(k+1)%3]!,edgeKey=[A.join(','),B.join(',')].sort().join('|'),previous=nativeEdges.get(edgeKey);if(previous){previous.triangles.add(key(f.points));continue;}const a:Point=[A[0],A[2]],b:Point=[B[0],B[2]],mid:Point=[(a[0]+b[0])/2,(a[1]+b[1])/2],centre:Point=[f.points.reduce((n,p)=>n+p[0],0)/3,f.points.reduce((n,p)=>n+p[2],0)/3],length=Math.hypot(centre[0]-mid[0],centre[1]-mid[1]);if(length<1e-10)continue;nativeEdges.set(edgeKey,{a,b,upperSide:[(centre[0]-mid[0])/length,(centre[1]-mid[1])/length],source:f,triangles:new Set([key(f.points)])});}
  for(const edge of nativeEdges.values())if(edge.triangles.size===1)boundaries.push({a:edge.a,b:edge.b,upperSide:edge.upperSide,source:{cell:edge.source.cell,collider:edge.source.collider,triangle:edge.source.triangle}});
  const domainEdges=options.domain.flatMap(r=>r.map((a,k)=>({points:[[a[0],0,a[1]],[r[(k+1)%r.length]![0],0,r[(k+1)%r.length]![1]],[a[0],0,a[1]]]as SupportTriangle})));
  for(const boundary of boundaries){
    const a=boundary.a,b=boundary.b,dx=b[0]-a[0],dz=b[1]-a[1],L=Math.hypot(dx,dz);if(L<.0001)continue;const cuts=[0,1];
    for(const g of [...source,...positive,...vertical,...domainEdges])for(let j=0;j<3;j++){
      const c=g.points[j]!,d=g.points[(j+1)%3]!,ex=d[0]-c[0],ez=d[2]-c[2],D=dx*ez-dz*ex;
      if(Math.abs(D)>1e-10){const px=c[0]-a[0],pz=c[2]-a[1],t=(px*ez-pz*ex)/D,u=(px*dz-pz*dx)/D;if(t>1e-7&&t<1-1e-7&&u>=-1e-7&&u<=1+1e-7)cuts.push(t);}
      else for(const q of[c,d]){const t=((q[0]-a[0])*dx+(q[2]-a[1])*dz)/(L*L);if(t>1e-7&&t<1-1e-7&&segmentDistance([q[0],q[2]],a,b).d<.00025)cuts.push(t);}
    }
    cuts.sort((a,b)=>a-b);const C=cuts.filter((v,i)=>!i||v-cuts[i-1]!>1e-7),at=(t:number):Point=>[a[0]+dx*t,a[1]+dz*t];
    for(let j=1;j<C.length;j++){
      const t0=C[j-1]!,t1=C[j]!,mid=at((t0+t1)/2),sides=[[-dz/L,dx/L],[dz/L,-dx/L]],outside=boundary.upperSide??sides.find(n=>!pointInPolygon([mid[0]+n[0]!*.02,mid[1]+n[1]!*.02],options.domain));if(!outside)continue;if(!pointInPolygon(mid,options.domain)&&!options.domain.some(r=>ringDistance(mid,r)<=.00025))continue;
      const innerDirection:Point=[-outside[0]!,-outside[1]!],outerDirection:Point=[outside[0]!,outside[1]!],sources=source.filter(f=>sideProbe(f.points,mid,innerDirection)).sort((a,b)=>supportHeight(b.points,mid)-supportHeight(a.points,mid));
      if(!sources.length){boundaryCensus.push({a:at(t0),b:at(t1),status:'no-native-lower-boundary'});continue;}const lower=sources[0]!,lowY=supportHeight(lower.points,mid);if(boundary.upperSide&&positive.some(g=>{const q=sideProbe(g.points,mid,innerDirection);return q&&supportHeight(g.points,q)>supportHeight(lower.points,q)+.005;})){boundaryCensus.push({a:at(t0),b:at(t1),status:'continuous-raised-floor-on-both-sides'});continue;}const owners=positive.filter(g=>sideProbe(g.points,mid,outerDirection)).sort((a,b)=>supportHeight(b.points,mid)-supportHeight(a.points,mid));
      if(!owners.length){boundaryCensus.push({a:at(t0),b:at(t1),status:'no-adjacent-raised-native-floor'});continue;}const upper=owners[0]!,highY=supportHeight(upper.points,mid),rise=highY-lowY;
      if(rise<=.005){boundaryCensus.push({a:at(t0),b:at(t1),status:'no-positive-kerb-step',rise});continue;}
      if(rise>options.maximumRise){boundaryCensus.push({a:at(t0),b:at(t1),status:'larger-native-structure-not-a-kerb',rise});continue;}
      const existing:[number,number][]=[];
      for(const g of vertical){if(!g.points.every(p=>Math.abs(dx*(p[2]-a[1])-dz*(p[0]-a[0]))/L<.00025))continue;const distances=g.points.map(p=>((p[0]-a[0])*dx+(p[2]-a[1])*dz)/L),target=(t0+t1)/2*L,hits:number[]=[];for(let n=0;n<3;n++){const u=distances[n]!,v=distances[(n+1)%3]!;if(target>=Math.min(u,v)-1e-6&&target<=Math.max(u,v)+1e-6){if(Math.abs(u-v)<1e-10)hits.push(g.points[n]![1],g.points[(n+1)%3]![1]);else hits.push(g.points[n]![1]+(g.points[(n+1)%3]![1]-g.points[n]![1])*(target-u)/(v-u));}}if(hits.length>=2)existing.push([Math.min(...hits),Math.max(...hits)]);}
      existing.sort((a,b)=>a[0]-b[0]);let covered=lowY;for(const q of existing)if(q[0]<=covered+.0001)covered=Math.max(covered,q[1]);
      if(covered>=highY-.0001){boundaryCensus.push({a:at(t0),b:at(t1),status:'literal-visible-native-vertical-coverage',existing});continue;}
      const P=at(t0).map(Math.fround)as Point,Q=at(t1).map(Math.fround)as Point,lowA=[P[0],Math.fround(supportHeight(lower.points,P)),P[1]],lowB=[Q[0],Math.fround(supportHeight(lower.points,Q)),Q[1]],topA=[P[0],Math.fround(supportHeight(upper.points,P)),P[1]],topB=[Q[0],Math.fround(supportHeight(upper.points,Q)),Q[1]],K=[lowA.join(','),lowB.join(','),topA.join(','),topB.join(',')].sort().join('|');if(emitted.has(K))continue;emitted.add(K);
      for(const[lo,hi]of[[lowA,topA],[lowB,topB]])assert.ok(hi![1]!-lo![1]!>0&&hi![1]!-lo![1]!<=options.maximumRise+.0001,'Only a measured ordinary native kerb can close this boundary');
      for(let T of [[lowA,lowB,topB],[lowA,topB,topA]]as SupportTriangle[]){const u=T[1].map((v,i)=>v-T[0][i]!),v=T[2].map((x,i)=>x-T[0][i]!),normal=[u[1]!*v[2]!-u[2]!*v[1]!,u[2]!*v[0]!-u[0]!*v[2]!,u[0]!*v[1]!-u[1]!*v[0]!];if(Math.hypot(...normal)===0){collapsedNativeReturns.push(T);continue;}if(normal[0]!*outside[0]!+normal[2]!*outside[1]!>0)T=[T[0],T[2],T[1]];rows.push({points:T,source:lower.source,upperSource:upper});}
      boundaryCensus.push({a:at(t0),b:at(t1),status:'source-native-kerb-return',nativeBoundary:boundary.source??null});proofs.push({a:lowA,b:lowB,upperA:topA,upperB:topB,source:{cell:lower.source.cell,collider:lower.source.collider,triangle:lower.source.triangle},upperSource:{cell:upper.cell,collider:upper.collider,triangle:upper.triangle},existingNativeVerticalCoverage:existing,maximumRise:Math.max(topA[1]!-lowA[1]!,topB[1]!-lowB[1]!)});
    }
  }
  return{faces:rows,proof:{kind:'exact-source-parking-native-kerb-returns',maximumAllowedRise:options.maximumRise,segments:proofs,boundaryCensus,triangles:rows.length,collapsedNativeReturns,horizontalFloorsChanged:false,upperBridgeFloorsExcluded:true}};
}
export function restoreNativeLowerFloor(options:{source:readonly ExtraBridgeNativeFace[];domain:Point[][];retained:readonly ExtraBridgeNativeFace[];upper:readonly SupportTriangle[];slabThickness:number;minimumHeadroom:number}){
  assert.ok(options.source.length>0&&options.source.length<=10000);assert.ok(options.minimumHeadroom>=2&&options.slabThickness>0);
  const retained=options.retained.filter(f=>f.group==='ground'&&area(f.points)>1e-8),upper=options.upper.filter(p=>area(p)>1e-8),faces:RestoredNativeLowerFace[]=[],clearance:{sourceCell:string;sourceCollider:string;sourceTriangle:number;point:Point;metres:number}[]=[],collapsed:{sourceCell:string;sourceTriangle:number;area:number}[]=[];
  for(const source of options.source){
    assert.equal(source.group,'ground');assert.ok(area(source.points)>1e-8);
    let pieces=polygonClipping.intersection([projected(source.points)],[options.domain]);
    const sameLevel=retained.filter(f=>overlaps(f.points,source.points)&&f.points.every(p=>Math.abs(supportHeight(source.points,[p[0],p[2]])-p[1])<.00008));
    if(sameLevel.length)pieces=polygonClipping.difference(pieces,...sameLevel.map(f=>projected(f.points)));
    for(const polygon of pieces){const flat:number[]=[],holes:number[]=[];for(const[i,ring]of polygon.entries()){if(i)holes.push(flat.length/2);for(const p of ring)flat.push(...p);}const ids=earcut(flat,holes);
      for(let i=0;i<ids.length;i+=3){const P=ids.slice(i,i+3).map(k=>{const x=Math.fround(flat[k*2]!),z=Math.fround(flat[k*2+1]!);return[x,Math.fround(supportHeight(source.points,[x,z])),z];})as SupportTriangle;
        if(area(P)<1e-8){collapsed.push({sourceCell:source.cell,sourceTriangle:source.triangle,area:area(P)});continue;}
        const signed=(T:SupportTriangle)=>(T[1][2]-T[0][2])*(T[2][0]-T[0][0])-(T[1][0]-T[0][0])*(T[2][2]-T[0][2]);
        assert.ok(signed(source.points)>0,'Only an actual upward native source floor can be restored');
        if(signed(P)<0)[P[1],P[2]]=[P[2],P[1]];
        // Complete common-plane overlap vertices, not a centre-point or guessed
        // nearby upper height, establish the slab clearance for each fragment.
        for(const U of upper.filter(U=>overlaps(U,P)))for(const overlap of polygonClipping.intersection([projected(P)],[projected(U)]))for(const ring of overlap)for(const q of ring){const metres=supportHeight(U,q)-options.slabThickness-supportHeight(P,q);assert.ok(metres>=options.minimumHeadroom,`Native lower floor violates actual slab clearance:${metres}`);clearance.push({sourceCell:source.cell,sourceCollider:source.collider,sourceTriangle:source.triangle,point:q,metres});}
        faces.push({points:P,source});
      }
    }
  }
  assert.ok(faces.length>0,'No missing native lower floor to restore');assert.ok(clearance.length>0,'Restoration requires actual overlapping upper deck authority');
  return{faces,proof:{sourceTriangles:options.source.length,restoredTriangles:faces.length,collapsedProjectedFragments:collapsed,minimumHeadroom:options.minimumHeadroom,minimumMeasuredSlabClearance:Math.min(...clearance.map(c=>c.metres)),slabThickness:options.slabThickness,clearance,retainedSameLevelFloorsSubtracted:true,allCurrentFloorsRemainLiteral:true,sourcePlaneHeightsOnly:true}};
}
