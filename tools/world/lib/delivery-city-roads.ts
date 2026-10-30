import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type {GameplayBundle,RoadGraph} from '../../../packages/world-schema/src/index.ts';
import {decodeDeliveryRoadFile} from './delivery-road-file.ts';
import {assertOutsideOnlyRoadGraphRepair} from './road-outside-repair.ts';
import {sourceSha256} from './source-files.ts';
import {prepareRetainedRoadRegistrations, registeredRetainedRoadBaseline} from './retained-road-review-context.ts';
import {readSerializedRoadFloor} from './serialized-road-floor.ts';
import {sourceFile} from './source-files.ts';
import {prepareAdditionalRoadInheritance,inspectAdditionalInheritanceDispositions,additionalPlazaRecords} from './inherited-road-bundle-context.ts';
import {prepareRoadInheritance,composeReviewedRoadBaselines,inspectInheritedLegacyDisposition} from './road-inheritance-context.ts';
import {deriveRoadPhysicalEnvelope} from './expansion-road-merge.ts';
import {readReviewedItameriOutsideRegistration}from './reviewed-itameri-outside-registration.ts';
import {prepareAppendWalkingReviews}from './delivery-road-walking-reviews.ts';
import {prepareCurrentNavigationCarry,currentCarryIds,assertCurrentNavigationCarry,currentOriginalNavigation}from './current-navigation-carry.ts';
import {readReviewedKopernikRegistration}from './reviewed-kopernik-registration.ts';
import {assertCurrentPlayableNavigationPreserved} from './delivery-navigation-preservation.ts';
import {prepareUdenmaankatuCrossing} from './road-finite-crossing-context.ts';
import {loadGeoJsonPolygons} from './geometry.ts';

export interface DeliveryRoadBinding {file:string;sha256:string}
export interface RoadAuthority {
  accepted:RoadGraph;acceptedManifestSha256:string;acceptedRoadsSha256:string;
  gameplay:Pick<GameplayBundle,'playArea'|'supportedArea'> & Partial<Pick<GameplayBundle,'vehicleDefinitions'>>;
  supportedAreaSha256?:string;
  nativeIndices:readonly string[];nativeCaches:readonly string[];
  collisions:readonly{kind:'accepted'|'new'|'final';cell:string;decodedSha256:string}[];
  finalWorldManifestSha256?:string;
  /** Actual current-world roads for inherited heights or retained source registrations. */
  current?:RoadGraph;
}
const groups=['nodes','lanes','connectors','parking','footways']as const;
/** Array prefixes preserve original record order and all metadata. Additional IDs
 * must be new, including in groups the semantic graph validator does not index. */
export function assertAcceptedRoadPrefix(accepted:RoadGraph,merged:RoadGraph){
  const prefix={...merged};
  for(const group of groups){const records=merged[group];assert.ok(records.length>=accepted[group].length,'Merged roads remove accepted '+group);assert.equal(new Set(records.map(r=>r.id)).size,records.length,'Duplicate merged road '+group+' ID');(prefix as any)[group]=records.slice(0,accepted[group].length);}
  assert.deepEqual(prefix,accepted,'Merged roads change accepted records or metadata');
}
/** Authoring projection is insufficient by itself. An exception needs the final
 * source/mask/serialized-collision merge receipt and an independently rechecked
 * whole accepted-geometry invariant. It remains pending final runtime gates. */
