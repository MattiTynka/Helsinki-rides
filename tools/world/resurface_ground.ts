// node tools/world/resurface_ground.ts --base CELLS --street-parts GEOJSON
// --origin ORIGIN --plan SOURCE_PLAN --config CONFIG --out-plan FRESH_AUTHORITY
// Application additionally requires --authority REVIEWED_AUTHORITY --out FRESH_WORK_DIR.
import assert from 'node:assert/strict';
import {cpSync,existsSync,lstatSync,mkdirSync,readdirSync,readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import sharp from 'sharp';
import {validateBytes} from 'gltf-validator';
import {loadGeoJsonPolygons} from './lib/geometry.ts';
import {encodeKtx2} from './lib/gltf.ts';
import {createResurfacingSelector,createPavingCoverageAudit,pavingSha,validateResurfacingPlan,type ResurfacingPlan,type SurfaceTarget,type PavingPattern} from './lib/ground-resurfacing.ts';
import {inspectGroundSurfaces,matchResurfacingTier,resurfaceGroundGlb} from './lib/ground-resurfacing-glb.ts';
import {originalPavingTexture,pavingRgbaMipBytes,pavingBc7MipBytes} from './lib/paving-textures.ts';
import {readFacadeGlb} from './lib/facade-glb.ts';

export interface ResurfaceArguments {base:string;streetParts:string;origin:string;plan:string;config:string}
const read=(file:string)=>readFileSync(file),json=(file:string)=>JSON.parse(readFileSync(file,'utf8'));
const sources=['resurface_ground.ts','lib/ground-resurfacing.ts','lib/ground-resurfacing-glb.ts','lib/paving-textures.ts','lib/facade-charts.ts','lib/facade-glb.ts','lib/geometry.ts','lib/gltf.ts','rebuild_ground.ts','build_cells.ts'];
const variant=(pattern:PavingPattern):'setts'|'fan-cobble'=>pattern==='fan-cobble'?'fan-cobble':'setts';
/** Certificates are JSON, which serializes numeric -0 as 0. Compare that
 * representation only; binary triangle keys remain exact hex strings. */
export function assertJsonCertificateEqual(actual:unknown,expected:unknown,message:string){
  const canonical=(value:unknown)=>JSON.parse(JSON.stringify(value,(_key,v:unknown)=>{
    if(typeof v==='number')assert.ok(Number.isFinite(v),'Nonfinite JSON certificate number');return v;
  }));
  assert.deepEqual(canonical(actual),canonical(expected),message);
}
function child(base:string,relative:string){assert.ok(relative&&!path.isAbsolute(relative));const file=path.resolve(base,relative),rel=path.relative(base,file);assert.ok(rel&&rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel),'Payload escapes base');assert.ok(!lstatSync(file).isSymbolicLink(),'No symlink payloads');return file;}
function inputs(args:ResurfaceArguments){
  const base=path.resolve(args.base),planFile=path.resolve(args.plan),plan:unknown=json(planFile);validateResurfacingPlan(plan);
  const pins=[path.join(base,'cells.json'),path.join(base,'report.json'),path.resolve(args.streetParts),path.resolve(args.origin),planFile,path.resolve(args.config),...sources.map(f=>fileURLToPath(new URL(f,import.meta.url)))].map(file=>({file,sha256:pavingSha(read(file))}));
  assert.equal(pins[0]!.sha256,plan.baseCellsIndexSha256,'Source cell index mismatch');assert.equal(pins[2]!.sha256,plan.streetPartsSha256,'Street-part source mismatch');assert.equal(pins[3]!.sha256,plan.originSha256,'Origin mismatch');
  return {base,plan,pins,index:json(path.join(base,'cells.json'))};
}
function sourceParts(args:ResurfaceArguments,plan:ResurfacingPlan){
  const raw=json(args.streetParts);for(const id of new Set(plan.regions.flatMap(r=>r.partIds)))assert.equal(raw.features.filter((f:any)=>String(f.properties.osan_id)===id).length,1,`Missing/duplicate source feature ${id}`);
  const origin=json(args.origin);return loadGeoJsonPolygons(args.streetParts,origin.originProjected[0],origin.originProjected[1],p=>String(p.osan_id));
}
function plannedTierCost(bytes:Uint8Array,targets:SurfaceTarget[],plan:ResurfacingPlan,distant:boolean){
  const kinds=[...new Set(targets.map(t=>variant(plan.regions.find(r=>r.id===t.region)!.pattern)))];if(distant)return {addedDrawCalls:0,textureVariants:[],addedBc7Bytes:0,addedRgbaMipBytes:0};
  const j=readFacadeGlb(bytes).json as any,remaining=new Map<string,number>();for(const t of targets){const key=`${t.node}:${t.primitive}`;if(remaining.has(key))continue;const n=j.nodes.find((n:any)=>n.name===t.node),p=j.meshes[n.mesh].primitives[t.primitive];remaining.set(key,j.accessors[p.indices].count/3);}
  let addedDrawCalls=0;for(const kind of kinds){let partial=false;const groups=new Map<string,number>();for(const t of targets)if(variant(plan.regions.find(r=>r.id===t.region)!.pattern)===kind){const key=`${t.node}:${t.primitive}`;groups.set(key,(groups.get(key)??0)+1);}for(const [key,n]of groups){assert.ok(n<=remaining.get(key)!);if(n<remaining.get(key)!)partial=true;remaining.set(key,remaining.get(key)!-n);}if(partial)addedDrawCalls++;}
  return {addedDrawCalls,textureVariants:kinds,addedBc7Bytes:kinds.length*pavingBc7MipBytes(256),addedRgbaMipBytes:kinds.length*pavingRgbaMipBytes(256)};
}
export async function planGroundResurfacing(args:ResurfaceArguments&{outPlan:string;preview?:string}){
  const {base,plan,pins,index}=inputs(args),out=path.resolve(args.outPlan),dir=out+'.cells';assert.ok(!existsSync(out)&&!existsSync(dir),'Fresh authority/receipt paths required');
  const origin=json(args.origin);assert.equal(index.originId,origin.id);const parts=sourceParts(args,plan);
  const sourceReport=json(path.join(base,'report.json')),writer=fileURLToPath(new URL('rebuild_ground.ts',import.meta.url)),writerHash=pavingSha(read(writer)),declaredWriterHash=sourceReport.repair?.sourceHashes?.['tools/world/rebuild_ground.ts'];
  if(declaredWriterHash)assert.equal(writerHash,declaredWriterHash,'Ground export writer differs from original repair source');
  const select=createResurfacingSelector(plan,parts),coverage=createPavingCoverageAudit(plan,parts),rows:any[]=[],counts={targets:0,rejections:0,cells:0,nativeRoundedTargets:0,maximumNativeDistanceMetres:0};mkdirSync(dir,{recursive:true});
  for(const cell of index.cells){
    const desc=cell.visual.lod0,bytes=read(child(base,desc.path));assert.equal(pavingSha(bytes),desc.sha256);const triangles=await inspectGroundSurfaces(bytes),targets:SurfaceTarget[]=[],rejections:any[]=[];
    for(const t of triangles){const q=select(t);coverage.observe(t,q);if(q.target){targets.push(q.target);if(q.target.nativeCoverage){counts.nativeRoundedTargets++;counts.maximumNativeDistanceMetres=Math.max(counts.maximumNativeDistanceMetres,q.target.nativeCoverage.maximumOutsideDistanceMetres);}}if(q.rejection)rejections.push({node:t.node,primitive:t.primitive,triangle:t.triangle,points:t.points,...q.rejection});}
    if(!targets.length&&!rejections.length){(globalThis as any).gc?.();continue;}
    const tiers:Record<string,any>= {lod0:{sha256:desc.sha256,targets,cost:plannedTierCost(bytes,targets,plan,false)}};
    if(targets.length)for(const lod of ['lod1','lod2'])if(cell.visual[lod]){const d=cell.visual[lod],b=read(child(base,d.path));assert.equal(pavingSha(b),d.sha256);const matching=await matchResurfacingTier(b,targets,lod==='lod2');tiers[lod]={sha256:d.sha256,targets:matching,cost:plannedTierCost(b,matching,plan,lod==='lod2')};}
    if(targets.length)assert.ok(tiers.lod2,'Selected cell needs an explicit distant mapping');
    const receipt=path.join(dir,cell.id+'.json'),data=Buffer.from(JSON.stringify({cell:cell.id,tiers,rejections},null,2)+'\n');writeFileSync(receipt,data,{flag:'wx'});
    rows.push({cell:cell.id,receipt,sha256:pavingSha(data),targets:targets.length,rejections:rejections.length,costs:Object.fromEntries(Object.entries(tiers).map(([k,v])=>[k,{...v.cost,drawCallsAfter:cell.visual[k].drawCalls+v.cost.addedDrawCalls}]))});counts.targets+=targets.length;counts.rejections+=rejections.length;if(targets.length)counts.cells++;
    (globalThis as any).gc?.();
  }
  assert.ok(counts.targets>0,'No source-qualified resurfacing targets');
  if(counts.nativeRoundedTargets)assert.equal(declaredWriterHash,writerHash,'Native recovery requires the original source-bound Float32 export writer');
  const previews:{variant:string;file:string;sha256:string}[]=[];
  if(args.preview)for(const kind of new Set(plan.regions.map(r=>variant(r.pattern)))){
    const image=originalPavingTexture(plan.texture,kind),ext=path.extname(args.preview),preview=path.resolve(args.preview.slice(0,args.preview.length-ext.length)+'-'+kind+'.png');
    assert.ok(!existsSync(preview),'Fresh preview required');mkdirSync(path.dirname(preview),{recursive:true});writeFileSync(preview,await sharp(image.data,{raw:{width:image.width,height:image.height,channels:4}}).png().toBuffer(),{flag:'wx'});previews.push({variant:kind,file:preview,sha256:pavingSha(read(preview))});
  }
  const result={schemaVersion:1,kind:'source-bound-ground-resurfacing',status:'PLAN_ONLY_REVIEW_REQUIRED',base,inputs:pins,planSha256:pavingSha(read(args.plan)),rows,counts,sourcePartCoverage:coverage.report(),
    texture:{...plan.texture,previews,rgbaMipBytesPerTileOwner:pavingRgbaMipBytes(256),bc7MipBytesPerTileOwner:pavingBc7MipBytes(256),maximumLowResidentAndIncomingBc7Bytes:18*pavingBc7MipBytes(256)*new Set(plan.regions.map(r=>variant(r.pattern))).size},
    nativeCoveragePolicy:'Only Float32 identity-transform ground is eligible. An outside polygon or each diagnostic subtriangle must lie in one SAME actual source-boundary segment capsule, radius hypot(max half-ULP X,max half-ULP Z)+1e-8m clipping allowance. Capsule convexity proves its full edges/interior. Diagnostic decomposition requires exact empty original-domain difference; recursion max12 levels/256 calls per face. Literal ROI bounds stay strict. Exactly one fully proven region required.',
    nativeExportDomain:{writer,sha256:writerHash,declaredWriterHash:declaredWriterHash??null,firstRounding:'rebuild_ground.ts: Float32Array.from(m.positions) after source clipping in runtime world metres, before GlbBuilder exact encoding; no cell-local translation. Every eligible node world matrix is asserted identity and every decoded POSITION accessor is native Float32.',originId:index.originId},
    contract:'Existing upward ground triangles only; full source-polygon coverage or explicit bounded native-rounding proof. Real partial/ambiguous faces remain unchanged and recorded. No geometry/collision/closure edits. Exact detailed/LOD1/distant ownership. Distant stays textureless with no extra draws.'};
  writeFileSync(out,JSON.stringify(result,null,2)+'\n',{flag:'wx'});return {out,sha256:pavingSha(read(out)),counts,previews};
}
function inventory(base:string,relative=''):Map<string,string>{const result=new Map<string,string>();for(const name of readdirSync(path.join(base,relative))){const rel=path.join(relative,name),full=path.join(base,rel),stat=lstatSync(full);assert.ok(!stat.isSymbolicLink());if(stat.isDirectory())for(const [f,h]of inventory(base,rel))result.set(f,h);else{assert.ok(stat.isFile());result.set(rel,pavingSha(read(full)));}}return result;}
export async function applyGroundResurfacing(args:ResurfaceArguments&{authority:string;out:string}){
  const {base,plan,pins,index}=inputs(args),authority=json(args.authority),out=path.resolve(args.out),work=path.resolve('data/work'),rel=path.relative(work,out);
  assert.ok(rel&&!path.isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+path.sep),'Output must be under unpublished data/work');assert.ok(!existsSync(out)&&out!==base&&!out.startsWith(base+path.sep)&&!base.startsWith(out+path.sep),'Fresh independent output required');
  assert.equal(authority.kind,'source-bound-ground-resurfacing');assert.equal(authority.base,base);assert.equal(authority.planSha256,pavingSha(read(args.plan)));
  assert.deepEqual(authority.inputs,pins,'Authority source/config/tool bindings changed');for(const p of authority.inputs)assert.equal(pavingSha(read(p.file)),p.sha256);
  const origin=json(args.origin);assert.equal(index.originId,origin.id);
  const select=createResurfacingSelector(plan,sourceParts(args,plan));
  const images=new Map([...new Set(plan.regions.map(r=>variant(r.pattern)))].map(kind=>[kind,originalPavingTexture(plan.texture,kind)])),encoded=new Map<string,Uint8Array>();
  for(const [kind,image]of images)encoded.set(kind,await encodeKtx2(image,'facade'));
  const config=json(args.config),writes=new Map<string,Uint8Array>(),results:any[]=[];
  const before=inventory(base),report=json(path.join(base,'report.json'));assert.ok(!report.groundResurfacing,'Ground has already been resurfaced');
  const seenCells=new Set<string>();
  for(const row of authority.rows){assert.ok(!seenCells.has(row.cell),'Duplicate authority cell');seenCells.add(row.cell);const receiptBytes=read(row.receipt);assert.equal(pavingSha(receiptBytes),row.sha256);const receipt=JSON.parse(receiptBytes.toString()),cell=index.cells.find((c:any)=>c.id===row.cell);assert.ok(cell);assert.equal(receipt.cell,cell.id);
    const qualified=(await inspectGroundSurfaces(read(child(base,cell.visual.lod0.path)))).flatMap(t=>{const q=select(t);return q.target?[q.target]:[];});
    assertJsonCertificateEqual(receipt.tiers.lod0.targets,qualified,'Authority targets differ from actual source qualification');assert.equal(row.targets,qualified.length);
    for(const [lod,tier]of Object.entries(receipt.tiers) as [string,{sha256:string;targets:SurfaceTarget[]}][]){if(!tier.targets.length)continue;const desc=cell.visual[lod];assert.ok(desc);assert.equal(desc.sha256,tier.sha256);const source=read(child(base,desc.path));assert.equal(pavingSha(source),desc.sha256);
      if(lod!=='lod0')assertJsonCertificateEqual(tier.targets,await matchResurfacingTier(source,qualified,lod==='lod2'),'Authority tier mapping changed');
      const predicted=plannedTierCost(source,tier.targets,plan,lod==='lod2');assertJsonCertificateEqual(receipt.tiers[lod].cost,predicted,'Authority cost changed');
      let current:Uint8Array=source;const patches:any[]=[];
      for(const kind of new Set(tier.targets.map(t=>variant(plan.regions.find(r=>r.id===t.region)!.pattern)))){
        const originalTargets=tier.targets.filter(t=>variant(plan.regions.find(r=>r.id===t.region)!.pattern)===kind),targets=patches.length?await matchResurfacingTier(current,originalTargets,lod==='lod2'):originalTargets;
        const changed=await resurfaceGroundGlb(current,{expectedSha256:pavingSha(current),targets,regions:plan.regions,image:images.get(kind)!,encodedTexture:lod==='lod2'?undefined:encoded.get(kind)!,distant:lod==='lod2',extras:{plan:plan.id,pattern:kind,sourcePlanSha256:pavingSha(read(args.plan)),referenceIds:plan.regions.flatMap(r=>r.referenceIds)}});current=changed.bytes;patches.push({variant:kind,...changed.proof});
      }
      const validation=await validateBytes(current,{maxIssues:100});assert.equal(validation.issues.numErrors,0,'Resurfaced GLB is invalid');assert.ok(!writes.has(desc.path),'Aliased target payload');writes.set(desc.path,current);
      const proof={sourceSha256:desc.sha256,outputSha256:pavingSha(current),targetTriangles:tier.targets.length,addedPrimitives:patches.reduce((n,p)=>n+p.addedPrimitives,0),textureCount:lod==='lod2'?0:patches.length,encodedBytes:lod==='lod2'?0:patches.reduce((n,p)=>n+encoded.get(p.variant)!.length,0),patches};
      assert.equal(proof.addedPrimitives,predicted.addedDrawCalls,'Actual draw partition differs from reviewed cost');
      desc.sha256=pavingSha(current);desc.bytes=current.length;desc.drawCalls+=proof.addedPrimitives;if(lod!=='lod2'){desc.atlases+=patches.length;desc.textureBytesEstimate+=patches.length*pavingRgbaMipBytes(256);}assert.ok(desc.drawCalls<=(lod==='lod2'?3:config.budgets.drawCallsPerCell),'Draw budget exceeded');
      results.push({cell:cell.id,lod,proof});
    }
  }
  report.groundResurfacing={plan:{file:args.plan,sha256:pavingSha(read(args.plan))},authority:{file:args.authority,sha256:pavingSha(read(args.authority))},texture:{license:'CC0-1.0',originalProcedural:true,width:256,height:256,variants:[...encoded].map(([kind,b])=>({variant:kind,sha256:pavingSha(b),bytes:b.length}))},results,nativeAppearanceAndMemoryAcceptance:'PENDING'};
  // Keep report and manifest metadata honest for the changed detailed payloads.
  for(const result of results.filter(r=>r.lod==='lod0')){const stat=report.cells?.find((r:any)=>r.cell===result.cell),cell=index.cells.find((c:any)=>c.id===result.cell);if(stat){stat.drawCalls=cell.visual.lod0.drawCalls;stat.glbBytes=cell.visual.lod0.bytes;stat.ktx2Bytes=(stat.ktx2Bytes??0)+result.proof.encodedBytes;stat.textureTexels=(stat.textureTexels??0)+256*256*result.proof.textureCount;}if(report.totals){report.totals.drawCalls+=result.proof.addedPrimitives;report.totals.ktx2Bytes+=result.proof.encodedBytes;report.totals.textureTexels+=256*256*result.proof.textureCount;}}
  if(report.totals){report.totals.uniqueTextures=(report.totals.uniqueTextures??0)+images.size;report.totals.residentTextureMiBEstimate=(report.totals.residentTextureMiBEstimate??0)+images.size*pavingBc7MipBytes(256)/2**20;}
  if(report.budgets)report.budgets.drawCallsPerCellMax=Math.max(...index.cells.map((c:any)=>c.visual.lod0.drawCalls));
  writes.set('cells.json',Buffer.from(JSON.stringify(index,null,1)+'\n'));writes.set('report.json',Buffer.from(JSON.stringify(report,null,1)+'\n'));
  cpSync(base,out,{recursive:true,force:false,errorOnExist:true});for(const [file,data]of writes)writeFileSync(child(out,file),data);
  const after=inventory(out);assert.deepEqual([...after.keys()].sort(),[...before.keys()].sort());for(const [f,h]of before)if(!writes.has(f.replaceAll(path.sep,'/'))&&!writes.has(f))assert.equal(after.get(f),h,`Unselected payload changed: ${f}`);for(const [f,h]of before)assert.equal(pavingSha(read(child(base,f))),h,'Input mutated');
  const proof={schemaVersion:1,status:'PASS_STATIC_APPEARANCE_ONLY_NATIVE_PENDING',sourceIndexSha256:plan.baseCellsIndexSha256,outputIndexSha256:pavingSha(read(path.join(out,'cells.json'))),authoritySha256:pavingSha(read(args.authority)),counts:authority.counts,texture:report.groundResurfacing.texture,results,preserved:{allNonvisualFilesByteExact:true,allUnselectedVisualFilesByteExact:true,oldBinAndDescriptorsPrefixExact:true,renderedTriangleCoordinatesAndWindingExact:true,noDistantTexturesOrExtraDraws:true},limits:'Partial/ambiguous source coverage remains unpainted and disclosed. Native opened appearance/resource/travel gates still required.'};writeFileSync(path.join(out,'ground-resurfacing-proof.json'),JSON.stringify(proof,null,2)+'\n',{flag:'wx'});return proof;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const {values:v}=parseArgs({options:{base:{type:'string'},'street-parts':{type:'string'},origin:{type:'string'},plan:{type:'string'},config:{type:'string'},'out-plan':{type:'string'},preview:{type:'string'},authority:{type:'string'},out:{type:'string'}}});
  for(const key of ['base','street-parts','origin','plan','config']as const)assert.ok(v[key],`--${key} required`);const args={base:v.base!,streetParts:v['street-parts']!,origin:v.origin!,plan:v.plan!,config:v.config!};
  if(v.authority){assert.ok(v.out&&!v['out-plan']);console.log(JSON.stringify(await applyGroundResurfacing({...args,authority:v.authority,out:v.out}),null,2));}else{assert.ok(v['out-plan']&&!v.out);console.log(JSON.stringify(await planGroundResurfacing({...args,outPlan:v['out-plan'],preview:v.preview}),null,2));}
}
