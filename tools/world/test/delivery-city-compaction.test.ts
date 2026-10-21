import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {gunzipSync} from 'node:zlib';
import type {WorldManifest} from '../../../packages/world-schema/src/index.ts';
import {encodeTerrain} from '../../../packages/world-schema/src/index.ts';
import {GlbBuilder,flatNormals} from '../lib/gltf.ts';
import {packGlb} from '../lib/shared-textures.ts';
import {readFacadeGlb} from '../lib/facade-glb.ts';
import {externalizeCellImages} from '../lib/shared-textures.ts';
import {deliverySha,decodeDeliveryCityGlb,decodeDeliverySimulation} from '../lib/delivery-city-payloads.ts';
import {selectDeliveryCityCompaction,decodedCityCompactionProof,qualifyDeliveryCityCompaction,compactDeliveryCity,removeEmptyCityVirtualBuffers} from '../lib/delivery-city-compaction.ts';

let fixturePromise:Promise<Uint8Array>|undefined;
function fixture(){return fixturePromise??=makeFixture();}
async function makeFixture(){
  const b=new GlbBuilder('lossless-city'),P=new Float32Array([0,0,0,2,0,0,2,0,2]),I=new Uint32Array([0,2,1]);
  await b.addMesh({name:'native-wall',positions:P,indices:I,normals:flatNormals(P,I),uvs:new Float32Array([0,0,1,0,1,1]),materialName:'native-facade'},{name:'native-facade',unlit:false});
  const raw=readFacadeGlb(await b.toGlb('source copyright',{sourceIds:['unchanged-building'],nested:{literal:2}},'exact')),j=structuredClone(raw.json)as any;
  j.nodes.push({name:'empty_runtime_socket',extras:{retain:true}});j.scenes[0].nodes.push(j.nodes.length-1);j.scenes.push({name:'secondary',nodes:[j.nodes.length-1]});
  // Real dead resources reference their own encoded bytes. Active vertex arrays, UVs,
  // material images, empty sockets and both scenes must survive byte-for-byte decoding.
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64'),padding=Buffer.alloc((4-png.length%4)%4),bin=Buffer.concat([raw.bin,png,padding,Buffer.alloc(4096,39)]);
  j.images=[{bufferView:j.bufferViews.length,mimeType:'image/png'}];j.bufferViews.push({buffer:0,byteOffset:raw.bin.length,byteLength:png.length});j.textures=[{source:0}];j.materials[0].pbrMetallicRoughness.baseColorTexture={index:0};
  const view=j.bufferViews.length;j.bufferViews.push({buffer:0,byteOffset:raw.bin.length+png.length+padding.length,byteLength:4096});
  j.accessors.push({bufferView:view,componentType:5126,count:3,type:'VEC3'});
  j.meshes.push({name:'obsolete-floor',primitives:[{attributes:{POSITION:j.accessors.length-1}}]});
  j.materials.push({name:'obsolete-photo',pbrMetallicRoughness:{baseColorTexture:{index:j.textures.length}}});
  j.textures.push({source:j.images.length});j.images.push(structuredClone(j.images[0]));
  j.buffers[0].byteLength=bin.length;return packGlb(j,bin);
}
const ref=(name:string,b:Uint8Array)=>({path:name,bytes:b.length,sha256:deliverySha(b)});
const descriptor=(id:string,r:ReturnType<typeof ref>)=>({id,cx:0,cz:0,boundsXZ:[0,0,128,128],visual:{lod0:{...r,triangles:1,drawCalls:1,atlases:1,textureBytesEstimate:16},lod1:{...r,triangles:1,drawCalls:1,atlases:1,textureBytesEstimate:16},lod2:{...r,triangles:1,drawCalls:1,atlases:1,textureBytesEstimate:16}},collision:ref('cells/collision.bin',new Uint8Array([1])),buildingIds:[],buildings:[],sourceTiles:[]});
const selectionManifest=(cells:ReturnType<typeof descriptor>[])=>({origin:{id:'test'},cells}as unknown as WorldManifest);

test('immutable live visual hashes are protected across changed paths, owner cells and tiers',()=>{
  const a=ref('cells/old.glb',new Uint8Array([1])),b=ref('cells/new.glb',new Uint8Array([2])),live=selectionManifest([descriptor('live',a)]),current=selectionManifest([descriptor('live',{...a,path:'cells/alias.glb'}),descriptor('new',b)]);
  const plan=selectDeliveryCityCompaction(current,live);assert.equal(plan.protectedReferences,3);assert.equal(plan.selected.length,1);assert.equal(plan.selected[0]!.owners.length,3);assert.equal(plan.selected[0]!.ref.sha256,b.sha256);
  const bad=structuredClone(current);(bad.cells[1]!.visual.lod1 as any).bytes++;
  assert.throws(()=>selectDeliveryCityCompaction(bad,live),/inconsistent size/);
  const unsafe=structuredClone(current);(unsafe.cells[1]!.visual.lod0 as any).path='assets/character.glb';assert.throws(()=>selectDeliveryCityCompaction(unsafe,live),/Only city/);
});

