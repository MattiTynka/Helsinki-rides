// Geometric support equivalence for delivery tiers with different triangulation.
// Never expands a source floor or creates render/collision geometry.
import assert from 'node:assert/strict';
import type {Document} from '@gltf-transform/core';
import type {CollisionBundle} from '../../../packages/world-schema/src/index.ts';
import type polygonClipping from 'polygon-clipping';
import earcut from 'earcut';
import {readTramGround,upwardTramTriangle,tramTriangleKey} from './tram-cell-ground.ts';
import type {TramGroundTriangle,TramVertex,TramMesh} from './tram-visuals.ts';
import {certifyTramCoverageFringes} from './tram-coverage.ts';
const identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const PLANE_TOLERANCE=.00001;
const GRID=.000001;
type Point=[number,number];
const cross=(a:Point,b:Point,p:Point)=>(b[0]-a[0])*(p[1]-a[1])-(b[1]-a[1])*(p[0]-a[0]);
function ringArea(r:readonly Point[]){let sum=0;for(let i=1;i<r.length-1;i++)sum+=cross(r[0]!,r[i]!,r[i+1]!);return Math.abs(sum)/2;}
function halfPlane(r:readonly Point[],value:(p:Point)=>number){const out:Point[]=[];for(let i=0;i<r.length;i++){const a=r[i]!,b=r[(i+1)%r.length]!,va=value(a),vb=value(b);if(va>=0)out.push(a);if((va>=0)!==(vb>=0)){const t=va/(va-vb);out.push([a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t]);}}return out;}
function convexIntersection(a:readonly Point[],b:readonly Point[]){let rest=[...a];const sign=Math.sign(cross(b[0]!,b[1]!,b[2]!));for(let i=0;i<b.length&&rest.length>=3;i++)rest=halfPlane(rest,p=>cross(b[i]!,b[(i+1)%b.length]!,p)*sign);return rest;}
/** A triangle minus another triangle is an exact disjoint convex partition.
 * This avoids sweep-line topology failures on nearly coincident dense grids;
 * source coordinates and the existing support-distance allowances stay intact. */
