import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import pc from 'polygon-clipping';
import {decodeRoadGraph, parseCollisionBundle, type RoadGraph, type WorldManifest} from '../../../packages/world-schema/src/index.ts';
import {decodeDeliverySimulation} from './delivery-city-payloads.ts';
import {sourceFile, sourceSha256} from './source-files.ts';
import {assertHorizontalSubdivision} from './road-horizontal-subdivision.ts';
import {bbox, pointInPolygon, type LocalPolygon, type Ring} from './geometry.ts';
import {assertBoundedInheritedGraph, assertInheritedBundleDisjoint, inheritedBundleHash as hash, type InheritedBundleWitness} from './inherited-height-bundle-evidence.ts';
import type {InheritedHeightContext, InheritedHeightPin, InheritedHeightWorld} from './reviewed-inherited-road-height.ts';

export const INHERITED_WALKING_DRAINS_APPROVAL_SHA256 = '48ce3ab190ba47368b6e95aebc5368eb91de134e09f309b7068a7c22248936aa';
const PACKET = 'e9e67dc36195624cf1ae0dfd80b9ba8664f94ca80f293a72e40944aab3c9a985';
const ARCHIVE = '5629db5c0c3562343599d73924b4f39001e54a4ee0bc4807c6bfdc659a149e0a';
const ORIGINAL = '0e18e55e8730f01144eef72a80decffbb53cdd658222f87a7e8ad6f75f2c4260';
const CURRENT = 'd453fdd79db114c914322f0209121c34819206b294004bdcece2739f0f3b4701';
const SOURCE = {osmSha256:'a6bf71bae890ab60b4249c8546e6b7185ce37c9ede4137e9c4aefbd9a755e65a',streetPartsSha256:'1ac1409cf70cd6c3ad1ab7139fd6f365898d5c654e499616a1892d1b669645b2'};
const IDS = ['w123812255', 'w1442691114'];
const BEFORE = ['66b32a79cd1d9ffebf106512e5df61a655d97509d66ca3bcf6b4b189d063dc8e','8c8516e42720fa9abb17ba5728e840e3b829951e782c5acb8632b07fa8533193'];
const AFTER = ['f6daf2c113aebd24b08763e7be9c32c62f7b28bda6256b72bcc0f1e7a4e8107d','353421b742a17749e09a92ec7cf05b6cfbcc85377aaf1d9cc0337beccd31f52d'];
type Footway = RoadGraph['footways'][number];
declare const authorityBrand: unique symbol;
export interface ReviewedInheritedWalkingDrainsAuthority {readonly [authorityBrand]: true}
interface Bound {
  originalHash:string; currentHash:string; currentWorld:InheritedHeightWorld;
  records:Footway[]; witnesses:InheritedBundleWitness[];
  parts:Map<string,LocalPolygon[]>; sourceWitnesses:Map<string,object>;
  edgeBatch:unknown[]; edgeDisposition:{schemaVersion:number;kind:string;approvalSha256:string;recordId:string;edgeBatchSha256:string;ordinaryStrictRayIdentityFailuresRetained:number;sameNormalClaim:boolean;noGenericRayTolerance:boolean}; verifyInputs:()=>void;
}
const authorities = new WeakMap<object,Bound>();
function required(authority:ReviewedInheritedWalkingDrainsAuthority) {const b=authorities.get(authority);assert.ok(b,'Unrecognized inherited drain authority');return b;}

/** Literal approval only. The source role is issued separately and never changes
 * Varusteet/Pintavesikourut into a generally eligible road or walking surface. */
