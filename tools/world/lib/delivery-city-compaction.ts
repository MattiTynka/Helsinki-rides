/** Final lossless cleanup of changed city payloads. Frozen live visual hashes stay literal. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type {Accessor,Document,Material,Texture,TextureInfo} from '@gltf-transform/core';
import {validateBytes} from 'gltf-validator';
import {validateWorldManifest,type FileRef,type SimulationFileRef,type WorldManifest} from '../../../packages/world-schema/src/index.ts';
import {compactGlb} from './compact-glb.ts';
import {packGlb} from './shared-textures.ts';
import {readFacadeGlb} from './facade-glb.ts';
import {readDeliveryFile,deliveryFile,freshDeliveryDirectory} from './delivery-city.ts';
import {decodeDeliveryCityGlb,deliveryGeometryStats,deliverySha,encodeDeliverySimulation,MAX_DELIVERY_DECODED_BYTES} from './delivery-city-payloads.ts';
import {bindDeliveryProducer,verifyDeliveryProducer,publicDeliveryProducer} from './delivery-city-provenance.ts';
import {resolveAppendDeliveryBudget,type AppendDeliveryBudget} from './delivery-city-files.ts';

type CompactionManifest=WorldManifest&{publicationFiles?:readonly (FileRef|SimulationFileRef)[]};
type Mutable<T>={-readonly [K in keyof T]:T[K] extends object?Mutable<T[K]>:T[K]};
const tiers=['lod0','lod1','lod2']as const;
/** Protection is by immutable bytes, including a live payload reused under another path/tier. */
export function selectDeliveryCityCompaction(manifest:WorldManifest,live:WorldManifest){
  assert.equal(manifest.origin.id,live.origin.id,'Live source origin differs');
  const protectedHashes=new Set(live.cells.flatMap(c=>tiers.flatMap(t=>c.visual[t]?[c.visual[t]!.sha256]:[])));
  const selected=new Map<string,{ref:FileRef;owners:{cell:string;tier:typeof tiers[number];path:string}[]}>();
  let protectedReferences=0;
  for(const c of manifest.cells)for(const tier of tiers){const ref=c.visual[tier];if(!ref)continue;
    assert.match(ref.path,/^cells\/[A-Za-z0-9._-]+\.glb$/,'Only city visual payloads may enter final compaction');
    if(protectedHashes.has(ref.sha256)){protectedReferences++;continue;}
    const entry=selected.get(ref.sha256)??{ref,owners:[]};assert.equal(entry.ref.bytes,ref.bytes,'Hash alias has inconsistent size');entry.owners.push({cell:c.id,tier,path:ref.path});selected.set(ref.sha256,entry);
  }
  return{protectedHashes,protectedReferences,selected:[...selected.values()].sort((a,b)=>a.ref.sha256.localeCompare(b.ref.sha256))};
}
const bytesOf=(a:ArrayBufferView)=>new Uint8Array(a.buffer,a.byteOffset,a.byteLength);
function accessorProof(a:Accessor|null){if(!a)return null;const values=a.getArray();assert.ok(values,'Decoded accessor has no array');return{type:a.getType(),componentType:a.getComponentType(),normalized:a.getNormalized(),count:a.getCount(),arrayType:values.constructor.name,bytes:values.byteLength,sha256:deliverySha(bytesOf(values)),extras:a.getExtras()};}
function textureProof(t:Texture|null){if(!t)return null;const image=t.getImage();assert.ok(image?.length,'Reachable texture needs pinned image bytes');return{name:t.getName(),uri:t.getURI(),mimeType:t.getMimeType(),imageBytes:image.length,imageSha256:deliverySha(image),extras:t.getExtras()};}
function textureInfoProof(info:TextureInfo|null){return info?{texCoord:info.getTexCoord(),magFilter:info.getMagFilter(),minFilter:info.getMinFilter(),wrapS:info.getWrapS(),wrapT:info.getWrapT(),extras:info.getExtras()}:null;}
function materialProof(m:Material|null){if(!m)return null;return{name:m.getName(),extras:m.getExtras(),alphaMode:m.getAlphaMode(),alphaCutoff:m.getAlphaCutoff(),doubleSided:m.getDoubleSided(),baseColorFactor:m.getBaseColorFactor(),emissiveFactor:m.getEmissiveFactor(),metallicFactor:m.getMetallicFactor(),roughnessFactor:m.getRoughnessFactor(),normalScale:m.getNormalScale(),occlusionStrength:m.getOcclusionStrength(),extensions:m.listExtensions().map(e=>e.extensionName).sort(),textures:[
    [textureProof(m.getBaseColorTexture()),textureInfoProof(m.getBaseColorTextureInfo())],
    [textureProof(m.getMetallicRoughnessTexture()),textureInfoProof(m.getMetallicRoughnessTextureInfo())],
    [textureProof(m.getNormalTexture()),textureInfoProof(m.getNormalTextureInfo())],
    [textureProof(m.getOcclusionTexture()),textureInfoProof(m.getOcclusionTextureInfo())],
    [textureProof(m.getEmissiveTexture()),textureInfoProof(m.getEmissiveTextureInfo())],
  ]};}
