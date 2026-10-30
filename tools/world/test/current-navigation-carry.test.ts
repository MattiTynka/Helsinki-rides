import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs';
import{decodeRoadGraph,type RoadGraph}from'../../../packages/world-schema/src/index.ts';import{decodeDeliverySimulation}from'../lib/delivery-city-payloads.ts';import{readSourceFile,sourceSha256}from'../lib/source-files.ts';
import{prepareCurrentNavigationCarry,carryCurrentNavigation,assertCurrentNavigationCarry,currentCarryIds,type CurrentNavigationCarry}from'../lib/current-navigation-carry.ts';
import{repairNewStraightConnectorOvershoot}from'../lib/road-connector-repair.ts';import{verifyConnectorProjectionRepair}from'../lib/connector-projection-authority.ts';
import{currentOriginalNavigation}from'../lib/current-navigation-carry.ts';
import{assertOutsideOnlyRoadGraphRepair,repairOutsidePolyline,assertOutsideOnlyPolylineRepair}from'../lib/road-outside-repair.ts';
import{assertCurrentPlayableNavigationPreserved}from'../lib/delivery-navigation-preservation.ts';
const candidateFile='../evidence/current-a-carry-through-audit-v1/unified-repro-v2/unified-raw-source-candidate.json',available=fs.existsSync(candidateFile);
const pin=(file:string)=>({file,sha256:sourceSha256(fs.readFileSync(file))});
export function currentCarryFixture(){
 const originalWorld={directory:'../accepted-world/world/senate-20261025-civilian-flee',manifestSha256:'0e18e55e8730f01144eef72a80decffbb53cdd658222f87a7e8ad6f75f2c4260'},currentWorld={directory:'../work/cumulative-city-east-walking-seam-v1/world',manifestSha256:'d453fdd79db114c914322f0209121c34819206b294004bdcece2739f0f3b4701'};
 const graph=(w:typeof originalWorld)=>{const m=JSON.parse(fs.readFileSync(w.directory+'/manifest.json','utf8'));return decodeRoadGraph(decodeDeliverySimulation(readSourceFile(w.directory,m.roads),m.roads));},sourceMask=pin('../evidence/w29282225-supported-area-source-qualified-v4.json'),mask=JSON.parse(fs.readFileSync(sourceMask.file,'utf8'));
 const binding={historicalOsm:pin('../sources/raw-v1/osm/southwest-20261029.json'),candidateOsm:pin('../sources/raw-v2/osm/southwest-cumulative-20261029.json'),sourceMask};
 const context={original:graph(originalWorld),current:graph(currentWorld),rawCandidate:decodeRoadGraph(fs.readFileSync(candidateFile)),originalWorld,currentWorld,coverage:{playArea:mask.qualification.expanded,supportedArea:mask.supportedArea},read:(p:{file:string;sha256:string},cap=64*1024*1024)=>{const stat=fs.lstatSync(p.file);assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=cap);return fs.readFileSync(p.file);}};
 return{binding,context};
}
let loaded:ReturnType<typeof currentCarryFixture>,prepared:ReturnType<typeof prepareCurrentNavigationCarry>;
function load(){if(!prepared){loaded=currentCarryFixture();prepared=prepareCurrentNavigationCarry(loaded.binding,loaded.context);}return{...loaded,prepared};}
test('fabricated current carry cannot bypass actual world authority',()=>{assert.throws(()=>currentCarryIds({}as CurrentNavigationCarry,'lanes'),/Unrecognized/);});
test('actual43 additions are derived, detached and restored without source or access waiver',{skip:!available},()=>{
 const{context,prepared:q}=load();assert.equal(q.receipt.records.length,43);assert.equal(q.receipt.paths.length,35);assert.equal(q.receipt.junctions.length,102);
 const carried=carryCurrentNavigation(q.authority,context.original,context.original);assert.ok(assertCurrentNavigationCarry(q.authority,context.original,context.current,carried));assert.equal(carried.lanes.length,context.original.lanes.length+16);assert.equal(carried.footways.length,context.original.footways.length+2);
 const id=currentCarryIds(q.authority,'lanes')[0]!,lane=carried.lanes.find(x=>x.id===id)!;(lane.points[0]as number[])[1]!+=.000001;assert.throws(()=>assertCurrentNavigationCarry(q.authority,context.original,context.current,carried),/changed/);q.verifyInputs();
});

