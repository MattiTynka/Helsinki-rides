import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {GlbBuilder,flatNormals,encodeKtx2} from '../lib/gltf.ts';
import {facadeAtlasBytes,facadeAtlasBc7Bytes,facadeTriangleKey,facadeChartSha256 as sha,type FacadeTriangle,type FacadeChart} from '../lib/facade-charts.ts';
import {authorGroupedFacadeCharts,type GroupedFacadePlan} from '../author_senate_facade_charts.ts';
import {facadeChartUv} from '../lib/facade-charts.ts';
import {applyDeliveryFacadeCharts,deliveryFacadeSourceOwners,rebindDeliveryFacadeFaces,type DeliveryFacadeProfile} from '../apply_delivery_facade_charts.ts';
import {applyFacadeChartsToGlb,readFacadeChartTriangles} from '../lib/facade-chart-glb.ts';
import sharp from 'sharp';

const rectangle=(x:number):FacadeTriangle[]=>[[[x,0,0],[x+8,0,0],[x+8,20,0]],[[x,0,0],[x+8,20,0],[x,20,0]]];
const A=rectangle(0),B=rectangle(10),untargeted=rectangle(20);
async function cell(coarse:boolean){
  const b=new GlbBuilder('group-fixture'),P=Float32Array.from([...A,...B,...untargeted].flat(2)),I=Uint32Array.from({length:P.length/3},(_,i)=>i);
  await b.addMesh({name:'facades',positions:P,indices:I,normals:flatNormals(P,I),...(!coarse?{uvs:new Float32Array(P.length/3*2).fill(.5)}:{}),materialName:'shared-wall'},
    {name:'shared-wall',unlit:true,...(!coarse?{textureKind:'facade' as const,texture:{width:8,height:8,data:new Uint8Array(8*8*4).fill(255)}}:{})});
  if(coarse)b.doc.getRoot().listMeshes()[0]!.listPrimitives()[0]!.setAttribute('COLOR_0',b.doc.createAccessor().setBuffer(b.doc.getRoot().listBuffers()[0]!).setType('VEC3').setArray(new Float32Array(P.length).fill(.4)));
  return b.toGlb('Synthetic original fixture',{},'exact');
}
async function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'grouped-facade-')),world=path.join(root,'world'),cityDir=path.join(root,'city');fs.mkdirSync(world);fs.mkdirSync(cityDir);
  const file=(name:string,bytes:Uint8Array)=>{const target=path.join(world,name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,bytes);return {path:name,bytes:bytes.length,sha256:sha(bytes)};};
  const detail=await cell(false),coarse=await cell(true),visual=(ref:any,atlases:number)=>({...ref,triangles:6,drawCalls:1,atlases,textureBytesEstimate:atlases*100});
  const detailRef=visual(file('cells/detail.glb',detail),1),coarseRef=visual(file('cells/coarse.glb',coarse),0),collision={...file('cells/physics.hcol',Buffer.from('unchanged-collision')),triangles:2};
  const manifest={schemaVersion:2,worldReleaseId:'fixture-source',origin:{id:'fixture-origin',originProjected:[0,0,0]},cellSize:128,boundsRuntimeXZ:[0,0,128,128],
    cells:[{id:'c_p00_p00',cx:0,cz:0,boundsXZ:[0,0,128,128],visual:{lod0:detailRef,lod1:detailRef,lod2:coarseRef},collision,buildingIds:['A','B'],buildings:[{id:'A',vtj:'vtj-A',texture:'flat-colour'},{id:'B',vtj:'vtj-B',texture:'flat-colour'}],sourceTiles:[]}],
    terrain:{...file('terrain.bin',Buffer.from('unchanged-terrain')),resolution:1,nx:2,nz:2,x0:0,z0:0},roads:file('roads.json',Buffer.from('{}')),gameplay:file('gameplay.json',Buffer.from('{}')),
    sources:[{id:'synthetic',title:'Synthetic test geometry',url:'https://example.org/',license:'CC0',attribution:'Synthetic'}],attribution:['Synthetic'],lighting:'unlit-facades'};
  const manifestBytes=Buffer.from(JSON.stringify(manifest));fs.writeFileSync(path.join(world,'manifest.json'),manifestBytes);
  const pieces:Buffer[]=[],buildings:any[]=[];let offset=0;
  for(const [id,triangles]of [['A',A],['B',B]] as const){
    const P=Float32Array.from(triangles.flatMap(t=>t.flatMap(v=>[v[0],-v[2],v[1]]))),I=Uint32Array.from({length:P.length/3},(_,i)=>i),positions={offset,bytes:P.byteLength};pieces.push(Buffer.from(P.buffer));offset+=P.byteLength;
    const indices={offset,bytes:I.byteLength};pieces.push(Buffer.from(I.buffer));offset+=I.byteLength;buildings.push({id,vtj:`vtj-${id}`,parts:[{positions,indices}]});
  }
  const bin=Buffer.concat(pieces),city={originId:'fixture-origin',binary:{file:'city-model.bin',sha256:sha(bin)},buildings},cityBytes=Buffer.from(JSON.stringify(city));fs.writeFileSync(path.join(cityDir,'city-model.bin'),bin);fs.writeFileSync(path.join(cityDir,'city-model.json'),cityBytes);
  const plan:GroupedFacadePlan={schemaVersion:2,id:'synthetic-reviewed-groups',baselineManifestSha256:sha(manifestBytes),source:{cityJsonSha256:sha(cityBytes),cityBinSha256:sha(bin),originId:'fixture-origin'},references:[{title:'Synthetic fixture; no production reference',url:'https://example.org/reference',role:'appearance-reference-only'}],
    groups:[{cell:'c_p00_p00',atlas:[128,128],buildings:['A','B'].map((id,i)=>({id,vtj:`vtj-${id}`,elevations:[{id:`front-${id}`,triangles:[0,1],pixels:[1+i*64,1,62,126],renderer:'archive-wing',ground:0,notes:'Synthetic reviewed fixture layout'}],limitations:[]}))}]};
  const planFile=path.join(root,'plan.json');fs.writeFileSync(planFile,JSON.stringify(plan));return {root,world,cityDir,planFile,manifest,manifestBytes,detail,coarse};
}

