import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import{nextFixture,nextFixtureAvailable as available,pin,read,hash}from './next-road-authority-fixture.ts';
import{prepareAdditionalRoadInheritance,additionalInheritedWalkingSources}from '../lib/inherited-road-bundle-context.ts';
import{composeReviewedRoadBaselines}from '../lib/road-inheritance-context.ts';
import{prepareRetainedRoadRegistrations}from '../lib/retained-road-review-context.ts';
import{readReviewedItameriOutsideRegistration}from '../lib/reviewed-itameri-outside-registration.ts';
import{readSerializedRoadFloor}from '../lib/serialized-road-floor.ts';
import{prepareAppendRoads,type RoadAuthority}from '../lib/delivery-city-roads.ts';
import{assertCurrentPlayableNavigationPreserved}from '../lib/delivery-navigation-preservation.ts';

test('25 exact heights preserve current A additions and the distinct w292 current tail',{skip:!available},()=>{
 const a=nextFixture(),c=a.composition,ids=new Set(c.literalInheritedIds);assert.equal(ids.size,25);assert.equal(a.additional.witnesses.length,24);assert.equal(c.literalInheritedRecords.filter((r:any)=>r.kind==='footways').length,12);
 for(const[before,after]of[[a.original,c.registeredAcceptedBaseline],[a.current,c.correctedCurrentBaseline]])for(const k of['nodes','lanes','connectors','footways','parking'])for(const r of before[k]){const actual=after[k].find((q:any)=>q.id===r.id);if(!ids.has(r.id))assert.deepEqual(actual,r);}
 const old=a.original.footways.find((r:any)=>r.id==='w29282225'),current=a.current.footways.find((r:any)=>r.id==='w29282225'),after=c.correctedCurrentBaseline.footways.find((r:any)=>r.id===current.id);assert.notEqual(hash(old),hash(current));assert.deepEqual(current.points.slice(9),after.points.slice(158));assert.equal(hash(after),'0f01bb5dea4a08d4e0ce7c2eec8d96b2753d53582b46f7b19910ac2848caf867');
 const graph=structuredClone(c.registeredAcceptedBaseline);for(const k of['nodes','lanes','connectors','footways','parking'])graph[k].push(...a.current[k].filter((r:any)=>!a.original[k].some((o:any)=>o.id===r.id)));
 const proof=assertCurrentPlayableNavigationPreserved(a.current,graph,a.coverage,a.original,c.registeredAcceptedBaseline,c.correctedCurrentBaseline);assert.equal(proof.reviewedHeightCorrections.length,25);assert.equal(proof.earlierExpansionRecordsPreserved,43);
});

test('25+122+869 separates horizontal registration and rejects incoming connectors or overlap',{skip:!available},()=>{
 const a=nextFixture(),job=JSON.parse(fs.readFileSync('../work/ruoholahti-main-walk-projection-plan-v6.json','utf8')),proposal=JSON.parse(fs.readFileSync(job.retainedRoadRegistrations[0].approvedProposal.file,'utf8')),floor=readSerializedRoadFloor(a.currentWorld,proposal.floor.region,a.original.originId);
 const retained=prepareRetainedRoadRegistrations(job.retainedRoadRegistrations,{accepted:a.original,acceptedManifestSha256:a.originalWorld.manifestSha256,acceptedCoverage:a.coverage,vehicleDefinitions:a.coverage.vehicleDefinitions,streetParts:{file:a.metadata.inputs.streetParts.path,sha256:a.metadata.inputs.streetParts.sha256},originProjected:a.om.origin.originProjected,selectedLaneIds:['122961573:0:f0'],floor:{manifestSha256:floor.receipt.manifestSha256,cells:floor.receipt.cells,triangles:floor.triangles},read});
 const itameri=readReviewedItameriOutsideRegistration(pin('../evidence/itameri-retained-outside-root-approval-v1.json'),{...a.context,coverage:a.expanded,otherRegistrationIds:['122961573:0:f0',...a.composition.literalInheritedIds],selectedNewConnectors:[],read});
 const args=[a.original,a.coverage,retained.authority,{authority:a.first.authority,current:a.current},{authority:a.additional.authority,current:a.current},{authority:itameri.authority,current:a.current,selectedNewConnectors:[]}]as const,c=composeReviewedRoadBaselines(...args);
 for(const id of['122961573:0:f0','86957349:0:f0']){assert.notDeepEqual(c.registeredAcceptedBaseline.lanes.find(r=>r.id===id),a.original.lanes.find((r:any)=>r.id===id));assert.deepEqual(c.correctedCurrentBaseline!.lanes.find(r=>r.id===id),a.current.lanes.find((r:any)=>r.id===id));}
 const graph=structuredClone(c.registeredAcceptedBaseline);for(const k of['nodes','lanes','connectors','footways','parking']as const)(graph[k]as any[]).push(...a.current[k].filter((r:any)=>!a.original[k].some((o:any)=>o.id===r.id)));
 const proof=assertCurrentPlayableNavigationPreserved(a.current,graph,a.coverage,a.original,c.registeredAcceptedBaseline,c.correctedCurrentBaseline);assert.equal(proof.reviewedHeightCorrections.length,25);assert.equal(proof.earlierExpansionRecordsPreserved,43);
 assert.throws(()=>composeReviewedRoadBaselines(...args.slice(0,5)as [any,any,any,any,any],{...args[5],selectedNewConnectors:[{...a.current.connectors[0],id:'new-unapproved',to:'86957349:0:f0'}]}),/No new incoming/);
 assert.throws(()=>additionalInheritedWalkingSources(a.additional.authority,a.original,a.current,['w123812255']),/overlaps/);
});

