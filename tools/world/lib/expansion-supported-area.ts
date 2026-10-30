import assert from 'node:assert/strict';
import polygonClipping from 'polygon-clipping';
import {validateSupportedArea, type SupportedArea} from '../../../packages/world-schema/src/index.ts';
import {assertSupportedAreaPreservesAccepted} from './delivery-supported-area.ts';

type Rect = readonly [number,number,number,number];
type Polygon = polygonClipping.Polygon;
const rectangle = (r:Rect):Polygon => [[[r[0],r[1]],[r[2],r[1]],[r[2],r[3]],[r[0],r[3]]]];
const area = (r:Rect) => ({minX:r[0],minZ:r[1],maxX:r[2],maxZ:r[3]});

/** Public municipal footprints bound where a new candidate may be explored.
 * This is a source/access mask; actual physical and route acceptance remains a separate gate. */
export function composeExpansionSupportedArea(input:{accepted:Rect;region:Rect;publicPolygons:Polygon[];excludedPolygons:Polygon[];unionBatchSize?:number}) {
  const {accepted,region} = input;
  for(const r of [accepted,region])assert.ok(r.length===4&&r.every(Number.isFinite)&&r[0]<r[2]&&r[1]<r[3]);
  assert.ok(input.publicPolygons.length>0,'No selected municipal public surface');
  let selected:polygonClipping.MultiPolygon=[];
  // Source plans can bind one bounded union when repeated intermediate clipping loses a ring.
  const batch=input.unionBatchSize??64;assert.ok(Number.isInteger(batch)&&batch>=1&&batch<=20_000);
  assert.ok(input.publicPolygons.length<=20_000,'Municipal source polygon count exceeds bounded union');
  for(let i=0;i<input.publicPolygons.length;i+=batch)selected=polygonClipping.union(selected,...input.publicPolygons.slice(i,i+batch));
  let extension=polygonClipping.intersection(selected,rectangle(region));
  for(let i=0;i<input.excludedPolygons.length;i+=64)extension=polygonClipping.difference(extension,...input.excludedPolygons.slice(i,i+64));
  const composed=polygonClipping.union([rectangle(accepted)],extension);
  const baseline:polygonClipping.MultiPolygon=[rectangle(accepted)];
  const connected=composed.filter(p=>polygonClipping.intersection([p],baseline).length>0);
  assert.equal(connected.length,1,'Accepted rectangle must have one connected component');
  // Polygon clipping emits a repeated closing vertex; the runtime schema closes rings implicitly.
  const rings=connected.map(p=>p.map(r=>r.slice(0,-1).map(([x,z])=>[x,z]as[number,number])));
  const supportedArea:SupportedArea={schemaVersion:1,regions:rings.map((p,i)=>({id:`southwest-connected-${i}`,outer:p[0]!,...(p.length>1?{holes:p.slice(1)}:{})}))};
  const expanded:Rect=[Math.min(accepted[0],region[0]),Math.min(accepted[1],region[1]),Math.max(accepted[2],region[2]),Math.max(accepted[3],region[3])];
  const diagnostics={holes:rings.map(p=>p.length-1),vertices:rings.map(p=>p.reduce((n,r)=>n+r.length,0)),
    holeAreas:rings.flatMap(p=>p.slice(1).map(r=>Math.abs(r.reduce((sum,v,i)=>{const next=r[(i+1)%r.length]!;return sum+v[0]*next[1]-next[0]*v[1];},0)/2))).sort((a,b)=>a-b)};
  const summary={holes:diagnostics.holes,vertices:diagnostics.vertices,histogram:[1e-8,1e-6,1e-4,0.01,0.1,1,10,100].map(limit=>({lessThanSquareMetres:limit,count:diagnostics.holeAreas.filter(a=>a<limit).length})),largest:diagnostics.holeAreas.slice(-10)};
  assert.deepEqual(validateSupportedArea(supportedArea,area(expanded)),[],`Source mask exceeds native geometry/complexity contract; refine explicit surface selection: ${JSON.stringify(summary)}`);
  assertSupportedAreaPreservesAccepted(supportedArea,{playArea:area(accepted)},area(expanded));
  assert.deepEqual(polygonClipping.difference(connected,polygonClipping.union(baseline,extension)),[],'Mask added unsupported footprint');
  return {supportedArea,expanded,excludedDisconnectedComponents:composed.length-connected.length,
    selectedComponents:extension.length,vertices:rings.reduce((n,p)=>n+p.reduce((m,r)=>m+r.length,0),0)};
}
