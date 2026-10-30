import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import polygonClipping from 'polygon-clipping';
import {decodeRoadGraph,parseCollisionBundle,validateSupportedArea,type RoadGraph,type SupportedArea,type Vec3,type WorldManifest} from '../../../packages/world-schema/src/index.ts';
import {decodeDeliverySimulation} from './delivery-city-payloads.ts';
import {sourceFile,sourceSha256} from './source-files.ts';
import {assertHorizontalSubdivision} from './road-horizontal-subdivision.ts';
import {loadGeoJsonPolygons,segmentDistance} from './geometry.ts';
import type {InheritedHeightContext,InheritedHeightPin,InheritedHeightWorld} from './reviewed-inherited-road-height.ts';
import type {RoadCoverage} from './expansion-road-merge.ts';

export const CURRENT_A_WALKING_APPROVAL_SHA256='b1113d2425bcd1caf07b6ffc0d1c3569cd71a7e6942806f5bab72fbea18df3fe';
export const CURRENT_A_WALKING_PROVENANCE_SHA256='11ed673635874a44aa9728d763ca8f70343d138a20273f747cb7631fac600217';
const ID='w29282225',ORIGINAL='0e18e55e8730f01144eef72a80decffbb53cdd658222f87a7e8ad6f75f2c4260',CURRENT='d453fdd79db114c914322f0209121c34819206b294004bdcece2739f0f3b4701';
const BEFORE='237811b0011b5c0e17aaf2c9b5e4e155acd49e4f80c432b3b6ddf052ea932a01',CURRENT_BEFORE='c389eab38b488580d6742bca33586ee99f15ce1c273fc1af3f3ccf492e425629',AFTER='0f01bb5dea4a08d4e0ce7c2eec8d96b2753d53582b46f7b19910ac2848caf867';
const PACKET='09dc0980f89533b483131fc7d95e3c1c93c84225df8536a3733e408e1fe38ab3',NORMALIZED_MASK='9e6426d55787089fb3739f99cb667fc3696507b33e068ba63a4ff1e615e156e6';
const SOURCE={osmSha256:'a6bf71bae890ab60b4249c8546e6b7185ce37c9ede4137e9c4aefbd9a755e65a',streetPartsSha256:'1ac1409cf70cd6c3ad1ab7139fd6f365898d5c654e499616a1892d1b669645b2'};
const hash=(value:unknown)=>sourceSha256(JSON.stringify(value));
type Footway=RoadGraph['footways'][number];
export interface CurrentAWalkingContext extends InheritedHeightContext {sourceMask:InheritedHeightPin;coverage:RoadCoverage}
declare const brand:unique symbol;
export interface ReviewedInheritedWalkingCurrentA {readonly [brand]:true}
type Witness={kind:'footways';id:string;beforeSha256:string;afterSha256:string};
interface Bound {originalHash:string;currentHash:string;after:Footway;coverageHash:string;sourceMaskSha256:string;witness:Witness}
const authorities=new WeakMap<object,Bound>();
function required(authority:ReviewedInheritedWalkingCurrentA){const b=authorities.get(authority);assert.ok(b,'Unrecognized current-A walking authority');return b;}
function disjoint(ids:readonly string[]){assert.ok(Array.isArray(ids)&&ids.length<=10000&&ids.every(id=>typeof id==='string'&&id.length>0&&id.length<=200));assert.equal(new Set(ids).size,ids.length,'Duplicate registration identity');assert.ok(!ids.includes(ID),'Current-A walking overlaps another registration');}
function boundedGraph(graph:RoadGraph){assert.equal(graph?.schemaVersion,2);let points=0;for(const kind of ['nodes','lanes','connectors','footways','parking']as const){assert.ok(Array.isArray(graph[kind])&&graph[kind].length<=100000);const ids=new Set<string>();for(const r of graph[kind]){assert.ok(typeof r.id==='string'&&r.id.length<=200&&!ids.has(r.id));ids.add(r.id);if('points'in r){assert.ok(Array.isArray(r.points)&&r.points.length<=100000);points+=r.points.length;assert.ok(points<=2_000_000);}}}}
const polygons=(area:SupportedArea):polygonClipping.MultiPolygon=>area.regions.map(r=>[r.outer.map(p=>[p[0],p[1]]as[number,number]),...(r.holes??[]).map(h=>h.map(p=>[p[0],p[1]]as[number,number]))]);

