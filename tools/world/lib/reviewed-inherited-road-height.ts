import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {decodeRoadGraph, parseCollisionBundle, type RoadGraph, type RoadLane, type Vec3, type WorldManifest} from '../../../packages/world-schema/src/index.ts';
import {verifyInheritedHeightWorldCompatibility} from './inherited-height-world-compatibility.ts';
import {decodeDeliverySimulation} from './delivery-city-payloads.ts';
import {sourceFile, sourceSha256} from './source-files.ts';
import {assertHorizontalSubdivision} from './road-horizontal-subdivision.ts';

export const INHERITED_ROAD_HEIGHT_APPROVAL_SHA256 = '9045504e445aad57acfcdb12da65e680d455f65ecd3a1294250cbfbe67bc0a8f';
export const INHERITED_ROAD_HEIGHT_PROVENANCE_SHA256 = 'ad28489924e9804ae065d939655f61b1f14e5975f631534df65a51b5857a361f';
const RECORD = '59804323:0:f0';
const ORIGINAL = '0e18e55e8730f01144eef72a80decffbb53cdd658222f87a7e8ad6f75f2c4260';
const CURRENT = 'fe78e6a00102dc33f80c9685b1b204465c2d21e5d470ef20586ca1dddd3817c2';
const PACKET = '9967c41f92e95514fef86f7883638cb88cf1fa9a7868f01f0a66b16cb0833c7b';
const REVIEW = '078a7227b7b77d5ad343d3b4898c72d3cd198c008154e4f896fe0067f4e44ac9';
const BEFORE = '95a6f68a5df5636314dc9ded65d23b21bb30a0807a2b86151ca8f8642b74b438';
const AFTER = '89786a50872bca22703314305e8a6e039ad13ac1fd01bd120bc711c24daa9daa';
const OSM = 'a6bf71bae890ab60b4249c8546e6b7185ce37c9ede4137e9c4aefbd9a755e65a';
const PARTS = '1ac1409cf70cd6c3ad1ab7139fd6f365898d5c654e499616a1892d1b669645b2';
const hash = (value: unknown) => sourceSha256(JSON.stringify(value));
export interface InheritedHeightPin {file: string; sha256: string; bytes?: number}
export interface InheritedHeightWorld {directory: string; manifestSha256: string}
export interface InheritedHeightContext {
  original: RoadGraph; current: RoadGraph;
  originalWorld: InheritedHeightWorld; currentWorld: InheritedHeightWorld;
  sourcePins: {osmSha256: string; streetPartsSha256: string};
  provenanceArchive: InheritedHeightPin;
  /** Only the literal root-approved fe78 to d453 successor. */
  worldCompatibility?: InheritedHeightPin;
  otherRegistrationIds: readonly string[];
}
declare const authorityBrand: unique symbol;
export interface ReviewedInheritedRoadHeightAuthority {readonly [authorityBrand]: true}
export interface InheritedLegacyProbe {
  recordId: string; kind: 'bodyCollision' | 'laneWidthCollision';
  point: Vec3; sampleIdentity: string;
}
interface Bound {
  originalHash: string; currentHash: string; after: RoadLane;
  probes: InheritedLegacyProbe[]; currentWorld: InheritedHeightWorld;
  checkedInputs: {pin: InheritedHeightPin; cap: number}[];
  witness: {kind: 'lanes'; id: string; beforeSha256: string; afterSha256: string};
}
const authorities = new WeakMap<object, Bound>();
const exactKeys = (value: object, keys: readonly string[]) => assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), 'Unexpected inherited-height field');
function disjoint(ids: readonly string[]) {
  assert.ok(Array.isArray(ids) && ids.length <= 10000 && ids.every(id => typeof id === 'string' && id.length > 0 && id.length <= 200));
  assert.equal(new Set(ids).size, ids.length, 'Duplicate registration identity');
  assert.ok(!ids.includes(RECORD), 'Inherited height overlaps another registration');
}
function boundedGraph(graph: RoadGraph) {
  assert.ok(graph && graph.schemaVersion === 2);
  let points = 0;
  for (const kind of ['nodes', 'lanes', 'connectors', 'footways', 'parking'] as const) {
    assert.ok(Array.isArray(graph[kind]) && graph[kind].length <= 100000);
    for (const record of graph[kind]) if ('points' in record) {
      assert.ok(Array.isArray(record.points) && record.points.length <= 100000); points += record.points.length;
      assert.ok(points <= 2_000_000, 'Inherited graph point budget exceeded');
    }
  }
}
/** Stream immutable evidence, especially the 121 MB trajectory, without parsing
 * or retaining its states. Hash and file identity are checked before returning. */
