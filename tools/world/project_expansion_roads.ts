// Source-bound vertical road projection. Output remains pending supported-area, serialized HCOL and travel gates.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {deserialize} from 'node:v8';
import {parseArgs} from 'node:util';
import {decodeRoadGraph, decodeSimulationPayload, type RoadGraph, type Vec3} from '../../packages/world-schema/src/index.ts';
import {RoadCollisionSupport, isPublicWalkingGroundTag, deriveRoadPhysicalEnvelope, type RoadCoverage, type RoadSupportTriangle} from './lib/expansion-road-merge.ts';
import {assertOutsideOnlyRoadGraphRepair, repairOutsidePolyline} from './lib/road-outside-repair.ts';
import {repairNewStraightConnectorOvershoot} from './lib/road-connector-repair.ts';
import {readSourceFile, sourceSha256, writeSourceJson} from './lib/source-files.ts';
import {readSerializedRoadFloor,type SerializedFloorWorld} from './lib/serialized-road-floor.ts';
import {prepareBridgeLevelProjectors} from './lib/bridge-road-floor.ts';
import {prepareReviewedWalkingProjectors} from './lib/reviewed-walking-floor.ts';
import {prepareRetainedRoadRegistrations, registeredRetainedRoadBaseline, type RetainedRoadReviewBinding} from './lib/retained-road-review-context.ts';
import {prepareRoadInheritance,composeReviewedRoadBaselines,isLiteralInheritedRoad,isLiteralHorizontalRegistration,inspectInheritedLegacyDisposition,type RoadInheritanceBinding} from './lib/road-inheritance-context.ts';
import {prepareAdditionalRoadInheritance,inspectAdditionalInheritanceDispositions,additionalPlazaRecords,type RoadInheritanceBundleBinding} from './lib/inherited-road-bundle-context.ts';
import {readReviewedItameriOutsideRegistration}from './lib/reviewed-itameri-outside-registration.ts';
import {prepareKaivopuistoFootway,readProjectionWalkingOsm,type KaivopuistoFootwayBinding}from './lib/road-walking-review-context.ts';
import {assertOutsideOnlyPolylineRepair} from './lib/road-outside-repair.ts';
import {assertCurrentPlayableNavigationPreserved} from './lib/delivery-navigation-preservation.ts';
import {loadGeoJsonPolygons} from './lib/geometry.ts';
import {prepareCurrentNavigationCarry,carryCurrentNavigation,currentCarryIds,assertCurrentNavigationCarry,currentOriginalNavigation,type CurrentNavigationCarryBinding}from './lib/current-navigation-carry.ts';
import {prepareUdenmaankatuCrossing,type UdenmaankatuCrossingBinding} from './lib/road-finite-crossing-context.ts';
import {readReviewedKopernikRegistration}from './lib/reviewed-kopernik-registration.ts';

interface Pin {file: string; sha256: string}
interface ProjectionJob {schemaVersion: 1; acceptedWorld: string; expectedManifestSha256: string; candidateRoads: Pin; nativeMetadata: Pin; serializedFloorWorld?:SerializedFloorWorld;bridgeLevelInventory?:Pin;walkingSurfaceReviews?:Pin[];
  retainedRoadRegistrations?: RetainedRoadReviewBinding[];
  inheritedRoadHeight?: RoadInheritanceBinding;
  inheritedRoadHeightBundle?:RoadInheritanceBundleBinding;udenmaankatuCrossing?:UdenmaankatuCrossingBinding;
  retainedItameriOutside?:{approval:Pin};kaivopuistoFootway?:KaivopuistoFootwayBinding;
  currentNavigationCarry?:CurrentNavigationCarryBinding;kopernikRegistration?:{approval:Pin;provenanceArchive:Pin;sourceMask:Pin};
  expandedCoverage: RoadCoverage; retainedLaneIds: string[]; newLaneIds: string[]; connectorIds: string[]; retainedFootwayIds?: string[]; newFootwayIds?: string[]; walkingRoutes?: {id: string; steps: {wayId: number; fromNode: number; toNode: number}[]}[];
  connectorContinuationReviews?: {id: string; maximumAngleDegrees: number; connectorSha256: string; fromLaneSha256: string; toLaneSha256: string; sourceNode: string}[]}
