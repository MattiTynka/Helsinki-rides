import assert from 'node:assert/strict';
import path from 'node:path';
import polygonClipping from 'polygon-clipping';
import {decodeRoadGraph, polylineLength, type RoadGraph, type RoadLane, type RoadConnector, type GameplayBundle, type Vec2, type WorldManifest} from '../../../packages/world-schema/src/index.ts';
import {vehicleCoverageFootprint, vehicleCoverageRadius, type VehicleCoverageDefinition} from '../../../packages/sim/src/coverage-footprint.ts';
import {sourceSha256, sourceFile} from './source-files.ts';
import {decodeDeliverySimulation} from './delivery-city-payloads.ts';
import {readSerializedRoadFloor, type SerializedFloorWorld} from './serialized-road-floor.ts';
import {loadGeoJsonPolygons} from './geometry.ts';
import {deriveRoadPhysicalEnvelope, inspectRoadAdmission, inspectRoadPhysicalSupport, roadCoveragePose, RoadCollisionSupport, type RoadCoverage} from './expansion-road-merge.ts';
import {protectedRoadPieces} from './delivery-navigation-preservation.ts';
import {assertOutsideOnlyPolylineRepair} from './road-outside-repair.ts';

export const ITAMERI_RETAINED_OUTSIDE_APPROVAL = '1c633114dcc228d509d8dfd01e4422b5e4bede2baa0ee20579027f6087c9d856';
const PROPOSAL = '8ad0ab340ee53ea8526142548ff3fd9231a606bee8011b449eb9de6eb2598162';
const ID = '86957349:0:f0', PARALLEL = '86957349:0:f1';
const ACCEPTED_MANIFEST = '0e18e55e8730f01144eef72a80decffbb53cdd658222f87a7e8ad6f75f2c4260';
const CURRENT = 'd453fdd79db114c914322f0209121c34819206b294004bdcece2739f0f3b4701';
const BEFORE = '07012ae72f3ce89e8e27f92a5a895ff9570629c845dac9369912dc67f75472a6';
const AFTER = '63a4e40251f50233bee5ceea20164ee263cc9c3d35d8a473c52fa14c7d4db2b3';
const hash = (v: unknown) => sourceSha256(JSON.stringify(v));
export interface ItameriOutsidePin {file: string; sha256: string; bytes?: number}
export interface ItameriOutsideContext {
  original: RoadGraph; current: RoadGraph;
  originalWorld: SerializedFloorWorld; currentWorld: SerializedFloorWorld;
  coverage: RoadCoverage;
  selectedNewConnectors: readonly RoadConnector[];
  otherRegistrationIds: readonly string[];
  read: (pin: ItameriOutsidePin, cap?: number) => Uint8Array;
}
declare const itameriBrand: unique symbol;
export interface ReviewedItameriOutsideRegistration {readonly [itameriBrand]: true}
interface Bound {originalHash: string; currentHash: string; after: RoadLane; verifyInputs: () => void}
const authorities = new WeakMap<object, Bound>();
function scope(ids: readonly string[], connectors: readonly RoadConnector[]) {
  assert.ok(Array.isArray(ids) && ids.length <= 10000 && ids.every(id => typeof id === 'string' && id.length <= 200));
  assert.equal(new Set(ids).size, ids.length, 'Duplicate registration identity');
  assert.ok(!ids.includes(ID), 'Itameri outside registration overlaps another authority');
  assert.ok(Array.isArray(connectors) && connectors.length <= 10000);
  assert.ok(connectors.every(c => c.to !== ID), 'No new incoming Itameri connector is approved');
}
function required(authority: ReviewedItameriOutsideRegistration) {const b = authorities.get(authority); assert.ok(b, 'Unrecognized Itameri outside authority'); return b;}
function hull(input: readonly Vec2[]) {
  const points = [...input].sort((a,b) => a[0]-b[0] || a[1]-b[1]).filter((p,i,a) => !i || p[0] !== a[i-1]![0] || p[1] !== a[i-1]![1]);
  const turn = (a: Vec2,b: Vec2,c: Vec2) => (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);
  const half = (list: readonly Vec2[]) => {const out: Vec2[] = []; for (const p of list) {while (out.length >= 2 && turn(out.at(-2)!,out.at(-1)!,p) <= 0) out.pop(); out.push(p);} return out;};
  return [...half(points).slice(0,-1), ...half(points.slice().reverse()).slice(0,-1)];
}
/** Endpoint hull plus a conservative rotation remainder encloses every body,
 * skid and tyre pose. Circumscribed64gons preserve the separate .10m margins. */