/** Every reachable primitive accessor is independently decoded, including complete unused
 * vertex tails in a live accessor. Raw compaction semantic proof also pins every material extension. */
export function decodedCityCompactionProof(doc:Document){
  const root=doc.getRoot(),nodes=root.listNodes(),nodeIndex=new Map(nodes.map((n,i)=>[n,i]));
  const accessors=new Set<Accessor>();const accessor=(a:Accessor|null)=>{if(a)accessors.add(a);return accessorProof(a);};
  const snapshot={asset:root.getAsset(),extras:root.getExtras(),nodes:nodes.map(node=>({name:node.getName(),matrix:node.getMatrix(),extras:node.getExtras(),children:node.listChildren().map(n=>nodeIndex.get(n)),weights:node.getWeights(),primitives:node.getMesh()?.listPrimitives().map(p=>({mode:p.getMode(),extras:p.getExtras(),indices:accessor(p.getIndices()),attributes:p.listSemantics().sort().map(s=>({semantic:s,accessor:accessor(p.getAttribute(s))})),targets:p.listTargets().map(t=>t.listSemantics().sort().map(s=>({semantic:s,accessor:accessor(t.getAttribute(s))}))),material:materialProof(p.getMaterial())}))})),scenes:root.listScenes().map(s=>({name:s.getName(),extras:s.getExtras(),children:s.listChildren().map(n=>nodeIndex.get(n))})),defaultScene:root.getDefaultScene()?root.listScenes().indexOf(root.getDefaultScene()!):null,
    skins:root.listSkins().map(s=>({name:s.getName(),extras:s.getExtras(),skeleton:nodeIndex.get(s.getSkeleton()!),joints:s.listJoints().map(n=>nodeIndex.get(n)),inverseBindMatrices:accessor(s.getInverseBindMatrices())})),
    animations:root.listAnimations().map(a=>({name:a.getName(),extras:a.getExtras(),channels:a.listChannels().map(c=>({targetNode:nodeIndex.get(c.getTargetNode()!),targetPath:c.getTargetPath(),input:accessor(c.getSampler()?.getInput()??null),output:accessor(c.getSampler()?.getOutput()??null),interpolation:c.getSampler()?.getInterpolation()}))})),
  };
  const decodedAccessorBytes=[...accessors].reduce((n,a)=>n+a.getArray()!.byteLength,0);assert.ok(decodedAccessorBytes<=MAX_DELIVERY_DECODED_BYTES,'Decoded active accessor limit exceeded');
  return{snapshot,sha256:deliverySha(JSON.stringify(snapshot)),nodes:nodes.length,accessors:accessors.size,decodedAccessorBytes};
}
/** Appended payloads can leave unused meshopt fallback buffers or completely
 * pruned optional arrays. glTF forbids both zero-byte buffers and empty arrays. */
