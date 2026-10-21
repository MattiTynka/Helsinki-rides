import assert from 'node:assert/strict';
import polygonClipping from 'polygon-clipping';
import {layeredLocal,type LayeredLowerFieldSpec,type buildLayeredLowerField} from './layered-bridge-field.ts';
import type {LayeredSourcePart} from './layered-bridge-source.ts';
import {supportNormal,type SupportTriangle,type SupportVertex} from './tram-support-repair.ts';

/** A native 10mm skin can lie just outside its actual municipal floor ring.
 * Only the displacement sample is projected to that exact source boundary. */
export function mapLayeredBoundaryJoin(p:SupportVertex,parts:readonly LayeredSourcePart[],field:ReturnType<typeof buildLayeredLowerField>):SupportVertex{
 let closest={distance:Infinity,x:0,z:0};for(const part of parts)for(const ring of part.rings)for(let i=1;i<ring.length;i++){const a=ring[i-1]!,b=ring[i]!,dx=b[0]-a[0],dz=b[1]-a[1],length2=dx*dx+dz*dz;if(!length2)continue;const t=Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[2]-a[1])*dz)/length2)),x=a[0]+dx*t,z=a[1]+dz*t,distance=Math.hypot(x-p[0],z-p[2]);if(distance<closest.distance)closest={distance,x,z};}
 assert.ok(closest.distance<=.0250001,'Lower join lost exact municipal boundary authority');const[s,t]=layeredLocal(field.spec,[closest.x,0,closest.z]),top=field.source(s,t),dy=field.delta([closest.x,top+.001,closest.z]);assert.ok(dy<=0);return dy===0?p:[p[0],Math.fround(p[1]+dy),p[2]];
}

/** The distant mesh may use a different diagonal on a vertical native skin.
 * Qualify its full 3D source plane/coverage, never just an XZ or Y match. */
export function layeredJoinFaceMatches(triangle:SupportTriangle,faces:readonly SupportTriangle[]):boolean{
 let normal:SupportVertex;try{normal=supportNormal(triangle);}catch{return false;}const drop=normal.reduce((best,v,i)=>Math.abs(v)>Math.abs(normal[best]!)?i:best,0),project=(p:SupportVertex)=>p.filter((_,i)=>i!==drop) as [number,number],ring=triangle.map(project),area=(r:readonly [number,number][])=>Math.abs(r.reduce((n,a,i)=>{const b=r[(i+1)%r.length]!;return n+a[0]*b[1]-a[1]*b[0];},0))/2;if(area(ring)<1e-10)return false;
 const matching=faces.filter(face=>{let n:SupportVertex;try{n=supportNormal(face);}catch{return false;}if(Math.abs(n.reduce((sum,v,i)=>sum+v*normal[i]!,0))<.999999)return false;return triangle.every(p=>Math.abs(n.reduce((sum,v,i)=>sum+v*(p[i]!-face[0][i]!),0))<=.00001);}).map(face=>[face.map(project)]);if(!matching.length)return false;const remaining=polygonClipping.difference([[ring]],...matching);return remaining.reduce((sum,p)=>sum+area(p[0]!),0)<=1e-8;
}
