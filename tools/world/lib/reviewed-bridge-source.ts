import assert from 'node:assert/strict';
import polygonClipping from 'polygon-clipping';
import {bbox,type LocalPolygon} from './geometry.ts';
import type {Vec3} from '../../../packages/world-schema/src/index.ts';

/** Called only after the source/profile/record/literal HCOL inventory verifies.
 * Preserve municipal classifications and expose exactly source ∩ authored sheet. */
export function clipReviewedBridgeRoadSources(parts: readonly LocalPolygon[], faces: readonly {points:readonly Vec3[]}[]): LocalPolygon[] {
  assert.ok(faces.length>0&&faces.length<=10000);
  let sheet:polygonClipping.MultiPolygon=[];
  for(let i=0;i<faces.length;i+=64)sheet=polygonClipping.union(sheet,...faces.slice(i,i+64).map(f=>{assert.ok(f.points.length===3&&f.points.every(p=>p.every(Number.isFinite)));return [f.points.map(p=>[p[0],-p[2]]as [number,number])];}));
  return parts.flatMap(part=>{
    if(part.properties.paatyyppi!=='Silta')return[];
    assert.equal(part.properties.alatyyppi,'Ajorata (Silta)','Unreviewed municipal bridge surface');
    return polygonClipping.intersection(part.rings,sheet).map(p=>{const rings=p.map(r=>r.slice(0,-1));return{id:part.id,properties:structuredClone(part.properties),rings,bbox:bbox(rings)};});
  });
}