const {values} = parseArgs({options: {plan: {type: 'string'}, out: {type: 'string'}, 'diagnostic-partial':{type:'boolean',default:false}}});
assert.ok(values.plan && values.out); assert.ok(!fs.existsSync(values.out), 'Fresh road projection output required');
const planBytes = fs.readFileSync(values.plan); assert.ok(planBytes.length < 2_000_000); const job = JSON.parse(planBytes.toString()) as ProjectionJob; assert.equal(job.schemaVersion, 1);
const pin = (ref: Pin, cap = 256_000_000) => {const stat = fs.lstatSync(ref.file); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= cap); const bytes = fs.readFileSync(ref.file); assert.equal(sourceSha256(bytes), ref.sha256, 'Road projection source changed'); return bytes;};
const manifestBytes = pin({file: path.join(job.acceptedWorld, 'manifest.json'), sha256: job.expectedManifestSha256}), manifest = JSON.parse(manifestBytes.toString());
const accepted = decodeRoadGraph(await decodeSimulationPayload(readSourceFile(job.acceptedWorld, manifest.roads), manifest.roads));
const acceptedCoverage = JSON.parse(readSourceFile(job.acceptedWorld, manifest.gameplay).toString()) as RoadCoverage;
const candidate = decodeRoadGraph(pin(job.candidateRoads)), metadata = JSON.parse(pin(job.nativeMetadata).toString());
for (const review of job.connectorContinuationReviews ?? []) {
  const connector = candidate.connectors.find(record => record.id === review.id); assert.ok(connector);
  const from = candidate.lanes.find(record => record.id === connector.from), to = candidate.lanes.find(record => record.id === connector.to); assert.ok(from && to);
  assert.equal(sourceSha256(JSON.stringify(connector)), review.connectorSha256); assert.equal(sourceSha256(JSON.stringify(from)), review.fromLaneSha256); assert.equal(sourceSha256(JSON.stringify(to)), review.toLaneSha256);
  assert.equal(connector.node, review.sourceNode); assert.equal(from.to, review.sourceNode); assert.equal(to.from, review.sourceNode);
}
assert.equal(metadata.kind, 'native-delivery-ground-cache');
for (const ref of Object.values(metadata.inputs) as {path: string; sha256: string}[]) pin({file: ref.path, sha256: ref.sha256});
for (const [file, sha256] of Object.entries(metadata.producerHashes) as [string, string][]) pin({file: path.resolve(metadata.producerRoot, file), sha256});
// The cumulative southern native ground cache is292MB; only this pinned offline cache gets the512MB bound.
const cacheBytes = pin({file: metadata.cache.path, sha256: metadata.cache.sha256}, 512_000_000); assert.equal(cacheBytes.length, metadata.cache.bytes);
const triangles: RoadSupportTriangle[] = [];let serializedFloor:ReturnType<typeof readSerializedRoadFloor>['receipt']|undefined;
if(job.serializedFloorWorld){
  const laneIds=new Set([...job.retainedLaneIds,...job.newLaneIds]),footIds=new Set([...job.retainedFootwayIds??[],...job.newFootwayIds??[]]),connectorIds=new Set(job.connectorIds);
  const points=[...accepted.lanes,...candidate.lanes].filter(p=>laneIds.has(p.id)).flatMap(p=>p.points).concat([...accepted.footways,...candidate.footways].filter(p=>footIds.has(p.id)).flatMap(p=>p.points),candidate.connectors.filter(p=>connectorIds.has(p.id)).flatMap(p=>p.points));assert.ok(points.length);
  const region=points.reduce<[number,number,number,number]>((b,p)=>[Math.min(b[0],p[0]-5),Math.min(b[1],p[2]-5),Math.max(b[2],p[0]+5),Math.max(b[3],p[2]+5)],[Infinity,Infinity,-Infinity,-Infinity]);
  const floor=readSerializedRoadFloor(job.serializedFloorWorld,region,manifest.origin.id);for(const t of floor.triangles)triangles.push(t);serializedFloor=floor.receipt;
}else{
const cache = deserialize(cacheBytes) as {ground: {pieces: {cell: string; tag: string; positions: number[]; indices: number[]}[]}};
for (const piece of cache.ground.pieces) if (piece.tag.startsWith('road:') || isPublicWalkingGroundTag(piece.tag)) for (let i = 0; i < piece.indices.length; i += 3) {
  const points = [0, 1, 2].map(k => piece.positions.slice(piece.indices[i + k]! * 3, piece.indices[i + k]! * 3 + 3) as Vec3);
  triangles.push({id: `${piece.cell}:${triangles.length}`, tag: piece.tag, points: points as [Vec3, Vec3, Vec3]});
}
}
const support = new RoadCollisionSupport(triangles), project = (x: number, z: number) => support.project(x, z);
const walkingSupport = new RoadCollisionSupport(triangles, isPublicWalkingGroundTag);
assert.ok(!job.bridgeLevelInventory||job.serializedFloorWorld,'Bridge levels require actual serialized floor authority');
const levels=job.bridgeLevelInventory?prepareBridgeLevelProjectors(job.bridgeLevelInventory,job.serializedFloorWorld!,triangles,candidate,pin):undefined;
assert.ok(!job.walkingSurfaceReviews||job.serializedFloorWorld,'Reviewed walking faces require actual serialized floor authority');
const reviewedWalking=job.walkingSurfaceReviews?prepareReviewedWalkingProjectors(job.walkingSurfaceReviews,job.serializedFloorWorld!,triangles,candidate,pin):undefined;
assert.ok(!job.retainedRoadRegistrations || serializedFloor, 'Retained horizontal registration requires current serialized floor');
const registrations = job.retainedRoadRegistrations ? prepareRetainedRoadRegistrations(job.retainedRoadRegistrations,{accepted,acceptedManifestSha256:job.expectedManifestSha256,acceptedCoverage,vehicleDefinitions:(acceptedCoverage as any).vehicleDefinitions,streetParts:{file:metadata.inputs.streetParts.path,sha256:metadata.inputs.streetParts.sha256},originProjected:manifest.origin.originProjected,selectedLaneIds:job.retainedLaneIds,floor:{manifestSha256:serializedFloor!.manifestSha256,cells:serializedFloor!.cells,triangles},read:pin}) : undefined;
const retainedBaseline=registrations?registeredRetainedRoadBaseline(registrations.authority,accepted,acceptedCoverage):accepted;
const retainedIds=retainedBaseline.lanes.filter((lane,i)=>sourceSha256(JSON.stringify(lane))!==sourceSha256(JSON.stringify(accepted.lanes[i]))).map(lane=>lane.id);
assert.ok(!(job.inheritedRoadHeight||job.inheritedRoadHeightBundle||job.retainedItameriOutside||job.currentNavigationCarry||job.kopernikRegistration||job.udenmaankatuCrossing)||job.serializedFloorWorld,'Reviewed navigation requires actual current serialized world');
const currentManifest=(job.inheritedRoadHeight||job.inheritedRoadHeightBundle||job.retainedItameriOutside||job.currentNavigationCarry||job.kopernikRegistration||job.udenmaankatuCrossing)?JSON.parse(pin({file:path.join(job.serializedFloorWorld!.directory,'manifest.json'),sha256:job.serializedFloorWorld!.manifestSha256},16*1024*1024).toString()):undefined;
const current=currentManifest?decodeRoadGraph(await decodeSimulationPayload(readSourceFile(job.serializedFloorWorld!.directory,currentManifest.roads),currentManifest.roads)):undefined;
const carried=job.currentNavigationCarry?prepareCurrentNavigationCarry(job.currentNavigationCarry,{original:accepted,current:current!,rawCandidate:candidate,originalWorld:{directory:job.acceptedWorld,manifestSha256:job.expectedManifestSha256},currentWorld:job.serializedFloorWorld!,coverage:job.expandedCoverage,read:pin}):undefined;
const carryIds=(kind:'lanes'|'connectors'|'footways')=>new Set(carried?currentCarryIds(carried.authority,kind):[]);
const carriedLaneIds=carryIds('lanes'),carriedConnectorIds=carryIds('connectors'),carriedFootwayIds=carryIds('footways');
const selectedNewConnectors=job.connectorIds.filter(id=>!carriedConnectorIds.has(id)).map(id=>{const c=candidate.connectors.find(c=>c.id===id);assert.ok(c);return c;});
if(job.retainedItameriOutside){assert.deepEqual(Object.keys(job.retainedItameriOutside),['approval']);assert.ok(job.retainedLaneIds.includes('86957349:0:f0'));}
const itameri=job.retainedItameriOutside?readReviewedItameriOutsideRegistration(job.retainedItameriOutside.approval,{original:accepted,current:current!,originalWorld:{directory:job.acceptedWorld,manifestSha256:job.expectedManifestSha256},currentWorld:job.serializedFloorWorld!,coverage:job.expandedCoverage,selectedNewConnectors,otherRegistrationIds:retainedIds,read:pin}):undefined;if(itameri)retainedIds.push(itameri.witness.id);
const inherited=job.inheritedRoadHeight?prepareRoadInheritance(job.inheritedRoadHeight,{original:accepted,current:current!,originalWorld:{directory:job.acceptedWorld,manifestSha256:job.expectedManifestSha256},currentWorld:job.serializedFloorWorld!,sourcePins:{osmSha256:candidate.source.sha256,streetPartsSha256:metadata.inputs.streetParts.sha256},otherRegistrationIds:retainedIds}):undefined;
const additional=job.inheritedRoadHeightBundle?prepareAdditionalRoadInheritance(job.inheritedRoadHeightBundle,{original:accepted,current:current!,originalWorld:{directory:job.acceptedWorld,manifestSha256:job.expectedManifestSha256},currentWorld:job.serializedFloorWorld!,sourcePins:{osmSha256:candidate.source.sha256,streetPartsSha256:metadata.inputs.streetParts.sha256},otherRegistrationIds:[...retainedIds,...(inherited?[inherited.witness.id]:[])],coverage:job.expandedCoverage}):undefined;
if(job.kopernikRegistration)assert.deepEqual(Object.keys(job.kopernikRegistration).sort(),['approval','provenanceArchive','sourceMask']);
const kopernik=job.kopernikRegistration?readReviewedKopernikRegistration(job.kopernikRegistration.approval,{original:accepted,current:current!,originalWorld:{directory:job.acceptedWorld,manifestSha256:job.expectedManifestSha256},currentWorld:job.serializedFloorWorld!,sourceMask:job.kopernikRegistration.sourceMask,coverage:job.expandedCoverage,sourcePins:{osmSha256:candidate.source.sha256,streetPartsSha256:metadata.inputs.streetParts.sha256},provenanceArchive:job.kopernikRegistration.provenanceArchive,otherRegistrationIds:[...retainedIds,...(inherited?[inherited.witness.id]:[]),...(additional?additional.witnesses.map(w=>w.id):[])],read:pin}):undefined;
const udenmaankatu=job.udenmaankatuCrossing?prepareUdenmaankatuCrossing(job.udenmaankatuCrossing,{original:accepted,current:current!,originalWorld:{directory:job.acceptedWorld,manifestSha256:job.expectedManifestSha256},currentWorld:job.serializedFloorWorld!,coverage:job.expandedCoverage,sourcePins:{osmSha256:candidate.source.sha256,streetPartsSha256:metadata.inputs.streetParts.sha256},read:pin}):undefined;
const finiteRecords=new Map(udenmaankatu?.reviewedRecords.map(r=>[r.id,r]));assert.ok([...finiteRecords.keys()].every(id=>job.retainedLaneIds.includes(id)),'Both finite crossing records must be explicitly selected');
const composition=composeReviewedRoadBaselines(accepted,acceptedCoverage,registrations?.authority,inherited?{authority:inherited.authority,current:current!}:undefined,additional?{authority:additional.authority,current:current!}:undefined,itameri?{authority:itameri.authority,current:current!,selectedNewConnectors}:undefined,kopernik?{authority:kopernik.authority,current:current!}:undefined);
assert.ok(composition.literalInheritedRecords.every(r=>(r.kind==='lanes'?job.retainedLaneIds:job.retainedFootwayIds??[]).includes(r.id)),'Inherited record must be explicitly selected for projection');
const repaired=composition.registeredAcceptedBaseline,proofs:unknown[]=[],failures:unknown[]=[];
const currentNavigation=carried?currentOriginalNavigation(carried.authority,accepted):undefined;
const retainedProtection=currentNavigation?.coverage??acceptedCoverage;
if(currentNavigation)for(const repair of currentNavigation.repairs){const index=repaired[repair.kind].findIndex(r=>r.id===repair.id),record=repaired[repair.kind][index]!;assert.ok(index>=0);
 if(isLiteralInheritedRoad(composition.authority,accepted,acceptedCoverage,repair.kind,record))continue;
 assert.deepEqual(record,accepted[repair.kind].find(r=>r.id===repair.id),'Current outside repair overlaps a nonliteral registration');
 (repaired[repair.kind] as unknown[])[index]=structuredClone(currentNavigation.baseline[repair.kind].find(r=>r.id===repair.id)!);
}
const plazaRecords=new Map((additional?additionalPlazaRecords(additional.authority):[]).map(r=>[r.id,r]));
assert.ok([...plazaRecords.keys()].every(id=>job.retainedLaneIds.includes(id)),'All approved plaza records must be explicitly selected');
const legacy=inherited?inspectInheritedLegacyDisposition(inherited.authority,{lane:repaired.lanes.find(l=>l.id===inherited.witness.id)!,currentWorld:job.serializedFloorWorld!,otherRegistrationIds:retainedIds,triangles,parts:loadGeoJsonPolygons(metadata.inputs.streetParts.path,manifest.origin.originProjected[0],manifest.origin.originProjected[1],p=>String(p.osan_id)),coverage:job.expandedCoverage,envelope:deriveRoadPhysicalEnvelope((acceptedCoverage as any).vehicleDefinitions)}):undefined;
const additionalObservations=additional?inspectAdditionalInheritanceDispositions(additional.authority,{roads:repaired,currentWorld:job.serializedFloorWorld!,coverage:job.expandedCoverage,otherRegistrationIds:[...retainedIds,...(inherited?[inherited.witness.id]:[])]}):undefined;
assert.ok(!job.kaivopuistoFootway||job.serializedFloorWorld,'Kaivo source registration requires actual floor');
const kaivo=job.kaivopuistoFootway?prepareKaivopuistoFootway(job.kaivopuistoFootway,{original:accepted,candidate,world:job.serializedFloorWorld!,sourcePins:{osmSha256:candidate.source.sha256,streetPartsSha256:metadata.inputs.streetParts.sha256},osm:readProjectionWalkingOsm(metadata,candidate,pin).osm,parts:loadGeoJsonPolygons(metadata.inputs.streetParts.path,manifest.origin.originProjected[0],manifest.origin.originProjected[1],p=>String(p.osan_id)),selectedNewFootwayIds:job.newFootwayIds??[],read:pin}):undefined;
let projected = carried?carryCurrentNavigation(carried.authority,accepted,candidate):structuredClone(candidate) as RoadGraph;
for (const [kind, graph, ids] of [['retained', repaired, job.retainedLaneIds], ['new', projected, job.newLaneIds]] as const) {
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) {
    const lane = graph.lanes.find(lane => lane.id === id); assert.ok(lane, 'Selected projection lane missing');
    if (kind === 'new') assert.ok(!accepted.lanes.some(lane => lane.id === id), 'New projection replaces accepted lane');
    if(kind==='new'&&carriedLaneIds.has(id)){proofs.push({kind:'carried-lane',id,actualCurrentRecordPreserved:true,afterSha256:sourceSha256(JSON.stringify(lane))});continue;}
    if(kind==='retained'&&finiteRecords.has(id)){
      const after=finiteRecords.get(id)!,{points:beforePoints,...beforeMetadata}=lane,{points:afterPoints,...afterMetadata}=after;
      assert.deepEqual(beforeMetadata,afterMetadata,'Finite crossing changed metadata');assertOutsideOnlyPolylineRepair(beforePoints,afterPoints,retainedProtection);assertOutsideOnlyPolylineRepair(accepted.lanes.find(l=>l.id===id)!.points,afterPoints,acceptedCoverage);
      (lane as {points:readonly Vec3[]}).points=structuredClone(afterPoints);proofs.push({kind,id,literalFiniteCrossingRecordPreserved:true,noProtectedHeightException:true,afterSha256:sourceSha256(JSON.stringify(lane))});continue;
    }
    if(kind==='retained'&&plazaRecords.has(id)){
      const after=plazaRecords.get(id)!,{points:beforePoints,...beforeMetadata}=lane,{points:afterPoints,...afterMetadata}=after;
      assert.deepEqual(beforeMetadata,afterMetadata,'Plaza authoring changed lane metadata');
      if(!isLiteralInheritedRoad(composition.authority,accepted,acceptedCoverage,'lanes',lane))assertOutsideOnlyPolylineRepair(beforePoints,afterPoints,acceptedCoverage);
      (lane as {points:readonly Vec3[]}).points=structuredClone(afterPoints);proofs.push({kind,id,literalReviewedPlazaRecordPreserved:true,protectedHeightAuthority:composition.literalInheritedIds.includes(id),afterSha256:sourceSha256(JSON.stringify(lane))});continue;
    }
    if(kind==='retained'&&isLiteralInheritedRoad(composition.authority,accepted,acceptedCoverage,'lanes',lane)){proofs.push({kind,id,...(isLiteralHorizontalRegistration(composition.authority,accepted,acceptedCoverage,'lanes',lane)?{literalHorizontalRegistrationPreserved:true}:{literalInheritedRecordPreserved:true}),afterSha256:sourceSha256(JSON.stringify(lane))});continue;}
    try {const result = repairOutsidePolyline(lane.points,kind==='retained'?retainedProtection:acceptedCoverage,job.expandedCoverage,kind==='new'?levels?.projectFor('lane',id,project)??project:project,.25,kind==='retained'?acceptedCoverage:undefined); (lane as {points: readonly Vec3[]}).points = result.points; proofs.push({kind, id, ...result.proof});}
    catch (error) {failures.push({kind, id, reason: (error as Error).message});}
  }
}
for (const [kind, graph, ids] of [['retained-footway', repaired, job.retainedFootwayIds ?? []], ['new-footway', projected, job.newFootwayIds ?? []]] as const) {
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) {const footway = graph.footways.find(record => record.id === id); assert.ok(footway, 'Selected projection footway missing'); if (kind === 'new-footway') assert.ok(!accepted.footways.some(prior => prior.id === id));
    if(kind==='new-footway'&&carriedFootwayIds.has(id)){proofs.push({kind:'carried-footway',id,actualCurrentRecordPreserved:true,afterSha256:sourceSha256(JSON.stringify(footway))});continue;}
    if(kind==='retained-footway'&&isLiteralInheritedRoad(composition.authority,accepted,acceptedCoverage,'footways',footway)){proofs.push({kind,id,literalInheritedRecordPreserved:true,afterSha256:sourceSha256(JSON.stringify(footway))});continue;}
    try {const fallback=(x:number,z:number)=>walkingSupport.project(x,z),reviewed=reviewedWalking?.projectFor(id,fallback)??fallback,result = repairOutsidePolyline(footway.points,kind==='retained-footway'?retainedProtection:acceptedCoverage,job.expandedCoverage,kind==='new-footway'?levels?.projectFor('footway',id,reviewed)??reviewed:fallback,.25,kind==='retained-footway'?acceptedCoverage:undefined); (footway as {points: readonly Vec3[]}).points = result.points; proofs.push({kind, id, ...result.proof});}
    catch (error) {failures.push({kind, id, reason: (error as Error).message});}
  }
}
// Connectors retain their native XZ geometry and receive exact lane endpoints after projection.
for (const id of job.connectorIds) {
  const connector = projected.connectors.find(connector => connector.id === id); assert.ok(connector && !accepted.connectors.some(prior => prior.id === id));
  if(carriedConnectorIds.has(id)){proofs.push({kind:'carried-connector',id,actualCurrentRecordPreserved:true,afterSha256:sourceSha256(JSON.stringify(connector))});continue;}
  const lane = (id: string) => repaired.lanes.find(lane => lane.id === id) ?? projected.lanes.find(lane => lane.id === id);
  const from = lane(connector.from), to = lane(connector.to); assert.ok(from && to);
  try {
    const result = repairOutsidePolyline(connector.points, acceptedCoverage, job.expandedCoverage, levels?.projectFor('connector',id,project)??project), points = result.points;
    assert.ok(Math.hypot(points[0]![0] - from.points.at(-1)![0], points[0]![2] - from.points.at(-1)![2]) <= .02 && Math.hypot(points.at(-1)![0] - to.points[0]![0], points.at(-1)![2] - to.points[0]![2]) <= .02, 'Source connector endpoint requires explicit horizontal registration');
    points[0] = [...from.points.at(-1)!]; points[points.length - 1] = [...to.points[0]!]; (connector as {points: readonly Vec3[]}).points = points;
    proofs.push({kind: 'new-connector', id, ...result.proof});
  } catch (error) {failures.push({kind: 'new-connector', id, reason: (error as Error).message});}
}
const changes = assertOutsideOnlyRoadGraphRepair(accepted, repaired, acceptedCoverage, composition.authority);
let connectorRepair: ReturnType<typeof repairNewStraightConnectorOvershoot>['witness'] | undefined;
if (!failures.length) {
  const repair = repairNewStraightConnectorOvershoot(repaired, projected, job.newLaneIds.filter(id=>!carriedLaneIds.has(id)), job.connectorIds.filter(id=>!carriedConnectorIds.has(id)), project, job.connectorContinuationReviews,levels?(id,x,z)=>levels.projectFor('connector',id,project)(x,z):undefined); projected = repair.graph; connectorRepair = repair.witness;
}
if(carried)assertCurrentNavigationCarry(carried.authority,accepted,current!,projected);
const currentPlayablePreservation=carried?assertCurrentPlayableNavigationPreserved(current!,carryCurrentNavigation(carried.authority,accepted,repaired),retainedProtection,accepted,composition.registeredAcceptedBaseline,composition.correctedCurrentBaseline,kopernik?.authority):undefined;
fs.mkdirSync(values.out, {recursive: true});
if (failures.length) {
  const partial=values['diagnostic-partial']?{accepted:writeSourceJson(values.out,'accepted-roads-diagnostic.json',repaired),candidate:writeSourceJson(values.out,'candidate-roads-diagnostic.json',projected)}:undefined;
  writeSourceJson(values.out, 'road-projection-failure.json', {schemaVersion: 1, status: 'RETHINK_NATIVE_ROAD_PROJECTION', planSha256: sourceSha256(planBytes), nativeMetadataSha256: job.nativeMetadata.sha256, nativeCacheSha256: metadata.cache.sha256,...(serializedFloor?{serializedFloorWorld:job.serializedFloorWorld,serializedFloor,...(levels?{levelSelection:levels.receipt}:{}),...(reviewedWalking?{walkingSurfaceSelection:reviewedWalking.receipt}:{})}:{}),...(partial?{diagnosticOnlyPartialGraphs:partial}:{}), proofs, failures}); throw new Error(`${failures.length} selected road records lack qualified native projection`);
}
registrations?.verifyInputs();
inherited?.verifyInputs();additional?.verifyInputs();itameri?.verifyInputs();kaivo?.verifyInputs();carried?.verifyInputs();kopernik?.verifyInputs();udenmaankatu?.verifyInputs();
const kaivoProjection=kaivo?.projected(projected);
const repairedRef = writeSourceJson(values.out, 'accepted-roads-outside-repaired.json', repaired), candidateRef = writeSourceJson(values.out, 'candidate-roads-native-projected.json', projected);
const currentRef=composition.correctedCurrentBaseline?writeSourceJson(values.out,'current-roads-reviewed-baseline.json',composition.correctedCurrentBaseline):undefined;
const receipt = {schemaVersion: 1, kind: 'source-bound-outside-road-projection', status: 'PROJECTED_PENDING_SUPPORTED_AREA_SERIALIZED_HCOL_AND_TRAVEL', acceptedManifestSha256: job.expectedManifestSha256, acceptedRoadsSha256: manifest.roads.sha256, originalCandidateRoads: job.candidateRoads,...(udenmaankatu?{udenmaankatuCrossing:{binding:job.udenmaankatuCrossing,originalWorld:{directory:job.acceptedWorld,manifestSha256:job.expectedManifestSha256},authorityReceipt:udenmaankatu.receipt}}:{}), nativeMetadata: job.nativeMetadata, nativeCacheSha256: metadata.cache.sha256, ...(carried?{currentNavigationCarry:{binding:job.currentNavigationCarry,authorityReceipt:carried.receipt},currentPlayablePreservation}:{}),...(kopernik?{kopernikRegistration:{binding:job.kopernikRegistration,originalWorld:{directory:job.acceptedWorld,manifestSha256:job.expectedManifestSha256},authorityReceipt:kopernik.receipt}}:{}), ...(registrations?{retainedRoadRegistrations:registrations.receipt}:{}),...(itameri?{retainedItameriOutside:{binding:job.retainedItameriOutside,originalWorld:{directory:job.acceptedWorld,manifestSha256:job.expectedManifestSha256},authorityReceipt:itameri.receipt}}:{}),...(kaivo?{kaivopuistoFootway:{binding:job.kaivopuistoFootway,authorityReceipt:kaivo.receipt,projection:kaivoProjection!.receipt}}:{}),...(inherited?{inheritedRoadHeight:{binding:job.inheritedRoadHeight,originalWorld:{directory:job.acceptedWorld,manifestSha256:job.expectedManifestSha256},authorityReceipt:inherited.receipt,legacy},correctedCurrentBaseline:{...currentRef!,file:path.resolve(values.out,currentRef!.path)}}:{}), ...(additional?{inheritedRoadHeightBundle:{binding:job.inheritedRoadHeightBundle,originalWorld:{directory:job.acceptedWorld,manifestSha256:job.expectedManifestSha256},authorityReceipt:additional.receipt,observations:additionalObservations},correctedCurrentBaseline:{...currentRef!,file:path.resolve(values.out,currentRef!.path)}}:{}), ...(serializedFloor?{serializedFloorWorld:job.serializedFloorWorld,serializedFloor,...(levels?{levelSelection:levels.receipt}:{}),...(reviewedWalking?{walkingSurfaceSelection:reviewedWalking.receipt}:{})}:{}), planSha256: sourceSha256(planBytes), producerSha256: sourceSha256(fs.readFileSync(import.meta.filename)), helperSha256: sourceSha256(fs.readFileSync(new URL('./lib/road-outside-repair.ts', import.meta.url))), connectorRepairHelperSha256: sourceSha256(fs.readFileSync(new URL('./lib/road-connector-repair.ts', import.meta.url))), repairedAcceptedRoads: {...repairedRef, file: path.resolve(values.out, repairedRef.path)}, projectedCandidateRoads: {...candidateRef, file: path.resolve(values.out, candidateRef.path)}, changes, proofs, connectorRepair, acceptedPiecewiseGeometryPreserved: !(inherited||additional||kopernik), reviewedBaselinePiecewiseGeometryPreserved:true, expandedCoverage: job.expandedCoverage};
writeSourceJson(values.out, 'road-projection-receipt.json', receipt);
console.log(JSON.stringify({status: receipt.status, changedAcceptedRecords: changes.length, projectedNewLanes: job.newLaneIds.filter(id=>!carriedLaneIds.has(id)).length, projectedConnectors: job.connectorIds.filter(id=>!carriedConnectorIds.has(id)).length,...(carried?{actualCurrentRecordsCarried:carried.receipt.records.length}:{})}));
