import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {encodeTerrain,parseTerrain,type WorldManifest,type TerrainGrid} from '../../../packages/world-schema/src/index.ts';
import {sourceFile,sourceSha256,readSourceFile,writeSourceJson} from './source-files.ts';
import {verifyAcceptedCoverage} from './accepted-coverage.ts';
import {readDeliveryFile,freshDeliveryDirectory,prepareNewDeliveryCells} from './delivery-city.ts';
import {decodeDeliverySimulation} from './delivery-city-payloads.ts';
import {linkOrCopyDeliveryFile} from './delivery-city-files.ts';
import {extendTerrainPreservingBase} from './terrain-extension.ts';
import {loadGeoJsonPolygons,bbox,type LocalPolygon} from './geometry.ts';
import {readDeliveryGroundExclusions} from './delivery-city-ground.ts';
import {authorizeNewStripFacades} from './delivery-city-source.ts';
import {composeCityFrontiers,planCityFrontier,type FrontierRectangle,type FrontierDirection} from './frontier-ground.ts';
import {validateAcquisitionJob} from './bounded-acquisition.ts';

interface InputPin {file:string;bytes:number;sha256:string}
interface SourceSnapshot {root:string;ledger:InputPin;payload:InputPin;snapshot:any;source:any}
interface BuildJob {
  schemaVersion:1;kind:'qualified-source-expansion-build-job';root:string;sourceRoot:string;
  snapshot:string;regionId:string;region:FrontierRectangle;acceptedBounds:FrontierRectangle;terrainExtent:FrontierRectangle;
  origin:any;acceptedWorld:string;acceptedCoverage:string;acceptedManifestSha256:string;coverageIndexSha256:string;
  pins:Record<string,InputPin>;sources:Record<string,SourceSnapshot>;outputs:Record<string,string>;
  commands:{id:string;program:'node';args:string[];dependsOn:string[]}[];rolloutPolicy:string;
  direction?:FrontierDirection;composition?:{id:string;region:FrontierRectangle;direction:FrontierDirection;replacementRegions:FrontierRectangle[]}[];
  rawTerrainProducerRequired?:boolean;
}
export interface PrepareExpansionBuildOptions {
  scope:string;profile:string;regionId:string;sources:string;snapshot:string;acceptedWorld:string;acceptedCoverage:string;
  acceptedSourceTerrain:string;treeProfile:string;treeAsset:string;out:string;conflictReview?:string;convertedModel?:string;rawTerrain?:string;
}
const producerRoot=fileURLToPath(new URL('../../../',import.meta.url));
const pin=(file:string):InputPin=>{const real=fs.realpathSync(file),stat=fs.lstatSync(real);assert.ok(stat.isFile());const bytes=fs.readFileSync(real);return{file:real,bytes:bytes.length,sha256:sourceSha256(bytes)};};
const pinned=(ref:InputPin)=>{const bytes=fs.readFileSync(ref.file);assert.equal(bytes.length,ref.bytes,'Input length changed: '+path.basename(ref.file));assert.equal(sourceSha256(bytes),ref.sha256,'Input hash changed: '+path.basename(ref.file));return bytes;};
const json=(file:string)=>JSON.parse(fs.readFileSync(file,'utf8'));
const area=(r:FrontierRectangle)=>({minX:r[0],minZ:r[1],maxX:r[2],maxZ:r[3]});
const bounds=(t:TerrainGrid):FrontierRectangle=>[t.x0,t.z0,t.x0+(t.nx-1)*t.resolution,t.z0+(t.nz-1)*t.resolution];
const overlaps=(a:readonly number[],b:readonly number[])=>a[0]!<=b[2]!&&a[2]!>=b[0]!&&a[1]!<=b[3]!&&a[3]!>=b[1]!;
const inside=(x:number,z:number,r:FrontierRectangle)=>x>=r[0]&&x<r[2]&&z>=r[1]&&z<r[3];
function parseRectangle(value:unknown):FrontierRectangle{assert.ok(Array.isArray(value)&&value.length===4&&value.every(Number.isFinite)&&value[0]<value[2]&&value[1]<value[3],'Invalid expansion rectangle');return value as [number,number,number,number];}

/** Region ownership and frontier priority are explicit. A terrain envelope never
 * promotes the original east halo or an unpublished partial candidate to coverage. */
