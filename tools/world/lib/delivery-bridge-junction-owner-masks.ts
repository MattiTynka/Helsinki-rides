import assert from 'node:assert/strict';
import {splitBridgeFaces,type BridgeFace} from './bridge-reconstruction.ts';
/** Selection masks must use the geometry after cell splitting and F32 export.
 * An unsplit edge at a cell boundary can differ by an encoded coordinate step
 * and cut away native ground which the shipped replacement never covers. */
export function encodedJunctionOwnerFloors(faces:readonly BridgeFace[]){return[...splitBridgeFaces(faces)].flatMap(([cell,local])=>local.map(face=>({cell,face})));}
const maskKey=(mask:readonly(readonly number[])[])=>{assert.equal(mask.length,3,'A source cut must reference an actual encoded floor triangle');return[0,1,2].map(start=>[0,1,2].map(k=>mask[(start+k)%3]!.join(',')).join('|')).sort()[0]!;};
export function validateJunctionOwnerMasks(faces:readonly BridgeFace[],selections:readonly{masks:readonly(readonly[number,number][])[]}[]){
 const actual=new Set(encodedJunctionOwnerFloors(faces).map(({face})=>maskKey(face.points.map(p=>[p[0],p[2]]))));for(const selection of selections)for(const mask of selection.masks)assert.ok(actual.has(maskKey(mask)),'Source cut uses a pre-owner or unrelated floor mask instead of the actual encoded replacement');return{kind:'ACTUAL_OWNER_CLIPPED_ENCODED_FLOOR_TRIANGLES',actualPositiveFloorTriangles:actual.size,selections:selections.length};
}