function checkedFile(pin: InheritedHeightPin, cap: number, retain = false): Buffer | undefined {
  assert.ok(pin && typeof pin.file === 'string' && pin.file.length > 0 && pin.file.length <= 4096);
  assert.deepEqual(Object.keys(pin).sort(), (pin.bytes === undefined ? ['file','sha256'] : ['bytes','file','sha256']).sort());
  assert.match(pin.sha256, /^[a-f0-9]{64}$/);
  const file = sourceFile(path.dirname(pin.file), path.basename(pin.file)), fd = fs.openSync(file, 'r');
  try {
    const before = fs.fstatSync(fd); assert.ok(before.isFile() && before.size > 0 && before.size <= cap, 'Inherited input byte limit exceeded');
    if (pin.bytes !== undefined) assert.equal(before.size, pin.bytes, 'Inherited input byte length changed');
    const digest = createHash('sha256'), chunk = Buffer.allocUnsafe(65536), pieces: Buffer[] = [];
    let size = 0;
    for (;;) {const n = fs.readSync(fd, chunk, 0, chunk.length, null); if (!n) break; size += n; assert.ok(size <= cap); digest.update(chunk.subarray(0,n)); if (retain) pieces.push(Buffer.from(chunk.subarray(0,n)));}
    const after = fs.fstatSync(fd); assert.equal(size,before.size); assert.equal(after.size,before.size); assert.equal(after.mtimeMs,before.mtimeMs);
    assert.equal(digest.digest('hex'),pin.sha256,'Approved inherited-height input changed');
    return retain ? Buffer.concat(pieces,size) : undefined;
  } finally {fs.closeSync(fd);}
}
function required(authority: ReviewedInheritedRoadHeightAuthority) {
  const bound = authorities.get(authority); assert.ok(bound, 'Unrecognized inherited-road-height authority'); return bound;
}
export function inheritedLegacyProbeIdentity(probe: Pick<InheritedLegacyProbe,'recordId'|'kind'|'point'>) {
  assert.equal(probe.recordId,RECORD); assert.ok(probe.kind === 'bodyCollision' || probe.kind === 'laneWidthCollision');
  assert.ok(Array.isArray(probe.point) && probe.point.length === 3 && probe.point.every(Number.isFinite));
  return hash({recordId:probe.recordId,kind:probe.kind,point:probe.point});
}

/** One approved record only. Approval of a larger inherited-road bundle must use
 * its own literal constructor; no ID/pin substitution is accepted here. */
