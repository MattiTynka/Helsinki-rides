import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import v8 from 'node:v8';
import {createHash} from 'node:crypto';
import {NodeIO,type Primitive} from '@gltf-transform/core';
import {ALL_EXTENSIONS} from '@gltf-transform/extensions';
import {MeshoptDecoder} from 'meshoptimizer';
import {encodeCollisionBundle,parseCollisionBundle,encodeTerrain,parseTerrain,type CellDescriptor} from '../../../packages/world-schema/src/index.ts';
import {addNativeFrontier,clipFrontierMesh,frontierTriangleKey,prepareNativeFrontier,planCityFrontier,type FrontierMesh} from './frontier-ground.ts';
import {clipGroundToRectangle,parseAppendRectangle,type AppendRectangle} from './append-city-cells.ts';
import {replaceGroundGlb,type GroundAttributeArray,type GroundGlbReplacement} from './replace-ground-glb.ts';
import {lowerTerrainUnderGround,type GroundPiece} from './ground.ts';
import {readFacadeGlb} from './facade-glb.ts';

const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
const trianglePoints=(mesh:FrontierMesh,t:number)=>[0,1,2].map(k=>Array.from(mesh.attributes.POSITION!.subarray(mesh.indices[t*3+k]!*3,mesh.indices[t*3+k]!*3+3)));
interface TrackedMesh {mesh:FrontierMesh;sourceTriangles:number[]}
function pickTriangles(input:TrackedMesh,predicate:(t:number)=>boolean):TrackedMesh {
  const indices:number[]=[],sourceTriangles:number[]=[];for(let t=0;t<input.mesh.indices.length/3;t++)if(predicate(t)){indices.push(...input.mesh.indices.subarray(t*3,t*3+3));sourceTriangles.push(input.sourceTriangles[t]!);}
  return{mesh:{...input.mesh,indices:Uint32Array.from(indices)},sourceTriangles};
}
function mergeTracked(parts:TrackedMesh[],template:FrontierMesh):TrackedMesh{
  const attributes:Record<string,GroundAttributeArray>={},indices:number[]=[],sourceTriangles:number[]=[];let vertices=0;
  for(const part of parts){for(const i of part.mesh.indices)indices.push(i+vertices);vertices+=part.mesh.attributes.POSITION!.length/3;for(const t of part.sourceTriangles)sourceTriangles.push(t);}
  for(const semantic of Object.keys(template.attributes)){const source=template.attributes[semantic]!,Type=source.constructor as {new(size:number):GroundAttributeArray},size=parts.reduce((n,p)=>n+p.mesh.attributes[semantic]!.length,0),array=new Type(size);let offset=0;for(const part of parts){array.set(part.mesh.attributes[semantic]!,offset);offset+=part.mesh.attributes[semantic]!.length;}attributes[semantic]=array;}
  return{mesh:{...template,attributes,indices:Uint32Array.from(indices)},sourceTriangles};
}
function clipTracked(input:TrackedMesh,axis:0|2,cut:number,side:'east'|'west'):TrackedMesh {const out=clipFrontierMesh(input.mesh,{cutX:cut,cutAxis:axis,side});return{mesh:out.mesh,sourceTriangles:out.sourceTriangles.map(i=>input.sourceTriangles[i]!)};}

/** Four disjoint exterior regions. The replacement owns aligned boundary walls; shared edge vertices
 * remain closed. Unselected architecture is emitted exactly once, with its raw attributes untouched. */