export function resolveExpansionPacket(scope:any,profile:any,regionId:string,acceptedBounds:FrontierRectangle){
  assert.equal(profile.regionId,regionId);if(scope.acceptedTerrainExtent)assert.deepEqual(scope.acceptedTerrainExtent,acceptedBounds,'Cumulative builds require the original accepted terrain');
  const selected=scope.regions.find((r:any)=>r.id===regionId);assert.ok(selected,'Unknown qualified expansion region');
  const region=parseRectangle(selected.boundsXZ),direction:FrontierDirection=profile.axis===undefined&&profile.side===undefined?{axis:'z',side:'south'}:{axis:profile.axis,side:profile.side};
  if(selected.axis!==undefined||selected.side!==undefined)assert.deepEqual(direction,{axis:selected.axis,side:selected.side},'Profile and scope frontier direction differ');
  planCityFrontier(acceptedBounds,region,direction);
  const ids:unknown=profile.compositionRegionIds??[regionId];assert.ok(Array.isArray(ids)&&ids.length>0&&ids.length<=8&&new Set(ids).size===ids.length&&ids.includes(regionId));
  const packets=ids.map(id=>{const r=scope.regions.find((p:any)=>p.id===id);assert.ok(r,'Unknown composition region');return{id:String(id),region:parseRectangle(r.boundsXZ),direction:id===regionId?direction:{axis:r.axis,side:r.side}as FrontierDirection};});
  const plans=composeCityFrontiers(acceptedBounds,packets.map(p=>({...p.direction,region:p.region}))),composition=packets.map((p,i)=>({...p,replacementRegions:plans[i]!.regions}));
  const defaultExtent:FrontierRectangle=[Math.min(acceptedBounds[0],region[0]),Math.min(acceptedBounds[1],region[1]),Math.max(acceptedBounds[2],region[2]),Math.max(acceptedBounds[3],region[3])];
  const terrainExtent=profile.useSharedTerrainExtent?parseRectangle(scope.terrainExtent):defaultExtent;
  for(const r of [acceptedBounds,...packets.map(p=>p.region)])assert.ok(r[0]>=terrainExtent[0]&&r[1]>=terrainExtent[1]&&r[2]<=terrainExtent[2]&&r[3]<=terrainExtent[3],'Shared terrain must contain accepted grid and every composed region');
  if(scope.actualNewCoverageMaxX!==undefined){assert.equal(scope.actualNewCoverageMaxX,acceptedBounds[2]);for(const p of packets)assert.ok(p.region[2]<=scope.actualNewCoverageMaxX,'Original east source halo is not new build coverage');assert.equal(terrainExtent[2],scope.actualNewCoverageMaxX);}
  return{region,direction,terrainExtent,composition};
}

/** The acquisition identity hashes the validated compact JSON object. Its on-disk
 * pretty-printed bytes have a separate immutable file pin. Keep both contracts. */
export function readExpansionAcquisition(root:string){
  const reportPin=pin(sourceFile(root,'acquisition-report.json')),report=JSON.parse(pinned(reportPin).toString());
  assert.equal(report.status,'ACQUIRED_PENDING_GEOMETRY_AND_CONFLICT_REVIEW');
  const jobPin=pin(sourceFile(root,'acquisition-job.json')),job=validateAcquisitionJob(JSON.parse(pinned(jobPin).toString()));
  assert.equal(sourceSha256(JSON.stringify(job)),report.jobSha256,'Acquisition canonical job identity differs');
  return{report,reportPin,jobPin};
}

export function inspectExpansionRawTerrain(directory:string,expectedIndexSha256:string,producerRequired=false,regions:readonly FrontierRectangle[]=[]){
  const document=pin(path.join(directory,'terrain.json')),doc=JSON.parse(pinned(document).toString()),binary=pin(sourceFile(directory,doc.file));assert.equal(binary.sha256,doc.sha256,'Raw terrain payload differs');assert.equal(doc.source?.snapshotSha256,expectedIndexSha256,'Raw terrain source index differs');
  if(producerRequired){assert.ok(doc.producer?.files&&doc.producer.runtime?.node&&doc.producer.runtime?.v8,'Cumulative raw terrain requires its actual producer receipt');for(const file of ['tools/world/build_terrain.ts','tools/world/lib/quantized-mesh.ts','tools/world/lib/terrain-source-fallback.ts','pnpm-lock.yaml'])assert.match(doc.producer.files[file]??'',/^[a-f0-9]{64}$/,'Incomplete raw terrain producer closure');assert.equal(doc.inputDigests?.indexSha256,expectedIndexSha256);assert.match(doc.inputDigests?.originSha256??'',/^[a-f0-9]{64}$/);}
  if(doc.qualifiedSourceFallback){const f=doc.qualifiedSourceFallback;assert.equal(f.kind,'qualified-single-sample-parent-terrain-source');assert.equal(f.primaryIndexSha256,expectedIndexSha256);assert.ok(Number.isInteger(f.usedSamples)&&f.usedSamples>=0&&f.usedSamples<=1&&Array.isArray(f.samples)&&f.samples.length===f.usedSamples);const grid=parseTerrain(pinned(binary)),bits=new Uint32Array(grid.heights.buffer,grid.heights.byteOffset,grid.heights.length);
    for(const sample of f.samples){assert.ok(Array.isArray(sample.runtimeXZ)&&sample.runtimeXZ.length===2&&sample.runtimeXZ.every(Number.isFinite));const [x,z]=sample.runtimeXZ,ix=(x-grid.x0)/grid.resolution,iz=(z-grid.z0)/grid.resolution;assert.ok(Number.isInteger(ix)&&Number.isInteger(iz)&&ix>=0&&ix<grid.nx&&iz>=0&&iz<grid.nz,'Fallback sample is outside raw grid');assert.equal(bits[iz*grid.nx+ix]!.toString(16).padStart(8,'0'),sample.runtimeFloat32Bits,'Raw fallback bits differ from qualified source');assert.equal(f.guardMetres,128);for(const r of regions)assert.ok(x<r[0]-128||x>r[2]+128||z<r[1]-128||z>r[3]+128,'Raw source fallback lies within cumulative packet guard');}
  }
  return{document,binary,producerStatus:doc.producer?'RECORDED_ACTUAL_RAW_PRODUCER':'LEGACY_RAW_WITHOUT_PRODUCER_RECEIPT',producer:doc.producer??null,inputDigests:doc.inputDigests??null,qualifiedSourceFallback:doc.qualifiedSourceFallback??null};
}

