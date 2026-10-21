import {test} from 'node:test';
import assert from 'node:assert/strict';
import {NodeIO} from '@gltf-transform/core';
import {ALL_EXTENSIONS} from '@gltf-transform/extensions';
import {MeshoptDecoder} from 'meshoptimizer';
import {GlbBuilder} from '../lib/gltf.ts';
import {appendGroundGlb} from '../lib/append-ground-glb.ts';
import {readFacadeGlb} from '../lib/facade-glb.ts';

async function fixture(){
  const builder=new GlbBuilder('filter'),positions=new Float32Array([0,0,0,1,0,0,1,0,1,0,0,1]),indices=new Uint32Array([0,2,1,0,3,2]);
  for(const name of ['selected','unrelated'])await builder.addMesh({name,positions,indices,materialName:'water'},{name:'water',unlit:false});
  const bytes=await builder.toGlb('fixture',{},'exact');await MeshoptDecoder.ready;
  const io=new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.decoder':MeshoptDecoder}),doc=await io.readBinary(bytes),p=doc.getRoot().listNodes().find(n=>n.getName()==='selected')!.getMesh()!.listPrimitives()[0]!;
  const add={nodeName:'selected',primitiveIndex:0,attributes:{POSITION:{original:p.getAttribute('POSITION')!.getArray()!as Float32Array,appended:[0,0,0,.5,0,.5,1,0,0]}},indices:{original:p.getIndices()!.getArray()!as Uint32Array,appended:[4,5,6],retainedTriangles:[1]}};
  return{bytes,io,doc,p,add};
}
test('source triangle filtering and appended clipped faces share the existing draw without altering other meshes or source buffers',async()=>{
  const{bytes,io,doc,p,add}=await fixture(),out=await appendGroundGlb(bytes,[add]),a=readFacadeGlb(bytes),b=readFacadeGlb(out),next=await io.readBinary(out);
  assert.deepEqual(b.bin.subarray(0,a.bin.length),a.bin);assert.equal(next.getRoot().listNodes().filter(n=>n.getMesh()).length,2);
  const q=next.getRoot().listNodes().find(n=>n.getName()==='selected')!.getMesh()!.listPrimitives()[0]!;
  assert.deepEqual(Array.from(q.getIndices()!.getArray()!),[...p.getIndices()!.getArray()!.subarray(3),4,5,6]);
  assert.deepEqual(q.getAttribute('POSITION')!.getArray()!.subarray(0,12),p.getAttribute('POSITION')!.getArray());
  const other=(d:typeof doc)=>d.getRoot().listNodes().find(n=>n.getName()==='unrelated')!.getMesh()!.listPrimitives()[0]!;
  assert.deepEqual(other(next).getIndices()!.getArray(),other(doc).getIndices()!.getArray());
  assert.deepEqual(other(next).getAttribute('POSITION')!.getArray(),other(doc).getAttribute('POSITION')!.getArray());
});
test('duplicate, reordered, negative, fractional and absent source triangle ordinals are rejected',async()=>{
  const{bytes,add}=await fixture();for(const retainedTriangles of [[1,1],[1,0],[-1],[.5],[2]])await assert.rejects(appendGroundGlb(bytes,[{...add,indices:{...add.indices,retainedTriangles}}]),/unique ordered source/);
});