test('actual decoded full accessor, image, material and scene identity survives dead BIN/image removal',async()=>{
  const source=await fixture(),saved=source.slice(),result=await qualifyDeliveryCityCompaction(source);
  assert.ok(result.receipt.savedBytes>4096);assert.ok(result.receipt.resources.images.before>result.receipt.resources.images.after);assert.equal(result.decodedProof.allDecodedAccessorsMaterialsImagesExact,true);assert.deepEqual(source,saved);
  const before=decodedCityCompactionProof(await decodeDeliveryCityGlb(source)),after=decodedCityCompactionProof(await decodeDeliveryCityGlb(result.bytes));assert.deepEqual(after.snapshot,before.snapshot);assert.equal(after.snapshot.nodes[1]!.name,'empty_runtime_socket');assert.equal(after.snapshot.scenes.length,2);
});

test('decoded proof catches UV, position, material and image drift independently',async()=>{
  const source=await fixture(),original=decodedCityCompactionProof(await decodeDeliveryCityGlb(source));
  for(const field of ['POSITION','TEXCOORD_0','material','image']){
    const doc=await decodeDeliveryCityGlb(source),p=doc.getRoot().listNodes().find(n=>n.getMesh())!.getMesh()!.listPrimitives()[0]!;
    if(field==='material')p.getMaterial()!.setRoughnessFactor(.123);
    else if(field==='image'){const texture=p.getMaterial()!.getBaseColorTexture()!,image=texture.getImage()!.slice();image[image.length-1]=image[image.length-1]!^1;texture.setImage(image);}
    else {const array=p.getAttribute(field)!.getArray()!;array[0]=array[0]!+1;}
    assert.notEqual(decodedCityCompactionProof(doc).sha256,original.sha256,`Must detect ${field}`);
  }
});

test('only unreferenced empty virtual meshopt buffers are removed and live fallback IDs are remapped exactly',async()=>{
  const raw=readFacadeGlb(await fixture()),j=structuredClone(raw.json)as any;
  const fallback=j.buffers.findIndex((b:any,i:number)=>i>0&&b.byteLength>0);assert.ok(fallback>0,'Fixture must contain actual compressed fallback data');
  j.buffers.splice(fallback,0,{byteLength:0,extensions:{EXT_meshopt_compression:{fallback:true}}});
  for(const view of j.bufferViews){if(view.buffer>=fallback)view.buffer++;if(view.extensions?.EXT_meshopt_compression?.buffer>=fallback)view.extensions.EXT_meshopt_compression.buffer++;}
  const withEmpty=packGlb(j,raw.bin),cleaned=removeEmptyCityVirtualBuffers(withEmpty);assert.deepEqual(cleaned.removed,[fallback]);assert.deepEqual(readFacadeGlb(cleaned.bytes).json,raw.json);assert.deepEqual(readFacadeGlb(cleaned.bytes).bin,raw.bin);
  assert.deepEqual(decodedCityCompactionProof(await decodeDeliveryCityGlb(withEmpty)).snapshot,decodedCityCompactionProof(await decodeDeliveryCityGlb(cleaned.bytes)).snapshot);
  const bad=structuredClone(j);bad.bufferViews[0].buffer=fallback;assert.throws(()=>removeEmptyCityVirtualBuffers(packGlb(bad,raw.bin)),/referenced virtual buffer/);
  const nonvirtual=structuredClone(j);delete nonvirtual.buffers[fallback].extensions;assert.throws(()=>removeEmptyCityVirtualBuffers(packGlb(nonvirtual,raw.bin)),/Only an unused meshopt/);
});

test('fully pruned optional image/texture/sampler arrays are omitted rather than invalid empty glTF entities',async()=>{
  const raw=readFacadeGlb(await fixture()),j=structuredClone(raw.json)as any;j.images=[];j.textures=[];j.samplers=[];delete j.materials[0].pbrMetallicRoughness.baseColorTexture;
  const result=removeEmptyCityVirtualBuffers(packGlb(j,raw.bin)),after=readFacadeGlb(result.bytes).json as any;assert.deepEqual(result.removedArrays,['textures','images','samplers']);assert.equal(after.images,undefined);assert.equal(after.textures,undefined);assert.equal(after.samplers,undefined);assert.deepEqual(after.nodes,j.nodes);assert.deepEqual(readFacadeGlb(result.bytes).bin,raw.bin);
});

test('unknown extension and unpinned or corrupt external image fail closed',async()=>{
  const source=await fixture(),raw=readFacadeGlb(source),j=structuredClone(raw.json)as any;j.extensionsUsed.push('VENDOR_unqualified_indices');
  await assert.rejects(qualifyDeliveryCityCompaction(packGlb(j,raw.bin)),/Unsupported GLB extension/);
  const external=externalizeCellImages(source),images=new Map(external.images.map(i=>[`../${i.path}`,i.bytes]));
  const result=await qualifyDeliveryCityCompaction(external.bytes,images);assert.ok(result.receipt.savedBytes>0);
  await assert.rejects(qualifyDeliveryCityCompaction(external.bytes),/Missing pinned/);
  const bad=new Map(images),key=bad.keys().next().value!;bad.set(key,new Uint8Array([1,2]));await assert.rejects(qualifyDeliveryCityCompaction(external.bytes,bad));
});