function swept(points: RoadLane['points'], end: number, definition: VehicleCoverageDefinition) {
  assert.ok(end > 0 && end < 100 && points.length <= 1000);
  const shapes: polygonClipping.Polygon[] = [];
  for (let i=0,n=Math.ceil(end/.125); i<n; i++) {
    const a=roadCoveragePose(points,end*i/n), b=roadCoveragePose(points,end*(i+1)/n);
    const unit=(q:readonly number[])=>q.map(v=>v/Math.hypot(...q)),qa=unit(a.rotation),qb=unit(b.rotation),angle=2*Math.acos(Math.min(1,Math.abs(qa.reduce((s,v,k)=>s+v*qb[k]!,0))));
    const radius=.10+vehicleCoverageRadius(definition)*angle*angle/8,expand=radius/Math.cos(Math.PI/64);
    const ring=hull([...vehicleCoverageFootprint(definition,a),...vehicleCoverageFootprint(definition,b)].flatMap(p=>Array.from({length:64},(_,k)=>[p[0]+Math.cos(k*Math.PI/32)*expand,p[1]+Math.sin(k*Math.PI/32)*expand] as Vec2)));
    shapes.push([[...ring,ring[0]!]]);
  }
  return polygonClipping.union(shapes[0]!,...shapes.slice(1));
}

/** Only the literal approved outside6m set-back and taper. This constructor
 * reads actual source/world bytes and grants no source-node or connector rule. */
