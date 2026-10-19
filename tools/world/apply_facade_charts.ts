// Chart explicitly reviewed existing source faces in a fresh independent cell
// copy. Run after ordinary facade repairs; matching distant triangles receive
// only vertex colours. This stage never regenerates ground, collision or LODs.
import assert from 'node:assert/strict';
import {cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import sharp from 'sharp';
import {validateBytes} from 'gltf-validator';
import type {CellDescriptor} from '../../packages/world-schema/src/index.ts';
import {encodeKtx2} from './lib/gltf.ts';
import {facadeAtlasBytes, facadeAtlasBc7Bytes, facadeChartSha256 as sha, facadeTriangleKey, validateFacadeChartProfile,
  type FacadeChart, type FacadePoint, type FacadeTriangle} from './lib/facade-charts.ts';
import {applyFacadeChartColorsToLod2, applyFacadeChartsToGlb, inspectFacadeChartTargets} from './lib/facade-chart-glb.ts';

const load = (file:string) => JSON.parse(readFileSync(file,'utf8'));
function child(base:string, relative:string) {
  assert.ok(relative && !path.isAbsolute(relative),'Payload paths must be relative');const result=path.resolve(base,relative),rel=path.relative(base,result);
  assert.ok(rel && rel!=='..' && !rel.startsWith('..'+path.sep) && !path.isAbsolute(rel),'Payload escapes its input directory');return result;
}
function inventory(dir:string, relative=''):Map<string,string> {
  const files=new Map<string,string>();
  for(const name of readdirSync(path.join(dir,relative))){const rel=path.join(relative,name),full=path.join(dir,rel),st=lstatSync(full);assert.ok(!st.isSymbolicLink(),'Input cell trees may not contain symlinks');
    if(st.isDirectory())for(const [p,h]of inventory(dir,rel))files.set(p,h);else {assert.ok(st.isFile());files.set(rel,sha(readFileSync(full)));}}
  return files;
}
function sourceKeys(city:any, bin:Buffer, building:string) {
  const matches=city.buildings.filter((b:any)=>b.id===building);assert.equal(matches.length,1,'Source building must be unique');
  const b=matches[0],keys=new Map<string,number>();
  for(const p of b.parts){
    const f32=(r:{offset:number;bytes:number})=>{assert.ok(r.offset>=0 && r.bytes%4===0 && r.offset+r.bytes<=bin.length);return new Float32Array(bin.buffer.slice(bin.byteOffset+r.offset,bin.byteOffset+r.offset+r.bytes));};
    const P=f32(p.positions),r=p.indices;assert.ok(r.offset>=0 && r.bytes%4===0 && r.offset+r.bytes<=bin.length);const I=new Uint32Array(bin.buffer.slice(bin.byteOffset+r.offset,bin.byteOffset+r.offset+r.bytes));
    for(let t=0;t<I.length;t+=3){const triangle=[0,1,2].map(k=>{const i=I[t+k]!*3;assert.ok(i+2<P.length);return [P[i]!,P[i+2]!,-P[i+1]!] as FacadePoint;}) as unknown as FacadeTriangle,key=facadeTriangleKey(triangle);keys.set(key,(keys.get(key)??0)+1);}
  }
  return {vtj:b.vtj??null,keys};
}

export async function applyFacadeChartBuild(args:{base:string;cityModel:string;profile:string;config:string;out:string}) {
  const base=path.resolve(args.base),out=path.resolve(args.out),cityDir=path.resolve(args.cityModel),profileFile=path.resolve(args.profile);
  assert.ok(!existsSync(out),'Output must be a new directory');assert.ok(base!==out && !out.startsWith(base+path.sep) && !base.startsWith(out+path.sep),'Input/output trees must be independent');
  const work=path.resolve('data/work'),outRel=path.relative(work,out);assert.ok(outRel && !outRel.startsWith('..') && !path.isAbsolute(outRel),'Output must be an unpublished data/work tree');
  const p:unknown=load(profileFile);validateFacadeChartProfile(p);
  const beforeInventory=inventory(base),indexBytes=readFileSync(path.join(base,'cells.json'));assert.equal(sha(indexBytes),p.baseCellsIndexSha256,'Base cell index hash changed');
  const index=JSON.parse(indexBytes.toString('utf8')) as {originId:string;cells:CellDescriptor[]},report=load(path.join(base,'report.json')),config=load(args.config);
  assert.equal(index.originId,p.source.originId);assert.equal(report.originId,p.source.originId);assert.ok(!report.facadeCharts,'This build already has authored chart integration');
  const cityBytes=readFileSync(path.join(cityDir,'city-model.json'));assert.equal(sha(cityBytes),p.source.cityJsonSha256);const city=JSON.parse(cityBytes.toString('utf8')),bin=readFileSync(child(cityDir,city.binary.file));
  assert.equal(sha(bin),p.source.cityBinSha256);assert.equal(sha(bin),city.binary.sha256);assert.equal(report.inputs.cityModelSha256,p.source.cityBinSha256);assert.equal(city.originId,p.source.originId);
  const artFile=path.resolve(path.dirname(profileFile),p.art.path),artBytes=readFileSync(artFile);assert.equal(sha(artBytes),p.art.sha256,'Authored art changed');
  const raw=await sharp(artBytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});assert.equal(raw.info.width,p.art.width);assert.equal(raw.info.height,p.art.height);
  const image={width:raw.info.width,height:raw.info.height,data:new Uint8Array(raw.data)};for(let i=3;i<image.data.length;i+=4)assert.equal(image.data[i],255,'Facade atlas must be entirely opaque');
  const encoded=await encodeKtx2(image,'facade'),encodedSha=sha(encoded),writes=new Map<string,Uint8Array>(),cells:any[]=[],changedFiles=new Set(['cells.json','report.json']);
  const source=new Map<string,ReturnType<typeof sourceKeys>>();
  for(const selected of p.cells){
    const owners=index.cells.filter(c=>c.id===selected.id);assert.equal(owners.length,1);const cell=owners[0]!;assert.ok(!cell.visual.lod1,'An existing intermediate tier requires an explicit chart mapping');assert.ok(cell.visual.lod2,'Distant tier must exist and have explicit correspondence');
    assert.equal(cell.visual.lod0.sha256,selected.lod0Sha256);assert.equal(cell.visual.lod2.sha256,selected.lod2Sha256);assert.equal(cell.visual.lod2.textureBytesEstimate,0,'Distant tier must be textureless');
    for(const b of selected.buildings){const records=cell.buildings.filter(r=>r.id===b.id);assert.equal(records.length,1,'Building must belong to the declared owner cell');assert.equal(records[0]!.vtj,b.vtj);
      const s=sourceKeys(city,bin,b.id);assert.equal(s.vtj,b.vtj);source.set(b.id,s);}
    for(const target of selected.detailed){const chart:FacadeChart=p.charts.find(c=>c.id===target.chart)!;assert.equal(source.get(chart.building)?.keys.get(target.key),1,'Detailed target is not exactly one triangle of its declared source building');}
    // A merged coarse mesh has no building ownership tags. Coplanarity alone
    // also admits overlapping foundation/ground faces. This adapter therefore
    // fails closed unless coarse selectors are exact selected source triangles.
    for(const target of selected.distant)assert.ok(selected.detailed.some(t=>t.chart===target.chart && t.key===target.key),'Distant target lacks exact selected source-triangle ownership; a separate reviewed coarse mapping is required');
    for(const target of selected.detailed)assert.equal(selected.distant.filter(t=>t.chart===target.chart && t.key===target.key).length,1,'Every detailed source triangle requires exactly one matching distant face in its chart/cell');
    const detailedBytes:Buffer=readFileSync(child(base,cell.visual.lod0.path)),distantBytes:Buffer=readFileSync(child(base,cell.visual.lod2.path));
    assert.equal(sha(detailedBytes),selected.lod0Sha256);assert.equal(sha(distantBytes),selected.lod2Sha256);
    const coverage=await inspectFacadeChartTargets(detailedBytes,{expectedSha256:selected.lod0Sha256,charts:p.charts,targets:selected.detailed});
    const detailed=await applyFacadeChartsToGlb(detailedBytes,{expectedSha256:selected.lod0Sha256,charts:p.charts,targets:selected.detailed,
      atlas:{name:p.id,image:encoded,mimeType:'image/ktx2',width:image.width,height:image.height},maximumFallbackBytes:p.maximumFallbackBytes,material:p.material,
      extras:{facadeChartProfile:p.id,profileSha256:sha(readFileSync(profileFile)),artSha256:p.art.sha256,artKind:p.art.kind,license:p.art.license,attribution:p.art.attribution,appearanceReferences:p.art.references,geometry:'Original source triangles; material coordinates only'}});
    const distant=await applyFacadeChartColorsToLod2(distantBytes,{expectedSha256:selected.lod2Sha256,charts:p.charts,targets:selected.distant,image,detailedCoverage:coverage});
    for(const payload of [detailed.bytes,distant.bytes]){const v=await validateBytes(payload,{maxIssues:100});assert.equal(v.issues.numErrors,0,`Chart GLB validator errors: ${JSON.stringify(v.issues.messages.filter(m=>m.severity===0))}`);}
    const next:CellDescriptor={...cell,buildings:cell.buildings.map(b=>selected.buildings.some(t=>t.id===b.id)?{...b,texture:'textured'}:b),visual:{
      lod0:{...cell.visual.lod0,sha256:sha(detailed.bytes),bytes:detailed.bytes.length,drawCalls:cell.visual.lod0.drawCalls+detailed.proof.addedPrimitives,atlases:cell.visual.lod0.atlases+1,textureBytesEstimate:cell.visual.lod0.textureBytesEstimate+detailed.proof.fallbackBytes},
      lod2:{...cell.visual.lod2,sha256:sha(distant.bytes),bytes:distant.bytes.length,drawCalls:cell.visual.lod2.drawCalls+distant.proof.addedPrimitives}}};
    assert.ok(next.visual.lod0.drawCalls<=config.budgets.drawCallsPerCell,'Authored facade exceeds per-cell draw cap');assert.ok(next.visual.lod2!.drawCalls<=3,'Authored distant faces exceed 3-draw cap');
    index.cells[index.cells.indexOf(cell)]=next;
    const stat=report.cells.find((s:any)=>s.cell===cell.id);assert.ok(stat);Object.assign(stat,{drawCalls:next.visual.lod0.drawCalls,glbBytes:detailed.bytes.length,ktx2Bytes:stat.ktx2Bytes+encoded.length,textureTexels:stat.textureTexels+image.width*image.height});if(Array.isArray(stat.atlases))stat.atlases.push(1);
    report.totals.drawCalls+=detailed.proof.addedPrimitives;report.totals.ktx2Bytes+=encoded.length;report.totals.textureTexels+=image.width*image.height;
    for(const [relative,payload]of [[cell.visual.lod0.path,detailed.bytes],[cell.visual.lod2.path,distant.bytes]] as const){assert.ok(!writes.has(relative),'Two profiles alias an output payload');writes.set(relative,payload);changedFiles.add(path.normalize(relative));}
    assert.equal(sha(readFileSync(child(base,cell.collision.path))),cell.collision.sha256);
    cells.push({cell:cell.id,buildings:selected.buildings,before:cell,after:next,detailed:detailed.proof,distant:distant.proof,collisionSha256:cell.collision.sha256});
  }
  report.totals.uniqueTextures+=1;report.totals.residentTextureMiBEstimate+=facadeAtlasBc7Bytes(image.width,image.height)/(1024*1024);
  report.budgets.drawCallsPerCellMax=Math.max(...index.cells.map(c=>c.visual.lod0.drawCalls));report.budgets.pass=report.budgets.pass && report.budgets.drawCallsPerCellMax<=config.budgets.drawCallsPerCell;
  assert.ok(report.budgets.pass,'Cell budgets failed');
  const sourceFiles=['apply_facade_charts.ts','lib/facade-charts.ts','lib/facade-chart-glb.ts','lib/gltf.ts','lib/facade-glb.ts'];
  const proof={schemaVersion:1,status:'PASS',runtimeVisualAndMemoryAcceptance:'REQUIRED_ON_NEW_CANDIDATE',profile:{path:args.profile,sha256:sha(readFileSync(profileFile)),id:p.id},source:p.source,baseCellsIndexSha256:p.baseCellsIndexSha256,
    art:{...p.art,encodedKtx2Sha256:encodedSha,encodedBytes:encoded.length,perOwnerRgbaMipBytes:facadeAtlasBytes(image.width,image.height),aggregateFallbackBytes:facadeAtlasBytes(image.width,image.height)*p.cells.length},
    toolSources:Object.fromEntries(sourceFiles.map(f=>[f,sha(readFileSync(new URL(f,import.meta.url)))])),configSha256:sha(readFileSync(args.config)),cells,
    preserved:{allHcolTerrainSceneryAndUnselectedFilesByteExact:true,originalAtlasesAndUntargetedUvsExact:true,worldGeometryAndWindingMultisetExact:true,groundWaterAndClosureGeometryExact:true},
    limitation:'Detailed authored artwork on reviewed original wall faces; distant vertex colours are an approximation on the unchanged coarse triangles.'};
  report.facadeCharts={profile:proof.profile,source:p.source,art:proof.art,toolSources:proof.toolSources,cells:cells.map(c=>({cell:c.cell,buildings:c.buildings,detailedTriangles:c.detailed.targetTriangles,distantTriangles:c.distant.targetTriangles})),runtimeAcceptance:proof.runtimeVisualAndMemoryAcceptance};
  writes.set('cells.json',Buffer.from(JSON.stringify(index,null,1)+'\n'));writes.set('report.json',Buffer.from(JSON.stringify(report,null,1)+'\n'));
  // Copy, never hardlink: the input remains a usable immutable rollback artifact.
  mkdirSync(path.dirname(out),{recursive:true});cpSync(base,out,{recursive:true,force:false,errorOnExist:true});
  for(const [relative,payload]of writes)writeFileSync(child(out,relative),payload);
  const afterInventory=inventory(out);assert.deepEqual([...afterInventory.keys()].sort(),[...beforeInventory.keys()].sort());
  for(const [relative,h]of beforeInventory)if(!changedFiles.has(relative))assert.equal(afterInventory.get(relative),h,`Unselected file changed: ${relative}`);
  for(const [relative,h]of beforeInventory)assert.equal(sha(readFileSync(child(base,relative))),h,'Input artifact changed during integration');
  const result={...proof,outputCellsIndexSha256:sha(readFileSync(path.join(out,'cells.json'))),unchangedFileCount:beforeInventory.size-changedFiles.size};
  writeFileSync(path.join(out,'facade-chart-proof.json'),JSON.stringify(result,null,2)+'\n');return result;
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const {values}=parseArgs({options:{base:{type:'string'},'city-model':{type:'string'},profile:{type:'string'},config:{type:'string'},out:{type:'string'}}});
  assert.ok(values.base && values['city-model'] && values.profile && values.config && values.out,'--base --city-model --profile --config --out required');
  const result=await applyFacadeChartBuild({base:values.base,cityModel:values['city-model'],profile:values.profile,config:values.config,out:values.out});
  console.log(JSON.stringify({status:result.status,cells:result.cells.length,outputCellsIndexSha256:result.outputCellsIndexSha256,acceptance:result.runtimeVisualAndMemoryAcceptance}));
}