test('seven actual-current original repairs are separate outside-only data and preserve current coverage',{skip:!available},()=>{
 const{context,prepared:q}=load(),value=currentOriginalNavigation(q.authority,context.original);
 assert.equal(q.receipt.originalOutsideRepairCount,7);assert.equal(q.receipt.records.length,43);assert.equal(value.repairs.length,7);
 const m=JSON.parse(fs.readFileSync(context.originalWorld.directory+'/manifest.json','utf8')),coverage=JSON.parse(decodeDeliverySimulation(readSourceFile(context.originalWorld.directory,m.gameplay),m.gameplay).toString());
 assert.equal(assertOutsideOnlyRoadGraphRepair(context.original,value.baseline,coverage).length,7);
 const next=carryCurrentNavigation(q.authority,context.original,value.baseline),preserved=assertCurrentPlayableNavigationPreserved(context.current,next,value.coverage,context.original);
 assert.equal(preserved.earlierExpansionRecordsPreserved,43);assert.equal(preserved.reviewedHeightCorrections.length,0);assert.equal(preserved.continuousCurrentPlayableGeometryPreserved,true);
 const reverted=carryCurrentNavigation(q.authority,context.original,context.original);assert.throws(()=>assertCurrentPlayableNavigationPreserved(context.current,reverted,value.coverage,context.original),/protected road/);
 value.baseline.lanes.find(r=>r.id==='122948203:0:f0')!.points[0]![1]+=1;assert.notDeepEqual(value.baseline,currentOriginalNavigation(q.authority,context.original).baseline);
 assert.throws(()=>currentOriginalNavigation({}as CurrentNavigationCarry,context.original),/Unrecognized/);
});

