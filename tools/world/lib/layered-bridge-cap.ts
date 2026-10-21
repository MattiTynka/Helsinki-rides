import assert from 'node:assert/strict';
import {layeredTriangleHash} from './layered-bridge-field.ts';
import type {LayeredRetainingWay} from './layered-bridge-source.ts';
import type {SupportTriangle,SupportVertex} from './tram-support-repair.ts';

export interface LayeredCapFloor {points:SupportTriangle;source:{cell:string;collider:string;triangle:number;sha256:string}}
/** Close only an original native retaining-wall cap footprint. Heights come
 * from the decoded, already repaired lower floor edges on its two banks. */
export function buildLayeredCapMapper(floors:readonly LayeredCapFloor[],axis:LayeredRetainingWay){
 assert.equal(axis.id,799540236);assert.ok(axis.upperEndpointIdentity);
 const bins=new Map<string,LayeredCapFloor[]>();
 for(const face of floors){const P=face.points;for(let x=Math.floor(Math.min(...P.map(p=>p[0])));x<=Math.floor(Math.max(...P.map(p=>p[0])));x++)for(let z=Math.floor(Math.min(...P.map(p=>p[2])));z<=Math.floor(Math.max(...P.map(p=>p[2])));z++){const k=`${x},${z}`,v=bins.get(k)??[];v.push(face);bins.set(k,v);}}
 const samples:{position:SupportVertex;newY:number;distance:number;source:LayeredCapFloor['source'];floorSha256:string;bankSources:{position:SupportVertex;distance:number;source:LayeredCapFloor['source'];floorSha256:string}[];boundaryError:number|null}[]=[];
 const cache=new Map<string,SupportVertex>();const sample=(p:SupportVertex):SupportVertex=>{const key=p.join(',');const cached=cache.get(key);if(cached)return cached;
  let edge={distance:Infinity,x:0,z:0,nx:0,nz:0};for(let i=1;i<axis.points.length;i++){const a=axis.points[i-1]!,b=axis.points[i]!,dx=b[0]-a[0],dz=b[1]-a[1],L2=dx*dx+dz*dz;if(!L2)continue;const t=Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[2]-a[1])*dz)/L2)),x=a[0]+t*dx,z=a[1]+t*dz,distance=Math.hypot(p[0]-x,p[2]-z);if(distance<edge.distance)edge={distance,x,z,nx:-dz/Math.sqrt(L2),nz:dx/Math.sqrt(L2)};}
  assert.ok(edge.distance<=.025001,'Cap vertex outside pinned native retaining skin');
  const nearby=new Set<LayeredCapFloor>();for(const dx of[-.026,0,.026])for(const dz of[-.026,0,.026])for(const f of bins.get(`${Math.floor(p[0]+dx)},${Math.floor(p[2]+dz)}`)??[])nearby.add(f);
  const banks:{distance:number;y:number;x:number;z:number;face:LayeredCapFloor}[]=[];
  for(const face of nearby)for(let i=0;i<3;i++){const a=face.points[i]!,b=face.points[(i+1)%3]!,dx=b[0]-a[0],dz=b[2]-a[2],L2=dx*dx+dz*dz;if(L2<1e-14)continue;const t=Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[2]-a[2])*dz)/L2)),x=a[0]+dx*t,z=a[2]+dz*t,distance=Math.hypot(x-p[0],z-p[2]);if(distance<=.0255)banks.push({distance,y:a[1]+(b[1]-a[1])*t,x,z,face});}
  banks.sort((a,b)=>a.distance-b.distance);const nearest=banks[0];assert.ok(nearest,'No actual repaired lower floor boundary for native cap');
  let y=nearest.y,used=[nearest];
  if(nearest.distance>.0003){const left=banks.find(b=>(b.x-edge.x)*edge.nx+(b.z-edge.z)*edge.nz<-.0003),right=banks.find(b=>(b.x-edge.x)*edge.nx+(b.z-edge.z)*edge.nz>.0003);assert.ok(left&&right,'Native cap lacks two actual repaired lower floor banks');y=(left.y*right.distance+right.y*left.distance)/(left.distance+right.distance);used=[left,right];}
  samples.push({position:p,newY:y,distance:nearest.distance,source:nearest.face.source,floorSha256:layeredTriangleHash(nearest.face.points),bankSources:used.map(b=>({position:[b.x,b.y,b.z],distance:b.distance,source:b.face.source,floorSha256:layeredTriangleHash(b.face.points)})),boundaryError:nearest.distance<=.0003?Math.abs(Math.fround(y)-nearest.y):null});const result:SupportVertex=[p[0],Math.fround(y),p[2]];cache.set(key,result);return result;
 };
 return{map:sample,samples};
}
