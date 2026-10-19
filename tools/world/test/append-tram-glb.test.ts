import {test} from 'node:test';
import assert from 'node:assert/strict';
import {NodeIO} from '@gltf-transform/core';
import {ALL_EXTENSIONS} from '@gltf-transform/extensions';
import {MeshoptDecoder} from 'meshoptimizer';
import {GlbBuilder,flatNormals} from '../lib/gltf.ts';
import {readFacadeGlb} from '../lib/facade-glb.ts';
import {appendTramVisualGlb} from '../lib/append-tram-glb.ts';
import type {TramMesh} from '../lib/tram-visuals.ts';

const mesh:TramMesh={positions:[.1,.003,.5,.9,.003,.5,.9,.003,.56],normals:[0,1,0,0,1,0,0,1,0],colours:[.49,.52,.54,.49,.52,.54,.49,.52,.54],uvs:[20/44,.5,20/44,.5,1,.5],indices:[0,2,1],bindings:[],stats:{expectedArea:.024,coveredArea:.024,missingArea:0,maximumLiftError:0,triangles:1}};
async function fixture(coarse=false,coarseMeshes=1){
 const builder=new GlbBuilder('fixture'),positions=new Float32Array([0,0,0,1,0,0,1,0,1]),indices=new Uint32Array([0,2,1]);
 for(const name of coarse?Array.from({length:coarseMeshes},(_,i)=>i?'append2:coarse':'coarse'):['source_ground_slabs','protected_building'])await builder.addMesh({name,positions,indices,normals:flatNormals(positions,indices),materialName:'stone'},{name:'stone',unlit:false});
 if(coarse)for(const mesh of builder.doc.getRoot().listMeshes())mesh.listPrimitives()[0]!.setAttribute('COLOR_0',builder.doc.createAccessor().setType('VEC3').setBuffer(builder.doc.getRoot().listBuffers()[0]!).setArray(new Float32Array(9).fill(.4)));
 const bytes=await builder.toGlb('source-copyright',{},'exact');await MeshoptDecoder.ready;const io=new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.decoder':MeshoptDecoder});return{bytes,io};
}
test('detailed rail append retains every old accessor/image/material/node/BIN byte and adds one decoded draw',async()=>{
 const{bytes,io}=await fixture(),next=await appendTramVisualGlb(bytes,mesh,{cell:'test',coarse:false}),a=readFacadeGlb(bytes),b=readFacadeGlb(next),j=a.json as any,k=b.json as any;
 assert.deepEqual(b.bin.subarray(0,a.bin.length),a.bin);
 for(const key of ['accessors','bufferViews','images','textures','materials','nodes','meshes'])assert.deepEqual((k[key]??[]).slice(0,(j[key]??[]).length),j[key]??[]);
 const old=await io.readBinary(bytes),decoded=await io.readBinary(next);assert.equal(decoded.getRoot().listMeshes().length,old.getRoot().listMeshes().length+1);assert.equal(decoded.getRoot().listMaterials().length,old.getRoot().listMaterials().length+1);
 for(const node of old.getRoot().listNodes()){const nn=decoded.getRoot().listNodes().find(n=>n.getName()===node.getName())!;assert.deepEqual(nn.getMatrix(),node.getMatrix());const p=node.getMesh()!.listPrimitives()[0]!,q=nn.getMesh()!.listPrimitives()[0]!;for(const s of p.listSemantics())assert.deepEqual(q.getAttribute(s)!.getArray(),p.getAttribute(s)!.getArray());assert.deepEqual(q.getIndices()!.getArray(),p.getIndices()!.getArray());}
 const rail=decoded.getRoot().listNodes().find(n=>n.getName()==='test_tram_visuals')!.getMesh()!.listPrimitives()[0]!;assert.deepEqual(rail.getAttribute('POSITION')!.getArray(),Float32Array.from(mesh.positions));assert.deepEqual(rail.getAttribute('TEXCOORD_0')!.getArray(),Float32Array.from(mesh.uvs));assert.equal(decoded.getRoot().listTextures().length,old.getRoot().listTextures().length+1);
 await assert.rejects(appendTramVisualGlb(next,mesh,{cell:'test',coarse:false}),/already appended/);
});
test('coarse append preserves original typed-array prefixes and keeps exact node/material/primitive counts',async()=>{
 const{bytes,io}=await fixture(true),next=await appendTramVisualGlb(bytes,mesh,{cell:'test',coarse:true}),a=await io.readBinary(bytes),b=await io.readBinary(next);
 assert.equal(b.getRoot().listNodes().length,a.getRoot().listNodes().length);assert.equal(b.getRoot().listMaterials().length,a.getRoot().listMaterials().length);
 const p=a.getRoot().listMeshes()[0]!.listPrimitives()[0]!,q=b.getRoot().listMeshes()[0]!.listPrimitives()[0]!;
 for(const s of p.listSemantics()){const old=p.getAttribute(s)!.getArray()!,current=q.getAttribute(s)!.getArray()!;assert.deepEqual(current.subarray(0,old.length),old);}
 assert.equal(b.getRoot().listMeshes()[0]!.listPrimitives().length,1);assert.equal(q.getIndices()!.getCount(),p.getIndices()!.getCount()+3);
 assert.deepEqual(readFacadeGlb(next).bin.subarray(0,readFacadeGlb(bytes).bin.length),readFacadeGlb(bytes).bin);
});
test('a second disjoint rail phase preserves the first and rejects repeated or partial overlapping footprints',async()=>{
 const{bytes,io}=await fixture(),first=await appendTramVisualGlb(bytes,mesh,{cell:'test',coarse:false});
 const shifted=(z:number):TramMesh=>({...mesh,positions:mesh.positions.map((v,i)=>i%3===2?v+z:v)});
 const second=await appendTramVisualGlb(first,shifted(1),{cell:'test',coarse:false}),a=readFacadeGlb(first),b=readFacadeGlb(second);
 for(const key of ['accessors','bufferViews','images','textures','materials','nodes','meshes'])assert.deepEqual(((b.json as any)[key]??[]).slice(0,((a.json as any)[key]??[]).length),(a.json as any)[key]??[]);
 assert.deepEqual(b.bin.subarray(0,a.bin.length),a.bin);
 const doc=await io.readBinary(second);assert.ok(doc.getRoot().listNodes().some(n=>n.getName()==='test_tram_visuals'));assert.ok(doc.getRoot().listNodes().some(n=>n.getName()==='append2:test_tram_visuals'));
 await assert.rejects(appendTramVisualGlb(second,shifted(1),{cell:'test',coarse:false}),/already appended/);
 await assert.rejects(appendTramVisualGlb(second,shifted(.01),{cell:'test',coarse:false}),/overlaps/);
 const third=await appendTramVisualGlb(second,shifted(2),{cell:'test',coarse:false});assert.ok((await io.readBinary(third)).getRoot().listNodes().some(n=>n.getName()==='append3:test_tram_visuals'));
});
test('an appended two-mesh coarse cell retains every mesh/draw and grows one compatible primitive only',async()=>{
 const{bytes,io}=await fixture(true,2),before=await io.readBinary(bytes),next=await appendTramVisualGlb(bytes,mesh,{cell:'test',coarse:true}),after=await io.readBinary(next);
 assert.equal(after.getRoot().listMeshes().length,2);assert.equal(after.getRoot().listNodes().length,before.getRoot().listNodes().length);assert.equal(after.getRoot().listMaterials().length,before.getRoot().listMaterials().length);
 let grown=0;for(const old of before.getRoot().listNodes()){const node=after.getRoot().listNodes().find(n=>n.getName()===old.getName())!,a=old.getMesh()!.listPrimitives()[0]!,b=node.getMesh()!.listPrimitives()[0]!;assert.deepEqual(node.getWorldMatrix(),old.getWorldMatrix());for(const s of a.listSemantics()){const aa=a.getAttribute(s)!.getArray()!,bb=b.getAttribute(s)!.getArray()!;assert.deepEqual(bb.subarray(0,aa.length),aa);}const oldI=a.getIndices()!.getArray()!,newI=b.getIndices()!.getArray()!;assert.deepEqual(newI.subarray(0,oldI.length),oldI);if(newI.length>oldI.length){assert.equal(newI.length,oldI.length+3);grown++;}}
 assert.equal(grown,1);assert.deepEqual(readFacadeGlb(next).bin.subarray(0,readFacadeGlb(bytes).bin.length),readFacadeGlb(bytes).bin);
});
