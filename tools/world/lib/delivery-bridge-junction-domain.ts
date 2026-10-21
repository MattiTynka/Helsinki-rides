import assert from 'node:assert/strict';
import polygonClipping from 'polygon-clipping';
import earcut from 'earcut';
import type {BridgeFace} from './bridge-reconstruction.ts';
import type {Vec3} from '../../../packages/world-schema/src/index.ts';
import type {SupportTriangle} from './tram-support-repair.ts';

/** A median cannot acquire ROAD authority from a parameter chart between
 * two real native banks. Emit only the named source carriageway union. */
export function censusJunctionCarriagewayFloor(faces:readonly BridgeFace[],domain:polygonClipping.MultiPolygon){
 assert.ok(domain.length);const result:BridgeFace[]=[],collapsed:unknown[]=[],nonAreaSourceComponents:unknown[]=[];let maximumSourceQuantizationMetres=0,encodedPositiveArea=0,emittedPositiveArea=0;
 for(const [sourceTriangle,face]of faces.entries()){
  assert.equal(face.role,'road');const p=face.points,clip=polygonClipping.intersection([p.map(p=>[p[0],p[2]] as [number,number])],domain);
  const[a,b,c]=p,det=(b[0]-a[0])*(c[2]-a[2])-(b[2]-a[2])*(c[0]-a[0]);assert.notEqual(det,0);
  // Quantize the horizontal coordinate before evaluating this literal chart
  // plane: the SAME encoded XZ must not retain two height roundings from two
  // unrepresentable pre-export points a few nanometres apart.
  const at=(rawX:number,rawZ:number):Vec3=>{const x=Math.fround(rawX),z=Math.fround(rawZ),v=((x-a[0])*(c[2]-a[2])-(z-a[2])*(c[0]-a[0]))/det,w=((b[0]-a[0])*(z-a[2])-(b[2]-a[2])*(x-a[0]))/det;return[x,Math.fround(a[1]+v*(b[1]-a[1])+w*(c[1]-a[1])),z];};
  for(const [polygonIndex,polygon]of clip.entries()){
   const rings=polygon.map(raw=>{const vertices=raw.slice(0,-1).map(([x,z])=>{const p=at(x,z);maximumSourceQuantizationMetres=Math.max(maximumSourceQuantizationMetres,Math.hypot(p[0]-x,p[2]-z));return p;});let changed=true;while(changed&&vertices.length){changed=false;for(let i=0;i<vertices.length;i++){const a=vertices[(i+vertices.length-1)%vertices.length]!,b=vertices[i]!;if(a[0]===b[0]&&a[2]===b[2]){assert.equal(a[1],b[1],'Two different heights cannot share one encoded floor vertex');vertices.splice(i,1);changed=true;break;}}}return vertices;});
   for(const ring of rings){let changed=true;while(changed&&ring.length>2){changed=false;for(let i=0;i<ring.length;i++){const a=ring[(i+ring.length-1)%ring.length]!,b=ring[i]!,c=ring[(i+1)%ring.length]!;if((b[0]-a[0])*(c[2]-a[2])-(b[2]-a[2])*(c[0]-a[0])===0){ring.splice(i,1);changed=true;break;}}}}
   const area=(ring:readonly Vec3[])=>{if(ring.length<3)return 0;const a=ring[0]!;let twice=0;for(let i=1;i<ring.length-1;i++){const b=ring[i]!,c=ring[i+1]!;twice+=(b[0]-a[0])*(c[2]-a[2])-(b[2]-a[2])*(c[0]-a[0]);}return Math.abs(twice)/2;};
   const outerArea=area(rings[0]!);if(outerArea===0){assert.ok(rings.every(r=>area(r)===0));nonAreaSourceComponents.push({sourceTriangle,polygonIndex,status:'EXACT_ZERO_ENCODED_SOURCE_COMPONENT_NO_FLOOR_MASK_OR_CUT_AUTHORITY',rawPolygon:polygon,encodedRings:rings});continue;}
   const positiveRings=rings.filter((r,i)=>{if(i&&area(r)===0){nonAreaSourceComponents.push({sourceTriangle,polygonIndex,ring:i,status:'EXACT_ZERO_ENCODED_SOURCE_HOLE',rawRing:polygon[i],encodedRing:r});return false;}return true;}),expected=outerArea-positiveRings.slice(1).reduce((n,r)=>n+area(r),0);assert.ok(expected>0,'Encoded source polygon has no positive road area');
   const vertices=positiveRings.flat(),coordinates:number[]=[],holes:number[]=[];positiveRings.forEach((ring,i)=>{if(i)holes.push(coordinates.length/2);for(const p of ring)coordinates.push(p[0],p[2]);});const ids=earcut(coordinates,holes);let actual=0;
   for(let i=0;i<ids.length;i+=3){const points=ids.slice(i,i+3).map(k=>vertices[k]!) as SupportTriangle,[A,B,C]=points,ny=(B[2]-A[2])*(C[0]-A[0])-(B[0]-A[0])*(C[2]-A[2]);if(ny===0){collapsed.push({sourceTriangle,polygonIndex,points});continue;}actual+=Math.abs(ny)/2;if(ny<0)[points[1],points[2]]=[points[2],points[1]];result.push({...face,points,uvs:points.map(p=>[Math.fround(p[0]/6),Math.fround(-p[2]/6)]) as BridgeFace['uvs']});}
   assert.equal(actual,expected,'Triangulation lost a positive ENCODED source area: '+JSON.stringify({sourceTriangle,polygonIndex,polygon,positiveRings,expected,actual}));encodedPositiveArea+=expected;emittedPositiveArea+=actual;
  }
 }
 return{faces:result,proof:{sourceDomainClipped:true,sourceChartTriangles:faces.length,emittedCarriagewayTriangles:result.length,medianChartHasNoFloorAuthority:true,maximumSourceQuantizationMetres,encodedPositiveArea,emittedPositiveArea,allPositiveEncodedSourceAreaRetained:encodedPositiveArea===emittedPositiveArea,nonAreaSourceComponents,collapsedPositiveFragments:collapsed}};
}
export function clipJunctionCarriagewayFloor(faces:readonly BridgeFace[],domain:polygonClipping.MultiPolygon){const result=censusJunctionCarriagewayFloor(faces,domain);assert.equal(result.proof.collapsedPositiveFragments.length,0,'Positive source-domain fragments collapsed after Float32 export: '+JSON.stringify(result.proof.collapsedPositiveFragments.slice(0,4)));return result;}