/** Slice a larger acquired grid without interpolation or changing any Float32 bit. */
export function sliceExpansionTerrain(grid:TerrainGrid,extent:FrontierRectangle):TerrainGrid{
  const dx=(extent[0]-grid.x0)/grid.resolution,dz=(extent[1]-grid.z0)/grid.resolution,nx=(extent[2]-extent[0])/grid.resolution+1,nz=(extent[3]-extent[1])/grid.resolution+1;
  assert.ok([dx,dz,nx,nz].every(Number.isSafeInteger)&&dx>=0&&dz>=0&&nx>=2&&nz>=2&&dx+nx<=grid.nx&&dz+nz<=grid.nz,'Raw terrain does not cover the aligned requested grid');
  const heights=new Float32Array(nx*nz),target=new Uint32Array(heights.buffer),source=new Uint32Array(grid.heights.buffer,grid.heights.byteOffset,grid.heights.length);
  for(let z=0;z<nz;z++)target.set(source.subarray((z+dz)*grid.nx+dx,(z+dz)*grid.nx+dx+nx),z*nx);
  return{x0:extent[0],z0:extent[1],resolution:grid.resolution,nx,nz,heights};
}

export function selectExpansionBuildings(model:any,accepted:WorldManifest,region:FrontierRectangle,ownershipRegions:readonly{id:string;region:FrontierRectangle}[]=[{id:'selected',region}]){
  assert.equal(model.originId,accepted.origin.id);assert.deepEqual(model.originProjected,accepted.origin.originProjected);
  const oldIds=new Set(accepted.cells.flatMap(c=>c.buildingIds)),oldOwners=accepted.cells.flatMap(c=>c.buildings),oldVtj=new Set(oldOwners.map(b=>b.vtj).filter(Boolean));
  const seen=new Set<string>(),excluded:{id:string;reason:string;vtj?:string;acceptedOwnerIds?:string[]}[]=[],selected:any[]=[],ownership:{id:string;regionId:string;vtj?:string}[]=[],vtjRegions=new Map<string,Set<string>>();
  for(const b of model.buildings){
    assert.ok(typeof b.id==='string'&&!seen.has(b.id),'Duplicate or missing source building identity');seen.add(b.id);
    assert.ok(b.boundsENU?.min?.length===3&&b.boundsENU?.max?.length===3&&[...b.boundsENU.min,...b.boundsENU.max].every(Number.isFinite));
    const x=(b.boundsENU.min[0]+b.boundsENU.max[0])/2,z=-(b.boundsENU.min[1]+b.boundsENU.max[1])/2;
    if(oldIds.has(b.id)||b.vtj&&oldVtj.has(b.vtj)){excluded.push({id:b.id,reason:'accepted-id-or-vtj-owner',...(b.vtj?{vtj:b.vtj}:{}),acceptedOwnerIds:oldOwners.filter(old=>old.id===b.id||b.vtj&&old.vtj===b.vtj).map(old=>old.id)});continue;}
    const owners=ownershipRegions.filter(p=>inside(x,z,p.region));assert.ok(owners.length<=1,'New building has multiple packet owners');if(owners.length){const owner=owners[0]!;ownership.push({id:b.id,regionId:owner.id,...(b.vtj?{vtj:b.vtj}:{})});if(b.vtj){const groups=vtjRegions.get(b.vtj)??new Set<string>();groups.add(owner.id);vtjRegions.set(b.vtj,groups);assert.ok(groups.size<=1,'New VTJ identity spans multiple packets; explicit source-owner review required: '+b.vtj);}}
    if(!inside(x,z,region)){excluded.push({id:b.id,reason:'outside-half-open-owner-region'});continue;}
    selected.push(b);
  }
  const used=[...new Set<number>(selected.flatMap(b=>b.parts.map((p:any)=>p.texture).filter((t:any)=>t!==null)))].sort((a,b)=>a-b),remap=new Map(used.map((t,i)=>[t,i]));
  for(const t of used)assert.ok(Number.isSafeInteger(t)&&t>=0&&t<model.textures.length,'Invalid source texture index');
  const textures=used.map(t=>model.textures[t]),buildings=selected.map(b=>({...b,parts:b.parts.map((p:any)=>({...p,texture:p.texture===null?null:remap.get(p.texture)}))}));
  return{model:{...model,textures,buildings,stats:{...model.stats,buildings:buildings.length,textured:buildings.filter(b=>b.textured).length,texturePixels:textures.reduce((n:number,t:any)=>n+t.width*t.height,0),selectedTriangles:buildings.reduce((n:number,b:any)=>n+b.triangles,0)}},excluded,ownership,textureIndexMap:used.map((sourceIndex,index)=>({sourceIndex,index}))};
}

