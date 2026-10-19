import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {appendCityCells,type FrontierRepairMetadata} from '../lib/append-city-cells.ts';
import {GlbBuilder,flatNormals} from '../lib/gltf.ts';
import {encodeCollisionBundle,encodeTerrain} from '../../../packages/world-schema/src/index.ts';
const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');

test('frontier merge requires exact evidence and limits the exception to five western metres and downward safety changes',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'helsinki-frontier-test-'));try{
  const base=path.join(root,'base'),extra=path.join(root,'extra'),original=path.join(root,'original'),source=path.join(root,'source');for(const p of[base,extra,original,source])fs.mkdirSync(p);
  const write=(dir:string,name:string,data:Uint8Array)=>{fs.writeFileSync(path.join(dir,name),data);return{path:name,bytes:data.length,sha256:sha(data)};},json=(dir:string,name:string,value:unknown)=>write(dir,name,Buffer.from(JSON.stringify(value)));
  const builder=new GlbBuilder('edge'),positions=new Float32Array([0,0,0,1,0,0,1,0,1]),indices=new Uint32Array([0,2,1]);await builder.addMesh({name:'edge_ground_slabs',positions,indices,normals:flatNormals(positions,indices),materialName:'slabs'},{name:'slabs',unlit:true});const glb=await builder.toGlb('fixture',{},'exact');
  const collision=encodeCollisionBundle({originId:'origin',frame:'X-east,Y-up,Z-south',cell:'edge',surfaceTags:['ground']},[{id:'g:edge',group:'ground',ref:null,positions,indices,triangleTags:new Uint16Array([0])}]);
  const cell=(dir:string)=>({id:'edge',boundsXZ:[-128,0,0,128],visual:{lod0:{...write(dir,'edge.glb',glb),triangles:1,drawCalls:1,atlases:0,textureBytesEstimate:0},lod2:{...write(dir,'edge.far.glb',glb),triangles:1,drawCalls:1,atlases:0,textureBytesEstimate:0}},collision:{...write(dir,'edge.bin',collision),triangles:1},buildingIds:[],buildings:[],sourceTiles:[]});
  const baseIndex={originId:'origin',cellSize:128,cells:[cell(base)]},extraIndex={...baseIndex,cells:[cell(extra)]},index=json(base,'cells.json',baseIndex);json(original,'cells.json',baseIndex);json(extra,'cells.json',extraIndex);
  const old=encodeTerrain({x0:0,z0:0,resolution:1,nx:8,nz:2,heights:new Float32Array(16).fill(10)}),row=[11,9,10,10,10,10,10,10,10],heights=Float32Array.from([...row,...row]),terrain=(h:Float32Array)=>encodeTerrain({x0:-1,z0:0,resolution:1,nx:9,nz:2,heights:h}),expanded=terrain(heights),oldSupport=write(base,'runtime-terrain.bin',old),support=write(root,'runtime.bin',expanded),src=write(source,'terrain.bin',expanded);
  json(source,'terrain.json',{file:'terrain.bin',sha256:src.sha256});json(root,'config.json',{budgets:{drawCallsPerCell:60},streaming:{enabled:true}});
  const evidence=json(root,'evidence.json',{protectedInteriorPreserved:true,originalBaseIndexSha256:index.sha256,trimmedBaseIndexSha256:index.sha256}),metadata:FrontierRepairMetadata={schemaVersion:1,originalBaseCells:original,originalBaseIndexSha256:index.sha256,trimmedBaseIndexSha256:index.sha256,geographicRegion:[-1,0,0,1],groundRegion:[-1,0,5,1],sourceBand:[-6,0,5,1],cutX:5,protectedMinX:5,protectedInteriorPreserved:true,evidence:{path:path.join(root,'evidence.json'),sha256:evidence.sha256}};
  const report={supportTerrain:oldSupport,inputs:{terrainSha256:'original'},totals:{residentTextureMiBEstimate:0},budgets:{pass:true}};json(original,'report.json',report);
  const setReports=(m=metadata,nextSupport=support)=>{json(base,'report.json',{...report,frontierRepair:m});json(extra,'report.json',{...report,supportTerrain:nextSupport,groundRegion:m.groundRegion,excludedGround:{indexSha256:index.sha256},frontierRepair:m});};setReports();
  const options={baseCells:base,appendCells:extra,region:[-1,0,0,1]as const,sourceTerrain:source,runtimeTerrain:path.join(root,'runtime.bin'),config:path.join(root,'config.json'),out:path.join(root,'merged'),frontierRepair:path.join(root,'evidence.json')},pass=appendCityCells(options);
  assert.equal(pass.status,'PASS_APPEND_ONLY_RUNTIME_PENDING');assert.equal(pass.report.appendCity.loweredFrontierRuntimeSamples,2);assert.deepEqual(pass.report.appendCity.region,[-1,0,0,1]);assert.equal(pass.report.appendCity.frontierRepair!.cutX,5);
  const reject=(name:string,pattern:RegExp,overrides:Partial<typeof options>={})=>{const out=path.join(root,name);assert.throws(()=>appendCityCells({...options,...overrides,out}),pattern);assert.ok(!fs.existsSync(out));};
  reject('no-explicit-proof',/clipping region/,{frontierRepair:undefined});
  setReports({...metadata,evidence:{...metadata.evidence,sha256:'stale'}});reject('stale-proof',/evidence hash changed/);setReports();
  setReports({...metadata,cutX:6,protectedMinX:6,groundRegion:[-1,0,6,1]});reject('wider-frontier',/exactly five metres/);setReports();
  setReports({...metadata,sourceBand:[-7,0,5,1]});reject('unbound-source-band',/source band differs/);setReports();
  const raised=heights.slice();raised[1]=11;setReports(metadata,write(root,'runtime.bin',terrain(raised)));reject('raised-old-floor',/lower-only frontier/);
  const interior=heights.slice();interior[6]=9;setReports(metadata,write(root,'runtime.bin',terrain(interior)));reject('protected-interior-change',/lower-only frontier/);
  write(root,'runtime.bin',expanded);setReports();json(extra,'report.json',{...report,supportTerrain:support,groundRegion:metadata.groundRegion,excludedGround:{indexSha256:'stale'},frontierRepair:metadata});reject('wrong-coverage',/exact accepted ground coverage/);
 }finally{const resolved=path.resolve(root);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(resolved).startsWith('helsinki-frontier-test-'));fs.rmSync(resolved,{recursive:true,force:true});}
});

