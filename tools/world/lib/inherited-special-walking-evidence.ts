import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {decodeRoadGraph,parseCollisionBundle,type RoadGraph,type WorldManifest} from '../../../packages/world-schema/src/index.ts';
import {verifyInheritedHeightWorldCompatibility} from './inherited-height-world-compatibility.ts';
import {decodeDeliverySimulation} from './delivery-city-payloads.ts';
import {sourceFile,sourceSha256} from './source-files.ts';
import {assertHorizontalSubdivision} from './road-horizontal-subdivision.ts';
import {assertBoundedInheritedGraph,assertInheritedBundleDisjoint,inheritedBundleHash as hash} from './inherited-height-bundle-evidence.ts';
import type {InheritedHeightContext,InheritedHeightPin,InheritedHeightWorld} from './reviewed-inherited-road-height.ts';

const ORIGINAL='0e18e55e8730f01144eef72a80decffbb53cdd658222f87a7e8ad6f75f2c4260',CURRENT='fe78e6a00102dc33f80c9685b1b204465c2d21e5d470ef20586ca1dddd3817c2';
const SOURCE={osmSha256:'a6bf71bae890ab60b4249c8546e6b7185ce37c9ede4137e9c4aefbd9a755e65a',streetPartsSha256:'1ac1409cf70cd6c3ad1ab7139fd6f365898d5c654e499616a1892d1b669645b2'};
const ROLES={
  w28842927:{approval:'ae55bc3b80e2ebb70b86b3554a74c5d04809b92f64be74ad94a9aa6c5ecab7c3',packet:'1f914ccd6f668373c262e8431e855765122fb64e820d36f28a54aad6aea729a0',archive:'12b61faf1679c57b522681aeb9ee6555265a3fbe49a4adddb82636e3493c1739',archiveCount:84,before:'d061509dd952151515318b0d94bd4d7e63309df00aec845d060fd64db5e686ef',after:'a700b6b1db7c8dc8d080f346937093ea78f284cb64392317a1a1a18f68b5db22',samples:7392,ticks:2310,rays:600,axisFailures:0},
  w28322529:{approval:'b62e18f313318398293aa583fddff23a4fe29c5906c800bae8ebd7eb5853ca77',packet:'961b1592b8e3b70bcf61bdeb6ca4bf1e757eb6fcaa68839a91ad0fc05f10fb77',archive:'8b796799eda5c8423892a41359766b5dd0ee31c54ff0fe3eed7fae7d48d05417',archiveCount:88,before:'13d15fbf1300d0c8df83f268487055ed355c03ff82ebca127edf74ce9712b35d',after:'ed922b2e6445fe8c6b6ff12fcd05ff496c835ef4b0904d5f7de27d2c668be266',samples:14124,ticks:4115,rays:1005,axisFailures:6},
};

/** Closed evidence reader only; each public constructor owns its own token map.
 * The two literal edge/avoidance dispositions cannot authorize another case. */
