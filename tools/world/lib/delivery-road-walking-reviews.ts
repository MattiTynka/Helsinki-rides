import assert from 'node:assert/strict';
import type {RoadGraph} from '../../../packages/world-schema/src/index.ts';
import type {RoadAuthority,DeliveryRoadBinding} from './delivery-city-roads.ts';
import {decodeDeliveryRoadFile} from './delivery-road-file.ts';
import {sourceFile} from './source-files.ts';
import {loadGeoJsonPolygons} from './geometry.ts';
import {inspectRetainedPathExposure,type RoadSourceElement} from './expansion-road-merge.ts';
import {prepareKaivopuistoFootway,prepareRetainedWalkingCrossing,readProjectionWalkingOsm} from './road-walking-review-context.ts';
import {assertReviewedRetainedWalkingCrossing} from './reviewed-retained-walking-crossing.ts';

/** Reconstruct source-only authorities from actual append inputs. Neither a
 * projection declaration nor a merge receipt is an opaque authority by itself. */
export function prepareAppendWalkingReviews(input:{projection:any;merge:any;graph:RoadGraph;authority:RoadAuthority;read:(pin:DeliveryRoadBinding,cap?:number)=>Uint8Array}){
 const{projection:p,merge,graph,authority,read}=input,world=p.serializedFloorWorld;
 assert.ok(world,'Walking source authority requires final serialized floor');assert.equal(world.manifestSha256,authority.finalWorldManifestSha256,'Walking source authority uses another append parent');
 const json=(pin:DeliveryRoadBinding,cap=16*1024*1024)=>JSON.parse(Buffer.from(read(pin,cap)).toString());
 const manifest=json({file:sourceFile(world.directory,'manifest.json'),sha256:world.manifestSha256}),metadata=json(p.nativeMetadata),candidate=decodeDeliveryRoadFile(read(p.originalCandidateRoads,64*1024*1024)),projected=decodeDeliveryRoadFile(read(p.projectedCandidateRoads,64*1024*1024));
 const{pin:osmPin,osm}=readProjectionWalkingOsm(metadata,candidate,read),partPin={file:metadata.inputs.streetParts.path,sha256:metadata.inputs.streetParts.sha256};
 read(partPin,128*1024*1024);assert.equal(candidate.source.sha256,osmPin.sha256);assert.equal(merge.osmSha256,osmPin.sha256);assert.equal(merge.streetPartsSha256,partPin.sha256);
 const parts=loadGeoJsonPolygons(partPin.file,manifest.origin.originProjected[0],manifest.origin.originProjected[1],properties=>String(properties.osan_id));
 const common={original:authority.accepted,candidate,world,sourcePins:{osmSha256:osmPin.sha256,streetPartsSha256:partPin.sha256},osm,parts,read};
 const closure=(cells:readonly{cell:string;decodedSha256:string}[])=>{for(const cell of cells)assert.ok(authority.collisions.some(c=>c.cell===cell.cell&&c.decodedSha256===cell.decodedSha256),'Walking source floor differs from actual append collision authority: '+cell.cell);};
 const kaivo=p.kaivopuistoFootway?prepareKaivopuistoFootway(p.kaivopuistoFootway.binding,{...common,selectedNewFootwayIds:p.proofs.filter((r:any)=>r.kind==='new-footway').map((r:any)=>r.id)}):undefined;
 if(kaivo){
  assert.deepEqual(kaivo.receipt,p.kaivopuistoFootway.authorityReceipt);closure(kaivo.receipt.completeLocalCollisionDecodedClosure);
  const projectedProof=kaivo.projected(projected);assert.deepEqual(projectedProof.receipt,p.kaivopuistoFootway.projection);assert.deepEqual(kaivo.projected(graph).receipt,projectedProof.receipt,'Final Kaivo record differs from the qualified projection');
  const audit=merge.walking?.newAudits?.find((r:any)=>r.id==='w87075617');assert.ok(audit,'Kaivo append lacks ordinary walking audit');assert.deepEqual(audit.physical.reviewedSourceAndFloor,projectedProof.receipt);
 }
 let crossing:ReturnType<typeof prepareRetainedWalkingCrossing>|undefined;
 if(merge.retainedWalkingCrossing){
  assert.ok(authority.current,'Retained crossing requires actual CURRENT graph');
  const audits=merge.walking?.retainedAudits;assert.ok(Array.isArray(audits));
  crossing=prepareRetainedWalkingCrossing(merge.retainedWalkingCrossing.binding,{...common,current:authority.current,acceptedCoverage:authority.gameplay,coverage:p.expandedCoverage,selectedRetainedFootwayIds:audits.map((r:any)=>r.id)});
  assert.deepEqual(crossing.receipt,merge.retainedWalkingCrossing.authorityReceipt);closure(crossing.receipt.localDecodedCollisionClosure);
  const record=graph.footways.find(r=>r.id==='w1533067599');assert.ok(record);const intervals=inspectRetainedPathExposure([record],authority.gameplay,p.expandedCoverage).find(r=>r.id===record.id)?.intervals;assert.ok(intervals);
  const way=osm.elements.find(w=>w.type==='way'&&w.id===1533067599);assert.ok(way);
  const receipt=assertReviewedRetainedWalkingCrossing(crossing.authority,record,way,intervals);assert.deepEqual(audits.find((r:any)=>r.id===record.id)?.physical.reviewedRetainedCrossing,receipt,'Crossing audit does not bind its exact source disposition');
  assert.ok(!(merge.walking.routes??[]).some((r:any)=>r.steps.some((s:any)=>s.id===record.id)),'Retained crossing source authority cannot authorize whole walking routes');
 }
 return{receipt:{...(kaivo?{kaivopuisto:kaivo.receipt}:{}),...(crossing?{retainedCrossing:crossing.receipt}:{})},verifyInputs:()=>{kaivo?.verifyInputs();crossing?.verifyInputs();}};
}
