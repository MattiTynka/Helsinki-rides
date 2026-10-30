import assert from 'node:assert/strict';
import type {Document} from '@gltf-transform/core';
import {encodeCollisionBundle, parseCollisionBundle, type Vec3} from '../../../packages/world-schema/src/index.ts';
import {replaceGroundGlb, type GroundAttributeArray, type GroundGlbReplacement} from './replace-ground-glb.ts';
import {deliveryGeometryStats} from './delivery-city-payloads.ts';

export interface MeasuredGroundFace {
  cell: string; kind: 'pieces' | 'kerbs'; tag: string; finish: string;
  use: 'both' | 'visual' | 'collision'; before: Vec3[]; after: Vec3[];
}
export const measuredFaceKey = (points: readonly (readonly number[])[]) => points.map(p => p.map(Math.fround).join(',')).sort().join('|');
const vertexKey = (p: readonly number[]) => p.map(Math.fround).join(',');
function normal(p: readonly (readonly number[])[]) {
  const [a,b,c]=p, u=b!.map((v,i)=>v-a![i]!), v=c!.map((n,i)=>n-a![i]!);
  const n=[u[1]!*v[2]!-u[2]!*v[1]!,u[2]!*v[0]!-u[0]!*v[2]!,u[0]!*v[1]!-u[1]!*v[0]!], length=Math.hypot(...n);
  assert.ok(length>0,'Discarded zero-area native faces must remain absent'); return n.map(v=>v/length);
}
export function validateMeasuredGroundFaces(faces: readonly MeasuredGroundFace[], region: readonly [number,number,number,number], acceptedBounds: readonly [number,number,number,number]) {
  assert.ok([...region,...acceptedBounds].every(Number.isFinite)&&region[0]<region[2]&&region[1]<region[3]&&acceptedBounds[0]<acceptedBounds[2]&&acceptedBounds[1]<acceptedBounds[3]);
  // Vertex-only exclusion misses a triangle spanning the protected interior. The
  // whole reviewed patch must be separated, including its piecewise boundary.
  assert.ok(region[2]<acceptedBounds[0]||region[0]>acceptedBounds[2]||region[3]<acceptedBounds[1]||region[1]>acceptedBounds[3],'Measured patch region intersects protected accepted city');
  assert.ok(faces.length>0&&faces.length<=5000);const map=new Map<string,{after:Vec3[];tags:Set<string>}>();
  for(const f of faces){assert.equal(f.before.length,3);assert.equal(f.after.length,3);assert.ok(['pieces','kerbs'].includes(f.kind)&&['both','visual','collision'].includes(f.use));
    for(let i=0;i<3;i++){const a=f.before[i]!,b=f.after[i]!;assert.ok(a.length===3&&b.length===3&&[...a,...b].every(Number.isFinite));assert.ok(a.every(v=>Math.fround(v)===v)&&b.every(v=>Math.fround(v)===v),'Exact serialized Float32 coordinates required');assert.ok(a[0]===b[0]&&a[2]===b[2],'Measured correction cannot move horizontal geometry');assert.ok(b[1]>=a[1]&&b[1]-a[1]<=1.5,'Only the reviewed bounded upward correction is supported');assert.ok(a[0]>=region[0]&&a[0]<=region[2]&&a[2]>=region[1]&&a[2]<=region[3]);assert.ok(a[0]<acceptedBounds[0]||a[0]>acceptedBounds[2]||a[2]<acceptedBounds[1]||a[2]>acceptedBounds[3],'Protected accepted city cannot be changed');}
    normal(f.before);normal(f.after);const key=measuredFaceKey(f.before),old=map.get(key);if(old){assert.equal(measuredFaceKey(old.after),measuredFaceKey(f.after),'Conflicting target for the same native face');old.tags.add(f.tag);}else map.set(key,{after:f.after,tags:new Set([f.tag])});
  }return map;
}
function selectedFaces(faces: readonly MeasuredGroundFace[], visual: boolean) {
  const result=new Map<string,{vertices:Map<string,Vec3>;tags:Set<string>}>();
  for(const f of faces.filter(f=>visual?f.use!=='collision':f.use!=='visual')){const key=measuredFaceKey(f.before),record=result.get(key)??{vertices:new Map<string,Vec3>(),tags:new Set<string>()};for(let i=0;i<3;i++){const before=vertexKey(f.before[i]!),after=f.after[i]!;if(record.vertices.has(before))assert.deepEqual(record.vertices.get(before),after);record.vertices.set(before,after);}record.tags.add(f.tag);result.set(key,record);}return result;
}
export function replaceMeasuredGroundCollision(bytes: Uint8Array, faces: readonly MeasuredGroundFace[]) {
  const old=parseCollisionBundle(bytes),expected=selectedFaces(faces,false),found=new Set<string>(),proofs:unknown[]=[];
  const colliders=old.colliders.map(c=>{
    if(c.group!=='ground'&&c.group!=='kerbs')return c;
    const positions=Array.from(c.positions),indices=Uint32Array.from(c.indices);let changed=0;
    for(let t=0;t<c.indices.length;t+=3){const points=Array.from(c.indices.subarray(t,t+3),id=>Array.from(c.positions.subarray(id*3,id*3+3)) as Vec3),key=measuredFaceKey(points),target=expected.get(key);if(!target)continue;
      assert.ok(target.tags.has(old.header.surfaceTags[c.triangleTags[t/3]!]!),'Current collision surface differs from native source');const next=points.map(p=>target.vertices.get(vertexKey(p))!);assert.ok(next.every(Boolean));
      for(let k=0;k<3;k++){indices[t+k]=positions.length/3;positions.push(...next[k]!);}found.add(key);changed++;proofs.push({collider:c.id,triangle:t/3,before:points,after:next});
    }
    return changed?{...c,positions:Float32Array.from(positions),indices}:c;
  });
  assert.equal(found.size,expected.size,'Current HCOL is missing an exact qualified native face');const output=encodeCollisionBundle(old.header,colliders),after=parseCollisionBundle(output);
  // Buffer offsets and position counts change; world identity and surface tags do not.
  const {colliders: oldLayout,...oldIdentity}=old.header,{colliders: newLayout,...newIdentity}=after.header;
  assert.deepEqual(newIdentity,oldIdentity);
  for(let i=0;i<old.colliders.length;i++){const a=old.colliders[i]!,b=after.colliders[i]!;assert.deepEqual(b.positions.subarray(0,a.positions.length),a.positions);assert.deepEqual(b.triangleTags,a.triangleTags);assert.equal(b.indices.length,a.indices.length);if(!['ground','kerbs'].includes(a.group))assert.deepEqual(b,a);}
  return {bytes:output,proofs,matchedNativeFaces:found.size};
}

