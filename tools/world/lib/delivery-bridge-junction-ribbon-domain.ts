import assert from 'node:assert/strict';
import polygonClipping from 'polygon-clipping';
import earcut from 'earcut';
import type {BridgeFace} from './bridge-reconstruction.ts';
import type {Vec3} from '../../../packages/world-schema/src/index.ts';
import {buildJunctionTravelProfile,type JunctionTravelProfile} from './delivery-bridge-junction-profile.ts';
import {auditJunctionDomainFaces} from './delivery-bridge-junction-domain-audit.ts';
import {fitJunctionFloorYEncoding} from './delivery-bridge-junction-y-encoding.ts';
import {retessellateJunctionRibbon} from './delivery-bridge-junction-ribbon-topology.ts';
import {clipConformingRibbonDomains} from './delivery-bridge-junction-ribbon-conformance.ts';

/** Clip the already encoded piecewise planar source-width floor. Re-evaluating
 * a different height chart on these boundaries would change its physical
 * planes, particularly at a source width notch. */
export function clipJunctionRibbonDomain(profile:JunctionTravelProfile,ribbon:readonly BridgeFace[],domain:polygonClipping.MultiPolygon){
 const conforming=clipConformingRibbonDomains(ribbon,domain),faces:BridgeFace[]=[],pinnedPlanes:BridgeFace[]=[],cache=new Map<string,Vec3>(),nonAreaSourceComponents:unknown[]=[];let maximumSourceQuantizationMetres=conforming.proof.maximumSourceQuantizationMetres,maximumEncodedPlaneDifferenceMetres=0,encodedPositiveArea=0,emittedPositiveArea=0;
 const area=(R:readonly Vec3[])=>{const a=R[0]!;let sum=0;for(let i=1;i+1<R.length;i++){const b=R[i]!,c=R[i+1]!;sum+=(b[0]-a[0])*(c[2]-a[2])-(b[2]-a[2])*(c[0]-a[0]);}return Math.abs(sum)/2;};
 for(const[sourceTriangle,source]of ribbon.entries()){
  const[a,b,c]=source.points,det=(b[0]-a[0])*(c[2]-a[2])-(b[2]-a[2])*(c[0]-a[0]);assert.notEqual(det,0);
  const height=(x:number,z:number)=>{const u=((x-a[0])*(c[2]-a[2])-(z-a[2])*(c[0]-a[0]))/det,v=((b[0]-a[0])*(z-a[2])-(b[2]-a[2])*(x-a[0]))/det;return a[1]+u*(b[1]-a[1])+v*(c[1]-a[1]);},polygons=conforming.rows[sourceTriangle]!;
  for(const[polygonIndex,polygon]of polygons.entries()){
   const rings=polygon.map(R=>{const ring=R.slice(0,-1).map(([rawX,rawZ])=>{const x=Math.fround(rawX),z=Math.fround(rawZ),key=`${x},${z}`;maximumSourceQuantizationMetres=Math.max(maximumSourceQuantizationMetres,Math.hypot(x-rawX,z-rawZ));let point=cache.get(key);if(!point){point=[x,source.points.find(p=>p[0]===x&&p[2]===z)?.[1]??Math.fround(height(x,z)),z];cache.set(key,point);}maximumEncodedPlaneDifferenceMetres=Math.max(maximumEncodedPlaneDifferenceMetres,Math.abs(point[1]-height(x,z)));return point;});let changed=true;while(changed&&ring.length>2){changed=false;for(let i=0;i<ring.length;i++){const a=ring[(i+ring.length-1)%ring.length]!,b=ring[i]!,c=ring[(i+1)%ring.length]!;if(b[0]===a[0]&&b[2]===a[2]||(b[0]-a[0])*(c[2]-a[2])-(b[2]-a[2])*(c[0]-a[0])===0){ring.splice(i,1);changed=true;break;}}}return ring;});
   if(area(rings[0]!)===0){assert.ok(rings.every(r=>area(r)===0));nonAreaSourceComponents.push({sourceTriangle,polygonIndex,rawPolygon:polygon,encodedRings:rings,status:'EXACT_ZERO_ENCODED_SOURCE_COMPONENT_NO_FLOOR_MASK_OR_CUT_AUTHORITY'});continue;}
   const positive=rings.filter((R,i)=>{if(i&&area(R)===0){nonAreaSourceComponents.push({sourceTriangle,polygonIndex,ring:i,status:'EXACT_ZERO_ENCODED_SOURCE_HOLE',rawRing:polygon[i],encodedRing:R});return false;}return true;}),points=positive.flat(),xy:number[]=[],holes:number[]=[];positive.forEach((R,i)=>{if(i)holes.push(xy.length/2);R.forEach(p=>xy.push(p[0],p[2]));});const indices=earcut(xy,holes),expected=area(positive[0]!)-positive.slice(1).reduce((n,R)=>n+area(R),0);let actual=0;
   for(let i=0;i<indices.length;i+=3){const P=indices.slice(i,i+3).map(k=>points[k]!)as[Vec3,Vec3,Vec3],[a,b,c]=P,ny=(b[2]-a[2])*(c[0]-a[0])-(b[0]-a[0])*(c[2]-a[2]);assert.notEqual(ny,0,'A positive encoded ribbon domain collapsed');actual+=Math.abs(ny)/2;if(ny<0)[P[1],P[2]]=[P[2],P[1]];faces.push({...source,points:P,uvs:P.map(p=>[Math.fround(p[0]/6),Math.fround(-p[2]/6)])as BridgeFace['uvs']});pinnedPlanes.push(source);}
   assert.equal(actual,expected,'Source ribbon clipping lost positive encoded area');encodedPositiveArea+=expected;emittedPositiveArea+=actual;
  }
 }
 assert.ok(maximumSourceQuantizationMetres<=.00008,'Source encoding exceeds the existing 80 micrometre bound');assert.ok(maximumEncodedPlaneDifferenceMetres<=.001,'Encoded floor changed its original approved ribbon plane');
 const ramp=buildJunctionTravelProfile(profile,.5),topology=retessellateJunctionRibbon(faces,pinnedPlanes),fit=fitJunctionFloorYEncoding(profile,topology.faces,topology.pinnedPlanes,ramp.proof.sourceBankTransverseEnvelope+ramp.proof.maximumTransverseQuantizationBound);
 return{faces:fit.faces,proof:{kind:'EXACT_SOURCE_UNION_CLIPPED_ENCODED_SOURCE_WIDTH_RIBBON',maximumSourceQuantizationMetres,maximumEncodedPlaneDifferenceMetres,encodedPositiveArea,emittedPositiveArea,allPositiveEncodedSourceAreaRetained:encodedPositiveArea===emittedPositiveArea,nonAreaSourceComponents,authoredTriangles:faces.length,sharedEdgeConformance:conforming.proof,positiveAreaTopology:topology.proof,authoredYEncoding:fit.proof,emittedGrade:auditJunctionDomainFaces(profile,fit.faces)}};
}
