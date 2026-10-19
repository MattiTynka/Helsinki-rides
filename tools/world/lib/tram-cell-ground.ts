import assert from 'node:assert/strict';
import type {Document} from '@gltf-transform/core';
import type {CollisionBundle} from '../../../packages/world-schema/src/index.ts';
import type {TramGroundTriangle,TramVertex} from './tram-visuals.ts';

const IDENTITY=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
export const tramTriangleKey=(vertices:readonly (readonly number[])[])=>vertices.map(p=>p.map(Math.fround).join(',')).sort().join('|');
export function tramGroundTriangleMultiset(doc:Document):string[]{
  const result:string[]=[];
  for(const node of doc.getRoot().listNodes()){
    if(!/_ground_(slabs|cobble|asphalt|grass|setts|yard)$/.test(node.getName())||!node.getMesh())continue;
    assert.deepEqual(node.getWorldMatrix(),IDENTITY);
    for(const p of node.getMesh()!.listPrimitives()){
      const pos=p.getAttribute('POSITION'),index=p.getIndices();assert.ok(pos&&index&&p.getMode()===4);
      for(let i=0;i<index.getCount();i+=3){const points=[0,1,2].map(k=>pos.getElement(index.getScalar(i+k),[]).map(Math.fround).join(','));result.push([points.join('|'),[points[1],points[2],points[0]].join('|'),[points[2],points[0],points[1]].join('|')].sort()[0]!);}
    }
  }
  return result.sort();
}
export function upwardTramTriangle(vertices:[TramVertex,TramVertex,TramVertex]) {
  const[a,b,c]=vertices,u=b.map((v,i)=>v-a[i]!),v=c.map((n,i)=>n-a[i]!);
  const n=[u[1]!*v[2]!-u[2]!*v[1]!,u[2]!*v[0]!-u[0]!*v[2]!,u[0]!*v[1]!-u[1]!*v[0]!],length=Math.hypot(...n);
  return length>0&&n[1]!/length>.3;
}
/** Bind every qualifying support face to the actual rendered and collision
 * triangle coordinates. Raw terrain, source-only surfaces and building roofs
 * cannot authorize rail placement. */
export function readTramGround(doc:Document,bundle:CollisionBundle):TramGroundTriangle[] {
  const collision=new Map<string,{collider:string;triangles:number[];tag:string}>();
  for(const item of bundle.colliders){
    if(item.group!=='ground')continue;
    for(let triangle=0;triangle<item.indices.length/3;triangle++){
      const vertices=[0,1,2].map(k=>Array.from(item.positions.subarray(item.indices[triangle*3+k]!*3,item.indices[triangle*3+k]!*3+3)) as TramVertex) as [TramVertex,TramVertex,TramVertex];
      if(!upwardTramTriangle(vertices))continue;
      const key=tramTriangleKey(vertices),tag=bundle.header.surfaceTags[item.triangleTags[triangle]!]!;
      const old=collision.get(key);if(old){assert.equal(old.collider,item.id,'Ambiguous source collider ownership');old.tag=[...new Set([...old.tag.split('|'),tag])].sort().join('|');old.triangles.push(triangle);}
      else collision.set(key,{collider:item.id,triangles:[triangle],tag});
    }
  }
  const result:TramGroundTriangle[]=[];
  for(const node of doc.getRoot().listNodes()){
    if(!/_ground_(slabs|cobble|asphalt|grass|setts|yard)$/.test(node.getName())||!node.getMesh())continue;
    assert.deepEqual(node.getWorldMatrix(),IDENTITY,'Ground rail support must retain identity world transform');
    for(const[primitive,p]of node.getMesh()!.listPrimitives().entries()){
      const positions=p.getAttribute('POSITION'),indices=p.getIndices();assert.ok(positions&&indices&&p.getMode()===4);
      for(let triangle=0;triangle<indices.getCount()/3;triangle++){
        const vertices=[0,1,2].map(k=>positions.getElement(indices.getScalar(triangle*3+k),[]) as unknown as TramVertex) as [TramVertex,TramVertex,TramVertex];
        if(!upwardTramTriangle(vertices))continue;
        const match=collision.get(tramTriangleKey(vertices));
        // Collision-only or visual-only pieces remain unresolved, never a new
        // synthesized support floor. The planner reports missing ribbon area.
        if(!match)continue;
        result.push({id:`${node.getName()}:${primitive}:${triangle}`,vertices,visual:{node:node.getName(),primitive,triangle},collision:{collider:match.collider,triangles:match.triangles},tag:match.tag});
      }
    }
  }
  return result;
}
export function proveTramGroundInTier(doc:Document,ground:readonly TramGroundTriangle[]) {
  const required=new Set(ground.map(t=>tramTriangleKey(t.vertices))),found=new Set<string>();
  for(const node of doc.getRoot().listNodes()){
    if(!node.getMesh())continue;
    for(const p of node.getMesh()!.listPrimitives()){
      const position=p.getAttribute('POSITION'),index=p.getIndices();if(!position||!index||p.getMode()!==4)continue;
      // Source ground uses identity nodes. Other transformed city meshes cannot
      // accidentally stand in for a missing coarse ground face.
      if(!node.getWorldMatrix().every((x,i)=>x===IDENTITY[i]))continue;
      for(let t=0;t<index.getCount();t+=3){const vertices=[0,1,2].map(k=>position.getElement(index.getScalar(t+k),[]));const key=tramTriangleKey(vertices);if(required.has(key))found.add(key);}
    }
  }
  return {required:required.size,found:found.size,missing:[...required].filter(key=>!found.has(key))};
}