function subtractTriangle(polygon:Point[],triangle:readonly Point[]){const result:Point[][]=[];let rest=polygon;const sign=Math.sign(cross(triangle[0]!,triangle[1]!,triangle[2]!));for(let edge=0;edge<3&&rest.length>=3;edge++){const value=(p:Point)=>cross(triangle[edge]!,triangle[(edge+1)%3]!,p)*sign,outside=halfPlane(rest,p=>-value(p));if(outside.length>=3&&ringArea(outside)>1e-14)result.push(outside);rest=halfPlane(rest,value);}return result;}
const intersection=(a:polygonClipping.Polygon,b:polygonClipping.Polygon):polygonClipping.MultiPolygon=>{assert.equal(a.length,1);assert.equal(b.length,1);const ring=convexIntersection(a[0]!.slice(0,-1),b[0]!.slice(0,-1));return ring.length>=3&&ringArea(ring)>1e-14?[[[...ring,ring[0]!]]]:[];};
type Floor={vertices:[TramVertex,TramVertex,TramVertex];visual?:TramGroundTriangle['visual'];collision?:TramGroundTriangle['collision'];tag?:string};
const bbox=(vertices:readonly number[][])=>[Math.min(...vertices.map(p=>p[0]!)),Math.min(...vertices.map(p=>p[2]!)),Math.max(...vertices.map(p=>p[0]!)),Math.max(...vertices.map(p=>p[2]!))];
const poly=(vertices:readonly number[][]):polygonClipping.Polygon=>{const p=vertices.map(v=>[v[0]!,v[2]!] as [number,number]);return[[...p,p[0]!]];};
const area=(polygons:polygonClipping.MultiPolygon)=>polygons.reduce((s,p)=>s+p.reduce((n,r,i)=>{const a=r[0]!;let v=0;for(let k=1;k<r.length-1;k++)v+=(r[k]![0]-a[0])*(r[k+1]![1]-a[1])-(r[k+1]![0]-a[0])*(r[k]![1]-a[1]);return n+(i?-1:1)*Math.abs(v/2);},0),0);
function plane(vertices:readonly number[][]){const[a,b,c]=vertices,den=(b![2]!-c![2]!)*(a![0]!-c![0]!)+(c![0]!-b![0]!)*(a![2]!-c![2]!);assert.ok(Math.abs(den)>1e-12);return(x:number,z:number)=>{const u=((b![2]!-c![2]!)*(x-c![0]!)+(c![0]!-b![0]!)*(z-c![2]!))/den,v=((c![2]!-a![2]!)*(x-c![0]!)+(a![0]!-c![0]!)*(z-c![2]!))/den;return u*a![1]!+v*b![1]!+(1-u-v)*c![1]!;};}
function spatial(floors:readonly Floor[]){
 const bins=new Map<string,Floor[]>();for(const f of floors){const b=bbox(f.vertices);for(let x=Math.floor(b[0]!/16);x<=Math.floor(b[2]!/16);x++)for(let z=Math.floor(b[1]!/16);z<=Math.floor(b[3]!/16);z++){const key=`${x},${z}`,list=bins.get(key)??[];list.push(f);bins.set(key,list);}}
 return(vertices:readonly number[][])=>{const b=bbox(vertices),found=new Set<Floor>();for(let x=Math.floor(b[0]!/16);x<=Math.floor(b[2]!/16);x++)for(let z=Math.floor(b[1]!/16);z<=Math.floor(b[3]!/16);z++)for(const f of bins.get(`${x},${z}`)??[]){const q=bbox(f.vertices);if(q[0]!<=b[2]!&&q[2]!>=b[0]!&&q[1]!<=b[3]!&&q[3]!>=b[1]!)found.add(f);}return [...found];};
}
function visualFloors(doc:Document,groundOnly:boolean){const result:Floor[]=[];
 for(const node of doc.getRoot().listNodes()){
  // Authored entrance repairs keep explicit _ground_ names too. They receive
  // authority only from an actual coincident HCOL ground face below.
  if(groundOnly&&!node.getName().includes('_ground_'))continue;
  if(!node.getMesh()||!node.getWorldMatrix().every((v,i)=>v===identity[i]))continue;
  for(const[primitive,p]of node.getMesh()!.listPrimitives().entries()){
   const P=p.getAttribute('POSITION'),I=p.getIndices();if(!P||!I||p.getMode()!==4)continue;
   for(let triangle=0;triangle<I.getCount()/3;triangle++){const vertices=[0,1,2].map(k=>P.getElement(I.getScalar(triangle*3+k),[]) as unknown as TramVertex) as [TramVertex,TramVertex,TramVertex];if(upwardTramTriangle(vertices))result.push({vertices,visual:{node:node.getName(),primitive,triangle}});}
  }
 }return result;
}
/** Equal floor surfaces may have different triangle diagonals. Their exact
 * intersection is a support facet bound to BOTH original source triangles. */
export function readMatchingDeliveryTramGround(doc:Document,bundle:CollisionBundle){
 const exact=readTramGround(doc,bundle),matched=new Set(exact.map(t=>`${t.visual.node}:${t.visual.primitive}:${t.visual.triangle}`)),floors:Floor[]=[];
 for(const item of bundle.colliders){if(item.group!=='ground')continue;for(let triangle=0;triangle<item.indices.length/3;triangle++){
  const vertices=[0,1,2].map(k=>Array.from(item.positions.subarray(item.indices[triangle*3+k]!*3,item.indices[triangle*3+k]!*3+3)) as TramVertex) as [TramVertex,TramVertex,TramVertex];
  if(upwardTramTriangle(vertices))floors.push({vertices,collision:{collider:item.id,triangles:[triangle]},tag:bundle.header.surfaceTags[item.triangleTags[triangle]!]!});
 }}const nearby=spatial(floors);let intersections=0,maximumPlaneError=0;
 for(const visual of visualFloors(doc,true)){
  const v=visual.visual!;if(matched.has(`${v.node}:${v.primitive}:${v.triangle}`))continue;const vy=plane(visual.vertices);
  for(const collider of nearby(visual.vertices)){
   const cy=plane(collider.vertices),common=intersection(poly(visual.vertices),poly(collider.vertices));if(area(common)<1e-12)continue;
   const error=Math.max(...common.flat(2).map(p=>Math.abs(vy(p[0],p[1])-cy(p[0],p[1]))));if(error>PLANE_TOLERANCE)continue;maximumPlaneError=Math.max(maximumPlaneError,error);
   for(const polygon of common){const values:number[]=[],holes:number[]=[];polygon.forEach((ring,i)=>{if(i)holes.push(values.length/2);for(const p of ring.slice(0,-1))values.push(...p);});const I=earcut(values,holes,2);
    for(let i=0;i<I.length;i+=3){const vertices=[0,1,2].map(k=>{const index=I[i+k]!*2,x=values[index]!,z=values[index+1]!;return[x,vy(x,z),z] as TramVertex;}) as [TramVertex,TramVertex,TramVertex];if(!upwardTramTriangle(vertices))[vertices[1],vertices[2]]=[vertices[2],vertices[1]];
     exact.push({id:`${v.node}:${v.primitive}:${v.triangle}:intersection:${collider.collision!.collider}:${collider.collision!.triangles[0]}:${i}`,vertices,visual:v,collision:collider.collision!,tag:collider.tag!});intersections++;
    }
   }
  }
 }
 return{ground:exact,proof:{exactFacets:exact.length-intersections,intersectionFacets:intersections,maximumPlaneError,planeToleranceMetres:PLANE_TOLERANCE,sourceGeometryUnchanged:true}};
}
/** Every proposed rail triangle is covered by an actual rendered tier floor at
 * its measured source-plane height; a missing strip or different height fails. */