export function readReviewedInheritedWalkingDrains(approvalPin:InheritedHeightPin, context:InheritedHeightContext) {
  assert.equal(approvalPin.sha256,INHERITED_WALKING_DRAINS_APPROVAL_SHA256,'Unapproved inherited drain authority');
  assert.equal(context.provenanceArchive.sha256,ARCHIVE,'Unapproved drain historical archive');
  assert.equal(context.originalWorld.manifestSha256,ORIGINAL);assert.equal(context.currentWorld.manifestSha256,CURRENT,'Unreviewed drain floor successor');
  assert.equal(context.worldCompatibility,undefined,'Drain authority has no generic world compatibility');
  assert.deepEqual(context.sourcePins,SOURCE);assertInheritedBundleDisjoint(context.otherRegistrationIds,IDS);
  assertBoundedInheritedGraph(context.original);assertBoundedInheritedGraph(context.current);
  for(const g of [context.original,context.current])for(let i=0;i<IDS.length;i++)assert.equal(hash(g.footways.find(r=>r.id===IDS[i])),BEFORE[i],'Inherited drain BEFORE changed');
  const inputs=new Map<string,{pin:InheritedHeightPin;cap:number}>();let total=0;
  function checked(pin:InheritedHeightPin,cap=16*1024*1024,retain=false,remember=true):Buffer|undefined {
    assert.ok(pin&&typeof pin.file==='string'&&pin.file.length>0&&pin.file.length<=4096);assert.match(pin.sha256,/^[a-f0-9]{64}$/);
    assert.deepEqual(Object.keys(pin).sort(),(pin.bytes===undefined?['file','sha256']:['file','sha256','bytes']).sort());
    const file=sourceFile(path.dirname(pin.file),path.basename(pin.file)),key=fs.realpathSync(file),known=inputs.get(key);if(known)assert.equal(known.pin.sha256,pin.sha256,'Conflicting drain evidence identity');
    const fd=fs.openSync(file,'r');try {
      const before=fs.fstatSync(fd);assert.ok(before.isFile()&&before.size>0&&before.size<=cap,'Drain evidence byte cap exceeded');if(pin.bytes!==undefined)assert.equal(before.size,pin.bytes);
      if(remember&&!known){total+=before.size;assert.ok(total<=1024*1024*1024&&inputs.size<2048,'Drain evidence budget exceeded');}
      const digest=createHash('sha256'),chunk=Buffer.allocUnsafe(65536),pieces:Buffer[]=[];let size=0;
      for(;;){const n=fs.readSync(fd,chunk,0,chunk.length,null);if(!n)break;size+=n;assert.ok(size<=cap);digest.update(chunk.subarray(0,n));if(retain)pieces.push(Buffer.from(chunk.subarray(0,n)));}
      const after=fs.fstatSync(fd);assert.equal(size,before.size);assert.equal(after.size,before.size);assert.equal(after.mtimeMs,before.mtimeMs);assert.equal(digest.digest('hex'),pin.sha256,'Approved drain input changed');
      if(remember)inputs.set(key,{pin:{...structuredClone(pin),file,bytes:size},cap});return retain?Buffer.concat(pieces,size):undefined;
    } finally {fs.closeSync(fd);}
  }
  const json=(p:InheritedHeightPin,cap=16*1024*1024):any=>JSON.parse(checked(p,cap,true)!.toString());
  const raw=(p:any)=>checked({file:p.file,sha256:p.sha256??p.storedSha256},32*1024*1024);
  const approval=json(approvalPin,65536);assert.equal(approval.kind,'literal-two-inherited-drain-crossing-walking-height-approval');assert.equal(approval.packet.sha256,PACKET);assert.equal(approval.provenanceArchive.sha256,ARCHIVE);
  const packet=json(approval.packet),review=json(approval.independentReview),geometry=json(approval.independentGeometryReview),reproduction=json(approval.freshNativeReplay),mapping=json(context.provenanceArchive,2*1024*1024);
  assert.equal(mapping.packetSha256,PACKET);assert.equal(mapping.files.length,95);const archive=new Map<string,string>();
  for(const p of mapping.files){assert.ok(p.kind==='source'||p.kind==='producer');const key=p.kind+':'+p.name;assert.ok(!archive.has(key));archive.set(key,p.sha256);checked({file:sourceFile(path.dirname(context.provenanceArchive.file),p.path),sha256:p.sha256,bytes:p.bytes},4*1024*1024);}
  const proofs:any=Object.fromEntries(Object.entries(packet.proofs).map(([k,p])=>[k,json(p as InheritedHeightPin)]));
  const proposal=proofs.proposal,source=proofs.sourceReview,ties=proofs.edgeTies,replay=json(review.replay),rayReplay=json(review.rayReplay);
  assert.deepEqual(proposal.sourcePins,SOURCE);json(proposal.census);assert.equal(source.world.manifestSha256,CURRENT);assert.equal(ties.world.manifestSha256,CURRENT);assert.equal(ties.recordId,IDS[0]);
  assert.equal(packet.originalWorld.manifestSha256,ORIGINAL);assert.equal(packet.currentWorld.manifestSha256,CURRENT);assert.deepEqual(packet.cases.map((c:any)=>c.id),IDS);
  assert.equal(packet.sourceInputs.length,2);assert.deepEqual(packet.sourceInputs.map((p:any)=>p.sha256).sort(),Object.values(SOURCE).sort());for(const p of packet.sourceInputs)checked(p,64*1024*1024);
  const mask=json(packet.mask);assert.equal(packet.mask.sha256,'d7ac8e4150fb5984a94b3956614cb74f21e3b82c37a99efb76b60bef81354923');assert.ok(mask.sourceFiles.length<=64);
  for(const p of mask.sourceFiles)checked({file:p.path,sha256:p.sha256,bytes:p.bytes},64*1024*1024);
  let visited=0;
  function provenance(v:any,depth=0){assert.ok(depth<=64&&++visited<1_000_000);if(typeof v==='number'){assert.ok(Number.isFinite(v),'Nonfinite drain evidence');return;}if(!v||typeof v!=='object')return;
    if(v.files&&!Array.isArray(v.files)&&typeof v.files==='object')for(const[name,sha]of Object.entries(v.files))assert.equal(archive.get('source:'+name),sha,'Historical drain source missing');
    if(v.reviewer?.sha256)assert.ok([...archive].some(([k,sha])=>k.startsWith('producer:')&&sha===v.reviewer.sha256),'Historical drain reviewer missing');
    for(const[k,value]of Object.entries(v)){if(k==='producerSha256'||k==='scriptSha256'||k==='originalScriptSha256')assert.ok([...archive].some(([name,sha])=>name.startsWith('producer:')&&sha===value),`Historical drain producer missing: ${k}`);provenance(value,depth+1);}
  }
  for(const p of [packet,review,geometry,reproduction,...Object.values(proofs),replay,rayReplay])provenance(p);
  const manifest=(w:InheritedHeightWorld)=>json({file:sourceFile(w.directory,'manifest.json'),sha256:w.manifestSha256}) as WorldManifest,om=manifest(context.originalWorld),cm=manifest(context.currentWorld);
  const payload=(w:InheritedHeightWorld,ref:{path:string;sha256:string;bytes:number})=>decodeDeliverySimulation(checked({file:sourceFile(w.directory,ref.path),sha256:ref.sha256,bytes:ref.bytes},64*1024*1024,true)!,ref);
  assert.equal(hash(decodeRoadGraph(payload(context.originalWorld,om.roads))),hash(context.original),'Drain authority requires actual ORIGINAL graph');assert.equal(hash(decodeRoadGraph(payload(context.currentWorld,cm.roads))),hash(context.current),'Drain authority requires actual CURRENT graph');
  const additions=[];for(const kind of ['nodes','lanes','connectors','footways','parking']as const){const ids=new Set(context.original[kind].map(r=>r.id));for(const r of context.current[kind])if(!ids.has(r.id))additions.push({kind,id:r.id,sha256:hash(r)});}assert.equal(additions.length,43);assert.deepEqual(additions,packet.retainedCurrentAdditions);
  for(const[w,m]of [[context.originalWorld,om],[context.currentWorld,cm]]as const){payload(w,m.terrain);payload(w,m.gameplay);}
  const bundles=new Map<string,ReturnType<typeof parseCollisionBundle>>(),cellHashes=new Map<string,string>();let decoded=0;
  function cells(w:InheritedHeightWorld,m:WorldManifest,pins:any[]){assert.ok(pins.length>0&&pins.length<=64);for(const p of pins){const id=p.cell??p.id,key=w.manifestSha256+':'+id,signature=hash({id,stored:p.storedSha256,decoded:p.decodedSha256,bytes:p.decodedBytes});if(cellHashes.has(key)){assert.equal(cellHashes.get(key),signature);continue;}
    const c=m.cells.find(c=>c.id===id);assert.ok(c);assert.equal(c.collision.sha256,p.storedSha256);const bytes=payload(w,c.collision);decoded+=bytes.length;assert.ok(decoded<=512*1024*1024);assert.equal(sourceSha256(bytes),p.decodedSha256);assert.equal(bytes.length,p.decodedBytes);const b=parseCollisionBundle(bytes);assert.equal(b.header.cell,id);assert.equal(b.header.originId,m.origin.id);bundles.set(key,b);cellHashes.set(key,signature);
  }}
  function literalFace(f:any){const match=/^(?:serialized:)?(c_[mp]\d+_[mp]\d+):(.+):(\d+)$/.exec(f.id);assert.ok(match);const b=bundles.get(CURRENT+':'+match[1]);assert.ok(b);const c=b.colliders.find(c=>c.id===match[2]);assert.ok(c&&c.group==='ground');const t=Number(match[3]);assert.ok(t>=0&&t<c.indices.length/3);const points=[0,1,2].map(k=>Array.from(c.positions.subarray(c.indices[t*3+k]!*3,c.indices[t*3+k]!*3+3)));assert.deepEqual(points,f.points,'Literal drain floor changed');assert.equal(b.header.surfaceTags[c.triangleTags[t]!],f.tag);}
  const records:Footway[]=[],witnesses:InheritedBundleWitness[]=[],parts=new Map<string,LocalPolygon[]>(),sourceWitnesses=new Map<string,object>();let samples=0,ticks=0,rays=0,sourceFailures=0;
  for(let i=0;i<IDS.length;i++){
    const c=packet.cases[i],s=source.results[i],witness={kind:'footways' as const,id:IDS[i]!,beforeSha256:BEFORE[i]!,afterSha256:AFTER[i]!};assert.deepEqual(approval.records[i],witness);assert.equal(hash(c.before),witness.beforeSha256);assert.equal(hash(c.after),witness.afterSha256);
    const metadata=(r:Footway)=>{const{points,...rest}=r;return rest;};assert.deepEqual(metadata(c.before),metadata(c.after));assertHorizontalSubdivision(c.before.points,c.after.points);
    const proposed=proposal.results.find((r:any)=>r.id===c.id);assert.ok(proposed);assert.deepEqual(proposed.original,c.before);assert.deepEqual(proposed.proposed,c.after);assert.deepEqual(s,c.reviewedClippedDrainSourceEligibility);assert.deepEqual(s.original,c.before);assert.deepEqual(s.proposed,c.after);assert.equal(hash(s.way),c.sourceWaySha256);assert.equal(s.sourceWaySha256,c.sourceWaySha256);assert.deepEqual(s.way.tags,c.sourceTags);
    cells(context.originalWorld,om,c.oldAndCurrentFloor.original);cells(context.currentWorld,cm,c.oldAndCurrentFloor.current);cells(context.currentWorld,cm,s.floor.cells);
    for(const proof of[proofs.dynamics,proofs.arithmetic,replay,rayReplay]){const q=proof.cases.find((r:any)=>r.id===c.id);assert.ok(q);cells(context.currentWorld,cm,q.cells);if(q.raw)raw(q.raw);if(q.runs)for(const run of q.runs){raw(run.before.trace);raw(run.after.trace);}}
    assert.equal(c.physical.radius,.38);assert.ok(c.physical.maxHeightDeviation<.2);assert.deepEqual(c.physical.failureCounts,{source:i?4:124});assert.equal(c.physical.failureCount,i?4:124);assert.equal(c.physical.failures.length,Math.min(32,c.physical.failureCount));samples+=c.physical.samples;sourceFailures+=c.physical.failureCount;
    assert.equal(c.nativeRuns.length,6);for(const run of c.nativeRuns){assert.equal(run.exactTracePreserved,true);assert.equal(run.before.trace.decodedSha256,run.after.trace.decodedSha256);for(const side of[run.before,run.after]){assert.equal(side.status,'PASS');assert.equal(side.reached,true);for(const k of['missing','terrainCount','nonPublic','maskFailures'])assert.equal(side[k],0);raw(side.trace);}ticks+=run.after.ticks;}
    assert.ok(c.raySummary.maximumTOIResidualUlps<=4);rays+=c.raySummary.rayPairs;raw(c.raySummary.raw);assert.equal(c.placementSummary.previouslyValidRejected,0);
    const role=approval.clippedSourceRoles[i];assert.equal(role.recordId,c.id);assert.equal(s.drain.id,i?'461266':'174450');assert.equal(role.drainPartId,s.drain.id);assert.equal(role.drainPartSha256,s.drain.sha256);assert.equal(s.drain.properties.paatyyppi,'Varusteet');assert.equal(s.drain.properties.alatyyppi,'Pintavesikourut');
    assert.deepEqual(role.nativeFaces,s.nativeFaces);assert.equal(s.nativeFaces.length,i?11:2);s.nativeFaces.forEach(literalFace);assert.equal(s.corridor.radius,.56);assert.equal(role.continuousSourceAndMaskRadius,.53);assert.ok(s.continuousCapsule.every((v:any)=>v.source&&v.mask));assert.deepEqual(s.uncovered,[]);assert.deepEqual(s.missingFloor,[]);
    const projected=s.drain.rings.map((r:Ring)=>r.map(([x,y])=>[x,-y]as[number,number]));assert.deepEqual(pc.intersection(s.corridor.polygons,[projected]),s.clippedDrain,'Drain clipping changed');
    const floorPolygons=s.nativeFaces.map((f:any)=>[[f.points.map((p:number[])=>[p[0],p[2]])]]) as pc.MultiPolygon[];
    const floorUnion=pc.union(floorPolygons[0]!,...floorPolygons.slice(1));assert.deepEqual(pc.difference(s.clippedDrain,floorUnion),[],'Drain crossing lacks whole native floor');
    const clipped:LocalPolygon[]=s.clippedDrain.map((polygon:number[][][])=>{const rings=polygon.map(r=>r.map(p=>[p[0]!,-p[1]!]as[number,number]));return{id:s.drain.id,rings,bbox:bbox(rings),properties:structuredClone(s.drain.properties)};});
    for(const failed of c.physical.failures)assert.ok(clipped.some(p=>pointInPolygon([failed.point[0],-failed.point[2]],p.rings)),'Unlisted failed source probe');
    parts.set(c.id,clipped);sourceWitnesses.set(c.id,{kind:'literal-record-clipped-public-drain-crossing',recordId:c.id,recordSha256:hash(c.after),sourceWaySha256:c.sourceWaySha256,sourcePins:SOURCE,sourcePartId:s.drain.id,originalPartSha256:s.drain.sha256,originalSubtype:'Pintavesikourut',clippedGeometrySha256:hash(s.clippedDrain),nativeFaces:s.nativeFaces.map((f:any)=>({id:f.id,sha256:f.sha256})),manifestSha256:CURRENT,approvalSha256:INHERITED_WALKING_DRAINS_APPROVAL_SHA256,rawOrdinarySourceFailuresRetained:c.physical.failureCount,sourceEligibilityOnly:true,noMotorAuthority:true});
    records.push(structuredClone(c.after));witnesses.push(witness);
  }
  assert.deepEqual({samples,ticks,rays,sourceFailures},{samples:12045,ticks:3724,rays:620,sourceFailures:128});
  assert.deepEqual(approval.numericDisposition.certificates,ties.certificates);assert.equal(ties.certificates.length,2);ties.actualFaces.forEach(literalFace);
  for(const e of ties.certificates){assert.equal(e.pointFloat32[1],768);assert.deepEqual(e.pointFloat32,[Math.fround(e.before.x),Math.fround(e.before.z)]);assert.equal(e.before.x,e.after.x);assert.equal(e.before.z,e.after.z);assert.ok(e.before.residualUlp<=4&&e.after.residualUlp<=4);assert.ok(e.returnedHeightDifference<=e.checkedArithmeticBound);}
  assert.equal(approval.newlyValidPlacements.length,1);assert.equal(approval.newlyValidPlacements[0].recordId,IDS[1]);assert.equal(approval.newlyValidPlacements[0].count,74);assert.deepEqual(packet.cases[1].raySummary.newlyValid.map((v:any)=>v.station),approval.newlyValidPlacements[0].stations);assert.deepEqual(packet.cases[0].raySummary.newlyValid,[]);
  const verifyInputs=()=>{for(const v of inputs.values())checked(v.pin,v.cap,false,false);};
  const edgeDisposition={schemaVersion:1,kind:'literal-two-drain-shared-edge-ray-disposition',approvalSha256:INHERITED_WALKING_DRAINS_APPROVAL_SHA256,recordId:IDS[0]!,edgeBatchSha256:hash(ties.certificates),ordinaryStrictRayIdentityFailuresRetained:2,sameNormalClaim:false,noGenericRayTolerance:true};
  const b:Bound={originalHash:hash(context.original),currentHash:hash(context.current),currentWorld:structuredClone(context.currentWorld),records,witnesses,parts,sourceWitnesses,edgeBatch:structuredClone(ties.certificates),edgeDisposition,verifyInputs};
  const authority=Object.freeze({})as ReviewedInheritedWalkingDrainsAuthority;authorities.set(authority,b);
  const receipt={schemaVersion:1,kind:'literal-reviewed-inherited-walking-drains',approvalSha256:INHERITED_WALKING_DRAINS_APPROVAL_SHA256,packetSha256:PACKET,provenanceArchiveSha256:ARCHIVE,originalManifestSha256:ORIGINAL,currentManifestSha256:CURRENT,originalGraphSha256:b.originalHash,currentGraphSha256:b.currentHash,currentAdditionsPreserved:43,witnesses:structuredClone(witnesses),physical:{samples,bodyFailures:0,heightToleranceMetres:.2,rawOrdinarySourceFailuresRetained:128,noLegacyFloorException:true},finiteRegression:{pairedScenarios:12,ticks,rays,exactNativeTrajectory:true},sourceRoles:[...sourceWitnesses.values()].map(v=>structuredClone(v)),edgeDisposition:structuredClone(edgeDisposition),newlyValidPlacements:approval.newlyValidPlacements.map((v:any)=>({recordId:v.recordId,count:v.count,stations:structuredClone(v.stations),rawRayProofSha256:v.rawRayProof.sha256,scope:v.scope}))};
  return{authority,...inheritedWalkingDrainBaselines(authority,context.original,context.current,context.otherRegistrationIds),witnesses:structuredClone(witnesses),receipt,verifyInputs};
}