export function readReviewedInheritedRoadHeight(approvalPin: InheritedHeightPin, context: InheritedHeightContext) {
  assert.equal(approvalPin.sha256,INHERITED_ROAD_HEIGHT_APPROVAL_SHA256,'Unapproved inherited-road-height case');
  assert.equal(context.provenanceArchive.sha256,INHERITED_ROAD_HEIGHT_PROVENANCE_SHA256,'Unapproved historical provenance mapping');
  assert.equal(context.originalWorld.manifestSha256,ORIGINAL);
  assert.deepEqual(context.sourcePins,{osmSha256:OSM,streetPartsSha256:PARTS}); disjoint(context.otherRegistrationIds);
  boundedGraph(context.original); boundedGraph(context.current);
  for (const graph of [context.original,context.current]) {const lane=graph.lanes.find(l=>l.id===RECORD);assert.ok(lane,'Inherited before lane changed or missing');assert.equal(hash(lane),BEFORE,'Inherited before lane changed');}
  const checkedInputs: Bound['checkedInputs'] = [];
  const checked = (pin: InheritedHeightPin,cap=16*1024*1024,retain=false) => {const result=checkedFile(pin,cap,retain);checkedInputs.push({pin:structuredClone(pin),cap});return result;};
  const json = (pin: InheritedHeightPin,cap=16*1024*1024): any => JSON.parse(checked(pin,cap,true)!.toString());
  const compatibility=verifyInheritedHeightWorldCompatibility(context.worldCompatibility,context.currentWorld,context.current,approvalPin.sha256,checked);
  const approval=json(approvalPin,65536); assert.equal(approval.kind,'literal-inherited-road-height-metadata-approval');
  assert.equal(approval.packet.sha256,PACKET); assert.equal(approval.independentReview.sha256,REVIEW);
  const packet=json(approval.packet),independent=json(approval.independentReview),proposal=json(packet.proposal),regression=json(packet.regression),legacy=json(packet.unchangedLegacyFloor),mask=json(packet.mask);
  json(packet.originalComparison); for(const pin of packet.sourceInputs)checked(pin,64*1024*1024);
  assert.equal(packet.world.manifestSha256,CURRENT);assert.equal(packet.acceptedManifestSha256,ORIGINAL);
  assert.deepEqual(packet.record,{kind:'lanes',id:RECORD,beforeSha256:BEFORE,afterSha256:AFTER,before:packet.record.before,after:packet.record.after});
  assert.equal(hash(packet.record.before),BEFORE);assert.equal(hash(packet.record.after),AFTER);
  const after=packet.record.after as RoadLane,before=packet.record.before as RoadLane;
  const metadata=(lane:RoadLane)=>{const{points,...rest}=lane;return rest;};assert.deepEqual(metadata(before),metadata(after));assertHorizontalSubdivision(before.points,after.points);assert.deepEqual(after.points.slice(0,10),before.points.slice(0,10));
  assert.deepEqual(proposal.changes.lane.before,before);assert.deepEqual(proposal.changes.lane.after,after);
  // The large raw trace remains a required byte pin, but compact, sealed evidence
  // carries its independently checked state equality and finite native metrics.
  checked(packet.dynamics,128*1024*1024);assert.equal(regression.driveSha256,packet.dynamics.sha256);
  assert.equal(regression.proposalSha256,packet.proposal.sha256);assert.equal(regression.worldManifestSha256,CURRENT);
  assert.equal(regression.spawn.previouslyValid,157);assert.equal(regression.spawn.rayPairs,1413);assert.ok(regression.spawn.maximumToiResidualUlp<=4);
  assert.equal(independent.dynamics.runs,18);assert.equal(independent.dynamics.states,9053);assert.equal(independent.dynamics.exactFullStateEquality,true);assert.equal(independent.dynamics.allRecordedNumbersFinite,true);
  assert.ok(regression.dynamicRuns.length===18&&regression.dynamicRuns.every((r:any)=>r.exactVehicleTrajectoryPreserved&&r.reached&&!r.zeroContactTicks&&!r.terrainContacts&&Number.isFinite(r.minimumActualOrientedUndersideClearance)&&r.minimumActualOrientedUndersideClearance>0&&r.failures.length===0));
  const mapping=json(context.provenanceArchive,2*1024*1024);assert.equal(mapping.independentReviewSha256,REVIEW);assert.equal(mapping.files.length,54);
  const archived=new Map<string,string>();for(const p of mapping.files){checked({file:sourceFile(path.dirname(context.provenanceArchive.file),p.path),sha256:p.sha256,bytes:p.bytes},4*1024*1024);assert.ok(!archived.has(p.kind+':'+p.name));archived.set(p.kind+':'+p.name,p.sha256);}
  for(const binding of independent.sourceBindings)for(const [name,sha]of Object.entries(binding.files))assert.equal(archived.get('source:'+name),sha,'Historical source closure missing');
  for(const sha of [packet.producerSha256,proposal.producerSha256,regression.producerSha256,legacy.producerSha256,independent.producer.sha256,mask.qualification.producerSha256])assert.ok([...archived].some(([name,value])=>name.startsWith('producer:')&&value===sha),'Historical producer missing');
  assert.ok(mask.sourceFiles.length<=32);for(const p of mask.sourceFiles)checked({file:p.path,sha256:p.sha256,bytes:p.bytes},64*1024*1024);
  const manifest=(world:InheritedHeightWorld)=>json({file:sourceFile(world.directory,'manifest.json'),sha256:world.manifestSha256}) as WorldManifest;
  const om=manifest(context.originalWorld),m=manifest(context.currentWorld);
  const payload=(world:InheritedHeightWorld,ref:{path:string;sha256:string;bytes:number})=>decodeDeliverySimulation(checked({file:sourceFile(world.directory,ref.path),sha256:ref.sha256,bytes:ref.bytes},64*1024*1024,true)!,ref);
  assert.equal(hash(decodeRoadGraph(payload(context.originalWorld,om.roads))),hash(context.original),'Authority requires actual ORIGINAL graph');
  assert.equal(hash(decodeRoadGraph(payload(context.currentWorld,m.roads))),hash(context.current),'Authority requires actual CURRENT graph including additions');
  const additions=[];for(const kind of ['nodes','lanes','connectors','footways','parking'] as const){const oldIds=new Set(context.original[kind].map(r=>r.id));for(const r of context.current[kind])if(!oldIds.has(r.id))additions.push({kind,id:r.id,sha256:hash(r)});}assert.equal(additions.length,43);assert.deepEqual(additions,packet.scope.currentAdditionRecordsPreserved);
  const gameplay=JSON.parse(payload(context.currentWorld,m.gameplay).toString());assert.equal(hash(gameplay.addresses),packet.regressions.addressesSha256);assert.equal(hash(gameplay.landmarks),packet.regressions.landmarksSha256);
  // Reading the exact stored terrain is sufficient here: the approved compact
  // regression binds its original/corrected local crop and actual native rays.
  checked({file:sourceFile(context.currentWorld.directory,m.terrain.path),sha256:m.terrain.sha256,bytes:m.terrain.bytes},64*1024*1024);
  const faces=new Map<string,{tag:string;points:Vec3[]}>();let totalDecoded=0;
  const loadCells=(prefix:string,world:InheritedHeightWorld,manifest:WorldManifest,pins:any[])=>{
    assert.ok(pins.length>0&&pins.length<=32&&new Set(pins.map(p=>p.cell)).size===pins.length);
    for(const p of pins){const cell=manifest.cells.find(c=>c.id===p.cell);assert.ok(cell);assert.equal(cell.collision.sha256,p.storedSha256);const bytes=payload(world,cell.collision);totalDecoded+=bytes.length;assert.ok(totalDecoded<=512*1024*1024);assert.equal(sourceSha256(bytes),p.decodedSha256);assert.equal(bytes.length,p.decodedBytes);const bundle=parseCollisionBundle(bytes);assert.equal(bundle.header.cell,p.cell);assert.equal(bundle.header.originId,manifest.origin.id);
      for(const c of bundle.colliders)if(c.group==='ground')for(let t=0;t<c.indices.length/3;t++)faces.set(prefix+`serialized:${p.cell}:${c.id}:${t}`,{tag:bundle.header.surfaceTags[c.triangleTags[t]!]!,points:[0,1,2].map(k=>Array.from(c.positions.subarray(c.indices[t*3+k]!*3,c.indices[t*3+k]!*3+3)) as Vec3)});
    }
  };
  loadCells('old:',context.originalWorld,om,legacy.originalFloor.cells);loadCells('new:',context.currentWorld,m,regression.cellPins);
  assert.equal(legacy.bodyFailures,190);assert.equal(legacy.nominalFailures,8);assert.equal(legacy.misses.length,198);assert.equal(proposal.physical.failureCount,190);assert.deepEqual(proposal.physical.failureCounts,{bodyCollision:190});assert.equal(proposal.physical.heightToleranceMetres,.2);
  const nominal=new Set(proposal.physical.nominalFailures.map((p:any)=>hash(p.point))),probes:InheritedLegacyProbe[]=[],identities=new Set<string>();
  for(const miss of legacy.misses){assert.ok(miss.point.length===3&&miss.point.every(Number.isFinite)&&Number.isFinite(miss.actualHeight)&&Math.abs(miss.residual)>.2);
    assert.deepEqual(miss.originalFaces.map((f:any)=>({tag:f.tag,points:f.points})),miss.finalFaces.map((f:any)=>({tag:f.tag,points:f.points})));
    for(const [prefix,list]of [['old:',miss.originalFaces],['new:',miss.finalFaces]] as const)for(const f of list)assert.deepEqual(faces.get(prefix+f.id),{tag:f.tag,points:f.points},'Approved legacy floor moved or was replaced');
    const kind=nominal.has(hash(miss.point))?'laneWidthCollision':'bodyCollision',probe={recordId:RECORD,kind,point:structuredClone(miss.point)} as Omit<InheritedLegacyProbe,'sampleIdentity'>,sampleIdentity=inheritedLegacyProbeIdentity(probe);assert.ok(!identities.has(sampleIdentity));identities.add(sampleIdentity);probes.push({...probe,sampleIdentity});
  }
  assert.equal(probes.filter(p=>p.kind==='bodyCollision').length,190);assert.equal(probes.filter(p=>p.kind==='laneWidthCollision').length,8);
  const authority=Object.freeze({}) as ReviewedInheritedRoadHeightAuthority,witness={kind:'lanes' as const,id:RECORD,beforeSha256:BEFORE,afterSha256:AFTER};
  authorities.set(authority,{originalHash:hash(context.original),currentHash:hash(context.current),after:structuredClone(after),probes,currentWorld:structuredClone(context.currentWorld),checkedInputs,witness});
  return {authority,...inheritedRoadHeightBaselines(authority,context.original,context.current,context.otherRegistrationIds),witness:structuredClone(witness),receipt:{schemaVersion:1,kind:'literal-reviewed-inherited-road-height',approvalSha256:approvalPin.sha256,packetSha256:PACKET,independentReviewSha256:REVIEW,provenanceArchiveSha256:INHERITED_ROAD_HEIGHT_PROVENANCE_SHA256,originalManifestSha256:ORIGINAL,currentManifestSha256:context.currentWorld.manifestSha256,...(compatibility?{historicalEvidenceManifestSha256:CURRENT,worldCompatibility:compatibility}:{}),originalGraphSha256:hash(context.original),currentGraphSha256:hash(context.current),currentAdditionsPreserved:43,witness:structuredClone(witness),legacyFailuresStillFailed:{body:190,nominal:8,toleranceMetres:.2}},verifyInputs:()=>{for(const item of checkedInputs)checkedFile(item.pin,item.cap);}};
}