export async function replaceMeasuredGroundVisual(bytes: Uint8Array, doc: Document, faces: readonly MeasuredGroundFace[], coarse: boolean) {
  const expected=selectedFaces(faces,true),found=new Set<string>(),replacements:GroundGlbReplacement[]=[],proofs:unknown[]=[];
  for(const node of doc.getRoot().listNodes())if(node.getMesh()&&(coarse||node.getName().includes('_ground_'))){
    assert.deepEqual(node.getWorldMatrix(),[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);
    for(const[primitiveIndex,p]of node.getMesh()!.listPrimitives().entries()){
      const position=p.getAttribute('POSITION'),index=p.getIndices();assert.ok(position&&index&&position.getArray() instanceof Float32Array&&p.getMode()===4);
      const original=Object.fromEntries(p.listSemantics().map(s=>[s,p.getAttribute(s)!.getArray()! as GroundAttributeArray])),appended=Object.fromEntries(p.listSemantics().map(s=>[s,[] as number[]])),indices=Uint32Array.from(index.getArray()!);let vertices=position.getCount(),changed=0;
      for(let t=0;t<index.getCount();t+=3){const ids=[0,1,2].map(k=>index.getScalar(t+k)),points=ids.map(i=>position.getElement(i,[]) as unknown as Vec3),key=measuredFaceKey(points),target=expected.get(key);if(!target)continue;
        const next=points.map(v=>target.vertices.get(vertexKey(v))!);assert.ok(next.every(Boolean));const n=normal(next);
        for(let k=0;k<3;k++){indices[t+k]=vertices++;for(const semantic of p.listSemantics()){const accessor=p.getAttribute(semantic)!,count=accessor.getElementSize(),array=original[semantic]!;let values=Array.from(array.subarray(ids[k]!*count,ids[k]!*count+count));if(semantic==='POSITION')values=[...next[k]!];else if(semantic==='NORMAL'){const scale=accessor.getNormalized()?(array instanceof Int8Array?127:array instanceof Int16Array?32767:0):1;assert.ok(scale,'Unsupported native normal representation');values=n.map(v=>scale===1?v:Math.round(v*scale));}appended[semantic]!.push(...values);}}
        found.add(key);changed++;proofs.push({node:node.getName(),primitive:primitiveIndex,triangle:t/3,before:points,after:next});
      }
      if(!changed)continue;const attributes:Record<string,GroundAttributeArray>={};for(const semantic of p.listSemantics()){const array=original[semantic]!,Type=array.constructor as {new(n:number):GroundAttributeArray},next=new Type(array.length+appended[semantic]!.length);next.set(array);next.set(appended[semantic]!,array.length);attributes[semantic]=next;}
      replacements.push({nodeName:node.getName(),primitiveIndex,...(coarse?{kind:'distant-ground' as const}:{}),attributes,indices});
    }
  }
  assert.equal(found.size,expected.size,'Current visual tier is missing an exact qualified native face');const output=await replaceGroundGlb(bytes,replacements),beforeStats=deliveryGeometryStats(bytes),afterStats=deliveryGeometryStats(output);assert.equal(afterStats.triangles,beforeStats.triangles);assert.equal(afterStats.drawCalls,beforeStats.drawCalls);
  return {bytes:output,proofs,matchedNativeFaces:found.size,stats:afterStats};
}
