// Source-bound material charts for optimized, external-texture delivery worlds.
// This writes replacement payloads only; the release owner applies the returned
// cell descriptors to its fresh derivative after any independent ground repair.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import sharp from 'sharp';
import {validateBytes} from 'gltf-validator';
import type {FileRef,WorldManifest} from '../../packages/world-schema/src/index.ts';
import {validateWorldManifest} from '../../packages/world-schema/src/index.ts';
import {readFacadeGlb} from './lib/facade-glb.ts';
import {facadeAtlasBytes,facadeChartSha256 as sha,facadeTriangleKey,validateFacadeTriangle,type FacadeChart,type FacadeChartTarget,type FacadeTriangle} from './lib/facade-charts.ts';
import {applyFacadeChartsToGlb,applyFacadeChartColorsToLod2,inspectFacadeChartTargets,readFacadeChartTriangles} from './lib/facade-chart-glb.ts';
import {encodeKtx2} from './lib/gltf.ts';

export interface DeliveryFacadeSourceOwner {readonly id:string;readonly vtj:string|null}
export type DeliveryFacadeCell = {id:string;baselineLevels:Record<string,string>;faces:{key:string;chart:string}[]} & (
  {building:string;vtj:string;buildings?:never} | {buildings:DeliveryFacadeSourceOwner[];building?:never;vtj?:never}
);
export interface DeliveryFacadeProfile {
  schemaVersion:1;
  id:string;
  baselineManifestSha256:string;
  source:{cityJsonSha256:string;cityBinSha256:string;originId:string};
  art:{path:string;sha256:string;width:number;height:number;license:string;attribution:string;
    references:{title:string;url:string;role:'appearance-reference-only'}[]};
  material:{name:string;unlit:boolean;roughness:number;doubleSided:boolean};
  charts:FacadeChart[];
  cells:DeliveryFacadeCell[];
}
/** Preserve legacy single-owner profiles; grouped profiles must name each source owner exactly once. */
export function deliveryFacadeSourceOwners(cell:DeliveryFacadeCell):readonly DeliveryFacadeSourceOwner[]{
  if('buildings' in cell){
    assert.ok(!('building' in cell)&&!('vtj' in cell),'Ambiguous grouped and legacy facade ownership');
    assert.ok(Array.isArray(cell.buildings)&&cell.buildings.length>0,'Grouped facade source owners required');
    assert.equal(new Set(cell.buildings.map(b=>b.id)).size,cell.buildings.length,'Duplicate facade source owner');
    for(const b of cell.buildings)assert.ok(b.id&&(b.vtj===null||typeof b.vtj==='string'&&b.vtj.length),'Source building ID and explicit VTJ or null required');return cell.buildings;
  }
  assert.ok(cell.building&&cell.vtj,'Legacy source building ID and VTJ required');return [{id:cell.building,vtj:cell.vtj}];
}
const load=(file:string)=>JSON.parse(fs.readFileSync(file,'utf8'));
function child(root:string,name:string) {
  assert.ok(name && !path.isAbsolute(name),'Relative asset path required');
  const file=path.resolve(root,name),rel=path.relative(root,file);
  assert.ok(rel && rel!=='..' && !rel.startsWith('..'+path.sep) && !path.isAbsolute(rel),'Asset path escapes its root');return file;
}
function pinned(root:string,ref:FileRef) {
  const file=child(root,ref.path),s=fs.lstatSync(file);assert.ok(s.isFile()&&!s.isSymbolicLink(),'Regular pinned payload required');
  const bytes=fs.readFileSync(file);assert.equal(bytes.length,ref.bytes,`${ref.path}: size changed`);assert.equal(sha(bytes),ref.sha256,`${ref.path}: hash changed`);return bytes;
}

