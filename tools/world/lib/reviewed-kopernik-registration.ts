import assert from 'node:assert/strict';
import path from 'node:path';
import polygonClipping from 'polygon-clipping';
import {decodeRoadGraph, parseTerrain, pointAlong, polylineLength, type RoadGraph, type RoadLane, type Vec2, type Vec3, type WorldManifest, type GameplayBundle} from '../../../packages/world-schema/src/index.ts';
import {supportsVehiclePose, supportsVehicleTransition, vehicleCoverageFootprint, vehicleCoverageRadius} from '../../../packages/sim/src/coverage-footprint.ts';
import {sourceFile, sourceSha256} from './source-files.ts';
import {decodeDeliverySimulation} from './delivery-city-payloads.ts';
import {loadGeoJsonPolygons} from './geometry.ts';
import {readSerializedRoadFloor, type SerializedFloorWorld} from './serialized-road-floor.ts';
import {deriveRoadPhysicalEnvelope, inspectRoadAdmission, inspectRoadPhysicalSupport, roadCoveragePose, RoadCollisionSupport, type RoadCoverage} from './expansion-road-merge.ts';

export const KOPERNIK_REGISTRATION_APPROVAL = '072ed5712ea412fd7a66acae5e4f732000716fd6f6516b70fa77a82f206ab8b1';
const PROPOSAL = 'fc29f61ddcfd1316ff15d94b0c1b9c77b382d1b853a489b11d2a0ac54938bacc';
const ARCHIVE = '0042f71771bd7d9e99a7f5d47b8c3dc4413a3ee7b7a6eedaacd94a579b4357b9';
const ORIGINAL = '0e18e55e8730f01144eef72a80decffbb53cdd658222f87a7e8ad6f75f2c4260';
const CURRENT = 'd453fdd79db114c914322f0209121c34819206b294004bdcece2739f0f3b4701';
const HISTORICAL_MASK = 'd7ac8e4150fb5984a94b3956614cb74f21e3b82c37a99efb76b60bef81354923';
const FINAL_MASK = '1200b9fe57f38c4a51fd0c536455817ffe0640b102727fd40b551cebb3ea4c80';
const IDS = ['123812227:0:f0', '123812227:0:b0'] as const;
const CROP = [-128, 640, 0, 897] as const;
const hash = (value: unknown) => sourceSha256(JSON.stringify(value));
export interface KopernikPin {file: string; sha256: string; bytes?: number}
export interface KopernikRegistrationContext {
  original: RoadGraph; current: RoadGraph;
  originalWorld: SerializedFloorWorld; currentWorld: SerializedFloorWorld;
  sourceMask: KopernikPin; coverage: RoadCoverage;
  sourcePins: {osmSha256: string; streetPartsSha256: string};
  provenanceArchive: KopernikPin; otherRegistrationIds: readonly string[];
  read: (pin: KopernikPin, cap?: number) => Uint8Array;
}
declare const kopernikBrand: unique symbol;
export interface ReviewedKopernikRegistration {readonly [kopernikBrand]: true}
interface Bound {originalHash: string; currentHash: string; before: RoadLane[]; after: RoadLane[]; witnesses: {kind: 'lanes'; id: string; beforeSha256: string; afterSha256: string}[]; verifyInputs: () => void}
const authorities = new WeakMap<object, Bound>();
function scope(ids: readonly string[]) {assert.ok(Array.isArray(ids) && ids.length <= 10000 && ids.every(id => typeof id === 'string' && id.length <= 200)); assert.equal(new Set(ids).size, ids.length); assert.ok(IDS.every(id => !ids.includes(id)), 'Kopernik registration overlaps another authority');}
function bound(authority: ReviewedKopernikRegistration) {const result = authorities.get(authority); assert.ok(result, 'Unrecognized Kopernik registration authority'); result.verifyInputs(); return result;}
function taskPin(ref: KopernikPin): KopernikPin {assert.match(ref.file, /^(?:evidence|work|source)\/[A-Za-z0-9_./-]+$/); assert.ok(!ref.file.split('/').includes('..')); return {...ref, file: '../' + ref.file};}
const coverageOf = (mask: any): RoadCoverage => ({playArea: mask.qualification.expanded, supportedArea: mask.supportedArea});
const polygons = (coverage: RoadCoverage): polygonClipping.MultiPolygon => coverage.supportedArea!.regions.map(r => [r.outer.map(p => [p[0],p[1]] as Vec2), ...(r.holes ?? []).map(h => h.map(p => [p[0],p[1]] as Vec2))]);

