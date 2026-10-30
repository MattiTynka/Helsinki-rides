import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {geodeticToGk25,gk25ToGeodetic} from '../../../packages/world-schema/src/index.ts';
import {decodeQuantizedMesh,tileDegrees} from '../lib/quantized-mesh.ts';
import {loadQualifiedTerrainFallback} from '../lib/terrain-source-fallback.ts';
const sha=(b:Uint8Array|string)=>createHash('sha256').update(b).digest('hex');
function fixture(run:(context:ReturnType<typeof create>)=>void){const root=fs.mkdtempSync(path.join(os.tmpdir(),'terrain-source-fallback-'));try{run(create(root));}finally{assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(root).startsWith('terrain-source-fallback-'));fs.rmSync(root,{recursive:true,force:true});}}
function create(root:string){
  const write=(name:string,content:Uint8Array|object)=>{const bytes=content instanceof Uint8Array?content:Buffer.from(JSON.stringify(content)+'\n');fs.writeFileSync(path.join(root,name),bytes);return{path:name,bytes:bytes.length,sha256:sha(bytes)};};
  const tile=Buffer.alloc(120),v=new DataView(tile.buffer,tile.byteOffset,tile.byteLength);v.setFloat32(24,10,true);v.setFloat32(28,20,true);v.setUint32(88,3,true);const zz=(n:number)=>(n<<1)^(n>>31);[[0,32767,0],[0,0,32767],[0,32767,16384]].forEach((values,a)=>values.forEach((value,i)=>v.setUint16(92+a*6+i*2,zz(value-(values[i-1]??0)),true)));v.setUint32(110,1,true);
  // Three high-water indices are zero and decode to 0,1,2.
  const parentPin=write('parent.terrain',tile),parent={zoom:17,x:149207,y:109338},d=tileDegrees(parent.zoom),point=geodeticToGk25((parent.y+.2)*d-90,(parent.x+.2)*d-180),origin={id:'fixture',originProjected:[point[0]-1,point[1]+1,7.5]},originBytes=Buffer.from(JSON.stringify(origin));
  const [lat,lon]=gk25ToGeodetic(...point),fx=(lon+180)/d,fy=(lat+90)/d,pu=(fx-parent.x)*32767,pv=(fy-parent.y)*32767,mesh=decodeQuantizedMesh(tile),uv=Array.from(mesh.u,(u,i)=>[u,mesh.v[i]!]),heights=Array.from(mesh.height),[[ax,ay],[bx,by],[cx,cy]]=uv as [[number,number],[number,number],[number,number]],det=(bx-ax)*(cy-ay)-(cx-ax)*(by-ay),l1=((bx-pu)*(cy-pv)-(cx-pu)*(by-pv))/det,l2=((cx-pu)*(ay-pv)-(ax-pu)*(cy-pv))/det,l3=1-l1-l2,height=l1*heights[0]!+l2*heights[1]!+l3*heights[2]!,f32=new Float32Array([height-7.5]);
  const metadata=write('layer.json',{version:'v1',projection:'EPSG:4326',scheme:'tms',format:'quantized-mesh-1.0',tiles:['{z}/{x}/{y}.terrain?v={version}'],available:Array.from({length:18},(_,z)=>z===17?[{startX:149207,endX:149207,startY:109338,endY:109338}]:[])}),scope=write('scope.json',{originId:'fixture',originProjected:origin.originProjected,regions:[{id:'new',boundsXZ:[1000,1000,1010,1010]}]});
  const primaryD=tileDegrees(18),indexBytes=Buffer.from(JSON.stringify({zoom:18,tiles:[{x:Math.floor((lon+180)/primaryD),y:Math.floor((lat+90)/primaryD)}]})),ledgerBytes=Buffer.from(JSON.stringify({source:{crs:'EPSG:4326',heightDatum:'N2000'},snapshots:{fixture:{sha256:sha(indexBytes),layer:'https://kartta.hel.fi/3d/datasource-data/fixture/',layerVersion:'v1',layerJsonSha256:metadata.sha256}}}));
  const comparison=write('comparison.json',{parentTile:{sha256:parentPin.sha256},pointEN:point,comparison:{maxAbsoluteNearDelta:.05,maxAbsoluteParentChildDelta:.5,interpretation:'Measured LOD difference, not physical height error.'}});
  const qualification={schemaVersion:1,kind:'qualified-single-sample-parent-terrain-source',primary:{indexSha256:sha(indexBytes),ledgerSha256:sha(ledgerBytes),snapshot:'fixture',zoom:18,layer:'https://kartta.hel.fi/3d/datasource-data/fixture/',version:'v1'},metadata,originSha256:sha(originBytes),scope,guardMetres:128,protectedBuildRegions:[{id:'new',boundsRuntimeXZ:[1000,1000,1010,1010]}],sample:{runtimeXZ:[1,1],projectedEN:point,parent:{...parent,file:parentPin,downloadReceipt:write('download.json',{url:'https://kartta.hel.fi/3d/datasource-data/fixture/17/149207/109338.terrain?v=v1',tile:{z:17,x:149207,y:109338},sha256:parentPin.sha256,bytes:parentPin.bytes,layerVersion:'v1',layerJsonSha256:metadata.sha256})},triangle:{index:0,vertices:[0,1,2],uv,heightsN2000:heights,barycentric:[l1,l2,l3]},heightN2000:height,runtimeFloat32Bits:new Uint32Array(f32.buffer)[0]!.toString(16).padStart(8,'0'),lodComparison:{report:comparison,maximumNearDeltaMetres:.05,maximumObservedDeltaMetres:.5,interpretation:'Measured LOD difference, not physical height error.'}},reason:'Explicit fixture source gap outside every128metre build guard; use qualified parent triangle only.'};
  const file=path.join(root,'qualification.json'),save=()=>write('qualification.json',qualification);save();return{root,file,qualification,save,height,inputs:{indexBytes,ledgerBytes,originBytes,snapshotName:'fixture'}};
}
test('single source fallback preserves every primary sample and records exact parent source only at the qualified missing point',()=>fixture(c=>{
  const a=loadQualifiedTerrainFallback(c.file,c.inputs);assert.equal(a.sample(-0,1,1),-0);assert.equal(a.provenance().usedSamples,0);assert.equal(a.sample(null,2,1),null);assert.equal(a.sample(null,1,1),c.height);const report=a.provenance();assert.equal(report.usedSamples,1);assert.equal(report.samples[0]!.runtimeFloat32Bits,c.qualification.sample.runtimeFloat32Bits);assert.equal(report.samples[0]!.sourceHeightN2000,c.height);assert.throws(()=>a.sample(null,1,1),/more than once/);
}));
test('changed sources, an omitted guard, guard admission, wrong triangle or modified source height cannot qualify',()=>fixture(c=>{
  const original=structuredClone(c.qualification);const mutate=(change:()=>void)=>{Object.assign(c.qualification,structuredClone(original));change();c.save();assert.throws(()=>loadQualifiedTerrainFallback(c.file,c.inputs));};
  mutate(()=>c.qualification.primary.indexSha256='a'.repeat(64));mutate(()=>c.qualification.primary.version='v2');mutate(()=>c.qualification.protectedBuildRegions=[]);mutate(()=>c.qualification.protectedBuildRegions[0]!.boundsRuntimeXZ=[-200,-200,1010,1010]);mutate(()=>c.qualification.sample.triangle.vertices=[2,1,0]);mutate(()=>c.qualification.sample.heightN2000+=.01);mutate(()=>c.qualification.sample.runtimeFloat32Bits='00000000');
  Object.assign(c.qualification,structuredClone(original));c.save();fs.appendFileSync(path.join(c.root,'parent.terrain'),'changed');assert.throws(()=>loadQualifiedTerrainFallback(c.file,c.inputs));
}));
test('tiny native terrain CLI emits producer closure and exact raw input hashes without changing primary sampling',()=>fixture(c=>{
  const producerRoot=fileURLToPath(new URL('../../../',import.meta.url)),snapshot=path.join(c.root,'tiny');fs.mkdirSync(snapshot);
  const tile=fs.readFileSync(path.join(c.root,'parent.terrain'));fs.writeFileSync(path.join(snapshot,'tile.terrain'),tile);
  const index=Buffer.from(JSON.stringify({zoom:17,tiles:[{file:'tile.terrain',x:149207,y:109338,sha256:sha(tile)}]})+'\n'),ledger=Buffer.from(JSON.stringify({source:{id:'fixture'},snapshots:{tiny:{sha256:sha(index),layerVersion:'v1'}}})+'\n'),config=Buffer.from(JSON.stringify({playArea:{minX:0,minZ:0,maxX:1,maxZ:1}})+'\n');
  fs.writeFileSync(path.join(snapshot,'tiles.json'),index);fs.writeFileSync(path.join(c.root,'ledger.json'),ledger);fs.writeFileSync(path.join(c.root,'origin.json'),c.inputs.originBytes);fs.writeFileSync(path.join(c.root,'config.json'),config);
  const output=path.join(c.root,'terrain'),result=spawnSync(process.execPath,['tools/world/build_terrain.ts','--tiles',snapshot,'--ledger',path.join(c.root,'ledger.json'),'--origin',path.join(c.root,'origin.json'),'--config',path.join(c.root,'config.json'),'--out',output],{cwd:producerRoot,encoding:'utf8'});assert.equal(result.status,0,result.stderr);
  const doc=JSON.parse(fs.readFileSync(path.join(output,'terrain.json'),'utf8'));assert.deepEqual(doc.inputDigests,{originSha256:sha(c.inputs.originBytes),configSha256:sha(config),ledgerSha256:sha(ledger),indexSha256:sha(index)});
  for(const file of ['tools/world/build_terrain.ts','tools/world/lib/quantized-mesh.ts','tools/world/lib/terrain-source-fallback.ts','packages/world-schema/src/coordinates.ts','pnpm-lock.yaml'])assert.equal(doc.producer.files[file],sha(fs.readFileSync(path.join(producerRoot,file))));
  assert.equal(doc.producer.runtime.node,process.versions.node);assert.equal(doc.nx,2);assert.equal(doc.nz,2);assert.equal(doc.qualifiedSourceFallback,undefined);
}));
