// Remove only a generated upward foundation quad proven redundant inside the
// very same native wall. All geometry decisions below use literal Float32
// vertices and exact polygon subtraction; no distance/area tolerance is used.
import assert from 'node:assert/strict';
import type {Document,Node,Primitive} from '@gltf-transform/core';
import {facadeTriangleKey,type FacadeTriangle,type FacadePoint} from './facade-charts.ts';
import {exactConvexCoverage,hasExactPolygonArea} from './delivery-exact-convex-coverage.ts';
export type SkirtEdge=readonly[number,number,number,number,number,number];
export interface SkirtSourceFace {part:number;triangle:number;key:string;points:FacadeTriangle}
export interface DuplicateSkirtQuad {edge:SkirtEdge;bottom:number;points:readonly FacadePoint[];keys:readonly string[];coveringSourceFaces:readonly {part:number;triangle:number;key:string}[];projectedArea:number;coverage:ReturnType<typeof exactConvexCoverage>}
const floatBits=new DataView(new ArrayBuffer(4));
function integer(value:number){assert.ok(Number.isFinite(value)&&Math.fround(value)===value,'Literal Float32 coordinates required');floatBits.setFloat32(0,value);const bits=floatBits.getUint32(0),exponent=(bits>>>23)&255,mantissa=BigInt((bits&0x7fffff)|(exponent?0x800000:0)),sign=bits>>>31?-1n:1n;return sign*(mantissa<<BigInt(exponent?exponent-1:0));}
const equal=(a:readonly number[],b:readonly number[])=>a.length===b.length&&a.every((v,k)=>v===b[k]);
function exactPlane(a:FacadePoint,b:FacadePoint,c:FacadePoint,p:FacadePoint){const u=b.map((v,k)=>integer(v)-integer(a[k]!)),v=c.map((n,k)=>integer(n)-integer(a[k]!)),w=p.map((n,k)=>integer(n)-integer(a[k]!));const det=(u[1]!*v[2]!-u[2]!*v[1]!)*w[0]!+(u[2]!*v[0]!-u[0]!*v[2]!)*w[1]!+(u[0]!*v[1]!-u[1]!*v[0]!)*w[2]!;return det===0n;}
export function literalWallFaces(parts:readonly {positions:Float32Array;indices:Uint32Array}[]):SkirtSourceFace[]{
 const out:SkirtSourceFace[]=[];for(const[part,p]of parts.entries())for(let t=0;t<p.indices.length;t+=3){const points=[0,1,2].map(k=>{const at=p.indices[t+k]!*3;return[p.positions[at]!,p.positions[at+1]!,p.positions[at+2]!]as const;})as unknown as FacadeTriangle;out.push({part,triangle:t/3,key:facadeTriangleKey(points),points});}return out;
}
/** Replays build_cells.ts bottom-edge predicate and three-decimal dedup exactly. */
export function sourceSkirtEdges(faces:readonly SkirtSourceFace[],minimumY:number):SkirtEdge[]{
 const edges:SkirtEdge[]=[],seen=new Set<string>();for(const f of faces){const[a,b,c]=f.points,u=b.map((v,k)=>v-a[k]!),v=c.map((n,k)=>n-a[k]!),nx=u[1]!*v[2]!-u[2]!*v[1]!,ny=u[2]!*v[0]!-u[0]!*v[2]!,nz=u[0]!*v[1]!-u[1]!*v[0]!,len=Math.hypot(nx,ny,nz)||1;if(Math.abs(ny/len)>.3)continue;
  for(const[i,j]of [[0,1],[1,2],[2,0]]as const){const a=f.points[i],b=f.points[j];if(a[1]>minimumY+.4||b[1]>minimumY+.4)continue;const k1=a.map(v=>v.toFixed(3)).join(','),k2=b.map(v=>v.toFixed(3)).join(','),key=k1<k2?k1+'|'+k2:k2+'|'+k1;if(seen.has(key))continue;seen.add(key);edges.push([...a,...b]);}
 }return edges;
}
export function generatedSkirtQuad(edge:SkirtEdge,bottom:number){
 const a=edge.slice(0,3)as unknown as FacadePoint,b=edge.slice(3)as unknown as FacadePoint,c=[edge[3],Math.fround(bottom),edge[5]]as const,d=[edge[0],Math.fround(bottom),edge[2]]as const;
 const triangles:FacadeTriangle[]=[[a,b,c],[a,c,d],[a,c,b],[a,d,c]];return{points:[a,b,c,d],triangles,keys:triangles.map(facadeTriangleKey)};
}
export function qualifyDuplicateUpwardSkirt(edge:SkirtEdge,bottom:number,source:readonly SkirtSourceFace[]):DuplicateSkirtQuad|null{
 assert.ok([...edge,bottom].every(Number.isFinite));if(Math.fround(bottom)<=Math.max(edge[1],edge[4]))return null;const quad=generatedSkirtQuad(edge,bottom),[a,b,c]=quad.points as [FacadePoint,FacadePoint,FacadePoint,FacadePoint];
 if(a[0]===b[0]&&a[2]===b[2])return null;const coordinate=Math.abs(b[0]-a[0])>=Math.abs(b[2]-a[2])?0:2,project=(p:FacadePoint)=>[p[coordinate],p[1]]as const;
 const covering=source.filter(f=>f.points.every(p=>exactPlane(a,b,c,p))&&f.points.some(p=>p[1]>Math.min(a[1],b[1]))&&hasExactPolygonArea(f.points.map(project)));
 if(!covering.length)return null;const coverage=exactConvexCoverage([quad.points.map(project)],covering.map(f=>f.points.map(project)),[]);if(coverage.exactPositiveResiduals!==0)return null;
 return{edge,bottom:Math.fround(bottom),points:quad.points,keys:quad.keys,coveringSourceFaces:covering.map(({part,triangle,key})=>({part,triangle,key})),projectedArea:coverage.publishedMaskArea,coverage};
}
export function nativeSkirtWorldTriangle(n:Node,p:Primitive,t:number):FacadeTriangle{
 const P=p.getAttribute('POSITION')!,I=p.getIndices()!,M=n.getWorldMatrix();return[0,1,2].map(k=>{const v=P.getElement(I.getScalar(t*3+k),[]);return[Math.fround(M[0]!*v[0]!+M[4]!*v[1]!+M[8]!*v[2]!+M[12]!),Math.fround(M[1]!*v[0]!+M[5]!*v[1]!+M[9]!*v[2]!+M[13]!),Math.fround(M[2]!*v[0]!+M[6]!*v[1]!+M[10]!*v[2]!+M[14]!)];})as unknown as FacadeTriangle;
}
export interface DuplicateSkirtSelection {node:string;primitive:number;triangles:readonly {index:number;key:string}[];quads:readonly DuplicateSkirtQuad[]}
/** Only the exact generated four-triangle, one-texel palette recipe is eligible. */
export function findDuplicateSkirts(doc:Document,buildings:readonly {id:string;faces:readonly SkirtSourceFace[];minimumY:number}[]){
 const selections:DuplicateSkirtSelection[]=[],census:any[]=[],drawnKeys=new Set<string>();for(const n of doc.getRoot().listNodes())for(const p of n.getMesh()?.listPrimitives()??[])for(let t=0;t<p.getIndices()!.getCount()/3;t++)drawnKeys.add(facadeTriangleKey(nativeSkirtWorldTriangle(n,p,t)));
 for(const n of doc.getRoot().listNodes())for(const[pi,p]of(n.getMesh()?.listPrimitives()??[]).entries()){
  if(!/_flat$/.test(n.getName()))continue;assert.deepEqual(n.getWorldMatrix(),[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);assert.equal(p.getMode(),4);assert.ok(p.getAttribute('TEXCOORD_0'));assert.ok(p.getMaterial()?.getName().includes('palette'),'Generated skirts require the native palette material');
  const count=p.getIndices()!.getCount()/3,triangles=Array.from({length:count},(_,t)=>nativeSkirtWorldTriangle(n,p,t)),keys=triangles.map(facadeTriangleKey),lookup=new Map<string,number[]>(),selected=new Set<number>(),quads:DuplicateSkirtQuad[]=[];keys.forEach((key,t)=>lookup.set(key,[...(lookup.get(key)??[]),t]));
  const sourceKeys=new Set(buildings.flatMap(b=>b.faces.map(f=>f.key)));
  for(const building of buildings)for(const edge of sourceSkirtEdges(building.faces,building.minimumY)){
   const a=edge.slice(0,3),b=edge.slice(3),candidates=new Set<number>();for(const t of triangles){if(!t.some(v=>equal(v,a))||!t.some(v=>equal(v,b)))continue;for(const v of t)if(v[0]===b[0]&&v[2]===b[2]&&v[1]>Math.max(a[1]!,b[1]!))candidates.add(v[1]);}
   for(const bottom of candidates){const quad=generatedSkirtQuad(edge,bottom),matches=quad.keys.map(key=>lookup.get(key)??[]);if(!matches.every(a=>a.length===1)){census.push({building:building.id,edge,bottom,status:'HELD_GENERATED_QUARTET_ABSENT_OR_AMBIGUOUS'});continue;}
    const ids=matches.map(a=>a[0]!);if(ids.some(t=>selected.has(t)))continue;if(new Set(ids).size!==4){census.push({building:building.id,edge,bottom,status:'HELD_DEGENERATE_GENERATED_QUARTET'});continue;}const proof=qualifyDuplicateUpwardSkirt(edge,bottom,building.faces.filter(f=>drawnKeys.has(f.key)));if(!proof){census.push({building:building.id,edge,bottom,status:'HELD_NATIVE_WALL_EXACT_COVERAGE_NOT_PROVEN'});continue;}
    if(quad.keys.some(key=>sourceKeys.has(key))){census.push({building:building.id,edge,bottom,status:'HELD_NATIVE_SOURCE_TRIANGLE_KEY_OVERLAP'});continue;}const uv=p.getAttribute('TEXCOORD_0')!,I=p.getIndices()!,texels=ids.flatMap(t=>[0,1,2].map(k=>uv.getElement(I.getScalar(t*3+k),[])));if(!texels.every(v=>equal(v,texels[0]!))){census.push({building:building.id,edge,bottom,status:'HELD_NONCONSTANT_PALETTE_TEXEL'});continue;}
    ids.forEach(t=>selected.add(t));quads.push(proof);census.push({building:building.id,edge,bottom,status:'EXACT_GENERATED_UPWARD_QUAD_REDUNDANT_INSIDE_NATIVE_WALL',keys:quad.keys,projectedArea:proof.projectedArea});
   }
  }
  if(selected.size)selections.push({node:n.getName(),primitive:pi,triangles:[...selected].sort((a,b)=>a-b).map(index=>({index,key:keys[index]!})),quads});
 }return{selections,census};
}
