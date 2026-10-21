import assert from 'node:assert/strict';
import {validateFacadeTriangle,type FacadeChart,type FacadeTriangle} from './facade-charts.ts';
export interface ProjectedElevation {originXZ:readonly[number,number];axisXZ:readonly[number,number];width:number;minY:number;maxY:number}
/** Share an original elevation across unchanged native curved facets. This
 * projects one common horizontal source axis; it does not claim arclength,
 * modify geometry, or weaken the individual native plane/bounds checks. */
export function chartInProjectedElevation(chart:FacadeChart,triangles:readonly FacadeTriangle[],frame:ProjectedElevation):FacadeChart{
 assert.ok(triangles.length&&[...frame.originXZ,...frame.axisXZ,frame.width,frame.minY,frame.maxY].every(Number.isFinite)&&Math.abs(Math.hypot(...frame.axisXZ)-1)<1e-10&&frame.width>0&&frame.maxY>frame.minY,'Invalid common source elevation frame');
 const ratio=chart.uAxis[0]*frame.axisXZ[0]+chart.uAxis[2]*frame.axisXZ[1];assert.ok(ratio>.2&&ratio<=1.000001,'Unsupported source wall orientation for common projected elevation');const first=[chart.origin[0]+chart.uAxis[0]*chart.bounds[0],chart.origin[2]+chart.uAxis[2]*chart.bounds[0]],offset=(first[0]!-frame.originXZ[0])*frame.axisXZ[0]+(first[1]!-frame.originXZ[1])*frame.axisXZ[1],start=chart.bounds[0]-offset/ratio,result={...chart,bounds:[start,frame.minY,start+frame.width/ratio,frame.maxY]as const};for(const triangle of triangles)validateFacadeTriangle(triangle,result);return result;
}