test('actual current-mask near-endpoint cuts retain the literal protected lane and footway vertices',{skip:!available},()=>{
 const{context,prepared:q}=load(),value=currentOriginalNavigation(q.authority,context.original),m=JSON.parse(fs.readFileSync(context.originalWorld.directory+'/manifest.json','utf8')),originalCoverage=JSON.parse(decodeDeliverySimulation(readSourceFile(context.originalWorld.directory,m.gameplay),m.gameplay).toString());
 for(const[kind,id]of[['lanes','122948203:0:b0'],['footways','w1552575431']]as const){const record=value.baseline[kind].find(r=>r.id===id)!;
  // The projector here deliberately follows the input curve. This isolates
  // preservation arithmetic; the separate actual CLI test uses serialized HCOL.
  const project=(x:number,z:number)=>{let best={distance:Infinity,height:0};for(let i=1;i<record.points.length;i++){const a=record.points[i-1]!,b=record.points[i]!,dx=b[0]-a[0],dz=b[2]-a[2],t=Math.max(0,Math.min(1,((x-a[0])*dx+(z-a[2])*dz)/(dx*dx+dz*dz))),distance=Math.hypot(x-a[0]-dx*t,z-a[2]-dz*t);if(distance<best.distance)best={distance,height:a[1]+(b[1]-a[1])*t};}return{height:best.height,triangles:['TEST_INPUT_CURVE_ONLY']};};
  const result=repairOutsidePolyline(record.points,value.coverage,context.coverage,project,.25,originalCoverage);assertOutsideOnlyPolylineRepair(record.points,result.points,value.coverage);
  const original=context.original[kind].find(r=>r.id===id)!;assertOutsideOnlyPolylineRepair(original.points,result.points,originalCoverage);
 }
});
test('all groups require literal current records; missing metadata topology and coordinates reject',{skip:!available},()=>{
 const{context,prepared:q}=load();for(const kind of['nodes','lanes','connectors','footways']as const){const g=carryCurrentNavigation(q.authority,context.original,context.original),id=currentCarryIds(q.authority,kind)[0]!,index=g[kind].findIndex(r=>r.id===id);(g[kind]as unknown as {id:string}[]).splice(index,1);assert.throws(()=>assertCurrentNavigationCarry(q.authority,context.original,context.current,g),/omitted/);}
 const g=carryCurrentNavigation(q.authority,context.original,context.original),lane=g.lanes.find(r=>r.id===currentCarryIds(q.authority,'lanes')[0])!;(lane as{length:number}).length+=1;assert.throws(()=>assertCurrentNavigationCarry(q.authority,context.original,context.current,g),/changed/);
});
test('different current source/world and mutable input snapshots cannot construct carry',{skip:!available},()=>{
 const{binding,context}=load();assert.throws(()=>prepareCurrentNavigationCarry(binding,{...context,currentWorld:{...context.currentWorld,manifestSha256:'0'.repeat(64)}}),/parent/);assert.throws(()=>prepareCurrentNavigationCarry({...binding,candidateOsm:{...binding.candidateOsm,sha256:'0'.repeat(64)}},context));const g=structuredClone(context.current);(g.lanes.at(-1)!.points[0]as number[])[0]!+=1;assert.throws(()=>prepareCurrentNavigationCarry(binding,{...context,current:g}),/actual current43/i);
});
test('copying cannot remove actual current mask access under a rehashed mask',{skip:!available},()=>{
 const{binding,context}=load(),mask=JSON.parse(fs.readFileSync(binding.sourceMask.file,'utf8'));mask.supportedArea={schemaVersion:1,regions:[{id:'removed-current-a',outer:[[-1792,-2304],[800,-2304],[800,768],[-1792,768]]}]};mask.qualification.expanded={minX:-1792,maxX:800,minZ:-2304,maxZ:768};const bytes=Buffer.from(JSON.stringify(mask)),changed={file:'test-removed-current-mask',sha256:sourceSha256(bytes)};
 assert.throws(()=>prepareCurrentNavigationCarry({...binding,sourceMask:changed},{...context,coverage:{playArea:mask.qualification.expanded,supportedArea:mask.supportedArea},read:(p,cap)=>p.file===changed.file?bytes:context.read(p,cap)}),/loses current centreline|admission changed/);
});
test('raw conflicts are explicit and opaque carry is replayed before connector qualification',{skip:!available},()=>{
 const{binding,context}=load(),raw=structuredClone(context.rawCandidate),id=context.current.lanes.find(r=>!context.original.lanes.some(o=>o.id===r.id))!.id,rawLane=raw.lanes.find(r=>r.id===id)!;(rawLane.points[0]as number[])[1]!+=.25;
 const q=prepareCurrentNavigationCarry(binding,{...context,rawCandidate:raw});assert.equal(q.receipt.records.find(r=>r.kind==='lanes'&&r.id===id)!.rawCandidateConflict,true);
 const projected=carryCurrentNavigation(q.authority,context.original,raw),project=()=>{throw new Error('Carried records must not be reprojected');},repaired=repairNewStraightConnectorOvershoot(context.original,projected,[],[],project),input={accepted:context.original,original:raw,projected,witness:repaired.witness,newLaneIds:[],connectorIds:[],newFootwayIds:[],project,currentCarry:{authority:q.authority,original:context.original,current:context.current}};
 const replay=verifyConnectorProjectionRepair(input);assert.deepEqual(replay.beforeRepair,projected);assert.equal(replay.receipt.originalGraphSha256,sourceSha256(JSON.stringify(raw)));
 assert.throws(()=>verifyConnectorProjectionRepair({...input,currentCarry:undefined}));assert.throws(()=>verifyConnectorProjectionRepair({...input,newLaneIds:[id]}),/cannot enter/);const changed=structuredClone(projected);(changed.lanes.find(r=>r.id===id)!.points[0]as number[])[0]!+=.0001;assert.throws(()=>verifyConnectorProjectionRepair({...input,projected:changed}),/carried record changed/);
});