export function prepareAppendRoads(input:{roads:DeliveryRoadBinding;roadMerge?:DeliveryRoadBinding;outsideProjection?:DeliveryRoadBinding},authority:RoadAuthority){
  const pins:({file:string;sha256:string;bytes:number})[]=[];
  const read=(binding:DeliveryRoadBinding,cap=16*1024*1024)=>{assert.ok(binding&&typeof binding.file==='string');assert.match(binding.sha256,/^[a-f0-9]{64}$/);const stat=fs.lstatSync(binding.file);assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&stat.size>0&&stat.size<=cap,'Road proof is not a bounded ordinary file');const bytes=fs.readFileSync(binding.file);assert.equal(sourceSha256(bytes),binding.sha256,'Road proof hash changed: '+path.basename(binding.file));pins.push({...binding,bytes:bytes.length});return bytes;};
  const roadsBytes=read(input.roads,64*1024*1024),graph=decodeDeliveryRoadFile(roadsBytes);assert.equal(graph.originId,authority.accepted.originId);
  let expected=authority.accepted,changes:ReturnType<typeof assertOutsideOnlyRoadGraphRepair>=[],projection:any=null,merge:any=null,registrations:ReturnType<typeof prepareRetainedRoadRegistrations>|undefined;
  let additional:ReturnType<typeof prepareAdditionalRoadInheritance>|undefined,additionalObservations:ReturnType<typeof inspectAdditionalInheritanceDispositions>|undefined;
  let udenmaankatu:ReturnType<typeof prepareUdenmaankatuCrossing>|undefined;
  let itameri:ReturnType<typeof readReviewedItameriOutsideRegistration>|undefined,walkingReviews:ReturnType<typeof prepareAppendWalkingReviews>|undefined;
  let currentPlayablePreservation:ReturnType<typeof assertCurrentPlayableNavigationPreserved>|undefined;
  let carry:ReturnType<typeof prepareCurrentNavigationCarry>|undefined,kopernik:ReturnType<typeof readReviewedKopernikRegistration>|undefined;
  const oldConnectorIds=new Set(authority.accepted.connectors.map(c=>c.id)),selectedNewConnectors=graph.connectors.filter(c=>!oldConnectorIds.has(c.id));
  const retainedIds=()=>{const baseline=registrations?registeredRetainedRoadBaseline(registrations.authority,authority.accepted,authority.gameplay):authority.accepted;return [...baseline.lanes.filter((r,i)=>sourceSha256(JSON.stringify(r))!==sourceSha256(JSON.stringify(authority.accepted.lanes[i]))).map(r=>r.id),...(itameri?[itameri.witness.id]:[])];};
  const itameriComposition=()=>itameri?{authority:itameri.authority,current:authority.current!,selectedNewConnectors}:undefined;
  let inherited:ReturnType<typeof prepareRoadInheritance>|undefined,composition:ReturnType<typeof composeReviewedRoadBaselines>|undefined,legacy:ReturnType<typeof inspectInheritedLegacyDisposition>|undefined;
  if(input.outsideProjection){
    assert.ok(input.roadMerge,'Outside road projection requires a source-qualified road merge receipt');
    projection=JSON.parse(read(input.outsideProjection).toString());assert.equal(projection.schemaVersion,1);assert.equal(projection.kind,'source-bound-outside-road-projection');assert.equal(projection.status,'PROJECTED_PENDING_SUPPORTED_AREA_SERIALIZED_HCOL_AND_TRAVEL');assert.equal(projection.acceptedManifestSha256,authority.acceptedManifestSha256);assert.equal(projection.acceptedRoadsSha256,authority.acceptedRoadsSha256);
    assert.ok(authority.nativeCaches.includes(projection.nativeCacheSha256),'Outside road repair uses a different native cache');const metadata=JSON.parse(read(projection.nativeMetadata).toString());assert.equal(metadata.cache.sha256,projection.nativeCacheSha256);
    if(projection.currentNavigationCarry){
      assert.ok(authority.current&&projection.serializedFloorWorld,'Current carry requires actual CURRENT graph and serialized parent');
      const declared=projection.currentNavigationCarry,world=projection.serializedFloorWorld;assert.equal(world.manifestSha256,authority.finalWorldManifestSha256,'Current carry uses another append parent');assert.equal(declared.binding.sourceMask.sha256,authority.supportedAreaSha256,'Current carry uses another final mask');assert.equal(declared.authorityReceipt.originalWorld.manifestSha256,authority.acceptedManifestSha256);
      const rawCandidate=decodeDeliveryRoadFile(read(projection.originalCandidateRoads,64*1024*1024));
      carry=prepareCurrentNavigationCarry(declared.binding,{original:authority.accepted,current:authority.current,rawCandidate,originalWorld:declared.authorityReceipt.originalWorld,currentWorld:world,coverage:projection.expandedCoverage,read});assert.deepEqual(carry.receipt,declared.authorityReceipt,'Current carry authority differs at append');assertCurrentNavigationCarry(carry.authority,authority.accepted,authority.current,graph);
      const carried=new Set(currentCarryIds(carry.authority,'connectors'));for(let i=selectedNewConnectors.length-1;i>=0;i--)if(carried.has(selectedNewConnectors[i]!.id))selectedNewConnectors.splice(i,1);
    }
    if(projection.retainedRoadRegistrations){
      assert.ok(projection.serializedFloorWorld&&authority.gameplay.vehicleDefinitions,'Retained registration requires final floor and original vehicle definitions');
      const registered=projection.retainedRoadRegistrations;assert.equal(registered.kind,'recomputed-retained-road-registrations');
      assert.ok(Array.isArray(registered.bindings)&&registered.bindings.length===1);
      assert.equal(registered.streetParts.sha256,metadata.inputs.streetParts.sha256,'Registration uses another native source snapshot');
      const proposal=JSON.parse(read(registered.bindings[0].approvedProposal,4_000_000).toString());
      const world=projection.serializedFloorWorld,finalManifest=JSON.parse(read({file:sourceFile(world.directory,'manifest.json'),sha256:world.manifestSha256}).toString());
      if(authority.finalWorldManifestSha256)assert.equal(world.manifestSha256,authority.finalWorldManifestSha256,'Retained registration uses another append parent');
      const floor=readSerializedRoadFloor(world,proposal.floor.region,authority.accepted.originId);
      for(const cell of floor.receipt.cells){
        assert.ok(authority.collisions.some(actual=>actual.cell===cell.cell&&actual.decodedSha256===cell.decodedSha256),'Retained registration collision authority differs: '+cell.cell);
        const ref=finalManifest.cells.find((c:any)=>c.id===cell.cell).collision;
        read({file:sourceFile(world.directory,ref.path),sha256:ref.sha256},64*1024*1024);
      }
      registrations=prepareRetainedRoadRegistrations(registered.bindings,{accepted:authority.accepted,acceptedManifestSha256:authority.acceptedManifestSha256,acceptedCoverage:authority.gameplay,vehicleDefinitions:authority.gameplay.vehicleDefinitions,streetParts:registered.streetParts,originProjected:finalManifest.origin.originProjected,selectedLaneIds:[proposal.before.id],floor:{manifestSha256:floor.receipt.manifestSha256,cells:floor.receipt.cells,triangles:floor.triangles},read:(pin,cap)=>read(pin,cap??64*1024*1024)});
      assert.deepEqual(registrations.receipt,registered,'Retained registration receipt differs from recomputed authority');
    }
    if(projection.retainedItameriOutside){
      assert.ok(authority.current&&projection.serializedFloorWorld,'Itameri registration requires actual CURRENT graph and final floor');
      const declared=projection.retainedItameriOutside,world=projection.serializedFloorWorld;assert.equal(world.manifestSha256,authority.finalWorldManifestSha256,'Itameri registration uses another append parent');assert.equal(declared.originalWorld.manifestSha256,authority.acceptedManifestSha256);assert.deepEqual(Object.keys(declared.binding),['approval']);
      itameri=readReviewedItameriOutsideRegistration(declared.binding.approval,{original:authority.accepted,current:authority.current,originalWorld:declared.originalWorld,currentWorld:world,coverage:projection.expandedCoverage,selectedNewConnectors,otherRegistrationIds:retainedIds(),read});assert.deepEqual(itameri.receipt,declared.authorityReceipt,'Itameri authority changed at append');
      for(const cell of itameri.floor.cells)assert.ok(authority.collisions.some(c=>c.cell===cell.cell&&c.decodedSha256===cell.decodedSha256),'Itameri floor differs from append collision authority');
    }
    if(projection.udenmaankatuCrossing){
      assert.ok(authority.current&&projection.serializedFloorWorld,'Finite crossing requires actual CURRENT graph and final floor');
      const declared=projection.udenmaankatuCrossing,world=projection.serializedFloorWorld;assert.equal(world.manifestSha256,authority.finalWorldManifestSha256);assert.equal(declared.originalWorld.manifestSha256,authority.acceptedManifestSha256);assert.equal(declared.binding.sourceMask.sha256,authority.supportedAreaSha256,'Finite crossing uses another supported area');
      const raw=decodeDeliveryRoadFile(read(projection.originalCandidateRoads,64*1024*1024));udenmaankatu=prepareUdenmaankatuCrossing(declared.binding,{original:authority.accepted,current:authority.current,originalWorld:declared.originalWorld,currentWorld:world,coverage:projection.expandedCoverage,sourcePins:{osmSha256:raw.source.sha256,streetPartsSha256:metadata.inputs.streetParts.sha256},read});assert.deepEqual(udenmaankatu.receipt,declared.authorityReceipt,'Finite crossing authority differs at append');
      const finalManifest=JSON.parse(read({file:sourceFile(world.directory,'manifest.json'),sha256:world.manifestSha256}).toString());for(const c of finalManifest.cells)assert.ok(authority.collisions.some(a=>a.cell===c.id&&a.decodedSha256===(c.collision.decodedSha256??c.collision.sha256)),'Finite crossing floor differs from actual append collision authority');
    }
    if(projection.inheritedRoadHeightBundle){
      assert.ok(authority.current&&projection.serializedFloorWorld,'Inherited bundle requires actual CURRENT graph and final floor');
      if(projection.inheritedRoadHeightBundle.binding.walkingCurrentA||projection.inheritedRoadHeightBundle.binding.plazaService)assert.equal(projection.inheritedRoadHeightBundle.binding.sourceMask?.sha256,authority.supportedAreaSha256,'Current-A inherited mask differs from append supported area');
      const declared=projection.inheritedRoadHeightBundle,world=projection.serializedFloorWorld;assert.equal(world.manifestSha256,authority.finalWorldManifestSha256,'Inherited bundle uses another append parent');assert.equal(declared.originalWorld.manifestSha256,authority.acceptedManifestSha256);
      const ids=retainedIds(),candidate=decodeDeliveryRoadFile(read(projection.originalCandidateRoads,64*1024*1024));
      additional=prepareAdditionalRoadInheritance(declared.binding,{original:authority.accepted,current:authority.current,originalWorld:declared.originalWorld,currentWorld:world,sourcePins:{osmSha256:candidate.source.sha256,streetPartsSha256:metadata.inputs.streetParts.sha256},otherRegistrationIds:[...ids,...(projection.inheritedRoadHeight?['59804323:0:f0']:[])],coverage:projection.expandedCoverage});assert.deepEqual(additional.receipt,declared.authorityReceipt);
      const finalManifest=JSON.parse(read({file:sourceFile(world.directory,'manifest.json'),sha256:world.manifestSha256}).toString());
      for(const cell of finalManifest.cells)assert.ok(authority.collisions.some(actual=>actual.cell===cell.id&&actual.decodedSha256===(cell.collision.decodedSha256??cell.collision.sha256)),'Inherited bundle floor differs from actual append collision authority: '+cell.id);
    }
    if(projection.kopernikRegistration){
      assert.ok(authority.current&&projection.serializedFloorWorld,'Kopernik registration requires actual CURRENT graph and final floor');const declared=projection.kopernikRegistration,world=projection.serializedFloorWorld;
      assert.equal(world.manifestSha256,authority.finalWorldManifestSha256,'Kopernik registration uses another append parent');assert.equal(declared.originalWorld.manifestSha256,authority.acceptedManifestSha256);assert.deepEqual(Object.keys(declared.binding).sort(),['approval','provenanceArchive','sourceMask']);assert.equal(declared.binding.sourceMask.sha256,authority.supportedAreaSha256,'Kopernik registration uses another final mask');
      const rawCandidate=decodeDeliveryRoadFile(read(projection.originalCandidateRoads,64*1024*1024));kopernik=readReviewedKopernikRegistration(declared.binding.approval,{original:authority.accepted,current:authority.current,originalWorld:declared.originalWorld,currentWorld:world,sourceMask:declared.binding.sourceMask,coverage:projection.expandedCoverage,sourcePins:{osmSha256:rawCandidate.source.sha256,streetPartsSha256:metadata.inputs.streetParts.sha256},provenanceArchive:declared.binding.provenanceArchive,otherRegistrationIds:[...retainedIds(),...(projection.inheritedRoadHeight?['59804323:0:f0']:[]),...(additional?additional.witnesses.map(w=>w.id):[])],read});assert.deepEqual(kopernik.receipt,declared.authorityReceipt,'Kopernik authority differs at append');for(const cell of kopernik.receipt.localCollision)assert.ok(authority.collisions.some(c=>c.cell===cell.cell&&c.decodedSha256===cell.decodedSha256),'Kopernik floor differs from append collision authority');
    }
    if(projection.inheritedRoadHeight){
      assert.ok(authority.current&&authority.gameplay.vehicleDefinitions&&projection.serializedFloorWorld,'Inherited height requires the actual current graph and final floor');
      const world=projection.serializedFloorWorld,declared=projection.inheritedRoadHeight;
      assert.equal(world.manifestSha256,authority.finalWorldManifestSha256,'Inherited height uses another append parent');
      assert.equal(declared.originalWorld.manifestSha256,authority.acceptedManifestSha256);
      const otherRegistrationIds=retainedIds();
      const candidate=decodeDeliveryRoadFile(read(projection.originalCandidateRoads,64*1024*1024));
      inherited=prepareRoadInheritance(declared.binding,{original:authority.accepted,current:authority.current,originalWorld:declared.originalWorld,currentWorld:world,sourcePins:{osmSha256:candidate.source.sha256,streetPartsSha256:metadata.inputs.streetParts.sha256},otherRegistrationIds});
      assert.deepEqual(inherited.receipt,declared.authorityReceipt,'Inherited authority receipt differs from recomputed append inputs');
      composition=composeReviewedRoadBaselines(authority.accepted,authority.gameplay,registrations?.authority,{authority:inherited.authority,current:authority.current},additional?{authority:additional.authority,current:authority.current}:undefined,itameriComposition(),kopernik?{authority:kopernik.authority,current:authority.current!}:undefined);
      assert.deepEqual(decodeDeliveryRoadFile(read(projection.correctedCurrentBaseline,64*1024*1024)),composition.correctedCurrentBaseline,'Projection changed the reviewed CURRENT graph');
      const floor=readSerializedRoadFloor(world,[125,735,225,865],authority.accepted.originId);
      for(const cell of floor.receipt.cells)assert.ok(authority.collisions.some(actual=>actual.cell===cell.cell&&actual.decodedSha256===cell.decodedSha256),'Inherited floor differs from append collision authority: '+cell.cell);
      const finalManifest=JSON.parse(read({file:sourceFile(world.directory,'manifest.json'),sha256:world.manifestSha256}).toString());
      read({file:metadata.inputs.streetParts.path,sha256:metadata.inputs.streetParts.sha256},64*1024*1024);
      legacy=inspectInheritedLegacyDisposition(inherited.authority,{lane:composition.registeredAcceptedBaseline.lanes.find(l=>l.id===inherited!.witness.id)!,currentWorld:world,otherRegistrationIds,triangles:floor.triangles,parts:loadGeoJsonPolygons(metadata.inputs.streetParts.path,finalManifest.origin.originProjected[0],finalManifest.origin.originProjected[1],p=>String(p.osan_id)),coverage:projection.expandedCoverage,envelope:deriveRoadPhysicalEnvelope(authority.gameplay.vehicleDefinitions)});
      assert.deepEqual(legacy,declared.legacy,'Inherited failed-probe disposition differs from actual append floor');
      assert.equal(projection.acceptedPiecewiseGeometryPreserved,false);assert.equal(projection.reviewedBaselinePiecewiseGeometryPreserved,true);
    }
    composition??=composeReviewedRoadBaselines(authority.accepted,authority.gameplay,registrations?.authority,undefined,additional?{authority:additional.authority,current:authority.current!}:undefined,itameriComposition(),kopernik?{authority:kopernik.authority,current:authority.current!}:undefined);
    if(additional){
      assert.deepEqual(decodeDeliveryRoadFile(read(projection.correctedCurrentBaseline,64*1024*1024)),composition.correctedCurrentBaseline,'Projection changed the height-only CURRENT baseline');
      const ids=retainedIds();
      additionalObservations=inspectAdditionalInheritanceDispositions(additional.authority,{roads:composition.registeredAcceptedBaseline,currentWorld:projection.serializedFloorWorld,coverage:projection.expandedCoverage,otherRegistrationIds:[...ids,...(inherited?[inherited.witness.id]:[])]});assert.deepEqual(additionalObservations,projection.inheritedRoadHeightBundle.observations,'Inherited bundle observations changed at append');assert.equal(projection.acceptedPiecewiseGeometryPreserved,false);assert.equal(projection.reviewedBaselinePiecewiseGeometryPreserved,true);
    }

    const repaired=read(projection.repairedAcceptedRoads,64*1024*1024);assert.equal(repaired.length,projection.repairedAcceptedRoads.bytes);expected=decodeDeliveryRoadFile(repaired);if(udenmaankatu)for(const r of udenmaankatu.reviewedRecords)assert.deepEqual(expected.lanes.find(l=>l.id===r.id),r,'Append requires exact finite crossing AFTER');if(additional)for(const record of additionalPlazaRecords(additional.authority))assert.deepEqual(expected.lanes.find(l=>l.id===record.id),record,'Append requires every exact reviewed plaza AFTER');changes=assertOutsideOnlyRoadGraphRepair(authority.accepted,expected,authority.gameplay,composition.authority);assert.deepEqual(changes,projection.changes,'Outside road repair witnesses differ');
  }
  if(carry){currentPlayablePreservation=assertCurrentPlayableNavigationPreserved(authority.current!,graph,currentOriginalNavigation(carry.authority,authority.accepted).coverage,authority.accepted,composition!.registeredAcceptedBaseline,composition!.correctedCurrentBaseline,kopernik?.authority);assert.deepEqual(currentPlayablePreservation,projection.currentPlayablePreservation,'Current-playable proof differs at append');}
  assertAcceptedRoadPrefix(expected,graph);
  if(input.roadMerge){
    merge=JSON.parse(read(input.roadMerge).toString());assert.equal(merge.schemaVersion,1);assert.equal(merge.status,'PASS_SOURCE_QUALIFIED_ROAD_MERGE_PENDING_RUNTIME');assert.equal(merge.acceptedManifestSha256,authority.acceptedManifestSha256);assert.equal(merge.acceptedRoadsSha256,authority.acceptedRoadsSha256);assert.equal(merge.mergedRoadsSha256,input.roads.sha256,'Merge receipt certifies another road payload');assert.equal(merge.acceptedPlayablePiecewiseGeometryPreserved,!(inherited||additional||kopernik));assert.equal(merge.acceptedRecordsPreserved,changes.length===0);
    assert.deepEqual(merge.udenmaankatuCrossing??null,projection?.udenmaankatuCrossing??null,'Merge finite crossing differs from projection');assert.deepEqual(merge.currentNavigationCarry??null,projection?.currentNavigationCarry??null,'Merge current carry differs from projection');if(carry)assert.deepEqual(merge.currentPlayablePreservation,currentPlayablePreservation,'Merge current-playable proof differs from actual append');assert.deepEqual(merge.kopernikRegistration??null,projection?.kopernikRegistration??null,'Merge Kopernik differs from projection');
    assert.deepEqual(merge.retainedItameriOutside??null,projection?.retainedItameriOutside??null,'Merge Itameri declaration differs from projection');
    assert.deepEqual(merge.kaivopuistoFootway??null,projection?.kaivopuistoFootway??null,'Merge Kaivo declaration differs from projection');
    assert.ok(!merge.retainedWalkingCrossing||projection,'Retained crossing requires its outside projection');
    if(projection&&(projection.kaivopuistoFootway||merge.retainedWalkingCrossing))walkingReviews=prepareAppendWalkingReviews({projection,merge,graph,authority,read});
    assert.deepEqual(merge.inheritedRoadHeightBundle??null,projection?.inheritedRoadHeightBundle??null,'Merge inherited bundle differs from projection');
    assert.deepEqual(merge.inheritedRoadHeight??null,projection?.inheritedRoadHeight??null,'Merge inherited-height authority differs from projection');
    if(inherited||additional){assert.equal(merge.reviewedBaselinePiecewiseGeometryPreserved,true);assert.equal(merge.correctedCurrentBaselineSha256,sourceSha256(JSON.stringify(composition!.correctedCurrentBaseline)));}
    assert.deepEqual(merge.retainedRoadRegistrations??null,registrations?.receipt??null,'Merge retained registration differs from recomputed append authority');
    assert.ok(authority.supportedAreaSha256,'Qualified road merge requires the same reviewed supported area');assert.equal(merge.expandedSupportedAreaSha256,authority.supportedAreaSha256,'Road merge uses another supported area');assert.ok(authority.nativeIndices.includes(merge.nativeCellsIndexSha256),'Road merge uses another serialized native cell index');
    assert.ok(Array.isArray(merge.supportInputs)&&merge.supportInputs.length>0,'Road merge lacks serialized physical support inputs');for(const support of merge.supportInputs)assert.ok(authority.collisions.some(c=>c.kind===support.kind&&c.cell===support.cell&&c.decodedSha256===support.decodedSha256),'Road merge collision authority differs: '+support.cell);
    if(input.outsideProjection){assert.equal(merge.outsideProjection?.receiptSha256,input.outsideProjection.sha256);assert.equal(merge.outsideProjection.repairedAcceptedRoadsSha256,projection.repairedAcceptedRoads.sha256);assert.deepEqual(merge.outsideProjection.changes,changes);}else assert.equal(merge.outsideProjection??null,null,'Road merge declares an unprovided projection exception');
  }
  composition??=composeReviewedRoadBaselines(authority.accepted,authority.gameplay,registrations?.authority);
  return{graph,...(kopernik?{kopernikRegistration:kopernik.authority}:{}),registeredAcceptedBaseline:composition.registeredAcceptedBaseline,...(composition.correctedCurrentBaseline?{correctedCurrentBaseline:composition.correctedCurrentBaseline}:{}),proof:{acceptedRoadsSha256:authority.acceptedRoadsSha256,mergedRoadsInputSha256:input.roads.sha256,acceptedRecordsPreserved:changes.length===0,acceptedPlayablePiecewiseGeometryPreserved:!(inherited||additional||kopernik),reviewedBaselinePiecewiseGeometryPreserved:true,roadMergeReceiptSha256:input.roadMerge?.sha256??null,outsideProjectionReceiptSha256:input.outsideProjection?.sha256??null,...(udenmaankatu?{udenmaankatuCrossing:udenmaankatu.receipt}:{}),...(carry?{currentNavigationCarry:carry.receipt,currentPlayablePreservation}:{}),...(kopernik?{kopernikRegistration:kopernik.receipt}:{}),...(registrations?{retainedRoadRegistrations:registrations.receipt.witnesses}:{}),...(itameri?{retainedItameriOutside:itameri.receipt}:{}),...(walkingReviews?{reviewedWalkingSources:walkingReviews.receipt}:{}),...(additional?{inheritedRoadHeightBundle:{authority:additional.receipt,observations:additionalObservations}}:{}),...(inherited?{inheritedRoadHeight:{authority:inherited.receipt,legacyDisposition:legacy!.disposition}}:{}),changes,status:merge?'PASS_SOURCE_QUALIFIED_ROAD_MERGE_PENDING_RUNTIME':'PASS_ACCEPTED_ROAD_PREFIX_PRESERVED_NEW_ROAD_QUALIFICATION_NOT_PROVIDED'},verifyInputs:()=>{for(const ref of pins){const bytes=fs.readFileSync(ref.file);assert.equal(bytes.length,ref.bytes,'Road proof input length changed');assert.equal(sourceSha256(bytes),ref.sha256,'Road proof input changed during append');}registrations?.verifyInputs();inherited?.verifyInputs();additional?.verifyInputs();itameri?.verifyInputs();walkingReviews?.verifyInputs();carry?.verifyInputs();kopernik?.verifyInputs();udenmaankatu?.verifyInputs();}};
}