export function removeEmptyCityVirtualBuffers(source:Uint8Array){
  const raw=readFacadeGlb(source),j=structuredClone(raw.json)as any,used=new Set<number>();
  for(const view of j.bufferViews??[]){used.add(view.buffer);if(view.extensions?.EXT_meshopt_compression)used.add(view.extensions.EXT_meshopt_compression.buffer);}
  const removed:number[]=[],mapping=new Map<number,number>(),buffers=[];
  for(const [id,buffer]of j.buffers.entries()){
    if(id>0&&buffer.byteLength===0){assert.equal(buffer.extensions?.EXT_meshopt_compression?.fallback,true,'Only an unused meshopt fallback buffer may be removed');assert.ok(!used.has(id),'A referenced virtual buffer cannot be empty');removed.push(id);}
    else {mapping.set(id,buffers.length);buffers.push(buffer);}
  }
  const removedArrays:string[]=[];for(const key of ['meshes','accessors','bufferViews','materials','textures','images','samplers'])if(Array.isArray(j[key])&&j[key].length===0){delete j[key];removedArrays.push(key);}
  if(!removed.length&&!removedArrays.length)return{bytes:source,removed,removedArrays};
  const remap=(id:number)=>{assert.ok(mapping.has(id),'Referenced buffer was removed');return mapping.get(id)!;};
  for(const view of j.bufferViews??[]){view.buffer=remap(view.buffer);if(view.extensions?.EXT_meshopt_compression)view.extensions.EXT_meshopt_compression.buffer=remap(view.extensions.EXT_meshopt_compression.buffer);}
  j.buffers=buffers;const bytes=packGlb(j,raw.bin);assert.deepEqual(readFacadeGlb(bytes).bin,raw.bin,'Empty-resource metadata cleanup changed BIN');return{bytes,removed,removedArrays};
}
export async function qualifyDeliveryCityCompaction(source:Uint8Array,images:ReadonlyMap<string,Uint8Array>=new Map()){
  assert.ok(source.length<=MAX_DELIVERY_DECODED_BYTES,'Encoded city payload limit exceeded');
  const canonical=compactGlb(source),normalized=removeEmptyCityVirtualBuffers(canonical.bytes),result={bytes:normalized.bytes,receipt:{...canonical.receipt,canonicalCompactedSha256:canonical.receipt.compactedSha256,removedEmptyVirtualBuffers:normalized.removed,removedEmptyResourceArrays:normalized.removedArrays,compactedSha256:deliverySha(normalized.bytes),compactedBytes:normalized.bytes.length,savedBytes:source.length-normalized.bytes.length}};assert.ok(result.bytes.length<=MAX_DELIVERY_DECODED_BYTES);
  const before=decodedCityCompactionProof(await decodeDeliveryCityGlb(source,images)),after=decodedCityCompactionProof(await decodeDeliveryCityGlb(result.bytes,images));
  assert.deepEqual(after.snapshot,before.snapshot,'Compaction changed an actual decoded accessor, material, texture, transform or scene');
  const beforeStats=deliveryGeometryStats(source),afterStats=deliveryGeometryStats(result.bytes);
  assert.deepEqual({triangles:afterStats.triangles,drawCalls:afterStats.drawCalls},{triangles:beforeStats.triangles,drawCalls:beforeStats.drawCalls},'Compaction changed geometry/draw statistics');
  const second=removeEmptyCityVirtualBuffers(compactGlb(result.bytes).bytes);assert.deepEqual(second.bytes,result.bytes,'Compaction is not byte-idempotent');
  const validationOptions={maxIssues:30,externalResourceFunction:async(uri:string)=>{const b=images.get(uri);assert.ok(b,'Khronos image absent from the pinned allowlist');return b;}},validation=await validateBytes(result.bytes,validationOptions);
  assert.equal(validation.issues.numErrors,0,`Compacted city GLB is invalid: ${JSON.stringify(validation.issues.messages.filter(m=>m.severity===0))}`);
  return{...result,decodedProof:{sha256:before.sha256,nodes:before.nodes,accessors:before.accessors,decodedAccessorBytes:before.decodedAccessorBytes,allDecodedAccessorsMaterialsImagesExact:true,secondCompactionByteIdentical:true,khronosValidationErrors:0,khronosValidationWarnings:validation.issues.numWarnings}};
}
function refsIn(value:unknown,result=new Map<string,FileRef>()){
  if(!value||typeof value!=='object')return result;
  if('path'in value&&'bytes'in value&&'sha256'in value&&typeof value.path==='string'&&typeof value.bytes==='number'&&typeof value.sha256==='string'){
    const ref={path:value.path,bytes:value.bytes,sha256:value.sha256};if(result.has(ref.path))assert.deepEqual(result.get(ref.path),ref,'Conflicting manifest file references');result.set(ref.path,ref);
  }
  for(const child of Object.values(value))refsIn(child,result);return result;
}
export async function compactDeliveryCity(o:{world:string;manifestSha256:string;liveWorld:string;liveManifestSha256:string;out:string;release:string;delivery?:AppendDeliveryBudget}){
  const delivery=resolveAppendDeliveryBudget(o.delivery);
  const producer=bindDeliveryProducer(new URL('../compact_delivery_city.ts',import.meta.url));
  const readManifest=(root:string,expected:string)=>{const b=fs.readFileSync(path.join(root,'manifest.json'));assert.equal(deliverySha(b),expected,'Pinned manifest changed');const m=JSON.parse(b.toString())as CompactionManifest;assert.deepEqual(validateWorldManifest(m),[]);return{b,m};};
  const source=readManifest(o.world,o.manifestSha256),live=readManifest(o.liveWorld,o.liveManifestSha256),plan=selectDeliveryCityCompaction(source.m,live.m),next=structuredClone(source.m)as Mutable<CompactionManifest>,shared=new Map(source.m.sharedTextures?.map(r=>[r.path,r])??[]),rows=[];
  assert.ok(live.m.cells.every(c=>source.m.cells.some(n=>n.id===c.id)),'Current world lost a protected live owner');
  const out=path.resolve(o.out);freshDeliveryDirectory(o.world,out,[o.liveWorld]);
  const written=new Map<string,FileRef>(),put=(name:string,bytes:Uint8Array)=>{const ref={path:name,bytes:bytes.length,sha256:deliverySha(bytes)},previous=written.get(name);if(previous){assert.deepEqual(previous,ref);return ref;}const file=deliveryFile(out,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes,{flag:'wx'});written.set(name,ref);return ref;};
  let savedPayloadBytes=0;
  for(const entry of plan.selected){const bytes=readDeliveryFile(o.world,entry.ref),images=new Map<string,Uint8Array>();for(const image of readFacadeGlb(bytes).json.images??[]){const uri=(image as any).uri;if(uri===undefined)continue;assert.match(uri,/^\.\.\/textures\/[a-f0-9]{64}\.(ktx2|png)$/);const ref=shared.get(uri.slice(3));assert.ok(ref,'City image absent from the pinned manifest');images.set(uri,readDeliveryFile(o.world,ref));}
    // Every alias is checked even though the SHA-identical bytes are compacted once.
    for(const alias of entry.owners){const c=source.m.cells.find(c=>c.id===alias.cell)!;readDeliveryFile(o.world,c.visual[alias.tier]!);}
    const result=await qualifyDeliveryCityCompaction(bytes,images);if(result.receipt.savedBytes<=0){rows.push({source:entry.ref,owners:entry.owners,status:'PRESERVED_NO_SAVING',receipt:result.receipt,decodedProof:result.decodedProof});continue;}
    const ref=put(`cells/compacted.${deliverySha(result.bytes)}.glb`,result.bytes);savedPayloadBytes+=result.receipt.savedBytes;
    for(const owner of entry.owners){const cell=next.cells.find(c=>c.id===owner.cell)!;cell.visual[owner.tier]={...cell.visual[owner.tier]!,...ref};}
    rows.push({source:entry.ref,owners:entry.owners,target:ref,status:'LOSSLESS_REACHABLE_RESOURCES_COMPACTED',receipt:result.receipt,decodedProof:result.decodedProof});
  }
  // Nothing outside explicit city visual file references may change.
  const compare=structuredClone(next);for(const c of compare.cells)c.visual=structuredClone(source.m.cells.find(s=>s.id===c.id)!.visual);assert.deepEqual(compare,source.m);
  verifyDeliveryProducer(producer);readManifest(o.world,o.manifestSha256);readManifest(o.liveWorld,o.liveManifestSha256);
  const proof={schemaVersion:1,kind:'final-lossless-changed-city-payload-compaction',sourceManifestSha256:o.manifestSha256,immutableLiveManifestSha256:o.liveManifestSha256,delivery,producer:publicDeliveryProducer(producer),protectedVisualHashes:[...plan.protectedHashes].sort(),protectedReferences:plan.protectedReferences,selectedPayloads:plan.selected.length,savedPayloadBytes,rows,policy:'Only changed/new city visuals were compacted. Every actual decoded active accessor, PBR material, image, UV, scene and transform remains exact; raw reachable semantics and encoded streams are separately pinned. All old live visual hashes, simulation, assets, source images and M1 remain literal.'},encoded=encodeDeliverySimulation(Buffer.from(JSON.stringify(proof)+'\n'));
  const proofPath=`publication/city-compaction.${o.manifestSha256.slice(0,20)}.json.gz`;assert.ok(!refsIn(next).has(proofPath),'A final compaction proof already exists');next.publicationFiles=[...(next.publicationFiles??[]),{...put(proofPath,encoded.bytes),compression:encoded.compression,decodedBytes:encoded.decodedBytes,decodedSha256:encoded.decodedSha256}];next.worldReleaseId=o.release;next.builtAt=new Date().toISOString();assert.deepEqual(validateWorldManifest(next),[]);
  const refs=refsIn(next);for(const ref of refs.values())if(!written.has(ref.path)){readDeliveryFile(o.world,ref);const target=deliveryFile(out,ref.path);fs.mkdirSync(path.dirname(target),{recursive:true});fs.linkSync(deliveryFile(o.world,ref.path),target);}
  const manifestBytes=Buffer.from(JSON.stringify(next,null,1)+'\n'),closedBytes=manifestBytes.length+[...refs.values()].reduce((n,r)=>n+r.bytes,0);assert.ok(delivery.inclusive?closedBytes<=delivery.worldBudgetBytes:closedBytes<delivery.worldBudgetBytes,`Compacted world exceeds ${delivery.mode} budget of ${delivery.worldBudgetBytes} bytes`);assert.ok(refs.size+1<10000,'Compacted world exceeds10k files');assert.ok(manifestBytes.length<=8*1024*1024,'Manifest size cap exceeded');fs.writeFileSync(path.join(out,'manifest.json'),manifestBytes,{flag:'wx'});
  return{status:'LOSSLESS_CITY_COMPACTED_PENDING_FINAL_PACKET_AND_RUNTIME_REVIEW',delivery,manifestSha256:deliverySha(manifestBytes),closedBytes,files:refs.size+1,selectedPayloads:plan.selected.length,changedPayloads:rows.filter(r=>r.status==='LOSSLESS_REACHABLE_RESOURCES_COMPACTED').length,savedPayloadBytes,proofDecodedBytes:encoded.decodedBytes,proofEncodedBytes:encoded.bytes.length};
}
