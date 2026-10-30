import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {gunzipSync} from 'node:zlib';
import {encodeCollisionBundle,encodeTerrain,encodePackedRoadGraph,type RoadGraph} from '../../../packages/world-schema/src/index.ts';
import {encodeDeliverySimulation} from '../lib/delivery-city-payloads.ts';
import {parseAddressAppendJob,inspectDeliveryAddresses,applyDeliveryAddresses} from '../append_delivery_addresses.ts';
import {sourceSha256} from '../lib/source-files.ts';
const hash='a'.repeat(64);
function fixture(root:string,packedRoads=false){
 const accepted=path.join(root,'accepted'),world=path.join(root,'candidate');fs.mkdirSync(accepted);fs.mkdirSync(world);
 const put=(dir:string,file:string,value:Uint8Array|string)=>{const bytes=Buffer.from(value),absolute=path.join(dir,file);fs.mkdirSync(path.dirname(absolute),{recursive:true});fs.writeFileSync(absolute,bytes);return{path:file,bytes:bytes.length,sha256:sourceSha256(bytes)};};
 const gameplay={originId:'fixture',playArea:{minX:-128,maxX:128,minZ:-128,maxZ:128},supportedArea:{schemaVersion:1,regions:[{id:'public',outer:[[-127,-127],[127,-127],[127,127],[-127,127]]}]},killHeight:-20,addresses:[{label:'Old street 1',position:[-20,-20],headingDeg:90}],landmarks:[{label:'Old landmark',position:[-20,-20],headingDeg:0}],unchanged:{value:42}};
 const roads:RoadGraph={schemaVersion:2,originId:'fixture',source:{id:'fixture',sha256:hash,attribution:'fixture',license:'CC0'},nodes:[{id:'a',kind:'end',position:[-30,0,-10]},{id:'b',kind:'end',position:[-10,0,-10]},{id:'c',kind:'end',position:[10,0,10]},{id:'d',kind:'end',position:[30,0,10]}],lanes:[{id:'old',wayId:1,name:null,highway:'residential',surface:'asphalt',speedLimit:10,width:3,from:'a',to:'b',index:0,count:1,points:[[-30,0,-10],[-10,0,-10]],length:20},{id:'new',wayId:2,name:null,highway:'residential',surface:'asphalt',speedLimit:10,width:3,from:'c',to:'d',index:0,count:1,points:[[10,0,10],[30,0,10]],length:20}],connectors:[],parking:[],footways:[]};
 const create=(dir:string,newBuilding:boolean)=>{const visual=put(dir,'cells/immutable.glb','fixture immutable GLB'),cell=(id:string,low:number,high:number,building:any)=>{const raw=encodeCollisionBundle({originId:'fixture',frame:'X-east,Y-up,Z-south',cell:id,surfaceTags:['road:asphalt']},[{id:'ground',group:'ground',ref:null,positions:Float32Array.from([low,0,low,high,0,low,high,0,high,low,0,high]),indices:Uint32Array.from([0,2,1,0,3,2]),triangleTags:new Uint16Array(2)}]);return{id,cx:low/128,cz:low/128,boundsXZ:[low,low,high,high],visual:{lod0:visual,lod1:visual,lod2:visual},collision:{...put(dir,`cells/${id}.hcol`,raw),triangles:2,boundsXZ:[low,low,high,high]},buildingIds:[building.id],buildings:[building],sourceTiles:[]};};
 const m={schemaVersion:2,worldReleaseId:newBuilding?'candidate-fixture':'accepted-fixture',origin:{id:'fixture',originProjected:[0,0,0]},cellSize:128,boundsRuntimeXZ:[-128,-128,128,128],cells:[cell('old',-128,0,{id:'BID_old',vtj:'old-vtj',registerId:'old-register'}),...(newBuilding?[cell('new',0,128,{id:'BID_new',vtj:'new-vtj',registerId:'new-register'})]:[])],terrain:{...put(dir,'terrain.bin',encodeTerrain({x0:-128,z0:-128,nx:3,nz:3,resolution:128,heights:new Float32Array(9).fill(-1)})),x0:-128,z0:-128,nx:3,nz:3,resolution:128},roads:put(dir,'roads.json',JSON.stringify(roads)),gameplay:put(dir,'gameplay.json',JSON.stringify(gameplay)),assets:[],sources:[{id:'fixture'}],attribution:['CC0'],lighting:'unlit-facades'};const manifest=put(dir,'manifest.json',JSON.stringify(m));return{m,manifest};};
 const old=create(accepted,false),current=create(world,true);
 if(packedRoads){
  const decoded=encodePackedRoadGraph(roads),encoded=encodeDeliverySimulation(decoded);
  current.m.roads={...put(world,'roads/navigation.bin.gz',encoded.bytes),compression:encoded.compression,decodedBytes:encoded.decodedBytes,decodedSha256:encoded.decodedSha256} as any;
  current.manifest=put(world,'manifest.json',JSON.stringify(current.m));
 }
 const feature={type:'Feature',id:'register.new',properties:{vtj_prt:'new-vtj',id:'new-register',katunimi_suomi:'New street',osoitenumero:'2'},geometry:{type:'Polygon',coordinates:[[[19,-21],[21,-21],[21,-19],[19,-19],[19,-21]]]}};
 const register=put(root,'register.geojson',JSON.stringify({type:'FeatureCollection',features:[feature]})),ledger=put(root,'ledger.json',JSON.stringify({schemaVersion:1,source:{id:'helsinki-building-register-wfs',crs:'EPSG:3879',axisOrder:'easting,northing',units:'metres',license:'CC0',attribution:'fixture'},snapshots:{fixture:{path:register.path,bytes:register.bytes,sha256:register.sha256,sourceJobSha256:hash,conflicts:0}}}));
 const selection=put(root,'selection.json',JSON.stringify({schemaVersion:1,kind:'source-bound-additive-addresses',acceptedManifestSha256:old.manifest.sha256,originId:'fixture',snapshot:'fixture',sourceJobSha256:hash,registerLedger:{file:path.join(root,ledger.path),sha256:ledger.sha256},register:{file:path.join(root,register.path),sha256:register.sha256},entries:[{entry:{label:'New street 2',position:[20,20],headingDeg:0},source:{featureId:feature.id,featureSha256:sourceSha256(JSON.stringify(feature)),polygonIndex:0,vtj:'new-vtj',buildingId:'BID_new'}}]}));
 const job={schemaVersion:1,kind:'source-bound-address-append',accepted:{world:accepted,manifestSha256:old.manifest.sha256,addressCount:1,landmarkCount:1},candidate:{world,manifestSha256:current.manifest.sha256},selection:{file:path.join(root,selection.path),sha256:selection.sha256},regions:[[0,0,128,128]],delivery:{mode:'external',worldBudgetBytes:1_000_000}};
 return{job,current,gameplay,world};
}
async function temporary(run:(root:string)=>Promise<void>){const root=fs.mkdtempSync(path.join(os.tmpdir(),'helsinki-address-appender-'));try{await run(root);}finally{const resolved=path.resolve(root);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(resolved).startsWith('helsinki-address-appender-'));fs.rmSync(resolved,{recursive:true,force:true});}}
test('address appender writes a fresh hash-closed derivative with literal prefix, unchanged legacy resolver and private-path-free proof',async()=>temporary(async root=>{
 const f=fixture(root),report=await inspectDeliveryAddresses(f.job,path.join(root,'inspection'));assert.equal(report.eligible,1);assert.equal(fs.existsSync(path.join(root,'inspection','manifest.json')),false);
 const out=path.join(root,'out'),result=await applyDeliveryAddresses(f.job,{out,release:'address-fixture'});assert.equal(result.appended,1);assert.equal(result.legacy.legacyDestinationCount,2);assert.equal(result.legacy.allLegacyResolverResultsUnchanged,true);const m=JSON.parse(fs.readFileSync(path.join(out,'manifest.json'),'utf8')),g=JSON.parse(fs.readFileSync(path.join(out,m.gameplay.path),'utf8'));assert.deepEqual(g.addresses.slice(0,1),f.gameplay.addresses);assert.deepEqual({...g,addresses:f.gameplay.addresses},f.gameplay);assert.deepEqual(m.cells,f.current.m.cells);assert.equal(sourceSha256(fs.readFileSync(path.join(f.world,'manifest.json'))),f.current.manifest.sha256);
 const proof=JSON.parse(gunzipSync(fs.readFileSync(path.join(out,m.publicationFiles[0].path))).toString());assert.ok(proof.producer.packageAliases.every((a:any)=>typeof a.package==='string'&&!('file'in a)));assert.ok(!JSON.stringify(proof).includes(root));assert.equal(proof.legacy.legacyDestinationCount,2);
 for(const c of m.cells)for(const ref of[c.collision,c.visual.lod0])assert.equal(sourceSha256(fs.readFileSync(path.join(out,ref.path))),ref.sha256);
 await assert.rejects(()=>applyDeliveryAddresses(f.job,{out,release:'second-fixture'}),/fresh/);
}));
test('stale world, prefix count and insufficient explicit budget fail before creating a derivative',async()=>temporary(async root=>{
 const f=fixture(root);assert.throws(()=>parseAddressAppendJob({...f.job,unexpected:true}),/fields/);assert.throws(()=>parseAddressAppendJob({...f.job,delivery:{mode:'external'}}));
 const bad=path.join(root,'bad');await assert.rejects(()=>applyDeliveryAddresses({...f.job,candidate:{...f.job.candidate,manifestSha256:hash}},{out:bad,release:'bad-fixture'}),/manifest changed/);assert.equal(fs.existsSync(bad),false);
 await assert.rejects(()=>applyDeliveryAddresses({...f.job,accepted:{...f.job.accepted,addressCount:2}},{out:bad,release:'bad-fixture'}));assert.equal(fs.existsSync(bad),false);
 await assert.rejects(()=>applyDeliveryAddresses({...f.job,delivery:{mode:'external',worldBudgetBytes:1}},{out:bad,release:'bad-fixture'}),/budget/);assert.equal(fs.existsSync(bad),false);
}));

test('address inspection and append consume the packed gzip roads emitted by final navigation',async()=>temporary(async root=>{
 const f=fixture(root,true),report=await inspectDeliveryAddresses(f.job,path.join(root,'inspection'));
 assert.equal(report.eligible,1);
 const out=path.join(root,'out'),result=await applyDeliveryAddresses(f.job,{out,release:'packed-address-fixture'});
 assert.equal(result.appended,1);assert.equal(result.legacy.allLegacyResolverResultsUnchanged,true);
 const manifest=JSON.parse(fs.readFileSync(path.join(out,'manifest.json'),'utf8'));
 assert.deepEqual(manifest.roads,f.current.m.roads);
 assert.deepEqual(fs.readFileSync(path.join(out,manifest.roads.path)),fs.readFileSync(path.join(f.world,manifest.roads.path)));
 const gameplay=JSON.parse(fs.readFileSync(path.join(out,manifest.gameplay.path),'utf8'));
 assert.deepEqual(gameplay.addresses.slice(0,1),f.gameplay.addresses);
 assert.equal(gameplay.addresses[1].label,'New street 2');
}));
