import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import{decodeRoadGraph,polylineLength,type RoadGraph}from '../../../packages/world-schema/src/index.ts';
import{readSourceFile,sourceSha256}from '../lib/source-files.ts';import{decodeDeliverySimulation}from '../lib/delivery-city-payloads.ts';import{loadGeoJsonPolygons}from '../lib/geometry.ts';
import{prepareKaivopuistoFootway,prepareRetainedWalkingCrossing,readProjectionWalkingOsm}from '../lib/road-walking-review-context.ts';
import{readReviewedInheritedWalkingDrains,qualifyReviewedInheritedWalkingDrainSources}from '../lib/reviewed-inherited-walking-drains.ts';
import{mergeQualifiedFootways}from '../lib/expansion-footway-merge.ts';
import{readSerializedRoadFloor}from '../lib/serialized-road-floor.ts';import{RoadCollisionSupport,isPublicWalkingGroundTag,inspectRetainedPathExposure}from '../lib/expansion-road-merge.ts';
import{pin,read}from './next-road-authority-fixture.ts';
const available=fs.existsSync('../evidence/w29282225-supported-area-source-qualified-v4.json');let cache:any;
function fixture(){if(cache)return cache;const originalWorld={directory:'../accepted-world/world/senate-20261025-civilian-flee',manifestSha256:'0e18e55e8730f01144eef72a80decffbb53cdd658222f87a7e8ad6f75f2c4260'},world={directory:'../work/cumulative-city-east-walking-seam-v1/world',manifestSha256:'d453fdd79db114c914322f0209121c34819206b294004bdcece2739f0f3b4701'},load=(w:any)=>{const m=JSON.parse(fs.readFileSync(w.directory+'/manifest.json','utf8'));return{m,graph:decodeRoadGraph(decodeDeliverySimulation(readSourceFile(w.directory,m.roads),m.roads)),gameplay:JSON.parse(decodeDeliverySimulation(readSourceFile(w.directory,m.gameplay),m.gameplay).toString())};},old=load(originalWorld),current=load(world),mask=JSON.parse(fs.readFileSync('../evidence/w29282225-supported-area-source-qualified-v4.json','utf8')),metadata=JSON.parse(fs.readFileSync('../work/cumulative-south-build-v1/native-cache.pinned.json','utf8')),candidate=JSON.parse(fs.readFileSync('../work/kaivopuisto-footway-registration-v1/roads-source-registered.json','utf8'))as RoadGraph,{osm}=readProjectionWalkingOsm(metadata,candidate,read),parts=loadGeoJsonPolygons(metadata.inputs.streetParts.path,old.m.origin.originProjected[0],old.m.origin.originProjected[1],p=>String(p.osan_id));
 return cache={originalWorld,original:old.graph,current:current.graph,acceptedCoverage:old.gameplay,candidate,world,coverage:{playArea:mask.qualification.expanded,supportedArea:mask.supportedArea},sourcePins:{osmSha256:candidate.source.sha256,streetPartsSha256:metadata.inputs.streetParts.sha256},osm,parts,read,origin:old.m.origin.originProjected,metadata};}
function options(a:any,accepted:RoadGraph,record:any,partIds:string[],region:[number,number,number,number],retained=true){const floor=readSerializedRoadFloor(a.world,region,a.original.originId);return{accepted,candidate:a.candidate,coverage:a.coverage,acceptedCoverage:a.acceptedCoverage,origin:a.origin,osm:a.osm,parts:a.parts,support:new RoadCollisionSupport(floor.triangles,isPublicWalkingGroundTag),newFootways:retained?[]:[{id:record.id,partIds}],retainedFootways:retained?[{id:record.id,partIds}]:[],exposure:retained?inspectRetainedPathExposure([record],a.acceptedCoverage,a.coverage):[],routes:[]};}

test('native OSM ledger is hash-bound and rejects duplicate or missing snapshot identity',{skip:!available},()=>{
 const a=fixture();assert.equal(sourceSha256(fs.readFileSync(readProjectionWalkingOsm(a.metadata,a.candidate,read).pin.file)),a.candidate.source.sha256);
 assert.throws(()=>readProjectionWalkingOsm(a.metadata,{...a.candidate,source:{...a.candidate.source,sha256:'0'.repeat(64)}},read),/one exact road source/);
 const ledger=JSON.parse(fs.readFileSync(a.metadata.inputs.osmLedger.path,'utf8'));ledger.snapshots.duplicate=Object.values(ledger.snapshots)[0];const raw=Buffer.from(JSON.stringify(ledger)),metadata=structuredClone(a.metadata);metadata.inputs.osmLedger.sha256=sourceSha256(raw);assert.throws(()=>readProjectionWalkingOsm(metadata,a.candidate,()=>raw),/one exact road source/);
});