/** Retain exact municipal rings, including holes. Every unqualified Silta in the build halo stays closed. */
export function expansionBridgeExclusions(parts:readonly LocalPolygon[],source:{file:string;sha256:string},originId:string,region:FrontierRectangle,halo:number){
  assert.ok(Number.isFinite(halo)&&halo>=6&&halo<=256);const work:FrontierRectangle=[region[0]-halo,region[1]-halo,region[2]+halo,region[3]+halo],groups=new Map<string,LocalPolygon[]>();
  for(const p of parts){if(p.properties.paatyyppi!=='Silta')continue;const b=bbox(p.rings),runtime=[b[0],-b[3],b[2],-b[1]];if(!overlaps(runtime,work))continue;const list=groups.get(p.id)??[];list.push(p);groups.set(p.id,list);}
  // Include all pieces belonging to a selected multipart source identity, matching the native reader.
  for(const id of groups.keys())groups.set(id,parts.filter(p=>p.id===id));
  return{schemaVersion:1,kind:'source-bound-unqualified-new-bridge-polygons',originId,source:{streetParts:source.file,sha256:source.sha256},region,exclusionHaloMetres:halo,
    parts:[...groups].sort(([a],[b])=>a.localeCompare(b)).map(([partId,polygons])=>({partId,main:'Silta',name:String(polygons[0]!.properties.kadunnimi??polygons[0]!.properties.nimi??''),polygonsRuntimeXZ:polygons.map(p=>p.rings.map(r=>r.map(([x,y])=>[x,-y]))),reason:'Unqualified deck: exclude this named municipal surface until source height, both approaches and physical support are qualified.'})),
    qualification:'SOURCE_BOUND_EXCLUSIONS_ONLY_NOT_BRIDGE_ACCEPTANCE'};
}

function readSnapshot(root:string,id:string,snapshotName:string,jobSha256:string):SourceSnapshot{
  const directory=sourceFile(root,id),ledger=pin(sourceFile(directory,'ledger.json')),document=JSON.parse(pinned(ledger).toString()),snapshot=document.snapshots?.[snapshotName];
  assert.ok(snapshot,'Missing completed '+id+' snapshot');assert.equal(snapshot.sourceJobSha256,jobSha256,'Mixed acquisition jobs');assert.ok(document.source?.license&&document.source?.attribution&&document.source?.crs,'Source provenance missing');
  const payload=pin(sourceFile(directory,snapshot.path));assert.equal(payload.sha256,snapshot.sha256,'Snapshot changed: '+id);
  if(snapshotName.includes('/'))throw new Error('Invalid snapshot name');
  if(['lod2','terrain','trees-street','trees-plot'].includes(id)){
    assert.equal(document.source.heightDatum,'N2000','Unknown height datum');const index=JSON.parse(pinned(payload).toString());assert.ok(Array.isArray(index.tiles)&&index.tiles.length>0);
    for(const tile of index.tiles)readSourceFile(path.dirname(payload.file),{path:tile.file,bytes:tile.bytes,sha256:tile.sha256});
  }else if(id==='osm')assert.deepEqual(snapshot.missingReferences,[],'Incomplete OSM closure');
  return{root:directory,ledger,payload,snapshot,source:document.source};
}