test('north merge binds its explicit axis proof and rejects any old sample change beyond five metres',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'helsinki-frontier-test-'));try{
  const base=path.join(root,'base'),extra=path.join(root,'extra'),original=path.join(root,'original'),source=path.join(root,'source');for(const p of[base,extra,original,source])fs.mkdirSync(p);
  const write=(dir:string,name:string,data:Uint8Array)=>{fs.writeFileSync(path.join(dir,name),data);return{path:name,bytes:data.length,sha256:sha(data)};},json=(dir:string,name:string,value:unknown)=>write(dir,name,Buffer.from(JSON.stringify(value)));
  const builder=new GlbBuilder('edge'),positions=new Float32Array([0,0,-2,1,0,-2,1,0,-1]),indices=new Uint32Array([0,2,1]);await builder.addMesh({name:'edge_ground_slabs',positions,indices,normals:flatNormals(positions,indices),materialName:'slabs'},{name:'slabs',unlit:true});const glb=await builder.toGlb('fixture',{},'exact');
  const collision=encodeCollisionBundle({originId:'origin',frame:'X-east,Y-up,Z-south',cell:'edge',surfaceTags:['ground']},[{id:'g:edge',group:'ground',ref:null,positions,indices,triangleTags:new Uint16Array([0])}]);
  const cell=(dir:string)=>({id:'edge',boundsXZ:[0,-128,128,0],visual:{lod0:{...write(dir,'edge.glb',glb),triangles:1,drawCalls:1,atlases:0,textureBytesEstimate:0},lod2:{...write(dir,'edge.far.glb',glb),triangles:1,drawCalls:1,atlases:0,textureBytesEstimate:0}},collision:{...write(dir,'edge.bin',collision),triangles:1},buildingIds:[],buildings:[],sourceTiles:[]});
  const baseIndex={originId:'origin',cellSize:128,cells:[cell(base)]},extraIndex={...baseIndex,cells:[cell(extra)]},index=json(base,'cells.json',baseIndex),extraRef=json(extra,'cells.json',extraIndex);json(original,'cells.json',baseIndex);
  const old=encodeTerrain({x0:0,z0:0,resolution:1,nx:2,nz:8,heights:new Float32Array(16).fill(10)}),heights=Float32Array.from([11,11,9,9,...new Array(14).fill(10)]),terrain=(h:Float32Array)=>encodeTerrain({x0:0,z0:-1,resolution:1,nx:2,nz:9,heights:h}),expanded=terrain(heights),oldSupport=write(base,'runtime-terrain.bin',old),support=write(root,'runtime.bin',expanded),src=write(source,'terrain.bin',expanded);
  json(source,'terrain.json',{file:'terrain.bin',sha256:src.sha256});json(root,'config.json',{budgets:{drawCallsPerCell:60},streaming:{enabled:true}});
  const metadata:FrontierRepairMetadata={schemaVersion:2,axis:'z',cut:5,protectedSide:'south',acceptedBounds:[0,0,1,7],originalBaseCells:original,originalBaseIndexSha256:index.sha256,trimmedBaseIndexSha256:index.sha256,geographicRegion:[0,-1,1,0],groundRegion:[0,-1,1,5],sourceBand:[0,-6,1,5],protectedInteriorPreserved:true,evidence:{path:path.join(root,'evidence.json'),sha256:''}};
  const report={supportTerrain:oldSupport,inputs:{terrainSha256:'original'},totals:{residentTextureMiBEstimate:0},budgets:{pass:true}};json(original,'report.json',report);
  const setReports=(m=metadata,nextSupport=support,evidencePatch:Record<string,unknown>={})=>{
   const evidence=json(root,'evidence.json',{...m,repairedStripIndexSha256:extraRef.sha256,...evidencePatch}),bound={...m,evidence:{...m.evidence,sha256:evidence.sha256}};
   json(base,'report.json',{...report,frontierRepair:bound});json(extra,'report.json',{...report,supportTerrain:nextSupport,groundRegion:m.groundRegion,excludedGround:{indexSha256:index.sha256},frontierRepair:bound});
  };setReports();
  const options={baseCells:base,appendCells:extra,region:[0,-1,1,0]as const,sourceTerrain:source,runtimeTerrain:path.join(root,'runtime.bin'),config:path.join(root,'config.json'),out:path.join(root,'merged'),frontierRepair:path.join(root,'evidence.json')},pass=appendCityCells(options);
  assert.equal(pass.status,'PASS_APPEND_ONLY_RUNTIME_PENDING');assert.equal(pass.report.appendCity.loweredFrontierRuntimeSamples,2);assert.equal(pass.report.appendCity.frontierRepair!.axis,'z');assert.equal(pass.report.appendCity.frontierRepair!.cut,5);
  const reject=(name:string,pattern:RegExp)=>{const out=path.join(root,name);assert.throws(()=>appendCityCells({...options,out}),pattern);assert.ok(!fs.existsSync(out));};
  setReports({...metadata,cut:6,groundRegion:[0,-1,1,6]});reject('wider-north-band',/exactly five metres/);
  setReports({...metadata,sourceBand:[0,-7,1,5]});reject('unbound-native-band',/source band differs/);
  setReports({...metadata,protectedSide:'east'});reject('wrong-protected-side',/protected side differs/);
  setReports({...metadata,acceptedBounds:[0,0,1,8]});reject('wrong-accepted-extent',/accepted extent differs/);
  setReports(metadata,support,{axis:'x'});reject('mismatched-evidence-axis',/evidence axis differs/);
  setReports(metadata,support,{repairedStripIndexSha256:'stale'});reject('unbound-strip-index',/repaired strip index changed/);
  const raised=heights.slice();raised[2]=11;setReports(metadata,write(root,'runtime.bin',terrain(raised)));reject('north-floor-raised',/lower-only frontier/);
  const cutSample=heights.slice();cutSample[12]=9;setReports(metadata,write(root,'runtime.bin',terrain(cutSample)));reject('north-protected-cut-changed',/lower-only frontier/);
  const westInterior=heights.slice();westInterior[16]=9;setReports(metadata,write(root,'runtime.bin',terrain(westInterior)));reject('old-west-interior-changed',/lower-only frontier/);
 }finally{const resolved=path.resolve(root);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(resolved).startsWith('helsinki-frontier-test-'));fs.rmSync(resolved,{recursive:true,force:true});}
});