export function inheritedWalkingDrainBaselines(authority:ReviewedInheritedWalkingDrainsAuthority,original:RoadGraph,current:RoadGraph,otherRegistrationIds:readonly string[]){
  const b=required(authority);assertInheritedBundleDisjoint(otherRegistrationIds,IDS);assertBoundedInheritedGraph(original);assertBoundedInheritedGraph(current);assert.equal(hash(original),b.originalHash,'Drain authority belongs to another ORIGINAL graph');assert.equal(hash(current),b.currentHash,'Drain authority belongs to another CURRENT graph');
  const corrected=(g:RoadGraph):RoadGraph=>({...structuredClone(g),footways:g.footways.map(r=>structuredClone(b.records.find(a=>a.id===r.id)??r))});return{originalBaseline:corrected(original),currentBaseline:corrected(current)};
}
export function assertReviewedInheritedWalkingDrainAfter(authority:ReviewedInheritedWalkingDrainsAuthority,record:Footway,otherRegistrationIds:readonly string[]){
  const b=required(authority);assertInheritedBundleDisjoint(otherRegistrationIds,IDS);const witness=b.witnesses.find(w=>w.id===record.id);assert.ok(witness,'Unlisted inherited drain record');assert.equal(hash(record),witness.afterSha256,'Exact reviewed drain AFTER required');return structuredClone(witness);
}
/** Eligibility is limited by the returned literal polygons, not by a subtype or
 * whole source feature. Ordinary source-distance/mask/HCOL checks still run. */