export function prepareExpansionBuild(options:PrepareExpansionBuildOptions){
  const out=path.resolve(options.out);assert.ok(!fs.existsSync(out),'Fresh build job directory required');
  assert.ok(fs.existsSync(path.join(options.sources,'acquisition-report.json')),'Acquisition is incomplete: the completed acquisition-report.json is required before preparing a source build');
  const profile= json(options.profile),scope=json(options.scope);assert.equal(scope.schemaVersion,1);assert.equal(profile.schemaVersion,1);assert.equal(options.regionId,profile.regionId);
  if(profile.requirePreparedRawTerrain)assert.ok(options.rawTerrain,'Cumulative profile requires --raw-terrain from the separately qualified shared source build');
  assert.match(options.snapshot,/^[a-z0-9][a-z0-9-]{0,95}$/);
  const acceptedRoot=fs.realpathSync(options.acceptedWorld),manifestPin=pin(sourceFile(acceptedRoot,'manifest.json')),manifest=JSON.parse(pinned(manifestPin).toString())as WorldManifest;
  assert.equal(manifestPin.sha256,scope.acceptedManifestSha256);assert.equal(manifest.origin.id,scope.originId);assert.deepEqual(manifest.origin.originProjected,scope.originProjected);assert.equal(manifest.cellSize,scope.cellSize);if(scope.acceptedCellCount!==undefined)assert.equal(manifest.cells.length,scope.acceptedCellCount);
  const coverage=verifyAcceptedCoverage({source:acceptedRoot,expectedManifestSha256:manifestPin.sha256,coverage:options.acceptedCoverage});
  const oldRuntime=parseTerrain(decodeDeliverySimulation(readDeliveryFile(acceptedRoot,manifest.terrain),manifest.terrain)),acceptedBounds=bounds(oldRuntime),packet=resolveExpansionPacket(scope,profile,options.regionId,acceptedBounds),{region,direction,composition}=packet,extent=packet.terrainExtent;
  const sourceTerrainDocument=pin(path.join(options.acceptedSourceTerrain,'terrain.json')),sourceTerrain=json(sourceTerrainDocument.file),sourceTerrainPin=pin(sourceFile(options.acceptedSourceTerrain,sourceTerrain.file));
  assert.equal(sourceTerrainPin.sha256,profile.sourceTerrainSha256,'Authoring terrain pin differs');assert.equal(sourceTerrainPin.sha256,sourceTerrain.sha256);assert.equal(sourceTerrain.originId,manifest.origin.id);assert.deepEqual(bounds(parseTerrain(pinned(sourceTerrainPin))),acceptedBounds,'Authoring and accepted runtime extents differ');
  const treeProfile=pin(options.treeProfile),treeAsset=pin(options.treeAsset),treeReport=JSON.parse(pinned(treeProfile).toString()),tree=manifest.assets.find(a=>a.id==='scenery-trees');
  assert.ok(tree);assert.equal(treeProfile.sha256,profile.treeProfileSha256);assert.equal(treeAsset.sha256,profile.treeAssetSha256);assert.equal(treeAsset.sha256,tree.sha256);assert.equal(treeReport.assets?.['scenery-trees']?.glb?.sha256,tree.sha256);readDeliveryFile(acceptedRoot,tree);
  const {report:acquisition,reportPin:acquisitionPin,jobPin:acquisitionJob}=readExpansionAcquisition(options.sources);
  const sources:Record<string,SourceSnapshot>={};for(const id of['lod2','terrain','trees-street','trees-plot','building-register','street-parts','osm'])sources[id]=readSnapshot(options.sources,id,options.snapshot,acquisition.jobSha256);
  assert.equal(sources.lod2!.snapshot.tilesetVersion,profile.lod2TilesetVersion,'Unqualified LoD2 vintage');
  const conflictPins=Object.entries(sources).filter(([,s])=>Number(s.snapshot.conflicts)>0).map(([id,s])=>{const p=pin(sourceFile(s.root,'conflicts.json'));assert.equal(p.sha256,s.snapshot.conflictsSha256);return{id,...p};});
  let conflictReview:InputPin|undefined;if(conflictPins.length){assert.ok(options.conflictReview,'Source conflicts require --conflict-review before geometry preparation');conflictReview=pin(options.conflictReview);const review=JSON.parse(pinned(conflictReview).toString());assert.ok(review.status==='QUALIFIED_FOR_EXPANSION_SOURCE_BUILD'||review.status==='QUALIFIED_FOR_STAGE_A_SOURCE_BUILD'&&options.regionId==='a-hietalahti-punavuori','Conflict review is not qualified for this expansion');assert.ok(review.regionId===options.regionId||Array.isArray(review.regionIds)&&review.regionIds.includes(options.regionId));assert.equal(review.jobSha256,acquisition.jobSha256);assert.deepEqual(review.conflicts.map((r:any)=>({id:r.id,sha256:r.sha256})).sort((a:any,b:any)=>a.id.localeCompare(b.id)),conflictPins.map(p=>({id:p.id,sha256:p.sha256})).sort((a,b)=>a.id.localeCompare(b.id)));assert.ok(review.disposition&&typeof review.disposition==='string');}
  const [E0,N0]=scope.originProjected,required=[E0+region[0]-scope.sourceHaloMetres,N0-region[3]-scope.sourceHaloMetres,E0+region[2]+scope.sourceHaloMetres,N0-region[1]+scope.sourceHaloMetres];
  for(const s of Object.values(sources)){const b=s.snapshot.bboxEN;assert.ok(b?.length===4&&b[0]<=required[0]&&b[1]<=required[1]&&b[2]>=required[2]&&b[3]>=required[3],'Acquisition lacks requested packet source halo');}
  const originPin=pin(path.join(producerRoot,'content/helsinki/world-origin.json'));assert.equal(json(originPin.file).id,scope.originId);assert.deepEqual(json(originPin.file).originProjected,scope.originProjected);
  const cellTemplate=pin(sourceFile(path.dirname(options.profile),profile.cells)),roadTemplate=pin(sourceFile(path.dirname(options.profile),profile.roads));
  const pins:Record<string,InputPin>={scope:pin(options.scope),profile:pin(options.profile),manifest:manifestPin,sourceTerrainDocument,sourceTerrain:sourceTerrainPin,treeProfile,treeAsset,acquisition:acquisitionPin,acquisitionJob,origin:originPin,cellTemplate,roadTemplate,landmarks:pin(path.join(producerRoot,'content/helsinki/landmarks.json')),preparer:pin(import.meta.filename),distantBuilder:pin(path.join(producerRoot,'tools/world/build_distant_cells.mjs')),lock:pin(path.join(producerRoot,'pnpm-lock.yaml')),...(conflictReview?{conflictReview}:{})};
  if(options.rawTerrain){const raw=inspectExpansionRawTerrain(options.rawTerrain,sources.terrain!.snapshot.sha256,profile.requireRawTerrainProducer===true,composition.map(p=>p.region));if(raw.inputDigests)assert.equal(raw.inputDigests.originSha256,originPin.sha256,'Raw terrain uses a different origin input');pins.rawTerrainDocument=raw.document;pins.rawTerrain=raw.binary;}
  for(const input of[options.sources,options.acceptedSourceTerrain,options.acceptedCoverage,options.convertedModel,options.rawTerrain].filter((p):p is string=>typeof p==='string')){const root=fs.realpathSync(input);assert.ok(out!==root&&!out.startsWith(root+path.sep),'Build job may not be inside an immutable input');}
  freshDeliveryDirectory(acceptedRoot,out);
  const outputs=Object.fromEntries(['model-full','model-stage-a','terrain-raw','terrain-source','terrain-runtime-seed','roads-source','trees-source','trees-stage-a','cells-native','delivery-cells'].map(name=>[name,path.join(out,name)]));
  if(options.convertedModel)outputs['model-full']=fs.realpathSync(options.convertedModel);
  if(options.rawTerrain)outputs['terrain-raw']=fs.realpathSync(options.rawTerrain);
  writeSourceJson(out,'extent.json',{schemaVersion:1,cellSize:manifest.cellSize,playArea:area(extent)});
  writeSourceJson(out,'trees-config.json',{schemaVersion:1,cellSize:manifest.cellSize,playArea:area(region)});
  const roads=JSON.parse(pinned(roadTemplate).toString());roads.playArea=area(extent);writeSourceJson(out,'roads-config.json',roads);
  const parts=loadGeoJsonPolygons(sources['street-parts']!.payload.file,E0,N0,(p,i)=>String(p.osan_id??p.id??i)),exclusions=expansionBridgeExclusions(parts,sources['street-parts']!.payload,scope.originId,region,profile.exclusionHaloMetres);
  writeSourceJson(out,'ground-exclusions.json',exclusions);readDeliveryGroundExclusions(path.join(out,'ground-exclusions.json'),sources['street-parts']!.payload.file,parts);
  const job:BuildJob={schemaVersion:1,kind:'qualified-source-expansion-build-job',root:out,sourceRoot:producerRoot,snapshot:options.snapshot,regionId:options.regionId,region,direction,composition,rawTerrainProducerRequired:profile.requireRawTerrainProducer===true,acceptedBounds,terrainExtent:extent,origin:manifest.origin,acceptedWorld:acceptedRoot,acceptedCoverage:fs.realpathSync(options.acceptedCoverage),acceptedManifestSha256:manifestPin.sha256,coverageIndexSha256:coverage.indexSha256,pins,sources,outputs,commands:[],rolloutPolicy:'Keep the original 515-cell baseline for cumulative unpublished candidates. Stage A enlarges the terrain envelope without filling its whole width. Build A+B+C cumulatively against the original accepted authority (south stops at original terrain maxX), then include west; do not treat Stage A terrain bounds as accepted playable coverage or use this frontier adapter to fill arbitrary interior holes. Composition order is the explicit corner replacement priority; each packet uses half-open building/tree ownership.'};
  const command=(id:string,args:string[])=>job.commands.push({id,program:'node',args,dependsOn:job.commands.length?[job.commands.at(-1)!.id]:[]}),phase=(id:string)=>command(id,['tools/world/prepare_expansion_build.ts','--phase',id,'--job',path.join(out,'build-job.json')]);
  if(!options.convertedModel)command('convert-model',['tools/world/convert_city_model.ts','--ledger',sources.lod2!.ledger.file,'--snapshot',options.snapshot,'--origin',originPin.file,'--out',outputs['model-full']!]);
  if(!options.rawTerrain)command('build-raw-terrain',['tools/world/build_terrain.ts','--tiles',path.dirname(sources.terrain!.payload.file),'--ledger',sources.terrain!.ledger.file,'--origin',originPin.file,'--config',path.join(out,'extent.json'),'--resolution','1','--out',outputs['terrain-raw']!]);
  phase('terrain');phase('model');
  command('build-source-roads',['tools/world/build_roads.ts','--osm-ledger',sources.osm!.ledger.file,'--snapshot',options.snapshot,'--origin',originPin.file,'--config',path.join(out,'roads-config.json'),'--terrain',path.join(outputs['terrain-source']!,'terrain.bin'),'--street-parts',sources['street-parts']!.payload.file,'--out',outputs['roads-source']!]);
  command('build-source-trees',['tools/world/build_trees.ts','--ledgers',[sources['trees-street']!.ledger.file,sources['trees-plot']!.ledger.file].join(','),'--snapshot',options.snapshot,'--terrain',outputs['terrain-source']!,'--roads',path.join(outputs['roads-source']!,'roads.json'),'--footprints',sources['building-register']!.payload.file,'--models',treeProfile.file,'--config',path.join(out,'trees-config.json'),'--origin',originPin.file,'--out',outputs['trees-source']!]);phase('trees');
  command('build-native-cells',['tools/world/build_cells.ts','--city-model',outputs['model-stage-a']!,'--terrain',outputs['terrain-source']!,'--footprints',sources['building-register']!.payload.file,'--street-parts',sources['street-parts']!.payload.file,'--landmarks',path.join(producerRoot,'content/helsinki/landmarks.json'),'--osm-ledger',sources.osm!.ledger.file,'--osm-snapshot',options.snapshot,'--trees',outputs['trees-stage-a']!,'--config',path.join(out,'cells-config.json'),'--origin',originPin.file,'--ground-region='+region.join(','),'--exclude-ground-cells',job.acceptedCoverage,'--ground-exclusions',path.join(out,'ground-exclusions.json'),'--ground-cache-out',path.join(out,'native-cache'),'--accepted-building-manifest',manifestPin.file,'--out',outputs['cells-native']!]);
  phase('distant-inputs');command('build-distant-cells',['tools/world/build_distant_cells.mjs','--cells',outputs['cells-native']!]);phase('delivery');
  // Commands are structured argv, never interpolated shell strings or executed by this preparer.
  for(const p of Object.values(pins))pinned(p);writeSourceJson(out,'build-job.json',job);
  return{status:'PASS_SOURCE_BUILD_JOB_PREPARED',job:path.join(out,'build-job.json'),packet:{regionId:options.regionId,region,direction,terrainExtent:extent,composition},commands:job.commands,excludedBridgeParts:exclusions.parts.map(p=>p.partId),remainingGates:['Qualified merged roads preserving accepted records or explicitly validated outside-only repairs','Source-qualified supported-area polygon; no bounding-rectangle default','Native asset, physical support, runtime traversal and performance gates']};
}

