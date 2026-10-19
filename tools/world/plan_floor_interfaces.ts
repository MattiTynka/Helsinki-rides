// Read-only floor-to-floor seam qualification, independently bound to the
// decoded current candidate. Application is a separate append-only phase.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
import {fileURLToPath} from 'node:url';
import {NodeIO} from '@gltf-transform/core';
import {ALL_EXTENSIONS} from '@gltf-transform/extensions';
import {MeshoptDecoder} from 'meshoptimizer';
import {parseCollisionBundle,type CellDescriptor} from '../../packages/world-schema/src/index.ts';
import {buildCoastalMask,sourceCoastalDecks,type CoastalOsm} from './lib/coastal-mask.ts';
import {loadCoastalRegistration} from './lib/coastal-registration.ts';
import {loadGeoJsonPolygons} from './lib/geometry.ts';
import {findFloorInterfaceSeals,meshFloorInterfaceSeals,type FloorSource,type FloorInterfaceOptions} from './lib/floor-interface-seals.ts';

interface PlannerOptions {cells:string;config:string;origin:string;osm:string;streetParts:string;out:string;coastalRegistration?:string|undefined}
interface Config {playArea:{minX:number;maxX:number;minZ:number;maxZ:number};carriagewayGrade:Pick<FloorInterfaceOptions,'protectedArea'|'protectedMarginMetres'>}
interface Origin {id:string;originProjected:[number,number,number];crs:string;heightDatum:string}
const sha=(bytes:Uint8Array|string)=>createHash('sha256').update(bytes).digest('hex');
const pointKey=(p:readonly number[])=>p.join(','),triangleKey=(p:readonly (readonly number[])[])=>p.map(pointKey).sort().join('|');
function containedPath(base:string,relative:string){const file=path.resolve(base,relative),local=path.relative(base,file);assert.ok(local&&!path.isAbsolute(local)&&local!=='..'&&!local.startsWith(`..${path.sep}`),'Payload escapes candidate');return file;}

