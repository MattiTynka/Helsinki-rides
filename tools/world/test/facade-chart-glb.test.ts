import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync} from 'node:fs';
import path from 'node:path';
import {NodeIO, type Document} from '@gltf-transform/core';
import {ALL_EXTENSIONS} from '@gltf-transform/extensions';
import {MeshoptDecoder} from 'meshoptimizer';
import {validateBytes} from 'gltf-validator';
import sharp from 'sharp';
import {GlbBuilder,flatNormals} from '../lib/gltf.ts';
import {readFacadeGlb} from '../lib/facade-glb.ts';
import {applyFacadeChartsToGlb,applyFacadeChartColorsToLod2,inspectFacadeChartTargets} from '../lib/facade-chart-glb.ts';
import {facadeChartSha256 as sha,facadeTriangleKey,type FacadeChart,type FacadeTriangle,type FacadeChartTarget,type FacadeChartProfile} from '../lib/facade-charts.ts';
import {applyFacadeChartBuild} from '../apply_facade_charts.ts';

const chart:FacadeChart={id:'east',building:'building',origin:[0,0,0],uAxis:[1,0,0],vAxis:[0,1,0],bounds:[0,0,2,2],pixels:[2,2,12,12],planeToleranceMetres:.001};
const a:FacadeTriangle=[[0,0,0],[2,0,0],[2,2,0]],b:FacadeTriangle=[[0,0,0],[2,2,0],[0,2,0]],other:FacadeTriangle=[[4,0,0],[5,0,0],[5,1,0]];
const coplanarNonSource:FacadeTriangle=[[0,0,0],[1,0,0],[1,1,0]];
const originalImage={width:8,height:8,data:new Uint8Array(8*8*4).fill(255)},art={width:16,height:16,data:new Uint8Array(16*16*4)};
for(let i=0;i<art.data.length;i+=4)art.data.set([160,190,220,255],i);
await MeshoptDecoder.ready;
const io=new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.decoder':MeshoptDecoder});
async function makeFixture(distant=false) {
  const builder=new GlbBuilder('fixture'),P=Float32Array.from([...a.flat(),...b.flat(),...(distant?coplanarNonSource:other).flat()]),I=Uint32Array.from({length:9},(_,i)=>i),uv=new Float32Array(18).fill(.5);
  await builder.addMesh({name:distant?'distant':'facades',positions:P,indices:I,normals:flatNormals(P,I),uvs:uv,materialName:'old-wall'},
    {name:'old-wall',unlit:distant,...(!distant?{texture:originalImage,textureKind:'facade' as const}:{})});
  const G=Float32Array.from([0,-1,0,2,-1,0,0,-1,2]),GI=Uint32Array.from([0,1,2]);
  await builder.addMesh({name:'cell_ground_stone',positions:G,indices:GI,materialName:'ground'},{name:'ground',unlit:false});
  if(distant){const p=builder.doc.getRoot().listMeshes()[0]!.listPrimitives()[0]!;p.setAttribute('COLOR_0',builder.doc.createAccessor().setType('VEC3').setBuffer(builder.doc.getRoot().listBuffers()[0]!).setArray(new Float32Array(P.length).fill(.4)));}
  return builder.toGlb('original fixture',{},'exact');
}
let detailPromise:Promise<Uint8Array>|undefined,coarsePromise:Promise<Uint8Array>|undefined;
const fixture=(distant=false)=>distant?(coarsePromise??=makeFixture(true)):(detailPromise??=makeFixture());
async function targets(bytes:Uint8Array,nodeName:string):Promise<FacadeChartTarget[]> {
  const doc=await io.readBinary(bytes),p=doc.getRoot().listNodes().find(n=>n.getName()===nodeName)!.getMesh()!.listPrimitives()[0]!,I=p.getIndices()!,P=p.getAttribute('POSITION')!,result:FacadeChartTarget[]=[];
  for(let t=0;t<I.getCount()/3;t++){const tri=[0,1,2].map(k=>P.getElement(I.getScalar(t*3+k),[]) as unknown as [number,number,number]) as unknown as FacadeTriangle,key=facadeTriangleKey(tri);
    if([facadeTriangleKey(a),facadeTriangleKey(b)].includes(key))result.push({node:nodeName,primitive:0,triangle:t,key,chart:'east'});}
  assert.equal(result.length,2);return result;
}
async function png(){return sharp(art.data,{raw:{width:art.width,height:art.height,channels:4}}).png().toBuffer();}
async function options(bytes:Uint8Array){return {expectedSha256:sha(bytes),charts:[chart],targets:await targets(bytes,'facades'),atlas:{name:'isolated',image:await png(),mimeType:'image/png' as const,width:16,height:16},maximumFallbackBytes:3*1024*1024,
  material:{name:'authored',unlit:false,roughness:.9,doubleSided:false},extras:{license:'CC0-1.0',attribution:'Original test art'}};}
