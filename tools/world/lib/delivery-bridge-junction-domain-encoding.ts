import assert from 'node:assert/strict';
import polygonClipping from 'polygon-clipping';
type Point=[number,number];
/** Canonicalize the municipal boundary once before any incident floor is
 * clipped. Only exact encoded duplicates/collinear vertices are removed. */
export function encodeJunctionSourceDomain(domain:polygonClipping.MultiPolygon){
 let maximumSourceQuantizationMetres=0;const nonAreaSourceComponents:unknown[]=[],polygons:polygonClipping.Polygon[]=[];
 const twiceArea=(R:Point[])=>{const a=R[0];if(!a)return 0;let n=0;for(let i=1;i+1<R.length;i++)n+=(R[i]![0]-a[0])*(R[i+1]![1]-a[1])-(R[i]![1]-a[1])*(R[i+1]![0]-a[0]);return n;};
 for(const[polygonIndex,polygon]of domain.entries()){const rings=polygon.map((ring,ringIndex)=>{const R=ring.slice(0,-1).map(([x,z])=>{const p:Point=[Math.fround(x),Math.fround(z)];maximumSourceQuantizationMetres=Math.max(maximumSourceQuantizationMetres,Math.hypot(x-p[0],z-p[1]));return p;});let changed=true;while(changed&&R.length>2){changed=false;for(let i=0;i<R.length;i++){const a=R[(i+R.length-1)%R.length]!,b=R[i]!,c=R[(i+1)%R.length]!;if(b[0]===a[0]&&b[1]===a[1]||(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])===0){R.splice(i,1);changed=true;break;}}}if(twiceArea(R)===0){nonAreaSourceComponents.push({polygonIndex,ringIndex,rawRing:ring,encodedRing:R,status:'EXACT_ZERO_ENCODED_SOURCE_COMPONENT_NO_FLOOR_MASK_OR_CUT_AUTHORITY'});return null;}return[...R,R[0]!];});if(rings[0])polygons.push(rings.filter((R):R is Point[]=>R!==null));else assert.ok(rings.every(R=>R===null),'An encoded hole cannot outlive its zero-area outer ring');}
 assert.ok(polygons.length,'Named source union has no positive encoded area');return{polygons:polygonClipping.union(polygons[0]!,...polygons.slice(1)),proof:{maximumSourceQuantizationMetres,nonAreaSourceComponents,allPositiveEncodedSourceComponentsRetained:true}};
}