test('retained crossing passes only its exact exposed audit; whole-route and missing native floor still reject',{skip:!available},()=>{
 const a=fixture(),binding={approval:pin('../evidence/retained-crossing-root-approval-v1/approval.json'),proposal:pin('../evidence/ruoholahti-routes/retained-west-public-crossing-proposal-v1.json'),projectedExposureReview:pin('../evidence/retained-crossing-projected-exposure-v1/review.json')},q=prepareRetainedWalkingCrossing(binding,{...a,selectedRetainedFootwayIds:['w1533067599']}),accepted={...a.original,footways:a.original.footways.map((r:any)=>r.id===q.record.id?q.record:r)},base=options(a,accepted,q.record,['492089'],[-1800,738,-1780,752]);
 assert.throws(()=>mergeQualifiedFootways(base),/not a public footway/);
 const granted={...base,reviewedRetainedCrossings:new Map([[q.record.id,q.authority]])};assert.throws(()=>mergeQualifiedFootways(granted),/Explicit source-connected walking return routes required/,'Exact source/native audit succeeds before intentionally absent route selection');
 assert.throws(()=>mergeQualifiedFootways({...granted,support:new RoadCollisionSupport([])}),/native road\/pavement support/);
 const way=a.osm.elements.find((w:any)=>w.type==='way'&&w.id===1533067599);assert.throws(()=>mergeQualifiedFootways({...granted,routes:[{id:'not-authorized-as-route',steps:[{wayId:way.id,fromNode:way.nodes[0],toNode:way.nodes[1]},{wayId:way.id,fromNode:way.nodes[1],toNode:way.nodes[0]}]}]}),/not a public footway/);
 assert.throws(()=>prepareRetainedWalkingCrossing(binding,{...a,selectedRetainedFootwayIds:[]}),/explicit retained/);
});

test('Kaivo source registration still runs ordinary capsule and native height support',{skip:!available},()=>{
 const a=fixture(),binding={approval:pin('../evidence/kaivopuisto-footway-root-approval-v1.json')},q=prepareKaivopuistoFootway(binding,{...a,selectedNewFootwayIds:['w87075617']}),record=a.candidate.footways.find((r:any)=>r.id==='w87075617'),projected=q.projected(a.candidate),base=options(a,a.original,record,q.receipt.sourcePartIds,[25,1323,76,1377],false),granted={...base,reviewedFootways:new Map([[record.id,{...projected,support:base.support}]])};
 assert.throws(()=>mergeQualifiedFootways(granted),/Explicit source-connected walking return routes required/);
 const raised=structuredClone(a.candidate);raised.footways.find((r:any)=>r.id===record.id).points.forEach((p:number[])=>p[1]=p[1]!+1);assert.doesNotThrow(()=>q.projected(raised));assert.throws(()=>mergeQualifiedFootways({...granted,candidate:raised}),/native road\/pavement support/);
 assert.throws(()=>prepareKaivopuistoFootway(binding,{...a,selectedNewFootwayIds:[]}),/explicit new-record/);
});

test('drain role supplies only exact clipped source while ordinary physical gate remains active',{skip:!available},()=>{
 const a=fixture(),ap=pin('../evidence/inherited-walking-drains-root-approval-v2.json'),approval=JSON.parse(read(ap).toString()),packet=JSON.parse(read(approval.packet).toString()),context={original:a.original,current:a.current,originalWorld:a.originalWorld,currentWorld:a.world,sourcePins:a.sourcePins,provenanceArchive:approval.provenanceArchive,otherRegistrationIds:[]},q=readReviewedInheritedWalkingDrains(ap,context);
 for(const c of packet.cases){const record=q.originalBaseline.footways.find(r=>r.id===c.id)!,grant=qualifyReviewedInheritedWalkingDrainSources(q.authority,{record,currentWorld:a.world,sourcePins:a.sourcePins,otherRegistrationIds:[]}),bounds=record.points.reduce((b,p)=>[Math.min(b[0]!,p[0]-2),Math.min(b[1]!,p[2]-2),Math.max(b[2]!,p[0]+2),Math.max(b[3]!,p[2]+2)],[Infinity,Infinity,-Infinity,-Infinity])as[number,number,number,number],partIds=[...new Set([...c.physical.sourcePartIds??[],...grant.parts.map(p=>p.id)])];
 // Retain the approved clipped drain subtype; ordinary parts stay unchanged.
 assert.ok(grant.parts.every(p=>p.properties.paatyyppi==='Varusteet'&&p.properties.alatyyppi==='Pintavesikourut'));
 const standard=a.parts.filter((p:any)=>['Ajorata','Kevyt liikenne','Muu rakenneosa'].includes(p.properties.paatyyppi)&&p.bbox[2]>=bounds[0]&&p.bbox[0]<=bounds[2]&&p.bbox[3]>=-bounds[3]&&p.bbox[1]<=-bounds[1]).map((p:any)=>p.id);const base=options(a,q.originalBaseline,record,[...new Set([...standard,...partIds])],bounds),reviewedInheritedWalkingSources=new Map([[record.id,{authority:q.authority,currentWorld:a.world,sourcePins:a.sourcePins,otherRegistrationIds:[]}]]);
 assert.throws(()=>mergeQualifiedFootways(base),/Non-public walking surface/);
 assert.throws(()=>mergeQualifiedFootways({...base,reviewedInheritedWalkingSources}),/Explicit source-connected walking return routes required/);
 assert.throws(()=>mergeQualifiedFootways({...base,reviewedInheritedWalkingSources,support:new RoadCollisionSupport([])}),/native road\/pavement support/);
 const moved=structuredClone(record);moved.points[0]![0]+=.001;assert.throws(()=>mergeQualifiedFootways({...base,accepted:{...base.accepted,footways:base.accepted.footways.map(r=>r.id===record.id?moved:r)},reviewedInheritedWalkingSources}),/Exact reviewed/);
 }
});