/** The existing current-A tail is a different record from ORIGINAL515. This
 * closed constructor binds both before records and never treats one as the other.
 * It grants no source-membership or physical-support exception. */
export function readReviewedInheritedWalkingCurrentA(approvalPin:InheritedHeightPin,context:CurrentAWalkingContext){
  assert.equal(approvalPin.sha256,CURRENT_A_WALKING_APPROVAL_SHA256,'Unapproved current-A walking correction');
  assert.equal(context.provenanceArchive.sha256,CURRENT_A_WALKING_PROVENANCE_SHA256,'Unapproved current-A historical provenance');
  assert.equal(context.originalWorld.manifestSha256,ORIGINAL);assert.equal(context.currentWorld.manifestSha256,CURRENT,'Current-A walking requires its exact current world');
  assert.equal(context.worldCompatibility,undefined,'No world compatibility alias is approved');assert.deepEqual(context.sourcePins,SOURCE);disjoint(context.otherRegistrationIds);
  boundedGraph(context.original);boundedGraph(context.current);
  assert.equal(hash(context.original.footways.find(r=>r.id===ID)),BEFORE,'Actual ORIGINAL walking record changed');
  assert.equal(hash(context.current.footways.find(r=>r.id===ID)),CURRENT_BEFORE,'Actual CURRENT walking record changed');
  const ledger=new Map<string,{pin:InheritedHeightPin;cap:number}>();let uniqueBytes=0;
  function checked(pin:InheritedHeightPin,cap=16*1024*1024,retain=false,remember=true):Buffer|undefined{
    assert.ok(pin&&typeof pin.file==='string'&&pin.file.length>0&&pin.file.length<=4096);assert.match(pin.sha256,/^[a-f0-9]{64}$/);
    assert.deepEqual(Object.keys(pin).sort(),(pin.bytes===undefined?['file','sha256']:['file','sha256','bytes']).sort());
    const file=sourceFile(path.dirname(pin.file),path.basename(pin.file)),key=fs.realpathSync(file),known=ledger.get(key);if(known)assert.equal(known.pin.sha256,pin.sha256,'Conflicting input identity');
    const fd=fs.openSync(file,'r');try{const before=fs.fstatSync(fd);assert.ok(before.isFile()&&before.size>0&&before.size<=cap,'Current-A evidence byte cap exceeded');if(pin.bytes!==undefined)assert.equal(before.size,pin.bytes);
      if(remember&&!known){uniqueBytes+=before.size;assert.ok(uniqueBytes<=1024*1024*1024&&ledger.size<2048,'Current-A evidence aggregate cap exceeded');}
      const digest=createHash('sha256'),chunk=Buffer.allocUnsafe(65536),pieces:Buffer[]=[];let size=0;
      for(;;){const n=fs.readSync(fd,chunk,0,chunk.length,null);if(!n)break;size+=n;assert.ok(size<=cap);digest.update(chunk.subarray(0,n));if(retain)pieces.push(Buffer.from(chunk.subarray(0,n)));}
      const after=fs.fstatSync(fd);assert.equal(size,before.size);assert.equal(after.size,before.size);assert.equal(after.mtimeMs,before.mtimeMs);assert.equal(digest.digest('hex'),pin.sha256,'Approved current-A input changed');
      if(remember)ledger.set(key,{pin:{...structuredClone(pin),file,bytes:size},cap});return retain?Buffer.concat(pieces,size):undefined;
    }finally{fs.closeSync(fd);}
  }
  const json=(pin:InheritedHeightPin,cap=16*1024*1024):any=>JSON.parse(checked(pin,cap,true)!.toString());
  const approval=json(approvalPin,65536);assert.equal(approval.kind,'literal-current-a-composed-w292-walking-height-and-source-mask-approval');assert.equal(approval.packet.sha256,PACKET);
  assert.equal(approval.independentReview.sha256,'f047330d47fa2766f33f4fa4911b05b72e879759689470842f7cebbf240cd922');
  assert.equal(approval.independentMaskAndNativeGeometryReview.sha256,'f3af7e2b8d609df04f18c89ad9996121294628f47b00cc9cea57f74edc817396');
  assert.equal(approval.provenanceArchive.sha256,CURRENT_A_WALKING_PROVENANCE_SHA256);
  const packet=json(approval.packet),independent=json(approval.independentReview),maskReview=json(approval.independentMaskAndNativeGeometryReview),replay=json(approval.freshNativeReplay),mapping=json(context.provenanceArchive,2*1024*1024);
  assert.equal(packet.originalWorld.manifestSha256,ORIGINAL);assert.equal(packet.currentWorld.manifestSha256,CURRENT);assert.equal(packet.cases.length,1);const c=packet.cases[0];
  const witness:Witness={kind:'footways',id:ID,beforeSha256:BEFORE,afterSha256:AFTER};assert.deepEqual(approval.records,[witness]);assert.deepEqual(approval.currentBeforeRecords,[{kind:'footways',id:ID,sha256:CURRENT_BEFORE}]);
  assert.equal(c.id,ID);assert.equal(hash(c.originalAccepted),BEFORE);assert.equal(hash(c.before),CURRENT_BEFORE);assert.equal(hash(c.after),AFTER);
  assert.equal(c.originalAcceptedRecordSha256,BEFORE);assert.equal(c.beforeSha256,CURRENT_BEFORE);assert.equal(c.afterSha256,AFTER);
  const metadata=(r:Footway)=>{const{points,...rest}=r;return rest;};assert.deepEqual(metadata(c.originalAccepted),metadata(c.after));assert.deepEqual(metadata(c.before),metadata(c.after));
  assertHorizontalSubdivision(c.originalAccepted.points,c.after.points);assertHorizontalSubdivision(c.before.points,c.after.points);
  assert.deepEqual(c.currentAComposition,approval.currentAComposition);assert.equal(c.currentAComposition.protectedOriginalTailIndex,9);assert.equal(c.currentAComposition.afterTailIndex,158);
  assert.deepEqual(c.before.points.slice(9),c.after.points.slice(158));assert.deepEqual(c.after.points.slice(158),c.currentAComposition.protectedLiteralTail);assert.equal(hash(c.after.points.slice(158)),'43807c51ca413643a5353fe3c7e394d5fa5a357ccf861fad11e16795e4051dbe');
  assert.deepEqual(c.before.points.slice(0,8),c.after.points.slice(0,8));assert.equal(c.after.points.length,162);
  const proofs:any={};for(const[key,pin]of Object.entries(packet.proofs)as[string,InheritedHeightPin][])proofs[key]=json(pin);
  const proposed=proofs.proposal.results[0];assert.equal(proofs.proposal.results.length,1);assert.deepEqual(proposed.original,c.before);assert.deepEqual(proposed.proposed,c.after);assert.deepEqual(proposed.acceptedOriginalRecord,c.originalAccepted);assert.deepEqual(proofs.proposal.sourcePins,SOURCE);
  assert.deepEqual(proposed.sourceFloorCells,c.oldAndCurrentFloor);assert.equal(proposed.sourceWaySha256,c.sourceWaySha256);assert.deepEqual(proposed.partIds,c.sourcePartIds);json(proofs.proposal.census);
  assert.equal(packet.sourceInputs.length,2);assert.deepEqual(packet.sourceInputs.map((p:any)=>p.sha256).sort(),Object.values(SOURCE).sort());for(const p of packet.sourceInputs)checked(p,64*1024*1024);
  assert.equal(mapping.packetSha256,PACKET);assert.equal(mapping.files.length,94);const archived=new Map<string,string>();
  for(const p of mapping.files){assert.ok(p.kind==='producer'||p.kind==='source');const key=p.kind+':'+p.name;assert.ok(!archived.has(key));archived.set(key,p.sha256);checked({file:sourceFile(path.dirname(context.provenanceArchive.file),p.path),sha256:p.sha256,bytes:p.bytes},4*1024*1024);}
  const producerHashes=new Set([...archived].filter(([key])=>key.startsWith('producer:')).map(([,sha])=>sha));let visited=0;
  function provenance(value:any,depth=0){assert.ok(depth<=64&&++visited<=1_000_000);if(typeof value==='number'){assert.ok(Number.isFinite(value));return;}if(!value||typeof value!=='object')return;
    if(value.files&&!Array.isArray(value.files)&&typeof value.files==='object')for(const[name,sha]of Object.entries(value.files))assert.equal(archived.get('source:'+name),sha,'Historical source closure missing');
    for(const[key,v]of Object.entries(value)){if(key==='producerSha256'||key==='reviewerSha256')assert.ok(producerHashes.has(v as string),'Historical producer missing');provenance(v,depth+1);}}
  const independentReplay=json(independent.replay),independentRays=json(independent.rayReplay);
  for(const v of [packet,independent,maskReview,independentReplay,independentRays,...Object.values(proofs)])provenance(v);
  for(const review of[independent,maskReview])assert.ok(producerHashes.has(review.reviewer.sha256));for(const g of replay.gates)assert.ok(producerHashes.has(g.scriptSha256)&&producerHashes.has(g.originalScriptSha256));

  // Normalization changes four provenance key names only. Runtime geometry and
  // the native-tested qualification object must remain byte-value identical.
  const amendment=approval.sourceMaskAmendment;assert.equal(amendment.originalNormalizedSourceMask.sha256,NORMALIZED_MASK);assert.equal(amendment.normalizedFinalSourceMask.sha256,'1200b9fe57f38c4a51fd0c536455817ffe0640b102727fd40b551cebb3ea4c80');assert.equal(context.sourceMask.sha256,amendment.normalizedFinalSourceMask.sha256,'Only the approved final source mask is admitted');
  assert.equal(amendment.unqualifiedCompactSourceMask.sha256,'5d65925d679030708b261c616a643b78e5847f0a452add02f46664d64ba9fd7a');assert.equal(amendment.qualifiedMetadataDerivative.sha256,'4b6e318d55c2efe9a9b5c1daa7ee82acf2df9e7e1d4494604ff96d2e633fd044');
  const historicalMask=json(amendment.originalProposedMask,4*1024*1024),normalized=json(amendment.originalNormalizedSourceMask,4*1024*1024),compact=json(amendment.unqualifiedCompactSourceMask,2_000_000),mask=json(context.sourceMask,2_000_000),previous=json(amendment.previousMask,2*1024*1024),serialization=json(amendment.losslessSourceMaskSerialization,65536),qualification=json(amendment.qualifiedMetadataDerivative,65536);
  assert.equal(serialization.original.sha256,NORMALIZED_MASK);assert.equal(serialization.compact.sha256,amendment.unqualifiedCompactSourceMask.sha256);assert.equal(serialization.allParsedValuesLiteral,true);assert.equal(serialization.sharedReviewDocumentByteCapUnchanged,2_000_000);checked(serialization.producer,65536);
  assert.equal(sourceSha256(JSON.stringify(normalized)+'\n'),amendment.unqualifiedCompactSourceMask.sha256,'Compact mask is not the exact lossless JSON serialization');assert.deepEqual(compact,normalized);
  const expected=structuredClone(historicalMask);let normalizedKeys=0;expected.sourceFiles=expected.sourceFiles.map((p:any)=>{if(p.path){assert.equal(p.file,undefined);return p;}assert.equal(typeof p.file,'string');const{file,...rest}=p;normalizedKeys++;return{...rest,path:file};});
  assert.equal(normalizedKeys,4);assert.deepEqual(normalized,expected,'Mask normalization changed more than four provenance keys');assert.deepEqual(normalized.supportedArea,historicalMask.supportedArea);assert.deepEqual(normalized.qualification,historicalMask.qualification);
  assert.equal(qualification.parent.sha256,amendment.unqualifiedCompactSourceMask.sha256);assert.equal(qualification.qualified.sha256,context.sourceMask.sha256);assert.deepEqual(Object.keys(qualification.metadataAmendment).sort(),['qualification','sourceFilesAppend']);assert.equal(qualification.metadataAmendment.sourceFilesAppend.length,4);
  const qualifiedExpected={...structuredClone(compact),qualification:structuredClone(qualification.metadataAmendment.qualification),sourceFiles:[...structuredClone(compact.sourceFiles),...structuredClone(qualification.metadataAmendment.sourceFilesAppend)]};assert.deepEqual(mask,qualifiedExpected,'Unapproved qualified-mask metadata change');assert.equal(sourceSha256(JSON.stringify(qualifiedExpected)+'\n'),context.sourceMask.sha256);assert.deepEqual(mask.supportedArea,historicalMask.supportedArea);
  checked(qualification.script,65536);const qualificationArchive=path.resolve(path.dirname(amendment.qualifiedMetadataDerivative.file),'w292-qualified-source-mask-v4-source-snapshot');for(const[name,sha256]of Object.entries(qualification.producer.files)){checked({file:sourceFile(qualificationArchive,name),sha256:sha256 as string},4*1024*1024);}
  assert.equal(mask.acceptedManifestSha256,ORIGINAL);assert.equal(mask.qualification.status,'PASS_SOURCE_QUALIFIED_SUPPORTED_AREA');assert.equal(mask.qualification.physicalNavigationStatus,'PENDING_FINAL_ALL_REGION_NAVIGATION');assert.equal(mask.qualification.actualParentManifestSha256,CURRENT);
  assert.deepEqual(context.coverage,{playArea:mask.qualification.expanded,supportedArea:mask.supportedArea},'Runtime coverage differs from approved final mask');assert.deepEqual(validateSupportedArea(mask.supportedArea,context.coverage.playArea),[]);
  assert.equal(mask.sourceFiles.length,30);for(const p of mask.sourceFiles)checked({file:p.path,sha256:p.sha256,bytes:p.bytes},64*1024*1024);
  const seam=proofs.maskProposal,certificate=proofs.continuousSource;assert.equal(seam.recordSha256,AFTER);assert.equal(seam.world.manifestSha256,CURRENT);assert.equal(amendment.proposal.sha256,packet.proofs.maskProposal.sha256);assert.equal(amendment.continuousSource.sha256,packet.proofs.continuousSource.sha256);
  assert.equal(maskReview.changedSourcePinMetadataEntries,4);assert.equal(maskReview.runtimeCoverageAndQualificationLiteral,true);assert.equal(maskReview.sourcePinFilesAndHashesPreserved,true);
  const oldPolygons=polygons(previous.supportedArea),newPolygons=polygons(mask.supportedArea),delta=polygonClipping.difference(newPolygons,oldPolygons);
  assert.deepEqual(polygonClipping.difference(oldPolygons,newPolygons),[],'Approved current playable coverage was removed');assert.deepEqual(polygonClipping.difference(delta,seam.sourcePartDelta),[]);assert.deepEqual(polygonClipping.difference(seam.sourcePartDelta,delta),[]);
  assert.equal(delta.length,1);assert.equal(delta[0]!.length,1);const vertices=delta[0]![0]!.slice(0,-1);assert.equal(vertices.length,4);const turns=vertices.map((p,i)=>{const q=vertices[(i+1)%4]!,r=vertices[(i+2)%4]!;return(q[0]-p[0])*(r[1]-p[1])-(q[1]-p[1])*(r[0]-p[0]);});assert.ok(turns.every(v=>v>0)||turns.every(v=>v<0));
  const parts=loadGeoJsonPolygons(seam.inputs.streetParts.file,25497350,6672960,p=>String(p.osan_id));assert.deepEqual(certificate.witnesses.map((w:any)=>w.id),['46516','58921']);
  for(const w of certificate.witnesses){const part=parts.find(p=>p.id===w.id);assert.ok(part);assert.equal(hash(part),w.sourcePartSha256);assert.equal(part.properties.paatyyppi,'Kevyt liikenne');assert.equal(part.properties.alatyyppi,'Jalankulkualue');assert.equal(part.properties.aluetieto,'Katu');const edge=w.edge,ring=part.rings[edge.ring]!;assert.deepEqual(edge.a,[ring[edge.index]![0],-ring[edge.index]![1]]);assert.deepEqual(edge.b,[ring[edge.index+1]![0],-ring[edge.index+1]![1]]);assert.equal(Math.max(...vertices.map(p=>segmentDistance(p,edge.a,edge.b).d)),edge.maximumDistance);assert.ok(edge.maximumDistance<=amendment.maximumContinuousPairedBoundaryDistanceMetres);}
  for(const part of parts){if(seam.sourcePartIds.includes(part.id))continue;const r=seam.boundsXZ,q=part.bbox;if(q[2]<r[0]||q[0]>r[2]||-q[1]<r[1]||-q[3]>r[3])continue;assert.deepEqual(polygonClipping.intersection(delta,[part.rings.map(r=>r.map(([x,y])=>[x,-y]as[number,number]))]),[],'Unapproved third source polygon');}

  const manifest=(w:InheritedHeightWorld)=>json({file:sourceFile(w.directory,'manifest.json'),sha256:w.manifestSha256})as WorldManifest;
  const om=manifest(context.originalWorld),cm=manifest(context.currentWorld);
  const payload=(w:InheritedHeightWorld,ref:{path:string;sha256:string;bytes:number})=>decodeDeliverySimulation(checked({file:sourceFile(w.directory,ref.path),sha256:ref.sha256,bytes:ref.bytes},64*1024*1024,true)!,ref);
  assert.equal(hash(decodeRoadGraph(payload(context.originalWorld,om.roads))),hash(context.original),'Authority requires actual ORIGINAL graph');assert.equal(hash(decodeRoadGraph(payload(context.currentWorld,cm.roads))),hash(context.current),'Authority requires actual CURRENT graph including additions');
  const additions=[];for(const kind of['nodes','lanes','connectors','footways','parking']as const){const oldIds=new Set(context.original[kind].map(r=>r.id));for(const r of context.current[kind])if(!oldIds.has(r.id))additions.push({kind,id:r.id,sha256:hash(r)});}assert.equal(additions.length,43);assert.deepEqual(additions,packet.retainedCurrentAdditions);
  for(const[w,m]of[[context.originalWorld,om],[context.currentWorld,cm]]as const){payload(w,m.gameplay);payload(w,m.terrain);}
  const faces=new Map<string,{id:string;tag:string;points:Vec3[]}>(),loaded=new Map<string,string>();let decodedBytes=0;
  function checkCells(w:InheritedHeightWorld,m:WorldManifest,pins:any[]){assert.ok(Array.isArray(pins)&&pins.length>0&&pins.length<=32);for(const p of pins){const id=p.cell??p.id,key=w.manifestSha256+':'+id,signature=hash({id,stored:p.storedSha256,decoded:p.decodedSha256,bytes:p.decodedBytes});if(loaded.has(key)){assert.equal(loaded.get(key),signature);continue;}const cell=m.cells.find(c=>c.id===id);assert.ok(cell);assert.equal(cell.collision.sha256,p.storedSha256);const bytes=payload(w,cell.collision);decodedBytes+=bytes.length;assert.ok(decodedBytes<=256*1024*1024);assert.equal(sourceSha256(bytes),p.decodedSha256);assert.equal(bytes.length,p.decodedBytes);const bundle=parseCollisionBundle(bytes);assert.equal(bundle.header.cell,id);assert.equal(bundle.header.originId,m.origin.id);loaded.set(key,signature);
      for(const collider of bundle.colliders)if(collider.group==='ground')for(let t=0;t<collider.indices.length/3;t++){const fid=`serialized:${id}:${collider.id}:${t}`;faces.set(w.manifestSha256+':'+fid,{id:fid,tag:bundle.header.surfaceTags[collider.triangleTags[t]!]!,points:[0,1,2].map(k=>Array.from(collider.positions.subarray(collider.indices[t*3+k]!*3,collider.indices[t*3+k]!*3+3))as Vec3)});}}}
  checkCells(context.originalWorld,om,c.oldAndCurrentFloor.original);checkCells(context.currentWorld,cm,c.oldAndCurrentFloor.current);checkCells(context.currentWorld,cm,seam.floor.cells);
  assert.equal(seam.native.length,6);const clipped:polygonClipping.MultiPolygon[]=[];
  for(const f of seam.native){const actual=faces.get(CURRENT+':'+f.id);assert.deepEqual(actual,{id:f.id,tag:f.tag,points:f.points});assert.equal(hash(actual),f.sha256);const[A,B,C]=actual!.points as[Vec3,Vec3,Vec3],u=B.map((n,i)=>n-A[i]!),v=C.map((n,i)=>n-A[i]!),normal=[u[1]!*v[2]!-u[2]!*v[1]!,u[2]!*v[0]!-u[0]!*v[2]!,u[0]!*v[1]!-u[1]!*v[0]!];assert.ok(Math.abs(normal[1]!)/Math.hypot(...normal)>=.65);const overlap=polygonClipping.intersection(delta,[[actual!.points.map(p=>[p[0],p[2]]as[number,number])]]);assert.deepEqual(overlap,f.clipped);for(const[x,z]of overlap.flat(2)){const y=A[1]-(normal[0]!*(x-A[0])+normal[2]!*(z-A[2]))/normal[1]!;for(const expected of seam.expectedHeightRange)assert.ok(Math.abs(y-expected)<=seam.maximumConservativeHeightDeviation+1e-12);}clipped.push(overlap);}
  assert.deepEqual(polygonClipping.difference(delta,polygonClipping.union(clipped[0]!,...clipped.slice(1))),[],'Exact native floor does not cover complete mask addition');
  const raw=(p:any)=>{const b=checked({file:p.file,sha256:p.storedSha256??p.sha256},32*1024*1024,true)!;if(p.decodedSha256){const decoded=gunzipSync(b,{maxOutputLength:64*1024*1024});assert.equal(decoded.length,p.decodedBytes);assert.equal(sourceSha256(decoded),p.decodedSha256);}};
  const dynamics=proofs.dynamics.cases[0],arithmetic=proofs.arithmetic.cases[0];assert.equal(dynamics.originalRecordSha256,CURRENT_BEFORE);assert.equal(dynamics.proposedRecordSha256,AFTER);assert.deepEqual(dynamics.runs,c.nativeRuns);assert.deepEqual(dynamics.summary,c.placementSummary);
  assert.deepEqual(c.physical,{samples:10098,maxHeightDeviation:.13439438980335439,failureCounts:{},failureCount:0,failures:[],radius:.38,stepMetres:.125});assert.deepEqual(arithmetic.failed,[]);assert.equal(arithmetic.rayPairs,805);assert.ok(arithmetic.maximumTOIResidualUlps<=4);assert.equal(arithmetic.sameColliderLiteralFaceClosureNormalXZ,true);assert.equal(arithmetic.actualPedestrianGroundResultsReproduced,true);raw(arithmetic.raw);
  let ticks=0;assert.equal(c.nativeRuns.length,6);for(const run of c.nativeRuns){assert.equal(run.exactTracePreserved,true);for(const side of[run.before,run.after]){assert.equal(side.status,'PASS');assert.equal(side.reached,true);for(const field of['missing','terrainCount','nonPublic','maskFailures'])assert.equal(side[field],0);raw(side.trace);}assert.equal(run.before.trace.decodedSha256,run.after.trace.decodedSha256);ticks+=run.after.ticks;}assert.equal(ticks,3244);
  for(const proof of[proofs.dynamics,proofs.arithmetic,independentReplay,independentRays]){const item=proof.cases.find((r:any)=>r.id===ID);assert.ok(item);checkCells(context.currentWorld,cm,item.cells);if(item.raw)raw(item.raw);else for(const run of item.runs){raw(run.before.trace);raw(run.after.trace);}}
  assert.equal(replay.pairedTicks,3244);assert.equal(replay.pairedValidRays,805);assert.equal(replay.historicalStalledRunsReproduced,true);assert.equal(packet.addressResults.length,1958);assert.equal(packet.routeLengths.length,5881);assert.equal(c.routeCoordinateQueries.length,1449);
  // The earlier six-pair stalls remain sealed failures, never relabelled PASS.
  assert.equal(approval.historicalMaskStalls.evidence.sha256,packet.proofs.priorStalledNative.sha256);assert.equal(proofs.priorStalledNative.cases.length,1);const stalled=proofs.priorStalledNative.cases[0];assert.equal(stalled.summary.physicalRunsPassed,0);assert.equal(stalled.runs.length,6);for(const run of stalled.runs)for(const side of[run.before,run.after]){assert.equal(side.status,'RETHINK');assert.equal(side.reached,false);raw(side.trace);}
  const verifyInputs=()=>{for(const {pin,cap}of ledger.values())checked(pin,cap,false,false);};verifyInputs();
  const authority=Object.freeze({})as ReviewedInheritedWalkingCurrentA;authorities.set(authority,{originalHash:hash(context.original),currentHash:hash(context.current),after:structuredClone(c.after),coverageHash:hash(context.coverage),sourceMaskSha256:context.sourceMask.sha256,witness});
  const currentWitness={kind:'footways' as const,id:ID,beforeSha256:CURRENT_BEFORE,afterSha256:AFTER};
  return{authority,...inheritedWalkingCurrentABaselines(authority,context.original,context.current,context.otherRegistrationIds),witness:structuredClone(witness),currentWitness,
    receipt:{schemaVersion:1,kind:'literal-reviewed-inherited-walking-current-a',approvalSha256:approvalPin.sha256,packetSha256:PACKET,provenanceArchiveSha256:CURRENT_A_WALKING_PROVENANCE_SHA256,originalManifestSha256:ORIGINAL,currentManifestSha256:CURRENT,originalGraphSha256:hash(context.original),currentGraphSha256:hash(context.current),witness:structuredClone(witness),currentWitness:structuredClone(currentWitness),currentAdditionsPreserved:43,currentATail:{beforeIndex:9,afterIndex:158,points:4,sha256:hash(c.after.points.slice(158))},sourceMaskSha256:context.sourceMask.sha256,historicalNormalizedMaskSha256:NORMALIZED_MASK,nativeTestedMaskSha256:amendment.originalProposedMask.sha256,maskGeometryReviewSha256:approval.independentMaskAndNativeGeometryReview.sha256,addedAreaSquareMetres:amendment.addedAreaSquareMetres,nativeMaskFaces:6,physical:{samples:10098,failures:0,radiusMetres:.38,heightToleranceMetres:.2,noSupportException:true},finiteRegression:{pairedScenarios:6,ticks:3244,rays:805,historicalStallsRetained:true},inputCount:ledger.size},
    verifyInputs};
}

export function inheritedWalkingCurrentABaselines(authority:ReviewedInheritedWalkingCurrentA,original:RoadGraph,current:RoadGraph,otherRegistrationIds:readonly string[]){const b=required(authority);disjoint(otherRegistrationIds);boundedGraph(original);boundedGraph(current);assert.equal(hash(original),b.originalHash,'Walking authority belongs to another ORIGINAL graph');assert.equal(hash(current),b.currentHash,'Walking authority belongs to another CURRENT graph');const corrected=(graph:RoadGraph):RoadGraph=>({...structuredClone(graph),footways:graph.footways.map(r=>structuredClone(r.id===ID?b.after:r))});return{originalBaseline:corrected(original),currentBaseline:corrected(current)};}
export function assertReviewedInheritedWalkingCurrentAAfter(authority:ReviewedInheritedWalkingCurrentA,record:Footway,coverage:RoadCoverage,sourceMaskSha256:string){const b=required(authority);assert.equal(hash(record),AFTER,'Exact reviewed current-A AFTER required');assert.equal(hash(coverage),b.coverageHash,'Runtime coverage changed after current-A qualification');assert.equal(sourceMaskSha256,b.sourceMaskSha256,'Final source-mask identity changed');}