test('whole-world compaction retains protected aliases, simulation/M1 bytes and source, and emits bounded gzip proof',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'helsinki-city-compaction-'));
  try{
    const source=path.join(root,'source'),live=path.join(root,'live'),out=path.join(root,'out');fs.mkdirSync(source);fs.mkdirSync(live);
    const put=(dir:string,name:string,b:Uint8Array)=>{const f=path.join(dir,name);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,b);return ref(name,b);};
    const oldBytes=(await qualifyDeliveryCityCompaction(await fixture())).bytes,newBytes=await fixture(),a=put(source,'cells/old.glb',oldBytes),b=put(source,'cells/new.glb',newBytes),collision=put(source,'cells/collision.bin',new Uint8Array([1])),terrain=put(source,'terrain.bin',encodeTerrain({x0:0,z0:0,nx:2,nz:2,resolution:1,heights:new Float32Array([1,2,3,4])})),roads=put(source,'roads.json',Buffer.from('{"fixed":"road"}')),gameplay=put(source,'gameplay.json',Buffer.from('{"fixed":"spawn"}'));
    const image=Buffer.from('immutable native atlas'),standard=put(source,`textures/${deliverySha(image)}.ktx2`,image),m1=Buffer.from('immutable old mip'),low={...put(source,`textures-m1/${deliverySha(m1)}.ktx2`,m1),source:standard.path};
    const cells=[descriptor('old',a),descriptor('new',b)].map(c=>({...c,collision})),manifest={schemaVersion:2,worldReleaseId:'fixture-source',origin:{id:'test',originProjected:[0,0,0]},cellSize:128,boundsRuntimeXZ:[0,0,128,128],cells,terrain:{...terrain,x0:0,z0:0,nx:2,nz:2,resolution:1},roads,gameplay,assets:[],sharedTextures:[standard],sharedTexturesM1:[low],sources:[{id:'test'}],attribution:['CC0'],lighting:'unlit-facades'};
    const raw=Buffer.from(JSON.stringify(manifest)),pinned=put(source,'manifest.json',raw),liveManifest={...manifest,cells:[cells[0]]},liveRef=put(live,'manifest.json',Buffer.from(JSON.stringify(liveManifest)));
    const result=await compactDeliveryCity({world:source,manifestSha256:pinned.sha256,liveWorld:live,liveManifestSha256:liveRef.sha256,out,release:'lossless-test'}),next=JSON.parse(fs.readFileSync(path.join(out,'manifest.json'),'utf8'));
    assert.ok(result.savedPayloadBytes>4096);assert.equal(result.changedPayloads,1);assert.deepEqual(next.cells[0],cells[0]);assert.equal(next.cells[1].visual.lod0.path,next.cells[1].visual.lod2.path);assert.deepEqual(next.terrain,manifest.terrain);assert.deepEqual(next.roads,manifest.roads);assert.deepEqual(next.gameplay,manifest.gameplay);assert.deepEqual(next.sharedTexturesM1,[low]);assert.deepEqual(fs.readFileSync(path.join(out,low.path)),m1);assert.deepEqual(fs.readFileSync(path.join(source,'manifest.json')),raw);
    const proofRef=next.publicationFiles[0],stored=fs.readFileSync(path.join(out,proofRef.path)),proof=JSON.parse(Buffer.from(decodeDeliverySimulation(stored,proofRef)).toString());assert.equal(proof.immutableLiveManifestSha256,liveRef.sha256);assert.equal(proof.rows[0].decodedProof.allDecodedAccessorsMaterialsImagesExact,true);assert.ok(proofRef.decodedBytes<64*1024*1024);assert.deepEqual(stored.length,proofRef.bytes);assert.equal(gunzipSync(stored).length,proofRef.decodedBytes);assert.ok(!JSON.stringify(proof).includes(root));
    const closed=new Map<string,number>();const walk=(v:any)=>{if(!v||typeof v!=='object')return;if(typeof v.path==='string'&&typeof v.bytes==='number')closed.set(v.path,v.bytes);for(const c of Object.values(v))walk(c);};walk(next);assert.equal(result.closedBytes,fs.statSync(path.join(out,'manifest.json')).size+[...closed.values()].reduce((a,b)=>a+b,0));
    await assert.rejects(compactDeliveryCity({world:source,manifestSha256:'f'.repeat(64),liveWorld:live,liveManifestSha256:liveRef.sha256,out:path.join(root,'must-not-create'),release:'bad'}),/Pinned manifest changed/);assert.ok(!fs.existsSync(path.join(root,'must-not-create')));
  }finally{const target=path.resolve(root);assert.ok(target.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(target).startsWith('helsinki-city-compaction-'));fs.rmSync(target,{recursive:true,force:true});}
});
