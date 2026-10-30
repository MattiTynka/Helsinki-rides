/** Lossless storage derivative; decoded terrain, road and HCOL bytes stay exact. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {gzipSync} from 'node:zlib';
import {validateWorldManifest,type FileRef,type SimulationFileRef} from '../../../packages/world-schema/src/index.ts';
import {decodeDeliverySimulation,deliverySha} from './delivery-city-payloads.ts';
import {deliveryFile,freshDeliveryDirectory,readDeliveryFile} from './delivery-city.ts';
import {linkOrCopyDeliveryFile,resolveAppendDeliveryBudget,type AppendDeliveryBudget} from './delivery-city-files.ts';
import {bindDeliveryProducer,publicDeliveryProducer,verifyDeliveryProducer} from './delivery-city-provenance.ts';

export function recompressSimulationPayload(stored:Uint8Array,ref:SimulationFileRef){
  const decoded=decodeDeliverySimulation(stored,ref),candidate=gzipSync(decoded,{level:9,mtime:0} as any);
  const encoded={path:'candidate.gz',bytes:candidate.length,sha256:deliverySha(candidate),compression:'gzip' as const,decodedBytes:decoded.length,decodedSha256:deliverySha(decoded)};
  assert.ok(Buffer.from(decodeDeliverySimulation(candidate,encoded)).equals(Buffer.from(decoded)),'Lossless recompression round trip changed decoded bytes');
  return {candidate,encoded,savedBytes:Math.max(0,stored.length-candidate.length)};
}

function collectRefs(value:unknown,refs=new Map<string,FileRef>()){
  if(!value||typeof value!=='object')return refs;
  const v=value as Record<string,unknown>;
  if(typeof v.path==='string'&&typeof v.bytes==='number'&&typeof v.sha256==='string'){
    const ref={path:v.path,bytes:v.bytes,sha256:v.sha256};if(refs.has(ref.path))assert.deepEqual(refs.get(ref.path),ref,'Conflicting manifest payload reference');refs.set(ref.path,ref);
  }
  for(const child of Object.values(v))collectRefs(child,refs);return refs;
}

export function recompressDeliverySimulation(options:{world:string;manifestSha256:string;out:string;release:string;delivery?:AppendDeliveryBudget;cache?:{path:string;sha256:string}}){
  const delivery=resolveAppendDeliveryBudget(options.delivery);
  assert.match(options.manifestSha256,/^[0-9a-f]{64}$/);assert.match(options.release,/^[a-z0-9][a-z0-9-]{0,95}$/);
  const producer=bindDeliveryProducer(new URL('../recompress_delivery_simulation.ts',import.meta.url));
  const manifestBytes=fs.readFileSync(path.join(options.world,'manifest.json'));assert.equal(deliverySha(manifestBytes),options.manifestSha256,'Source manifest changed');
  const before=JSON.parse(manifestBytes.toString());assert.deepEqual(validateWorldManifest(before),[]);
  let cacheDocument:any;const cachedCandidates=new Map<string,any>();
  if(options.cache){
    const cacheFile=path.join(options.cache.path,'cache.json');assert.ok(fs.statSync(cacheFile).size<=8*1024*1024,'Compression cache metadata exceeds bound');const cacheBytes=fs.readFileSync(cacheFile);assert.equal(deliverySha(cacheBytes),options.cache.sha256,'Compression cache pin changed');cacheDocument=JSON.parse(cacheBytes.toString());
    assert.equal(cacheDocument.schemaVersion,1);assert.equal(cacheDocument.kind,'lossless-simulation-gzip-cache');assert.equal(cacheDocument.sourceManifestSha256,options.manifestSha256);assert.ok(Array.isArray(cacheDocument.entries)&&cacheDocument.entries.length<10000);
    for(const entry of cacheDocument.entries){assert.ok(!cachedCandidates.has(entry.source.path),'Duplicate compression cache source');assert.equal(entry.encoded.compression,'gzip');cachedCandidates.set(entry.source.path,entry);}
  }
  const next=structuredClone(before),out=path.resolve(options.out),written=new Map<string,FileRef>();freshDeliveryDirectory(options.world,out);
  const put=(name:string,bytes:Uint8Array)=>{const ref={path:name,bytes:bytes.length,sha256:deliverySha(bytes)},old=written.get(name);if(old){assert.deepEqual(old,ref);return old;}const file=deliveryFile(out,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes,{flag:'wx'});written.set(name,ref);return ref;};
  const rows:any[]=[],cached=new Map<string,SimulationFileRef>();let savedPayloadBytes=0;
  const apply=(kind:'terrain'|'roads'|'collision',ref:SimulationFileRef)=>{
    const source=readDeliveryFile(options.world,ref),key=JSON.stringify(ref),previous=cached.get(key);if(previous)return previous;
    let result=recompressSimulationPayload(source,ref);
    const cachedCandidate=cachedCandidates.get(ref.path);
    if(cachedCandidate){
      assert.deepEqual(cachedCandidate.source,ref,'Compression cache source differs');const candidate=readDeliveryFile(options.cache!.path,cachedCandidate.encoded),raw=decodeDeliverySimulation(source,ref),decoded=decodeDeliverySimulation(candidate,cachedCandidate.encoded);assert.ok(Buffer.from(decoded).equals(Buffer.from(raw)),'Cached compression changes decoded bytes');
      if(candidate.length<result.candidate.length)result={candidate:Buffer.from(candidate),encoded:cachedCandidate.encoded,savedBytes:Math.max(0,source.length-candidate.length)};
    }
    if(!result.savedBytes){rows.push({kind,before:ref,status:'PRESERVED_NO_SAVING'});cached.set(key,ref);return ref;}
    const name=kind==='collision'?`cells/simulation-gzip9.${result.encoded.sha256}.hcol.gz`:`${kind}.gzip9.${result.encoded.sha256}.bin.gz`;
    const after={...ref,...put(name,result.candidate),compression:result.encoded.compression,decodedBytes:result.encoded.decodedBytes,decodedSha256:result.encoded.decodedSha256};
    rows.push({kind,before:ref,after,status:'LOSSLESS_GZIP9',savedBytes:result.savedBytes,decodedBytesExact:true});savedPayloadBytes+=result.savedBytes;cached.set(key,after);return after;
  };
  next.terrain=apply('terrain',before.terrain);next.roads=apply('roads',before.roads);
  for(let i=0;i<next.cells.length;i++)next.cells[i].collision=apply('collision',before.cells[i].collision);
  const restored=structuredClone(next);restored.terrain=before.terrain;restored.roads=before.roads;restored.cells.forEach((cell:any,i:number)=>cell.collision=before.cells[i].collision);assert.deepEqual(restored,before,'Recompression changed fields outside simulation file references');
  verifyDeliveryProducer(producer);
  const proof={schemaVersion:1,kind:'lossless-simulation-gzip9',status:'DECODED_BYTES_EXACT_RUNTIME_PENDING',sourceManifestSha256:options.manifestSha256,delivery,producer:publicDeliveryProducer(producer),...(options.cache?{cache:{sha256:options.cache.sha256,producer:cacheDocument.producer,compression:cacheDocument.compression}}:{}),savedPayloadBytes,rows,limitations:['Stored/download bytes only; decoded physics, terrain and graph memory unchanged.','Geometry, triangle order, collision extents, graph values, scenery, gameplay, actors, textures and visual refs stay unchanged.']};
  const proofRaw=Buffer.from(JSON.stringify(proof)+'\n'),proofEncoded=gzipSync(proofRaw,{level:9,mtime:0} as any),proofRef={...put(`publication/simulation-gzip9.${options.manifestSha256.slice(0,20)}.json.gz`,proofEncoded),compression:'gzip' as const,decodedBytes:proofRaw.length,decodedSha256:deliverySha(proofRaw)};
  decodeDeliverySimulation(proofEncoded,proofRef);next.publicationFiles=[...(next.publicationFiles??[]),proofRef];next.worldReleaseId=options.release;next.builtAt=new Date().toISOString();assert.deepEqual(validateWorldManifest(next),[]);
  const refs=collectRefs(next);for(const ref of refs.values())if(!written.has(ref.path)){const target=deliveryFile(out,ref.path);fs.mkdirSync(path.dirname(target),{recursive:true});linkOrCopyDeliveryFile(deliveryFile(options.world,ref.path),target,ref);}
  const bytes=Buffer.from(JSON.stringify(next,null,1)+'\n'),worldBytes=bytes.length+[...refs.values()].reduce((sum,ref)=>sum+ref.bytes,0);
  assert.ok(delivery.inclusive?worldBytes<=delivery.worldBudgetBytes:worldBytes<delivery.worldBudgetBytes,`Recompressed world exceeds ${delivery.mode} budget`);assert.ok(refs.size+1<10000&&bytes.length<=8*1024*1024,'Manifest/file budget exceeded');
  verifyDeliveryProducer(producer);if(options.cache)assert.equal(deliverySha(fs.readFileSync(path.join(options.cache.path,'cache.json'))),options.cache.sha256,'Compression cache changed');assert.equal(deliverySha(fs.readFileSync(path.join(options.world,'manifest.json'))),options.manifestSha256,'Source manifest changed');fs.writeFileSync(path.join(out,'manifest.json'),bytes,{flag:'wx'});
  return {status:proof.status,delivery,manifestSha256:deliverySha(bytes),worldBytes,files:refs.size+1,savedPayloadBytes,changedPayloads:rows.filter(row=>row.status==='LOSSLESS_GZIP9').length,proofRef};
}
