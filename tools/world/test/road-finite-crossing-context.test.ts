import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {decodeRoadGraph}from'../../../packages/world-schema/src/index.ts';
import {decodeDeliverySimulation}from'../lib/delivery-city-payloads.ts';
import {sourceSha256}from'../lib/source-files.ts';
import {prepareUdenmaankatuCrossing}from'../lib/road-finite-crossing-context.ts';
import {inspectRetainedRoadExposure,inspectRoadAdmission,inspectReviewedUdenmaankatuRoadPhysicalSupport,inspectRoadPhysicalSupport,deriveRoadPhysicalEnvelope,RoadCollisionSupport,type RoadSourceElement}from'../lib/expansion-road-merge.ts';
import {readSerializedRoadFloor}from'../lib/serialized-road-floor.ts';
import {loadGeoJsonPolygons}from'../lib/geometry.ts';
const available=fs.existsSync('../evidence/udenmaankatu-crossing-root-approval-v1.json');
function fixture(){
 const pin=(file:string)=>({file,sha256:sourceSha256(fs.readFileSync(file))}),originalWorld={directory:'../accepted-world/world/senate-20261025-civilian-flee',manifestSha256:'0e18e55e8730f01144eef72a80decffbb53cdd658222f87a7e8ad6f75f2c4260'},currentWorld={directory:'../work/cumulative-city-east-walking-seam-v1/world',manifestSha256:'d453fdd79db114c914322f0209121c34819206b294004bdcece2739f0f3b4701'};
 const load=(w:typeof originalWorld)=>{const m=JSON.parse(fs.readFileSync(w.directory+'/manifest.json','utf8')),read=(r:any)=>decodeDeliverySimulation(fs.readFileSync(w.directory+'/'+r.path),r);return{graph:decodeRoadGraph(read(m.roads)),gameplay:JSON.parse(read(m.gameplay).toString())};},old=load(originalWorld),current=load(currentWorld),sourceMask=pin('../evidence/w29282225-supported-area-source-qualified-v4.json'),mask=JSON.parse(fs.readFileSync(sourceMask.file,'utf8'));
 const binding={approval:pin('../evidence/udenmaankatu-crossing-root-approval-v1.json'),provenanceArchive:pin('../evidence/udenmaankatu-crossing-root-provenance-v1/mapping.json'),sourceMask},context={original:old.graph,current:current.graph,originalWorld,currentWorld,coverage:{playArea:mask.qualification.expanded,supportedArea:mask.supportedArea},sourcePins:{osmSha256:'a6bf71bae890ab60b4249c8546e6b7185ce37c9ede4137e9c4aefbd9a755e65a',streetPartsSha256:'1ac1409cf70cd6c3ad1ab7139fd6f365898d5c654e499616a1892d1b669645b2'},read:(p:{file:string},cap=64*1024*1024)=>{const stat=fs.lstatSync(p.file);assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=cap);return fs.readFileSync(p.file);}};
 return{binding,context,old,current,prepared:prepareUdenmaankatuCrossing(binding,context)};
}
test('finite crossing context has no caller-provided record, source polygon or height baseline',()=>{assert.throws(()=>prepareUdenmaankatuCrossing({approval:{},provenanceArchive:{},sourceMask:{},after:{}}as never,{}as never));});
test('actual two finite crossings retain ordinary source, body and private-tail closure gates',{skip:!available},()=>{
 const f=fixture(),p=f.prepared;assert.equal(p.reviewedRecords.length,2);assert.equal('currentBaseline'in p,false);assert.equal('heightAuthority'in p,false);
 const parts=loadGeoJsonPolygons('../sources/raw-v2/street-parts/southwest-cumulative-20261029.geojson',25497350,6672960,v=>String(v.osan_id)),osm=JSON.parse(fs.readFileSync('../sources/raw-v2/osm/southwest-cumulative-20261029.json','utf8')),way=osm.elements.find((e:RoadSourceElement)=>e.type==='way'&&e.id===1204623899);
 const region=p.reviewedRecords.flatMap(l=>l.points).reduce<[number,number,number,number]>((b,q)=>[Math.min(b[0],q[0]-5),Math.min(b[1],q[2]-5),Math.max(b[2],q[0]+5),Math.max(b[3],q[2]+5)],[Infinity,Infinity,-Infinity,-Infinity]),floor=readSerializedRoadFloor(f.context.currentWorld,region,f.old.graph.originId),support=new RoadCollisionSupport(floor.triangles),envelope=deriveRoadPhysicalEnvelope(f.old.gameplay.vehicleDefinitions),exposures=inspectRetainedRoadExposure({...f.old.graph,lanes:p.reviewedRecords},f.old.gameplay,f.context.coverage);
 for(const lane of p.reviewedRecords){const intervals=exposures.find(r=>r.id===lane.id)!.intervals,admission=inspectRoadAdmission(lane.points,intervals,f.context.coverage,envelope),input={lane,intervals,admittedIntervals:admission.admittedIntervals,way,partIds:['59319','59311','46532'],parts,support,coverage:f.context.coverage,envelope};
  assert.ok(admission.closedIntervals.length>0,'Private continuation must remain closed');assert.throws(()=>inspectRoadPhysicalSupport(lane.id,lane.points,lane.width,input.partIds,parts,support,input.coverage,envelope,input.admittedIntervals,true),/Non-carriageway/);
  const result=inspectReviewedUdenmaankatuRoadPhysicalSupport(p.roles.get(lane.id)!,input);assert.equal(result.failureCount,0);assert.ok(result.samples>1000);
  assert.throws(()=>inspectReviewedUdenmaankatuRoadPhysicalSupport(p.roles.get(lane.id)!,{...input,lane:{...lane,id:lane.id+'>other'}}),/Unreviewed/);
  assert.throws(()=>inspectReviewedUdenmaankatuRoadPhysicalSupport(p.roles.get(lane.id)!,{...input,admittedIntervals:intervals}),/admitted crossing/);
  assert.throws(()=>inspectReviewedUdenmaankatuRoadPhysicalSupport(p.roles.get(lane.id)!,{...input,way:{...way,tags:{...way.tags,access:'private'}}}),/way changed/);
 }p.verifyInputs();
});