function primitive(doc:Document,name:string,index=0){return doc.getRoot().listNodes().find(n=>n.getName()===name)!.getMesh()!.listPrimitives()[index]!;}

test('actual compressed chart partition preserves old encoded atlases/UVs, ground and winding while drawing target faces once',async()=>{
  const before=await fixture(),result=await applyFacadeChartsToGlb(before,await options(before)),old=readFacadeGlb(before),next=readFacadeGlb(result.bytes);
  assert.deepEqual(next.bin.subarray(0,old.bin.length),old.bin);assert.deepEqual(next.json.images!.slice(0,old.json.images!.length),old.json.images);
  const source=await io.readBinary(before),decoded=await io.readBinary(result.bytes),p=primitive(source,'facades'),q=primitive(decoded,'facades'),added=primitive(decoded,'facades',1);
  for(const s of p.listSemantics())assert.deepEqual(q.getAttribute(s)!.getArray(),p.getAttribute(s)!.getArray(),`Original ${s} changed`);
  assert.equal(q.getIndices()!.getCount(),3);assert.equal(added.getIndices()!.getCount(),6);assert.notDeepEqual(added.getAttribute('TEXCOORD_0')!.getArray(),p.getAttribute('TEXCOORD_0')!.getArray());
  const G=primitive(source,'cell_ground_stone'),H=primitive(decoded,'cell_ground_stone');for(const s of G.listSemantics())assert.deepEqual(G.getAttribute(s)!.getArray(),H.getAttribute(s)!.getArray());assert.deepEqual(G.getIndices()!.getArray(),H.getIndices()!.getArray());
  assert.equal(decoded.getRoot().listTextures().length,source.getRoot().listTextures().length+1);assert.deepEqual(decoded.getRoot().listTextures()[0]!.getImage(),source.getRoot().listTextures()[0]!.getImage());
  assert.equal(result.proof.targetTriangles,2);assert.equal(result.proof.addedPrimitives,1);assert.equal((await validateBytes(result.bytes,{maxIssues:50})).issues.numErrors,0);
});
test('wrong hashes, missing/reversed selectors, duplicated targets and ground selections fail closed',async()=>{
  const bytes=await fixture(),o=await options(bytes);
  await assert.rejects(applyFacadeChartsToGlb(bytes,{...o,expectedSha256:'a'.repeat(64)}),/hash changed/);
  await assert.rejects(applyFacadeChartsToGlb(bytes,{...o,targets:[...o.targets,...o.targets]}),/Duplicate/);
  await assert.rejects(applyFacadeChartsToGlb(bytes,{...o,targets:[{...o.targets[0]!,key:facadeTriangleKey([a[0],a[2],a[1]])}]}),/coordinates or winding/);
  await assert.rejects(applyFacadeChartsToGlb(bytes,{...o,targets:[{...o.targets[0]!,node:'cell_ground_stone'}]}),/Ground primitives/);
});
test('textureless distant patch proves selected detailed coverage and preserves ground and non-target colours through decode',async()=>{
  const detail=await fixture(),coarse=await fixture(true),coverage=await inspectFacadeChartTargets(detail,{expectedSha256:sha(detail),charts:[chart],targets:await targets(detail,'facades')}),o={expectedSha256:sha(coarse),charts:[chart],targets:await targets(coarse,'distant'),image:art,detailedCoverage:coverage};
  const result=await applyFacadeChartColorsToLod2(coarse,o),old=await io.readBinary(coarse),next=await io.readBinary(result.bytes),p=primitive(old,'distant'),q=primitive(next,'distant');
  assert.deepEqual(q.getAttribute('COLOR_0')!.getArray(),p.getAttribute('COLOR_0')!.getArray());assert.equal(next.getRoot().listTextures().length,0);assert.equal(result.proof.textureBytesEstimate,0);
  const G=primitive(old,'cell_ground_stone'),H=primitive(next,'cell_ground_stone');assert.deepEqual(G.getAttribute('POSITION')!.getArray(),H.getAttribute('POSITION')!.getArray());assert.deepEqual(G.getIndices()!.getArray(),H.getIndices()!.getArray());
  assert.notDeepEqual(primitive(next,'distant',1).getAttribute('COLOR_0')!.getArray(),p.getAttribute('COLOR_0')!.getArray());assert.equal((await validateBytes(result.bytes,{maxIssues:50})).issues.numErrors,0);
  await assert.rejects(applyFacadeChartColorsToLod2(coarse,{...o,detailedCoverage:new Map([['east',[a]]])}),/outside selected/);
});

