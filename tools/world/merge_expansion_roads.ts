// node tools/world/merge_expansion_roads.ts --plan QUALIFICATION_JOB.json --out FRESH_DIRECTORY
// Select source road records explicitly; this tool never guesses boundary joins from nearby coordinates.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {gunzipSync} from 'node:zlib';
import {decodeRoadGraph, decodeSimulationPayload, parseCollisionBundle, pointAlong, MAX_SIMULATION_PAYLOAD_BYTES, type CellDescriptor, type WorldManifest, type Vec3, type RoadGraph} from '../../packages/world-schema/src/index.ts';
import {prepareCurrentNavigationCarry,currentCarryIds,assertCurrentNavigationCarry,currentOriginalNavigation,carryCurrentNavigation,type CurrentNavigationCarryBinding} from './lib/current-navigation-carry.ts';
import {prepareUdenmaankatuCrossing,type UdenmaankatuCrossingBinding} from './lib/road-finite-crossing-context.ts';
import {readReviewedKopernikRegistration} from './lib/reviewed-kopernik-registration.ts';
import {readReviewedItameriOutsideRegistration}from './lib/reviewed-itameri-outside-registration.ts';
import {prepareKaivopuistoFootway,prepareRetainedWalkingCrossing,type KaivopuistoFootwayBinding,type RetainedWalkingCrossingBinding}from './lib/road-walking-review-context.ts';
import {assertCurrentPlayableNavigationPreserved} from './lib/delivery-navigation-preservation.ts';
import {loadGeoJsonPolygons} from './lib/geometry.ts';
import {sourceFile, sourceSha256, readSourceFile, writeSourceJson} from './lib/source-files.ts';
import {deriveRoadPhysicalEnvelope, inspectRetainedRoadExposure, mergeQualifiedRoads, RoadCollisionSupport, isPublicWalkingGroundTag, type RoadCoverage, type RoadMergeSelection, type RoadSupportTriangle, type RoadSourceElement} from './lib/expansion-road-merge.ts';
import {readQualifiedSupportedArea} from './lib/delivery-supported-area.ts';
import {assertOutsideOnlyRoadGraphRepair} from './lib/road-outside-repair.ts';
import {readSerializedRoadFloor,type SerializedFloorWorld} from './lib/serialized-road-floor.ts';
import {prepareRoadMergeReviews, type RoadMergeReviewInputs} from './lib/road-merge-reviews.ts';
import {prepareRetainedRoadRegistrations, registeredRetainedRoadBaseline, type RetainedRoadReviewBinding} from './lib/retained-road-review-context.ts';
import {prepareEhrenstromNavigation, type EhrenstromNavigationBinding} from './lib/ehrenstrom-navigation-context.ts';
import {prepareAdditionalRoadInheritance,inspectAdditionalInheritanceDispositions,additionalInheritedWalkingSources,additionalPlazaRoles,additionalPlazaRecords,type RoadInheritanceBundleBinding} from './lib/inherited-road-bundle-context.ts';
import {prepareRoadInheritance,composeReviewedRoadBaselines,inspectInheritedLegacyDisposition,type RoadInheritanceBinding} from './lib/road-inheritance-context.ts';