/** Detached graphs cannot mutate the authority or each other. Callers retain the
 * ORIGINAL graph for final original-to-final change accounting. */
export function inheritedRoadHeightBaselines(authority:ReviewedInheritedRoadHeightAuthority,original:RoadGraph,current:RoadGraph,otherRegistrationIds:readonly string[]){
  const b=required(authority);disjoint(otherRegistrationIds);boundedGraph(original);boundedGraph(current);assert.equal(hash(original),b.originalHash,'Inherited authority belongs to another ORIGINAL graph');assert.equal(hash(current),b.currentHash,'Inherited authority belongs to another CURRENT graph');
  const corrected=(graph:RoadGraph)=>({...structuredClone(graph),lanes:graph.lanes.map(l=>structuredClone(l.id===RECORD?b.after:l))});
  return{originalBaseline:corrected(original),currentBaseline:corrected(current)};
}

/** A separate disposition for a complete observational failed-probe batch.
 * No sampler, result object, threshold, or failure count is changed. */
export function qualifyReviewedInheritedLegacyProbes(authority:ReviewedInheritedRoadHeightAuthority,input:{lane:RoadLane;currentWorld:InheritedHeightWorld;otherRegistrationIds:readonly string[];probes:readonly InheritedLegacyProbe[]}){
  const b=required(authority);disjoint(input.otherRegistrationIds);assert.equal(hash(input.lane),AFTER,'Legacy disposition requires the exact reviewed after lane');assert.equal(input.currentWorld.manifestSha256,b.currentWorld.manifestSha256);assert.equal(fs.realpathSync(input.currentWorld.directory),fs.realpathSync(b.currentWorld.directory),'Legacy disposition belongs to another serialized floor');
  assert.ok(Array.isArray(input.probes)&&input.probes.length===198,'Complete legacy failed-probe batch required');
  const ids=new Set<string>();for(const p of input.probes){exactKeys(p,['recordId','kind','point','sampleIdentity']);assert.equal(p.sampleIdentity,inheritedLegacyProbeIdentity(p));assert.ok(!ids.has(p.sampleIdentity),'Duplicate legacy failed probe');ids.add(p.sampleIdentity);}
  assert.deepEqual([...ids].sort(),b.probes.map(p=>p.sampleIdentity).sort(),'Unlisted or omitted legacy failed probe');
  // Recheck all serialized/provenance bytes at use, so a prior opaque token is
  // not a permission to use newly changed floor or stale raw evidence.
  for(const item of b.checkedInputs)checkedFile(item.pin,item.cap);
  return{schemaVersion:1,kind:'literal-unchanged-original-floor-native-dynamics-disposition',approvalSha256:INHERITED_ROAD_HEIGHT_APPROVAL_SHA256,packetSha256:PACKET,worldManifestSha256:b.currentWorld.manifestSha256,record:structuredClone(b.witness),observedProbeBatchSha256:hash([...input.probes].sort((a,b)=>a.sampleIdentity.localeCompare(b.sampleIdentity))),failedBodyProbesRetained:190,failedNominalProbesRetained:8,ordinaryHeightToleranceMetres:.2,ordinaryResultStillFailed:true,nativeDynamicsQualificationOnly:true};
}
