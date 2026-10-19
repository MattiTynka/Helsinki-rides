// Read-only source-bound tram detail authority. Application is a separate CLI
// and requires a fresh output directory after the plan has been reviewed.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {fileURLToPath} from 'node:url';
import {NodeIO} from '@gltf-transform/core';
import {ALL_EXTENSIONS} from '@gltf-transform/extensions';
import {MeshoptDecoder} from 'meshoptimizer';
import {parseCollisionBundle,geodeticToGk25,type CellDescriptor} from '../../packages/world-schema/src/index.ts';
import {tramFootprints,drapeTramFootprints,DEFAULT_TRAM_PROFILE,TRAM_BOOLEAN_GRID_METRES,type TramTrack,type TramBounds} from './lib/tram-visuals.ts';
import {readTramGround,proveTramGroundInTier,tramGroundTriangleMultiset} from './lib/tram-cell-ground.ts';
import {tramStripePng,TRAM_STRIPE,tramStripeResidentBytes} from './lib/tram-texture.ts';

export interface TramPlannerOptions {cells:string;origin:string;profile:string;out:string;referenceCells?:string;detailTriangleCap?:number;coarseTriangleCap?:number}
const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
export async function planTramVisuals(options:TramPlannerOptions){
  const base=path.resolve(options.cells),out=path.resolve(options.out);assert.ok(!fs.existsSync(out),'Fresh tram plan required');
  const producerSources=['./plan_tram_visuals.ts','./apply_tram_visuals.ts','./lib/tram-visuals.ts','./lib/tram-coverage.ts','./lib/tram-cell-ground.ts','./lib/tram-texture.ts','./lib/append-tram-glb.ts','./lib/append-ground-glb.ts','./lib/facade-glb.ts','../../packages/world-schema/src/coordinates.ts','../../packages/world-schema/src/collision.ts'].map(relative=>{const file=fileURLToPath(new URL(relative,import.meta.url));return{file,sha256:sha(fs.readFileSync(file))};});
  const receipts=out.replace(/\.json$/i,'')+'-cells';assert.ok(!fs.existsSync(receipts),'Fresh tram receipts required');
  const inputs=new Map<string,string>();
  const read=(file:string)=>{const resolved=path.resolve(file),bytes=fs.readFileSync(resolved);inputs.set(resolved,sha(bytes));return bytes;};
  const json=(file:string)=>JSON.parse(read(file).toString('utf8'));
  const indexFile=path.join(base,'cells.json'),index=json(indexFile) as {originId:string;cellSize:number;cells:CellDescriptor[]},origin=json(options.origin),profile=json(options.profile);
  const sourceBuildReport=path.join(base,'report.json');read(sourceBuildReport);
  const referenceBase=options.referenceCells?path.resolve(options.referenceCells):null,referenceIndex=referenceBase?json(path.join(referenceBase,'cells.json')):null;
  assert.equal(origin.crs,'EPSG:3879');assert.equal(origin.heightDatum,'N2000');assert.equal(index.originId,origin.id);assert.equal(index.cellSize,128);
  if(profile.origin?.sha256)assert.equal(profile.origin.sha256,inputs.get(path.resolve(options.origin)),'Tram profile origin drift');
  for(const source of profile.sourceLocks??[]){assert.ok(typeof source.file==='string'&&/^[a-f0-9]{64}$/.test(source.sha256));assert.equal(sha(read(source.file)),source.sha256,`Tram source drift:${source.file}`);}
  const tracks:TramTrack[]=profile.tracks;assert.ok(Array.isArray(tracks)&&tracks.length>0&&tracks.length<=500,'Explicit bounded source tracks required');
  assert.equal(new Set(tracks.map(t=>t.wayId)).size,tracks.length,'Duplicate source tram ways');
  assert.ok(profile.osm?.path&&/^[a-f0-9]{64}$/.test(profile.osm.sha256),'Hash-bound original OSM required');
  const osmBytes=read(profile.osm.path);assert.equal(sha(osmBytes),profile.osm.sha256,'Original OSM changed');
  if(profile.osm.ledgerPath){assert.equal(sha(read(profile.osm.ledgerPath)),profile.osm.ledgerSha256,'OSM ledger changed');}
  {
    const osm=JSON.parse(osmBytes.toString('utf8')),ways=new Map<number,any>(),nodes=new Map<number,any>();
    for(const e of osm.elements){if(e.type==='way')ways.set(e.id,e);if(e.type==='node')nodes.set(e.id,e);}
    for(const track of tracks){
      const source=ways.get(track.wayId);assert.ok(source,`Missing source tram way${track.wayId}`);assert.deepEqual(track.tags,source.tags,'Tram tags differ from pinned original');
      assert.deepEqual(track.points.map(p=>p.nodeId),source.nodes,'Tram axis node order differs from original source');
      assert.ok(!track.tags.gauge||track.tags.gauge==='1000','Selected track has different source gauge');
      assert.ok(!track.tags.layer||track.tags.layer==='0','Multilevel tram axis requires explicit source deck authority');
      assert.ok(!track.tags.bridge||track.tags.bridge==='no','Tram bridge requires explicit deck authority');
      for(const p of track.points){const n=nodes.get(p.nodeId);assert.ok(n);const[e,north]=geodeticToGk25(n.lat,n.lon);assert.ok(Math.abs(p.x-(e-origin.originProjected[0]))<1e-8&&Math.abs(p.z+(north-origin.originProjected[1]))<1e-8,'Tram X/Z differs from source projection');}
    }
  }
  const b=profile.scope?.renderBoundsRuntimeXZ;
  const renderBounds:TramBounds=b?{minX:b[0],minZ:b[1],maxX:b[2],maxZ:b[3]}:profile.scope?.playArea??profile.playArea;
  assert.ok(renderBounds&&Object.values(renderBounds).every(Number.isFinite)&&renderBounds.maxX>renderBounds.minX&&renderBounds.maxZ>renderBounds.minZ,'Profile must supply actual playable bounds');
  const gauge=profile.gauge?.metres??profile.gaugeMetres;assert.equal(gauge,1,'Profile lacks the confirmed1000mm Helsinki gauge');
  const detailCap=options.detailTriangleCap??16000,coarseCap=options.coarseTriangleCap??8000;
  assert.ok(Number.isSafeInteger(detailCap)&&detailCap>0&&Number.isSafeInteger(coarseCap)&&coarseCap>0);
  const footprints=tramFootprints(tracks),start=performance.now(),artwork={...TRAM_STRIPE,sha256:sha(await tramStripePng()),residentBytes:tramStripeResidentBytes(),originalPixelsOnly:true};
  await MeshoptDecoder.ready;const io=new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.decoder':MeshoptDecoder});
  fs.mkdirSync(path.dirname(out),{recursive:true});fs.mkdirSync(receipts);
  const rows:any[]=[],problems:string[]=[];let detailedTriangles=0,coarseTriangles=0,missingArea=0,selectedMetres=0;
  for(const track of tracks)for(let i=1;i<track.points.length;i++)selectedMetres+=Math.hypot(track.points[i]!.x-track.points[i-1]!.x,track.points[i]!.z-track.points[i-1]!.z);
  const payload=(relative:string)=>{const file=path.resolve(base,relative),local=path.relative(base,file);assert.ok(local&&!local.startsWith('..')&&!path.isAbsolute(local),'Payload escapes candidate');return read(file);};
  for(const cell of index.cells){
    const[x0,z0,x1,z1]=cell.boundsXZ,bounds={minX:Math.max(x0,renderBounds.minX),minZ:Math.max(z0,renderBounds.minZ),maxX:Math.min(x1,renderBounds.maxX),maxZ:Math.min(z1,renderBounds.maxZ)};
    if(bounds.minX>=bounds.maxX||bounds.minZ>=bounds.maxZ)continue;
    const relevantGroups=new Set(footprints.filter(f=>Math.max(...f.polygon.map(p=>p[0]))>=bounds.minX&&Math.min(...f.polygon.map(p=>p[0]))<=bounds.maxX&&Math.max(...f.polygon.map(p=>p[1]))>=bounds.minZ&&Math.min(...f.polygon.map(p=>p[1]))<=bounds.maxZ).map(f=>`${f.wayId}:${f.segment}:${f.side}`));
    const relevant=footprints.filter(f=>relevantGroups.has(`${f.wayId}:${f.segment}:${f.side}`));
    if(!relevant.length)continue;
    const vb=payload(cell.visual.lod0.path),cb=payload(cell.collision.path);assert.equal(sha(vb),cell.visual.lod0.sha256);assert.equal(sha(cb),cell.collision.sha256);
    const doc=await io.readBinary(vb),bundle=parseCollisionBundle(cb),ground=readTramGround(doc,bundle),detail=drapeTramFootprints(relevant,ground,bounds),coarse=drapeTramFootprints(relevant,ground,bounds,true);
    if(detail.stats.expectedArea<=1e-10)continue;
    const unsupported=detail.coverage!.fringes.filter(f=>!f.qualified);
    if(detail.coverage!.unresolvedArea>1e-12)problems.push(`${cell.id}:unresolved rail support area${detail.coverage!.unresolvedArea}m2`);
    if(coarse.coverage!.unresolvedArea>1e-12)problems.push(`${cell.id}:unresolved coarse rail support area${coarse.coverage!.unresolvedArea}m2`);
    let groundPreservation:any=null;
    if(referenceBase){
      const reference=referenceIndex.cells.find((r:CellDescriptor)=>r.id===cell.id);assert.ok(reference,'Reference cell missing');
      const referenceFile=path.resolve(referenceBase,reference.visual.lod0.path);assert.ok(!path.relative(referenceBase,referenceFile).startsWith('..'));
      const referenceBytes=read(referenceFile);assert.equal(sha(referenceBytes),reference.visual.lod0.sha256);
      const oldGround=tramGroundTriangleMultiset(await io.readBinary(referenceBytes)),newGround=tramGroundTriangleMultiset(doc);assert.deepEqual(newGround,oldGround,'Final resurfacing changed original ground triangle coordinates/winding');
      assert.equal(reference.collision.sha256,cell.collision.sha256,'Final resurfacing changed collision');groundPreservation={reference:referenceFile,referenceSha256:sha(referenceBytes),orientedGroundTriangles:oldGround.length,sha256:sha(Buffer.from(JSON.stringify(oldGround))),collisionSha256:cell.collision.sha256,exact:true};
    }
    const usedGround=[...new Map([...detail.bindings,...coarse.bindings].map(b=>[b.ground.id,b.ground])).values()],tiers:any={};
    for(const tier of ['lod1','lod2'] as const){const ref=cell.visual[tier];if(!ref){if(tier==='lod2')problems.push(`${cell.id}:missing existing coarse tier`);continue;}
      const bytes=payload(ref.path);assert.equal(sha(bytes),ref.sha256);const proof=proveTramGroundInTier(await io.readBinary(bytes),usedGround);tiers[tier]={...proof,missing:proof.missing.slice(0,3)};if(proof.missing.length)problems.push(`${cell.id}:${tier} lacks${proof.missing.length} exact supporting ground triangles`);
    }
    detailedTriangles+=detail.stats.triangles;coarseTriangles+=coarse.stats.triangles;missingArea+=detail.stats.missingArea;
    const receipt=path.join(receipts,`${cell.id}.json`),value={schemaVersion:1,cell:cell.id,bounds,inputs:{visual:cell.visual,collision:cell.collision},detail,coarse,tiers,unsupported,groundPreservation,profile:DEFAULT_TRAM_PROFILE};
    const bytes=Buffer.from(JSON.stringify(value)+'\n');fs.writeFileSync(receipt,bytes,{flag:'wx'});rows.push({cell:cell.id,receipt,sha256:sha(bytes),detailedTriangles:detail.stats.triangles,coarseTriangles:coarse.stats.triangles,expectedArea:detail.stats.expectedArea,missingArea:detail.stats.missingArea,ways:[...new Set(relevant.map(f=>f.wayId))].sort((a,b)=>a-b)});
    global.gc?.();console.log(JSON.stringify({cell:cell.id,detail:detail.stats.triangles,coarse:coarse.stats.triangles,rawMissingArea:detail.stats.missingArea,unresolvedArea:detail.coverage!.unresolvedArea,rssMiB:process.memoryUsage().rss/2**20}));
  }
  if(detailedTriangles>detailCap)problems.push(`Detailed tram triangles${detailedTriangles}>cap${detailCap}`);
  if(coarseTriangles>coarseCap)problems.push(`Coarse tram triangles${coarseTriangles}>cap${coarseCap}`);
  if(!rows.length)problems.push('No source tram footprint intersects supported playable ground');
  for(const source of producerSources)assert.equal(sha(fs.readFileSync(source.file)),source.sha256,'Tram producer changed while planning');
  const report={schemaVersion:1,status:problems.length?'BLOCKED_SOURCE_OR_BUDGET':'READY_FOR_ASSET_APPLICATION',candidate:{directory:base,index:indexFile,sha256:inputs.get(indexFile)},sourceBuildReport:{file:sourceBuildReport,sha256:inputs.get(sourceBuildReport)},origin:{file:path.resolve(options.origin),sha256:inputs.get(path.resolve(options.origin))},profile:{file:path.resolve(options.profile),sha256:inputs.get(path.resolve(options.profile))},producerSources,inputs:[...inputs].map(([file,sha256])=>({file,sha256})),artwork,gauge:{metres:1,authority:'https://kaupunkiliikenne.fi/termisto/',offsetDefinition:'Measuring faces are500mm from actual source track centreline; visual head has nonzero width'},visualProfile:{...DEFAULT_TRAM_PROFILE,booleanGridMetres:TRAM_BOOLEAN_GRID_METRES,dimensionAuthority:'Gauge and≤3mm rail lift verified against operator; head/groove/guard widths are a visual approximation, not an as-built profile survey',junctionLimitation:'Intersecting original track ribbons have deterministic source ownership; exact switch tongue/frog engineering is not surveyed'},preservation:{collisionByteExact:true,existingGeometryAndImagesByteExact:true,newPhysicalGeometry:false,lod0NewDrawsPerAffectedCell:1,lod2NewDraws:0},budgets:{detailTriangleCap:detailCap,coarseTriangleCap:coarseCap},totals:{sourceWays:tracks.length,sourceAxisMetres:selectedMetres,cells:rows.length,detailedTriangles,coarseTriangles,missingArea},problems,rows,elapsedSeconds:(performance.now()-start)/1000,rssMiB:process.memoryUsage().rss/2**20};
  fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n',{flag:'wx'});return report;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const{values}=parseArgs({options:{cells:{type:'string'},origin:{type:'string'},profile:{type:'string'},out:{type:'string'},'reference-cells':{type:'string'},'detail-triangle-cap':{type:'string'},'coarse-triangle-cap':{type:'string'}}});
  assert.ok(values.cells&&values.origin&&values.profile&&values.out,'--cells --origin --profile --out required');
  const result=await planTramVisuals({cells:values.cells,origin:values.origin,profile:values.profile,out:values.out,referenceCells:values['reference-cells'],detailTriangleCap:values['detail-triangle-cap']?Number(values['detail-triangle-cap']):undefined,coarseTriangleCap:values['coarse-triangle-cap']?Number(values['coarse-triangle-cap']):undefined});
  console.log(JSON.stringify({status:result.status,...result.totals,problems:result.problems,rssMiB:result.rssMiB}));
}
