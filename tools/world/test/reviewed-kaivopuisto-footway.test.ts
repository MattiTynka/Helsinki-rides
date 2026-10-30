import test from'node:test';import assert from'node:assert/strict';import fs from'node:fs';
import{decodeRoadGraph,type RoadGraph,type Vec3}from'../../../packages/world-schema/src/index.ts';import{readSourceFile}from'../lib/source-files.ts';import{decodeDeliverySimulation}from'../lib/delivery-city-payloads.ts';import{loadGeoJsonPolygons}from'../lib/geometry.ts';
import{readReviewedKaivopuistoFootway,assertReviewedKaivopuistoFootwayProjection,KAIVOPUISTO_FOOTWAY_APPROVAL_SHA256,type ReviewedKaivopuistoFootway}from'../lib/reviewed-kaivopuisto-footway.ts';
const approval={file:'../evidence/kaivopuisto-footway-root-approval-v1.json',sha256:KAIVOPUISTO_FOOTWAY_APPROVAL_SHA256},available=fs.existsSync(approval.file);
function fixture(){const root='../accepted-world/world/senate-20261025-civilian-flee',m=JSON.parse(fs.readFileSync(root+'/manifest.json','utf8'));return{
 accepted:decodeRoadGraph(decodeDeliverySimulation(readSourceFile(root,m.roads),m.roads)),candidate:JSON.parse(fs.readFileSync('../work/kaivopuisto-footway-registration-v1/roads-source-registered.json','utf8'))as RoadGraph,
 world:{directory:'../work/cumulative-city-east-walking-seam-v1/world',manifestSha256:'d453fdd79db114c914322f0209121c34819206b294004bdcece2739f0f3b4701'},
 sourcePins:{osmSha256:'a6bf71bae890ab60b4249c8546e6b7185ce37c9ede4137e9c4aefbd9a755e65a',streetPartsSha256:'1ac1409cf70cd6c3ad1ab7139fd6f365898d5c654e499616a1892d1b669645b2'},
 osm:JSON.parse(fs.readFileSync('../sources/raw-v2/osm/southwest-cumulative-20261029.json','utf8')),parts:loadGeoJsonPolygons('../sources/raw-v2/street-parts/southwest-cumulative-20261029.geojson',25497350,6672960,p=>String(p.osan_id)),
 read:(p:{file:string;sha256:string},cap=16*1024*1024)=>{const bytes=fs.readFileSync(p.file);assert.ok(bytes.length<=cap);return bytes;},
};}
let context:ReturnType<typeof fixture>,qualified:ReturnType<typeof readReviewedKaivopuistoFootway>;
function loaded(){if(!qualified){context=fixture();qualified=readReviewedKaivopuistoFootway(approval,context);}return qualified;}
test('an arbitrary or serialized token cannot authorize walking registration',()=>{
 assert.throws(()=>readReviewedKaivopuistoFootway({...approval,sha256:'0'.repeat(64)},{}as never),/Unapproved/);
 assert.throws(()=>assertReviewedKaivopuistoFootwayProjection({}as ReviewedKaivopuistoFootway,{id:'w87075617',points:[]}),/Unverified/);
});
test('exact approved new trace composes on unchanged local d453 floors and keeps all source nodes',{skip:!available},()=>{
 const q=loaded(),record=context.candidate.footways.find(p=>p.id==='w87075617')!,source=assertReviewedKaivopuistoFootwayProjection(q.authority,record);
 assert.equal(source.sourceNodePoints.size,6);assert.equal(q.receipt.sourceNodeXZPreserved,6);assert.equal(q.receipt.sourceMembershipOnly,true);assert.equal(q.receipt.ordinaryFloorAndCapsuleGatesRequired,true);assert.ok(!JSON.stringify(q.receipt).includes('../'));
 const changed=structuredClone(record);changed.points[0]![1]+=.001;assert.doesNotThrow(()=>assertReviewedKaivopuistoFootwayProjection(q.authority,changed),'Source authority does not replace ordinary vertical qualification');
 q.registered.points[0]![0]+=1;source.sourcePoints[0]![0]+=1;assert.doesNotThrow(()=>assertReviewedKaivopuistoFootwayProjection(q.authority,record),'Detached data cannot mutate opaque authority');
 q.receipt.ordinaryFloorAndCapsuleGatesRequired=false;assert.equal((assertReviewedKaivopuistoFootwayProjection(q.authority,record).receipt as Record<string,unknown>).ordinaryFloorAndCapsuleGatesRequired,true);
 assert.throws(()=>assertReviewedKaivopuistoFootwayProjection(JSON.parse(JSON.stringify(q.authority)),record),/Unverified/);
});

test('changed actual local HCOL cannot reuse the source proof or an existing opaque authority',{skip:!available},()=>{
 const q=loaded(),manifest=JSON.parse(fs.readFileSync(context.world.directory+'/manifest.json','utf8')),needle=manifest.cells.find((c:any)=>c.id==='c_p00_p10').collision.path.split('/').at(-1),original=fs.readFileSync;let changed=0;
 try{
  (fs as any).readFileSync=(file:any,...args:any[])=>{const value=(original as any)(file,...args);if(String(file).endsWith(needle)&&Buffer.isBuffer(value)){const copy=Buffer.from(value);copy[0]=copy[0]!^1;changed++;return copy;}return value;};
  assert.throws(()=>readReviewedKaivopuistoFootway(approval,context));assert.ok(changed>0);changed=0;
  assert.throws(()=>q.verifyInputs());assert.ok(changed>0);
 }finally{fs.readFileSync=original;}
});
test('other IDs, moved or reversed geometry, source changes and accepted replacements fail closed',{skip:!available},()=>{
 const q=loaded(),record=context.candidate.footways.find(p=>p.id==='w87075617')!;
 type MutableFootway={id:string;points:Vec3[]};
 for(const edit of[(p:MutableFootway)=>{p.id='w999';},(p:MutableFootway)=>{p.points[100]![0]+=.001;},(p:MutableFootway)=>{p.points.reverse();},(p:MutableFootway)=>{p.points.splice(100,1);},(p:MutableFootway)=>{(p as unknown as{access:string}).access='private';}]){const changed=structuredClone(record);edit(changed as unknown as MutableFootway);assert.throws(()=>assertReviewedKaivopuistoFootwayProjection(q.authority,changed));}
 const accepted=structuredClone(context.accepted);(accepted.footways as unknown as unknown[]).push(structuredClone(record));assert.throws(()=>readReviewedKaivopuistoFootway(approval,{...context,accepted}),/accepted footway/);
 assert.throws(()=>readReviewedKaivopuistoFootway(approval,{...context,sourcePins:{...context.sourcePins,osmSha256:'0'.repeat(64)}}));
 const osm=structuredClone(context.osm);osm.elements.find((p:any)=>p.type==='way'&&p.id===87075617).tags.foot='private';assert.throws(()=>readReviewedKaivopuistoFootway(approval,{...context,osm}),/identity or access/);
 const parts=structuredClone(context.parts),p=parts.find(p=>p.id==='41165')!;p.rings[0]![0]![0]+=.001;assert.throws(()=>readReviewedKaivopuistoFootway(approval,{...context,parts}),/municipal source/);
});
