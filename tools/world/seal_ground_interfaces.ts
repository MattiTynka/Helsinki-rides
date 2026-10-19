// Reproducible post-build closure of source-qualified vertical ground gaps.
// The authority reports are read-only selections bound to the input payloads.
// This tool creates a fresh build; it never changes a published/hardlinked input.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
import {NodeIO,type Primitive} from '@gltf-transform/core';
import {ALL_EXTENSIONS} from '@gltf-transform/extensions';
import {MeshoptDecoder} from 'meshoptimizer';
import {parseCollisionBundle,encodeCollisionBundle} from '../../packages/world-schema/src/index.ts';
import {appendGroundGlb,type GroundGlbAppend} from './lib/append-ground-glb.ts';
import {readFacadeGlb} from './lib/facade-glb.ts';
import {meshVerticalSeals} from './lib/vertical-seal-mesh.ts';
import {selectCoarseGroundCorrespondence} from './lib/ground-seal-colour.ts';

const {values}=parseArgs({options:{cells:{type:'string'},coast:{type:'string'},interfaces:{type:'string'},floors:{type:'string'},out:{type:'string'}}});
assert.ok(values.cells&&values.out&&(values.coast||values.interfaces||values.floors),'--cells --out and at least one of --coast --interfaces --floors required');
const base=path.resolve(values.cells),out=path.resolve(values.out);assert.ok(!fs.existsSync(out),'Fresh output required');
const sha=(b:Uint8Array|string)=>createHash('sha256').update(b).digest('hex'),read=(p:string)=>fs.readFileSync(p),json=(p:string)=>JSON.parse(read(p).toString());
const index=json(path.join(base,'cells.json')),coast=values.coast?json(values.coast):null;
if(coast){assert.equal(coast.candidate.sha256,sha(read(path.join(base,'cells.json'))),'Coast selection input mismatch');for(const source of coast.sources)assert.equal(sha(read(source.file)),source.sha256,`Coast source drift: ${source.file}`);}
const plans=[['interface',values.interfaces],['floor',values.floors]].flatMap(([kind,file])=>file?[{kind,file,plan:json(file)}]:[]);
for(const{plan}of plans){
  assert.equal(plan.baseCellsIndexSha256,sha(read(path.join(base,'cells.json'))),'Interface selection input mismatch');
  assert.equal(sha(read(plan.helper)),plan.helperSha256,'Qualifier changed after selection');
  assert.equal(sha(read(path.join(base,'report.json'))),plan.sourceBuildReportSha256,'Source report changed');
  assert.equal(plan.visualBinding.matchedTriangles,plan.visualBinding.uniqueHcolTriangles,'Incomplete visual binding');
  assert.equal(plan.visualBinding.rejectedSeals,0,'Nonvisual interfaces require a separately filtered plan');
  const sources=new Map<string,string>();
  for(const source of [...(plan.producerSources??[]),...(Array.isArray(plan.inputs)?plan.inputs:[])]){
    assert.ok(typeof source.file==='string'&&/^[a-f0-9]{64}$/.test(source.sha256),'Invalid authority source binding');
    if(sources.has(source.file))assert.equal(sources.get(source.file),source.sha256,'Conflicting authority source hashes');
    sources.set(source.file,source.sha256);
  }
  for(const[file,expected]of sources)assert.equal(sha(read(file)),expected,`Authority source changed after selection: ${file}`);
}
const byCell=new Map<string,any[]>();for(const seal of coast?.seals??[]){const s={...seal,kind:'coast'},list=byCell.get(s.cell)??[];list.push(s);byCell.set(s.cell,list);}
const plannedRows=plans.flatMap(({kind,plan})=>plan.rows.map((row:any)=>({kind,row})));
const affectedCells=new Set([...byCell.keys(),...plannedRows.filter(({row})=>row.seals>0).map(({row})=>row.cell)]);let selectedCount=0;
await MeshoptDecoder.ready;const io=new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.decoder':MeshoptDecoder});
const changed=new Map<string,Uint8Array>(),checks:any[]=[];
function growth(p:Primitive,nodeName:string,points:number[],newIndices:number[],colours?:number[],primitiveIndex=0):GroundGlbAppend {
  const count=p.getAttribute('POSITION')!.getCount(),attributes:Record<string,any>={};
  const normals:number[]=[],uv:number[]=[];
  for(let i=0;i<points.length;i+=9){const a=points.slice(i,i+3),b=points.slice(i+3,i+6),c=points.slice(i+6,i+9),u=b.map((v,k)=>v-a[k]!),v=c.map((x,k)=>x-a[k]!),n=[u[1]!*v[2]!-u[2]!*v[1]!,u[2]!*v[0]!-u[0]!*v[2]!,u[0]!*v[1]!-u[1]!*v[0]!],L=Math.hypot(...n);assert.ok(L>0);for(let k=0;k<3;k++)normals.push(...n.map(x=>x/L));}
  for(let i=0;i<points.length;i+=3)uv.push(points[i]!/3,points[i+1]!/3);
  for(const semantic of p.listSemantics()){
    const a=p.getAttribute(semantic)!,original=a.getArray()!;let appended:number[];
    if(semantic==='POSITION')appended=points;
    else if(semantic==='TEXCOORD_0'){assert.equal(a.getComponentType(),5126);appended=uv;}
    else if(semantic==='NORMAL'){
      const scale=a.getNormalized()?(a.getComponentType()===5120?127:a.getComponentType()===5122?32767:NaN):1;assert.ok(Number.isFinite(scale));appended=normals.map(x=>scale===1?x:Math.round(x*scale));
    }else if(semantic==='COLOR_0'){assert.ok(colours);assert.equal(a.getComponentType(),5126);appended=colours;}
    else throw Error(`Unsupported ground attribute ${semantic}`);
    attributes[semantic]={original,appended};
  }
  return{nodeName,primitiveIndex,attributes,indices:{original:p.getIndices()!.getArray()! as any,appended:newIndices.map(i=>i+count)}};
}
function quad(s:any,positions:number[],indices:number[]){
  const p:number[][]=[s.top[0],s.top[1],s.bottom[1],s.bottom[0]].map((a:number[])=>a.map(Math.fround));
  const oldLength=indices.length;
  for(const back of [false,true]){const first=positions.length/3,vertices=back?[p[1]!,p[0]!,p[3]!,p[2]!]:p;positions.push(...vertices.flat());
    for(const tri of [[0,1,2],[0,2,3]]){const [a,b,c]=tri.map(i=>vertices[i]!) as [number[],number[],number[]],u=b.map((v,i)=>v-a[i]!),v=c.map((x,i)=>x-a[i]!);if(Math.hypot(u[1]!*v[2]!-u[2]!*v[1]!,u[2]!*v[0]!-u[0]!*v[2]!,u[0]!*v[1]!-u[1]!*v[0]!)>0)indices.push(...tri.map(i=>first+i));}
  }return(indices.length-oldLength)/3;
}
function appendSeal(s:any,positions:number[],indices:number[]){
  const source=s.kind==='coast'?{positions:[] as number[],indices:[] as number[]}:meshVerticalSeals([s]);
  if(s.kind==='coast')quad(s,source.positions,source.indices);
  let triangles=0;
  for(let i=0;i<source.indices.length;i+=3){const p=source.indices.slice(i,i+3).map(id=>source.positions.slice(id*3,id*3+3).map(Math.fround)),[a,b,c]=p as [number[],number[],number[]],u=b.map((x,k)=>x-a[k]!),v=c.map((x,k)=>x-a[k]!);
    assert.ok((u[2]! * v[0]! - u[0]! * v[2]!) === 0,'Added Float32 triangles must stay exactly vertical');
    if(Math.hypot(u[1]!*v[2]!-u[2]!*v[1]!,u[0]!*v[1]!-u[1]!*v[0]!)===0)continue;
    const first=positions.length/3;positions.push(...p.flat());indices.push(first,first+1,first+2);triangles++;
  }return triangles;
}
for(const cell of index.cells){
  const seals=[...(byCell.get(cell.id)??[])];
  for(const {kind,row}of plannedRows.filter(({row})=>row.cell===cell.id&&row.seals>0)){const rb=read(row.receipt);assert.equal(sha(rb),row.sha256,'Interface receipt hash mismatch');const r=JSON.parse(rb.toString());assert.equal(r.seals.length,row.seals);assert.equal(r.visualBinding.bindings.length,row.visualBinding.uniqueTriangles);assert.equal(r.visualBinding.rejected.length,0);seals.push(...r.seals.map((s:any)=>({...s,kind,inputs:{collision:{sha256:r.collisionSha256},visual:r.visualLod0,coarse:r.visualLod2}})));}
  if(!seals.length)continue;selectedCount+=seals.length;
  const vb=read(path.join(base,cell.visual.lod0.path)),cb=read(path.join(base,cell.collision.path)),lb=read(path.join(base,cell.visual.lod2.path));
  assert.equal(sha(vb),cell.visual.lod0.sha256);assert.equal(sha(cb),cell.collision.sha256);assert.equal(sha(lb),cell.visual.lod2.sha256);
  for(const s of seals){assert.equal(s.inputs.visual.sha256,sha(vb));assert.equal(s.inputs.collision.sha256,sha(cb));if(s.inputs.coarse)assert.equal(s.inputs.coarse.sha256,sha(lb));}
  const doc=await io.readBinary(vb),coarseDoc=await io.readBinary(lb),bundle=parseCollisionBundle(cb);
  const groundNodes=doc.getRoot().listNodes().filter(n=>n.getName().includes('_ground_'));
  const target=groundNodes.find(n=>n.getName().endsWith('_ground_slabs'))??groundNodes.find(n=>n.getName().endsWith('_ground_setts'))??groundNodes.find(n=>n.getName().endsWith('_ground_cobble'))??groundNodes[0];assert.ok(target,'Existing ground finish required');
  assert.deepEqual(target.getWorldMatrix(),[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);assert.equal(target.getMesh()!.listPrimitives().length,1);
  const p=target.getMesh()!.listPrimitives()[0]!,correspondence=selectCoarseGroundCorrespondence(p,coarseDoc,`${cell.id}/${target.getName()}`),lp=correspondence.primitive,available=correspondence.samples;
  const positions:number[]=[],indices:number[]=[],colours:number[]=[],tags:number[]=[];
  const ground=bundle.colliders.find(c=>c.id===`g:${cell.id}`&&c.group==='ground');assert.ok(ground);
  for(const s of seals){
    const midpoint=s.top[0].map((v:number,i:number)=>(v+s.top[1][i])/2);
    let nearest=available[0]!,distance=Infinity;for(const a of available){const d=a.point.reduce((n,v,i)=>n+(v-midpoint[i])**2,0);if(d<distance){distance=d;nearest=a;}}
    const before=positions.length/3,triangles=appendSeal(s,positions,indices);for(let i=before;i<positions.length/3;i++)colours.push(...nearest.colour);
    const tagName=s.kind==='coast'?'wall':s.sideTag;const tag=bundle.header.surfaceTags.indexOf(tagName);assert.ok(tag>=0,`Missing existing tag ${tagName}`);tags.push(...Array(triangles).fill(tag));
  }
  const vnew=await appendGroundGlb(vb,[growth(p,target.getName(),positions,indices)]),lnew=await appendGroundGlb(lb,[growth(lp,correspondence.nodeName,positions,indices,colours,correspondence.primitiveIndex)]);
  const newPositions=new Float32Array(ground.positions.length+positions.length);newPositions.set(ground.positions);newPositions.set(positions,ground.positions.length);
  const newIndices=new Uint32Array(ground.indices.length+indices.length);newIndices.set(ground.indices);newIndices.set(indices.map(i=>i+ground.positions.length/3),ground.indices.length);
  const newTags=new Uint16Array(ground.triangleTags.length+tags.length);newTags.set(ground.triangleTags);newTags.set(tags,ground.triangleTags.length);
  const colliders=bundle.colliders.map(c=>c===ground?{...c,positions:newPositions,indices:newIndices,triangleTags:newTags}:c);
  const cnew=encodeCollisionBundle({originId:bundle.header.originId,frame:bundle.header.frame,cell:bundle.header.cell,surfaceTags:bundle.header.surfaceTags},colliders);
  const parsed=parseCollisionBundle(cnew);assert.equal(parsed.colliders.length,bundle.colliders.length);
  for(let i=0;i<bundle.colliders.length;i++){const old=bundle.colliders[i]!,next=parsed.colliders[i]!;assert.equal(next.id,old.id);for(const key of ['positions','indices','triangleTags'] as const)assert.deepEqual(next[key].subarray(0,old[key].length),old[key]);}
  // Decode actual compressed outputs and compare every old accessor prefix,
  // including untouched buildings/materials/textures and the complete coarse tier.
  for(const [before,after,nodeName]of [[doc,await io.readBinary(vnew),target.getName()],[coarseDoc,await io.readBinary(lnew),correspondence.nodeName]] as const){
    assert.equal(after.getRoot().listTextures().length,before.getRoot().listTextures().length);assert.equal(after.getRoot().listMaterials().length,before.getRoot().listMaterials().length);
    for(const node of before.getRoot().listNodes()){const next=after.getRoot().listNodes().find(n=>n.getName()===node.getName())!;assert.deepEqual(next.getMatrix(),node.getMatrix());if(!node.getMesh())continue;
      for(const [pi,old]of node.getMesh()!.listPrimitives().entries()){const np=next.getMesh()!.listPrimitives()[pi]!;
        for(const a of [...old.listSemantics(),'indices']){const aa=(a==='indices'?old.getIndices():old.getAttribute(a))!.getArray()!,bb=(a==='indices'?np.getIndices():np.getAttribute(a))!.getArray()!;assert.deepEqual(Array.from(bb.subarray(0,aa.length)),Array.from(aa));if(node.getName()!==nodeName)assert.equal(bb.length,aa.length);}
      }
    }
  }
  const originalRaw=readFacadeGlb(vb),newRaw=readFacadeGlb(vnew);assert.deepEqual(newRaw.bin.subarray(0,originalRaw.bin.length),originalRaw.bin);
  for(const [descriptor,bytes]of [[cell.visual.lod0,vnew],[cell.visual.lod2,lnew],[cell.collision,cnew]] as const){changed.set(descriptor.path,bytes);descriptor.sha256=sha(bytes);descriptor.bytes=bytes.length;descriptor.triangles+=indices.length/3;}
  checks.push({cell:cell.id,seals:seals.length,coast:seals.filter(s=>s.kind==='coast').length,interfaces:seals.filter(s=>s.kind==='interface').length,floors:seals.filter(s=>s.kind==='floor').length,targetPrimitive:target.getName(),coarseColourSourceNode:correspondence.nodeName,coarseColourSourcePrimitive:correspondence.primitiveIndex,coarseColourMatchedTriangles:correspondence.matchedTriangles,coarseColourSamples:available.length,addedTriangles:indices.length/3,colliderItems:colliders.length,originalArraysAndPhysicalGlbPrefixPreserved:true});
  global.gc?.();if(checks.length%20===0)console.log(JSON.stringify({cells:checks.length,rssMiB:process.memoryUsage().rss/2**20}));
}
assert.equal(checks.length,affectedCells.size,'Missing selected cell');fs.mkdirSync(out,{recursive:true});
function copy(directory:string,prefix=''){for(const entry of fs.readdirSync(directory,{withFileTypes:true})){const rel=path.posix.join(prefix,entry.name),destination=path.join(out,rel),source=path.join(directory,entry.name);if(entry.isDirectory()){fs.mkdirSync(destination);copy(source,rel);}else if(changed.has(rel))fs.writeFileSync(destination,changed.get(rel)!,{flag:'wx'});else if(['cells.json','report.json','vertical-ground-closure.json'].includes(rel))continue;else fs.linkSync(source,destination);}}
copy(base);fs.writeFileSync(path.join(out,'cells.json'),JSON.stringify(index,null,1)+'\n',{flag:'wx'});
const report=json(path.join(base,'report.json')),parent=report.verticalGroundClosure??null;
report.verticalGroundClosure={parent,sourceCellsSha256:sha(read(path.join(base,'cells.json'))),coastalAuthority:values.coast?{path:values.coast,sha256:sha(read(values.coast))}:null,interfaceAuthorities:plans.map(({kind,file})=>({kind,path:file,sha256:sha(read(file!))})),toolSha256:sha(read(import.meta.filename)),checks};
fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,1)+'\n',{flag:'wx'});
const proof={schemaVersion:1,status:'PASS_APPEND_ONLY_STATIC_PROOF_RUNTIME_REVIEW_PENDING',base,out,sourceIndexSha256:sha(read(path.join(base,'cells.json'))),indexSha256:sha(read(path.join(out,'cells.json'))),authorities:report.verticalGroundClosure,sourceFiles:['tools/world/seal_ground_interfaces.ts','tools/world/lib/append-ground-glb.ts','tools/world/test/append-ground-glb.test.ts','tools/world/lib/vertical-seal-mesh.ts','tools/world/test/vertical-seal-mesh.test.ts','tools/world/lib/ground-seal-colour.ts','tools/world/test/ground-seal-colour.test.ts'].map(file=>({file,sha256:sha(read(file))})),changedPayloads:[...changed].map(([file,bytes])=>({file,bytes:bytes.length,sha256:sha(bytes)})),checks,limitations:['Added exactly vertical Float32 faces only; no existing floors or building geometry moves.','Qualifiers explicitly withhold ambiguous or protected interfaces; see authority reports.','Actual compressed runtime views, traversal and resource gates remain required.']};
fs.writeFileSync(path.join(out,'vertical-ground-closure.json'),JSON.stringify(proof,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({out,cells:checks.length,seals:selectedCount,addedTriangles:checks.reduce((n,r)=>n+r.addedTriangles,0),changedPayloads:changed.size,indexSha256:proof.indexSha256,rssMiB:process.memoryUsage().rss/2**20}));