function loadJob(file:string):BuildJob{
  const job=json(file)as BuildJob;assert.equal(job.schemaVersion,1);assert.equal(job.kind,'qualified-source-expansion-build-job');assert.equal(path.resolve(file),path.join(job.root,'build-job.json'));
  assert.equal(job.sourceRoot,producerRoot,'Build job belongs to another producer checkout');for(const[name,output]of Object.entries(job.outputs))if(name!=='model-full'&&name!=='terrain-raw')assert.equal(output,path.join(job.root,name),'Build output escapes its job');
  for(const p of Object.values(job.pins))pinned(p);for(const s of Object.values(job.sources)){pinned(s.ledger);pinned(s.payload);}return job;
}
function writeTerrain(root:string,terrain:TerrainGrid,originId:string,source:unknown){
  assert.ok(!fs.existsSync(root),'Fresh terrain derivative required');fs.mkdirSync(root,{recursive:true});const bytes=encodeTerrain(terrain);fs.writeFileSync(path.join(root,'terrain.bin'),bytes,{flag:'wx'});
  writeSourceJson(root,'terrain.json',{schemaVersion:1,kind:'terrain-heightfield',originId,file:'terrain.bin',bytes:bytes.length,sha256:sourceSha256(bytes),x0:terrain.x0,z0:terrain.z0,nx:terrain.nx,nz:terrain.nz,resolution:terrain.resolution,source});return{bytes:bytes.length,sha256:sourceSha256(bytes)};
}
/** The distant builder updates cells.json in place. Retain the exact native detail
 * index/report first, then prove it added only the derived coarse descriptors. */
