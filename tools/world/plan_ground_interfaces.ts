// Plan the same source-qualified vertical closure after any fresh cell build.
// No source assets change. Receipts bind actual HCOL triangles to exact decoded
// visual ground before the append-only consumer is allowed to use them.
// node tools/world/plan_ground_interfaces.ts --cells <build> --config <cells.json>
//   --origin <world-origin.json> --street-parts <register.geojson> --out <new-plan.json>
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {createHash} from 'node:crypto';
import {NodeIO} from '@gltf-transform/core';
import {ALL_EXTENSIONS} from '@gltf-transform/extensions';
import {MeshoptDecoder} from 'meshoptimizer';
import {parseCollisionBundle} from '../../packages/world-schema/src/index.ts';
import {findGroundInterfaceSeals,type GroundInterfaceSeal} from './lib/ground-interface-seals.ts';
import {meshVerticalSeals} from './lib/vertical-seal-mesh.ts';
import {loadGeoJsonPolygons,pointInPolygon,ringDistance} from './lib/geometry.ts';

const {values}=parseArgs({options:{cells:{type:'string'},config:{type:'string'},origin:{type:'string'},'street-parts':{type:'string'},out:{type:'string'}}});
for(const k of ['cells','config','origin','street-parts','out'] as const)assert.ok(values[k],`--${k} is required`);
const base=path.resolve(values.cells!),out=path.resolve(values.out!),directory=out+'.cells';
assert.ok(!existsSync(out)&&!existsSync(directory),'Fresh plan and receipt directory required');
assert.ok(out!==base&&!out.startsWith(base+path.sep),'Write plans outside the immutable input cell build');
const sha=(b:Uint8Array|string)=>createHash('sha256').update(b).digest('hex'),read=(p:string)=>readFileSync(p),json=(b:Uint8Array)=>JSON.parse(Buffer.from(b).toString('utf8'));
const indexPath=path.join(base,'cells.json'),ib=read(indexPath),index=json(ib),reportPath=path.join(base,'report.json'),reportBytes=read(reportPath),report=json(reportBytes),configBytes=read(values.config!),config=json(configBytes),originBytes=read(values.origin!),origin=json(originBytes),partsBytes=read(values['street-parts']!);
assert.equal(index.originId,origin.id,'Origin differs from the built cells');assert.equal(report.originId,origin.id,'Origin differs from the source report');
assert.ok(Array.isArray(origin.originProjected)&&origin.originProjected.length===3&&origin.originProjected.every(Number.isFinite),'Invalid projected origin');
assert.equal(report.inputs.streetParts,sha(partsBytes),'Street register differs from the source cell build');
const grade=config.carriagewayGrade,keep=grade?.protectedArea,margin=grade?.protectedMarginMetres??grade?.gridMetres*2;
assert.ok(keep&&[keep.minX,keep.maxX,keep.minZ,keep.maxZ,margin].every(Number.isFinite)&&keep.minX<keep.maxX&&keep.minZ<keep.maxZ&&margin>=0,'An explicit accepted-area/margin policy is required');
if(config.coastal)assert.ok(report.coastal?.mask?.water&&report.coastal?.decks?.polygons,'Coastal builds require their actual source water and deck masks');
const options={protectedArea:{minX:keep.minX-margin,maxX:keep.maxX+margin,minZ:keep.minZ-margin,maxZ:keep.maxZ+margin},waterMasks:report.coastal?.mask?.water??[],registeredDecks:report.coastal?.decks?.polygons??[]};
const [E0,N0]=origin.originProjected,parts=loadGeoJsonPolygons(values['street-parts']!,E0,N0,(p,i)=>String(p['osan_id']??p['id']??i)),helper=fileURLToPath(new URL('./lib/ground-interface-seals.ts',import.meta.url)),helperSha256=sha(read(helper));
await MeshoptDecoder.ready;const io=new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.decoder':MeshoptDecoder});mkdirSync(directory);
const triangleKey=(v:number[][])=>v.map(p=>p.map(Math.fround).join(',')).sort().join('|'),rows:any[]=[];
let maxRssMiB=0,uniqueHcolSides=0,uniqueHcolFloors=0,uniqueHcolTriangles=0,matchedTriangles=0,rejectedSeals=0;
for(const cell of index.cells){
 const cb=read(path.join(base,cell.collision.path)),vb=read(path.join(base,cell.visual.lod0.path));assert.equal(sha(cb),cell.collision.sha256,`${cell.id} HCOL drift`);assert.equal(sha(vb),cell.visual.lod0.sha256,`${cell.id} visual drift`);
 const bundle=parseCollisionBundle(cb),ground=bundle.colliders.filter(c=>c.group==='ground'),sources=ground.map(c=>({id:c.id,cell:cell.id,positions:c.positions,indices:c.indices,triangleTags:Array.from(c.triangleTags,t=>bundle.header.surfaceTags[t]!)})),selected=findGroundInterfaceSeals(sources,options),colliders=new Map(ground.map(c=>[c.id,c]));
 const needed=new Map<string,{key:string;roles:Set<string>;match:any|null}>(),sideIds=new Set<string>(),floorIds=new Set<string>();
 const need=(id:string,triangle:number,role:string)=>{const c=colliders.get(id);assert.ok(c&&triangle>=0&&triangle*3+2<c.indices.length,'Ground triangle reference out of range');const ref=id+':'+triangle;let item=needed.get(ref);if(!item){const vertices=[0,1,2].map(k=>Array.from(c.positions.slice(c.indices[triangle*3+k]!*3,c.indices[triangle*3+k]!*3+3)));item={key:triangleKey(vertices),roles:new Set(),match:null};needed.set(ref,item);}item.roles.add(role);(role==='side'?sideIds:floorIds).add(ref);};
 for(const s of selected.seals){need(s.sourceId,s.sideTriangle,'side');need(s.groundSourceId,s.groundTriangle,'floor');}
 const keys=new Map<string,string[]>();for(const[id,item]of needed){const refs=keys.get(item.key)??[];refs.push(id);keys.set(item.key,refs);}
 if(needed.size){const doc=await io.readBinary(vb);for(const node of doc.getRoot().listNodes()){if(!node.getName().includes('_ground_'))continue;const mesh=node.getMesh();if(!mesh)continue;const M=node.getWorldMatrix();for(const[pi,p]of mesh.listPrimitives().entries()){if(p.getMode()!==4)continue;const P=p.getAttribute('POSITION');if(!P)continue;const I=p.getIndices(),n=I?.getCount()??P.getCount();for(let j=0;j<n;j+=3){const vertices=[0,1,2].map(k=>{const q=P.getElement(I?I.getScalar(j+k):j+k,[]);return[0,1,2].map(a=>Math.fround(M[a]!*q[0]!+M[a+4]!*q[1]!+M[a+8]!*q[2]!+M[a+12]!));}),refs=keys.get(triangleKey(vertices));if(!refs)continue;for(const ref of refs){const item=needed.get(ref)!;if(!item.match)item.match={node:node.getName(),primitive:pi,triangle:j/3,triangleKeySha256:sha(item.key),material:p.getMaterial()?.getName()??null};}}}}}
 const visible=(s:GroundInterfaceSeal)=>Boolean(needed.get(s.sourceId+':'+s.sideTriangle)!.match&&needed.get(s.groundSourceId+':'+s.groundTriangle)!.match);
 const seals=selected.seals.filter(visible).map(s=>{const p:[number,number]=[(s.top[0][0]+s.top[1][0])/2,-(s.top[0][2]+s.top[1][2])/2],near=parts.filter(q=>q.bbox[0]<p[0]+.1&&q.bbox[2]>p[0]-.1&&q.bbox[1]<p[1]+.1&&q.bbox[3]>p[1]-.1);return{...s,sourceParts:near.map(q=>({id:q.id,main:q.properties['paatyyppi'],sub:q.properties['alatyyppi'],name:q.properties['alueen_nimi'],contains:pointInPolygon(p,q.rings),edgeDistance:Math.min(...q.rings.map(r=>ringDistance(p,r)))})).filter(q=>q.contains||q.edgeDistance<.025)};});
 const rejected=selected.seals.filter(s=>!visible(s)).map(s=>({sourceId:s.sourceId,sideTriangle:s.sideTriangle,groundSourceId:s.groundSourceId,groundTriangle:s.groundTriangle,top:s.top,reason:'HCOL triangle absent from exact Float32 visual ground'})),bindings=[...needed].map(([reference,item])=>({reference,roles:[...item.roles],visual:item.match,triangleKeySha256:sha(item.key)})),receipt=path.join(directory,cell.id+'.json');
 const cellPayload={cell:cell.id,collisionSha256:sha(cb),visualLod0:cell.visual.lod0,visualLod2:cell.visual.lod2,seals,rejections:selected.rejections,counts:selected.counts,precisionRetries:selected.precisionRetries,visualBinding:{sourceVisual:cell.visual.lod0,sourceCollision:cell.collision,bindings,rejected}},rb=Buffer.from(JSON.stringify(cellPayload)+'\n');writeFileSync(receipt,rb,{flag:'wx'});const mesh=meshVerticalSeals(seals),matched=[...needed.values()].filter(item=>item.match).length;
 uniqueHcolSides+=sideIds.size;uniqueHcolFloors+=floorIds.size;uniqueHcolTriangles+=needed.size;matchedTriangles+=matched;rejectedSeals+=rejected.length;
 rows.push({cell:cell.id,receipt,sha256:sha(rb),seals:seals.length,lengthMetres:seals.reduce((n,s)=>n+s.length,0),maximumGapMetres:seals.reduce((n,s)=>Math.max(n,...s.gap),0),addedVertices:mesh.positions.length/3,addedTriangles:mesh.indices.length/3,byTag:seals.reduce((o:Record<string,number>,s)=>(o[s.sideTag]=(o[s.sideTag]??0)+1,o),{}),counts:selected.counts,precisionRetries:selected.precisionRetries.length,visualBinding:{uniqueSides:sideIds.size,uniqueFloors:floorIds.size,uniqueTriangles:needed.size,matchedTriangles:matched,rejectedSeals:rejected.length}});
 maxRssMiB=Math.max(maxRssMiB,process.memoryUsage().rss/2**20);global.gc?.();if(rows.length%25===0)console.log(JSON.stringify({cells:rows.length,seals:rows.reduce((n,r)=>n+r.seals,0),maxRssMiB}));
}
assert.equal(sha(read(helper)),helperSha256,'Qualifier changed during planning');
const verticalMeshHelper=fileURLToPath(new URL('./lib/vertical-seal-mesh.ts',import.meta.url));
const result={schemaVersion:1,status:'READ_ONLY_VISUAL_BOUND_CLOSURE_PLAN',baseCellsIndex:indexPath,baseCellsIndexSha256:sha(ib),sourceBuildReportSha256:sha(reportBytes),sourcePartsSha256:sha(partsBytes),helper,helperSha256,verticalMeshHelper,verticalMeshHelperSha256:sha(read(verticalMeshHelper)),appendContract:'Qualified geometry is the section polygon domain INSIDE its outer ring and OUTSIDE the UNION of its holes. Use meshVerticalSeals and actual Float32 vertical station decomposition; preserve pre-Float32 selected domain area, skip only Float32-collapsed/zero-area faces, and require every emitted triangle normalY===0. Append only to existing visual/HCOL/LOD2 groups and preserve all original attribute/index prefixes and source floors. Audit top/bottom bounds are not replacement quads; the old earcut triangulation is not authority.',sources:[{file:values.config!,sha256:sha(configBytes)},{file:values.origin!,sha256:sha(originBytes)},{file:values['street-parts']!,sha256:sha(partsBytes)},{file:fileURLToPath(import.meta.url),sha256:sha(read(fileURLToPath(import.meta.url)))}],options:{protectedArea:options.protectedArea,sourceWaterMasks:options.waterMasks.length,registeredDecks:options.registeredDecks.length},visualBinding:{method:'Exact canonical Float32 runtime triangle correspondence in decoded visual _ground_ primitives; no distance matching.',uniqueHcolSides,uniqueHcolFloors,uniqueHcolTriangles,matchedTriangles,rejectedSeals,maxRssMiB},totals:{cells:rows.length,seals:rows.reduce((n,r)=>n+r.seals,0),lengthMetres:rows.reduce((n,r)=>n+r.lengthMetres,0),maximumGapMetres:Math.max(0,...rows.map(r=>r.maximumGapMetres)),addedVertices:rows.reduce((n,r)=>n+r.addedVertices,0),addedTriangles:rows.reduce((n,r)=>n+r.addedTriangles,0),byTag:rows.reduce((o:Record<string,number>,r)=>{for(const[k,v]of Object.entries(r.byTag))o[k]=(o[k]??0)+(v as number);return o;},{}),precisionRetries:rows.reduce((n,r)=>n+r.precisionRetries,0),maxRssMiB,counts:rows.reduce((o:Record<string,number>,r)=>{for(const[k,v]of Object.entries(r.counts))o[k]=(o[k]??0)+(v as number);return o;},{})},rows};
writeFileSync(out,JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({out,sha256:sha(read(out)),visualBinding:result.visualBinding,totals:result.totals}));
