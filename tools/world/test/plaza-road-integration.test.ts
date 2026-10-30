import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {decodeRoadGraph,type RoadGraph} from '../../../packages/world-schema/src/index.ts';
import {decodeDeliverySimulation} from '../lib/delivery-city-payloads.ts';
import {sourceSha256} from '../lib/source-files.ts';
import {prepareAdditionalRoadInheritance,additionalPlazaRecords,additionalPlazaRoles,type RoadInheritanceBundleBinding} from '../lib/inherited-road-bundle-context.ts';
import {composeReviewedRoadBaselines} from '../lib/road-inheritance-context.ts';
import {assertOutsideOnlyRoadGraphRepair,assertOutsideOnlyPolylineRepair} from '../lib/road-outside-repair.ts';
import {deriveRoadPhysicalEnvelope,inspectRetainedRoadExposure,inspectRoadAdmission,inspectReviewedPlazaRoadPhysicalSupport,RoadCollisionSupport,type RoadSourceElement} from '../lib/expansion-road-merge.ts';
import {readSerializedRoadFloor} from '../lib/serialized-road-floor.ts';
import {loadGeoJsonPolygons} from '../lib/geometry.ts';

const available=fs.existsSync('../evidence/plaza-service-root-approval-v1.json');
const hash=(v:unknown)=>sourceSha256(JSON.stringify(v));
const sourceMask={file:'../evidence/w29282225-supported-area-source-qualified-v4.json',sha256:'1200b9fe57f38c4a51fd0c536455817ffe0640b102727fd40b551cebb3ea4c80'};
const plazaService={approval:{file:'../evidence/plaza-service-root-approval-v1.json',sha256:'27c7fd57756403aba0047aff545226a50ec5e5a6a75f63c5f5c4bb28486b4945'},provenanceArchive:{file:'../evidence/plaza-service-root-approval-provenance-v1/mapping.json',sha256:'0beeea1016cb58697122c8bec124fd1222b5e517d6ba83c230708f24282f43e2'},officialProducerSupplement:{file:'../evidence/plaza-official-reference-provenance-root-supplement-v1.json',sha256:'26ec94f46ba63c79179a3a5dec0437c662fd492ca5d15c4b6953fdad430c99fa'}};
function setup(){
 const originalWorld={directory:'../accepted-world/world/senate-20261025-civilian-flee',manifestSha256:'0e18e55e8730f01144eef72a80decffbb53cdd658222f87a7e8ad6f75f2c4260'},currentWorld={directory:'../work/cumulative-city-east-walking-seam-v1/world',manifestSha256:'d453fdd79db114c914322f0209121c34819206b294004bdcece2739f0f3b4701'};
 const read=(w:typeof originalWorld)=>{const m=JSON.parse(fs.readFileSync(w.directory+'/manifest.json','utf8'));return{graph:decodeRoadGraph(decodeDeliverySimulation(fs.readFileSync(w.directory+'/'+m.roads.path),m.roads)),gameplay:JSON.parse(decodeDeliverySimulation(fs.readFileSync(w.directory+'/'+m.gameplay.path),m.gameplay).toString())};};
 const old=read(originalWorld),cur=read(currentWorld),mask=JSON.parse(fs.readFileSync(sourceMask.file,'utf8')),coverage={playArea:mask.qualification.expanded,supportedArea:mask.supportedArea};
 const context={original:old.graph,current:cur.graph,originalWorld,currentWorld,sourcePins:{osmSha256:'a6bf71bae890ab60b4249c8546e6b7185ce37c9ede4137e9c4aefbd9a755e65a',streetPartsSha256:'1ac1409cf70cd6c3ad1ab7139fd6f365898d5c654e499616a1892d1b669645b2'},otherRegistrationIds:[],coverage};
 const binding:RoadInheritanceBundleBinding={schemaVersion:1,sourceMask,plazaService},prepared=prepareAdditionalRoadInheritance(binding,context),composition=composeReviewedRoadBaselines(old.graph,old.gameplay,undefined,undefined,{authority:prepared.authority,current:cur.graph});
 return{old,cur,context,binding,prepared,composition};
}
let fixture:ReturnType<typeof setup>;
const load=()=>fixture??=setup();