export function prepareExpansionDistantInputs(jobFile:string){
  const job=loadJob(jobFile),native=job.outputs['cells-native']!,index=pin(path.join(native,'cells.json')),report=pin(path.join(native,'report.json')),document=JSON.parse(pinned(index).toString());assert.ok(document.cells.length>0&&document.cells.every((c:any)=>!c.visual.lod2),'Distant preparation requires fresh detailed native cells');
  const copies=[['native-detail-index.json',index],['native-detail-report.json',report]]as const;for(const[name,ref]of copies)fs.writeFileSync(path.join(job.root,name),pinned(ref),{flag:'wx'});
  const receipt={status:'PASS_NATIVE_DETAIL_ARCHIVED_BEFORE_DISTANT_BUILD',index,report,distantBuilder:job.pins.distantBuilder};writeSourceJson(job.root,'native-detail-receipt.json',receipt);return receipt;
}
export async function prepareExpansionDelivery(jobFile:string){
  const job=loadJob(jobFile),native=job.outputs['cells-native']!,archive=json(path.join(job.root,'native-detail-receipt.json')),oldIndex=fs.readFileSync(path.join(job.root,'native-detail-index.json')),oldReport=fs.readFileSync(path.join(job.root,'native-detail-report.json'));assert.equal(sourceSha256(oldIndex),archive.index.sha256);assert.equal(sourceSha256(oldReport),archive.report.sha256);assert.equal(sourceSha256(fs.readFileSync(path.join(native,'report.json'))),archive.report.sha256,'Distant build changed native report');
  const index=pin(path.join(native,'cells.json')),document=JSON.parse(pinned(index).toString()),before=JSON.parse(oldIndex.toString()),distant=json(path.join(native,'distant-report.json'));assert.equal(distant.toolSha256,job.pins.distantBuilder!.sha256,'Unpinned distant producer');assert.equal(document.cells.length,before.cells.length);assert.equal(distant.cells.length,document.cells.length);const stripped=structuredClone(document);for(let i=0;i<document.cells.length;i++){const c=document.cells[i];assert.ok(c.visual.lod2,'Native cells lack distant geometry; run build-distant-cells first');const record=distant.cells[i];assert.equal(record.cell,c.id);for(const key of Object.keys(c.visual.lod2))assert.deepEqual(record[key],c.visual.lod2[key]);delete stripped.cells[i].visual.lod2;}assert.deepEqual(stripped,before,'Distant build changed detailed native content');
  return prepareNewDeliveryCells({nativeCells:native,expectedIndexSha256:index.sha256,acceptedWorld:job.acceptedWorld,expectedManifestSha256:job.acceptedManifestSha256,out:job.outputs['delivery-cells']!});
}
export function prepareExpansionTerrain(jobFile:string){
  const job=loadJob(jobFile),rawLineage=inspectExpansionRawTerrain(job.outputs['terrain-raw']!,job.sources.terrain!.snapshot.sha256,job.rawTerrainProducerRequired,job.composition?.map(p=>p.region)??[job.region]),rawDoc=JSON.parse(pinned(rawLineage.document).toString()),raw=rawLineage.binary;assert.equal(rawDoc.originId,job.origin.id);if(rawLineage.inputDigests&&job.pins.origin)assert.equal(rawLineage.inputDigests.originSha256,job.pins.origin.sha256);
  const grid=sliceExpansionTerrain(parseTerrain(pinned(raw)),job.terrainExtent);const authoring=extendTerrainPreservingBase(parseTerrain(pinned(job.pins.sourceTerrain!)),grid),manifest=JSON.parse(pinned(job.pins.manifest!).toString())as WorldManifest,acceptedRaw=decodeDeliverySimulation(readDeliveryFile(job.acceptedWorld,manifest.terrain),manifest.terrain),runtime=extendTerrainPreservingBase(parseTerrain(acceptedRaw),grid);
  const source=writeTerrain(job.outputs['terrain-source']!,authoring.terrain,job.origin.id,{kind:'authoring-extension',baseSha256:job.pins.sourceTerrain!.sha256,expandedSha256:raw.sha256,rawLineage,...authoring.audit}),seed=writeTerrain(job.outputs['terrain-runtime-seed']!,runtime.terrain,job.origin.id,{kind:'accepted-runtime-seed-only',baseSha256:sourceSha256(acceptedRaw),expandedSha256:raw.sha256,rawLineage,...runtime.audit,note:'Do not feed safety terrain to visual ground assembly. Final append repeats accepted sample preservation after native lowering.'});
  const receipt={status:'PASS_SOURCE_AND_RUNTIME_TERRAIN_SEPARATED',authoring:source,runtimeSeed:seed,rawLineage,authoringBaseSha256:job.pins.sourceTerrain!.sha256,acceptedRuntimeSha256:sourceSha256(acceptedRaw)};writeSourceJson(job.root,'terrain-receipt.json',receipt);return receipt;
}