/** A joint registration of two literal inherited lane axes. It is deliberately
 * separate from height-only baselines and grants no source, floor or spawn rule. */
export function readReviewedKopernikRegistration(approvalPin: KopernikPin, context: KopernikRegistrationContext) {
  assert.equal(approvalPin.sha256, KOPERNIK_REGISTRATION_APPROVAL, 'Unapproved Kopernik registration');
  assert.equal(context.originalWorld.manifestSha256, ORIGINAL); assert.equal(context.currentWorld.manifestSha256, CURRENT, 'No future Kopernik world alias');
  assert.equal(context.provenanceArchive.sha256, ARCHIVE); assert.ok([HISTORICAL_MASK, FINAL_MASK].includes(context.sourceMask.sha256), 'Unreviewed Kopernik source mask'); scope(context.otherRegistrationIds);
  const pins: {pin: KopernikPin; cap: number}[] = []; let totalBytes = 0;
  const read = (pin: KopernikPin, cap = 64 * 1024 * 1024) => {
    assert.ok(pin && typeof pin.file === 'string' && pin.file.length <= 4096); assert.match(pin.sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(Object.keys(pin).sort(), (pin.bytes === undefined ? ['file','sha256'] : ['file','sha256','bytes']).sort());
    const bytes = context.read(pin, cap); assert.ok(bytes.length > 0 && bytes.length <= cap); if (pin.bytes !== undefined) assert.equal(bytes.length, pin.bytes);
    assert.equal(sourceSha256(bytes), pin.sha256, 'Kopernik input changed'); totalBytes += bytes.length; assert.ok(totalBytes <= 512 * 1024 * 1024, 'Unbounded Kopernik evidence'); pins.push({pin: structuredClone(pin), cap}); return bytes;
  };
  const json = (pin: KopernikPin, cap?: number): any => JSON.parse(Buffer.from(read(pin, cap)).toString());
  const approval = json(approvalPin, 65536); assert.equal(approval.status, 'APPROVED_LITERAL_TWO_RECORD_SOURCE_CONTAINED_KOPERNIK_REGISTRATION'); assert.equal(approval.proposal.sha256, PROPOSAL);
  const proposal = json(taskPin(approval.proposal), 2_000_000), reviews = approval.reviews.map((p: KopernikPin) => json(taskPin(p), 65536));
  assert.deepEqual(proposal.originalWorld, approval.originalWorld); assert.deepEqual(proposal.currentWorld, approval.currentWorld);
  assert.equal(approval.producerArchive.sha256, ARCHIVE);
  const archive = json(context.provenanceArchive, 65536) as {name:string;sha256:string;bytes:number;archiveFile:string}[]; assert.equal(archive.length, 115); assert.equal(new Set(archive.map(p=>p.name)).size, 115);
  for (const entry of archive) {assert.equal(entry.archiveFile, entry.sha256); assert.match(entry.archiveFile, /^[a-f0-9]{64}$/); read({file: sourceFile(path.dirname(context.provenanceArchive.file), entry.archiveFile), sha256: entry.sha256, bytes: entry.bytes}, 8 * 1024 * 1024);}
  const snapshot = json(proposal.sourceSnapshot, 65536) as {file:string;sha256:string;bytes:number}[];
  assert.equal(snapshot.length, 102); for (const entry of snapshot) assert.ok(archive.some(a=>a.name===entry.file&&a.sha256===entry.sha256&&a.bytes===entry.bytes), 'Historical producer missing from closed archive');
  assert.ok(archive.some(a=>a.sha256===approval.producerSha256));
  for (const step of proposal.executed) {assert.equal(step.exitCode, 0); assert.ok(archive.some(a=>a.sha256===step.entry.sha256)); assert.ok(archive.some(a=>a.sha256===step.originalProducer.sha256)); read(step.log, 65536); assert.deepEqual(step.output, proposal.proofs[step.role]);}
  for (const pin of proposal.candidateDerivation) read(pin, 2_000_000);
  const proofs: Record<string, any> = {}; for (const [role, pin] of Object.entries(proposal.proofs)) {const bytes=read(pin as KopernikPin,32*1024*1024); if(role!=='nativeComparison') proofs[role]=JSON.parse(Buffer.from(bytes).toString());}
  const manifest = (world: SerializedFloorWorld) => json({file: sourceFile(world.directory,'manifest.json'), sha256:world.manifestSha256},16*1024*1024) as WorldManifest;
  const om=manifest(context.originalWorld), cm=manifest(context.currentWorld);
  const payload=(world:SerializedFloorWorld,ref:{path:string;sha256:string;bytes:number})=>decodeDeliverySimulation(read({file:sourceFile(world.directory,ref.path),sha256:ref.sha256,bytes:ref.bytes}),ref);
  assert.equal(hash(decodeRoadGraph(payload(context.originalWorld,om.roads))),hash(context.original),'Actual ORIGINAL graph required');
  assert.equal(hash(decodeRoadGraph(payload(context.currentWorld,cm.roads))),hash(context.current),'Actual CURRENT graph required');
  const oldGameplay=JSON.parse(payload(context.originalWorld,om.gameplay).toString()) as GameplayBundle, gameplay=JSON.parse(payload(context.currentWorld,cm.gameplay).toString()) as GameplayBundle;
  assert.deepEqual(gameplay.vehicleDefinitions,oldGameplay.vehicleDefinitions); assert.deepEqual(oldGameplay.playArea,{minX:-1792,maxX:800,minZ:-2304,maxZ:768}); assert.equal(oldGameplay.supportedArea,undefined);
  const graphReview=reviews.find((r:any)=>r.status==='PASS_ACTUAL_ORIGINAL_CURRENT_TWO_RECORD_BINDING_AND_43_ADDITIONS'); assert.ok(graphReview);
  assert.equal(hash(context.original),graphReview.originalRoadGraphSha256); assert.equal(hash(context.current),graphReview.currentRoadGraphSha256);
  const additions=[]; for(const kind of ['nodes','lanes','connectors','footways','parking'] as const){const old=new Set(context.original[kind].map(r=>r.id));for(const record of context.current[kind])if(!old.has(record.id))additions.push({kind,id:record.id,sha256:hash(record)});}
  assert.equal(additions.length,43); assert.deepEqual(additions,proposal.currentAdditions); assert.deepEqual(additions,graphReview.currentAdditions);
  assert.deepEqual(proposal.sourceInputs,approval.source.sourcePins); const street=proposal.sourceInputs.find((p:KopernikPin)=>p.sha256==='1ac1409cf70cd6c3ad1ab7139fd6f365898d5c654e499616a1892d1b669645b2'),osmPin=proposal.sourceInputs.find((p:KopernikPin)=>p.sha256==='a6bf71bae890ab60b4249c8546e6b7185ce37c9ede4137e9c4aefbd9a755e65a'); assert.ok(street&&osmPin);
  read(street); const osm=json(osmPin); assert.deepEqual(context.sourcePins,{osmSha256:osmPin.sha256,streetPartsSha256:street.sha256});
  const way=osm.elements.find((w:any)=>w.type==='way'&&w.id===123812227); assert.ok(way?.nodes?.length&&way.tags?.highway); const waySha256=hash(way);
  const parts=loadGeoJsonPolygons(street.file,25497350,6672960,p=>String(p.osan_id)),selected=approval.source.ordinaryCarriagewayPartIds.map((id:string)=>{const part=parts.find(p=>p.id===id);assert.ok(part);const approved=proofs.source.sourceParts.find((p:any)=>p.id===id);assert.equal(hash(part),approved.sha256);assert.equal(part.properties.paatyyppi,'Ajorata');assert.equal(part.properties.alatyyppi,'Ajorata');return part;});
  const union=polygonClipping.union(...selected.map((p:typeof parts[number])=>p.rings.map(r=>r.map(([x,n])=>[x,-n] as Vec2))) as [polygonClipping.Polygon,...polygonClipping.Polygon[]]);
  const sourceCoverage:RoadCoverage={playArea:{minX:-100,minZ:700,maxX:0,maxZ:850},supportedArea:{schemaVersion:1,regions:union.map((p,i)=>({id:'public-carriageway-'+i,outer:p[0]!.slice(0,-1),holes:p.slice(1).map(r=>r.slice(0,-1))}))}};
  assert.equal(proposal.mask.sha256,HISTORICAL_MASK); const historicalMask=json(proposal.mask,2_000_000), actualMask=json(context.sourceMask,2_000_000); if(context.sourceMask.sha256===HISTORICAL_MASK)assert.deepEqual(actualMask,historicalMask);
  assert.equal(actualMask.qualification.status,'PASS_SOURCE_QUALIFIED_SUPPORTED_AREA'); assert.deepEqual(context.coverage,coverageOf(actualMask),'Actual pinned Kopernik coverage required');
  const historicalCoverage=coverageOf(historicalMask), crop:polygonClipping.MultiPolygon=[[[[CROP[0],CROP[1]],[CROP[2],CROP[1]],[CROP[2],CROP[3]],[CROP[0],CROP[3]]]]];
  const historicalLocal=polygonClipping.intersection(polygons(historicalCoverage),crop), actualLocal=polygonClipping.intersection(polygons(context.coverage),crop);
  assert.deepEqual(polygonClipping.difference(historicalLocal,actualLocal),[]); assert.deepEqual(polygonClipping.difference(actualLocal,historicalLocal),[],'Mask changes local Kopernik physical domain');
  const floor=readSerializedRoadFloor(context.currentWorld,[-50,725,-20,838],context.original.originId); assert.deepEqual(floor.receipt,proofs.connected.floor); assert.deepEqual(floor.receipt,proofs.nativeOutback.floor);
  const nativeCells=[];for(const cell of cm.cells){const b=cell.collision.boundsXZ??cell.boundsXZ;if(b[0]>CROP[2]||b[2]<CROP[0]||b[1]>CROP[3]||b[3]<CROP[1])continue;const bytes=payload(context.currentWorld,cell.collision);nativeCells.push({id:cell.id,decodedSha256:sourceSha256(bytes),decodedBytes:bytes.length});} assert.deepEqual(nativeCells,proofs.nativeOutback.cells);
  const terrain=parseTerrain(payload(context.currentWorld,cm.terrain)); assert.equal(terrain.resolution,1); const heights=new Float32Array(129*257);for(let z=0;z<257;z++)for(let x=0;x<129;x++){const value=terrain.heights[(640+z-terrain.z0)*terrain.nx-128+x-terrain.x0];assert.ok(value!==undefined&&Number.isFinite(value));heights[z*129+x]=value;}
  const terrainCropSha256=sourceSha256(new Uint8Array(heights.buffer));assert.equal(terrainCropSha256,proofs.nativeOutback.terrainCropSha256);assert.equal(terrainCropSha256,proofs.census.terrainCropSha256);
  const envelope=deriveRoadPhysicalEnvelope(gameplay.vehicleDefinitions),support=new RoadCollisionSupport(floor.triangles);assert.equal(envelope.definitionsSha256,proofs.parallel.definitionsSha256);
  const before:RoadLane[]=[],after:RoadLane[]=[],physicalResults=[];let sourcePoses=0,sourceTransitions=0,unsupportedKnots=0,minCropMargin=Infinity;
  const cropContains=(points:readonly Vec2[],padding=0)=>{for(const[x,z]of points){const margin=Math.min(x-CROP[0],CROP[2]-x,z-CROP[1],CROP[3]-z)-padding;assert.ok(margin>0,'Kopernik pose/sweep leaves its exact compatibility crop');minCropMargin=Math.min(minCropMargin,margin);}};
  assert.deepEqual(proposal.cases.map((c:any)=>c.id),IDS);for(const c of proposal.cases){
    const old=context.original.lanes.find(l=>l.id===c.id),current=context.current.lanes.find(l=>l.id===c.id),lane=c.after as RoadLane,approved=approval.records.find((r:any)=>r.id===c.id);assert.ok(old&&current&&approved);assert.deepEqual(old,c.before);assert.deepEqual(current,old);assert.equal(hash(old),approved.beforeSha256);assert.equal(hash(lane),approved.afterSha256);
    const{points:op,...ometa}=old,{points:np,...nmeta}=lane;assert.deepEqual(ometa,nmeta);assert.deepEqual([np[0],np.at(-1)],[op[0],op.at(-1)]);assert.equal(lane.length,approved.metadataLength);assert.equal(polylineLength(np),approved.actualPolylineAfter);assert.equal(np.length,379);
    assert.ok(way.nodes.includes(Number(lane.from.slice(1)))&&way.nodes.includes(Number(lane.to.slice(1))));
    for(let i=0;i<c.horizontalAuthoring.moves.length;i++){const move=c.horizontalAuthoring.moves[i],p=pointAlong(op,move.station).point;assert.deepEqual([np[i]![0],np[i]![2]],[move.after[0],move.after[2]]);assert.deepEqual([p[0],p[2]],[move.before[0],move.before[2]]);assert.ok(Math.hypot(np[i]![0]-p[0],np[i]![2]-p[2])<=approved.continuousHorizontalBoundMetres);}
    const admission=inspectRoadAdmission(np,[[0,polylineLength(np)]],context.coverage,envelope);assert.deepEqual(admission.admittedIntervals,c.commonAdmittedIntervals);assert.deepEqual(admission.closedIntervals,c.closedIntervals);
    for(const u of c.closedTailReference.unsupported){assert.deepEqual(np[u.index],u.point);const station=polylineLength(np.slice(0,u.index+1)),pose=roadCoveragePose(np,station);const closed=envelope.definitions.filter(d=>!supportsVehiclePose(context.coverage,d,pose.position,pose.rotation,0)).map(d=>d.id);assert.deepEqual(closed,u.closedByDefinition);assert.equal(closed.length,3);unsupportedKnots++;}
    assert.equal(c.closedTailReference.unsupported.length,44);let poses=0,transitions=0;
    for(const definition of envelope.definitions){let previous:ReturnType<typeof roadCoveragePose>|undefined;for(let i=0,n=Math.ceil(polylineLength(np)/.125);i<=n;i++){const pose=roadCoveragePose(np,polylineLength(np)*i/n);if(!supportsVehiclePose(context.coverage,definition,pose.position,pose.rotation)){previous=undefined;continue;}cropContains(vehicleCoverageFootprint(definition,pose),.1);assert.ok(supportsVehiclePose(sourceCoverage,definition,pose.position,pose.rotation));poses++;if(previous){assert.ok(supportsVehicleTransition(sourceCoverage,definition,previous,pose));assert.ok(supportsVehicleTransition(context.coverage,definition,previous,pose));transitions++;}previous=pose;}}
    const sourceResult=proofs.source.results.find((r:any)=>r.id===c.id);assert.equal(poses,sourceResult.poses);assert.equal(transitions,sourceResult.transitions);assert.deepEqual(sourceResult.failures,[]);sourcePoses+=poses;sourceTransitions+=transitions;
    const connected=proofs.connected.results.find((r:any)=>r.id===c.id),approach=context.current.lanes.find(l=>l.id===connected.approach.id),connector=context.current.connectors.find(l=>l.id===connected.connector.id);assert.ok(approach&&connector);assert.equal(hash(approach),connected.approach.sha256);assert.equal(hash(connector),connected.connector.sha256);
    const referenceWitnesses:{pointXZ:number[];height:number;triangles:string[]}[]=[];const projected=(points:readonly Vec3[])=>{const length=polylineLength(points),result:Vec3[]=[];for(let i=0,n=Math.ceil(length/.125);i<=n;i++){const point=pointAlong(points,length*i/n).point,hit=support.project(point[0],point[2]);assert.ok(hit);result.push([point[0],hit.height,point[2]]);referenceWitnesses.push({pointXZ:[point[0],point[2]],height:hit.height,triangles:hit.triangles});}return result;};
    const forward=c.id===IDS[0],extension=forward?[...projected(approach.points),...projected(connector.points)]:[...projected(connector.points),...projected(approach.points)],reference=forward?[...extension,...np]:[...np,...extension],offset=forward?polylineLength([...extension,np[0]!]):0,ranges=c.commonAdmittedIntervals.map(([a,b]:[number,number])=>[a+offset,b+offset] as [number,number]);
    cropContains(reference.map(p=>[p[0],p[2]] as Vec2),Math.hypot(envelope.bodyHalfLength,envelope.bodyHalfWidth));
    assert.deepEqual(reference,connected.points);assert.deepEqual(referenceWitnesses,connected.referenceOnlyNativeYProjection);assert.deepEqual(ranges,connected.ranges);assert.equal(hash(reference),c.sourceConnectedReference.pointsSha256);
    const physical=inspectRoadPhysicalSupport(c.id,reference,lane.width,approval.source.ordinaryCarriagewayPartIds,parts,support,context.coverage,envelope,ranges,true);assert.deepEqual(physical,connected.physical);assert.equal(physical.failureCount,0);assert.equal(physical.heightToleranceMetres,.2);assert.equal(physical.nominalFailureCount,approved.nominalFailuresRemain);assert.equal(connected.standaloneFailedBodySamples,approved.standaloneEndpointClampedFailuresRemain);physicalResults.push({id:c.id,referencePointsSha256:hash(reference),ranges,samples:physical.samples,maxHeightDeviation:physical.maxHeightDeviation,bodyFailures:physical.failureCount,nominalFailuresRetained:physical.nominalFailureCount,standaloneEndpointFailuresRetained:connected.standaloneFailedBodySamples});before.push(structuredClone(old));after.push(structuredClone(lane));
  }
  assert.equal(unsupportedKnots,88);assert.equal(sourcePoses,3875);assert.equal(sourceTransitions,3869);
  for(const result of proofs.parallel.results)for(const polygon of result.union)for(const ring of polygon)cropContains(ring);assert.deepEqual(polygonClipping.intersection(proofs.parallel.results[0].union,proofs.parallel.results[1].union),[]);
  const nativeSummaries=[];for(const run of proofs.nativeOutback.runs){assert.ok(run.reached);assert.equal(run.version,'candidate');assert.deepEqual(run.counts,{coverage:0,sourcePose:0,sourceSweep:0,terrain:0,zeroContactTicks:0});assert.deepEqual(run.failures,[]);const definition=envelope.definitions.find(d=>d.id===run.definition);assert.ok(definition);let previous:typeof run.states[number]['pose']|undefined;
    for(const state of run.states){assert.ok(supportsVehiclePose(context.coverage,definition,state.pose.position,state.pose.rotation,state.pose.steerAngle));let padding=.1;if(previous){assert.ok(supportsVehicleTransition(context.coverage,definition,previous,state.pose));const a=previous.rotation.map((v:number)=>v/Math.hypot(...previous!.rotation)),b=state.pose.rotation.map((v:number)=>v/Math.hypot(...state.pose.rotation)),angle=2*Math.acos(Math.min(1,Math.abs(a.reduce((s:number,v:number,i:number)=>s+v*b[i],0))));padding+=vehicleCoverageRadius(definition)*angle*angle/8;cropContains(vehicleCoverageFootprint(definition,previous),padding);}cropContains(vehicleCoverageFootprint(definition,state.pose),padding);previous=state.pose;}
    nativeSummaries.push({id:run.laneId,definition:run.definition,ticks:run.states.length,turnTick:run.turnTick,reverseTick:run.reverseTick,trajectorySha256:hash(run.states),maximumTrack:run.maximumTrack,minimumContacts:run.minContacts,minimumOrientedClearance:run.minimumClearance,counts:run.counts});}
  assert.equal(nativeSummaries.length,6);assert.deepEqual(nativeSummaries,approval.regressionCensus.nativeOutbackRuns);assert.deepEqual(proofs.census.summary,Object.fromEntries(Object.keys(proofs.census.summary).map(k=>[k,approval.regressionCensus[k]])));
  const coverageSnapshot=structuredClone(context.coverage),sourcePinsSnapshot=structuredClone(context.sourcePins),sourceMaskSnapshot=structuredClone(context.sourceMask),originalHash=hash(context.original),currentHash=hash(context.current);
  const verifyInputs=()=>{for(const{pin,cap}of pins){const bytes=context.read(pin,cap);assert.ok(bytes.length>0&&bytes.length<=cap);if(pin.bytes!==undefined)assert.equal(bytes.length,pin.bytes);assert.equal(sourceSha256(bytes),pin.sha256,'Kopernik input changed after qualification');}assert.deepEqual(context.coverage,coverageSnapshot);assert.deepEqual(context.sourcePins,sourcePinsSnapshot);assert.deepEqual(context.sourceMask,sourceMaskSnapshot);scope(context.otherRegistrationIds);assert.equal(hash(context.original),originalHash);assert.equal(hash(context.current),currentHash);assert.deepEqual(readSerializedRoadFloor(context.currentWorld,[-50,725,-20,838],context.original.originId).receipt,floor.receipt);};verifyInputs();
  const witnesses=after.map((lane,i)=>({kind:'lanes' as const,id:lane.id,beforeSha256:hash(before[i]),afterSha256:hash(lane)})),authority=Object.freeze({}) as ReviewedKopernikRegistration;authorities.set(authority,{originalHash,currentHash,before,after,witnesses,verifyInputs});
  const baselines=kopernikRegistrationBaselines(authority,context.original,context.current,context.otherRegistrationIds);assert.equal(hash(baselines.currentBaseline),graphReview.registeredCurrentGraphSha256);
  return{authority,...baselines,witnesses:structuredClone(witnesses),receipt:{kind:'literal-joint-kopernik-protected-xz-registration',approvalSha256:KOPERNIK_REGISTRATION_APPROVAL,proposalSha256:PROPOSAL,producerArchiveSha256:ARCHIVE,originalManifestSha256:ORIGINAL,currentManifestSha256:CURRENT,witnesses:structuredClone(witnesses),registrationNotHeightOnly:true,jointPairRequired:true,all43CurrentAdditionsPreserved:true,sourcePins:sourcePinsSnapshot,sourceWaySha256:waySha256,sourcePartIds:approval.source.ordinaryCarriagewayPartIds,historicalMaskSha256:HISTORICAL_MASK,actualMaskSha256:context.sourceMask.sha256,maskCompatibility:{crop:CROP,symmetricDifferenceEmpty:true,minimumInflatedHullCropMargin:minCropMargin,actualNativeTrajectoryMaskRecheck:true},localCollision:floor.receipt.cells,terrainCropSha256,sourcePoses,sourceTransitions,physical:physicalResults,unsupportedKnotsRejected:unsupportedKnots,historicalNativeOutback:nativeSummaries,spawnLimitations:proofs.census.summary,noSourceFloorConnectorOrSteepSpawnOverride:true},verifyInputs};
}

export function kopernikRegistrationBaselines(authority:ReviewedKopernikRegistration,original:RoadGraph,current:RoadGraph,otherRegistrationIds:readonly string[]){const b=bound(authority);scope(otherRegistrationIds);assert.equal(hash(original),b.originalHash);assert.equal(hash(current),b.currentHash);const apply=(graph:RoadGraph)=>({...structuredClone(graph),lanes:graph.lanes.map(l=>structuredClone(b.after.find(r=>r.id===l.id)??l))});return{originalBaseline:apply(original),currentBaseline:apply(current)};}
export function assertReviewedKopernikAfter(authority:ReviewedKopernikRegistration,lane:RoadLane){const b=bound(authority),expected=b.after.find(r=>r.id===lane.id);assert.ok(expected,'Unreviewed Kopernik lane');assert.deepEqual(lane,expected,'Exact reviewed Kopernik AFTER required');return structuredClone(expected);}
/** The publication guard must consume the pair together. It returns authority
 * for exactly these two records; other changes still need ordinary preservation. */
export function assertReviewedKopernikCurrentRegistration(authority:ReviewedKopernikRegistration,actualCurrent:RoadGraph,proposed:RoadGraph){const b=bound(authority);assert.equal(hash(actualCurrent),b.currentHash,'Kopernik registration belongs to another current graph');for(const expected of b.after){const records=proposed.lanes.filter(l=>l.id===expected.id);assert.equal(records.length,1);assert.deepEqual(records[0],expected,'Both exact Kopernik AFTER lanes are required');}return b.after.map((after,i)=>({kind:'lanes' as const,id:after.id,before:structuredClone(b.before[i]!),after:structuredClone(after),beforeSha256:hash(b.before[i]),afterSha256:hash(after)}));}
