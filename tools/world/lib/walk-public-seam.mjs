import assert from 'node:assert/strict';
import polygonClipping from 'polygon-clipping';
import {sourceSha256} from './source-files.ts';
const area=g=>g.reduce((s,p)=>s+p.reduce((n,r,i)=>n+(i?-1:1)*Math.abs(r.reduce((a,u,j)=>{const v=r[(j+1)%r.length];return a+u[0]*v[1]-u[1]*v[0];},0))/2,0),0);
const ring=p=>[[...p,p[0]]];
function distance(p,a,b){const x=b[0]-a[0],z=b[1]-a[1],d=x*x+z*z,t=d?Math.min(1,Math.max(0,((p[0]-a[0])*x+(p[1]-a[1])*z)/d)):0;return Math.hypot(p[0]-a[0]-x*t,p[1]-a[1]-z*t);}
/** A route-only source-registration seam, never a world/mask extension. Exact
 * named source boundaries and actual positive-area native floor must both bind it. */
export function qualifyPublicPavingSeam(gap,parts,scene){
 assert.deepEqual(parts.map(p=>p.id).sort((a,b)=>a-b),[58144,58145]);
 const vertices=gap.flat(2);assert.ok(vertices.length&&area(gap)<.0001);
 for(const p of vertices){assert.ok(p[0]>=-58&&p[0]<=-56&&p[1]>=10&&p[1]<=32,'Outside explicit Senate paving seam domain');
  for(const part of parts)assert.ok(Math.min(...part.geometry.flatMap(poly=>poly.flatMap(r=>r.slice(1).map((b,i)=>distance(p,r[i],b)))))<=.00001,'Gap is not between the two literal named source boundaries');}
 const bounds=[Math.min(...vertices.map(p=>p[0])),Math.min(...vertices.map(p=>p[1])),Math.max(...vertices.map(p=>p[0])),Math.max(...vertices.map(p=>p[1]))],faces=[],witnesses=[];
 for(const [handle,identity]of scene.identities){const c=scene.world.physics.getCollider(handle),base=scene.world.surfaceAt(handle,null);if(!['ground','kerb'].includes(base?.group))continue;const shape=c.shape,p=shape.vertices,indices=shape.indices;if(!p||!indices)continue;
  for(let i=0;i<indices.length;i+=3){const points=[indices[i],indices[i+1],indices[i+2]].map(k=>[p[k*3],p[k*3+1],p[k*3+2]]);const xy=points.map(v=>[v[0],v[2]]);if(Math.max(...xy.map(v=>v[0]))<bounds[0]||Math.min(...xy.map(v=>v[0]))>bounds[2]||Math.max(...xy.map(v=>v[1]))<bounds[1]||Math.min(...xy.map(v=>v[1]))>bounds[3])continue;
   const[a,b,d]=points,u=b.map((v,k)=>v-a[k]),v=d.map((n,k)=>n-a[k]),cross=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]],normal=cross[1]/Math.hypot(...cross),surface=scene.world.surfaceAt(handle,i/3);if(!(normal>=.6)||/water|sea|ocean/i.test(surface?.tag??''))continue;
   const overlap=polygonClipping.intersection(gap,ring(xy));if(!overlap.length||area(overlap)===0)continue;
   faces.push(ring(xy));witnesses.push({...identity,triangle:i/3,pointsSha256:sourceSha256(JSON.stringify(points)),tag:surface.tag});
  }
 }
 assert.ok(faces.length,'Paving seam has no native floor');const coverage=polygonClipping.union(faces[0],...faces.slice(1));assert.equal(area(polygonClipping.difference(gap,coverage)),0,'Paving seam is not completely covered by actual native floor');
 return{kind:'explicit-route-only-source-registration-seam',sourcePartIds:[58144,58145],sourcePartsSha256:sourceSha256(JSON.stringify(parts)),gap,gapAreaSquareMetres:area(gap),maximumBoundaryDistanceMetres:.00001,nativeFaces:witnesses,worldAndMaskUnmodified:true};
}
