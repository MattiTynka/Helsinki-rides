import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {NodeIO} from '@gltf-transform/core';
import {ALL_EXTENSIONS} from '@gltf-transform/extensions';
import {MeshoptDecoder} from 'meshoptimizer';
import {GlbBuilder,flatNormals} from '../lib/gltf.ts';
import {readFacadeGlb} from '../lib/facade-glb.ts';
import {AcceptedGroundCoverage,appendCityCells,appendCityCollision,appendCityGlb,clipGroundToRectangle,filterAcceptedBuildings,parseAppendRectangle} from '../lib/append-city-cells.ts';
import {encodeCollisionBundle,encodeTerrain,parseCollisionBundle,type TriMeshCollider} from '../../../packages/world-schema/src/index.ts';
import type {GroundPiece} from '../lib/ground.ts';

const hash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
function ground(minX=-4,maxX=4):GroundPiece{return{cell:'test',finish:'slabs',level:'raised',tag:'road',use:'collision',positions:[minX,minX,0,maxX,maxX,0,maxX,maxX,4,minX,minX,4],uvs:[minX,0,maxX,0,maxX,4,minX,4],indices:[0,2,1,0,3,2]};}
function area(pieces:readonly GroundPiece[]){let area=0;for(const p of pieces)for(let i=0;i<p.indices.length;i+=3){const[a,b,c]=p.indices.slice(i,i+3).map(n=>[p.positions[n*3]!,p.positions[n*3+2]!]);area+=Math.abs((b![0]!-a![0]!)*(c![1]!-a![1]!)-(b![1]!-a![1]!)*(c![0]!-a![0]!))/2;}return area;}
test('rectangle clipping preserves grade, UV interpolation, winding and metadata at a non-grid edge',()=>{
 const original=ground(-1352,-1348),before=structuredClone(original),out=clipGroundToRectangle([original],[-1351,1,-1350,3]);assert.ok(Math.abs(area(out)-2)<1e-10);assert.deepEqual(original,before);
 for(const p of out){assert.equal(p.use,'collision');assert.equal(p.tag,'road');for(let i=0;i<p.positions.length/3;i++){const x=p.positions[i*3]!,y=p.positions[i*3+1]!,z=p.positions[i*3+2]!;assert.ok(x>=-1351&&x<=-1350&&z>=1&&z<=3);assert.equal(y,x);assert.equal(p.uvs[i*2],x);assert.equal(p.uvs[i*2+1],z);}}
 assert.equal(clipGroundToRectangle([original],[-1360,0,-1355,4]).length,0);assert.equal(clipGroundToRectangle([original],[-1355,-1,-1345,5])[0],original);
 for(const invalid of['0,0,0,1','1,0,0,1','0,0,1,NaN','0,1,2',',0,1,2'])assert.throws(()=>parseAppendRectangle(invalid));
 assert.throws(()=>clipGroundToRectangle([{...original,indices:[0,1,99]}],[0,0,1,1]),/index/);
 assert.throws(()=>clipGroundToRectangle([{...original,positions:[NaN,0,0],uvs:[0,0],indices:[0,0,0]}],[0,0,1,1]),/nonfinite/);
});
test('accepted protrusions subtract exact coverage including a closed interior hole without bridging it',()=>{
 const mask=new AcceptedGroundCoverage([[[0,9,1],[2,9,1],[2,9,3]],[[0,9,1],[2,9,3],[0,9,3]]]);
 const result=clipGroundToRectangle([ground()],[ -4,0,4,4],mask);assert.ok(Math.abs(area(result)-28)<1e-9);
 for(const p of result)for(let i=0;i<p.indices.length;i+=3){const ids=p.indices.slice(i,i+3),x=ids.reduce((s,n)=>s+p.positions[n*3]!,0)/3,z=ids.reduce((s,n)=>s+p.positions[n*3+2]!,0)/3;assert.ok(!(x>0&&x<2&&z>1&&z<3),'triangle crosses accepted interior');}
 const full=new AcceptedGroundCoverage([[[ -4,0,0],[4,0,0],[4,0,4]],[[-4,0,0],[4,0,4],[-4,0,4]]]);assert.equal(clipGroundToRectangle([ground()],[-4,0,4,4],full).length,0);
});
test('coverage subtraction splits vertical kerbs, removes covered segments and keeps heights',()=>{
 const p:GroundPiece={...ground(),positions:[-4,0,2,4,0,2,4,1,2,-4,1,2],uvs:[0,0,8,0,8,1,0,1]},mask=new AcceptedGroundCoverage([[[0,0,0],[4,0,0],[4,0,4]],[[0,0,0],[4,0,4],[0,0,4]]]);
 const output=clipGroundToRectangle([p],[-4,0,4,4],mask);assert.ok(output.length);let minY=Infinity,maxY=-Infinity;for(const q of output)for(let i=0;i<q.positions.length;i+=3){assert.ok(q.positions[i]!<=0);minY=Math.min(minY,q.positions[i+1]!);maxY=Math.max(maxY,q.positions[i+1]!);}assert.equal(minY,0);assert.equal(maxY,1);
});
test('building filter preserves all source texture page references and binary spans',()=>{
 const model={buildings:[{id:'accepted',start:0},{id:'new',start:30}],textures:[{index:17}],binary:{sha256:'same'}};const result=filterAcceptedBuildings(model,new Set(['accepted']));assert.deepEqual(result.removed,['accepted']);assert.equal(result.model.textures,model.textures);assert.equal(result.model.binary,model.binary);assert.equal(result.model.buildings[0],model.buildings[1]);assert.equal(model.buildings.length,2);
});
async function glb(name:string,x:number,textured=false){const g=new GlbBuilder(name),positions=Float32Array.from([x,0,0,x+1,0,0,x+1,0,1]),indices=new Uint32Array([0,2,1]);await g.addMesh({name,positions,indices,normals:flatNormals(positions,indices),uvs:new Float32Array([0,0,1,0,1,1]),materialName:'stone'},{name:'stone',unlit:false,texture:textured?{width:2,height:2,data:new Uint8Array(16).fill(175)}:undefined});return g.toGlb('fixture',{},'exact');}
test('GLB append keeps original encoded image and buffer bytes and decoded accessors exact',async()=>{
 const untextured=appendCityGlb(await glb('ground',0),await glb('ground',-10)),validator=await import('gltf-validator');assert.equal((await validator.validateBytes(untextured)).issues.numErrors,0);
 const base=await glb('ground',0,true),extra=await glb('ground',-10,true),out=appendCityGlb(base,extra),a=readFacadeGlb(base),b=readFacadeGlb(out);assert.deepEqual(b.bin.subarray(0,a.bin.length),a.bin);
 await MeshoptDecoder.ready;const io=new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.decoder':MeshoptDecoder}),old=await io.readBinary(base),added=await io.readBinary(extra),merged=await io.readBinary(out);
 for(const[source,name]of[[old,'ground'],[added,'append:ground']]as const){const p=source.getRoot().listNodes()[0]!.getMesh()!.listPrimitives()[0]!,q=merged.getRoot().listNodes().find(n=>n.getName()===name)!.getMesh()!.listPrimitives()[0]!;for(const s of p.listSemantics())assert.deepEqual(q.getAttribute(s)!.getArray(),p.getAttribute(s)!.getArray());assert.deepEqual(q.getIndices()!.getArray(),p.getIndices()!.getArray());assert.deepEqual(q.getMaterial()!.getBaseColorTexture()!.getImage(),p.getMaterial()!.getBaseColorTexture()!.getImage());}
 const report=await validator.validateBytes(out);assert.equal(report.issues.numErrors,0,JSON.stringify(report.issues.messages));
});
async function hierarchyGlb(round:number,names=['cell_ground_slabs',`unique-detail-${round}`]){
 const g=new GlbBuilder('hierarchy'),positions=new Float32Array([round,0,0,round+1,0,0,round+1,0,1]),indices=new Uint32Array([0,2,1]);
 for(const name of names)await g.addMesh({name,positions,indices,normals:flatNormals(positions,indices),uvs:new Float32Array([0,0,1,0,1,1]),materialName:'stone'},{name:'stone',unlit:false,texture:{width:2,height:2,data:new Uint8Array(16).fill(150+round)}});
 const scene=g.doc.getRoot().listScenes()[0]!,parent=g.doc.createNode('city-owner').setTranslation([round,round*2,round*3]).setExtras({owner:round});for(const child of scene.listChildren())parent.addChild(child);scene.addChild(parent);
 return g.toGlb('fixture',{cell:'cell'},'exact');
}
test('repeated city appends choose append2/append3 namespaces while preserving prefixes and hierarchy references',async()=>{
 await MeshoptDecoder.ready;const io=new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.decoder':MeshoptDecoder}),validator=await import('gltf-validator');let bytes=await hierarchyGlb(0);
 for(let round=1;round<=3;round++){
  const extra=await hierarchyGlb(round),base=readFacadeGlb(bytes),source=readFacadeGlb(extra),out=appendCityGlb(bytes,extra),next=readFacadeGlb(out),namespace=round===1?'append:':`append${round}:`;
  assert.deepEqual(appendCityGlb(bytes,extra),out,'Identical inputs must choose identical namespaces');assert.deepEqual(next.bin.subarray(0,base.bin.length),base.bin);const start=(base.bin.length+3)&~3;assert.deepEqual(next.bin.subarray(start,start+source.bin.length),source.bin);
  for(const key of['accessors','bufferViews','samplers','textures','images','materials','meshes','nodes'])assert.deepEqual(((next.json[key]??[])as unknown[]).slice(0,((base.json[key]??[])as unknown[]).length),base.json[key]??[],`Original ${key} prefix changed`);
  const sourceDoc=await io.readBinary(extra),merged=await io.readBinary(out),allNames=merged.getRoot().listNodes().map(n=>n.getName()),expectedName=(name:string)=>name===`unique-detail-${round}`?name:`${namespace}${name}`;assert.equal(new Set(allNames).size,allNames.length);
  for(const old of sourceDoc.getRoot().listNodes()){
   const added=merged.getRoot().listNodes().find(n=>n.getName()===expectedName(old.getName()))!;assert.ok(added);assert.deepEqual(added.getMatrix(),old.getMatrix());assert.deepEqual(added.getWorldMatrix(),old.getWorldMatrix());assert.deepEqual(added.getExtras(),old.getExtras());assert.deepEqual(added.listChildren().map(n=>n.getName()),old.listChildren().map(n=>expectedName(n.getName())));
   for(const[pIndex,p]of(old.getMesh()?.listPrimitives()??[]).entries()){const q=added.getMesh()!.listPrimitives()[pIndex]!;for(const semantic of p.listSemantics()){assert.deepEqual(q.getAttribute(semantic)!.getArray(),p.getAttribute(semantic)!.getArray());assert.equal(q.getAttribute(semantic)!.getNormalized(),p.getAttribute(semantic)!.getNormalized());}assert.deepEqual(q.getIndices()!.getArray(),p.getIndices()!.getArray());assert.deepEqual(q.getMaterial()!.getBaseColorTexture()!.getImage(),p.getMaterial()!.getBaseColorTexture()!.getImage());}
  }
  assert.equal((await validator.validateBytes(out)).issues.numErrors,0);bytes=out;
 }
});
test('append namespace avoids reserved literal incoming prefixed names without renaming unique nodes',async()=>{
 const base=await hierarchyGlb(0,['cell_ground_slabs']),extra=await hierarchyGlb(1,['cell_ground_slabs','append:cell_ground_slabs']),out=readFacadeGlb(appendCityGlb(base,extra)),names=(out.json.nodes as {name:string}[]).map(n=>n.name);assert.equal(new Set(names).size,names.length);assert.ok(names.includes('append2:cell_ground_slabs'));assert.ok(names.includes('append2:city-owner'));assert.ok(names.includes('append:cell_ground_slabs'));assert.ok(!names.includes('append:city-owner'));
});
function collider(id='g:test',group:TriMeshCollider['group']='ground',x=0):TriMeshCollider{return{id,group,ref:null,positions:new Float32Array([x,0,0,x+1,0,0,x+1,0,1]),indices:new Uint32Array([0,2,1]),triangleTags:new Uint16Array([0])};}
function collision(id:string,colliders:TriMeshCollider[],tags=['road']){return encodeCollisionBundle({originId:'origin',frame:'X-east,Y-up,Z-south',cell:id,surfaceTags:tags},colliders);}
test('HCOL appends ground arrays and remaps new tag IDs while preserving all old collider order',()=>{
 const base=collision('test',[collider(),collider('building','buildings')]),extra=collision('test',[collider('g:test','ground',-2),collider('tree','trees')],['raised']),result=parseCollisionBundle(appendCityCollision(base,extra));assert.deepEqual(result.header.surfaceTags,['road','raised']);assert.deepEqual(result.colliders.map(c=>c.id),['g:test','building','tree']);assert.deepEqual(Array.from(result.colliders[0]!.indices),[0,2,1,3,5,4]);assert.deepEqual(Array.from(result.colliders[0]!.triangleTags),[0,1]);assert.deepEqual(result.colliders[1],parseCollisionBundle(base).colliders[1]);assert.throws(()=>appendCityCollision(base,collision('test',[collider('building','buildings')])),/duplicate non-ground/);
});
test('cell merge hardlinks untouched cells, preserves edge prefixes and rejects altered source contracts',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'helsinki-append-test-'));try{
 const base=path.join(root,'base'),extra=path.join(root,'extra'),source=path.join(root,'source');for(const dir of[base,extra,source])fs.mkdirSync(dir);
 const write=(dir:string,name:string,bytes:Uint8Array)=>{const f=path.join(dir,name);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,bytes);return{path:name,bytes:bytes.length,sha256:hash(bytes)};};const json=(dir:string,name:string,value:unknown)=>write(dir,name,Buffer.from(JSON.stringify(value)));
 const model=await glb('ground',0),cell=(dir:string,id:string)=>({id,boundsXZ:[0,0,128,128],visual:{lod0:{...write(dir,`${id}.glb`,model),triangles:1,drawCalls:1,atlases:0,textureBytesEstimate:0},lod2:{...write(dir,`${id}.far.glb`,model),triangles:1,drawCalls:1,atlases:0,textureBytesEstimate:0}},collision:{...write(dir,`${id}.bin`,collision(id,[collider(`g:${id}`)])),triangles:1},buildings:[],buildingIds:[],sourceTiles:[]});
 const ai={originId:'origin',cellSize:128,cells:[cell(base,'edge'),cell(base,'untouched')]},bi={originId:'origin',cellSize:128,cells:[cell(extra,'edge'),cell(extra,'new')]};const index=json(base,'cells.json',ai);json(extra,'cells.json',bi);
 const old=encodeTerrain({x0:0,z0:0,resolution:1,nx:2,nz:2,heights:Float32Array.from([1,2,3,4])}),expanded=encodeTerrain({x0:-1,z0:0,resolution:1,nx:3,nz:2,heights:Float32Array.from([5,1,2,6,3,4])}),support=write(base,'runtime-terrain.bin',old),src=write(source,'terrain.bin',expanded);json(source,'terrain.json',{file:'terrain.bin',sha256:src.sha256});write(root,'support.bin',expanded);json(root,'config.json',{budgets:{drawCallsPerCell:60},streaming:{enabled:true}});
 const acceptedWater={mask:{water:[{id:'existing-sea',rings:[[[0,0],[1,0],[1,1]]]}]},source:{sha256:'accepted-coast'},counts:{water:1}},expandedWater={mask:{water:[...acceptedWater.mask.water,{id:'new-inland-basin',rings:[[[-1,0],[-.5,0],[-.5,.5]]]}]},source:{sha256:'expanded-coast'},counts:{water:2}};
 const report={supportTerrain:support,inputs:{terrainSha256:'old'},totals:{residentTextureMiBEstimate:1},budgets:{pass:true},coastal:acceptedWater},patch={...report,coastal:expandedWater,groundRegion:[-1,0,0,1],excludedGround:{indexSha256:index.sha256}};json(base,'report.json',report);json(extra,'report.json',patch);
 const options={baseCells:base,appendCells:extra,region:[-1,0,0,1]as const,sourceTerrain:source,runtimeTerrain:path.join(root,'support.bin'),config:path.join(root,'config.json'),out:path.join(root,'out')},result=appendCityCells(options);assert.equal(result.status,'PASS_APPEND_ONLY_RUNTIME_PENDING');assert.deepEqual([result.unchanged,result.appended,result.added],[1,1,1]);assert.equal(fs.statSync(path.join(base,'untouched.glb')).ino,fs.statSync(path.join(options.out,'untouched.glb')).ino);assert.equal(fs.statSync(path.join(base,'untouched.glb')).nlink,2);
 const mergedReport=JSON.parse(fs.readFileSync(path.join(options.out,'report.json'),'utf8'));assert.deepEqual(mergedReport.coastal,expandedWater,'Closures need the expanded source mask including the inland basin');assert.deepEqual(mergedReport.appendCity.coastalContexts,{selected:'append',base:acceptedWater,append:expandedWater});assert.equal(mergedReport.appendCity.baseReportSha256,hash(fs.readFileSync(path.join(base,'report.json'))));assert.equal(mergedReport.appendCity.appendReportSha256,hash(fs.readFileSync(path.join(extra,'report.json'))));
 json(extra,'report.json',{...patch,coastal:undefined});const fallbackOut=path.join(root,'fallback');appendCityCells({...options,out:fallbackOut});const fallbackReport=JSON.parse(fs.readFileSync(path.join(fallbackOut,'report.json'),'utf8'));assert.deepEqual(fallbackReport.coastal,acceptedWater);assert.deepEqual(fallbackReport.appendCity.coastalContexts,{selected:'base',base:acceptedWater,append:null});json(extra,'report.json',patch);
 assert.throws(()=>appendCityCells({...options,out:path.join(root,'bad') ,region:[-2,0,0,1]}),/clipping region/);assert.ok(!fs.existsSync(path.join(root,'bad')));
 json(extra,'report.json',{...patch,excludedGround:{indexSha256:'stale'}});assert.throws(()=>appendCityCells({...options,out:path.join(root,'bad')}),/accepted ground/);assert.ok(!fs.existsSync(path.join(root,'bad')));
 json(extra,'report.json',{...patch,groundRegion:[-.5,0,.5,1]});assert.throws(()=>appendCityCells({...options,out:path.join(root,'bad'),region:[-.5,0,.5,1]}),/contiguous full rectangular strip/);assert.ok(!fs.existsSync(path.join(root,'bad')));
 json(extra,'report.json',patch);const broken=expanded.slice();new DataView(broken.buffer).setFloat32(32,99,true);write(root,'support.bin',broken);assert.throws(()=>appendCityCells({...options,out:path.join(root,'bad')}),/terrain sample changed/);assert.ok(!fs.existsSync(path.join(root,'bad')));
 }finally{const resolved=path.resolve(root);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(resolved).startsWith('helsinki-append-test-'));fs.rmSync(resolved,{recursive:true,force:true});}
});
