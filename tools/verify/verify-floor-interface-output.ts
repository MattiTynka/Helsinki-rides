// Independent read-only output proof for plan_floor_interfaces → sealer. Run
// before a later authored-facade draw partition changes the coarse index list.
import assert from 'node:assert/strict';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {createHash} from 'node:crypto';
import {NodeIO,type Document,type Node,type Primitive} from '@gltf-transform/core';
import {ALL_EXTENSIONS} from '@gltf-transform/extensions';
import {MeshoptDecoder} from 'meshoptimizer';
import {parseCollisionBundle,type CellDescriptor,type FileRef} from '../../packages/world-schema/src/index.ts';
import {meshVerticalSeals} from '../world/lib/vertical-seal-mesh.ts';
import {readFacadeGlb} from '../world/lib/facade-glb.ts';

type Point=readonly [number,number,number];
interface Pack {cell:string;name:string;positions:ArrayLike<number>;indices:ArrayLike<number>}
interface Ray {pixel:number[];origin:Point;direction:Point;hits?:Record<string,unknown>}
interface Hit {cell:string;name:string;triangle:number;distance:number;point:number[]}
const {values}=parseArgs({options:{plan:{type:'string'},cells:{type:'string'},rays:{type:'string'},out:{type:'string'}}});
assert.ok(values.plan&&values.cells&&values.rays&&values.out&&!existsSync(values.out),'--plan --cells --rays and fresh --out required');
const read=(p:string)=>readFileSync(p),sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex'),json=(p:string)=>JSON.parse(read(p).toString('utf8'));
const planBytes=read(values.plan),plan=json(values.plan),base=path.dirname(plan.baseCellsIndex),cells=path.resolve(values.cells),indexBytes=read(path.join(cells,'cells.json'));
const oldIndex=json(plan.baseCellsIndex) as {cells:CellDescriptor[]},index=JSON.parse(indexBytes.toString()) as {cells:CellDescriptor[]},raysBytes=read(values.rays),reference=JSON.parse(raysBytes.toString());
assert.equal(sha(read(plan.baseCellsIndex)),plan.baseCellsIndexSha256);assert.equal(sha(read(path.join(base,'report.json'))),plan.sourceBuildReportSha256);assert.equal(sha(read(plan.helper)),plan.helperSha256);
assert.equal(plan.visualBinding.rejectedSeals,0);assert.equal(plan.visualBinding.matchedTriangles,plan.visualBinding.uniqueHcolTriangles);
assert.ok(!json(path.join(cells,'report.json')).facadeCharts,'Run strict coarse-index-prefix proof before the authored facade drawing partition');
const view=reference.views.find((v:any)=>v.rows.some((r:any)=>r.kind==='sky-pixel'));assert.ok(view,'No sky pixel view supplied');
const rays:Ray[]=view.rows.filter((r:any)=>r.kind==='sky-pixel');assert.ok(rays.length>0);for(const r of rays){assert.ok(r.origin.length===3&&r.direction.length===3&&[...r.origin,...r.direction].every(Number.isFinite));assert.ok(!r.hits?.visual&&!r.hits?.visualDoubleSided&&!r.hits?.hcol,'Reference is not an old source-miss control');}
const rayCells=new Set<string>((reference.files??[]).flatMap((f:any)=>{const m=path.basename(f.file).match(/^(c_[pm]\d+_[pm]\d+)\.lod0\.glb$/);return m?[m[1]!]:[];}));assert.ok(rayCells.size>0,'Reference must bind its old visual domain');
await MeshoptDecoder.ready;const io=new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.decoder':MeshoptDecoder});
const issues:{cell?:string;message:string}[]=[],checks:any[]=[],controls=rays.map(r=>({pixel:r.pixel,origin:r.origin,direction:r.direction,oldVisual:null as Hit|null,oldVisualDouble:null as Hit|null,oldHcol:null as Hit|null,planned:null as Hit|null,lod0:null as Hit|null,lod2:null as Hit|null,hcol:null as Hit|null}));
let maximumRssMiB=0,plannedTriangles=0,actualTriangles=0;
const canonical=(p:readonly Point[])=>[0,1,2].map(i=>[p[i],p[(i+1)%3],p[(i+2)%3]].map(v=>v!.map(Math.fround).join(',')).join('|')).sort()[0]!;
function triangle(pack:Pack,j:number):[Point,Point,Point]{return[0,1,2].map(k=>[0,1,2].map(a=>Math.fround(pack.positions[pack.indices[j+k]!*3+a]!)) as unknown as Point) as [Point,Point,Point];}
function multiset(packs:readonly Pack[],vertical=true){const result=new Map<string,number>();for(const p of packs)for(let j=0;j<p.indices.length;j+=3){const t=triangle(p,j),[a,b,c]=t,u=b.map((x,k)=>x-a[k]!),v=c.map((x,k)=>x-a[k]!),n=[u[1]!*v[2]!-u[2]!*v[1]!,u[2]!*v[0]!-u[0]!*v[2]!,u[0]!*v[1]!-u[1]!*v[0]!];assert.ok(Math.hypot(...n)>0,'Actual appended triangle collapsed');if(vertical)assert.ok(n[1]===0,'Actual appended Float32 triangle is not exactly vertical');const key=canonical(t);result.set(key,(result.get(key)??0)+1);}return result;}
function equalSets(expected:Map<string,number>,actual:Map<string,number>,label:string){assert.equal(actual.size,expected.size,`${label}: unique triangle count mismatch`);for(const[k,n]of expected)assert.equal(actual.get(k),n,`${label}: coordinate/winding multiplicity mismatch ${k}`);}
function packPrimitive(node:Node,p:Primitive,cell:string,indices?:ArrayLike<number>):Pack{
  const P=p.getAttribute('POSITION')!,M=node.getWorldMatrix(),positions=new Float32Array(P.getCount()*3);for(let i=0;i<P.getCount();i++){const v=P.getElement(i,[]);for(let a=0;a<3;a++)positions[i*3+a]=M[a]!*v[0]!+M[a+4]!*v[1]!+M[a+8]!*v[2]!+M[a+12]!;}
  return{cell,name:node.getName(),positions,indices:indices??p.getIndices()!.getArray()!};
}
/** Möller–Trumbore with the same front/back distinction as the renderer. */
function hit(pack:Pack,ray:Ray,front:boolean):Hit|null{let nearest:Hit|null=null;const O=ray.origin,D=ray.direction;
  for(let j=0;j<pack.indices.length;j+=3){const[a,b,c]=triangle(pack,j),e1=b.map((x,k)=>x-a[k]!),e2=c.map((x,k)=>x-a[k]!),p=[D[1]*e2[2]!-D[2]*e2[1]!,D[2]*e2[0]!-D[0]*e2[2]!,D[0]*e2[1]!-D[1]*e2[0]!],det=e1.reduce((s,x,k)=>s+x*p[k]!,0);
    if(front?det<=0:det===0)continue;const inv=1/det,T=O.map((x,k)=>x-a[k]!),u=T.reduce((s,x,k)=>s+x*p[k]!,0)*inv;if(u<0||u>1)continue;const q=[T[1]!*e1[2]!-T[2]!*e1[1]!,T[2]!*e1[0]!-T[0]!*e1[2]!,T[0]!*e1[1]!-T[1]!*e1[0]!],v=D.reduce((s,x,k)=>s+x*q[k]!,0)*inv;if(v<0||u+v>1)continue;const distance=e2.reduce((s,x,k)=>s+x*q[k]!,0)*inv;
    if(distance<0||distance>200||nearest&&distance>=nearest.distance)continue;nearest={cell:pack.cell,name:pack.name,triangle:j/3,distance,point:O.map((x,k)=>x+D[k]!*distance)};
  }return nearest;
}
function update(kind:'oldVisual'|'oldVisualDouble'|'oldHcol'|'planned'|'lod0'|'lod2'|'hcol',packs:readonly Pack[],front:boolean){for(let i=0;i<rays.length;i++)for(const pack of packs){const h=hit(pack,rays[i]!,front);if(h&&(!controls[i]![kind]||h.distance<controls[i]![kind]!.distance))controls[i]![kind]=h;}}
function oldRayDocument(doc:Document,cell:string){const packs:Pack[]=[];for(const n of doc.getRoot().listNodes())for(const p of n.getMesh()?.listPrimitives()??[]){assert.ok(p.getIndices()&&p.getMode()===4);packs.push(packPrimitive(n,p,cell));}update('oldVisual',packs,true);update('oldVisualDouble',packs,false);}
function visualGrowth(before:Document,after:Document,cell:string,tier:'lod0'|'lod2'){
  const packs:Pack[]=[];assert.equal(after.getRoot().listNodes().length,before.getRoot().listNodes().length);
  for(const node of before.getRoot().listNodes()){
    const matches=after.getRoot().listNodes().filter(n=>n.getName()===node.getName());assert.equal(matches.length,1);const next=matches[0]!;assert.deepEqual(next.getMatrix(),node.getMatrix());const mesh=node.getMesh();if(!mesh)continue;assert.equal(next.getMesh()!.listPrimitives().length,mesh.listPrimitives().length);
    for(const[pi,p]of mesh.listPrimitives().entries()){
      const q=next.getMesh()!.listPrimitives()[pi]!;assert.deepEqual(q.listSemantics(),p.listSemantics());const ground=tier==='lod2'||node.getName().includes('_ground_');
      for(const s of p.listSemantics()){const a=p.getAttribute(s)!,b=q.getAttribute(s)!;assert.equal(a.getType(),b.getType());assert.equal(a.getComponentType(),b.getComponentType());assert.equal(a.getNormalized(),b.getNormalized());assert.deepEqual(b.getArray()!.subarray(0,a.getArray()!.length),a.getArray()!,'Old attribute prefix changed');if(!ground)assert.equal(b.getCount(),a.getCount(),'Non-ground attribute grew');}
      const a=p.getIndices()!,b=q.getIndices()!;assert.deepEqual(Array.from(b.getArray()!.subarray(0,a.getCount())),Array.from(a.getArray()!),'Old index prefix changed');
      if(b.getCount()!==a.getCount()){assert.ok(ground,'Only ground may grow');packs.push(packPrimitive(next,q,cell,b.getArray()!.slice(a.getCount())));}else for(const s of p.listSemantics())assert.equal(q.getAttribute(s)!.getCount(),p.getAttribute(s)!.getCount(),'Unused vertices appended without faces');
    }
  }return packs;
}
function payload(dir:string,ref:FileRef){const b=read(path.join(dir,ref.path));assert.equal(sha(b),ref.sha256,'Payload hash mismatch');assert.equal(b.length,ref.bytes);return b;}

