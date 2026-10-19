import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {GlbBuilder,flatNormals} from '../lib/gltf.ts';
import {encodeCollisionBundle,geodeticToGk25} from '../../../packages/world-schema/src/index.ts';
import {planTramVisuals} from '../plan_tram_visuals.ts';
import {applyTramVisuals} from '../apply_tram_visuals.ts';

const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
async function fixture(){
 const root=path.resolve(tmpdir()),dir=fs.mkdtempSync(path.join(root,'helsinki-tram-')),cells=path.join(dir,'cells');fs.mkdirSync(cells);
 const put=(file:string,value:unknown)=>{fs.writeFileSync(file,JSON.stringify(value));return sha(fs.readFileSync(file));};
 const positions=new Float32Array([-2,0,-2,12,0,-2,12,0,2,-2,0,2]),indices=new Uint32Array([0,2,1,0,3,2]);
 async function glb(coarse:boolean){const b=new GlbBuilder('fixture');await b.addMesh({name:coarse?'coarse':'test_ground_slabs',positions,indices,normals:flatNormals(positions,indices),materialName:'source-stone'},{name:'source-stone',unlit:false});if(coarse)b.doc.getRoot().listMeshes()[0]!.listPrimitives()[0]!.setAttribute('COLOR_0',b.doc.createAccessor().setType('VEC3').setBuffer(b.doc.getRoot().listBuffers()[0]!).setArray(new Float32Array(12).fill(.4)));return b.toGlb('original-source',{},'exact');}
 const visual=await glb(false),coarse=await glb(true),collision=encodeCollisionBundle({originId:'tram-test',frame:'X-east,Y-up,Z-south',cell:'test',surfaceTags:['road','wall']},[{id:'g:test',group:'ground',ref:null,positions,indices,triangleTags:new Uint16Array([0,0])}]);
 for(const[name,bytes]of[['visual.glb',visual],['lod1.glb',visual],['coarse.glb',coarse],['collision.bin',collision]] as const)fs.writeFileSync(path.join(cells,name),bytes);
 const[E,N]=geodeticToGk25(60.17,24.95),[e2,n2]=geodeticToGk25(60.17,24.9501),origin=path.join(dir,'origin.json'),originSha=put(origin,{id:'tram-test',crs:'EPSG:3879',heightDatum:'N2000',originProjected:[E,N,0]});
 const tags={railway:'tram',gauge:'1000'},osm=path.join(dir,'osm.json'),osmSha=put(osm,{elements:[{type:'node',id:1,lat:60.17,lon:24.95},{type:'node',id:2,lat:60.17,lon:24.9501},{type:'way',id:12,nodes:[1,2],tags}]}),profile=path.join(dir,'profile.json');
 put(profile,{schemaVersion:1,origin:{sha256:originSha},osm:{path:osm,sha256:osmSha},scope:{renderBoundsRuntimeXZ:[0,-1,10,1]},gauge:{metres:1},tracks:[{wayId:12,tags,points:[{nodeId:1,x:0,z:0},{nodeId:2,x:e2-E,z:-(n2-N)}]}]});
 const ref=(name:string,bytes:Uint8Array)=>({path:name,bytes:bytes.length,sha256:sha(bytes),triangles:2,drawCalls:1,atlases:0,textureBytesEstimate:0});
 put(path.join(cells,'cells.json'),{originId:'tram-test',cellSize:128,cells:[{id:'test',boundsXZ:[-2,-2,12,2],visual:{lod0:ref('visual.glb',visual),lod1:ref('lod1.glb',visual),lod2:ref('coarse.glb',coarse)},collision:{path:'collision.bin',sha256:sha(collision),bytes:collision.length,triangles:2},buildings:[],buildingIds:[],sourceTiles:[]}]});
 put(path.join(cells,'report.json'),{totals:{triangles:2,drawCalls:1},arbitraryOriginalMetadata:{mustStay:true}});fs.writeFileSync(path.join(cells,'runtime-terrain.bin'),new Uint8Array([1,2,3,4]));put(path.join(cells,'scenery.json'),{instances:[{id:'accepted-tree',position:[1,2,3]}]});
 return{dir,cells,origin,profile,osm,plan:path.join(dir,'plan.json'),out:path.join(dir,'out'),cleanup(){assert.ok(dir.startsWith(root+path.sep)&&path.basename(dir).startsWith('helsinki-tram-'));fs.rmSync(dir,{recursive:true,force:true});}};
}
test('source-bound plan and fresh writer preserve physics, accepted metadata andLOD1 while adding only visual rails',async()=>{
 const f=await fixture();try{
  const oldIndex=fs.readFileSync(path.join(f.cells,'cells.json')),plan=await planTramVisuals({...f,out:f.plan});assert.equal(plan.status,'READY_FOR_ASSET_APPLICATION',JSON.stringify(plan.problems));assert.equal(plan.totals.sourceWays,1);assert.equal(JSON.parse(fs.readFileSync(plan.rows[0].receipt,'utf8')).detail.coverage.unresolvedArea,0);
  const proof=await applyTramVisuals(f);assert.equal(proof.checks.length,1);assert.deepEqual(proof.checks[0].tiers.map((t:any)=>t.addedDraws),[1,1,0]);
  for(const file of ['collision.bin','runtime-terrain.bin','scenery.json'])assert.deepEqual(fs.readFileSync(path.join(f.out,file)),fs.readFileSync(path.join(f.cells,file)));
  assert.deepEqual(fs.readFileSync(path.join(f.cells,'cells.json')),oldIndex);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.out,'report.json'),'utf8')).arbitraryOriginalMetadata,{mustStay:true});
  await assert.rejects(applyTramVisuals(f),/fresh/);
 }finally{f.cleanup();}
});
test('budgets never silently drop track detail and blocked authorities cannot write a candidate',async()=>{
 const f=await fixture();try{const plan=await planTramVisuals({...f,out:f.plan,detailTriangleCap:1,coarseTriangleCap:1});assert.equal(plan.status,'BLOCKED_SOURCE_OR_BUDGET');assert.ok(plan.totals.detailedTriangles>1);await assert.rejects(applyTramVisuals(f),/Unresolved/);assert.equal(fs.existsSync(f.out),false);}finally{f.cleanup();}
});
test('changed raw source or final candidate payload rejects the immutable authority before output exists',async()=>{
 const f=await fixture();try{await planTramVisuals({...f,out:f.plan});fs.appendFileSync(f.osm,' ');await assert.rejects(applyTramVisuals(f),/authority drift/);assert.equal(fs.existsSync(f.out),false);}finally{f.cleanup();}
});
