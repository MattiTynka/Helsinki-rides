import assert from 'node:assert/strict';
import type {FacadeTriangle} from './facade-charts.ts';
import {classifyFacadeTriangle} from './delivery-new-area-facades.ts';
type Face={key:string;kind:string;texture:number|null;points:FacadeTriangle};
/** A declared complete flat elevation must include every original wall triangle
 * on that same plane inside its exact bounds. Tiny numerical normal differences
 * must not strand an unpainted diagonal in the middle of the facade. */
export function assertCompleteSelectedFacadePlane(all:readonly Face[],selected:readonly Face[],frame:{origin:readonly[number,number];axis:readonly[number,number];width:number;minY:number;maxY:number}){
 assert.ok(selected.length);const n=classifyFacadeTriangle(selected[0]!.points).normal,p0=selected[0]!.points[0],keys=new Set(selected.map(f=>f.key));
 const inside=(point:readonly number[])=>{const d=point.reduce((s,v,i)=>s+(v-p0[i]!)*n[i]!,0),u=(point[0]!-frame.origin[0])*frame.axis[0]+(point[2]!-frame.origin[1])*frame.axis[1];return Math.abs(d)<=.002&&u>=-.00001&&u<=frame.width+.00001&&point[1]!>=frame.minY-.00001&&point[1]!<=frame.maxY+.00001;};
 const complete=all.filter(f=>f.kind==='wall'&&f.texture===null&&f.points.every(inside));for(const face of complete)assert.ok(keys.has(face.key),'Declared complete native elevation omits a coplanar original wall triangle');
 return{completeNativePlane:true,sourceTrianglesInExactElevation:complete.length,planeToleranceMetres:.002};
}

/** Curved/bayed elevations still consist of exact native planar triangles. Test
 * each selected support plane independently so a coplanar diagonal cannot be
 * stranded between independently projected source facets. This does not select
 * any additional plane or assert coverage of unselected architecture. */
export function assertCompleteSelectedFacadeSupportPlanes(all:readonly Face[],selected:readonly Face[],frame:{origin:readonly[number,number];axis:readonly[number,number];width:number;minY:number;maxY:number}){
  assert.ok(selected.length);let checked=0;
  for(const face of selected){assertCompleteSelectedFacadePlane(all,[face,...selected.filter(f=>f!==face)],frame);checked++;}
  return{allSelectedNativeSupportPlanesChecked:true,selectedTriangles:checked,planeToleranceMetres:.002};
}
