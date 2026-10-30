import assert from 'node:assert/strict';
import polygonClipping from 'polygon-clipping';
import {composeExpansionSupportedArea} from './expansion-supported-area.ts';
type Rect=readonly[number,number,number,number];
/** Remove every unqualified deck from ordinary municipal land first. Add only
 * the separately qualified literal upper floors, before testing connectivity:
 * otherwise the valid far bank is lost while the bridge is still absent. */
export function composeRuoholahtiPublicArea(input:{accepted:Rect;region:Rect;publicPolygons:polygonClipping.Polygon[];unqualifiedDecks:polygonClipping.Polygon[];qualifiedUpperFloor:polygonClipping.Polygon[]}){
  assert.ok(input.qualifiedUpperFloor.length>0&&input.qualifiedUpperFloor.length<=10000);
  let land:polygonClipping.MultiPolygon=[];
  for(let i=0;i<input.publicPolygons.length;i+=64)land=polygonClipping.union(land,...input.publicPolygons.slice(i,i+64));
  for(let i=0;i<input.unqualifiedDecks.length;i+=64)land=polygonClipping.difference(land,...input.unqualifiedDecks.slice(i,i+64));
  const result=composeExpansionSupportedArea({accepted:input.accepted,region:input.region,publicPolygons:[...land,...input.qualifiedUpperFloor],excludedPolygons:[]});
  return{...result,unqualifiedDecksRemovedBeforeMeasuredFloorUnion:true,qualifiedUpperTriangles:input.qualifiedUpperFloor.length};
}
