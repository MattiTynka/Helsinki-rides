// Restore only source terrain which the explicitly excluded upper Silta outline
// removed. Retained lower streets own their complete footprints and heights.
import assert from 'node:assert/strict';
import earcut from 'earcut';
import polygonClipping from 'polygon-clipping';
import {supportHeight,supportNormal,type SupportTriangle,type SupportVertex} from './tram-support-repair.ts';
import type {ExtraBridgeNativeFace} from './delivery-extra-bridges-source.ts';
import type {ExtraBridgeFace} from './delivery-extra-bridges-mesh.ts';
type Point=[number,number];
type Box=[number,number,number,number];
const box=(p:SupportTriangle):Box=>[Math.min(...p.map(q=>q[0])),Math.min(...p.map(q=>q[2])),Math.max(...p.map(q=>q[0])),Math.max(...p.map(q=>q[2]))];
const overlap=(a:Box,b:Box)=>a[0]<=b[2]&&a[2]>=b[0]&&a[1]<=b[3]&&a[3]>=b[1];
const area=(p:SupportTriangle)=>Math.abs((p[1][0]-p[0][0])*(p[2][2]-p[0][2])-(p[1][2]-p[0][2])*(p[2][0]-p[0][0]))/2;
function inside(p:SupportTriangle,q:Point,tolerance=.00008){
  const[a,b,c]=p,D=(b[2]-c[2])*(a[0]-c[0])+(c[0]-b[0])*(a[2]-c[2]);if(Math.abs(D)<1e-12)return false;
  const u=((b[2]-c[2])*(q[0]-c[0])+(c[0]-b[0])*(q[1]-c[2]))/D,v=((c[2]-a[2])*(q[0]-c[0])+(a[0]-c[0])*(q[1]-c[2]))/D;
  const perimeter=Math.max(Math.hypot(a[0]-b[0],a[2]-b[2]),Math.hypot(b[0]-c[0],b[2]-c[2]),Math.hypot(c[0]-a[0],c[2]-a[2]));return Math.min(u,v,1-u-v)>=-tolerance*perimeter/Math.abs(D);
}
function lineCuts(a:Point,b:Point,c:Point,d:Point){
  const dx=b[0]-a[0],dz=b[1]-a[1],ex=d[0]-c[0],ez=d[1]-c[1],D=dx*ez-dz*ex,L2=dx*dx+dz*dz;if(L2<1e-16)return[];
  if(Math.abs(D)<1e-10){if(Math.abs(dx*(c[1]-a[1])-dz*(c[0]-a[0]))/Math.sqrt(L2)>.00008)return[];return[c,d].map(p=>((p[0]-a[0])*dx+(p[1]-a[1])*dz)/L2).filter(t=>t>1e-7&&t<1-1e-7);}
  const px=c[0]-a[0],pz=c[1]-a[1],u=(px*ez-pz*ex)/D,v=(px*dz-pz*dx)/D;return u>1e-7&&u<1-1e-7&&v>=-1e-7&&v<=1+1e-7?[u]:[];
}
export interface ExtraBridgeEarthRecovery {
  schemaVersion:1;kind:'native-omitted-silta-fallback-source-v1';partIds:number[];
  source:{nativeMetadataSha256:string;replaySha256:string;originalStreetPartsSha256:string;sourceTerrainSha256:string;frozenProducer:Record<string,string>;shadowChangedSubtypesOnly:true};
  triangles:SupportTriangle[];
}
export function buildExtraBridgeEarth(options:{source:ExtraBridgeEarthRecovery;footprints:{id:number;rings:Point[][]}[];retained:readonly ExtraBridgeNativeFace[];upperFloors:readonly SupportTriangle[]}){
  const{source,footprints}=options;assert.equal(source.schemaVersion,1);assert.equal(source.kind,'native-omitted-silta-fallback-source-v1');assert.ok(source.triangles.length>0&&source.triangles.length<10000);
  assert.deepEqual([...source.partIds].sort((a,b)=>a-b),footprints.map(p=>p.id).sort((a,b)=>a-b));assert.equal(source.source.shadowChangedSubtypesOnly,true);for(const h of[source.source.nativeMetadataSha256,source.source.replaySha256,source.source.originalStreetPartsSha256,source.source.sourceTerrainSha256,...Object.values(source.source.frozenProducer)])assert.match(h,/^[a-f0-9]{64}$/);
  const domains=footprints.map(p=>p.rings),domain=polygonClipping.union(domains[0]!,...domains.slice(1)),retained=options.retained.filter(f=>f.group==='ground'&&!f.tag.endsWith(':bridge-reconstruction')&&area(f.points)>1e-8).map(f=>({...f,box:box(f.points)}));
  const raw:{triangle:SupportTriangle;source:SupportTriangle}[]=[];let recoveredArea=0;
  for(const T of source.triangles){assert.ok(T.flat().every(Number.isFinite)&&area(T)>1e-8);let clipped=polygonClipping.intersection([[T.map(q=>[q[0],q[2]]as Point)]],domain);if(!clipped.length)continue;const nearby=retained.filter(f=>overlap(box(T),f.box));if(nearby.length)clipped=polygonClipping.difference(clipped,...nearby.map(f=>[f.points.map(q=>[q[0],q[2]]as Point)]));
    for(const polygon of clipped){const flat:number[]=[],holes:number[]=[];for(const[i,ring]of polygon.entries()){if(i)holes.push(flat.length/2);for(const q of ring)flat.push(...q);}const I=earcut(flat,holes);for(let i=0;i<I.length;i+=3){const triangle=I.slice(i,i+3).map(k=>[flat[k*2]!,supportHeight(T,[flat[k*2]!,flat[k*2+1]!]),flat[k*2+1]!])as SupportTriangle;if(area(triangle)>1e-8){raw.push({triangle,source:T});recoveredArea+=area(triangle);}}}
  }
  assert.ok(raw.length>0,'No omitted source terrain remains to recover');
  const allKnots=raw.flatMap(f=>f.triangle.map(p=>[p[0],p[2]]as Point));
  const nativeEdges=retained.flatMap(f=>[0,1,2].map(k=>[[f.points[k]![0],f.points[k]![2]],[f.points[(k+1)%3]![0],f.points[(k+1)%3]![2]]]as[Point,Point]));
  const collapsedProjectedTriangles:{points:SupportTriangle;sourceArea:number}[]=[],faces:ExtraBridgeFace[]=[],verticalReturns:{points:SupportTriangle;lowerSide:Point;outwardDot:number}[]=[],boundaryIntervals:{a:SupportVertex;b:SupportVertex;maximumError:number;cell:string;collider:string;triangle:number}[]=[],boundaryWitnesses:{point:SupportVertex;before:number;native:number;cell:string;collider:string;triangle:number}[]=[];
  const nativeAt=(q:Point,tolerance=.00008)=>retained.filter(f=>q[0]>=f.box[0]-tolerance&&q[0]<=f.box[2]+tolerance&&q[1]>=f.box[1]-tolerance&&q[1]<=f.box[3]+tolerance&&inside(f.points,q,tolerance)).sort((a,b)=>supportHeight(b.points,q)-supportHeight(a.points,q));
  const point=(q:Point,T:SupportTriangle,owner?:typeof retained[number]):SupportVertex=>{
    const xy=q.map(Math.fround)as Point,before=supportHeight(T,xy),height=owner?supportHeight(owner.points,xy):before,P=[xy[0],Math.fround(height),xy[1]]as SupportVertex;
    if(owner)boundaryWitnesses.push({point:P,before,native:height,cell:owner.cell,collider:owner.collider,triangle:owner.triangle});return P;
  };
  const emit=(T:SupportTriangle,lowerSide?:Point,sourceDomain?:SupportTriangle)=>{
    let normal:SupportVertex;try{normal=supportNormal(T);}catch{return;}
    if(lowerSide){
      const centre:Point=[T.reduce((n,p)=>n+p[0],0)/3,T.reduce((n,p)=>n+p[2],0)/3];let dot=normal[0]*(lowerSide[0]-centre[0])+normal[2]*(lowerSide[1]-centre[1]);
      if(Math.abs(dot)<=1e-12){
        // A sub-ULP source fan can round onto its own outer edge. Its source
        // domain must lie wholly on one side; that exact half-space, rather
        // than an arbitrary camera or double-sided material, owns the exterior.
        assert.ok(sourceDomain);const sides=sourceDomain.map(p=>normal[0]*(p[0]-centre[0])+normal[2]*(p[2]-centre[1]));assert.ok(sides.every(v=>v>=-1e-10)||sides.every(v=>v<=1e-10),'Ambiguous collapsed source fan exterior');const inside=sides.reduce((a,b)=>Math.abs(a)>Math.abs(b)?a:b);assert.ok(Math.abs(inside)>1e-12,'Zero-area source domain has no physical exterior');dot=-inside;
      }
      if(dot<0){T=[T[0],T[2],T[1]];normal=supportNormal(T);}verticalReturns.push({points:T,lowerSide,outwardDot:Math.abs(dot)});
    }
    else if(normal[1]<0)T=[T[0],T[2],T[1]];
    for(const p of T){const floors=options.upperFloors.filter(f=>inside(f,[p[0],p[2]]));assert.ok(floors.length,'Recovered terrain escaped the authored upper source footprint');const upper=Math.max(...floors.map(f=>supportHeight(f,[p[0],p[2]])));assert.ok(p[1]<=upper+.001,'Pinned source terrain protrudes through the authored upper floor');}
    faces.push({points:T,role:'bank',material:'concrete',collision:true,sourcePartIds:source.partIds,colour:[.27,.26,.23],uvs:T.map(p=>[p[0]/4,p[2]/4])as ExtraBridgeFace['uvs']});
  };
  for(const r of raw){
    const rounded=r.triangle.map(p=>p.map(Math.fround))as SupportTriangle;if(area(rounded)<1e-8){collapsedProjectedTriangles.push({points:rounded,sourceArea:area(r.triangle)});continue;}
    const segments:{a:SupportVertex;b:SupportVertex;rawA:Point;rawB:Point}[]=[];
    for(let k=0;k<3;k++){
      const a=r.triangle[k]!,b=r.triangle[(k+1)%3]!,A:Point=[a[0],a[2]],B:Point=[b[0],b[2]],dx=B[0]-A[0],dz=B[1]-A[1],L2=dx*dx+dz*dz,cuts=[0,1];
      for(const[c,d]of nativeEdges)cuts.push(...lineCuts(A,B,c,d));
      for(const q of allKnots){const t=((q[0]-A[0])*dx+(q[1]-A[1])*dz)/L2;if(t>1e-7&&t<1-1e-7&&Math.abs(dx*(q[1]-A[1])-dz*(q[0]-A[0]))/Math.sqrt(L2)<.000001)cuts.push(t);}
      cuts.sort((a,b)=>a-b);const E=cuts.filter((q,i)=>!i||q-cuts[i-1]!>1e-7),at=(t:number)=>[A[0]+dx*t,A[1]+dz*t]as Point;
      // An overlapping native floor envelope can switch planes inside an
      // interval even when no triangle edge crosses it. Preserve that knot too.
      for(let i=1;i<E.length;i++){const lo=E[i-1]!,hi=E[i]!,active=nativeAt(at((lo+hi)/2),.000001);for(let a=0;a<active.length;a++)for(let b=a+1;b<active.length;b++){const delta=(t:number)=>supportHeight(active[a]!.points,at(t))-supportHeight(active[b]!.points,at(t)),u=delta(lo),v=delta(hi);if(u*v<0)cuts.push(lo+(hi-lo)*u/(u-v));}}
      cuts.sort((a,b)=>a-b);const U=cuts.filter((q,i)=>!i||q-cuts[i-1]!>1e-7);
      for(let i=1;i<U.length;i++){
        const lo=U[i-1]!,hi=U[i]!,mid=at((lo+hi)/2),owner=nativeAt(mid)[0],P=point(at(lo),r.source,owner),Q=point(at(hi),r.source,owner);
        if(P[0]===Q[0]&&P[2]===Q[2])continue;
        if(owner){const test:Point=[(P[0]+Q[0])/2,(P[2]+Q[2])/2],error=Math.abs((P[1]+Q[1])/2-supportHeight(owner.points,test));assert.ok(error<.0001,'Source bank must follow the complete actual boundary plane');boundaryIntervals.push({a:P,b:Q,maximumError:error,cell:owner.cell,collider:owner.collider,triangle:owner.triangle});}
        segments.push({a:P,b:Q,rawA:at(lo),rawB:at(hi)});
      }
    }
    const q:Point=[r.triangle.reduce((n,p)=>n+p[0],0)/3,r.triangle.reduce((n,p)=>n+p[2],0)/3],centre=point(q,r.source);
    for(let i=0;i<segments.length;i++){
      const edge=segments[i]!,next=segments[(i+1)%segments.length]!;emit([centre,edge.a,edge.b]);
      // Existing curbs may have two distinct real heights at the same boundary
      // XZ. Retain both endpoints and close their source-bound vertical return.
      if(edge.b[0]===next.a[0]&&edge.b[2]===next.a[2]&&edge.b[1]!==next.a[1]){
        const lower=edge.b[1]>next.a[1]?next.rawB:edge.rawA;emit([centre,edge.b,next.a],lower,r.triangle);
      }
    }
  }
  assert.ok(collapsedProjectedTriangles.reduce((n,t)=>n+t.sourceArea,0)<.01,'Unrepresentable Float32 fragments exceed the bounded source-roundoff area');
  const maxC0=Math.max(...boundaryIntervals.map(q=>q.maximumError));assert.ok(boundaryIntervals.length>0&&maxC0<.0001);
  return{faces,proof:{kind:source.kind,sourceParts:source.partIds,sourceTriangles:source.triangles.length,recoveredArea,triangles:faces.length,retainedFloorTriangles:retained.length,boundaryWitnesses,boundaryIntervals,verticalReturns,collapsedProjectedTriangles,maximumC0ErrorMetres:maxC0,maximumSourceBoundaryAdjustmentMetres:Math.max(...boundaryWitnesses.map(w=>Math.abs(w.before-w.native))),retainedNativeFloorsUnchanged:true,interiorSourceFieldRetained:true,method:'Subtract all retained native lower floor projections, restore only the exact omitted Silta fallback domain, retain replay interior heights and insert every real native boundary knot before joining the bank.'}};
}