interface FileBinding {file: string; sha256: string}
interface MergeJob extends RoadMergeReviewInputs {
  schemaVersion: 1; acceptedWorld: string; expectedManifestSha256: string;
  candidateRoads: FileBinding; osm: FileBinding; streetParts: FileBinding; expandedSupportedArea: FileBinding;
  nativeCells: {directory: string; indexSha256: string}; selection: RoadMergeSelection;
  outsideProjection?: FileBinding;
  currentNavigationCarry?:CurrentNavigationCarryBinding;
  kopernikRegistration?:{approval:FileBinding;provenanceArchive:FileBinding;sourceMask:FileBinding};
  finalSerializedWorld?:SerializedFloorWorld;
  retainedRoadRegistrations?: RetainedRoadReviewBinding[];
  ehrenstromNavigation?: EhrenstromNavigationBinding;
  inheritedRoadHeight?: RoadInheritanceBinding;
  inheritedRoadHeightBundle?:RoadInheritanceBundleBinding;udenmaankatuCrossing?:UdenmaankatuCrossingBinding;
  retainedItameriOutside?:{approval:FileBinding};kaivopuistoFootway?:KaivopuistoFootwayBinding;retainedWalkingCrossing?:RetainedWalkingCrossingBinding;
}
const {values} = parseArgs({options: {plan: {type: 'string'}, out: {type: 'string'}}});
assert.ok(values.plan && values.out, '--plan and --out required');
const planBytes = fs.readFileSync(values.plan); assert.ok(planBytes.length <= 16 * 1024 * 1024, 'Road merge job exceeds 16 MiB');
const job = JSON.parse(planBytes.toString('utf8')) as MergeJob; assert.equal(job.schemaVersion, 1);
assert.deepEqual(Object.keys(job).sort(), ['schemaVersion', 'acceptedWorld', 'expectedManifestSha256', 'candidateRoads', 'osm', 'streetParts', 'expandedSupportedArea', 'nativeCells', 'selection', ...(job.outsideProjection ? ['outsideProjection'] : []),...(job.finalSerializedWorld?['finalSerializedWorld']:[]), ...['bridgeLevelInventory','walkingSurfaceReviews','transitCrossingReviews','retainedRoadRegistrations','ehrenstromNavigation','inheritedRoadHeight','inheritedRoadHeightBundle','retainedItameriOutside','kaivopuistoFootway','retainedWalkingCrossing','currentNavigationCarry','kopernikRegistration','udenmaankatuCrossing'].filter(key => Object.hasOwn(job, key))].sort(), 'Unexpected road merge job fields');
assert.ok(!fs.existsSync(values.out), 'Fresh merged road output required');
function boundFile(binding: FileBinding, cap = 128 * 1024 * 1024) {
  assert.match(binding.sha256, /^[a-f0-9]{64}$/); const stat = fs.lstatSync(binding.file); assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size <= cap, 'Bound source input exceeds cap or is not an ordinary file');
  const bytes = fs.readFileSync(binding.file); assert.equal(sourceSha256(bytes), binding.sha256, 'Road merge source hash drift: ' + path.basename(binding.file)); return bytes;
}
const manifestBytes = boundFile({file: sourceFile(job.acceptedWorld, 'manifest.json'), sha256: job.expectedManifestSha256}, 8 * 1024 * 1024);
const manifest = JSON.parse(manifestBytes.toString('utf8')) as WorldManifest;
const acceptedRoadsStored = readSourceFile(job.acceptedWorld, manifest.roads), acceptedRoadsDecoded = await decodeSimulationPayload(acceptedRoadsStored, manifest.roads), originalAccepted = decodeRoadGraph(acceptedRoadsDecoded);
let accepted = originalAccepted;
assert.equal(accepted.originId, manifest.origin.id);
const acceptedGameplay = JSON.parse(readSourceFile(job.acceptedWorld, manifest.gameplay).toString('utf8'));
const acceptedCoverage = acceptedGameplay as RoadCoverage, vehicleEnvelope = deriveRoadPhysicalEnvelope(acceptedGameplay.vehicleDefinitions);
let outsideProjection: {receiptSha256: string; repairedAcceptedRoadsSha256: string; changes: ReturnType<typeof assertOutsideOnlyRoadGraphRepair>} | undefined;
let projectionFloor: {manifestSha256:string;region:readonly[number,number,number,number];cells:{cell:string;decodedSha256:string}[]}|undefined;
let originalCandidate: RoadGraph | undefined, originalCandidatePin: FileBinding | undefined;
let projectionReceipt: any;
if (job.outsideProjection) {
  const projection = JSON.parse(boundFile(job.outsideProjection).toString());
  projectionReceipt = projection;
  assert.equal(projection.kind, 'source-bound-outside-road-projection'); assert.equal(projection.status, 'PROJECTED_PENDING_SUPPORTED_AREA_SERIALIZED_HCOL_AND_TRAVEL');
  assert.equal(projection.acceptedManifestSha256, job.expectedManifestSha256); assert.equal(projection.acceptedRoadsSha256, manifest.roads.sha256);
  assert.equal(projection.projectedCandidateRoads.sha256, job.candidateRoads.sha256, 'Projected candidate differs');
  originalCandidatePin = projection.originalCandidateRoads; originalCandidate = decodeRoadGraph(boundFile(projection.originalCandidateRoads)); const metadata = JSON.parse(boundFile(projection.nativeMetadata).toString());
  assert.equal(metadata.cache.sha256, projection.nativeCacheSha256); boundFile({file: metadata.cache.path, sha256: metadata.cache.sha256}, 512_000_000);
  if(projection.serializedFloor){
    assert.equal(projection.serializedFloor.kind,'final-serialized-road-floor');assert.equal(projection.serializedFloor.originId,manifest.origin.id);
    assert.equal(projection.serializedFloor.manifestSha256,projection.serializedFloorWorld.manifestSha256);
    const finalWorld=JSON.parse(boundFile({file:sourceFile(projection.serializedFloorWorld.directory,'manifest.json'),sha256:projection.serializedFloorWorld.manifestSha256},16*1024*1024).toString());
    assert.equal(finalWorld.origin.id,manifest.origin.id);for(const cell of projection.serializedFloor.cells){const actual=finalWorld.cells.find((c:CellDescriptor)=>c.id===cell.cell);assert.ok(actual);assert.equal(actual.collision.sha256,cell.storedSha256);assert.equal(actual.collision.decodedSha256??actual.collision.sha256,cell.decodedSha256);}
    projectionFloor=projection.serializedFloor;
  }
  accepted = decodeRoadGraph(boundFile(projection.repairedAcceptedRoads, MAX_SIMULATION_PAYLOAD_BYTES));
}
assert.deepEqual(job.retainedRoadRegistrations ?? null, projectionReceipt?.retainedRoadRegistrations?.bindings ?? null, 'Merge must explicitly bind the same retained registrations as projection');
assert.deepEqual(job.retainedItameriOutside??null,projectionReceipt?.retainedItameriOutside?.binding??null,'Merge Itameri binding differs from projection');
assert.deepEqual(job.kaivopuistoFootway??null,projectionReceipt?.kaivopuistoFootway?.binding??null,'Merge Kaivo binding differs from projection');
assert.deepEqual(job.inheritedRoadHeightBundle??null,projectionReceipt?.inheritedRoadHeightBundle?.binding??null,'Merge must bind the same inherited bundle as projection');
assert.deepEqual(job.inheritedRoadHeight??null,projectionReceipt?.inheritedRoadHeight?.binding??null,'Merge must explicitly bind the same inherited-height authority as projection');
assert.deepEqual(job.currentNavigationCarry??null,projectionReceipt?.currentNavigationCarry?.binding??null,'Merge carry binding differs from projection');
assert.deepEqual(job.udenmaankatuCrossing??null,projectionReceipt?.udenmaankatuCrossing?.binding??null,'Merge finite crossing differs from projection');
assert.deepEqual(job.kopernikRegistration??null,projectionReceipt?.kopernikRegistration?.binding??null,'Merge Kopernik binding differs from projection');
const expandedPlayArea = {...acceptedCoverage.playArea};
for (const [minX, minZ, maxX, maxZ] of job.selection.regions) {expandedPlayArea.minX = Math.min(expandedPlayArea.minX, minX); expandedPlayArea.minZ = Math.min(expandedPlayArea.minZ, minZ); expandedPlayArea.maxX = Math.max(expandedPlayArea.maxX, maxX); expandedPlayArea.maxZ = Math.max(expandedPlayArea.maxZ, maxZ);}
const expandedSupported = readQualifiedSupportedArea({path: job.expandedSupportedArea.file, sha256: job.expandedSupportedArea.sha256}, {manifestSha256: job.expectedManifestSha256, originId: manifest.origin.id, gameplay: acceptedCoverage}, expandedPlayArea);
const expandedCoverage: RoadCoverage = {playArea: expandedPlayArea, supportedArea: expandedSupported.supportedArea};
const candidateBytes = boundFile(job.candidateRoads, MAX_SIMULATION_PAYLOAD_BYTES), candidate = decodeRoadGraph(candidateBytes);
const osmBytes = boundFile(job.osm), osm = JSON.parse(osmBytes.toString('utf8')) as {elements: RoadSourceElement[]};
assert.equal(candidate.source.sha256, job.osm.sha256, 'Candidate roads are not bound to this OSM snapshot');
boundFile(job.streetParts); const parts = loadGeoJsonPolygons(job.streetParts.file, manifest.origin.originProjected[0], manifest.origin.originProjected[1], (properties, i) => String(properties.osan_id ?? properties.id ?? i));
const nativeIndexBytes = boundFile({file: sourceFile(job.nativeCells.directory, 'cells.json'), sha256: job.nativeCells.indexSha256}, 16 * 1024 * 1024);
const native = JSON.parse(nativeIndexBytes.toString('utf8')) as {originId: string; cells: CellDescriptor[]}; assert.equal(native.originId, manifest.origin.id);
const selected = new Set(job.selection.lanes.map(lane => lane.id)), points = candidate.lanes.filter(lane => selected.has(lane.id)).flatMap(lane => lane.points);
for (const [refs, records] of [[job.selection.footways ?? [], candidate.footways], [job.selection.retainedFootways ?? [], accepted.footways]] as const) for (const ref of refs) {const record = records.find(record => record.id === ref.id); assert.ok(record); points.push(...record.points);}
points.push(...job.selection.seamConnectors.flatMap(ref => ref.connector.points)); assert.ok(points.length > 0);
const retainedExposure = inspectRetainedRoadExposure(accepted, acceptedCoverage, expandedCoverage);
for (const tail of retainedExposure) {const lane = accepted.lanes.find(lane => lane.id === tail.id)!; points.push(...lane.points); for (const [from, to] of tail.intervals) points.push(pointAlong(lane.points, from).point, pointAlong(lane.points, to).point);}
const region = points.reduce((bounds, point) => [Math.min(bounds[0]!, point[0] - 5), Math.min(bounds[1]!, point[2] - 5), Math.max(bounds[2]!, point[0] + 5), Math.max(bounds[3]!, point[2] + 5)], [Infinity, Infinity, -Infinity, -Infinity]);
const triangles: RoadSupportTriangle[] = [], supportInputs = [];
let finalFloor:ReturnType<typeof readSerializedRoadFloor>['receipt']|undefined;
if(job.finalSerializedWorld){
 const prior=projectionFloor?.region??region,scope=[Math.min(region[0]!,prior[0]!),Math.min(region[1]!,prior[1]!),Math.max(region[2]!,prior[2]!),Math.max(region[3]!,prior[3]!)]as[number,number,number,number];
 const floor=readSerializedRoadFloor(job.finalSerializedWorld,scope,manifest.origin.id);finalFloor=floor.receipt;
 for(const triangle of floor.triangles)triangles.push(triangle);for(const cell of floor.receipt.cells)supportInputs.push({kind:'final',...cell});
}else{
for (const input of [{kind: 'accepted', root: job.acceptedWorld, cells: manifest.cells}, {kind: 'new', root: job.nativeCells.directory, cells: native.cells}]) {
  for (const cell of input.cells) {
    const bounds = cell.collision.boundsXZ ?? cell.boundsXZ;
    if (bounds[2] < region[0]! || bounds[0] > region[2]! || bounds[3] < region[1]! || bounds[1] > region[3]!) continue;
    const encoded = readSourceFile(input.root, cell.collision), decoded = cell.collision.compression === 'gzip' ? gunzipSync(encoded, {maxOutputLength: MAX_SIMULATION_PAYLOAD_BYTES}) : encoded;
    assert.ok(decoded.length <= MAX_SIMULATION_PAYLOAD_BYTES);
    if (cell.collision.compression) {assert.equal(decoded.length, cell.collision.decodedBytes); assert.equal(sourceSha256(decoded), cell.collision.decodedSha256);}
    const bundle = parseCollisionBundle(Uint8Array.from(decoded)); assert.equal(bundle.header.cell, cell.id); assert.equal(bundle.header.originId, manifest.origin.id);
    supportInputs.push({kind: input.kind, cell: cell.id, storedSha256: cell.collision.sha256, decodedSha256: sourceSha256(decoded)});
    for (const collider of bundle.colliders) if (collider.group === 'ground') for (let i = 0; i < collider.indices.length; i += 3) {
      const tag = bundle.header.surfaceTags[collider.triangleTags[i / 3]!]!; if (!tag.startsWith('road:') && !isPublicWalkingGroundTag(tag)) continue;
      const vertices = [0, 1, 2].map(k => {const offset = collider.indices[i + k]! * 3; return Array.from(collider.positions.subarray(offset, offset + 3)) as unknown as Vec3;});
      triangles.push({id: `${input.kind}:${cell.id}:${collider.id}:${i / 3}`, tag, points: vertices as [Vec3, Vec3, Vec3]});
    }
  }
}
}
assert.ok(triangles.length > 0, 'No road collision supports the selected expansion');
if(projectionFloor)for(const cell of projectionFloor.cells)assert.ok(supportInputs.some(input=>input.cell===cell.cell&&input.decodedSha256===cell.decodedSha256),'Final merge differs from serialized projection floor: '+cell.cell);
assert.ok(!job.retainedRoadRegistrations || job.finalSerializedWorld && finalFloor, 'Retained registrations require final serialized floor');
const registrations = job.retainedRoadRegistrations ? prepareRetainedRoadRegistrations(job.retainedRoadRegistrations,{accepted:originalAccepted,acceptedManifestSha256:job.expectedManifestSha256,acceptedCoverage,vehicleDefinitions:acceptedGameplay.vehicleDefinitions,streetParts:job.streetParts,originProjected:manifest.origin.originProjected,selectedLaneIds:(job.selection.retainedLanes??[]).map(lane=>lane.id),floor:{manifestSha256:finalFloor!.manifestSha256,cells:finalFloor!.cells,triangles},read:boundFile}) : undefined;
const retainedBaseline=registrations?registeredRetainedRoadBaseline(registrations.authority,originalAccepted,acceptedCoverage):originalAccepted;
const retainedIds=retainedBaseline.lanes.filter((lane,i)=>sourceSha256(JSON.stringify(lane))!==sourceSha256(JSON.stringify(originalAccepted.lanes[i]))).map(lane=>lane.id);
assert.ok(!(job.inheritedRoadHeight||job.inheritedRoadHeightBundle||job.retainedItameriOutside||job.retainedWalkingCrossing||job.currentNavigationCarry||job.kopernikRegistration||job.udenmaankatuCrossing)||job.finalSerializedWorld&&finalFloor&&projectionReceipt,'Inherited height requires final serialized floor and projection');
const currentManifest=(job.inheritedRoadHeight||job.inheritedRoadHeightBundle||job.retainedItameriOutside||job.retainedWalkingCrossing||job.currentNavigationCarry||job.kopernikRegistration||job.udenmaankatuCrossing)?JSON.parse(boundFile({file:sourceFile(job.finalSerializedWorld!.directory,'manifest.json'),sha256:job.finalSerializedWorld!.manifestSha256},16*1024*1024).toString()):undefined;
const current=currentManifest?decodeRoadGraph(await decodeSimulationPayload(readSourceFile(job.finalSerializedWorld!.directory,currentManifest.roads),currentManifest.roads)):undefined;
assert.ok(!job.currentNavigationCarry||originalCandidate,'Current carry requires the raw projection candidate');
const carry=job.currentNavigationCarry?prepareCurrentNavigationCarry(job.currentNavigationCarry,{original:originalAccepted,current:current!,rawCandidate:originalCandidate!,originalWorld:{directory:job.acceptedWorld,manifestSha256:job.expectedManifestSha256},currentWorld:job.finalSerializedWorld!,coverage:expandedCoverage,read:boundFile}):undefined;
if(carry){assertCurrentNavigationCarry(carry.authority,originalAccepted,current!,candidate);assert.deepEqual(carry.receipt,projectionReceipt.currentNavigationCarry.authorityReceipt,'Current carry authority changed between projection and merge');}
const carriedConnectors=new Set(carry?currentCarryIds(carry.authority,'connectors'):[]);
const selectedNewConnectors=[...job.selection.connectors.filter(ref=>!carriedConnectors.has(ref.id)).map(ref=>{const c=candidate.connectors.find(c=>c.id===ref.id);assert.ok(c);return c;}),...job.selection.seamConnectors.map(ref=>ref.connector)];
if(job.retainedItameriOutside){assert.deepEqual(Object.keys(job.retainedItameriOutside),['approval']);assert.ok(job.selection.retainedLanes?.some(r=>r.id==='86957349:0:f0'));}
const itameri=job.retainedItameriOutside?readReviewedItameriOutsideRegistration(job.retainedItameriOutside.approval,{original:originalAccepted,current:current!,originalWorld:{directory:job.acceptedWorld,manifestSha256:job.expectedManifestSha256},currentWorld:job.finalSerializedWorld!,coverage:expandedCoverage,selectedNewConnectors,otherRegistrationIds:retainedIds,read:boundFile}):undefined;if(itameri)retainedIds.push(itameri.witness.id);
const inherited=job.inheritedRoadHeight?prepareRoadInheritance(job.inheritedRoadHeight,{original:originalAccepted,current:current!,originalWorld:{directory:job.acceptedWorld,manifestSha256:job.expectedManifestSha256},currentWorld:job.finalSerializedWorld!,sourcePins:{osmSha256:job.osm.sha256,streetPartsSha256:job.streetParts.sha256},otherRegistrationIds:retainedIds}):undefined;
const additional=job.inheritedRoadHeightBundle?prepareAdditionalRoadInheritance(job.inheritedRoadHeightBundle,{original:originalAccepted,current:current!,originalWorld:{directory:job.acceptedWorld,manifestSha256:job.expectedManifestSha256},currentWorld:job.finalSerializedWorld!,sourcePins:{osmSha256:job.osm.sha256,streetPartsSha256:job.streetParts.sha256},otherRegistrationIds:[...retainedIds,...(inherited?[inherited.witness.id]:[])],coverage:expandedCoverage}):undefined;
const kopernik=job.kopernikRegistration?readReviewedKopernikRegistration(job.kopernikRegistration.approval,{original:originalAccepted,current:current!,originalWorld:{directory:job.acceptedWorld,manifestSha256:job.expectedManifestSha256},currentWorld:job.finalSerializedWorld!,sourceMask:job.kopernikRegistration.sourceMask,coverage:expandedCoverage,sourcePins:{osmSha256:job.osm.sha256,streetPartsSha256:job.streetParts.sha256},provenanceArchive:job.kopernikRegistration.provenanceArchive,otherRegistrationIds:[...retainedIds,...(inherited?[inherited.witness.id]:[]),...(additional?additional.witnesses.map(w=>w.id):[])],read:boundFile}):undefined;
if(kopernik){assert.equal(job.kopernikRegistration!.sourceMask.sha256,job.expandedSupportedArea.sha256);assert.deepEqual(kopernik.receipt,projectionReceipt.kopernikRegistration.authorityReceipt);assert.deepEqual(projectionReceipt.kopernikRegistration.originalWorld,{directory:job.acceptedWorld,manifestSha256:job.expectedManifestSha256});}
const udenmaankatu=job.udenmaankatuCrossing?prepareUdenmaankatuCrossing(job.udenmaankatuCrossing,{original:originalAccepted,current:current!,originalWorld:{directory:job.acceptedWorld,manifestSha256:job.expectedManifestSha256},currentWorld:job.finalSerializedWorld!,coverage:expandedCoverage,sourcePins:{osmSha256:job.osm.sha256,streetPartsSha256:job.streetParts.sha256},read:boundFile}):undefined;
if(udenmaankatu){assert.equal(job.udenmaankatuCrossing!.sourceMask.sha256,job.expandedSupportedArea.sha256);assert.deepEqual(udenmaankatu.receipt,projectionReceipt.udenmaankatuCrossing.authorityReceipt);for(const r of udenmaankatu.reviewedRecords){assert.ok(job.selection.retainedLanes?.some(q=>q.id===r.id),'Both finite crossing records must be selected');assert.deepEqual(accepted.lanes.find(l=>l.id===r.id),r,'Exact finite crossing AFTER required at merge');}}
const composition=composeReviewedRoadBaselines(originalAccepted,acceptedCoverage,registrations?.authority,inherited?{authority:inherited.authority,current:current!}:undefined,additional?{authority:additional.authority,current:current!}:undefined,itameri?{authority:itameri.authority,current:current!,selectedNewConnectors}:undefined,kopernik?{authority:kopernik.authority,current:current!}:undefined);
assert.ok(composition.literalInheritedRecords.every(r=>(r.kind==='lanes'?job.selection.retainedLanes??[]:job.selection.retainedFootways??[]).some(l=>l.id===r.id)),'Inherited lane must be selected for ordinary newly exposed-tail qualification');
const legacy=inherited?inspectInheritedLegacyDisposition(inherited.authority,{lane:accepted.lanes.find(l=>l.id===inherited.witness.id)!,currentWorld:job.finalSerializedWorld!,otherRegistrationIds:retainedIds,triangles,parts,coverage:expandedCoverage,envelope:vehicleEnvelope}):undefined;
const additionalObservations=additional?inspectAdditionalInheritanceDispositions(additional.authority,{roads:accepted,currentWorld:job.finalSerializedWorld!,coverage:expandedCoverage,otherRegistrationIds:[...retainedIds,...(inherited?[inherited.witness.id]:[])]}):undefined;
if (projectionReceipt) {
  if(itameri)assert.deepEqual(itameri.receipt,projectionReceipt.retainedItameriOutside.authorityReceipt,'Itameri source/floor authority changed');
  if(additional){assert.deepEqual(projectionReceipt.inheritedRoadHeightBundle.originalWorld,{directory:job.acceptedWorld,manifestSha256:job.expectedManifestSha256});assert.deepEqual(projectionReceipt.inheritedRoadHeightBundle.authorityReceipt,additional.receipt);assert.deepEqual(projectionReceipt.inheritedRoadHeightBundle.observations,additionalObservations);assert.deepEqual(decodeRoadGraph(boundFile(projectionReceipt.correctedCurrentBaseline,MAX_SIMULATION_PAYLOAD_BYTES)),composition.correctedCurrentBaseline);}
  if (registrations) assert.deepEqual(registrations.receipt,projectionReceipt.retainedRoadRegistrations,'Retained registration proof changed between projection and merge');
  if(inherited){assert.deepEqual(projectionReceipt.inheritedRoadHeight.originalWorld,{directory:job.acceptedWorld,manifestSha256:job.expectedManifestSha256});assert.deepEqual(projectionReceipt.inheritedRoadHeight.authorityReceipt,inherited.receipt);assert.deepEqual(projectionReceipt.inheritedRoadHeight.legacy,legacy,'Legacy observational probe batch changed between projection and merge');assert.deepEqual(decodeRoadGraph(boundFile(projectionReceipt.correctedCurrentBaseline,MAX_SIMULATION_PAYLOAD_BYTES)),composition.correctedCurrentBaseline,'Projection changed the reviewed current-world baseline');}
  const changes = assertOutsideOnlyRoadGraphRepair(originalAccepted,accepted,acceptedCoverage,composition.authority);
  assert.deepEqual(changes,projectionReceipt.changes,'Outside repair record witnesses differ');
  outsideProjection = {receiptSha256:job.outsideProjection!.sha256,repairedAcceptedRoadsSha256:projectionReceipt.repairedAcceptedRoads.sha256,changes};
}
const currentPlayablePreservation=carry?assertCurrentPlayableNavigationPreserved(current!,carryCurrentNavigation(carry.authority,originalAccepted,accepted),currentOriginalNavigation(carry.authority,originalAccepted).coverage,originalAccepted,composition.registeredAcceptedBaseline,composition.correctedCurrentBaseline,kopernik?.authority):undefined;
if(carry)assert.deepEqual(currentPlayablePreservation,projectionReceipt.currentPlayablePreservation,'Actual current-playable preservation differs between projection and merge');
const hasReviews = !!(job.bridgeLevelInventory || job.walkingSurfaceReviews || job.transitCrossingReviews);
assert.ok(!hasReviews || job.finalSerializedWorld && finalFloor && originalCandidate && originalCandidatePin, 'Reviewed structures and surfaces require original source projection and final serialized authority');
const connectorProjection=projectionReceipt?.connectorRepair?{accepted,...(carry?{currentCarry:{authority:carry.authority,original:originalAccepted,current:current!}}:{}),witness:projectionReceipt.connectorRepair,newLaneIds:projectionReceipt.proofs.filter((p:any)=>p.kind==='new').map((p:any)=>p.id),connectorIds:projectionReceipt.proofs.filter((p:any)=>p.kind==='new-connector').map((p:any)=>p.id),newFootwayIds:projectionReceipt.proofs.filter((p:any)=>p.kind==='new-footway').map((p:any)=>p.id)}:undefined;
const reviews = hasReviews ? prepareRoadMergeReviews(job, {world: job.finalSerializedWorld!, cells: finalFloor!.cells, triangles, originalCandidate: originalCandidate!, projectedCandidate: candidate, originalCandidatePin: originalCandidatePin!, sourcePins: {osmSha256: job.osm.sha256, streetPartsSha256: job.streetParts.sha256}, parts, osm, selection: job.selection, ...(connectorProjection?{connectorProjection}:{}), read: boundFile}) : undefined;
assert.ok(!job.ehrenstromNavigation || finalFloor, 'Reviewed Ehrenstrom navigation requires the final serialized floor');
const ehrenstrom = job.ehrenstromNavigation ? prepareEhrenstromNavigation(job.ehrenstromNavigation, {accepted:originalAccepted, acceptedCoverage, candidate, selectedLaneIds:[...selected], sourcePins:{osmSha256:job.osm.sha256,streetPartsSha256:job.streetParts.sha256}, vehicleDefinitionsSha256:vehicleEnvelope.definitionsSha256, osm, parts, floor:{manifestSha256:finalFloor!.manifestSha256,cells:finalFloor!.cells,triangles}, read:boundFile}) : undefined;
assert.ok(!(job.kaivopuistoFootway||job.retainedWalkingCrossing)||job.finalSerializedWorld,'Reviewed walking source requires actual serialized world');
const walkingContext={original:originalAccepted,candidate,world:job.finalSerializedWorld!,sourcePins:{osmSha256:job.osm.sha256,streetPartsSha256:job.streetParts.sha256},osm,parts,read:boundFile};
const kaivo=job.kaivopuistoFootway?prepareKaivopuistoFootway(job.kaivopuistoFootway,{...walkingContext,selectedNewFootwayIds:(job.selection.footways??[]).map(r=>r.id)}):undefined;
const kaivoProjected=kaivo?.projected(candidate);if(kaivo){assert.deepEqual(kaivo.receipt,projectionReceipt.kaivopuistoFootway.authorityReceipt);assert.deepEqual(kaivoProjected!.receipt,projectionReceipt.kaivopuistoFootway.projection);}
const crossing=job.retainedWalkingCrossing?prepareRetainedWalkingCrossing(job.retainedWalkingCrossing,{...walkingContext,current:current!,acceptedCoverage,coverage:expandedCoverage,selectedRetainedFootwayIds:(job.selection.retainedFootways??[]).map(r=>r.id)}):undefined;
const reviewedFootways=new Map(reviews?.reviewedFootways);if(kaivo){assert.ok(!reviewedFootways.has('w87075617'),'Overlapping new walking roles');reviewedFootways.set('w87075617',{...kaivoProjected!,support:new RoadCollisionSupport(triangles,isPublicWalkingGroundTag)});}
const reviewedRetainedCrossings=crossing?new Map([['w1533067599',crossing.authority]]):undefined;
const reviewedPlaza=additional?additionalPlazaRoles(additional.authority):undefined;
if(additional)for(const record of additionalPlazaRecords(additional.authority))assert.deepEqual(accepted.lanes.find(l=>l.id===record.id),record,'Merge requires exact reviewed plaza AFTER');
const reviewedInheritedWalkingSources=additional?additionalInheritedWalkingSources(additional.authority,originalAccepted,current!,[...retainedIds,...(inherited?[inherited.witness.id]:[])]):undefined;
if(job.inheritedRoadHeightBundle?.walkingCurrentA||job.inheritedRoadHeightBundle?.plazaService)assert.equal(job.inheritedRoadHeightBundle.sourceMask?.sha256,job.expandedSupportedArea.sha256,'Current-A inherited source mask differs from final merge mask');
fs.mkdirSync(values.out, {recursive: true});
writeSourceJson(values.out, 'retained-road-exposure.json', {schemaVersion: 1, acceptedManifestSha256: job.expectedManifestSha256, acceptedRoadsSha256: manifest.roads.sha256, expandedSupportedAreaSha256: job.expandedSupportedArea.sha256, retainedExposure});
let result: ReturnType<typeof mergeQualifiedRoads>;
try {result = mergeQualifiedRoads({accepted, candidate,...(carry?{currentCarry:{authority:carry.authority,original:originalAccepted,current:current!}}:{}), acceptedCoverage, expandedCoverage, vehicleEnvelope, osm, originProjected: manifest.origin.originProjected, parts, support: new RoadCollisionSupport(triangles), walkingSupport: new RoadCollisionSupport(triangles, isPublicWalkingGroundTag), selection: job.selection, ...(reviews ? {reviewedRoadSupports: reviews.reviewedRoadSupports, reviewedFootways: reviews.reviewedFootways, reviewedSurfaces: reviews.reviewedSurfaces} : {}), reviewedFootways,reviewedRetainedCrossings,reviewedInheritedWalkingSources,reviewedPlaza,reviewedUdenmaankatu:udenmaankatu?.roles,...(ehrenstrom ? {reviewedSourceJoins:ehrenstrom.sourceJoins} : {})});}
catch (error) {writeSourceJson(values.out, 'road-merge-failure.json', {schemaVersion: 1, status: 'RETHINK_SOURCE_ROAD_QUALIFICATION', planSha256: sourceSha256(planBytes), message: (error as Error).message, retainedExposure, retainedAudit: (error as Error & {retainedAudit?: unknown}).retainedAudit ?? null,...(udenmaankatu?{udenmaankatuHandoffVerified:true,udenmaankatuCrossing:projectionReceipt.udenmaankatuCrossing}:{}), ...(inherited?{inheritedRoadHeight:{authorityReceipt:inherited.receipt,legacy},inheritedProjectionHandoffVerified:true}:{}), ...(additional?{inheritedRoadHeightBundle:{authorityReceipt:additional.receipt,observations:additionalObservations},inheritedBundleHandoffVerified:true}:{}), ...(carry?{currentNavigationCarry:{binding:job.currentNavigationCarry,authorityReceipt:carry.receipt},currentNavigationCarryHandoffVerified:true,currentPlayablePreservation}:{}),...(kopernik?{kopernikRegistration:projectionReceipt.kopernikRegistration,kopernikHandoffVerified:true}:{}), pathAdmission: (error as Error & {pathAdmission?: unknown}).pathAdmission ?? null}); throw new Error((error as Error).message);}
// Bind again after processing; no receipt may certify a moving source input.
boundFile(job.candidateRoads, MAX_SIMULATION_PAYLOAD_BYTES); boundFile(job.osm); boundFile(job.streetParts); boundFile(job.expandedSupportedArea);
boundFile({file: sourceFile(job.acceptedWorld, 'manifest.json'), sha256: job.expectedManifestSha256});
boundFile({file: sourceFile(job.nativeCells.directory, 'cells.json'), sha256: job.nativeCells.indexSha256});
if(job.finalSerializedWorld)boundFile({file:sourceFile(job.finalSerializedWorld.directory,'manifest.json'),sha256:job.finalSerializedWorld.manifestSha256},16*1024*1024);
registrations?.verifyInputs();
inherited?.verifyInputs();additional?.verifyInputs();itameri?.verifyInputs();kaivo?.verifyInputs();crossing?.verifyInputs();carry?.verifyInputs();kopernik?.verifyInputs();udenmaankatu?.verifyInputs();
ehrenstrom?.verifyInputs();
if(carry)assertCurrentNavigationCarry(carry.authority,originalAccepted,current!,result.graph);
const roadBytes = Buffer.from(JSON.stringify(result.graph) + '\n'); assert.ok(roadBytes.length <= MAX_SIMULATION_PAYLOAD_BYTES, 'Merged road JSON exceeds decoded simulation cap');
fs.writeFileSync(path.join(values.out, 'roads.json'), roadBytes, {flag: 'wx'});
const receipt = {...result.receipt, acceptedManifestSha256: job.expectedManifestSha256, acceptedRoadsSha256: manifest.roads.sha256,
  ...(udenmaankatu?{udenmaankatuCrossing:projectionReceipt.udenmaankatuCrossing}:{}),...(carry?{currentNavigationCarry:projectionReceipt.currentNavigationCarry,currentPlayablePreservation}:{}),...(kopernik?{kopernikRegistration:projectionReceipt.kopernikRegistration}:{}),
  ...(registrations?{retainedRoadRegistrations:registrations.receipt}:{}),
  ...(itameri?{retainedItameriOutside:projectionReceipt.retainedItameriOutside}:{}),...(kaivo?{kaivopuistoFootway:projectionReceipt.kaivopuistoFootway}:{}),...(crossing?{retainedWalkingCrossing:{binding:job.retainedWalkingCrossing,authorityReceipt:crossing.receipt}}:{}),
  ...(additional?{inheritedRoadHeightBundle:{binding:job.inheritedRoadHeightBundle,originalWorld:{directory:job.acceptedWorld,manifestSha256:job.expectedManifestSha256},authorityReceipt:additional.receipt,observations:additionalObservations},correctedCurrentBaselineSha256:sourceSha256(JSON.stringify(composition.correctedCurrentBaseline))}:{}),
  ...(inherited?{inheritedRoadHeight:{binding:job.inheritedRoadHeight,originalWorld:{directory:job.acceptedWorld,manifestSha256:job.expectedManifestSha256},authorityReceipt:inherited.receipt,legacy},correctedCurrentBaselineSha256:sourceSha256(JSON.stringify(composition.correctedCurrentBaseline))}:{}),
  ...(ehrenstrom?{ehrenstromNavigation:ehrenstrom.receipt}:{}),
  acceptedRecordsPreserved: !outsideProjection?.changes.length, acceptedPlayablePiecewiseGeometryPreserved: !(inherited||additional||kopernik), reviewedBaselinePiecewiseGeometryPreserved:true, outsideProjection: outsideProjection ?? null,
  acceptedDecodedRoadsSha256: sourceSha256(acceptedRoadsDecoded), candidateRoadsSha256: job.candidateRoads.sha256, osmSha256: job.osm.sha256,
  streetPartsSha256: job.streetParts.sha256, expandedSupportedAreaSha256: job.expandedSupportedArea.sha256, nativeCellsIndexSha256: job.nativeCells.indexSha256, mergedRoadsSha256: sourceSha256(roadBytes),
  planSha256: sourceSha256(planBytes), supportInputs,...(finalFloor?{finalSerializedWorld:job.finalSerializedWorld,finalFloor}:{}), ...(reviews ? {reviewedSourceAndLevels: reviews.receipt} : {}), producerSha256: sourceSha256(fs.readFileSync(import.meta.filename)), helperSha256: sourceSha256(fs.readFileSync(new URL('./lib/expansion-road-merge.ts', import.meta.url))),
  runtimeCoverageProducerSha256: sourceSha256(fs.readFileSync(new URL('../../packages/sim/src/coverage-footprint.ts', import.meta.url))),
  walkingHelperSha256: sourceSha256(fs.readFileSync(new URL('./lib/expansion-footway-merge.ts', import.meta.url))),
  supportedAreaProducerSha256: sourceSha256(fs.readFileSync(new URL('../../packages/world-schema/src/supported-area.ts', import.meta.url)))};
writeSourceJson(values.out, 'road-merge-receipt.json', receipt);
console.log(JSON.stringify({status: receipt.status, newLanes: receipt.selectedLaneIds.length, newConnectors: receipt.selectedConnectorIds.length, boundaryConnections: receipt.boundaryWitnesses.length, mergedRoadsSha256: receipt.mergedRoadsSha256}));