export interface SpecialWalkingContext extends InheritedHeightContext {provenanceSupplement?:InheritedHeightPin;worldCompatibility?:InheritedHeightPin}
export function readSpecialWalkingEvidence(id:keyof typeof ROLES,approvalPin:InheritedHeightPin,context:SpecialWalkingContext){
  assert.ok(id==='w28842927'||id==='w28322529','Unapproved special walking identity');const policy=ROLES[id];
  assert.equal(approvalPin.sha256,policy.approval,'Unapproved special walking authority');assert.equal(context.provenanceArchive.sha256,policy.archive,'Unapproved special historical archive');
  assert.equal(context.originalWorld.manifestSha256,ORIGINAL);assert.deepEqual(context.sourcePins,SOURCE);
  assertInheritedBundleDisjoint(context.otherRegistrationIds,[id]);assertBoundedInheritedGraph(context.original);assertBoundedInheritedGraph(context.current);
  for(const g of[context.original,context.current])assert.equal(hash(g.footways.find(r=>r.id===id)),policy.before,'Special walking BEFORE record changed');
  const inputs=new Map<string,{pin:InheritedHeightPin;cap:number}>();let total=0;
  function checked(pin:InheritedHeightPin,cap=16*1024*1024,retain=false,remember=true):Buffer|undefined{
    assert.ok(pin&&typeof pin.file==='string'&&pin.file.length>0&&pin.file.length<=4096);assert.match(pin.sha256,/^[a-f0-9]{64}$/);
    assert.deepEqual(Object.keys(pin).sort(),(pin.bytes===undefined?['file','sha256']:['file','sha256','bytes']).sort());
    const file=sourceFile(path.dirname(pin.file),path.basename(pin.file)),key=fs.realpathSync(file),existing=inputs.get(key);if(existing)assert.equal(existing.pin.sha256,pin.sha256);
    const fd=fs.openSync(file,'r');try{const before=fs.fstatSync(fd);assert.ok(before.isFile()&&before.size>0&&before.size<=cap,'Special walking evidence byte cap exceeded');if(pin.bytes!==undefined)assert.equal(before.size,pin.bytes);
      if(remember&&!existing){total+=before.size;assert.ok(total<=1024*1024*1024&&inputs.size<2048);}
      const digest=createHash('sha256'),chunk=Buffer.allocUnsafe(65536),pieces:Buffer[]=[];let size=0;
      for(;;){const n=fs.readSync(fd,chunk,0,chunk.length,null);if(!n)break;size+=n;assert.ok(size<=cap);digest.update(chunk.subarray(0,n));if(retain)pieces.push(Buffer.from(chunk.subarray(0,n)));}
      const after=fs.fstatSync(fd);assert.equal(size,before.size);assert.equal(after.size,before.size);assert.equal(after.mtimeMs,before.mtimeMs);assert.equal(digest.digest('hex'),pin.sha256,'Approved special walking input changed');
      if(remember)inputs.set(key,{pin:{...structuredClone(pin),file,bytes:size},cap});return retain?Buffer.concat(pieces,size):undefined;
    }finally{fs.closeSync(fd);}
  }
  const json=(p:InheritedHeightPin,cap=16*1024*1024):any=>JSON.parse(checked(p,cap,true)!.toString()),raw=(p:any)=>checked({file:p.file,sha256:p.sha256??p.storedSha256},32*1024*1024);
  const compatibility=verifyInheritedHeightWorldCompatibility(context.worldCompatibility,context.currentWorld,context.current,approvalPin.sha256,checked);
  const approval=json(approvalPin,65536);assert.equal(approval.kind,'literal-special-inherited-walking-height-metadata-approval');assert.equal(approval.packet.sha256,policy.packet);assert.equal(approval.provenanceArchive.sha256,policy.archive);
  const packet=json(approval.packet),sourceReview=json(approval.sourceNativeArithmeticReview),geometryReview=json(approval.independentGeometryReview),reproduction=json(approval.freshNativeAndRayReproduction),mapping=json(context.provenanceArchive,2*1024*1024);
  assert.equal(mapping.packetSha256,policy.packet);assert.equal(mapping.files.length,policy.archiveCount);const archive=new Map<string,string>();
  for(const p of mapping.files){assert.ok(p.kind==='producer'||p.kind==='source');const key=p.kind+':'+p.name;assert.ok(!archive.has(key));archive.set(key,p.sha256);checked({file:sourceFile(path.dirname(context.provenanceArchive.file),p.path),sha256:p.sha256,bytes:p.bytes},4*1024*1024);}
  if(id==='w28322529'){
    assert.ok(context.provenanceSupplement,'Exact executed arithmetic archive supplement required');assert.equal(context.provenanceSupplement.sha256,'6f5c9e8f8657406663864def06a2d7131daaf3581fcaa1297d9d83e3220d6b08');
    const approved=json(context.provenanceSupplement,65536);assert.equal(approved.supplement.sha256,'2617e3666bf94ac9850c3557347469b67aa36b8ae175c02ec3ae1573e07ea8e6');assert.equal(approved.originalApproval.sha256,policy.approval);assert.equal(approved.originalProvenanceMapping.sha256,policy.archive);assert.equal(approved.packet.sha256,policy.packet);
    const supplement=json(approved.supplement,65536);assert.equal(supplement.files.length,1);const p=supplement.files[0];assert.equal(p.kind,'producer');assert.equal(p.sha256,'1e579eb62f4bf72e188a934d4a90f71693be760d173304be4886738a5f542037');assert.equal(p.bytes,9711);checked({file:sourceFile(path.dirname(approved.supplement.file),p.path),sha256:p.sha256,bytes:p.bytes},65536);assert.ok(!archive.has(p.kind+':'+p.name));archive.set(p.kind+':'+p.name,p.sha256);
  }else assert.equal(context.provenanceSupplement,undefined,'Unrelated historical supplement');
  assert.equal(packet.cases.length,1);const c=packet.cases[0];assert.equal(c.id,id);assert.equal(hash(c.before),policy.before);assert.equal(hash(c.after),policy.after);
  const witness={kind:'footways' as const,id,beforeSha256:policy.before,afterSha256:policy.after};assert.deepEqual(approval.records,[witness]);
  const metadata=(r:RoadGraph['footways'][number])=>{const{points,...rest}=r;return rest;};assert.deepEqual(metadata(c.before),metadata(c.after));assertHorizontalSubdivision(c.before.points,c.after.points);
  const proofs:any=Object.fromEntries(Object.entries(packet.proofs).map(([key,pin])=>[key,json(pin as InheritedHeightPin)]));const proposal=proofs.proposal;
  json(proposal.census);assert.deepEqual(proposal.sourcePins,SOURCE);const proposed=proposal.results.find((r:any)=>r.id===id);assert.ok(proposed);assert.deepEqual(proposed.original,c.before);assert.deepEqual(proposed.proposed,c.after);assert.equal(proposed.sourceWaySha256,c.sourceWaySha256);assert.deepEqual(proposed.sourceTags,c.sourceTags);assert.deepEqual(proposed.partIds,c.sourcePartIds);
  assert.equal(packet.sourceInputs.length,2);assert.deepEqual(packet.sourceInputs.map((p:any)=>p.sha256).sort(),Object.values(SOURCE).sort());for(const p of packet.sourceInputs)checked(p,64*1024*1024);
  const mask=json(packet.mask);assert.equal(proposal.maskSha256,packet.mask.sha256);assert.ok(mask.sourceFiles.length<=64);for(const p of mask.sourceFiles)checked({file:p.path,sha256:p.sha256,bytes:p.bytes},64*1024*1024);
  const replay=json(sourceReview.replay),rayReplay=json(sourceReview.rayReplay);assert.equal(sourceReview.target.sha256,policy.packet);
  const extra:any[]=[];if(id==='w28322529')for(const k of['proof','currentAGeometry','independentReproduction','freshCurrentAGeometryReplay'])extra.push(json(approval.currentAAvoidanceDisposition[k]));
  let visited=0;function provenance(v:any,depth=0){assert.ok(depth<=64&&++visited<1_000_000);if(typeof v==='number'){assert.ok(Number.isFinite(v),'Nonfinite special walking evidence');return;}if(!v||typeof v!=='object')return;
    if(v.files&&!Array.isArray(v.files)&&typeof v.files==='object')for(const[name,sha]of Object.entries(v.files))assert.equal(archive.get('source:'+name),sha,'Historical special source missing');
    if(v.reviewer?.sha256)assert.ok([...archive].some(([key,sha])=>key.startsWith('producer:')&&sha===v.reviewer.sha256),'Historical special reviewer missing');
    for(const[k,value]of Object.entries(v)){if(k==='producerSha256'||k==='scriptSha256'||k==='originalScriptSha256')assert.ok([...archive].some(([name,sha])=>name.startsWith('producer:')&&sha===value),`Historical special producer missing: ${k} ${value}`);provenance(value,depth+1);}
  }
  for(const v of[packet,sourceReview,geometryReview,reproduction,proposal,...Object.values(proofs),replay,rayReplay,...extra])provenance(v);
  const manifest=(w:InheritedHeightWorld)=>json({file:sourceFile(w.directory,'manifest.json'),sha256:w.manifestSha256})as WorldManifest,om=manifest(context.originalWorld),cm=manifest(context.currentWorld);
  const payload=(w:InheritedHeightWorld,ref:{path:string;sha256:string;bytes:number})=>decodeDeliverySimulation(checked({file:sourceFile(w.directory,ref.path),sha256:ref.sha256,bytes:ref.bytes},64*1024*1024,true)!,ref);
  assert.equal(hash(decodeRoadGraph(payload(context.originalWorld,om.roads))),hash(context.original),'Special authority requires actual ORIGINAL graph');assert.equal(hash(decodeRoadGraph(payload(context.currentWorld,cm.roads))),hash(context.current),'Special authority requires actual CURRENT graph');
  const additions=[];for(const kind of['nodes','lanes','connectors','footways','parking']as const){const ids=new Set(context.original[kind].map(r=>r.id));for(const r of context.current[kind])if(!ids.has(r.id))additions.push({kind,id:r.id,sha256:hash(r)});}assert.equal(additions.length,43);assert.deepEqual(additions,packet.retainedCurrentAdditions);
  for(const[w,m]of[[context.originalWorld,om],[context.currentWorld,cm]]as const){payload(w,m.terrain);payload(w,m.gameplay);}
  const bundles=new Map<string,ReturnType<typeof parseCollisionBundle>>(),cellHashes=new Map<string,string>();let decoded=0;
  function checkCells(w:InheritedHeightWorld,m:WorldManifest,pins:any[]){assert.ok(pins.length>0&&pins.length<=64);for(const p of pins){const cellId=p.cell??p.id,key=w.manifestSha256+':'+cellId,signature=hash({cellId,stored:p.storedSha256,decoded:p.decodedSha256,bytes:p.decodedBytes});if(cellHashes.has(key)){assert.equal(cellHashes.get(key),signature);continue;}const cell=m.cells.find(v=>v.id===cellId);assert.ok(cell);assert.equal(cell.collision.sha256,p.storedSha256);const bytes=payload(w,cell.collision);decoded+=bytes.length;assert.ok(decoded<=512*1024*1024);assert.equal(sourceSha256(bytes),p.decodedSha256);assert.equal(bytes.length,p.decodedBytes);const bundle=parseCollisionBundle(bytes);assert.equal(bundle.header.cell,cellId);assert.equal(bundle.header.originId,m.origin.id);bundles.set(key,bundle);cellHashes.set(key,signature);}}
  checkCells(context.originalWorld,om,c.oldAndCurrentFloor.original);checkCells(context.currentWorld,cm,c.oldAndCurrentFloor.current);
  for(const proof of[proofs.dynamics,proofs.arithmetic,replay,rayReplay]){const selected=proof.cases.find((r:any)=>r.id===id);assert.ok(selected);checkCells(context.currentWorld,cm,selected.cells);if(selected.raw)raw(selected.raw);if(selected.runs)for(const run of selected.runs){raw(run.before.trace);raw(run.after.trace);}}
  assert.equal(c.physical.failureCount,0);assert.deepEqual(c.physical.failureCounts,{});assert.equal(c.physical.samples,policy.samples);assert.equal(c.physical.radius,.38);assert.ok(c.physical.maxHeightDeviation<.2);assert.equal(c.nativeRuns.length,6);
  let ticks=0,axisFailures=0;for(const run of c.nativeRuns){assert.equal(run.exactTracePreserved,true);assert.equal(run.before.trace.decodedSha256,run.after.trace.decodedSha256);for(const side of[run.before,run.after]){assert.equal(side.reached,true);for(const k of['missing','terrainCount','nonPublic','maskFailures'])assert.equal(side[k],0);assert.equal(side.status,policy.axisFailures?'RETHINK':'PASS');raw(side.trace);}if(run.after.status!=='PASS')axisFailures++;ticks+=run.after.ticks;}
  assert.equal(ticks,policy.ticks);assert.equal(axisFailures,policy.axisFailures);assert.equal(c.raySummary.rayPairs,policy.rays);assert.deepEqual(c.raySummary.newlyValid,[]);assert.ok(c.raySummary.maximumTOIResidualUlps<=4);raw(c.raySummary.raw);
  assert.equal(c.raySummary.failedStrictIdentityProbes.length,1);const edge=approval.exactEdgeDisposition,failed=c.raySummary.failedStrictIdentityProbes[0];assert.deepEqual(failed.before,edge.before);assert.deepEqual(failed.after,edge.after);assert.equal(failed.sameSupportIdentity,false);assert.equal(failed.sameNormal,false);assert.equal(failed.sameLiteralTriangle,false);assert.equal(failed.withinBound,true);
  assert.equal(edge.pointFloat32[1],768);assert.deepEqual(edge.pointFloat32,[Math.fround(edge.before.x),Math.fround(edge.before.z)]);assert.equal(edge.before.x,edge.after.x);assert.equal(edge.before.z,edge.after.z);assert.equal(edge.literalFaces.length,2);
  for(const f of edge.literalFaces){const match=/^(c_[mp]\d+_[mp]\d+):(.+):(\d+)$/.exec(f.id);assert.ok(match);const bundle=bundles.get(context.currentWorld.manifestSha256+':'+match[1]);assert.ok(bundle);const collider=bundle.colliders.find(v=>v.id===match[2]);assert.ok(collider);const triangle=Number(match[3]);assert.equal(triangle,f.triangle);const points=[0,1,2].map(k=>Array.from(collider.positions.subarray(collider.indices[triangle*3+k]!*3,collider.indices[triangle*3+k]!*3+3)));assert.deepEqual(points,f.points,'Literal special edge face changed');assert.equal(bundle.header.surfaceTags[collider.triangleTags[triangle]!],f.tag);}
  assert.deepEqual(approval.retainedFailures,{ordinaryStrictRayResult:'RETHINK_SUPPORT_IDENTITY_OR_ARITHMETIC',ordinaryAxisTrackingFailedRuns:policy.axisFailures});
  if(id==='w28322529'){
    const disposition=approval.currentAAvoidanceDisposition,g=proofs.currentAGeometry;assert.equal(disposition.nativeCapsuleSamples,135795);assert.equal(disposition.structuralCapsuleOverlaps,0);assert.equal(disposition.currentAFloorFacesLiteral,79);assert.equal(disposition.currentACompleteStructuralCollidersLiteral,3);assert.equal(disposition.currentATerrainNodesLiteral,2028);
    assert.equal(g.before.manifestSha256,'b0ca22a67978a6e267b3dd29f402be856393be46298457dd9e51df23ead4842e');const am=manifest(g.before);checkCells(g.before,am,g.cells.before);checkCells(context.currentWorld,cm,g.cells.after);payload(g.before,am.terrain);
    assert.equal(extra[2].allOrdinaryAxisTrackingFailuresRetained,true);assert.equal(g.floorBindings.length,79);assert.equal(g.structures.length,3);assert.equal(g.terrain.values.length,2028);
    // All currentA complete collider bytes are bound through the local HCOL
    // pins above. The sealed Python geometry review checks the literal subsets.
  }
  const disposition={schemaVersion:1,kind:'literal-special-walking-metadata-only-disposition',approvalSha256:policy.approval,packetSha256:policy.packet,record:witness,ordinaryStrictRayResult:'RETHINK_SUPPORT_IDENTITY_OR_ARITHMETIC',ordinaryAxisTrackingFailedRuns:policy.axisFailures,exactEdgeSha256:hash(edge),failedStrictProbeBatchSha256:hash(c.raySummary.failedStrictIdentityProbes),ordinaryAxisRunBatchSha256:hash(c.nativeRuns),noGenericRayOrTrackingTolerance:true,...(id==='w28322529'?{currentAAvoidance:{buildingBID:approval.currentAAvoidanceDisposition.buildingBID,physicalTicks:4115,nativeCapsuleSamples:135795,structuralCapsuleOverlaps:0,ordinaryTrackingFailuresRemainFailed:true}}:{})};
  return{id,after:structuredClone(c.after)as RoadGraph['footways'][number],witness,originalHash:hash(context.original),currentHash:hash(context.current),failedProbes:structuredClone(c.raySummary.failedStrictIdentityProbes),axisRuns:structuredClone(c.nativeRuns),disposition,
    receipt:{schemaVersion:1,kind:'literal-reviewed-inherited-special-walking-height',approvalSha256:policy.approval,packetSha256:policy.packet,provenanceArchiveSha256:policy.archive,...(context.provenanceSupplement?{provenanceSupplementApprovalSha256:context.provenanceSupplement.sha256}:{}),originalManifestSha256:ORIGINAL,currentManifestSha256:context.currentWorld.manifestSha256,historicalEvidenceManifestSha256:CURRENT,...(compatibility?{worldCompatibility:compatibility}:{}),originalGraphSha256:hash(context.original),currentGraphSha256:hash(context.current),currentAdditionsPreserved:43,witness,physical:{samples:policy.samples,failures:0,heightToleranceMetres:.2,pairedTicks:policy.ticks,rayPairs:policy.rays},disposition},
    verifyInputs:()=>{for(const item of inputs.values())checked(item.pin,item.cap,false,false);},
  };
}