export function proveDeliveryTramTierSupport(doc:Document,mesh:TramMesh){
 const nearby=spatial(visualFloors(doc,false)),boundSources=(mesh.bindings??[]).flatMap(b=>{assert.ok(Number.isSafeInteger(b.triangles)&&b.triangles>0);return Array<TramGroundTriangle>(b.triangles).fill(b.ground);});if(boundSources.length)assert.equal(boundSources.length,mesh.indices.length/3,'Incomplete rail/source triangle binding');
 let missingArea=0,rawMissingArea=0,qualifiedNumericalArea=0,maximumPlaneError=0,maximumRailFloat32LiftError=0;const missing:any[]=[];
 for(let i=0;i<mesh.indices.length;i+=3){const vertices=[0,1,2].map(k=>mesh.positions.slice(mesh.indices[i+k]!*3,mesh.indices[i+k]!*3+3).map((v,j)=>j===1?v-.003:v));
  // Compare the two actual source floors, rather than inferring a reference
  // plane from already rounded rail vertices on a steep source face.
  const source=boundSources[i/3],vy=plane(source?.vertices??vertices);
  for(const v of vertices){const error=Math.abs(v[1]!-vy(v[0]!,v[2]!));maximumRailFloat32LiftError=Math.max(maximumRailFloat32LiftError,error);assert.ok(error<=.0001,'Rail/source lift exceeds the 0.1mm construction bound');}
  let pieces:Point[][]=[vertices.map(v=>[v[0]!,v[2]!] as Point)];
  const qualified:Floor[]=[];
  for(const floor of nearby(vertices)){const triangle=floor.vertices.map(v=>[v[0],v[2]] as Point),common=pieces.map(p=>convexIntersection(p,triangle)).filter(p=>p.length>=3&&ringArea(p)>1e-14);if(!common.length)continue;const fy=plane(floor.vertices),error=Math.max(...common.flat().map(p=>Math.abs(vy(p[0],p[1])-fy(p[0],p[1]))));if(error>PLANE_TOLERANCE)continue;qualified.push(floor);maximumPlaneError=Math.max(maximumPlaneError,error);pieces=pieces.flatMap(p=>subtractTriangle(p,triangle));if(!pieces.length)break;}
  const uncovered:polygonClipping.MultiPolygon=pieces.map(p=>[[...p,p[0]!]]);
  const a=area(uncovered);if(a>1e-10){rawMissingArea+=a;const fringes=certifyTramCoverageFringes(uncovered,qualified.map((f,k)=>({id:String(k),vertices:f.vertices,visual:f.visual!,collision:{collider:'tier',triangles:[k]},tag:'tier-support'}))),unresolved=fringes.filter(f=>!f.qualified).reduce((s,f)=>s+f.area,0);qualifiedNumericalArea+=a-unresolved;missingArea+=unresolved;if(unresolved>1e-10&&missing.length<20)missing.push({triangle:i/3,area:a,polygon:uncovered,fringes});}
 }
 return{triangles:mesh.indices.length/3,missingArea,rawMissingArea,qualifiedNumericalArea,missing,maximumPlaneError,planeToleranceMetres:PLANE_TOLERANCE,maximumRailFloat32LiftError,railConstructionBoundMetres:.0001,sourcePlaneAuthority:boundSources.length?'paired-rendered-and-collision-floor-bindings':'exact-rail-plane-without-bindings',construction:'direct-convex-source-triangle-partition',booleanGridMetres:0,fringeAllowanceGridMetres:GRID,qualified:missingArea<=1e-8};
}
