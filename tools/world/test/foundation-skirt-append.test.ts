import assert from 'node:assert/strict';
import {test} from 'node:test';
import {NodeIO} from '@gltf-transform/core';
import {ALL_EXTENSIONS} from '@gltf-transform/extensions';
import {MeshoptDecoder} from 'meshoptimizer';
import {GlbBuilder,flatNormals} from '../lib/gltf.ts';
import {appendFoundationSkirts,type BoundFoundationRepair} from '../lib/foundation-skirt-append.ts';
import {frontierTriangleKey} from '../lib/frontier-ground.ts';
import {readFacadeGlb} from '../lib/facade-glb.ts';
async function decoder(){await MeshoptDecoder.ready;return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.decoder':MeshoptDecoder});}
async function fixture(shared=false,displacedCoarse=false){
 const positions=new Float32Array([128,2,0,130,2,0,130,4,0]),indices=new Uint32Array([0,1,2]),builder=new GlbBuilder('source');await builder.addMesh({name:'source_palette',positions,indices,normals:flatNormals(positions,indices),uvs:new Float32Array([.5,.25,.5,.25,.5,.25]),materialName:'source_palette'},{name:'source_palette',unlit:false,texture:{width:2,height:2,data:new Uint8Array(16).fill(175)}});
 await builder.addMesh({name:'cell_ground_slabs',positions:new Float32Array([128,0,-1,130,0,-1,130,0,1]),indices,normals:new Float32Array([0,1,0,0,1,0,0,1,0]),uvs:new Float32Array([0,0,1,0,1,1]),materialName:'ground'},{name:'ground',unlit:false});
 if(shared){const root=builder.doc.getRoot(),original=root.listNodes().find(n=>n.getName()==='source_palette')!;root.listScenes()[0]!.addChild(builder.doc.createNode('other_instance').setMesh(original.getMesh()));}
 const lod0=await builder.toGlb('test',{},'exact'),coarse=new GlbBuilder('distant');await coarse.addMesh({name:'cell',positions:Float32Array.from(positions,(v,i)=>displacedCoarse&&i%3===1?v+.5:v),indices,materialName:'vertex-colour'},{name:'vertex-colour',unlit:true});const p=coarse.doc.getRoot().listMeshes()[0]!.listPrimitives()[0]!;p.setAttribute('COLOR_0',coarse.doc.createAccessor().setBuffer(coarse.doc.getRoot().listBuffers()[0]!).setType('VEC3').setArray(new Float32Array([.4,.4,.4,.4,.4,.4,.4,.4,.4])));const lod2=await coarse.toGlb('test',{cell:'cell',level:'distant'},'exact'),io=await decoder(),d=await io.readBinary(lod0),source=d.getRoot().listNodes().find(n=>n.getName()==='source_palette')!.getMesh()!.listPrimitives()[0]!,I=source.getIndices()!,P=source.getAttribute('POSITION')!,U=source.getAttribute('TEXCOORD_0')!,corners=[0,1,2].map(k=>P.getElement(I.getScalar(k),[]));
 const uv=U.getElement(0,[]),repair:BoundFoundationRepair={building:'source-building',vtj:'source-vtj',cell:'cell',node:'source_palette',primitive:0,triangle:0,sourceTriangleKey:frontierTriangleKey(corners),materialName:'source_palette',edgeRuntime:[[128,2,0],[130,2,0]],uv:[uv,uv] as any,exterior:[0,1],reason:'Bounded exact fixture skirt'};
 return{lod0,lod2,repair,io};
}
test('visual foundation append preserves all old data/ground while packing exact palette UV and distant colour',async()=>{
 const f=await fixture(),a=f.lod0.slice(),b=f.lod2.slice(),result=await appendFoundationSkirts(f.lod0,f.lod2,[f.repair],()=>0);assert.deepEqual(f.lod0,a);assert.deepEqual(f.lod2,b);assert.equal(result.addedTriangles,16);assert.equal(result.audits[0]!.maximumNormalY,0);assert.equal(result.groundArraysUnchanged,true);
 const before=await f.io.readBinary(a),after=await f.io.readBinary(result.lod0),p=after.getRoot().listNodes().find(n=>n.getName()==='source_palette')!.getMesh()!.listPrimitives()[0]!,old=before.getRoot().listNodes().find(n=>n.getName()==='source_palette')!.getMesh()!.listPrimitives()[0]!,U=p.getAttribute('TEXCOORD_0')!,raw=U.getArray()!,uv=old.getAttribute('TEXCOORD_0')!.getArray()!;for(let i=old.getAttribute('POSITION')!.getCount()*2;i<raw.length;i++)assert.equal(raw[i],uv[i%2]);const rawBefore=readFacadeGlb(a),rawAfter=readFacadeGlb(result.lod0);assert.deepEqual(rawAfter.bin.subarray(0,rawBefore.bin.length),rawBefore.bin);assert.deepEqual(rawAfter.json.images,rawBefore.json.images);assert.deepEqual(rawAfter.json.materials,rawBefore.json.materials);
 const groundBefore=before.getRoot().listNodes().find(n=>n.getName()==='cell_ground_slabs')!.getMesh()!.listPrimitives()[0]!,groundAfter=after.getRoot().listNodes().find(n=>n.getName()==='cell_ground_slabs')!.getMesh()!.listPrimitives()[0]!;for(const s of groundBefore.listSemantics())assert.deepEqual(groundAfter.getAttribute(s)!.getArray(),groundBefore.getAttribute(s)!.getArray());assert.deepEqual(groundAfter.getIndices()!.getArray(),groundBefore.getIndices()!.getArray());const validator=await import('gltf-validator');for(const bytes of[result.lod0,result.lod2]){const v=await validator.validateBytes(bytes);assert.equal(v.issues.numErrors,0,JSON.stringify(v.issues.messages));}
});
test('buried source geometry produces no bytes or faces and partially buried intervals are skipped',async()=>{
 const f=await fixture(),none=await appendFoundationSkirts(f.lod0,f.lod2,[f.repair],()=>3);assert.equal(none.addedTriangles,0);assert.deepEqual(none.lod0,f.lod0);assert.deepEqual(none.lod2,f.lod2);const part=await appendFoundationSkirts(f.lod0,f.lod2,[f.repair],x=>x<129?3:0);assert.ok(part.addedTriangles>0&&part.addedTriangles<16);
});
test('wrong source geometry/material/UV or absent dry support rejects the repair',async()=>{
 const f=await fixture();await assert.rejects(appendFoundationSkirts(f.lod0,f.lod2,[{...f.repair,sourceTriangleKey:'bad'}],()=>0),/triangle drift/);await assert.rejects(appendFoundationSkirts(f.lod0,f.lod2,[{...f.repair,uv:[[.1,.1],[.1,.1]]}],()=>0),/not present/);await assert.rejects(appendFoundationSkirts(f.lod0,f.lod2,[{...f.repair,materialName:'wrong'}],()=>0),/not present/);await assert.rejects(appendFoundationSkirts(f.lod0,f.lod2,[f.repair],()=>null),/lacks dry ground/);await assert.rejects(appendFoundationSkirts(f.lod0,f.lod2,[f.repair],()=>-20),/over 8m/);
});
test('source instances shared with another node are rejected rather than changed together',async()=>{
 const f=await fixture(true);await assert.rejects(appendFoundationSkirts(f.lod0,f.lod2,[f.repair],()=>0),/Shared source meshes/);
});
test('simplified distant skirts require explicit source-palette texel authority and preserve the old coarse geometry',async()=>{
 const f=await fixture(false,true);await assert.rejects(appendFoundationSkirts(f.lod0,f.lod2,[f.repair],()=>0),/explicit original palette/);const result=await appendFoundationSkirts(f.lod0,f.lod2,[{...f.repair,coarsePaletteTexel:{node:'cell',primitive:0}}],()=>0);assert.equal(result.addedTriangles,16);assert.equal(result.audits[0]!.coarseSourceTriangle,null);assert.ok((result.audits[0]!.colourBinding as {method:string}).method.includes('palette texel'));assert.ok(result.audits[0]!.sourceColour.every(Number.isFinite));
});
