import assert from 'node:assert/strict';
import {test} from 'node:test';
import {gzipSync} from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {decodeSimulationPayload,encodeTerrain} from '../../../packages/world-schema/src/index.ts';
import {deliverySha} from '../lib/delivery-city-payloads.ts';
import {recompressSimulationPayload,recompressDeliverySimulation} from '../lib/delivery-simulation-recompression.ts';

test('level9 delivery retains exact runtime-decoded HCOL-like bytes and rejects wrong source pins',async()=>{
  const raw=Buffer.from(Array.from({length:20000},(_,i)=>`HCOL:${i%43}:position:${i%113}\n`).join('')),stored=gzipSync(raw,{level:1}),ref={path:'cells/test.gz',bytes:stored.length,sha256:deliverySha(stored),compression:'gzip' as const,decodedBytes:raw.length,decodedSha256:deliverySha(raw)};
  const result=recompressSimulationPayload(stored,ref);assert.ok(result.savedBytes>0);assert.deepEqual(Buffer.from(await decodeSimulationPayload(result.candidate,result.encoded)),raw);
  assert.throws(()=>recompressSimulationPayload(stored,{...ref,sha256:'0'.repeat(64)}));assert.throws(()=>recompressSimulationPayload(stored,{...ref,decodedSha256:'0'.repeat(64)}));assert.throws(()=>recompressSimulationPayload(stored,{...ref,decodedBytes:raw.length+1}));
});

test('uncompressed road JSON round trips through the existing runtime gzip path; incompressible payload is not a saving',async()=>{
  const raw=Buffer.from('{"lanes":'+JSON.stringify(Array.from({length:300},(_,i)=>({id:i,points:[[1.123456789,2,3],[4,5,6]]})))+'}'),ref={path:'roads.json',bytes:raw.length,sha256:deliverySha(raw)};
  const result=recompressSimulationPayload(raw,ref);assert.ok(result.savedBytes>0);assert.deepEqual(Buffer.from(await decodeSimulationPayload(result.candidate,result.encoded)),raw);
  const tiny=new Uint8Array([1,2,3]),noSaving=recompressSimulationPayload(tiny,{path:'tiny.bin',bytes:tiny.length,sha256:deliverySha(tiny)});assert.equal(noSaving.savedBytes,0);
});

test('fresh world preserves all nonsimulation refs and collision metadata; pinned cache cannot substitute other decoded bytes',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'helsinki-simulation-gzip-'));
  try{
    const world=path.join(root,'world'),cache=path.join(root,'cache');fs.mkdirSync(world);fs.mkdirSync(cache);
    const put=(folder:string,name:string,bytes:Uint8Array)=>{const file=path.join(folder,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);return{path:name,bytes:bytes.length,sha256:deliverySha(bytes)};};
    const raw=Buffer.from('immutable HCOL arrays\n'.repeat(50000)),stored=gzipSync(raw,{level:1}),collision={...put(world,'cells/source.hcol.gz',stored),compression:'gzip' as const,decodedBytes:raw.length,decodedSha256:deliverySha(raw),triangles:50,boundsXZ:[-1,-2,130,140]},visual={...put(world,'cells/source.glb',Buffer.from('fixed visual bytes')),triangles:1,drawCalls:1,atlases:0,textureBytesEstimate:0};
    const manifest={schemaVersion:2,worldReleaseId:'fixture-source',origin:{id:'test',originProjected:[0,0,0]},cellSize:128,boundsRuntimeXZ:[0,0,128,128],cells:[{id:'old',cx:0,cz:0,boundsXZ:[0,0,128,128],visual:{lod0:visual,lod1:visual,lod2:visual},collision,buildingIds:[],buildings:[],sourceTiles:[]}],terrain:{...put(world,'terrain.bin',encodeTerrain({x0:0,z0:0,nx:2,nz:2,resolution:1,heights:new Float32Array([1,2,3,4])})),x0:0,z0:0,nx:2,nz:2,resolution:1},roads:put(world,'roads.json',Buffer.from('{"fixed":"road"}'.repeat(500))),gameplay:put(world,'gameplay.json',Buffer.from('{"fixed":"spawn"}')),assets:[],sharedTextures:[],sharedTexturesM1:[],sources:[{id:'test'}],attribution:['CC0'],lighting:'unlit-facades'};
    const sourceBytes=Buffer.from(JSON.stringify(manifest));fs.writeFileSync(path.join(world,'manifest.json'),sourceBytes);
    const encoded=gzipSync(raw,{level:9}),encodedRef={...put(cache,'payloads/cache.gz',encoded),compression:'gzip',decodedBytes:raw.length,decodedSha256:deliverySha(raw)};
    const cacheData={schemaVersion:1,kind:'lossless-simulation-gzip-cache',sourceManifestSha256:deliverySha(sourceBytes),producer:{sha256:'a'.repeat(64)},compression:{codec:'gzip'},entries:[{source:collision,encoded:encodedRef}]};
    const cacheBytes=Buffer.from(JSON.stringify(cacheData));fs.writeFileSync(path.join(cache,'cache.json'),cacheBytes);
    const options={world,manifestSha256:deliverySha(sourceBytes),release:'fixture-gzip',delivery:{mode:'external' as const,worldBudgetBytes:2_000_000},cache:{path:cache,sha256:deliverySha(cacheBytes)}};
    const out=path.join(root,'out'),result=recompressDeliverySimulation({...options,out}),next=JSON.parse(fs.readFileSync(path.join(out,'manifest.json'),'utf8'));
    assert.ok(result.savedPayloadBytes>0);assert.match(next.cells[0].collision.path,/\.hcol\.gz$/);assert.deepEqual(next.cells[0].visual,manifest.cells[0]!.visual);assert.deepEqual(next.cells[0].collision.boundsXZ,collision.boundsXZ);assert.equal(next.cells[0].collision.triangles,50);assert.deepEqual(next.gameplay,manifest.gameplay);assert.deepEqual(next.assets,manifest.assets);assert.deepEqual(next.sharedTextures,manifest.sharedTextures);assert.deepEqual(Buffer.from(await decodeSimulationPayload(fs.readFileSync(path.join(out,next.cells[0].collision.path)),next.cells[0].collision)),raw);assert.deepEqual(fs.readFileSync(path.join(world,'manifest.json')),sourceBytes);
    const bad=structuredClone(cacheData),other=Buffer.from('different but well formed decoded bytes');bad.entries[0]!.encoded={...put(cache,'payloads/wrong.gz',gzipSync(other)),compression:'gzip',decodedBytes:other.length,decodedSha256:deliverySha(other)};const badBytes=Buffer.from(JSON.stringify(bad));fs.writeFileSync(path.join(cache,'cache.json'),badBytes);
    const refused=path.join(root,'refused');assert.throws(()=>recompressDeliverySimulation({...options,out:refused,cache:{path:cache,sha256:deliverySha(badBytes)}}),/changes decoded bytes/);assert.ok(!fs.existsSync(path.join(refused,'manifest.json')));
    assert.throws(()=>recompressDeliverySimulation({...options,out:path.join(root,'bad-cache')}),/cache pin changed/);assert.ok(!fs.existsSync(path.join(root,'bad-cache')));
    assert.throws(()=>recompressDeliverySimulation({...options,cache:undefined,out:path.join(world,'nested')}),/may not overlap/);assert.ok(!fs.existsSync(path.join(world,'nested')));
  }finally{const target=path.resolve(root);assert.ok(target.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(target).startsWith('helsinki-simulation-gzip-'));fs.rmSync(target,{recursive:true,force:true});}
});
