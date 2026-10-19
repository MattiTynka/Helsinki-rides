import {test} from 'node:test';
import assert from 'node:assert/strict';
import {NodeIO} from '@gltf-transform/core';
import {ALL_EXTENSIONS} from '@gltf-transform/extensions';
import {MeshoptDecoder} from 'meshoptimizer';
import {GlbBuilder,flatNormals} from '../lib/gltf.ts';
import {appendGroundGlb} from '../lib/append-ground-glb.ts';
import {readFacadeGlb} from '../lib/facade-glb.ts';

test('append preserves original BIN, all original primitive arrays and material counts through actual meshopt decode',async()=>{
  const builder=new GlbBuilder('fixture'),positions=new Float32Array([0,1,0,1,1,0,1,0,0]),indices=new Uint32Array([0,1,2]);
  for(const name of ['ground','unrelated'])await builder.addMesh({name,positions,indices,normals:flatNormals(positions,indices),uvs:new Float32Array([0,0,1,0,1,1]),materialName:'stone'},{name:'stone',unlit:false});
  const before=await builder.toGlb('fixture',{},'exact');await MeshoptDecoder.ready;
  const io=new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.decoder':MeshoptDecoder});
  const doc=await io.readBinary(before),p=doc.getRoot().listNodes().find(n=>n.getName()==='ground')!.getMesh()!.listPrimitives()[0]!;
  const attributes=Object.fromEntries(p.listSemantics().map(s=>[s,{original:p.getAttribute(s)!.getArray()! as any,appended:s==='POSITION'?[0,1,0,1,0,0,0,0,0]:s==='NORMAL'?[0,0,127,0,0,127,0,0,127]:[0,0,1,1,0,1]}]));
  const count=p.getAttribute('POSITION')!.getCount(),bytes=await appendGroundGlb(before,[{nodeName:'ground',primitiveIndex:0,attributes,indices:{original:p.getIndices()!.getArray()! as any,appended:[count,count+1,count+2,count,count+2,count+1]}}]);
  const a=readFacadeGlb(before),b=readFacadeGlb(bytes);assert.deepEqual(b.bin.subarray(0,a.bin.length),a.bin);
  const decoded=await io.readBinary(bytes),q=decoded.getRoot().listNodes().find(n=>n.getName()==='ground')!.getMesh()!.listPrimitives()[0]!;
  for(const s of p.listSemantics())assert.deepEqual(q.getAttribute(s)!.getArray()!.subarray(0,p.getAttribute(s)!.getArray()!.length),p.getAttribute(s)!.getArray());
  assert.deepEqual(Array.from(q.getIndices()!.getArray()!),[...p.getIndices()!.getArray()!,count,count+1,count+2,count,count+2,count+1]);
  const unrelated=decoded.getRoot().listNodes().find(n=>n.getName()==='unrelated')!.getMesh()!.listPrimitives()[0]!;
  for(const s of p.listSemantics())assert.deepEqual(unrelated.getAttribute(s)!.getArray(),p.getAttribute(s)!.getArray());
  assert.equal(decoded.getRoot().listMaterials().length,doc.getRoot().listMaterials().length);
  assert.equal(decoded.getRoot().listTextures().length,doc.getRoot().listTextures().length);
});

test('missing or mismatched attribute growth fails before output',async()=>{
  const builder=new GlbBuilder('fixture'),positions=new Float32Array([0,1,0,1,1,0,1,0,0]),indices=new Uint32Array([0,1,2]);
  await builder.addMesh({name:'ground',positions,indices,materialName:'stone'},{name:'stone',unlit:false});
  const bytes=await builder.toGlb('fixture',{},'exact');
  await assert.rejects(appendGroundGlb(bytes,[{nodeName:'ground',primitiveIndex:0,attributes:{},indices:{original:indices,appended:[]}}]),/Every attribute/);
});