export function prepareExpansionModel(jobFile:string){
  const job=loadJob(jobFile),input=job.outputs['model-full']!,output=job.outputs['model-stage-a']!,bytes=fs.readFileSync(path.join(input,'city-model.json')),model=JSON.parse(bytes.toString()),manifest=JSON.parse(pinned(job.pins.manifest!).toString())as WorldManifest;
  assert.equal(model.source.snapshotSha256,job.sources.lod2!.snapshot.sha256);assert.equal(model.source.tilesetVersion,job.sources.lod2!.snapshot.tilesetVersion);const selected=selectExpansionBuildings(model,manifest,job.region,job.composition?.map(p=>({id:p.id,region:p.region})));assert.ok(selected.model.buildings.length>0,'No qualified new building owners in region');
  freshDeliveryDirectory(input,output);const copy=(file:string,expected:string,expectedBytes?:number)=>{const source=sourceFile(input,file),info=fs.statSync(source),target=sourceFile(output,file);assert.equal(expectedBytes??info.size,info.size);fs.mkdirSync(path.dirname(target),{recursive:true});linkOrCopyDeliveryFile(source,target,{path:file,bytes:info.size,sha256:expected});};
  copy(model.binary.file,model.binary.sha256,model.binary.bytes);const texturePins=selected.model.textures.map((texture:any)=>pin(sourceFile(input,texture.file)));for(const texture of texturePins)copy(path.relative(input,texture.file).replaceAll('\\','/'),texture.sha256);
  const modelRef=writeSourceJson(output,'city-model.json',selected.model),config=JSON.parse(pinned(job.pins.cellTemplate!).toString());config.playArea=area(job.terrainExtent);config.carriagewayGrade.protectedArea=area(job.acceptedBounds);config.curatedFacades='none-new-strips';config.continuation={kind:'current-vintage-new-strips-only',acceptedSourceManifestSha256:job.acceptedManifestSha256,acceptedCoverageIndexSha256:job.coverageIndexSha256,protectedPlayArea:area(job.acceptedBounds),appendRegionXZ:job.region,modelSha256:modelRef.sha256,sourceSnapshotSha256:model.source.snapshotSha256,sourceTilesetVersion:model.source.tilesetVersion};
  authorizeNewStripFacades(config,fs.readFileSync(path.join(output,'city-model.json')),fs.readFileSync(path.join(job.acceptedCoverage,'cells.json')),pinned(job.pins.manifest!));writeSourceJson(job.root,'cells-config.json',config);
  const receipt={status:'PASS_NEW_BUILDING_OWNERS_AND_CONFIG_BOUND',sourceModelSha256:sourceSha256(bytes),model:modelRef,buildings:selected.model.buildings.length,excluded:selected.excluded,packetOwnership:selected.ownership,composition:job.composition??null,textureIndexMap:selected.textureIndexMap,derivedTexturePins:texturePins,binaryDescriptorUnchanged:true,acceptedManifestSha256:job.acceptedManifestSha256};writeSourceJson(job.root,'model-receipt.json',receipt);return receipt;
}

export function prepareExpansionTrees(jobFile:string){
  const job=loadJob(jobFile),manifest=JSON.parse(pinned(job.pins.manifest!).toString())as WorldManifest;assert.ok(manifest.scenery);const scenery=JSON.parse(readDeliveryFile(job.acceptedWorld,manifest.scenery).toString()),accepted=new Set(scenery.instances.map((i:any)=>i.id)),source=pin(path.join(job.outputs['trees-source']!,'trees.json')),trees=JSON.parse(pinned(source).toString());assert.equal(trees.originId,job.origin.id);assert.equal(trees.assetSha256,job.pins.treeAsset!.sha256);
  const seen=new Set<string>(),excluded:any[]=[],kept=trees.trees.filter((tree:any)=>{assert.ok(!seen.has(tree.id),'Duplicate generated tree identity');seen.add(tree.id);assert.ok(tree.position?.length===3&&tree.position.every(Number.isFinite));const reason=accepted.has(tree.id)?'accepted-instance':inside(tree.position[0],tree.position[2],job.region)?null:'outside-half-open-region';if(reason)excluded.push({id:tree.id,reason});return reason===null;});
  const output=job.outputs['trees-stage-a']!;freshDeliveryDirectory(job.outputs['trees-source']!,output);writeSourceJson(output,'trees.json',{...trees,trees:kept});const receipt={status:'PASS_NEW_TREE_IDENTITIES_FILTERED_SUPPORT_REVIEW_REQUIRED',sourceSha256:source.sha256,trees:kept.length,excluded,assetSha256:job.pins.treeAsset!.sha256,acceptedManifestSha256:job.acceptedManifestSha256};writeSourceJson(output,'trees-report.json',receipt);return receipt;
}