export function qualifyReviewedInheritedWalkingDrainSources(authority:ReviewedInheritedWalkingDrainsAuthority,input:{record:Footway;currentWorld:InheritedHeightWorld;sourcePins:InheritedHeightContext['sourcePins'];otherRegistrationIds:readonly string[]}){
  const b=required(authority);assertReviewedInheritedWalkingDrainAfter(authority,input.record,input.otherRegistrationIds);assert.deepEqual(input.sourcePins,SOURCE);assert.equal(input.currentWorld.manifestSha256,CURRENT);assert.equal(fs.realpathSync(input.currentWorld.directory),fs.realpathSync(b.currentWorld.directory),'Drain source role belongs to another floor');b.verifyInputs();
  return{parts:structuredClone(b.parts.get(input.record.id)!),sourceWitnesses:structuredClone(b.sourceWitnesses.get(input.record.id)!)};
}
/** The exact observational two-edge batch only. It does not make the original
 * identity/normal comparison pass and cannot authorize an arbitrary ray tie. */
export function qualifyReviewedInheritedWalkingDrainEdges(authority:ReviewedInheritedWalkingDrainsAuthority,input:{record:Footway;certificates:readonly unknown[];otherRegistrationIds:readonly string[]}){
  const b=required(authority);assertReviewedInheritedWalkingDrainAfter(authority,input.record,input.otherRegistrationIds);assert.equal(input.record.id,IDS[0]);assert.ok(Array.isArray(input.certificates)&&input.certificates.length===2);assert.deepEqual(input.certificates,b.edgeBatch,'Complete exact drain edge batch required');b.verifyInputs();return structuredClone(b.edgeDisposition);
}

