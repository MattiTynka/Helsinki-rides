import assert from 'node:assert/strict';
import path from 'node:path';
import type {RoadGraph}from'../../../packages/world-schema/src/index.ts';
import type {RoadCoverage,RoadSourceElement}from'./expansion-road-merge.ts';
import type {SerializedFloorWorld}from'./serialized-road-floor.ts';
import type {LocalPolygon}from'./geometry.ts';
import {sourceFile,sourceSha256}from'./source-files.ts';
import {readReviewedKaivopuistoFootway,assertReviewedKaivopuistoFootwayProjection}from'./reviewed-kaivopuisto-footway.ts';
import {readReviewedRetainedWalkingCrossing,RETAINED_WALKING_CROSSING_PROPOSAL_SHA256}from'./reviewed-retained-walking-crossing.ts';
interface Pin{file:string;sha256:string;bytes?:number}
export interface KaivopuistoFootwayBinding{approval:Pin}
export interface RetainedWalkingCrossingBinding{approval:Pin;proposal:Pin;projectedExposureReview?:Pin}
interface Context{original:RoadGraph;candidate:RoadGraph;world:SerializedFloorWorld;sourcePins:{osmSha256:string;streetPartsSha256:string};osm:{elements:RoadSourceElement[]};parts:readonly LocalPolygon[];read:(pin:Pin,cap?:number)=>Uint8Array}
export function prepareKaivopuistoFootway(binding:KaivopuistoFootwayBinding,context:Context&{selectedNewFootwayIds:readonly string[]}){
 assert.deepEqual(Object.keys(binding),['approval']);assert.ok(context.selectedNewFootwayIds.includes('w87075617'),'Kaivo authority requires explicit new-record selection');
 const result=readReviewedKaivopuistoFootway(binding.approval,{accepted:context.original,candidate:context.candidate,world:context.world,sourcePins:context.sourcePins,osm:context.osm,parts:context.parts,read:context.read});
 return{...result,projected:(graph:RoadGraph)=>{const record=graph.footways.find(r=>r.id==='w87075617');assert.ok(record);return assertReviewedKaivopuistoFootwayProjection(result.authority,record);}};
}
/** The approval is separate from the lower-level proposal reader. It grants
 * only the named newly exposed crossing audit; whole-route access is unchanged. */
export function prepareRetainedWalkingCrossing(binding:RetainedWalkingCrossingBinding,context:Context&{current:RoadGraph;acceptedCoverage:RoadCoverage;coverage:RoadCoverage;selectedRetainedFootwayIds:readonly string[]}){
 assert.deepEqual(Object.keys(binding).sort(),['approval','proposal',...(binding.projectedExposureReview?['projectedExposureReview']:[])].sort());assert.equal(binding.approval.sha256,'23158fadebd8aae8e11d8d28d54d9593996cd0a906daa16c494710d96f71fd9b');assert.equal(binding.proposal.sha256,RETAINED_WALKING_CROSSING_PROPOSAL_SHA256);assert.ok(context.selectedRetainedFootwayIds.includes('w1533067599'),'Crossing authority requires explicit retained selection');
 const bytes=context.read(binding.approval,65536);assert.ok(bytes.length<=65536);assert.equal(sourceSha256(bytes),binding.approval.sha256);const approval=JSON.parse(Buffer.from(bytes).toString());assert.equal(approval.kind,'literal-retained-public-carriageway-crossing-source-approval');assert.equal(approval.recordId,'w1533067599');assert.equal(approval.proposal.sha256,binding.proposal.sha256);
 const result=readReviewedRetainedWalkingCrossing({file:binding.proposal.file,sha256:binding.proposal.sha256},{accepted:context.original,current:context.current,acceptedCoverage:context.acceptedCoverage,world:context.world,coverage:context.coverage,...(binding.projectedExposureReview?{projectedExposureReview:binding.projectedExposureReview}:{}),sourcePins:context.sourcePins,osm:context.osm,parts:context.parts,read:context.read});
 return{...result,receipt:{approvalSha256:binding.approval.sha256,...result.receipt},verifyInputs:()=>{assert.equal(sourceSha256(context.read(binding.approval,65536)),binding.approval.sha256);result.verifyInputs();}};
}

/** Select one raw snapshot by the graph's exact digest from the pinned native
 * OSM ledger. A private metadata path never substitutes for content identity. */
export function readProjectionWalkingOsm(metadata:any,candidate:RoadGraph,read:Context['read']){
 const ref=metadata.inputs.osmLedger;assert.ok(ref&&typeof ref.path==='string');const ledgerPin={file:ref.path,sha256:ref.sha256},bytes=read(ledgerPin,4*1024*1024);assert.equal(sourceSha256(bytes),ref.sha256);const ledger=JSON.parse(Buffer.from(bytes).toString());assert.equal(ledger.schemaVersion,1);const snapshots=Object.values(ledger.snapshots)as {path:string;sha256:string;bytes:number}[];assert.ok(snapshots.length>0&&snapshots.length<=1024);const matches=snapshots.filter(s=>s.sha256===candidate.source.sha256);assert.equal(matches.length,1,'Native ledger does not identify one exact road source');const snapshot=matches[0]!;assert.ok(Number.isSafeInteger(snapshot.bytes)&&snapshot.bytes>0&&snapshot.bytes<=128*1024*1024);const pin={file:sourceFile(path.dirname(ledgerPin.file),snapshot.path),sha256:snapshot.sha256},raw=read(pin,128*1024*1024);assert.equal(raw.length,snapshot.bytes);assert.equal(sourceSha256(raw),pin.sha256);return{pin,osm:JSON.parse(Buffer.from(raw).toString())as{elements:RoadSourceElement[]}};
}