/** Resolve only manifest-pinned local images, including normalized ../textures URIs. */
export function deliveryFacadeImages(root:string,ref:FileRef,bytes:Uint8Array,shared:readonly FileRef[]) {
  const {json}=readFacadeGlb(bytes),images=new Map<string,Uint8Array>();
  for(const image of (json.images??[]) as {uri?:string}[]){
    if(!image.uri)continue;
    assert.ok(!/[\\?#:]/.test(image.uri)&&!image.uri.startsWith('/'),'External image URI must be a local payload');
    const relative=path.posix.normalize(path.posix.join(path.posix.dirname(ref.path),image.uri));
    const owners=shared.filter(r=>r.path===relative);assert.equal(owners.length,1,'External image must have exactly one shared-texture manifest owner');
    images.set(image.uri,pinned(root,owners[0]!));
  }
  return images;
}

function sourceKeys(city:any,bin:Buffer,building:string,vtj:string|null) {
  const buildings=city.buildings.filter((b:any)=>b.id===building);assert.equal(buildings.length,1,'Unique source building required');assert.equal(buildings[0].vtj,vtj);
  const keys=new Map<string,number>();
  for(const part of buildings[0].parts){
    const p=part.positions,i=part.indices;assert.ok(p.offset>=0&&p.bytes%4===0&&p.offset+p.bytes<=bin.length&&i.offset>=0&&i.bytes%4===0&&i.offset+i.bytes<=bin.length);
    const P=new Float32Array(bin.buffer.slice(bin.byteOffset+p.offset,bin.byteOffset+p.offset+p.bytes)),I=new Uint32Array(bin.buffer.slice(bin.byteOffset+i.offset,bin.byteOffset+i.offset+i.bytes));
    for(let t=0;t<I.length;t+=3){const tri=[0,1,2].map(k=>{const v=I[t+k]!*3;assert.ok(v+2<P.length);return [P[v]!,P[v+2]!,-P[v+1]!] as const;}) as unknown as FacadeTriangle;
      const key=facadeTriangleKey(tri);keys.set(key,(keys.get(key)??0)+1);}
  }
  return keys;
}

export async function rebindDeliveryFacadeFaces(bytes:Uint8Array,images:ReadonlyMap<string,Uint8Array>,faces:DeliveryFacadeProfile['cells'][number]['faces'],charts:readonly FacadeChart[]) {
  const requested=new Map(faces.map(f=>[f.key,f.chart]));assert.equal(requested.size,faces.length,'Duplicate source face');assert.ok(requested.size>0);
  const targets:FacadeChartTarget[]=[],found=new Set<string>();
  for(const face of await readFacadeChartTriangles(bytes,images)){
    const chartId=requested.get(face.key);if(!chartId)continue;
    assert.ok(!found.has(face.key),'Source face is drawn more than once in this tier');found.add(face.key);
    const chart=charts.find(c=>c.id===chartId);assert.ok(chart,'Missing chart');validateFacadeTriangle(face.points,chart);
    targets.push({node:face.node,primitive:face.primitive,triangle:face.triangle,key:face.key,chart:chartId});
  }
  assert.equal(found.size,requested.size,'A selected source face is absent or changed in this tier');return targets;
}

export async function applyDeliveryFacadeCharts(args:{baseline:string;current:string;cityModel:string;profile:string;out:string}) {
  const baseline=path.resolve(args.baseline),current=path.resolve(args.current),out=path.resolve(args.out),profileFile=path.resolve(args.profile),cityDir=path.resolve(args.cityModel);
  assert.ok(!fs.existsSync(out),'Fresh replacement output required');
  for(const source of [baseline,current])assert.ok(out!==source&&!out.startsWith(source+path.sep)&&!source.startsWith(out+path.sep),'Output must be independent of source world');
  const p=load(profileFile) as DeliveryFacadeProfile;assert.equal(p.schemaVersion,1);assert.ok(p.id&&p.charts.length&&p.cells.length);
  const baseBytes=fs.readFileSync(path.join(baseline,'manifest.json'));assert.equal(sha(baseBytes),p.baselineManifestSha256,'Wrong deployed baseline');
  const base=JSON.parse(baseBytes.toString()) as WorldManifest,manifest=load(path.join(current,'manifest.json')) as WorldManifest;
  assert.deepEqual(validateWorldManifest(base),[]);assert.deepEqual(validateWorldManifest(manifest),[]);assert.equal(base.origin.id,p.source.originId);assert.equal(manifest.origin.id,p.source.originId);
  const cityBytes=fs.readFileSync(path.join(cityDir,'city-model.json'));assert.equal(sha(cityBytes),p.source.cityJsonSha256);const city=JSON.parse(cityBytes.toString());
  const bin=fs.readFileSync(child(cityDir,city.binary.file));assert.equal(sha(bin),p.source.cityBinSha256);assert.equal(sha(bin),city.binary.sha256);assert.equal(city.originId,p.source.originId);
  const artBytes=fs.readFileSync(child(path.dirname(profileFile),p.art.path));assert.equal(sha(artBytes),p.art.sha256);assert.ok(p.art.license&&p.art.attribution&&p.art.references.length);
  for(const r of p.art.references){assert.equal(r.role,'appearance-reference-only');assert.ok(/^https:\/\//.test(r.url)&&r.title);}
  const raw=await sharp(artBytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});assert.equal(raw.info.width,p.art.width);assert.equal(raw.info.height,p.art.height);
  const grouped=p.cells.some(c=>'buildings' in c),sideLimit=grouped?1024:768;
  assert.ok(p.art.width<=sideLimit&&p.art.height<=sideLimit);for(let i=3;i<raw.data.length;i+=4)assert.equal(raw.data[i],255,'Opaque facade art required');
  const maximumFallbackBytes=grouped?6*1024*1024:3*1024*1024;
  assert.ok(facadeAtlasBytes(p.art.width,p.art.height)<=maximumFallbackBytes,'Authored atlas exceeds fallback memory budget');
  const image={width:raw.info.width,height:raw.info.height,data:new Uint8Array(raw.data)},atlas=await encodeKtx2(image,'facade');
  const pending=new Map<string,Uint8Array>(),updates:any[]=[];let addedTextureEstimate=0;
  assert.equal(new Set(p.cells.map(c=>c.id)).size,p.cells.length,'Cell entries must be unique');
  for(const selected of p.cells){
    const original=base.cells.find(c=>c.id===selected.id),cell=manifest.cells.find(c=>c.id===selected.id);assert.ok(original&&cell,'Missing owner cell');
    const owners=deliveryFacadeSourceOwners(selected),ownerIds=new Set(owners.map(b=>b.id)),source=new Map<string,ReturnType<typeof sourceKeys>>();
    for(const owner of owners){
      assert.equal(cell.buildings.find(b=>b.id===owner.id)?.vtj,owner.vtj,'Wrong source building owner');
      assert.equal(original.buildings.find(b=>b.id===owner.id)?.vtj,owner.vtj,'Source building is absent from the deployed owner cell');
      source.set(owner.id,sourceKeys(city,bin,owner.id,owner.vtj));
    }
    for(const face of selected.faces){const chart=p.charts.find(c=>c.id===face.chart);assert.ok(chart&&ownerIds.has(chart.building),'Chart owner is not declared in this cell');
      assert.equal(source.get(chart.building)?.get(face.key),1,'Chart target must be exactly one triangle of its declared original source building');}
    for(const owner of owners)assert.ok(selected.faces.some(f=>p.charts.find(c=>c.id===f.chart)?.building===owner.id),'Declared source owner has no selected facade faces');
    const next={...cell,visual:{...cell.visual},buildings:[...cell.buildings]},cache=new Map<string,{ref:any;proof:any}>();let coverage:Awaited<ReturnType<typeof inspectFacadeChartTargets>>|undefined;
    const proofs:any[]=[];
    for(const level of ['lod0','lod1','lod2'] as const){
      const old=cell.visual[level],baseLevel:FileRef|undefined=original.visual[level];if(!old){assert.ok(!selected.baselineLevels[level]);continue;}
      assert.equal(baseLevel?.sha256,selected.baselineLevels[level],'Pinned baseline tier changed');
      const cached=cache.get(old.path);if(cached){
        next.visual[level]={...old,path:cached.ref.path,sha256:cached.ref.sha256,bytes:cached.ref.bytes,
          drawCalls:old.drawCalls+cached.proof.addedPrimitives,atlases:old.atlases+(level==='lod2'?0:1),textureBytesEstimate:old.textureBytesEstimate+cached.proof.fallbackBytes};
        proofs.push({level,alias:true,...cached.proof});continue;
      }
      const bytes=pinned(current,old),images=deliveryFacadeImages(current,old,bytes,manifest.sharedTextures??[]),targets=await rebindDeliveryFacadeFaces(bytes,images,selected.faces,p.charts),common={expectedSha256:old.sha256,charts:p.charts,targets,externalImages:images};
      if(level==='lod0')coverage=await inspectFacadeChartTargets(bytes,common);
      assert.ok(coverage,'Detailed coverage must be established before lower tiers');
      const result=level==='lod2'?await applyFacadeChartColorsToLod2(bytes,{...common,image,detailedCoverage:coverage}):await applyFacadeChartsToGlb(bytes,{...common,
        atlas:{name:p.id,image:atlas,mimeType:'image/ktx2',width:p.art.width,height:p.art.height},maximumFallbackBytes,material:p.material,
        extras:{facadeChartProfile:p.id,profileSha256:sha(fs.readFileSync(profileFile)),artSha256:p.art.sha256,license:p.art.license,attribution:p.art.attribution,appearanceReferences:p.art.references,sourceGeometry:'Original municipal triangles and winding unchanged'}});
      const validationOptions={maxIssues:100,externalResourceFunction:async(uri:string)=>{const payload=images.get(uri);assert.ok(payload,'Validator requested an unpinned image');return payload;}};
      const validation=await validateBytes(result.bytes,validationOptions);
      assert.equal(validation.issues.numErrors,0,JSON.stringify(validation.issues.messages.filter(m=>m.severity===0)));
      const hash=sha(result.bytes),name=`cells/${cell.id}.${level}.${hash.slice(0,16)}.glb`;
      const ref={...old,path:name,sha256:hash,bytes:result.bytes.length,drawCalls:old.drawCalls+result.proof.addedPrimitives,
        // Manifest scheduling uses an RGBA+mips upper bound; the chart proof's
        // textureBytesEstimate is the separate compressed GPU estimate.
        atlases:old.atlases+(level==='lod2'?0:1),textureBytesEstimate:old.textureBytesEstimate+result.proof.fallbackBytes};
      assert.ok(ref.drawCalls<=24,'Facade exceeds per-cell draw cap');if(grouped&&level==='lod2')assert.ok(ref.drawCalls<=3,'Grouped facade exceeds the 3-draw distant-tier cap');
      next.visual[level]=ref;pending.set(name,result.bytes);cache.set(old.path,{ref,proof:result.proof});proofs.push({level,...result.proof});
      if(level==='lod0')addedTextureEstimate+=result.proof.fallbackBytes;
    }
    next.buildings=next.buildings.map(b=>ownerIds.has(b.id)?{...b,texture:'textured'}:b);assert.deepEqual(next.collision,cell.collision);pinned(current,cell.collision);
    updates.push({cell:cell.id,before:cell,after:next,proofs});
  }
  fs.mkdirSync(out,{recursive:true});for(const [relative,bytes]of pending){const file=child(out,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes,{flag:'wx'});}
  const proof={schemaVersion:1,status:'PATCH_PAYLOADS_READY',runtimeAcceptance:'REQUIRED',profile:p.id,profileSha256:sha(fs.readFileSync(profileFile)),baselineManifestSha256:p.baselineManifestSha256,
    currentManifestSha256:sha(fs.readFileSync(path.join(current,'manifest.json'))),source:p.source,art:p.art,encodedAtlasSha256:sha(atlas),addedTextureEstimate,updates,
    files:[...pending].map(([name,bytes])=>({path:name,bytes:bytes.length,sha256:sha(bytes)})),preserved:{originalBinPrefix:true,unselectedImagesAndUVs:true,sourceCoordinatesAndWinding:true,collisionAndGround:true,sourceWorldsUnmodified:true}};
  fs.writeFileSync(path.join(out,'patches.json'),JSON.stringify(proof,null,2)+'\n',{flag:'wx'});return proof;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const {values}=parseArgs({options:{baseline:{type:'string'},current:{type:'string'},'city-model':{type:'string'},profile:{type:'string'},out:{type:'string'}}});
  assert.ok(values.baseline&&values.current&&values['city-model']&&values.profile&&values.out,'--baseline --current --city-model --profile --out required');
  const result=await applyDeliveryFacadeCharts({baseline:values.baseline,current:values.current,cityModel:values['city-model'],profile:values.profile,out:values.out});
  console.log(JSON.stringify({status:result.status,cells:result.updates.length,files:result.files.length,addedTextureEstimate:result.addedTextureEstimate}));
}
