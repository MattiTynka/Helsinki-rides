// Missing-detail census: an atlas URI does not imply a photographic facade.
import assert from 'node:assert/strict';
export type CensusPoint = readonly [number,number,number];
export type CensusTriangle = readonly [CensusPoint,CensusPoint,CensusPoint];
export interface FacadeAxis {id:number;name:string;highway:string;points:readonly (readonly [number,number])[]}
export function classifyFacadeTriangle(triangle:CensusTriangle,wallMaxNormalY=.3){
  const [a,b,c]=triangle,u=b.map((v,k)=>v-a[k]!),v=c.map((p,k)=>p-a[k]!),normal=[u[1]!*v[2]!-u[2]!*v[1]!,u[2]!*v[0]!-u[0]!*v[2]!,u[0]!*v[1]!-u[1]!*v[0]!] as [number,number,number],length=Math.hypot(...normal);
  assert.ok(triangle.flat().every(Number.isFinite));
  return {area:length/2,kind:!length?'degenerate':Math.abs(normal[1]/length)<wallMaxNormalY?'wall':normal[1]>0?'roof':'underside',normal:normal.map(n=>length?n/length:0) as [number,number,number],centre:a.map((n,k)=>(n+b[k]!+c[k]!)/3) as [number,number,number]};
}
export function closestFacadeAxis(point:readonly [number,number],axes:readonly FacadeAxis[],maximum=45){
  let best:{id:number;name:string;highway:string;distance:number;point:[number,number];segment:number}|null=null;
  for(const axis of axes)for(let i=1;i<axis.points.length;i++){
    const a=axis.points[i-1]!,b=axis.points[i]!,u=b[0]-a[0],v=b[1]-a[1],d=u*u+v*v;if(!d)continue;
    const t=Math.max(0,Math.min(1,((point[0]-a[0])*u+(point[1]-a[1])*v)/d)),q:[number,number]=[a[0]+t*u,a[1]+t*v],distance=Math.hypot(q[0]-point[0],q[1]-point[1]);
    if(distance<=maximum&&(!best||distance<best.distance))best={id:axis.id,name:axis.name,highway:axis.highway,distance,point:q,segment:i-1};
  }return best;
}
/** Geometry intersection, not an assumption that every source-null face is visible. */
export function facadeRayIntersection(from:CensusPoint,to:CensusPoint,triangle:CensusTriangle):number|null{
  const [a,b,c]=triangle,d=to.map((v,k)=>v-from[k]!),u=b.map((v,k)=>v-a[k]!),v=c.map((p,k)=>p-a[k]!),cross=(x:readonly number[],y:readonly number[])=>[x[1]!*y[2]!-x[2]!*y[1]!,x[2]!*y[0]!-x[0]!*y[2]!,x[0]!*y[1]!-x[1]!*y[0]!],dot=(x:readonly number[],y:readonly number[])=>x.reduce((s,n,k)=>s+n*y[k]!,0),p=cross(d,v),det=dot(u,p);if(Math.abs(det)<1e-10)return null;
  const s=from.map((n,k)=>n-a[k]!),x=dot(s,p)/det;if(x< -1e-8||x>1+1e-8)return null;const q=cross(s,u),y=dot(d,q)/det;if(y< -1e-8||x+y>1+1e-8)return null;const t=dot(v,q)/det;return t>1e-5&&t<1-1e-5?t:null;
}
