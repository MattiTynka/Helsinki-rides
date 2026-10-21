import assert from 'node:assert/strict';
import polygonClipping from 'polygon-clipping';
import{exactConvexCoverage,hasExactPolygonArea}from'./delivery-exact-convex-coverage.ts';
type Point=[number,number];type Multi=polygonClipping.MultiPolygon;
const area=(m:Multi)=>m.reduce((total,p)=>total+Math.abs(p.reduce((sum,r,i)=>sum+(i?-1:1)*Math.abs(r.reduce((v,a,j)=>{const b=r[(j+1)%r.length]!;return v+a[0]*b[1]-b[0]*a[1];},0))/2,0)),0);
function union(items:Multi[]){const combine=(p:Multi[])=>polygonClipping.union(p[0]!,...p.slice(1));let current=items;while(current.length>64){const next:Multi[]=[];for(let i=0;i<current.length;i+=64)next.push(combine(current.slice(i,i+64)));current=next;}return current.length?combine(current):[];}
/** A bounded source cut needs a coverage subtraction, not a global union of
 * near-tangent replacement triangles. Keep every actual positive piece and
 * subtract the literal floor triangles before the same 80um edge bound. */
export function deliveryRoadSourceCutCoverage(masks:readonly{id:string;polygon:readonly(readonly number[])[]}[],floors:readonly{points:readonly(readonly number[])[]}[]){
 const bound=.00008,corner=bound/Math.SQRT2,actual=floors.map(f=>f.points.map(p=>[p[0]!,p[2]!]as Point)).filter(hasExactPolygonArea),edges:Point[][]=[];
 for(const p of actual)for(let i=0;i<p.length;i++){
  const a=p[i]!,b=p[(i+1)%p.length]!,dx=b[0]-a[0],dz=b[1]-a[1],length=Math.hypot(dx,dz);if(!length)continue;const nx=-dz/length*bound,nz=dx/length*bound;
  edges.push([[a[0]+nx,a[1]+nz],[b[0]+nx,b[1]+nz],[b[0]-nx,b[1]-nz],[a[0]-nx,a[1]-nz]],[[a[0]-corner,a[1]-corner],[a[0]+corner,a[1]-corner],[a[0]+corner,a[1]+corner],[a[0]-corner,a[1]+corner]]);
 }
 const proof=exactConvexCoverage(masks.map(m=>m.polygon),actual,edges);
 return{status:proof.exactPositiveResiduals?'MISSING_CANONICAL_FLOOR_PROJECTION':'COMPLETE_MASK_UNION_COVERED_WITHIN_EXISTING_SOURCE_CONSTRUCTION_BOUND',maximumProjectionErrorMetres:bound,...proof,actualPositiveFloorTriangles:actual.length,method:'Exact rational convex subtraction of literal source-local pieces and existing80micrometre edge neighborhoods. No floating sweep, coordinate rounding or positive-area omission.'};
}
/** Coverage uses the existing 80-micrometre encoded source construction bound,
 * never the 1mm contact gate. An inscribed disk/rectangle edge neighbourhood
 * cannot conceal a real missing floor island or select a different level. */
export function deliveryRoadProjectionCoverage(masks:readonly {id:string;polygon:readonly(readonly number[])[]}[],floors:readonly {points:readonly(readonly number[])[]}[],maximumProjectionError=.00008){
 assert.equal(maximumProjectionError,.00008,'Published source projection bound cannot be widened');const positiveFloors=floors.filter(f=>{const[a,b,c]=f.points;return(b![0]!-a![0]!)*(c![2]!-a![2]!)-(b![2]!-a![2]!)*(c![0]!-a![0]!)!==0;}),wanted=union(masks.map(m=>[[m.polygon.map(p=>[p[0]!,p[1]!]as Point)]])),actual=union(positiveFloors.map(f=>[[f.points.map(p=>[p[0]!,p[2]!]as Point)]])),missing=polygonClipping.difference(wanted,actual),extra=polygonClipping.difference(actual,wanted),neighborhood:Multi[]=[actual];
 if(!missing.length)return{status:'COMPLETE_MASK_UNION_COVERED_WITHIN_EXISTING_SOURCE_CONSTRUCTION_BOUND',maximumProjectionErrorMetres:maximumProjectionError,publishedMaskArea:area(wanted),canonicalFloorArea:area(actual),rawMissingArea:0,rawExtraArea:area(extra),rawMissingComponents:missing,unexplainedArea:0,unexplainedComponents:missing,method:'Published mask union is literally covered by canonical clipped source ROAD floors; no construction-bound neighbourhood needed.'};
 // Inscribed corner squares are deliberately stricter than a radius80um disk.
 // They avoid tangent-circle Boolean instability without rounding native XZ.
 const corner=maximumProjectionError/Math.SQRT2;
 for(const polygon of actual)for(const ring of polygon)for(let i=0;i<ring.length;i++){const a=ring[i]!,b=ring[(i+1)%ring.length]!,dx=b[0]-a[0],dz=b[1]-a[1],L=Math.hypot(dx,dz);if(!L)continue;const nx=-dz/L*maximumProjectionError,nz=dx/L*maximumProjectionError;neighborhood.push([[[[a[0]+nx,a[1]+nz],[b[0]+nx,b[1]+nz],[b[0]-nx,b[1]-nz],[a[0]-nx,a[1]-nz]]]]);neighborhood.push([[[[a[0]-corner,a[1]-corner],[a[0]+corner,a[1]-corner],[a[0]+corner,a[1]+corner],[a[0]-corner,a[1]+corner]]]]);}
 const bounds=(m:Multi)=>{const points=m.flat(2);return[Math.min(...points.map(p=>p[0])),Math.min(...points.map(p=>p[1])),Math.max(...points.map(p=>p[0])),Math.max(...points.map(p=>p[1]))];},nearby=neighborhood.slice(1).map(shape=>({shape,bounds:bounds(shape)}));
 // Subtract bounded edge neighbourhoods from each actual residual separately.
 // Unioning thousands of nearly tangent buffers first is numerically unstable
 // and unnecessary: literal source floors have already been subtracted.
 const unexplained:Multi=missing.flatMap(polygon=>{let remaining:Multi=[polygon];const box=bounds(remaining);for(const n of nearby){if(!remaining.length)break;const b=n.bounds;if(box[0]!>b[2]!||box[2]!<b[0]!||box[1]!>b[3]!||box[3]!<b[1]!)continue;remaining=polygonClipping.difference(remaining,n.shape);}return remaining;});return{status:unexplained.length?'MISSING_CANONICAL_FLOOR_PROJECTION':'COMPLETE_MASK_UNION_COVERED_WITHIN_EXISTING_SOURCE_CONSTRUCTION_BOUND',maximumProjectionErrorMetres:maximumProjectionError,publishedMaskArea:area(wanted),canonicalFloorArea:area(actual),rawMissingArea:area(missing),rawExtraArea:area(extra),rawMissingComponents:missing,unexplainedArea:area(unexplained),unexplainedComponents:unexplained,method:'Exact projected union of declared canonical clipped Float32 ROAD faces. Edge rectangles and inscribed corner squares stay within the existing80micrometre native construction bound. No source coordinates are rounded and full oriented XYZ identity is checked separately.'};
}