test('plaza bundle rejects forged tokens, unlisted fields and missing exact mask',()=>{
 assert.throws(()=>additionalPlazaRecords({}as never),/Unrecognized/);
 assert.throws(()=>additionalPlazaRoles({}as never),/Unrecognized/);
 assert.throws(()=>prepareAdditionalRoadInheritance({schemaVersion:1,plazaService,sourceMask,extra:true}as never,{}as never));
});
test('actual sixteen authoring records contribute only four protected Y witnesses',{skip:!available},()=>{
 const f=load(),records=additionalPlazaRecords(f.prepared.authority);assert.equal(records.length,16);assert.equal(f.prepared.witnesses.length,4);assert.equal(f.composition.literalInheritedRecords.length,4);
 const heightIds=new Set(f.prepared.witnesses.map(w=>w.id));const after:RoadGraph={...structuredClone(f.composition.registeredAcceptedBaseline),lanes:f.composition.registeredAcceptedBaseline.lanes.map(l=>structuredClone(records.find(r=>r.id===l.id)??l))};
 for(const r of records)if(!heightIds.has(r.id))assertOutsideOnlyPolylineRepair(f.old.graph.lanes.find(l=>l.id===r.id)!.points,r.points,f.old.gameplay);
 const changes=assertOutsideOnlyRoadGraphRepair(f.old.graph,after,f.old.gameplay,f.composition.authority);assert.equal(changes.length,16);
 for(const kind of['nodes','lanes','connectors','parking','footways']as const)for(const current of f.cur.graph[kind])if(!(kind==='lanes'&&heightIds.has(current.id)))assert.deepEqual(f.composition.correctedCurrentBaseline![kind].find(r=>r.id===current.id),current);
 assert.equal(f.prepared.receipt.currentAdditionsPreserved,43);assert.equal(f.composition.correctedCurrentBaseline!.lanes.filter((r,i)=>hash(r)!==hash(f.cur.graph.lanes[i])).length,4);
 records[0]!.points[0]![1]+=1;assert.notEqual(hash(records),hash(additionalPlazaRecords(f.prepared.authority)));f.prepared.verifyInputs();
});
test('ordinary outside preservation remains mandatory for the twelve non-height records',{skip:!available},()=>{
 const f=load(),records=additionalPlazaRecords(f.prepared.authority),r=records.find(r=>r.id==='1271953696:0:f0')!,bad=structuredClone(r);bad.points[0]![1]+=.001;
 const graph={...structuredClone(f.composition.registeredAcceptedBaseline),lanes:f.composition.registeredAcceptedBaseline.lanes.map(l=>l.id===bad.id?bad:l)};
 assert.throws(()=>assertOutsideOnlyRoadGraphRepair(f.old.graph,graph,f.old.gameplay,f.composition.authority),/inside|accepted|height/i);
 assert.throws(()=>prepareAdditionalRoadInheritance(f.binding,{...f.context,otherRegistrationIds:[f.prepared.witnesses[0]!.id]}),/overlap/);
});
test('actual sixteen retained exposures use clipped source and additive floor with ordinary full-body gate',{skip:!available},()=>{
 const f=load(),records=additionalPlazaRecords(f.prepared.authority),roles=additionalPlazaRoles(f.prepared.authority),packet=JSON.parse(fs.readFileSync('../evidence/plaza-service-review-packet-v1/packet.json','utf8'));
 const parts=loadGeoJsonPolygons('../sources/raw-v2/street-parts/southwest-cumulative-20261029.geojson',25497350,6672960,p=>String(p.osan_id)),osm=JSON.parse(fs.readFileSync('../sources/raw-v2/osm/southwest-cumulative-20261029.json','utf8'));
 const region=records.flatMap(r=>r.points).reduce<[number,number,number,number]>((b,p)=>[Math.min(b[0],p[0]-5),Math.min(b[1],p[2]-5),Math.max(b[2],p[0]+5),Math.max(b[3],p[2]+5)],[Infinity,Infinity,-Infinity,-Infinity]);
 const floor=readSerializedRoadFloor(f.context.currentWorld,region,f.old.graph.originId),support=new RoadCollisionSupport(floor.triangles),envelope=deriveRoadPhysicalEnvelope(f.old.gameplay.vehicleDefinitions);
 const exposed=inspectRetainedRoadExposure({...f.old.graph,lanes:records},f.old.gameplay,f.context.coverage);
 let count=0;for(const lane of records){const role=packet.corridorRoles.find((r:any)=>r.id===lane.id),tail=exposed.find(r=>r.id===lane.id)!;assert.deepEqual(tail.intervals,role.intervals);const admission=inspectRoadAdmission(lane.points,tail.intervals,f.context.coverage,envelope),input={lane,intervals:tail.intervals,admittedIntervals:admission.admittedIntervals,way:osm.elements.find((w:RoadSourceElement)=>w.type==='way'&&w.id===lane.wayId),partIds:[...new Set<string>(role.sourceEligibility.sourceParts.map((p:any)=>p.id))],parts,support,coverage:f.context.coverage,envelope};
  const proof=inspectReviewedPlazaRoadPhysicalSupport(roles.get(lane.id)!,input);assert.equal(proof.failureCount,0,lane.id+JSON.stringify(proof.failureCounts));count+=proof.samples;
  if(lane===records[0]){assert.throws(()=>inspectReviewedPlazaRoadPhysicalSupport({sourceAuthority:roles.get(lane.id)!.floorAuthority as never,floorAuthority:roles.get(lane.id)!.floorAuthority},input),/Unrecognized/);assert.throws(()=>inspectReviewedPlazaRoadPhysicalSupport(roles.get(lane.id)!,{...input,lane:{...lane,id:'wrong'}}),/Unreviewed/);assert.throws(()=>inspectReviewedPlazaRoadPhysicalSupport(roles.get(lane.id)!,{...input,admittedIntervals:[[tail.intervals[0]![0],tail.intervals[0]![1]+1]]}),/admission differs/);}
 }
 assert.ok(count>100000);f.prepared.verifyInputs();
});
