import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import path from 'node:path';
import {NodeIO} from '@gltf-transform/core';
import {ALL_EXTENSIONS} from '@gltf-transform/extensions';
import {MeshoptDecoder} from 'meshoptimizer';
import {validateBytes} from 'gltf-validator';
import {GlbBuilder,flatNormals,encodeKtx2} from '../lib/gltf.ts';
import {readFacadeGlb} from '../lib/facade-glb.ts';
import {pavingSha,pavingTriangleKey,type ResurfacingPlan,type SurfaceTarget} from '../lib/ground-resurfacing.ts';
import {inspectGroundSurfaces,matchResurfacingTier,resurfaceGroundGlb} from '../lib/ground-resurfacing-glb.ts';
import {originalPavingTexture} from '../lib/paving-textures.ts';
import {planGroundResurfacing,applyGroundResurfacing,assertJsonCertificateEqual} from '../resurface_ground.ts';

const h='a'.repeat(64),region={id:'stone',partIds:['1'],expectedMaterials:['Nupukivi'],existingFinishes:['setts' as const],pattern:'setts' as const,basis:{originXZ:[0,0] as [number,number],alongXZ:[1,0] as [number,number]},tileMetres:[2,1] as [number,number],referenceIds:['fixture']};
const plan:ResurfacingPlan={schemaVersion:1,id:'test',baseCellsIndexSha256:h,streetPartsSha256:h,originSha256:h,regions:[region],texture:{size:256,seed:20261018,stonesPerSide:10,jointMetres:.004},minimumNormalY:.7};
const image=originalPavingTexture(plan.texture);let encoded:Promise<Uint8Array>|undefined;
const texture=()=>encoded??=encodeKtx2(image,'facade');
const selected=[[0,0,0],[0,0,1],[1,0,0]],other=[[4,0,0],[4,0,1],[5,0,0]],wall=[[0,0,0],[0,.15,0],[1,0,0]];
await MeshoptDecoder.ready;const io=new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.decoder':MeshoptDecoder});
async function fixture(coarse=false,omitSelected=false,onlySelected=false){
  const b=new GlbBuilder('fixture'),P=Float32Array.from([...(omitSelected?other:selected).flat(),...(onlySelected?[]:[...other.flat(),...wall.flat()])]),I=Uint32Array.from({length:P.length/3},(_,i)=>i);
  await b.addMesh({name:coarse?'distant':'c_ground_setts',positions:P,indices:I,normals:flatNormals(P,I),uvs:Float32Array.from({length:18},()=>.5),materialName:'old-stone'},{name:'old-stone',unlit:coarse});
  if(coarse){const p=b.doc.getRoot().listMeshes()[0]!.listPrimitives()[0]!;p.setAttribute('COLOR_0',b.doc.createAccessor().setType('VEC3').setBuffer(b.doc.getRoot().listBuffers()[0]!).setArray(new Float32Array(P.length).fill(.4)));}
  return b.toGlb('original fixture',{},'exact');
}
async function target(bytes:Uint8Array):Promise<SurfaceTarget[]>{const rows=await inspectGroundSurfaces(bytes);const match=rows.find(t=>pavingTriangleKey(t.points)===pavingTriangleKey(selected as any));assert.ok(match);return [{node:match.node,primitive:match.primitive,triangle:match.triangle,key:pavingTriangleKey(match.points),region:'stone'}];}
test('JSON authority round-trip accepts source-edge signed zero while binary geometry keys remain strict',()=>{
  const key=pavingTriangleKey([[-0,0,0],[0,0,1],[1,0,0]]),otherKey=pavingTriangleKey([[0,0,0],[0,0,1],[1,0,0]]);assert.notEqual(key,otherKey);
  const recomputed={key,nativeCoverage:{fragments:[{sourceEdge:[[31.459228515625,-0],[31.459228135914305,-3.94921306989815e-7]]}]}},stored=JSON.parse(JSON.stringify(recomputed));
  assert.ok(Object.is(recomputed.nativeCoverage.fragments[0]!.sourceEdge[0]![1],-0));assert.equal(Object.is(stored.nativeCoverage.fragments[0].sourceEdge[0][1],-0),false);
  assert.throws(()=>assert.deepEqual(stored,recomputed));assert.doesNotThrow(()=>assertJsonCertificateEqual(stored,recomputed,'same JSON certificate'));
  assert.throws(()=>assertJsonCertificateEqual({...stored,key:otherKey},recomputed,'binary key changed'),/binary key changed/);
  const changed=structuredClone(stored);changed.nativeCoverage.fragments[0].sourceEdge[0][0]+=1e-9;assert.throws(()=>assertJsonCertificateEqual(changed,recomputed,'source coordinate changed'),/source coordinate changed/);
  assert.throws(()=>assertJsonCertificateEqual({distance:null},{distance:NaN},'invalid'),/Nonfinite/);
});
test('actual compressed ground partition preserves BIN/images/old UVs and wall closure while selected source draws exactly once',async()=>{
  const before=await fixture(),targets=await target(before),r=await resurfaceGroundGlb(before,{expectedSha256:pavingSha(before),targets,regions:[region],image,encodedTexture:await texture(),distant:false,extras:{fixture:true}}),old=readFacadeGlb(before),next=readFacadeGlb(r.bytes);
  assert.deepEqual(next.bin.subarray(0,old.bin.length),old.bin);assert.deepEqual(next.json.images?.slice(0,old.json.images?.length??0)??[],old.json.images??[]);
  const a=await io.readBinary(before),b=await io.readBinary(r.bytes),p=a.getRoot().listMeshes()[0]!.listPrimitives()[0]!,q=b.getRoot().listMeshes()[0]!.listPrimitives()[0]!;
  for(const s of p.listSemantics())assert.deepEqual(q.getAttribute(s)!.getArray(),p.getAttribute(s)!.getArray());
  assert.equal(q.getIndices()!.getCount(),6);assert.equal(b.getRoot().listMeshes()[0]!.listPrimitives()[1]!.getIndices()!.getCount(),3);assert.equal(r.proof.addedPrimitives,1);assert.equal((await validateBytes(r.bytes)).issues.numErrors,0);
  await assert.rejects(resurfaceGroundGlb(before,{expectedSha256:h,targets,regions:[region],image,encodedTexture:await texture(),distant:false,extras:{}}),/hash mismatch/);
  await assert.rejects(resurfaceGroundGlb(before,{expectedSha256:pavingSha(before),targets:[...targets,...targets],regions:[region],image,encodedTexture:await texture(),distant:false,extras:{}}),/Duplicate/);
});
test('whole-primitive selection stays one draw; distant recolour changes no geometry, old colour prefix or draw count',async()=>{
  const before=await fixture(false,false,true),all=(await inspectGroundSurfaces(before)).map(t=>({node:t.node,primitive:t.primitive,triangle:t.triangle,key:pavingTriangleKey(t.points),region:'stone'}));
  const full=await resurfaceGroundGlb(before,{expectedSha256:pavingSha(before),targets:all,regions:[region],image,encodedTexture:await texture(),distant:false,extras:{}});assert.equal(full.proof.addedPrimitives,0);assert.equal((await validateBytes(full.bytes)).issues.numErrors,0);
  const coarse=await fixture(true),targets=await matchResurfacingTier(coarse,await target(before),true),r=await resurfaceGroundGlb(coarse,{expectedSha256:pavingSha(coarse),targets,regions:[region],image,distant:true,extras:{}});
  const a=await io.readBinary(coarse),b=await io.readBinary(r.bytes),p=a.getRoot().listMeshes()[0]!.listPrimitives()[0]!,q=b.getRoot().listMeshes()[0]!.listPrimitives()[0]!;
  for(const s of p.listSemantics())assert.deepEqual(q.getAttribute(s)!.getArray()!.slice(0,p.getAttribute(s)!.getArray()!.length),p.getAttribute(s)!.getArray());
  assert.equal(b.getRoot().listMeshes()[0]!.listPrimitives().length,1);assert.equal(b.getRoot().listTextures().length,0);assert.equal(r.proof.addedPrimitives,0);assert.equal((await validateBytes(r.bytes)).issues.numErrors,0);
  await assert.rejects(matchResurfacingTier(await fixture(true,true),await target(before),true),/Missing\/ambiguous/);
});
test('one ordinary variant merges selected faces across original ground finishes into at most one new draw',async()=>{
  const b=new GlbBuilder('two-finish-ground');
  for(const [finish,offset]of [['setts',0],['cobble',8]]as const){const P=Float32Array.from([...selected.flatMap(v=>[v[0]!+offset,v[1]!,v[2]!]),...other.flatMap(v=>[v[0]!+offset,v[1]!,v[2]!])]),I=Uint32Array.from({length:6},(_,i)=>i);await b.addMesh({name:`c_ground_${finish}`,positions:P,indices:I,normals:flatNormals(P,I),uvs:new Float32Array(12),materialName:finish},{name:finish,unlit:false});}
  const bytes=await b.toGlb('two original finishes',{},'exact'),rows=await inspectGroundSurfaces(bytes),targets=rows.filter(t=>Math.min(...t.points.map(p=>p[0]))===0||Math.min(...t.points.map(p=>p[0]))===8).map(t=>({node:t.node,primitive:t.primitive,triangle:t.triangle,key:pavingTriangleKey(t.points),region:'stone'}));assert.equal(targets.length,2);
  const result=await resurfaceGroundGlb(bytes,{expectedSha256:pavingSha(bytes),targets,regions:[region],image,encodedTexture:await texture(),distant:false,extras:{}});
  assert.equal(result.proof.addedPrimitives,1);const after=await io.readBinary(result.bytes);assert.equal(after.getRoot().listMeshes().reduce((n,m)=>n+m.listPrimitives().length,0),3);assert.equal(after.getRoot().listTextures().length,1);assert.equal((await validateBytes(result.bytes)).issues.numErrors,0);
});
test('CLI authority binds source/config/producer, maps accepted LOD1, and fresh application preserves nonvisual bytes',async()=>{
  const work=path.resolve('data/work');mkdirSync(work,{recursive:true});const root=mkdtempSync(path.join(work,'test-resurfacing-'));
  try{
    const base=path.join(root,'base');mkdirSync(path.join(base,'visual'),{recursive:true});mkdirSync(path.join(base,'collision'));
    const detail=await fixture(),coarse=await fixture(true),payload=(file:string,b:Uint8Array)=>({path:file,sha256:pavingSha(b),bytes:b.length}),visual=(file:string,b:Uint8Array)=>({...payload(file,b),triangles:3,drawCalls:1,atlases:0,textureBytesEstimate:0});
    for(const [name,b]of [['detail.glb',detail],['middle.glb',detail],['far.glb',coarse]]as const)writeFileSync(path.join(base,'visual',name),b);
    const collision=Buffer.from('exact old HCOL'),terrain=Buffer.from('exact old terrain');writeFileSync(path.join(base,'collision','cell.bin'),collision);writeFileSync(path.join(base,'runtime-terrain.bin'),terrain);
    const cell={id:'c_p00_p00',visual:{lod0:visual('visual/detail.glb',detail),lod1:visual('visual/middle.glb',detail),lod2:visual('visual/far.glb',coarse)},collision:payload('collision/cell.bin',collision)};
    const index=Buffer.from(JSON.stringify({originId:'fixture-origin',cells:[cell]}));writeFileSync(path.join(base,'cells.json'),index);writeFileSync(path.join(base,'report.json'),JSON.stringify({cells:[{cell:cell.id,drawCalls:1,glbBytes:detail.length,ktx2Bytes:0,textureTexels:0}],totals:{drawCalls:1,ktx2Bytes:0,textureTexels:0},budgets:{pass:true}}));
    const origin=path.join(root,'origin.json'),streetParts=path.join(root,'parts.json'),profile=path.join(root,'source-plan.json'),config=path.join(root,'config.json');writeFileSync(origin,JSON.stringify({id:'fixture-origin',originProjected:[0,0,0]}));
    writeFileSync(streetParts,JSON.stringify({type:'FeatureCollection',features:[{type:'Feature',properties:{osan_id:1,materiaali:'Nupukivi',alatyyppi:'Ajorata'},geometry:{type:'Polygon',coordinates:[[[0,0],[2,0],[2,-2],[0,-2],[0,0]]]}}]}));
    writeFileSync(profile,JSON.stringify({...plan,baseCellsIndexSha256:pavingSha(index),streetPartsSha256:pavingSha(readFileSync(streetParts)),originSha256:pavingSha(readFileSync(origin))}));writeFileSync(config,JSON.stringify({budgets:{drawCallsPerCell:60}}));
    const args={base,streetParts,origin,plan:profile,config},authority=path.join(root,'authority.json');const q=await planGroundResurfacing({...args,outPlan:authority});assert.equal(q.counts.targets,1);
    const a=JSON.parse(readFileSync(authority,'utf8')),receipt=JSON.parse(readFileSync(a.rows[0].receipt,'utf8'));assert.equal(receipt.tiers.lod1.targets.length,1);assert.equal(receipt.tiers.lod2.targets.length,1);
    const out=path.join(root,'out'),result=await applyGroundResurfacing({...args,authority,out});assert.equal(result.status,'PASS_STATIC_APPEARANCE_ONLY_NATIVE_PENDING');for(const f of ['collision/cell.bin','runtime-terrain.bin'])assert.deepEqual(readFileSync(path.join(out,f)),readFileSync(path.join(base,f)));assert.deepEqual(readFileSync(path.join(base,'cells.json')),index);
    const next=JSON.parse(readFileSync(path.join(out,'cells.json'),'utf8')).cells[0];assert.equal(next.visual.lod0.drawCalls,2);assert.equal(next.visual.lod1.drawCalls,2);assert.equal(next.visual.lod2.drawCalls,1);assert.equal(next.visual.lod2.textureBytesEstimate,0);
    const features=JSON.parse(readFileSync(streetParts,'utf8'));features.features.push({type:'Feature',properties:{osan_id:2,materiaali:'Noppakivi',alatyyppi:'Ajorata'},geometry:{type:'Polygon',coordinates:[[[4,0],[6,0],[6,-2],[4,-2],[4,0]]]}});writeFileSync(streetParts,JSON.stringify(features));
    writeFileSync(profile,JSON.stringify({...plan,baseCellsIndexSha256:pavingSha(index),streetPartsSha256:pavingSha(readFileSync(streetParts)),originSha256:pavingSha(readFileSync(origin)),regions:[region,{...region,id:'fan',partIds:['2'],expectedMaterials:['Noppakivi'],pattern:'fan-cobble',tileMetres:[2,2]}]}));
    const authority2=path.join(root,'authority2.json');await planGroundResurfacing({...args,outPlan:authority2});const mixed=await applyGroundResurfacing({...args,authority:authority2,out:path.join(root,'mixed')});
    const detailProof=mixed.results.find(r=>r.lod==='lod0')!.proof;assert.equal(detailProof.textureCount,2);assert.equal(detailProof.targetTriangles,2);assert.equal(detailProof.patches.length,2);assert.equal(mixed.results.find(r=>r.lod==='lod2')!.proof.addedPrimitives,0);
    writeFileSync(config,JSON.stringify({budgets:{drawCallsPerCell:59}}));const bad=path.join(root,'must-not-exist');await assert.rejects(applyGroundResurfacing({...args,authority:authority2,out:bad}),/bindings changed/);assert.equal(existsSync(bad),false);
  }finally{assert.ok(root.startsWith(work+path.sep));rmSync(root,{recursive:true,force:true});}
});