export function readReviewedItameriOutsideRegistration(approvalPin: ItameriOutsidePin, context: ItameriOutsideContext) {
  assert.equal(approvalPin.sha256, ITAMERI_RETAINED_OUTSIDE_APPROVAL, 'Unapproved Itameri outside registration');
  assert.equal(context.originalWorld.manifestSha256, ACCEPTED_MANIFEST); assert.equal(context.currentWorld.manifestSha256, CURRENT);
  scope(context.otherRegistrationIds, context.selectedNewConnectors);
  const pins: {pin: ItameriOutsidePin; cap: number}[] = [];
  const read = (p: ItameriOutsidePin, cap=64*1024*1024) => {
    assert.ok(p && typeof p.file === 'string' && p.file.length <= 4096); assert.match(p.sha256,/^[a-f0-9]{64}$/);
    assert.deepEqual(Object.keys(p).sort(),(p.bytes===undefined?['file','sha256']:['file','sha256','bytes']).sort());
    const bytes=context.read(p,cap); assert.ok(bytes.length > 0 && bytes.length <= cap); if(p.bytes!==undefined) assert.equal(bytes.length,p.bytes);
    assert.equal(sourceSha256(bytes),p.sha256,'Itameri source input changed'); pins.push({pin:structuredClone(p),cap}); return bytes;
  };
  const json=(p:ItameriOutsidePin,cap?:number):any=>JSON.parse(Buffer.from(read(p,cap)).toString());
  const approval=json(approvalPin,65536); assert.equal(approval.kind,'literal-itameri-retained-outside-endpoint-registration-approval'); assert.equal(approval.proposal.sha256,PROPOSAL);
  const proposal=json(approval.proposal,2_000_000),review=json(approval.independentReview,65536),target=json(review.target,2_000_000);
  assert.equal(approval.independentReview.sha256,'bb5e678eb151f68663c6b0b8f646738729d786af44d48fa2f478b409439224aa');
  assert.equal(review.target.sha256,'5ca43d74973826c3c450d1351c38c8e78c3b5d91daa03a38b234817e7ae41b11');
  assert.deepEqual(target.sourceClosure,approval.sourcePins); assert.equal(Object.keys(target.sourceClosure).length,60);
  for(const [file,digest]of Object.entries(target.sourceClosure)){
    // The pinned source archive includes a pnpm package name containing '@',
    // which is deliberately outside the narrower public asset path grammar.
    const root=path.resolve(target.sourceSnapshotRoot),resolved=path.resolve(root,file),relative=path.relative(root,resolved);
    assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative),'Source archive path escapes its root');
    read({file:resolved,sha256:digest as string},4*1024*1024);
  }
  read(target.producer); read(target.diagnosticProducer); read(target.diagnostic,16*1024*1024);
  const manifest=(w:SerializedFloorWorld)=>json({file:sourceFile(w.directory,'manifest.json'),sha256:w.manifestSha256},16*1024*1024) as WorldManifest;
  const om=manifest(context.originalWorld),cm=manifest(context.currentWorld);
  const payload=(w:SerializedFloorWorld,ref:{path:string;sha256:string;bytes:number})=>decodeDeliverySimulation(read({file:sourceFile(w.directory,ref.path),sha256:ref.sha256,bytes:ref.bytes}),ref);
  assert.equal(hash(decodeRoadGraph(payload(context.originalWorld,om.roads))),hash(context.original),'Actual ORIGINAL graph required');
  assert.equal(hash(decodeRoadGraph(payload(context.currentWorld,cm.roads))),hash(context.current),'Actual CURRENT graph required');
  const oldGameplay=JSON.parse(payload(context.originalWorld,om.gameplay).toString()) as GameplayBundle,currentGameplay=JSON.parse(payload(context.currentWorld,cm.gameplay).toString()) as GameplayBundle;
  assert.deepEqual(oldGameplay.playArea,{minX:-1792,maxX:800,minZ:-2304,maxZ:768}); assert.equal(oldGameplay.supportedArea,undefined);
  const before=context.original.lanes.find(l=>l.id===ID),current=context.current.lanes.find(l=>l.id===ID),after=proposal.selected.after as RoadLane;
  assert.ok(before && current); assert.equal(hash(before),BEFORE); assert.deepEqual(current,before); assert.equal(hash(after),AFTER);
  assert.deepEqual(proposal.original.record,before); assert.equal(approval.beforeSha256,BEFORE); assert.equal(approval.afterSha256,AFTER);
  const metadata=({points,length,...rest}:RoadLane)=>rest; assert.deepEqual(metadata(after),metadata(before));
  assert.equal(before.length,43.136); assert.equal(after.length,37.12772913784751); assert.equal(after.length,polylineLength(after.points));
  assert.deepEqual(after.points.at(-1),before.points.at(-1));
  assert.deepEqual(protectedRoadPieces(after.points,oldGameplay),protectedRoadPieces(before.points,oldGameplay),'Protected original XYZ changed');
  assert.deepEqual(protectedRoadPieces(after.points,currentGameplay),protectedRoadPieces(current.points,currentGameplay),'Protected current XYZ changed');
  assert.deepEqual(proposal.registration,approval.authorizedRegistration);
  for(const graph of [context.original,context.current]) {
    assert.equal(graph.connectors.filter(c=>c.to===ID).length,0,'Accepted incoming connector unexpectedly exists');
    assert.deepEqual(graph.connectors.filter(c=>c.from===ID),approval.graphContinuity.acceptedOutgoingConnectors);
  }
  const osm=json(proposal.source.osm),partsBytes=read(proposal.source.streetParts),parts=loadGeoJsonPolygons(proposal.source.streetParts.file,25497350,6672960,p=>String(p.osan_id));
  assert.equal(sourceSha256(partsBytes),'1ac1409cf70cd6c3ad1ab7139fd6f365898d5c654e499616a1892d1b669645b2');
  assert.equal(proposal.source.osm.sha256,'a6bf71bae890ab60b4249c8546e6b7185ce37c9ede4137e9c4aefbd9a755e65a');
  const way=osm.elements.find((w:any)=>w.type==='way'&&w.id===86957349); assert.equal(hash(way),approval.sourceWaySha256);
  const selected=approval.sourcePartIds.map((id:string)=>{const part=parts.find(p=>p.id===id);assert.ok(part);assert.equal(part.properties.paatyyppi,'Ajorata');assert.equal(part.properties.alatyyppi,'Ajorata');assert.deepEqual(part,proposal.source.parts.find((p:any)=>p.part.id===id).part);return part;});
  const polygons:polygonClipping.Polygon[]=selected.map((p:typeof parts[number])=>p.rings.map(r=>r.map(([x,n])=>[x,-n] as Vec2)));
  const union=polygonClipping.union(polygons[0]!,...polygons.slice(1),[[[-1792,-2304],[800,-2304],[800,768],[-1792,768],[-1792,-2304]]]);
  const sourceCoverage:RoadCoverage={playArea:proposal.source.sourceCoverage.playArea,supportedArea:{schemaVersion:1,regions:union.map((p,i)=>({id:'ordinary-carriageway-'+i,outer:p[0]!.slice(0,-1),...(p.length>1?{holes:p.slice(1).map(r=>r.slice(0,-1))}:{})}))}};
  assert.deepEqual(sourceCoverage,proposal.source.sourceCoverage);
  const floor=readSerializedRoadFloor(context.currentWorld,proposal.floor.region,context.original.originId); assert.deepEqual(floor.receipt,proposal.floor,'Current local HCOL closure changed');
  for(const cell of floor.receipt.cells){const ref=cm.cells.find(c=>c.id===cell.cell)!.collision;read({file:sourceFile(context.currentWorld.directory,ref.path),sha256:ref.sha256,bytes:ref.bytes});}
  const faces=new Map(floor.triangles.map(t=>[t.id,t])); assert.equal(proposal.literalFloorFaces.length,32); for(const f of proposal.literalFloorFaces)assert.deepEqual(faces.get(f.id),f,'Literal Itameri floor changed');
  const envelope=deriveRoadPhysicalEnvelope(oldGameplay.vehicleDefinitions); assert.equal(envelope.definitionsSha256,'bdc7451dab6157088d952b942acbf73a80a6d4e780d6132fa48a1ad9f34a65f3');
  const ranges=proposal.physical.intervals as [number,number][]; assert.deepEqual(ranges,[[0,19.09662038968907]]);
  const sourceAdmission=inspectRoadAdmission(after.points,ranges,sourceCoverage,envelope),maskAdmission=inspectRoadAdmission(after.points,ranges,context.coverage,envelope);
  assert.deepEqual(sourceAdmission,proposal.sourceAdmission); assert.equal(maskAdmission.closedIntervals.length,0,'Current mask closes the registered lane');
  const physical=inspectRoadPhysicalSupport(ID,after.points,after.width,approval.sourcePartIds,parts,new RoadCollisionSupport(floor.triangles),context.coverage,envelope,ranges,true);
  assert.deepEqual(physical,proposal.physical,'Current full-body Itameri support changed'); assert.equal(physical.failureCount,0);
  const diagnostic=json(proposal.diagnostic,16*1024*1024),projected=json(diagnostic.graph),parallel=projected.lanes.find((l:RoadLane)=>l.id===PARALLEL) as RoadLane,originalParallel=context.original.lanes.find(l=>l.id===PARALLEL)!;
  assert.deepEqual(context.current.lanes.find(l=>l.id===PARALLEL),originalParallel); assert.equal(hash(parallel),proposal.graphContinuity.parallelLane.sha256);
  const {points:parallelPoints,...parallelMetadata}=parallel,{points:originalParallelPoints,...originalParallelMetadata}=originalParallel;assert.deepEqual(parallelMetadata,originalParallelMetadata);assertOutsideOnlyPolylineRepair(originalParallelPoints,parallelPoints,oldGameplay);
  const seam=parallel.points.findIndex(p=>p[0]===-1792);assert.ok(seam>0);const parallelEnd=polylineLength(parallel.points.slice(0,seam+1));
  const sweeps=envelope.definitions.map(d=>({id:d.id,a:swept(after.points,ranges[0]![1],d),b:swept(parallel.points,parallelEnd,d)}));
  for(const a of sweeps)for(const b of sweeps)assert.equal(polygonClipping.intersection(a.a,b.b).length,0,'Registered and parallel physical clearance envelopes overlap');
  const verifyInputs=()=>{for(const p of pins){const b=context.read(p.pin,p.cap);assert.equal(sourceSha256(b),p.pin.sha256,'Itameri input changed after qualification');}assert.deepEqual(readSerializedRoadFloor(context.currentWorld,proposal.floor.region,context.original.originId).receipt,floor.receipt);};verifyInputs();
  const authority=Object.freeze({}) as ReviewedItameriOutsideRegistration;authorities.set(authority,{originalHash:hash(context.original),currentHash:hash(context.current),after:structuredClone(after),verifyInputs});
  const witness={kind:'lanes' as const,id:ID,beforeSha256:BEFORE,afterSha256:AFTER};
  return{authority,...itameriOutsideBaselines(authority,context.original,context.current,context.otherRegistrationIds,context.selectedNewConnectors),witness,receipt:{kind:'literal-itameri-outside-registration',approvalSha256:ITAMERI_RETAINED_OUTSIDE_APPROVAL,proposalSha256:PROPOSAL,originalManifestSha256:ACCEPTED_MANIFEST,currentManifestSha256:CURRENT,witness,oldLength:before.length,registeredLength:after.length,localCollisionClosure:floor.receipt.cells,noNewIncomingConnectors:true,protectedOriginalAndCurrentChordsPreserved:true,sourcePins:{osmSha256:proposal.source.osm.sha256,streetPartsSha256:proposal.source.streetParts.sha256},sourceWaySha256:approval.sourceWaySha256,sourcePartIds:approval.sourcePartIds,vehicleBodySamples:physical.samples,vehicleBodyFailures:0,nominalFailuresRetained:physical.nominalFailureCounts,parallelClearancePairs:9},floor:floor.receipt,verifyInputs};
}

export function itameriOutsideBaselines(authority:ReviewedItameriOutsideRegistration,original:RoadGraph,current:RoadGraph,otherRegistrationIds:readonly string[],selectedNewConnectors:readonly RoadConnector[]) {
  const b=required(authority);scope(otherRegistrationIds,selectedNewConnectors);assert.equal(hash(original),b.originalHash,'Itameri authority belongs to another ORIGINAL graph');assert.equal(hash(current),b.currentHash,'Itameri authority belongs to another CURRENT graph');
  const corrected=(g:RoadGraph)=>({...structuredClone(g),lanes:g.lanes.map(l=>structuredClone(l.id===ID?b.after:l))});return{originalBaseline:corrected(original),currentBaseline:corrected(current)};
}
export function assertReviewedItameriOutsideAfter(authority:ReviewedItameriOutsideRegistration,lane:RoadLane,selectedNewConnectors:readonly RoadConnector[]=[]) {const b=required(authority);scope([],selectedNewConnectors);assert.equal(hash(lane),hash(b.after),'Exact reviewed Itameri AFTER required');return structuredClone(b.after);}
