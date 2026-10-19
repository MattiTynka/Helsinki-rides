// Fresh-copy application of a reviewed tram plan. Original source cells are
// never modified, including hardlinked predecessor and published payloads.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
import {fileURLToPath} from 'node:url';
import {NodeIO,type Primitive} from '@gltf-transform/core';
import {ALL_EXTENSIONS} from '@gltf-transform/extensions';
import {MeshoptDecoder} from 'meshoptimizer';
import {appendTramVisualGlb} from './lib/append-tram-glb.ts';
import {readFacadeGlb} from './lib/facade-glb.ts';
import type {TramMesh} from './lib/tram-visuals.ts';
import {tramStripeResidentBytes,tramStripePng} from './lib/tram-texture.ts';

const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
export async function applyTramVisuals(options:{cells:string;plan:string;out:string}){
  const base=path.resolve(options.cells),out=path.resolve(options.out);assert.ok(!fs.existsSync(out),'Tram output must be fresh');
  const outRelative=path.relative(base,out);assert.ok(outRelative==='..'||outRelative.startsWith(`..${path.sep}`)||path.isAbsolute(outRelative),'Tram output must not be nested inside its immutable source candidate');
  const read=(file:string)=>fs.readFileSync(file),json=(file:string)=>JSON.parse(read(file).toString('utf8'));
  const planBytes=read(options.plan),plan=json(options.plan),sourceIndex=read(path.join(base,'cells.json')),index=JSON.parse(sourceIndex.toString('utf8'));
  assert.equal(plan.status,'READY_FOR_ASSET_APPLICATION','Unresolved tram authority or budgets');assert.equal(plan.candidate.sha256,sha(sourceIndex),'Tram authority candidate differs');
  for(const source of [...plan.inputs,...plan.producerSources])assert.equal(sha(read(source.file)),source.sha256,`Tram authority drift:${source.file}`);
  assert.equal(sha(await tramStripePng()),plan.artwork.sha256,'Approved original tram artwork changed');
  assert.ok(plan.rows.length>0);assert.equal(new Set(plan.rows.map((r:any)=>r.cell)).size,plan.rows.length);
  const safe=(relative:string)=>{const file=path.resolve(base,relative),local=path.relative(base,file);assert.ok(local&&!path.isAbsolute(local)&&!local.startsWith('..'),'Candidate path traversal');return file;};
  await MeshoptDecoder.ready;const io=new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.decoder':MeshoptDecoder});
  const changes=new Map<string,Uint8Array>(),checks:any[]=[];
  async function preserve(before:Uint8Array,after:Uint8Array,coarse:boolean){
    const a=readFacadeGlb(before),b=readFacadeGlb(after),j=a.json as any,k=b.json as any;
    assert.deepEqual(b.bin.subarray(0,a.bin.length),a.bin,'Original BIN byte prefix changed');
    for(const key of ['accessors','bufferViews','images','textures','samplers','materials'])assert.deepEqual((k[key]??[]).slice(0,(j[key]??[]).length),j[key]??[],`Original${key} JSON changed`);
    assert.deepEqual(k.nodes.slice(0,j.nodes.length),j.nodes);assert.deepEqual(k.asset,j.asset);
    const old=await io.readBinary(before),next=await io.readBinary(after);
    for(const node of old.getRoot().listNodes()){
      const nn=next.getRoot().listNodes().find(n=>n.getName()===node.getName());assert.ok(nn);assert.deepEqual(nn.getMatrix(),node.getMatrix());if(!node.getMesh())continue;
      for(const[pi,p]of node.getMesh()!.listPrimitives().entries()){
        const q:Primitive=nn.getMesh()!.listPrimitives()[pi]!;assert.deepEqual(q.listSemantics(),p.listSemantics());
        for(const semantic of [...p.listSemantics(),'indices']){const aa=(semantic==='indices'?p.getIndices():p.getAttribute(semantic))!.getArray()!,bb=(semantic==='indices'?q.getIndices():q.getAttribute(semantic))!.getArray()!;
          assert.deepEqual(bb.subarray(0,aa.length),aa,'Original decoded accessor prefix changed');if(!coarse)assert.equal(bb.length,aa.length,'Original detailed primitive grew');}
      }
    }
    assert.equal(next.getRoot().listTextures().length,old.getRoot().listTextures().length+(coarse?0:1));assert.equal(next.getRoot().listMaterials().length,old.getRoot().listMaterials().length+(coarse?0:1));
    return{oldBinBytes:a.bin.length,oldNodes:j.nodes.length,oldAccessors:j.accessors.length,binPrefixExact:true,decodedArrayPrefixesExact:true,oldMaterialsImagesAndTransformsExact:true};
  }
  for(const row of plan.rows){
    const bytes=read(row.receipt);assert.equal(sha(bytes),row.sha256,'Tram cell recipe changed');const receipt=JSON.parse(bytes.toString('utf8')),cell=index.cells.find((c:any)=>c.id===row.cell);assert.ok(cell);assert.equal(receipt.cell,cell.id);
    assert.deepEqual(receipt.inputs.visual,cell.visual);assert.deepEqual(receipt.inputs.collision,cell.collision);
    assert.equal(sha(read(safe(cell.collision.path))),cell.collision.sha256,'HCOL input changed');
    const tiers:any[]=[];
    for(const tier of ['lod0','lod1','lod2'] as const){
      const ref=cell.visual[tier];if(!ref)continue;const coarse=tier==='lod2',mesh:TramMesh=coarse?receipt.coarse:receipt.detail;
      const old=read(safe(ref.path));assert.equal(sha(old),ref.sha256);const next=await appendTramVisualGlb(old,mesh,{cell:cell.id,coarse}),proof=await preserve(old,next,coarse);
      changes.set(ref.path,next);ref.sha256=sha(next);ref.bytes=next.length;ref.triangles+=mesh.indices.length/3;if(!coarse){ref.drawCalls++;ref.atlases++;ref.textureBytesEstimate+=tramStripeResidentBytes();}
      tiers.push({tier,addedTriangles:mesh.indices.length/3,addedDraws:coarse?0:1,...proof});
    }
    checks.push({cell:cell.id,collisionByteExact:true,tiers});global.gc?.();
  }
  // Recheck every manifest payload before copying, including unrelated cells.
  // Copying source files as hardlinks is safe because all later writes use fresh
  // files and neither source payloads nor their descriptors are edited in place.
  const originalIndex=JSON.parse(sourceIndex.toString('utf8'));
  for(const cell of originalIndex.cells)for(const ref of [cell.collision,...Object.values(cell.visual)] as any[])assert.equal(sha(read(safe(ref.path))),ref.sha256,'Source payload changed during application');
  assert.equal(sha(read(path.join(base,'cells.json'))),sha(sourceIndex),'Source index changed during application');
  fs.mkdirSync(out,{recursive:true});
  function copy(directory:string,prefix=''){
    for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
      const rel=path.posix.join(prefix,entry.name),destination=path.join(out,rel),source=path.join(directory,entry.name);
      if(entry.isDirectory()){fs.mkdirSync(destination);copy(source,rel);}else if(changes.has(rel))fs.writeFileSync(destination,changes.get(rel)!,{flag:'wx'});
      else if(!['cells.json','report.json','tram-visuals.json'].includes(rel))fs.linkSync(source,destination);
    }
  }
  copy(base);fs.writeFileSync(path.join(out,'cells.json'),JSON.stringify(index,null,1)+'\n',{flag:'wx'});
  const report=json(path.join(base,'report.json')),parent=report.tramVisuals??null;
  const sources=['./apply_tram_visuals.ts','./lib/append-tram-glb.ts','./lib/tram-texture.ts','./lib/append-ground-glb.ts','./lib/facade-glb.ts'].map(relative=>{const file=fileURLToPath(new URL(relative,import.meta.url));return{file,sha256:sha(read(file))};});
  report.tramVisuals={parent,sourceIndexSha256:sha(sourceIndex),authority:{file:path.resolve(options.plan),sha256:sha(planBytes)},sources,checks};
  if(report.totals){for(const key of ['triangles','drawCalls'])if(typeof report.totals[key]==='number')report.totals[key]+=key==='triangles'?plan.totals.detailedTriangles:plan.rows.length;}
  fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,1)+'\n',{flag:'wx'});
  const proof={schemaVersion:1,status:'PASS_APPEND_ONLY_STATIC_RUNTIME_REVIEW_PENDING',source:base,out,sourceIndexSha256:sha(sourceIndex),indexSha256:sha(read(path.join(out,'cells.json'))),authority:report.tramVisuals.authority,producerSources:sources,totals:plan.totals,checks,unchanged:{allCollisionBytes:true,allTerrainAndSceneryBytes:true,allOldGeometryAttributesAndTriangles:true,allOldImageBytesAndMaterials:true},limitations:['Source track placement is mapped OSM geometry, not an as-built rail survey.','Visual head/groove/guard widths approximate the grooved rail section.','No overhead wires, poles, sleepers or physical rail bumps added.','Final actual runtime captures and unchanged performance gates remain required.']};
  fs.writeFileSync(path.join(out,'tram-visuals.json'),JSON.stringify(proof,null,2)+'\n',{flag:'wx'});return proof;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const{values}=parseArgs({options:{cells:{type:'string'},plan:{type:'string'},out:{type:'string'}}});assert.ok(values.cells&&values.plan&&values.out,'--cells --plan --out required');
  const result=await applyTramVisuals({cells:values.cells,plan:values.plan,out:values.out});console.log(JSON.stringify({status:result.status,indexSha256:result.indexSha256,...result.totals,rssMiB:process.memoryUsage().rss/2**20}));
}
