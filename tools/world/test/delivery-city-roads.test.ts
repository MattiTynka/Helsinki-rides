import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {RoadGraph} from '../../../packages/world-schema/src/index.ts';
import {assertAcceptedRoadPrefix,prepareAppendRoads} from '../lib/delivery-city-roads.ts';
import {assertOutsideOnlyRoadGraphRepair} from '../lib/road-outside-repair.ts';
import {sourceSha256} from '../lib/source-files.ts';

const accepted=():RoadGraph=>({schemaVersion:2,originId:'fixture',source:{id:'source',sha256:'a'.repeat(64),attribution:'Fixture',license:'CC0'},nodes:[{id:'a',kind:'junction',position:[-2,0,0]},{id:'b',kind:'junction',position:[2,0,0]}],lanes:[{id:'lane',wayId:1,name:'Fixture road',highway:'residential',surface:'asphalt',speedLimit:10,width:3,from:'a',to:'b',length:4,index:0,count:1,points:[[-2,0,0],[2,0,0]]}],connectors:[],parking:[],footways:[]});
const coverage={playArea:{minX:-10,maxX:0,minZ:-10,maxZ:10}};
const hashes={manifest:'b'.repeat(64),roads:'c'.repeat(64),mask:'d'.repeat(64),native:'e'.repeat(64),cache:'f'.repeat(64),collision:'1'.repeat(64)};
const authority=(graph:RoadGraph)=>({accepted:graph,acceptedManifestSha256:hashes.manifest,acceptedRoadsSha256:hashes.roads,gameplay:coverage,supportedAreaSha256:hashes.mask,nativeIndices:[hashes.native],nativeCaches:[hashes.cache],collisions:[{kind:'new' as const,cell:'new-cell',decodedSha256:hashes.collision}]});
function fixture(run:(root:string)=>void){const root=fs.mkdtempSync(path.join(os.tmpdir(),'helsinki-delivery-road-'));try{run(root);}finally{assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(root).startsWith('helsinki-delivery-road-'));fs.rmSync(root,{recursive:true,force:true});}}
function write(root:string,name:string,value:unknown){const bytes=Buffer.from(JSON.stringify(value)+'\n'),file=path.join(root,name);fs.writeFileSync(file,bytes);return{file,bytes:bytes.length,sha256:sourceSha256(bytes)};}

test('default append preserves accepted prefixes, metadata and unique IDs across every road record group',()=>fixture(root=>{
 const before=accepted(),merged={...before,footways:[{id:'new-footway',points:[[1,0,1],[2,0,1]]as [number,number,number][]}]},roads=write(root,'roads.json',merged),result=prepareAppendRoads({roads},authority(before));assert.equal(result.proof.acceptedRecordsPreserved,true);assert.equal(result.proof.roadMergeReceiptSha256,null);result.verifyInputs();
 const changed=structuredClone(merged);(changed.lanes[0]!.points as [number,number,number][])[0]=[-2,1,0];assert.throws(()=>assertAcceptedRoadPrefix(before,changed),/change accepted/);
 assert.throws(()=>assertAcceptedRoadPrefix(before,{...merged,source:{...merged.source,id:'other'}}),/change accepted/);assert.throws(()=>assertAcceptedRoadPrefix(before,{...merged,nodes:[...merged.nodes].reverse()}),/change accepted/);assert.throws(()=>assertAcceptedRoadPrefix(before,{...merged,lanes:[]}),/remove accepted/);assert.throws(()=>assertAcceptedRoadPrefix(before,{...merged,footways:[...merged.footways,...merged.footways]}),/Duplicate/);
 fs.appendFileSync(roads.file,' ');assert.throws(result.verifyInputs,/changed during append|length changed/);
}));

for(const kind of ['lanes','footways']as const)test(`outside-only ${kind} repair requires the exact final mask/serialized-HCOL merge and complete changed-record witnesses`,()=>fixture(root=>{
 const before:RoadGraph={...accepted(),footways:kind==='footways'?[{id:'retained-footway',points:[[-2,0,0],[2,0,0]]}]:[]};
 const repaired=structuredClone(before);(repaired[kind][0] as any).points=[[-2,0,0],[0,0,0],[1,1,0],[2,2,0]];const changes=assertOutsideOnlyRoadGraphRepair(before,repaired,coverage),repairedRef=write(root,'repaired.json',repaired),nativeMetadata=write(root,'native.json',{cache:{sha256:hashes.cache}}),projection={schemaVersion:1,kind:'source-bound-outside-road-projection',status:'PROJECTED_PENDING_SUPPORTED_AREA_SERIALIZED_HCOL_AND_TRAVEL',acceptedManifestSha256:hashes.manifest,acceptedRoadsSha256:hashes.roads,nativeMetadata,nativeCacheSha256:hashes.cache,repairedAcceptedRoads:repairedRef,changes},outsideProjection=write(root,'projection.json',projection),roads=write(root,'roads.json',repaired),merge={schemaVersion:1,status:'PASS_SOURCE_QUALIFIED_ROAD_MERGE_PENDING_RUNTIME',acceptedManifestSha256:hashes.manifest,acceptedRoadsSha256:hashes.roads,mergedRoadsSha256:roads.sha256,acceptedPlayablePiecewiseGeometryPreserved:true,acceptedRecordsPreserved:false,expandedSupportedAreaSha256:hashes.mask,nativeCellsIndexSha256:hashes.native,supportInputs:[{kind:'new',cell:'new-cell',decodedSha256:hashes.collision}],outsideProjection:{receiptSha256:outsideProjection.sha256,repairedAcceptedRoadsSha256:repairedRef.sha256,changes}},roadMerge=write(root,'merge.json',merge),input={roads,outsideProjection,roadMerge};
 const result=prepareAppendRoads(input,authority(before));assert.equal(result.proof.acceptedRecordsPreserved,false);assert.deepEqual(result.proof.changes,changes);assert.equal(result.proof.acceptedPlayablePiecewiseGeometryPreserved,true);
 assert.throws(()=>prepareAppendRoads({roads},authority(before)),/change accepted/);assert.throws(()=>prepareAppendRoads({roads,outsideProjection},authority(before)),/requires a source-qualified/);
 for(const edit of[{status:'PROJECTED_PENDING_RUNTIME'},{expandedSupportedAreaSha256:'0'.repeat(64)},{nativeCellsIndexSha256:'0'.repeat(64)},{supportInputs:[{kind:'new',cell:'new-cell',decodedSha256:'0'.repeat(64)}]},{outsideProjection:{...merge.outsideProjection,changes:[]}}]){const bad=write(root,'bad-merge.json',{...merge,...edit});assert.throws(()=>prepareAppendRoads({...input,roadMerge:bad},authority(before)));}
 const noWitness=write(root,'bad-projection.json',{...projection,changes:[]});assert.throws(()=>prepareAppendRoads({...input,outsideProjection:noWitness},authority(before)),/witnesses differ/);
 const insideChanged=structuredClone(repaired);(insideChanged[kind][0] as any).points[1]=[0,.25,0];const wrong=write(root,'wrong-repair.json',insideChanged),badProjection=write(root,'inside-projection.json',{...projection,repairedAcceptedRoads:wrong});assert.throws(()=>prepareAppendRoads({...input,outsideProjection:badProjection},authority(before)),/accepted piecewise height|protected boundary interpolation/);
}));