export function retainGroundOutsideRectangle(mesh:FrontierMesh,region:AppendRectangle,selectTriangle?:(triangle:number)=>boolean):TrackedMesh {
  parseAppendRectangle(region.join(','));const original={mesh,sourceTriangles:Array.from({length:mesh.indices.length/3},(_,i)=>i)},selected=pickTriangles(original,t=>selectTriangle?.(t)??true),unselected=pickTriangles(original,t=>!(selectTriangle?.(t)??true));
  const withoutAligned=(input:TrackedMesh,axis:0|2,cut:number)=>pickTriangles(input,t=>!trianglePoints(input.mesh,t).every(p=>p[axis]===cut));
  const left=withoutAligned(clipTracked(selected,0,region[0],'west'),0,region[0]),right=withoutAligned(clipTracked(selected,0,region[2],'east'),0,region[2]);
  const middle=clipTracked(clipTracked(selected,0,region[0],'east'),0,region[2],'west'),bottom=withoutAligned(clipTracked(middle,2,region[1],'west'),2,region[1]),top=withoutAligned(clipTracked(middle,2,region[3],'east'),2,region[3]);
  return mergeTracked([left,right,bottom,top,unselected].filter(p=>p.mesh.indices.length),mesh);
}
export function patchGroundCollision(bytes:Uint8Array,region:AppendRectangle,pieces:readonly GroundPiece[],selectTriangle?:(colliderId:string,triangle:number,tag:string)=>boolean){
  const old=parseCollisionBundle(bytes),tags=[...old.header.surfaceTags],tag=(name:string)=>{let id=tags.indexOf(name);if(id<0){id=tags.length;tags.push(name);}assert.ok(id<=65535);return id;};let appended=false;
  const native=pieces.filter(p=>p.use!=='visual'),colliders=old.colliders.map(c=>{
    if(c.group!=='ground'&&c.group!=='kerbs')return c;
    const selected=(i:number)=>selectTriangle?.(c.id,i,old.header.surfaceTags[c.triangleTags[i]!]!)??true;
    if(selectTriangle&&!c.triangleTags.some((_tag,i)=>selected(i)))return c;
    const kept=retainGroundOutsideRectangle({attributes:{POSITION:c.positions},components:{POSITION:3},normalized:{POSITION:false},indices:c.indices},region,selected),positions=Array.from(kept.mesh.attributes.POSITION!),indices=Array.from(kept.mesh.indices),triangleTags=kept.sourceTriangles.map(i=>c.triangleTags[i]!);
    if(!appended&&c.group==='ground'){for(const p of native){const offset=positions.length/3;for(const v of p.positions)positions.push(v);for(const i of p.indices)indices.push(i+offset);for(let i=0;i<p.indices.length/3;i++)triangleTags.push(tag(p.tag));}appended=true;}
    return{...c,positions:Float32Array.from(positions),indices:Uint32Array.from(indices),triangleTags:Uint16Array.from(triangleTags)};
  });
  assert.ok(appended||!native.length,'Patch needs an existing ground collider');const out=encodeCollisionBundle({...old.header,surfaceTags:tags},colliders),decoded=parseCollisionBundle(out);
  assert.deepEqual(decoded.colliders.map(c=>[c.id,c.group,c.ref]),old.colliders.map(c=>[c.id,c.group,c.ref]));
  for(let i=0;i<old.colliders.length;i++)if(!['ground','kerbs'].includes(old.colliders[i]!.group))assert.deepEqual(decoded.colliders[i],old.colliders[i],'Non-ground collider changed');
  return{bytes:out,triangles:colliders.reduce((n,c)=>n+c.indices.length/3,0)};
}
const fromPrimitive=(p:Primitive):FrontierMesh=>({attributes:Object.fromEntries(p.listSemantics().map(s=>[s,p.getAttribute(s)!.getArray()! as GroundAttributeArray])),components:Object.fromEntries(p.listSemantics().map(s=>[s,p.getAttribute(s)!.getElementSize()])),normalized:Object.fromEntries(p.listSemantics().map(s=>[s,p.getAttribute(s)!.getNormalized()])),indices:Uint32Array.from(p.getIndices()!.getArray()!)});
const identity=[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
function protectedFrontierPlane(value:unknown):{axis:'x'|'z';cut:number;positive:boolean}{
  assert.ok(value&&typeof value==='object'&&!Array.isArray(value),'Frontier repair metadata must be an object');const repair=value as Record<string,unknown>;
  assert.ok(repair.schemaVersion===1||repair.schemaVersion===2,'Unsupported frontier repair schema');assert.equal(repair.protectedInteriorPreserved,true,'Frontier protected-interior proof is required');
  const rectangle=(key:string):AppendRectangle=>{const value=repair[key];assert.ok(Array.isArray(value)&&value.length===4&&value.every(v=>typeof v==='number'&&Number.isFinite(v)),`Frontier ${key} must contain four finite coordinates`);return parseAppendRectangle(value.join(','));};
  const region=rectangle('geographicRegion'),groundRegion=rectangle('groundRegion'),sourceBand=rectangle('sourceBand');
  if(repair.schemaVersion===1){
    assert.ok(repair.axis===undefined||repair.axis==='x','Legacy frontier must use the X axis');assert.equal(repair.cut,undefined,'Legacy frontier may not carry an explicit-axis cut');
    assert.ok(typeof repair.cutX==='number'&&Number.isFinite(repair.cutX),'Legacy frontier cutX is required');assert.equal(repair.protectedMinX,repair.cutX,'Legacy frontier protection differs from its cut');assert.equal(repair.cutX,region[2]+5,'Legacy frontier must replace exactly five accepted metres');
    assert.deepEqual(groundRegion,[region[0],region[1],repair.cutX,region[3]],'Legacy frontier ground region differs');assert.deepEqual(sourceBand,[region[2]-6,region[1],repair.cutX,region[3]],'Legacy frontier source band differs');return{axis:'x',cut:repair.cutX,positive:false};
  }
  assert.ok(repair.axis==='x'||repair.axis==='z','Explicit frontier axis is required');assert.ok(typeof repair.cut==='number'&&Number.isFinite(repair.cut),'Explicit frontier cut is required');
  assert.equal(repair.cutX,undefined,'Explicit frontier may not carry a legacy X cut');assert.equal(repair.protectedMinX,undefined,'Explicit frontier may not carry legacy X protection');
  const plan=planCityFrontier(rectangle('acceptedBounds'),region,repair.axis);assert.equal(repair.cut,plan.cut,'Explicit frontier cut differs from its accepted extent');assert.equal(repair.protectedSide,plan.protectedSide,'Explicit frontier protected side differs');assert.deepEqual(groundRegion,plan.groundRegion,'Explicit frontier ground region differs');assert.deepEqual(sourceBand,plan.sourceBand,'Explicit frontier source band differs');
  return{axis:plan.axis,cut:plan.cut,positive:plan.protectedSide==='north'};
}
/** A later local patch may lie in newly appended terrain. Its protection rule is a half-plane, not the
 * old accepted-grid lowering exception: points outside old bounds still require the same protected cut. */
export function outsideProtectedFrontier(repair:unknown,x:number,z:number):boolean{
  assert.ok(Number.isFinite(x)&&Number.isFinite(z),'Frontier patch coordinates must be finite');const plane=protectedFrontierPlane(repair),coordinate=plane.axis==='x'?x:z;return plane.positive?coordinate>plane.cut:coordinate<plane.cut;
}
function groundKeys(doc:Awaited<ReturnType<NodeIO['readBinary']>>){const keys=new Map<string,string>();for(const node of doc.getRoot().listNodes())if(node.getMesh()&&node.getName().includes('_ground_')){assert.deepEqual(node.getWorldMatrix(),identity,'Ground patch requires baked world coordinates');const finish=node.getName().split('_ground_')[1]!;for(const primitive of node.getMesh()!.listPrimitives()){const mesh=fromPrimitive(primitive);for(let t=0;t<mesh.indices.length/3;t++)keys.set(frontierTriangleKey(trianglePoints(mesh,t)),finish);}}return keys;}
function activeCounts(bytes:Uint8Array){const json=readFacadeGlb(bytes).json as any;let triangles=0,drawCalls=0;for(const n of json.nodes)if(n.mesh!==undefined)for(const p of json.meshes[n.mesh].primitives){triangles+=json.accessors[p.indices].count/3;drawCalls++;}return{triangles,drawCalls};}

export interface PreservedGroundPatchSidecar {path:string;bytes:number;sha256:string}
/** Preserve unmodified provenance beside the regenerated payloads. Preflight every destination before
 * linking anything, so a conflicting existing file cannot cause another proof to be silently replaced. */
export function preserveGroundPatchSidecars(sourceRoot:string,outputRoot:string,payloadPaths:Iterable<string>):PreservedGroundPatchSidecar[]{
  const base=path.resolve(sourceRoot),out=path.resolve(outputRoot),inside=(root:string,file:string)=>{const relative=path.relative(root,file);return relative===''||(!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith(`..${path.sep}`));};assert.ok(!inside(base,out)&&!inside(out,base),'Sidecar source/output directories must be disjoint');
  const optionalStat=(file:string)=>{try{return fs.lstatSync(file);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}},safe=(root:string,relative:string)=>{const file=path.resolve(root,relative);assert.ok(file!==root&&inside(root,file),'Sidecar path escapes its owner');return file;},canonical=(relative:string)=>path.relative(base,safe(base,relative)).replaceAll('\\','/');
  const sourceStat=fs.lstatSync(base);assert.ok(sourceStat.isDirectory()&&!sourceStat.isSymbolicLink(),'Sidecar source must be an ordinary directory');const outputStat=optionalStat(out);assert.ok(!outputStat||(outputStat.isDirectory()&&!outputStat.isSymbolicLink()),'Sidecar output must be an ordinary directory');
  const excluded=new Set([...payloadPaths,'cells.json','report.json','ground-region-patch.json'].map(canonical)),refs:PreservedGroundPatchSidecar[]=[];
  const scan=(relative='')=>{for(const item of fs.readdirSync(path.join(base,relative),{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const local=path.join(relative,item.name),file=safe(base,local),stat=fs.lstatSync(file);assert.ok(!stat.isSymbolicLink(),`Sidecar source links are not followed: ${local}`);if(stat.isDirectory())scan(local);else{assert.ok(stat.isFile(),`Unsupported sidecar source entry: ${local}`);const name=local.replaceAll('\\','/');if(excluded.has(name))continue;const bytes=fs.readFileSync(file);assert.equal(bytes.length,stat.size);refs.push({path:name,bytes:bytes.length,sha256:sha(bytes)});}}};scan();
  const existing=new Set<string>();for(const ref of refs){const target=safe(out,ref.path),parts=path.relative(out,path.dirname(target)).split(path.sep).filter(Boolean);let parent=out;for(const part of parts){parent=path.join(parent,part);const stat=optionalStat(parent);assert.ok(!stat||(stat.isDirectory()&&!stat.isSymbolicLink()),`Sidecar output parent cannot be a link or file: ${parent}`);}const stat=optionalStat(target);if(!stat)continue;assert.ok(stat.isFile()&&!stat.isSymbolicLink(),`Sidecar output cannot be a link or directory: ${ref.path}`);const bytes=fs.readFileSync(target);assert.ok(bytes.length===ref.bytes&&sha(bytes)===ref.sha256,`Existing sidecar differs: ${ref.path}`);existing.add(ref.path);}
  fs.mkdirSync(out,{recursive:true});for(const ref of refs){const source=safe(base,ref.path),target=safe(out,ref.path);assert.equal(sha(fs.readFileSync(source)),ref.sha256,`Source sidecar changed: ${ref.path}`);if(!existing.has(ref.path)){fs.mkdirSync(path.dirname(target),{recursive:true});fs.linkSync(source,target);}const bytes=fs.readFileSync(target);assert.equal(bytes.length,ref.bytes);assert.equal(sha(bytes),ref.sha256,`Preserved sidecar changed: ${ref.path}`);assert.equal(sha(fs.readFileSync(source)),ref.sha256,`Input sidecar changed: ${ref.path}`);}
  return refs;
}

async function patchVisual(bytes:Uint8Array,io:NodeIO,region:AppendRectangle,pieces:readonly GroundPiece[],tier:string,keys:Map<string,string>){
  const doc=await io.readBinary(bytes),changes:GroundGlbReplacement[]=[],nativeByFinish=new Map<string,GroundPiece[]>();for(const p of pieces)if(p.use!=='collision'){const list=nativeByFinish.get(p.finish)??[];list.push(p);nativeByFinish.set(p.finish,list);}
  if(tier!=='lod2'){
    for(const node of doc.getRoot().listNodes())if(node.getMesh()&&node.getName().includes('_ground_')){assert.deepEqual(node.getWorldMatrix(),identity,'Ground patch requires baked world coordinates');const finish=node.getName().split('_ground_')[1]!;
      for(const[i,p]of node.getMesh()!.listPrimitives().entries()){const original=fromPrimitive(p),kept=retainGroundOutsideRectangle(original,region).mesh,add=nativeByFinish.get(finish)??[],next=addNativeFrontier(kept,add);nativeByFinish.delete(finish);changes.push({nodeName:node.getName(),primitiveIndex:i,attributes:next.attributes,indices:next.indices});}
    }
    assert.equal(nativeByFinish.size,0,`Native finishes need existing materials: ${[...nativeByFinish.keys()].join(', ')}`);
  }else{
    const coarse:{name:string;primitiveIndex:number;mesh:FrontierMesh}[]=[],palette=new Map<string,{sum:number[];count:number}>();
    for(const node of doc.getRoot().listNodes())if(node.getMesh()){assert.deepEqual(node.getWorldMatrix(),identity);for(const[i,p]of node.getMesh()!.listPrimitives().entries()){const mesh=fromPrimitive(p);assert.deepEqual(Object.keys(mesh.attributes).sort(),['COLOR_0','POSITION']);assert.ok(mesh.attributes.COLOR_0 instanceof Float32Array&&mesh.components.COLOR_0===3,'Distant colours must be native Float32 RGB');
      for(let t=0;t<mesh.indices.length/3;t++){const finish=keys.get(frontierTriangleKey(trianglePoints(mesh,t)));if(!finish)continue;const item=palette.get(finish)??{sum:[0,0,0],count:0};for(let k=0;k<3;k++){const index=mesh.indices[t*3+k]!;for(let c=0;c<3;c++)item.sum[c]!+=mesh.attributes.COLOR_0[index*3+c]!;item.count++;}palette.set(finish,item);}
      coarse.push({name:node.getName(),primitiveIndex:i,mesh});
    }}
    assert.ok(coarse.length,'Distant cell has no geometry');let added=false;
    for(const entry of coarse){const kept=retainGroundOutsideRectangle(entry.mesh,region,t=>keys.has(frontierTriangleKey(trianglePoints(entry.mesh,t)))).mesh;
      if(!added){const pos=Array.from(kept.attributes.POSITION!),colour=Array.from(kept.attributes.COLOR_0!),indices=Array.from(kept.indices);
        for(const[finish,parts]of nativeByFinish){const sampled=palette.get(finish);assert.ok(sampled,`No source distant colour for native finish ${finish}`);const rgb=sampled.sum.map(v=>v/sampled.count);for(const p of parts)for(const id of p.indices){indices.push(pos.length/3);pos.push(...p.positions.slice(id*3,id*3+3));colour.push(...rgb);}}
        kept.attributes={POSITION:Float32Array.from(pos),COLOR_0:Float32Array.from(colour)};kept.indices=Uint32Array.from(indices);added=true;
      }
      changes.push({nodeName:entry.name,primitiveIndex:entry.primitiveIndex,kind:'distant-ground',attributes:kept.attributes,indices:kept.indices});
    }
  }
  const out=await replaceGroundGlb(bytes,changes);assert.deepEqual(readFacadeGlb(out).bin.subarray(0,readFacadeGlb(bytes).bin.length),readFacadeGlb(bytes).bin);return{bytes:out,...activeCounts(out)};
}

export interface GroundRegionPatchOptions {cells:string;nativeCache:string;nativeMetadata:string;region:AppendRectangle;out:string}
export async function patchGroundRegion(options:GroundRegionPatchOptions){
  parseAppendRectangle(options.region.join(','));const base=path.resolve(options.cells),out=path.resolve(options.out),relative=path.relative(base,out);assert.ok(!fs.existsSync(out),'Ground patch output must be fresh');assert.ok(relative==='..'||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative),'Output cannot be nested in source');
  const metadataBytes=fs.readFileSync(options.nativeMetadata),metadata=JSON.parse(metadataBytes.toString());assert.equal(metadata.schemaVersion,1);assert.equal(metadata.kind,'native-ground-region-patch');assert.equal(metadata.status,'SOURCE_GROUND_PATCH_QUALIFIED_SERIALIZATION_PENDING','Native source patch must be qualified');assert.deepEqual(metadata.region,options.region);
  assert.equal(path.resolve(metadata.cache.file),path.resolve(options.nativeCache),'Native cache path differs');const cacheBytes=fs.readFileSync(options.nativeCache);assert.equal(sha(cacheBytes),metadata.cache.sha256);const receipts=[...(metadata.inputs??[]),...(metadata.sourceFiles??[]),...(metadata.runtimeTerrain?[metadata.runtimeTerrain]:[])];assert.ok(receipts.length,'Native source bindings required');for(const r of receipts)assert.equal(sha(fs.readFileSync(r.file)),r.sha256,`Changed native source ${r.file}`);
  const cached=v8.deserialize(cacheBytes) as {pieces:GroundPiece[];kerbs:GroundPiece[]};assert.ok(Array.isArray(cached.pieces)&&Array.isArray(cached.kerbs));const prepared=prepareNativeFrontier(clipGroundToRectangle([...cached.pieces,...cached.kerbs],options.region)),pieces=prepared.pieces;assert.ok(pieces.length,'Native patch has no ground');
  const indexBytes=fs.readFileSync(path.join(base,'cells.json')),index=JSON.parse(indexBytes.toString()),report=JSON.parse(fs.readFileSync(path.join(base,'report.json'),'utf8'));
  const hasFrontier=report.frontierRepair!==undefined&&report.frontierRepair!==null;if(hasFrontier)protectedFrontierPlane(report.frontierRepair);
  const safe=(root:string,p:string)=>{const file=path.resolve(root,p),rel=path.relative(root,file);assert.ok(rel&&!path.isAbsolute(rel)&&rel!=='..'&&!rel.startsWith(`..${path.sep}`));return file;};
  const read=(ref:{path:string;sha256:string;bytes?:number})=>{const bytes=fs.readFileSync(safe(base,ref.path));assert.equal(sha(bytes),ref.sha256);if(ref.bytes!==undefined)assert.equal(bytes.length,ref.bytes);return bytes;};
  const cellIds=new Set<string>(index.cells.map((c:CellDescriptor)=>c.id)),affected=new Set<string>(pieces.map(p=>p.cell));for(const id of affected)assert.ok(cellIds.has(id),`Native ground has no existing cell: ${id}`);
  for(const cell of index.cells as CellDescriptor[]){
    for(const ref of Object.values(cell.visual))read(ref);
    // Authored walls may cross their owning cell's rectangle. Use actual ground triangles, not just the
    // descriptor rectangle, so an old protruding face cannot survive inside the replacement region.
    for(const c of parseCollisionBundle(read(cell.collision)).colliders)if(c.group==='ground'||c.group==='kerbs')for(let t=0;t<c.indices.length;t+=3){const ids=[c.indices[t]!,c.indices[t+1]!,c.indices[t+2]!],xs=ids.map(i=>c.positions[i*3]!),zs=ids.map(i=>c.positions[i*3+2]!);if(Math.min(...xs)<=options.region[2]&&Math.max(...xs)>=options.region[0]&&Math.min(...zs)<=options.region[3]&&Math.max(...zs)>=options.region[1]){affected.add(cell.id);break;}}
  }
  const oldTerrainBytes=read(report.supportTerrain),oldTerrain=parseTerrain(oldTerrainBytes),nextTerrain=lowerTerrainUnderGround(oldTerrain,pieces),lowered:any[]=[];
  for(let i=0;i<oldTerrain.heights.length;i++)if(!Object.is(oldTerrain.heights[i],nextTerrain.heights[i])){const x=oldTerrain.x0+(i%oldTerrain.nx)*oldTerrain.resolution,z=oldTerrain.z0+Math.floor(i/oldTerrain.nx)*oldTerrain.resolution;assert.ok(x>=options.region[0]&&x<=options.region[2]&&z>=options.region[1]&&z<=options.region[3]&&nextTerrain.heights[i]!<oldTerrain.heights[i]!,'Safety changes must lower only within patch');if(hasFrontier)assert.ok(outsideProtectedFrontier(report.frontierRepair,x,z),'Protected interior safety changed');lowered.push({x,z,old:oldTerrain.heights[i],next:nextTerrain.heights[i]});}
  await MeshoptDecoder.ready;const io=new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.decoder':MeshoptDecoder});fs.mkdirSync(out,{recursive:true});
  const write=(refPath:string,bytes:Uint8Array)=>{const file=safe(out,refPath);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes,{flag:'wx'});return{path:refPath,bytes:bytes.length,sha256:sha(bytes)};},link=(p:string)=>{const target=safe(out,p);fs.mkdirSync(path.dirname(target),{recursive:true});fs.linkSync(safe(base,p),target);};
  const proof:any[]=[];for(const cell of index.cells as CellDescriptor[]){const native=pieces.filter(p=>p.cell===cell.id);
    if(!affected.has(cell.id)){for(const ref of[...Object.values(cell.visual),cell.collision])link(ref.path);continue;}
    const lod0=read(cell.visual.lod0),keys=groundKeys(await io.readBinary(lod0)),before=structuredClone(cell);
    for(const[tier,ref]of Object.entries(cell.visual)){const result=await patchVisual(read(ref),io,options.region,native,tier,keys);Object.assign(ref,write(ref.path,result.bytes),{triangles:result.triangles,drawCalls:result.drawCalls});}
    const collision=patchGroundCollision(read(cell.collision),options.region,native);Object.assign(cell.collision,write(cell.collision.path,collision.bytes),{triangles:collision.triangles});proof.push({cell:cell.id,before,after:structuredClone(cell),nativePieces:native.length});
  }
  const supportTerrain=write(report.supportTerrain.path,encodeTerrain(nextTerrain));if(fs.existsSync(path.join(base,'scenery.json')))link('scenery.json');
  const preservedSidecars=preserveGroundPatchSidecars(base,out,[report.supportTerrain.path,'scenery.json',...(index.cells as CellDescriptor[]).flatMap(c=>[...Object.values(c.visual),c.collision].map(ref=>ref.path))]);
  const patch={schemaVersion:1,region:options.region,baseCells:base,baseIndexSha256:sha(indexBytes),nativeMetadata:{file:options.nativeMetadata,sha256:sha(metadataBytes)},nativeCache:{file:options.nativeCache,sha256:sha(cacheBytes)},inputs:receipts,sourceStatus:metadata.status,method:'Exact native ground rectangle; disjoint exterior clipping; raw GLB BIN prefixes and non-ground resources retained; distant architecture selected by exact LOD0 ground triangle keys',distantColourMethod:'Mean existing distant vertex colour by matching source ground finish',discardedExactFloat32ZeroArea:prepared.discarded,protectedInteriorPreserved:true,preservedSidecars,loweredSafetySamples:lowered.length,lowered,proof};
  const nextReport={...report,builtAt:new Date().toISOString(),supportTerrain,groundRegionPatch:patch,groundRegionPatches:[...(report.groundRegionPatches??(report.groundRegionPatch?[report.groundRegionPatch]:[])),patch],cells:index.cells.map((c:CellDescriptor)=>({cell:c.id,buildings:c.buildings.length,drawCalls:c.visual.lod0.drawCalls,triangles:c.visual.lod0.triangles,glbBytes:c.visual.lod0.bytes,collisionTriangles:c.collision.triangles})),totals:{...report.totals,cells:index.cells.length,drawCalls:index.cells.reduce((n:number,c:CellDescriptor)=>n+c.visual.lod0.drawCalls,0)},budgets:{...report.budgets,runtimeResidencyVerification:'REQUIRED: final patched candidate traversal'}};
  for(const r of receipts)assert.equal(sha(fs.readFileSync(r.file)),r.sha256);assert.equal(sha(fs.readFileSync(path.join(base,'cells.json'))),sha(indexBytes));write('cells.json',Buffer.from(JSON.stringify(index,null,1)+'\n'));write('report.json',Buffer.from(JSON.stringify(nextReport,null,1)+'\n'));write('ground-region-patch.json',Buffer.from(JSON.stringify(patch,null,2)+'\n'));
  return{status:'PASS_SOURCE_GROUND_PATCH_RUNTIME_PENDING',cells:proof.length,loweredSafetySamples:lowered.length,indexSha256:sha(fs.readFileSync(path.join(out,'cells.json')))};
}
