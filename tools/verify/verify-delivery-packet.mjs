// Read-only acceptance of a new-only native/optimized delivery packet.
// Run node --expose-gc tools/verify/verify-delivery-packet.mjs with all seven explicit binding flags.
// This does not certify world append, physical seams, trees or real-control gameplay.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {compareCity,groundFaces,setImageMap} from './lib/delivery-packet-oracle.mjs';
import {parseArgs} from 'node:util';
import {readFacadeGlb} from '../world/lib/facade-glb.ts';
import {decodeDeliverySimulation,deliveryCollisionBounds,deliveryGeometryStats} from '../world/lib/delivery-city-payloads.ts';
import {readKtx2Layout,dropTopMips} from '../../packages/world-schema/src/ktx2-mips.ts';
import {validateWorldManifest,parseCollisionBundle} from '../../packages/world-schema/src/index.ts';
const {values}=parseArgs({options:Object.fromEntries(['native','optimized','accepted','expected-native-index','expected-optimized-index','expected-accepted-manifest','out'].map(k=>[k,{type:'string'}]))});
for(const key of ['native','optimized','accepted','expected-native-index','expected-optimized-index','expected-accepted-manifest','out'])assert.ok(values[key],`--${key} required`);
for(const key of ['expected-native-index','expected-optimized-index','expected-accepted-manifest'])assert.match(values[key],/^[a-f0-9]{64}$/);
assert.ok(global.gc,'Run with --expose-gc for sequential packet validation');
const source=fileURLToPath(new URL('../../',import.meta.url)),base=source,evidence=path.resolve(values.out);
const roots=Object.fromEntries(['native','optimized','accepted'].map(k=>[k,fs.realpathSync(values[k])]));
function canonicalFuturePath(file){
  let parent=path.resolve(file);const suffix=[];
  while(!fs.existsSync(parent)){const next=path.dirname(parent);assert.notEqual(next,parent,'Output has no existing ancestor');suffix.unshift(path.basename(parent));parent=next;}
  const result=path.join(fs.realpathSync(parent),...suffix);return process.platform==='win32'?result.toLowerCase():result;
}
const outputPath=canonicalFuturePath(evidence);
for(const root of Object.values(roots)){
  assert.ok(fs.statSync(root).isDirectory(),'Packet input must be a directory');const inputPath=canonicalFuturePath(root);
  assert.ok(outputPath!==inputPath&&!outputPath.startsWith(inputPath+path.sep)&&!inputPath.startsWith(outputPath+path.sep),'Evidence output must be disjoint from every packet input');
}
assert.ok(!fs.existsSync(evidence),'Use a fresh evidence directory');fs.mkdirSync(evidence,{recursive:true});
const require=createRequire(path.join(source,'package.json'));
const {NodeIO,GLB_BUFFER}=require('@gltf-transform/core'),{ALL_EXTENSIONS}=require('@gltf-transform/extensions'),{MeshoptDecoder}=require('meshoptimizer'),validator=require('gltf-validator');
const sha=b=>createHash('sha256').update(b).digest('hex'),read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const pin=p=>{const b=fs.readFileSync(p);return {bytes:b.length,sha256:sha(b)};};
const refs=(value,out=new Map())=>{if(!value||typeof value!=='object')return out;if(typeof value.path==='string'&&typeof value.sha256==='string'&&typeof value.bytes==='number'){const v={path:value.path,bytes:value.bytes,sha256:value.sha256};if(out.has(v.path))assert.deepEqual(out.get(v.path),v);out.set(v.path,v);}for(const v of Object.values(value))refs(v,out);return out;};
function safe(root,name){assert.ok(name.split('/').every(p=>/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(p)));let p=root;for(const part of name.split('/')){p=path.join(p,part);assert.ok(!fs.lstatSync(p).isSymbolicLink());}assert.ok(fs.lstatSync(p).isFile());return p;}
function inventory(root,rel='',out={}){for(const entry of fs.readdirSync(path.join(root,rel),{withFileTypes:true})){assert.ok(!entry.isSymbolicLink());const next=rel?`${rel}/${entry.name}`:entry.name;if(entry.isDirectory())inventory(root,next,out);else{assert.ok(entry.isFile());out[next]=pin(path.join(root,next));}}return Object.fromEntries(Object.entries(out).sort(([a],[b])=>a.localeCompare(b)));}
const before=Object.fromEntries(Object.entries(roots).map(([name,root])=>[name,inventory(root)]));
assert.equal(before.native['cells.json'].sha256,values['expected-native-index']);
assert.equal(before.optimized['cells.json'].sha256,values['expected-optimized-index']);
assert.equal(before.accepted['manifest.json'].sha256,values['expected-accepted-manifest']);
const bound=new Map();
function bind(file){file=path.resolve(file);if(bound.has(file))return;const b=fs.readFileSync(file);bound.set(file,sha(b));if(/\.(?:ts|mjs|js)$/.test(file))for(const m of b.toString().matchAll(/(?:from\s*|import\s*\(\s*|import\s*)['"]([^'"]+\.(?:ts|mjs|js))['"]/g))if(m[1].startsWith('.'))bind(path.resolve(path.dirname(file),m[1]));}
bind(fileURLToPath(import.meta.url));for(const f of ['pnpm-lock.yaml','package.json','tools/verify/verify-optimized-world.mjs'])bind(path.join(source,f));
const bindings={inputs:before,validationSources:Object.fromEntries([...bound].map(([f,h])=>[path.relative(base,f).replaceAll('\\','/'),h]))};
fs.writeFileSync(path.join(evidence,'bindings-before.json'),JSON.stringify(bindings,null,2)+'\n');
const native=read(path.join(roots.native,'cells.json')),candidate=read(path.join(roots.optimized,'cells.json')),accepted=read(path.join(roots.accepted,'manifest.json')),receipt=read(path.join(roots.optimized,'delivery-receipt.json'));
assert.deepEqual(validateWorldManifest(accepted),[]);
for(const name of ['native','optimized','accepted']){const document=name==='native'?native:name==='optimized'?candidate:accepted;for(const ref of refs(document).values())assert.deepEqual(before[name][ref.path],{bytes:ref.bytes,sha256:ref.sha256},`${name}/${ref.path}`);}
const payloadNames=[...refs(candidate).keys(),'cells.json','delivery-receipt.json','report.json','runtime-terrain.bin','scenery.json'].sort();assert.deepEqual(Object.keys(before.optimized).sort(),payloadNames,'Optimized packet payload closure');
assert.deepEqual(Object.keys(before.accepted).sort(),['manifest.json',...refs(accepted).keys()].sort(),'Accepted world payload closure');
assert.equal(receipt.sourceIndexSha256,before.native['cells.json'].sha256);assert.equal(receipt.acceptedManifestSha256,before.accepted['manifest.json'].sha256);
assert.ok(native.cells.length>0&&native.cells.length<10000);assert.equal(candidate.cells.length,native.cells.length);assert.equal(receipt.cells.length,native.cells.length);
const nativeIds=native.cells.map(c=>c.id),candidateIds=candidate.cells.map(c=>c.id),receiptIds=receipt.cells.map(c=>c.cell);
for(const ids of [nativeIds,candidateIds,receiptIds]){assert.ok(ids.every(id=>typeof id==='string'&&id.length>0));assert.equal(new Set(ids).size,ids.length,'Duplicate packet or receipt cell ID');}
assert.deepEqual(candidateIds.slice().sort(),nativeIds.slice().sort(),'Optimized cell IDs differ from native');assert.deepEqual(receiptIds.slice().sort(),nativeIds.slice().sort(),'Receipt cell IDs differ from native');
for(const key of ['schemaVersion','originId','cellSize'])assert.deepEqual(candidate[key],native[key]);assert.equal(candidate.originId,accepted.origin.id);assert.equal(candidate.cellSize,accepted.cellSize);
const readPayload=(root,ref)=>{const b=fs.readFileSync(safe(root,ref.path));assert.equal(b.length,ref.bytes);assert.equal(sha(b),ref.sha256);return b;};
const acceptedIds=new Set(accepted.cells.flatMap(c=>c.buildingIds));const owners=new Map(),acceptedCellIds=new Set(accepted.cells.map(c=>c.id));
const imageMap=new Map();for(const r of receipt.cells)for(const m of r.mips){if(imageMap.has(m.nativeSha256))assert.equal(imageMap.get(m.nativeSha256),m.standardSha256);imageMap.set(m.nativeSha256,m.standardSha256);}setImageMap(imageMap);
const shared=new Map(candidate.sharedTextures.map(r=>[r.path,r])),low=new Map(candidate.sharedTexturesM1.map(r=>[r.source,r]));assert.equal(shared.size,candidate.sharedTextures.length);assert.equal(low.size,candidate.sharedTexturesM1.length);
const usedImages=new Set(),checkedMips=new Set(),models=new Map();let peakRss=0;
function memory(){peakRss=Math.max(peakRss,process.memoryUsage().rss);assert.ok(peakRss<1024**3,'Sequential static validation RSS exceeds 1 GiB');}
await MeshoptDecoder.ready;const io=new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.decoder':MeshoptDecoder});
async function model(root,ref){const bytes=readPayload(root,ref),raw=readFacadeGlb(bytes),json=raw.json,external=new Map();for(const b of json.buffers)assert.equal(b.uri,undefined);for(const image of json.images??[])if(image.uri){assert.match(image.uri,/^\.\.\/textures\/[a-f0-9]{64}\.(?:png|ktx2)$/);const name=image.uri.slice(3),r=shared.get(name);assert.ok(r);assert.equal(path.posix.basename(name).split('.')[0],r.sha256);external.set(image.uri,readPayload(root,r));usedImages.add(name);}
  const validation=await validator.validateBytes(bytes,{maxIssues:10000,externalResourceFunction:async uri=>{assert.ok(external.has(uri));return external.get(uri);}});assert.equal(validation.issues.numErrors,0,`${ref.path}: ${JSON.stringify(validation.issues.messages.filter(m=>m.severity===0))}`);const warnings={};for(const m of validation.issues.messages)if(m.severity===1)warnings[m.code]=(warnings[m.code]??0)+1;
  const document=await io.readJSON({json:structuredClone(json),resources:{[GLB_BUFFER]:raw.bin,...Object.fromEntries(external)}});const out={document,json,bin:raw.bin,external,validation:{warnings,warningCount:validation.issues.numWarnings,errors:0}};models.set(`${root}/${ref.path}`,{sha256:ref.sha256,...out.validation});return out;}
function imageBytes(model,image){if(image.uri)return model.external.get(image.uri);const view=model.json.bufferViews[image.bufferView];assert.equal(view.buffer,0);return model.bin.subarray(view.byteOffset??0,(view.byteOffset??0)+view.byteLength);}
function checkMips(model,cellReceipt){const sourceImages=new Map((model.json.images??[]).map(i=>{const b=imageBytes(model,i);return[sha(b),b];}));for(const m of cellReceipt.mips){const original=sourceImages.get(m.nativeSha256);assert.ok(original,`${cellReceipt.cell}: mip source absent`);const standardRef=[...shared.values()].find(r=>r.sha256===m.standardSha256);assert.ok(standardRef);const standard=readPayload(roots.optimized,standardRef);if(standardRef.path.endsWith('.ktx2')){const a=readKtx2Layout(original),b=readKtx2Layout(standard),drops=Math.max(a.width,a.height)===2048?1:0;assert.deepEqual(standard,Buffer.from(dropTopMips(original,drops)));assert.ok(b.width<=2048&&b.height<=2048);if(Math.max(b.width,b.height)>=1024&&b.levelCount>1){const reduced=low.get(standardRef.path);assert.ok(reduced);assert.equal(reduced.sha256,m.lowSha256);assert.deepEqual(readPayload(roots.optimized,reduced),Buffer.from(dropTopMips(standard,1)));}else assert.equal(m.lowSha256,undefined);}else assert.deepEqual(standard,original);checkedMips.add(m.nativeSha256);}}
const cells=[];
for(const original of native.cells){const next=candidate.cells.find(c=>c.id===original.id),r=receipt.cells.find(c=>c.cell===original.id);assert.ok(next&&r);// A western packet may append new owners to an existing edge cell. Accepted building IDs remain forbidden.
  
  const metadata=c=>Object.fromEntries(Object.entries(c).filter(([k])=>!['visual','collision'].includes(k)));assert.deepEqual(metadata(next),metadata(original));assert.equal(new Set(next.buildingIds).size,next.buildingIds.length);for(const b of next.buildings)assert.ok(next.buildingIds.includes(b.id));for(const id of next.buildingIds)assert.ok(!acceptedIds.has(id));
  for(const b of next.buildings){assert.equal(b.cell,next.id);assert.ok(!acceptedIds.has(b.id),`${b.id} already accepted`);assert.ok(!owners.has(b.id),`${b.id} repeated owner`);owners.set(b.id,next.id);}
  const nativeCollision=readPayload(roots.native,original.collision),decoded=decodeDeliverySimulation(readPayload(roots.optimized,next.collision),next.collision);assert.deepEqual(Buffer.from(decoded),nativeCollision);const bounds=deliveryCollisionBounds(decoded,next.boundsXZ);assert.deepEqual(bounds.boundsXZ,next.collision.boundsXZ);assert.equal(bounds.triangles,next.collision.triangles);const hcol=parseCollisionBundle(decoded);for(const c of hcol.colliders){for(const v of c.positions)assert.ok(Number.isFinite(v));for(const i of c.indices)assert.ok(i<c.positions.length/3);}
  assert.equal(r.sourceNearSha256,original.visual.lod0.sha256);assert.equal(r.sourceFarSha256,original.visual.lod2.sha256);const a=await model(roots.native,original.visual.lod0),b=await model(roots.optimized,next.visual.lod0);checkMips(a,r);const near=await compareCity(a,b,`${next.id}/near`),ground=groundFaces(a);
  let mid;if(next.visual.lod1.path===next.visual.lod0.path)mid={aliasNear:true};else{const m=await model(roots.optimized,next.visual.lod1);mid=await compareCity(a,m,`${next.id}/mid`,{ground,limit:.001,attributeLimit:.002,bounds:next.boundsXZ});}
  const fa=await model(roots.native,original.visual.lod2),fb=await model(roots.optimized,next.visual.lod2),far=await compareCity(fa,fb,`${next.id}/far`,{ground,limit:.01,attributeLimit:.02,bounds:next.boundsXZ});
  for(const tier of ['lod0','lod1','lod2']){const ref=next.visual[tier],stats=deliveryGeometryStats(readPayload(roots.optimized,ref));assert.deepEqual(stats,{triangles:ref.triangles,drawCalls:ref.drawCalls,atlases:ref.atlases});assert.ok(ref.drawCalls<=(tier==='lod2'?3:60));}
  cells.push({id:next.id,buildings:next.buildingIds.length,collision:{decodedBytes:decoded.length,triangles:bounds.triangles,exactNativeBytes:true},near,mid,far});console.log(JSON.stringify(cells.at(-1)));global.gc();memory();}
assert.deepEqual([...usedImages].sort(),[...shared.keys()].sort(),'All standard shared images referenced');assert.equal(checkedMips.size,imageMap.size);for(const ref of low.values())assert.ok(usedImages.has(ref.source));
for(const name of ['runtime-terrain.bin','scenery.json'])assert.deepEqual(before.native[name],before.optimized[name],`${name} copied byte exact`);
const report=read(path.join(roots.optimized,'report.json'));assert.equal(report.budgets.pass,true);assert.equal(report.delivery.sourceIndexSha256,before.native['cells.json'].sha256);assert.equal(report.delivery.acceptedBuildingManifestSha256,before.accepted['manifest.json'].sha256);
for(const [name,root]of Object.entries(roots))assert.deepEqual(inventory(root),before[name],`${name} changed during validation`);for(const[f,h]of bound)assert.equal(sha(fs.readFileSync(f)),h,`Validation source changed: ${f}`);
const result={schemaVersion:1,status:'PASS_STATIC_DELIVERY_PACKET_PENDING_WORLD_APPEND_AND_RUNTIME',inputs:Object.fromEntries(Object.entries(before).map(([n,files])=>[n,{files:Object.keys(files).length,bytes:Object.values(files).reduce((s,r)=>s+r.bytes,0),index:files[n==='accepted'?'manifest.json':'cells.json']} ])),sourcesUnchanged:true,inputsUnchanged:true,sourceBinding:pin(path.join(evidence,'bindings-before.json')),oracleDerivation:{source:'tools/verify/verify-optimized-world.mjs',scope:'Native geometry/material comparison functions; image identities are canonicalized only after independent exact encoded mip validation.'},ownership:{acceptedBuildingIds:acceptedIds.size,newUniqueBuildingIds:owners.size,packetCells:candidate.cells.length,newCells:candidate.cells.filter(c=>!acceptedCellIds.has(c.id)).length,overlappingAcceptedCells:candidate.cells.filter(c=>acceptedCellIds.has(c.id)).length,acceptedOwnersReused:0},textures:{standard:shared.size,low:low.size,sourceMipIdentities:checkedMips.size,allSurvivingEncodedLevelsExact:true},models:[...models.values()],cells,peakRssBytes:peakRss,limits:['Independent bidirectional LOD verification samples seven points per changed triangle; this is not an exact continuous Hausdorff proof.','Complete staging packet only: no playable-world append, native terrain seam/road/tree integration, browser visual or runtime/performance acceptance claimed.']};
fs.writeFileSync(path.join(evidence,'result.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({status:result.status,cells:cells.length,models:models.size,peakRssBytes:peakRss,result:pin(path.join(evidence,'result.json'))}));