// Replay the old negative control independently of candidate errors. A failed
// per-cell comparison must not accidentally stand in for an unexecuted ray.
const replayedOldCells:string[]=[];
for(const id of rayCells){const cell=oldIndex.cells.find(c=>c.id===id);assert.ok(cell,'Recorded old ray domain is outside the base index');
  oldRayDocument(await io.readBinary(payload(base,cell.visual.lod0)),id);
  const bundle=parseCollisionBundle(payload(base,cell.collision));update('oldHcol',bundle.colliders.map(c=>({cell:id,name:c.id,positions:c.positions,indices:c.indices})),false);replayedOldCells.push(id);global.gc?.();maximumRssMiB=Math.max(maximumRssMiB,process.memoryUsage().rss/2**20);assert.ok(maximumRssMiB<500,'CPU verifier exceeded 500 MiB bound');
}
assert.deepEqual(index.cells.map(c=>c.id),oldIndex.cells.map(c=>c.id),'Cell order changed');
for(const old of oldIndex.cells){const next=index.cells.find(c=>c.id===old.id)!;const row=plan.rows.find((r:any)=>r.cell===old.id);assert.ok(row,'Missing cell authority row');
  try{
    let seals:any[]=[],receipt:any=null;
    if(row.seals){const b=read(row.receipt);assert.equal(sha(b),row.sha256);receipt=JSON.parse(b.toString());assert.equal(receipt.cell,old.id);assert.equal(receipt.seals.length,row.seals);assert.equal(receipt.visualBinding.bindings.length,row.visualBinding.uniqueTriangles);assert.equal(receipt.visualBinding.rejected.length,0);assert.equal(receipt.collisionSha256,old.collision.sha256);assert.equal(receipt.visualLod0.sha256,old.visual.lod0.sha256);assert.equal(receipt.visualLod2.sha256,old.visual.lod2!.sha256);seals=receipt.seals;}
    const mesh=meshVerticalSeals(seals),expected:Pack={cell:old.id,name:'planned vertical station domain',positions:Float32Array.from(mesh.positions),indices:mesh.indices},expectedSet=multiset([expected]);plannedTriangles+=mesh.indices.length/3;update('planned',[expected],true);
    const check:any={cell:old.id,seals:row.seals,receiptSha256:row.sha256,plannedTriangles:mesh.indices.length/3,verticalMeshStats:mesh.stats};
    for(const tier of ['lod0','lod2'] as const){assert.ok(old.visual[tier]&&next.visual[tier]);const ob=payload(base,old.visual[tier]!),nb=payload(cells,next.visual[tier]!);const a=readFacadeGlb(ob),b=readFacadeGlb(nb);assert.deepEqual(b.bin.subarray(0,a.bin.length),a.bin,'Old physical BIN prefix changed');
      if(sha(ob)===sha(nb)){assert.equal(mesh.indices.length,0,'Candidate lacks planned faces');check[tier]={unchanged:true,appendedTriangles:0};continue;}
      const before=await io.readBinary(ob),after=await io.readBinary(nb);
      const additions=visualGrowth(before,after,old.id,tier),actual=multiset(additions);equalSets(expectedSet,actual,`${old.id}/${tier}`);update(tier,additions,true);check[tier]={sourceSha256:old.visual[tier]!.sha256,outputSha256:next.visual[tier]!.sha256,appendedTriangles:additions.reduce((s,p)=>s+p.indices.length/3,0),oldAttributeIndexAndPhysicalBinPrefixesExact:true,exactCoordinateWindingMultiset:true};
    }
    const ob=payload(base,old.collision),nb=payload(cells,next.collision),a=parseCollisionBundle(ob),b=parseCollisionBundle(nb);assert.equal(a.colliders.length,b.colliders.length);assert.equal(a.header.originId,b.header.originId);assert.equal(a.header.frame,b.header.frame);assert.equal(a.header.cell,b.header.cell);assert.deepEqual(a.header.surfaceTags,b.header.surfaceTags);
    const additions:Pack[]=[];let appendedTagCount=0;
    for(let k=0;k<a.colliders.length;k++){const x=a.colliders[k]!,y=b.colliders[k]!;assert.equal(x.id,y.id);assert.equal(x.group,y.group);assert.equal(x.ref,y.ref);for(const f of ['positions','indices','triangleTags'] as const)assert.deepEqual(y[f].subarray(0,x[f].length),x[f]);
      if(y.indices.length>x.indices.length){assert.equal(x.id,`g:${old.id}`);assert.equal(y.triangleTags.length-x.triangleTags.length,(y.indices.length-x.indices.length)/3);for(const tag of y.triangleTags.subarray(x.triangleTags.length))assert.equal(b.header.surfaceTags[tag],'wall','Appended floor seam tag changed');appendedTagCount+=y.triangleTags.length-x.triangleTags.length;additions.push({cell:old.id,name:y.id,positions:y.positions,indices:y.indices.slice(x.indices.length)});}else for(const f of ['positions','indices','triangleTags'] as const)assert.equal(y[f].length,x[f].length);
    }
    equalSets(expectedSet,multiset(additions),`${old.id}/HCOL`);update('hcol',additions,false);actualTriangles+=appendedTagCount;check.hcol={sourceSha256:old.collision.sha256,outputSha256:next.collision.sha256,appendedTriangles:appendedTagCount,itemCountOrderTagsAndArrayPrefixesExact:true,exactCoordinateWindingMultiset:true};checks.push(check);
  }catch(error){issues.push({cell:old.id,message:error instanceof Error?error.message:String(error)});}
  global.gc?.();maximumRssMiB=Math.max(maximumRssMiB,process.memoryUsage().rss/2**20);assert.ok(maximumRssMiB<500,'CPU verifier exceeded 500 MiB bound');
}
for(const c of controls){if(c.oldVisual||c.oldVisualDouble||c.oldHcol)issues.push({message:`Reference pixel ${c.pixel} no longer reproduces the old source miss`});
  for(const tier of ['planned','lod0','lod2','hcol'] as const)if(!c[tier])issues.push({message:`Pixel ${c.pixel} remains open in ${tier}`});
  if(c.planned)for(const tier of ['lod0','lod2','hcol'] as const)if(c[tier]&&Math.abs(c[tier]!.distance-c.planned.distance)>.0002)issues.push({message:`Pixel ${c.pixel}/${tier} hits a different remote face`});
}
const result={schemaVersion:1,status:issues.length?'FAIL':'PASS_ACTUAL_COMPRESSED_FLOOR_CLOSURE_CPU_ONLY',scope:'All plan rows: actual Float32 coordinate/winding multisets and strict old accessor/index/physical BIN prefixes; exact vertical added faces; HCOL item order/tags/prefixes. Same recorded source-miss pixel rays (200m, recorded old visual domain) hit actual compressed appended LOD0/front, LOD2/front and HCOL faces. Native visual, movement and memory acceptance remains required.',
  source:{plan:values.plan,planSha256:sha(planBytes),baseCellsIndexSha256:plan.baseCellsIndexSha256,cells,indexSha256:sha(indexBytes),rays:values.rays,raysSha256:sha(raysBytes),helperSha256:plan.helperSha256,verticalMesherSha256:sha(read('tools/world/lib/vertical-seal-mesh.ts')),verifierSha256:sha(read(import.meta.filename))},
  counts:{rows:plan.rows.length,checkedCells:checks.length,plannedTriangles,actualHcolTriangles:actualTriangles,rays:rays.length,issues:issues.length},replayedOldCells,checks,controls,issues,maximumRssMiB};
writeFileSync(values.out,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({out:values.out,sha256:sha(read(values.out)),status:result.status,counts:result.counts,maximumRssMiB}));if(issues.length)process.exitCode=1;