test('current-A source mask is mandatory and cannot be replaced by equal-sized unrelated coverage',{skip:!available},()=>{
 const a=nextFixture(),binding={schemaVersion:1 as const,walkingCurrentA:a.plan.inheritedRoadHeightBundle.walkingCurrentA,sourceMask:a.plan.inheritedRoadHeightBundle.sourceMask};
 assert.throws(()=>prepareAdditionalRoadInheritance({...binding,sourceMask:{...binding.sourceMask,sha256:'0'.repeat(64)}},a.context));
 const changed=structuredClone(a.expanded);changed.playArea.maxX+=1;assert.throws(()=>prepareAdditionalRoadInheritance(binding,{...a.context,coverage:changed}));
 assert.throws(()=>prepareAdditionalRoadInheritance({...binding,sourceMask:undefined}as never,a.context));
});

// A synthetic merge envelope exercises append authority composition only. It is
// deliberately not a regional source/network acceptance or a world write.
test('actual25 projection passes append tuple preservation; wrong final mask rejects',{skip:!available||!fs.existsSync('../work/inherited-next-bundle-integration-v1/projection-v1/road-projection-receipt.json')},()=>{
 const a=nextFixture(),outsideProjection=pin('../work/inherited-next-bundle-integration-v1/projection-v1/road-projection-receipt.json'),p=JSON.parse(read(outsideProjection).toString()),tmp=fs.mkdtempSync(path.join(os.tmpdir(),'road25-tuple-'));
 try{const write=(name:string,value:unknown)=>{const file=path.join(tmp,name);fs.writeFileSync(file,JSON.stringify(value)+'\n');return pin(file);},graph=structuredClone(a.composition.registeredAcceptedBaseline);for(const k of['nodes','lanes','connectors','footways','parking'])graph[k].push(...a.current[k].filter((r:any)=>!a.original[k].some((o:any)=>o.id===r.id)));
 const roads=write('roads.json',graph),collisions=a.cm.cells.map((c:any)=>({kind:'final' as const,cell:c.id,decodedSha256:c.collision.decodedSha256??c.collision.sha256})),native='a'.repeat(64),mask=a.plan.inheritedRoadHeightBundle.sourceMask.sha256,authority:RoadAuthority={accepted:a.original,current:a.current,acceptedManifestSha256:a.originalWorld.manifestSha256,acceptedRoadsSha256:a.om.roads.sha256,gameplay:a.coverage,supportedAreaSha256:mask,nativeIndices:[native],nativeCaches:[p.nativeCacheSha256],collisions,finalWorldManifestSha256:a.currentWorld.manifestSha256};
 const merge={schemaVersion:1,status:'PASS_SOURCE_QUALIFIED_ROAD_MERGE_PENDING_RUNTIME',acceptedManifestSha256:authority.acceptedManifestSha256,acceptedRoadsSha256:a.om.roads.sha256,mergedRoadsSha256:roads.sha256,acceptedPlayablePiecewiseGeometryPreserved:false,acceptedRecordsPreserved:false,reviewedBaselinePiecewiseGeometryPreserved:true,inheritedRoadHeight:p.inheritedRoadHeight,inheritedRoadHeightBundle:p.inheritedRoadHeightBundle,correctedCurrentBaselineSha256:hash(a.composition.correctedCurrentBaseline),expandedSupportedAreaSha256:mask,nativeCellsIndexSha256:native,supportInputs:collisions,outsideProjection:{receiptSha256:outsideProjection.sha256,repairedAcceptedRoadsSha256:p.repairedAcceptedRoads.sha256,changes:p.changes}},input={roads,outsideProjection,roadMerge:write('synthetic-merge.json',merge)};
 const result=prepareAppendRoads(input,authority);assert.equal(result.proof.changes.length,25);assert.deepEqual(result.correctedCurrentBaseline,a.composition.correctedCurrentBaseline);result.verifyInputs();
 assert.throws(()=>prepareAppendRoads(input,{...authority,supportedAreaSha256:'0'.repeat(64)}),/mask differs/);
 }finally{assert.ok(path.resolve(tmp).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(tmp).startsWith('road25-tuple-'));fs.rmSync(tmp,{recursive:true,force:true});}
});