test('fresh-copy build binds source building/art, updates actual metadata and leaves HCOL/terrain/scenery/input bytes exact',async()=>{
  const work=path.resolve('data/work');mkdirSync(work,{recursive:true});const root=mkdtempSync(path.join(work,'test-facade-charts-'));
  try{
    const base=path.join(root,'base'),cityDir=path.join(root,'city'),out=path.join(root,'output');mkdirSync(path.join(base,'visual'),{recursive:true});mkdirSync(path.join(base,'collision'));mkdirSync(cityDir);
    const detail=await fixture(),coarse=await fixture(true),detailTargets=await targets(detail,'facades'),distantTargets=await targets(coarse,'distant');
    writeFileSync(path.join(base,'visual/detail.glb'),detail);writeFileSync(path.join(base,'visual/distant.glb'),coarse);
    const col=Buffer.from('immutable-source-shell'),terrain=Buffer.from('immutable-terrain'),scenery=Buffer.from('immutable-scenery');writeFileSync(path.join(base,'collision/cell.bin'),col);writeFileSync(path.join(base,'runtime-terrain.bin'),terrain);writeFileSync(path.join(base,'scenery.json'),scenery);
    const P=Float32Array.from([...a.flatMap(v=>[v[0],-v[2],v[1]]),...b.flatMap(v=>[v[0],-v[2],v[1]]),...other.flatMap(v=>[v[0],-v[2],v[1]])]),I=Uint32Array.from({length:9},(_,i)=>i),sourceBin=Buffer.concat([Buffer.from(P.buffer),Buffer.from(I.buffer)]);
    const city={originId:'origin',binary:{file:'city-model.bin',sha256:sha(sourceBin)},buildings:[{id:'building',vtj:'vtj',parts:[{positions:{offset:0,bytes:P.byteLength},indices:{offset:P.byteLength,bytes:I.byteLength}}]}]};
    writeFileSync(path.join(cityDir,'city-model.bin'),sourceBin);const cityBytes=Buffer.from(JSON.stringify(city));writeFileSync(path.join(cityDir,'city-model.json'),cityBytes);
    const file=(p:string,bytes:Uint8Array)=>({path:p,bytes:bytes.length,sha256:sha(bytes)}),visual=(p:string,bytes:Uint8Array,atlases:number)=>({...file(p,bytes),triangles:4,drawCalls:2,atlases,textureBytesEstimate:atlases*100});
    const cell={id:'cell',cx:0,cz:0,boundsXZ:[0,0,128,128],visual:{lod0:visual('visual/detail.glb',detail,1),lod2:visual('visual/distant.glb',coarse,0)},collision:{...file('collision/cell.bin',col),triangles:3},buildingIds:['building'],buildings:[{id:'building',vtj:'vtj',texture:'flat-colour'}],sourceTiles:[]};
    const indexBytes=Buffer.from(JSON.stringify({originId:'origin',cells:[cell]}));writeFileSync(path.join(base,'cells.json'),indexBytes);
    writeFileSync(path.join(base,'report.json'),JSON.stringify({originId:'origin',inputs:{cityModelSha256:sha(sourceBin)},cells:[{cell:'cell',drawCalls:2,glbBytes:detail.length,ktx2Bytes:100,textureTexels:64,atlases:[1]}],totals:{drawCalls:2,ktx2Bytes:100,textureTexels:64,uniqueTextures:1,residentTextureMiBEstimate:1},budgets:{pass:true}}));
    const artBytes=await png();writeFileSync(path.join(root,'art.png'),artBytes);
    const profile:FacadeChartProfile={schemaVersion:1,id:'original-test',baseCellsIndexSha256:sha(indexBytes),source:{cityJsonSha256:sha(cityBytes),cityBinSha256:sha(sourceBin),originId:'origin'},art:{path:'art.png',sha256:sha(artBytes),width:16,height:16,kind:'original-procedural',license:'CC0-1.0',attribution:'Test original procedural art',references:[]},maximumFallbackBytes:3*1024*1024,material:{name:'original-atlas',unlit:false,roughness:.9,doubleSided:false},charts:[chart],cells:[{id:'cell',lod0Sha256:sha(detail),lod2Sha256:sha(coarse),buildings:[{id:'building',vtj:'vtj'}],detailed:detailTargets,distant:distantTargets}]};
    const profileFile=path.join(root,'profile.json'),config=path.join(root,'config.json');writeFileSync(profileFile,JSON.stringify(profile));writeFileSync(config,JSON.stringify({budgets:{drawCallsPerCell:6}}));
    const proof=await applyFacadeChartBuild({base,cityModel:cityDir,profile:profileFile,config,out});assert.equal(proof.status,'PASS');assert.equal(readFileSync(path.join(base,'cells.json')).toString(),indexBytes.toString());
    for(const f of ['collision/cell.bin','runtime-terrain.bin','scenery.json'])assert.deepEqual(readFileSync(path.join(out,f)),readFileSync(path.join(base,f)));
    const result=JSON.parse(readFileSync(path.join(out,'cells.json'),'utf8')).cells[0];assert.equal(result.buildings[0].texture,'textured');assert.equal(result.visual.lod0.triangles,4);assert.equal(result.visual.lod0.atlases,2);assert.equal(result.visual.lod0.drawCalls,3);assert.equal(result.visual.lod2.drawCalls,3);assert.equal(result.visual.lod2.textureBytesEstimate,0);assert.ok(existsSync(path.join(out,'facade-chart-proof.json')));
    await assert.rejects(applyFacadeChartBuild({base,cityModel:cityDir,profile:profileFile,config,out}),/new directory/);
    const coarseDoc=await io.readBinary(coarse),cp=primitive(coarseDoc,'distant'),ci=cp.getIndices()!,ca=cp.getAttribute('POSITION')!;
    let overlapIndex=-1;for(let t=0;t<ci.getCount()/3;t++){const tri=[0,1,2].map(k=>ca.getElement(ci.getScalar(t*3+k),[]) as unknown as [number,number,number]) as unknown as FacadeTriangle;if(facadeTriangleKey(tri)===facadeTriangleKey(coplanarNonSource))overlapIndex=t;}
    assert.ok(overlapIndex>=0);
    const badProfile={...profile,cells:[{...profile.cells[0]!,distant:[...distantTargets,{node:'distant',primitive:0,triangle:overlapIndex,key:facadeTriangleKey(coplanarNonSource),chart:'east'}]}]};
    writeFileSync(profileFile,JSON.stringify(badProfile));const badOut=path.join(root,'rejected');
    await assert.rejects(applyFacadeChartBuild({base,cityModel:cityDir,profile:profileFile,config,out:badOut}),/exact selected source-triangle ownership/);assert.equal(existsSync(badOut),false,'A coplanar non-source face must fail before output creation');
    writeFileSync(profileFile,JSON.stringify({...profile,cells:[{...profile.cells[0]!,distant:[distantTargets[0]!]}]}));
    await assert.rejects(applyFacadeChartBuild({base,cityModel:cityDir,profile:profileFile,config,out:badOut}),/exactly one matching distant face/);assert.equal(existsSync(badOut),false,'Incomplete distant correspondence must fail before output creation');
  }finally{assert.ok(root.startsWith(work+path.sep));rmSync(root,{recursive:true,force:true});}
});