test('two source owners in one cell share one atlas and draw partition across detailed and textureless distant tiers',async()=>{
  const f=await fixture();try{
    const authored=path.join(f.root,'authored');await authorGroupedFacadeCharts({plan:f.planFile,cityModel:f.cityDir,baseline:f.world,out:authored});
    const profileFile=path.join(authored,'c_p00_p00/profile.json'),profile=JSON.parse(fs.readFileSync(profileFile,'utf8')) as DeliveryFacadeProfile;
    assert.deepEqual(deliveryFacadeSourceOwners(profile.cells[0]!),[{id:'A',vtj:'vtj-A'},{id:'B',vtj:'vtj-B'}]);assert.equal(profile.cells.length,1);assert.equal(profile.charts.length,2);
    const proof=await applyDeliveryFacadeCharts({baseline:f.world,current:f.world,cityModel:f.cityDir,profile:profileFile,out:path.join(f.root,'payloads')});
    const update=proof.updates[0];assert.deepEqual(update.after.buildings.map((b:any)=>b.texture),['textured','textured']);assert.equal(update.after.visual.lod0.drawCalls,2);assert.equal(update.after.visual.lod0.atlases,2);
    // 128² + 64² + ... + 1² RGBA texels = 87,380 bytes. The manifest
    // scheduler divides this upper bound by four; a BC7 estimate here undercounts.
    assert.equal(proof.addedTextureEstimate,87380);assert.equal(update.after.visual.lod0.textureBytesEstimate,100+87380);
    assert.equal(update.after.visual.lod2.drawCalls,2);assert.equal(update.after.visual.lod2.atlases,0);assert.equal(update.after.visual.lod2.textureBytesEstimate,0);assert.equal(proof.files.length,2);assert.deepEqual(update.after.visual.lod1,update.after.visual.lod0);
    assert.deepEqual(update.after.collision,f.manifest.cells[0]!.collision);assert.deepEqual(fs.readFileSync(path.join(f.world,'manifest.json')),f.manifestBytes);
    const after=fs.readFileSync(path.join(f.root,'payloads',update.after.visual.lod0.path));assert.deepEqual((await readFacadeChartTriangles(after,new Map())).map(t=>t.key).sort(),(await readFacadeChartTriangles(f.detail)).map(t=>t.key).sort());
    // A legitimate source face from B cannot be relabelled as an A face.
    const bad={...profile,charts:profile.charts.map(c=>c.building==='B'?{...c,building:'A'}:c)},badFile=path.join(authored,'c_p00_p00/wrong-owner.json');fs.writeFileSync(badFile,JSON.stringify(bad));
    await assert.rejects(applyDeliveryFacadeCharts({baseline:f.world,current:f.world,cityModel:f.cityDir,profile:badFile,out:path.join(f.root,'rejected')}),/declared original source building/);
    assert.equal(fs.existsSync(path.join(f.root,'rejected')),false);
    // The same adapter still accepts the original single-owner profile shape.
    const legacy={...profile,charts:profile.charts.filter(c=>c.building==='A'),cells:[{id:'c_p00_p00',building:'A',vtj:'vtj-A',baselineLevels:profile.cells[0]!.baselineLevels,faces:profile.cells[0]!.faces.filter(f=>f.chart==='front-A')}]};
    const legacyFile=path.join(authored,'c_p00_p00/legacy.json');fs.writeFileSync(legacyFile,JSON.stringify(legacy));const old=await applyDeliveryFacadeCharts({baseline:f.world,current:f.world,cityModel:f.cityDir,profile:legacyFile,out:path.join(f.root,'legacy-payloads')});
    assert.deepEqual(old.updates[0].after.buildings.map((b:any)=>b.texture),['textured','flat-colour']);
  }finally{assert.ok(path.resolve(f.root).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(f.root,{recursive:true,force:true});}
});
test('grouped owner normalization rejects duplicate and ambiguous source declarations',()=>{
  const base={id:'cell',baselineLevels:{},faces:[]};
  assert.deepEqual(deliveryFacadeSourceOwners({...base,buildings:[{id:'anonymous-exact-BID',vtj:null}]}),[{id:'anonymous-exact-BID',vtj:null}]);
  for(const vtj of [undefined,'',42])assert.throws(()=>deliveryFacadeSourceOwners({...base,buildings:[{id:'anonymous-exact-BID',vtj}]} as any),/explicit VTJ or null/);
  assert.throws(()=>deliveryFacadeSourceOwners({...base,building:'anonymous-exact-BID',vtj:null} as any),/Legacy source/);
  assert.throws(()=>deliveryFacadeSourceOwners({...base,buildings:[{id:'A',vtj:'A'},{id:'A',vtj:'A'}]}),/Duplicate facade source owner/);
  assert.throws(()=>deliveryFacadeSourceOwners({...base,buildings:[],building:'A',vtj:'A'} as any),/Ambiguous/);
  assert.throws(()=>deliveryFacadeSourceOwners({...base,buildings:[]}),/source owners required/);
});

test('explicit null VTJ still binds the exact original BID and cannot exchange neighboring anonymous source faces',async()=>{
  const f=await fixture();try {
    const authored=path.join(f.root,'authored');await authorGroupedFacadeCharts({plan:f.planFile,cityModel:f.cityDir,baseline:f.world,out:authored});
    const profileFile=path.join(authored,'c_p00_p00/profile.json'),p=JSON.parse(fs.readFileSync(profileFile,'utf8')) as DeliveryFacadeProfile;
    const cityFile=path.join(f.cityDir,'city-model.json'),city=JSON.parse(fs.readFileSync(cityFile,'utf8'));for(const b of city.buildings)b.vtj=null;const cityBytes=Buffer.from(JSON.stringify(city));fs.writeFileSync(cityFile,cityBytes);p.source.cityJsonSha256=sha(cityBytes);
    for(const b of f.manifest.cells[0]!.buildings)(b as any).vtj=null;const manifestBytes=Buffer.from(JSON.stringify(f.manifest));fs.writeFileSync(path.join(f.world,'manifest.json'),manifestBytes);p.baselineManifestSha256=sha(manifestBytes);p.cells[0]={id:p.cells[0]!.id,baselineLevels:p.cells[0]!.baselineLevels,faces:p.cells[0]!.faces,buildings:p.cells[0]!.buildings!.map(b=>({...b,vtj:null}))};
    fs.writeFileSync(profileFile,JSON.stringify(p));const good=await applyDeliveryFacadeCharts({baseline:f.world,current:f.world,cityModel:f.cityDir,profile:profileFile,out:path.join(f.root,'null-payloads')});assert.equal(good.updates.length,1);
    const bad={...p,charts:p.charts.map(c=>c.building==='B'?{...c,building:'A'}:c)},badFile=path.join(authored,'c_p00_p00/exchanged-anonymous.json');fs.writeFileSync(badFile,JSON.stringify(bad));
    await assert.rejects(applyDeliveryFacadeCharts({baseline:f.world,current:f.world,cityModel:f.cityDir,profile:badFile,out:path.join(f.root,'wrong-null-owner')}),/declared original source building/);assert.ok(!fs.existsSync(path.join(f.root,'wrong-null-owner')));
  } finally {assert.ok(path.resolve(f.root).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(f.root,{recursive:true,force:true});}
});
test('projecting source segments share one architectural artwork frame without duplicating a central entry',async()=>{
  const f=await fixture();try{
    const plan=JSON.parse(fs.readFileSync(f.planFile,'utf8')) as GroupedFacadePlan;
    for(const [i,building]of plan.groups[0]!.buildings.entries())Object.assign(building.elevations[0]!,{renderer:'etelaesplanadi12-north',pixels:[1,1,126,126],artFrame:{id:'one-street-front',width:18,minY:0,maxY:20,startU:i*10}});
    fs.writeFileSync(f.planFile,JSON.stringify(plan));const authored=path.join(f.root,'shared-frame');await authorGroupedFacadeCharts({plan:f.planFile,cityModel:f.cityDir,baseline:f.world,out:authored});
    const dir=path.join(authored,'c_p00_p00'),svg=fs.readFileSync(path.join(dir,'facade.svg'),'utf8'),profile=JSON.parse(fs.readFileSync(path.join(dir,'profile.json'),'utf8')) as DeliveryFacadeProfile;
    assert.equal((svg.match(/data-feature="etela12-central-wood-entry"/g)??[]).length,1);
    const left=facadeChartUv([0,0,0],profile.charts[0]!,128,128),right=facadeChartUv([10,0,0],profile.charts[1]!,128,128);assert.ok(left[0]<.02&&right[0]>.5,'Different source planes must sample their distinct intervals in the shared image');
    const proof=await applyDeliveryFacadeCharts({baseline:f.world,current:f.world,cityModel:f.cityDir,profile:path.join(dir,'profile.json'),out:path.join(f.root,'shared-payloads')});assert.equal(proof.updates[0].after.visual.lod0.drawCalls,2);assert.equal(proof.updates[0].after.visual.lod2.drawCalls,2);
    plan.groups[0]!.buildings[1]!.elevations[0]!.artFrame!.startU=15;fs.writeFileSync(f.planFile,JSON.stringify(plan));await assert.rejects(authorGroupedFacadeCharts({plan:f.planFile,cityModel:f.cityDir,baseline:f.world,out:path.join(f.root,'out-of-frame')}),/exceeds its shared artwork interval/);
  }finally{assert.ok(path.resolve(f.root).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(f.root,{recursive:true,force:true});}
});
test('1024 grouped KTX2 atlas records compressed residency and full fallback memory separately and retains the GPU cap',async()=>{
  const bytes=await cell(false),image={width:1024,height:1024,data:new Uint8Array(1024*1024*4).fill(255)},encoded=await encodeKtx2(image,'facade');
  const chart:FacadeChart={id:'large',building:'A',origin:[0,0,0],uAxis:[1,0,0],vAxis:[0,1,0],bounds:[0,0,8,20],pixels:[1,1,1022,1022],planeToleranceMetres:.001};
  const faces=A.map(t=>({key:facadeTriangleKey(t),chart:'large'})),targets=await rebindDeliveryFacadeFaces(bytes,new Map(),faces,[chart]),options={expectedSha256:sha(bytes),charts:[chart],targets,externalImages:new Map(),
    atlas:{name:'large-original',image:encoded,mimeType:'image/ktx2' as const,width:1024,height:1024},maximumFallbackBytes:6*1024*1024,material:{name:'large-original',unlit:true,roughness:.95,doubleSided:true},extras:{license:'CC0-1.0'}};
  const result=await applyFacadeChartsToGlb(bytes,options);assert.equal(result.proof.textureBytesEstimate,facadeAtlasBc7Bytes(1024,1024));assert.equal(result.proof.fallbackBytes,facadeAtlasBytes(1024,1024));assert.ok(result.proof.textureBytesEstimate<3*1024*1024);
  await assert.rejects(applyFacadeChartsToGlb(bytes,{...options,maximumFallbackBytes:3*1024*1024}),/fallback memory/);
  const png=await sharp(image.data,{raw:{width:1024,height:1024,channels:4}}).png().toBuffer();
  await assert.rejects(applyFacadeChartsToGlb(bytes,{...options,atlas:{...options.atlas,image:png,mimeType:'image/png'}}),/GPU residency/);
});