export async function planFloorInterfaces(options:PlannerOptions){
  const base=path.resolve(options.cells),out=path.resolve(options.out),receiptDir=out+'.cells';assert.ok(!fs.existsSync(out)&&!fs.existsSync(receiptDir),'Fresh plan and receipt directory required');
  const inputHashes=new Map<string,string>(),read=(file:string)=>{const bytes=fs.readFileSync(file);inputHashes.set(file,sha(bytes));return bytes;},json=<T>(file:string)=>JSON.parse(read(file).toString('utf8')) as T;
  const helper=fileURLToPath(new URL('./lib/floor-interface-seals.ts',import.meta.url)),helperSha256=sha(read(helper));
  const producerSources=[fileURLToPath(import.meta.url),helper,fileURLToPath(new URL('./lib/vertical-seal-mesh.ts',import.meta.url)),fileURLToPath(new URL('./lib/coastal-mask.ts',import.meta.url)),fileURLToPath(new URL('./lib/geometry.ts',import.meta.url)),fileURLToPath(new URL('../../packages/world-schema/src/collision.ts',import.meta.url))].map(file=>({file,sha256:sha(read(file))}));
  const indexFile=path.join(base,'cells.json'),reportFile=path.join(base,'report.json'),index=json<{originId:string;cells:CellDescriptor[]}>(indexFile),sourceBuildReportSha256=sha(read(reportFile)),configFile=path.resolve(options.config),originFile=path.resolve(options.origin),osmFile=path.resolve(options.osm),partsFile=path.resolve(options.streetParts),config=json<Config>(configFile),origin=json<Origin>(originFile);
  assert.equal(index.originId,origin.id);assert.equal(origin.crs,'EPSG:3879');assert.equal(origin.heightDatum,'N2000');assert.ok(config.playArea&&config.carriagewayGrade?.protectedArea,'Explicit play/protected areas required');assert.ok(origin.originProjected.length===3&&origin.originProjected.every(Number.isFinite));
  function masks(){
    const osm=json<CoastalOsm>(osmFile);inputHashes.set(partsFile,sha(fs.readFileSync(partsFile)));
    const parts=loadGeoJsonPolygons(partsFile,origin.originProjected[0],origin.originProjected[1],p=>String(p['osan_id']));
    let mask=buildCoastalMask(osm,{area:config.playArea,originProjected:origin.originProjected});
    if(options.coastalRegistration){
      const registration=loadCoastalRegistration(options.coastalRegistration,mask,origin.originProjected,{streetPartsSha256:inputHashes.get(partsFile)!,osmSha256:inputHashes.get(osmFile)!});
      read(options.coastalRegistration);for(const ref of Object.values(registration.sources))read(ref.file);
      const helper=fileURLToPath(new URL('./lib/coastal-registration.ts',import.meta.url));producerSources.push({file:helper,sha256:sha(read(helper))});mask=registration.mask;
    }
    const decks=sourceCoastalDecks(osm,parts,origin.originProjected);
    return{water:mask.water,decks:decks.polygons,walls:parts.filter(p=>String(p.properties['alatyyppi'])==='Tukimuuri'),sourceWater:mask.sources};
  }
  const source=masks(),qualificationOptions:FloorInterfaceOptions={...config.carriagewayGrade,waterMasks:source.water,registeredDecks:source.decks,wallMasks:source.walls,maximumGapMetres:.15,floatToleranceMetres:.0001};global.gc?.();await MeshoptDecoder.ready;
  const io=new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.decoder':MeshoptDecoder}),rows:any[]=[],totals={cells:0,seals:0,lengthMetres:0,maximumLengthMetres:0,maximumGapMetres:0,addedVertices:0,addedTriangles:0,counts:{} as Record<string,number>},visualBinding={uniqueHcolTriangles:0,matchedTriangles:0,rejectedSeals:0},start=performance.now();fs.mkdirSync(receiptDir,{recursive:true});
  for(const cell of index.cells){
    const collisionFile=containedPath(base,cell.collision.path),collisionBytes=read(collisionFile);assert.equal(sha(collisionBytes),cell.collision.sha256);assert.equal(collisionBytes.byteLength,cell.collision.bytes);const bundle=parseCollisionBundle(collisionBytes);assert.equal(bundle.header.cell,cell.id);assert.equal(bundle.header.originId,index.originId);
    const sources:FloorSource[]=bundle.colliders.filter(c=>c.group!=='trees').map(c=>({id:c.id,cell:cell.id,positions:c.positions,indices:c.indices,triangleTags:Array.from(c.triangleTags,t=>bundle.header.surfaceTags[t]!)}));
    const qualified=findFloorInterfaceSeals(sources,qualificationOptions),required=new Map<string,{sourceId:string;triangle:number;points:number[][]}>();
    for(const seal of qualified.seals)for(const[id,triangle]of[[seal.upperSourceId,seal.upperTriangle],[seal.lowerSourceId,seal.lowerTriangle]] as const){const collider=bundle.colliders.find(c=>c.id===id);assert.ok(collider);const points=[0,1,2].map(k=>{const vertex=collider.indices[triangle*3+k]!;return Array.from(collider.positions.subarray(vertex*3,vertex*3+3));});required.set(`${id}:${triangle}`,{sourceId:id,triangle,points});}
    const matches=new Map<string,any[]>(),visualFile=containedPath(base,cell.visual.lod0.path);let visualSha256=cell.visual.lod0.sha256;
    if(required.size){const bytes=read(visualFile);assert.equal(sha(bytes),visualSha256);const doc=await io.readBinary(bytes),needed=new Set([...required.values()].map(r=>triangleKey(r.points)));
      for(const node of doc.getRoot().listNodes()){const mesh=node.getMesh();if(!mesh||!node.getName().includes('_ground_'))continue;assert.deepEqual(node.getWorldMatrix(),[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]);for(const[primitiveIndex,p]of mesh.listPrimitives().entries()){const position=p.getAttribute('POSITION'),index=p.getIndices();assert.ok(position&&index);assert.equal(position.getComponentType(),5126);assert.equal(position.getNormalized(),false);const values=position.getArray()!,indices=index.getArray()!;for(let i=0;i<indices.length;i+=3){const points=[0,1,2].map(k=>Array.from(values.subarray(indices[i+k]!*3,indices[i+k]!*3+3))),key=triangleKey(points);if(!needed.has(key))continue;const list=matches.get(key)??[];list.push({node:node.getName(),primitiveIndex,triangle:i/3});matches.set(key,list);}}}
    }
    const bindings=[...required.values()].filter(r=>matches.has(triangleKey(r.points))).map(r=>({...r,visual:matches.get(triangleKey(r.points))})),unbound=[...required.values()].filter(r=>!matches.has(triangleKey(r.points))),unboundIds=new Set(unbound.map(r=>`${r.sourceId}:${r.triangle}`)),rejectedSeals=qualified.seals.filter(s=>unboundIds.has(`${s.upperSourceId}:${s.upperTriangle}`)||unboundIds.has(`${s.lowerSourceId}:${s.lowerTriangle}`)).length;
    visualBinding.uniqueHcolTriangles+=required.size;visualBinding.matchedTriangles+=bindings.length;visualBinding.rejectedSeals+=rejectedSeals;
    const mesh=meshFloorInterfaceSeals(qualified.seals),receipt=path.join(receiptDir,cell.id+'.json'),maxGap=Math.max(0,...qualified.seals.flatMap(s=>s.gap)),lengthMetres=qualified.seals.reduce((n,s)=>n+s.length,0),maxLength=Math.max(0,...qualified.seals.map(s=>s.length));
    const cellReport={cell:cell.id,kind:'source-floor-interface-seals',collisionSha256:cell.collision.sha256,visualLod0:cell.visual.lod0,visualLod2:cell.visual.lod2??null,seals:qualified.seals,rejections:qualified.rejections,counts:qualified.counts,visualBinding:{bindings,rejected:unbound},preservation:'Qualification only; no original vertices, indices, tags, source masks, collider items or payload bytes changed.'};
    const bytes=JSON.stringify(cellReport,null,2)+'\n';fs.writeFileSync(receipt,bytes,{flag:'wx'});rows.push({cell:cell.id,receipt,sha256:sha(bytes),seals:qualified.seals.length,lengthMetres,maximumLengthMetres:maxLength,maximumGapMetres:maxGap,addedVertices:mesh.positions.length/3,addedTriangles:mesh.indices.length/3,counts:qualified.counts,visualBinding:{uniqueTriangles:required.size,matchedTriangles:bindings.length,rejectedSeals}});
    totals.cells++;totals.seals+=qualified.seals.length;totals.lengthMetres+=lengthMetres;totals.maximumLengthMetres=Math.max(totals.maximumLengthMetres,maxLength);totals.maximumGapMetres=Math.max(totals.maximumGapMetres,maxGap);totals.addedVertices+=mesh.positions.length/3;totals.addedTriangles+=mesh.indices.length/3;for(const[k,v]of Object.entries(qualified.counts))totals.counts[k]=(totals.counts[k]??0)+v;
    global.gc?.();assert.ok(process.memoryUsage().rss<690*1048576,'700MiB qualification limit');if(totals.cells%25===0)console.log(JSON.stringify({cells:totals.cells,seals:totals.seals,rssMiB:process.memoryUsage().rss/2**20}));
  }
  for(const[file,digest]of inputHashes)assert.equal(sha(fs.readFileSync(file)),digest,`Input drift during qualification: ${file}`);
  const result={schemaVersion:1,kind:'source-floor-interface-seals',status:visualBinding.rejectedSeals?'UNBOUND_SOURCE_TRIANGLES_REQUIRE_REVIEW':'SOURCE_BOUND_READ_ONLY_FLOOR_PLAN',baseCellsIndex:indexFile,baseCellsIndexSha256:inputHashes.get(indexFile),sourceBuildReportSha256,helper,helperSha256,producerSources,inputs:[...inputHashes].map(([file,sha256])=>({file,sha256})),options:{protectedArea:qualificationOptions.protectedArea,protectedMarginMetres:qualificationOptions.protectedMarginMetres,maximumGapMetres:.15,floatToleranceMetres:.0001},qualificationRules:{sourceCollinearityMetres:1e-8,minimumFloorInteriorWidthMetres:.0001,maximumExistingFacePlaneDistanceMetres:.0001,ambiguousAdditionMinimumSectionWidthMetres:.0001,actualSourcePlaneProfiles:true,mesher:'meshVerticalSeals'},authority:{sourceWater:source.sourceWater,wallMaskIds:source.walls.map(p=>p.id),registeredDeckIds:source.decks.map(p=>p.id)},appendContract:'Fresh output only. Append vertical wall-tag geometry to existing ground primitive/HCOL item and LOD2, retaining all original array prefixes, old tags, collider item order/count and all floor heights. No new XZ floor area or source changes.',visualBinding,totals:{...totals,wallSeconds:(performance.now()-start)/1000,maxRssMiB:process.resourceUsage().maxRSS/1024},rows};fs.writeFileSync(out,JSON.stringify(result,null,2)+'\n',{flag:'wx'});return{out,sha256:sha(fs.readFileSync(out)),totals:result.totals,visualBinding};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){const{values}=parseArgs({options:{cells:{type:'string'},config:{type:'string'},origin:{type:'string'},osm:{type:'string'},'street-parts':{type:'string'},out:{type:'string'},'coastal-registration':{type:'string'}}});for(const key of['cells','config','origin','osm','street-parts','out']as const)assert.ok(values[key],`--${key} required`);console.log(JSON.stringify(await planFloorInterfaces({cells:values.cells!,config:values.config!,origin:values.origin!,osm:values.osm!,streetParts:values['street-parts']!,out:values.out!,coastalRegistration:values['coastal-registration']}),null,2));}
