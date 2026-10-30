import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {decodeRoadGraph, parseCollisionBundle, type RoadGraph, type RoadLane, type WorldManifest} from '../../../packages/world-schema/src/index.ts';
import {verifyInheritedHeightWorldCompatibility} from './inherited-height-world-compatibility.ts';
import {decodeDeliverySimulation} from './delivery-city-payloads.ts';
import {sourceFile, sourceSha256} from './source-files.ts';
import {assertHorizontalSubdivision} from './road-horizontal-subdivision.ts';
import type {InheritedHeightContext, InheritedHeightPin, InheritedHeightWorld} from './reviewed-inherited-road-height.ts';

const ORIGINAL='0e18e55e8730f01144eef72a80decffbb53cdd658222f87a7e8ad6f75f2c4260';
const CURRENT='fe78e6a00102dc33f80c9685b1b204465c2d21e5d470ef20586ca1dddd3817c2';
const SOURCE={osmSha256:'a6bf71bae890ab60b4249c8546e6b7185ce37c9ede4137e9c4aefbd9a755e65a',streetPartsSha256:'1ac1409cf70cd6c3ad1ab7139fd6f365898d5c654e499616a1892d1b669645b2'};
const ROLES={
  driving:{approval:'9b52a5264dbc681205d20f58db604ee01dbf8a9f6bce327022d27d0dc58b2f3e',packet:'94b8e639f15725a20291a91eec2105c3c29df350032a0e35ed45bfec8a0b29d5',review:'10b98901ffc17879a8427d88af4efd6f9319bae6054ff23c3949f70fc164ab75',archive:'6d4e8031bbcef0f7cfabc884510102d454b1cddc698e4dfcf73bde3f6018de5c',archiveCount:49,kind:'lanes' as const,approvalKind:'literal-eight-inherited-driving-height-metadata-approval',ids:['9776916:0:f0','9776916:0:b0','86533504:0:f1','86533504:0:f2','4236417:0:f0','80715855:0:f0','80715855:0:b0','123813196:0:f0']},
  walking:{approval:'2753379290b26347b16ededfddbe1751718ba2335fa8787f0d68f57f96581860',packet:'8c782bdf17e482ab337c962f3183fe8d158093d504f2aec12ecaa31f048a51f4',review:'eabe77cc5a6c478c7ec81f0f4359752502789bb16a50d45c3b3644b796468a26',archive:'104481b596d0184861eaa6f5adb288a6742149299affa601e6cb7683109f8253',archiveCount:58,kind:'footways' as const,approvalKind:'literal-seven-inherited-walking-height-metadata-approval',ids:['w28692747','w86356194','w37282867','w86597184','w123812236','w123812246','w618189329']},
};
export const inheritedBundleHash=(value:unknown)=>sourceSha256(JSON.stringify(value));
type BundleRecord=RoadLane|RoadGraph['footways'][number];
export interface InheritedBundleWitness {kind:'lanes'|'footways';id:string;beforeSha256:string;afterSha256:string}

export function assertInheritedBundleDisjoint(ids:readonly string[],ownIds:readonly string[]){
  assert.ok(Array.isArray(ids)&&ids.length<=10000&&ids.every(id=>typeof id==='string'&&id.length>0&&id.length<=200));
  assert.equal(new Set(ids).size,ids.length,'Duplicate registration identity');
  assert.ok(ids.every(id=>!ownIds.includes(id)),'Inherited height overlaps another registration');
}
export function assertBoundedInheritedGraph(graph:RoadGraph){
  assert.equal(graph?.schemaVersion,2);let points=0;
  for(const kind of ['nodes','lanes','connectors','footways','parking']as const){
    assert.ok(Array.isArray(graph[kind])&&graph[kind].length<=100000);
    const ids=new Set<string>();for(const r of graph[kind]){
      assert.ok(typeof r.id==='string'&&r.id.length<=200&&!ids.has(r.id),'Duplicate graph identity');ids.add(r.id);
      if('points'in r){assert.ok(Array.isArray(r.points)&&r.points.length<=100000);points+=r.points.length;assert.ok(points<=2_000_000);}
    }
  }
}
/** No authority is created here. This reader accepts only two sealed approval
 * identities; the separate driving and walking modules issue distinct tokens. */
export function readClosedInheritedHeightEvidence(role:'driving'|'walking',approvalPin:InheritedHeightPin,context:InheritedHeightContext){
  assert.ok(role==='driving'||role==='walking','Unknown closed inherited-height role');const policy=ROLES[role];
  assert.equal(approvalPin.sha256,policy.approval,'Unapproved inherited-height bundle');
  assert.equal(context.provenanceArchive.sha256,policy.archive,'Unapproved historical provenance mapping');
  assert.equal(context.originalWorld.manifestSha256,ORIGINAL);
  assert.deepEqual(context.sourcePins,SOURCE);assertInheritedBundleDisjoint(context.otherRegistrationIds,policy.ids);
  assertBoundedInheritedGraph(context.original);assertBoundedInheritedGraph(context.current);
  const ledger=new Map<string,{pin:InheritedHeightPin;cap:number}>();let uniqueBytes=0;
  function checked(pin:InheritedHeightPin,cap=16*1024*1024,retain=false,remember=true):Buffer|undefined{
    assert.ok(pin&&typeof pin.file==='string'&&pin.file.length>0&&pin.file.length<=4096);assert.match(pin.sha256,/^[a-f0-9]{64}$/);
    assert.deepEqual(Object.keys(pin).sort(),(pin.bytes===undefined?['file','sha256']:['file','sha256','bytes']).sort());
    const file=sourceFile(path.dirname(pin.file),path.basename(pin.file)),key=fs.realpathSync(file),known=ledger.get(key);
    if(known)assert.equal(known.pin.sha256,pin.sha256,'One input has conflicting identities');
    const fd=fs.openSync(file,'r');try{
      const before=fs.fstatSync(fd);assert.ok(before.isFile()&&before.size>0&&before.size<=cap,'Inherited input byte limit exceeded');
      if(pin.bytes!==undefined)assert.equal(before.size,pin.bytes,'Inherited input byte length changed');
      if(remember&&!known){uniqueBytes+=before.size;assert.ok(uniqueBytes<=1024*1024*1024&&ledger.size<2048,'Inherited evidence budget exceeded');}
      const digest=createHash('sha256'),chunk=Buffer.allocUnsafe(65536),pieces:Buffer[]=[];let size=0;
      for(;;){const n=fs.readSync(fd,chunk,0,chunk.length,null);if(!n)break;size+=n;assert.ok(size<=cap);digest.update(chunk.subarray(0,n));if(retain)pieces.push(Buffer.from(chunk.subarray(0,n)));}
      const after=fs.fstatSync(fd);assert.equal(size,before.size);assert.equal(after.size,before.size);assert.equal(after.mtimeMs,before.mtimeMs);
      assert.equal(digest.digest('hex'),pin.sha256,'Approved inherited-height input changed');
      if(remember)ledger.set(key,{pin:{...structuredClone(pin),file,bytes:before.size},cap});
      return retain?Buffer.concat(pieces,size):undefined;
    }finally{fs.closeSync(fd);}
  }
  const json=(pin:InheritedHeightPin,cap=16*1024*1024):any=>JSON.parse(checked(pin,cap,true)!.toString());
  const compatibility=verifyInheritedHeightWorldCompatibility(context.worldCompatibility,context.currentWorld,context.current,approvalPin.sha256,checked);
  const approval=json(approvalPin,65536);assert.equal(approval.kind,policy.approvalKind);
  assert.equal(approval.packet.sha256,policy.packet);assert.equal(approval.independentReview.sha256,policy.review);assert.equal(approval.provenanceArchive.sha256,policy.archive);
  const packet=json(approval.packet),independent=json(approval.independentReview),mapping=json(context.provenanceArchive,2*1024*1024);
  assert.deepEqual(packet.cases.map((c:any)=>c.id),policy.ids);assert.deepEqual(approval.records.map((c:any)=>c.id),policy.ids);
  assert.equal(packet.originalWorld.manifestSha256,ORIGINAL);assert.equal(packet.currentWorld.manifestSha256,CURRENT);
  assert.equal(mapping.packetSha256,policy.packet);assert.equal(mapping.independentReviewSha256,policy.review);assert.equal(mapping.files.length,policy.archiveCount);
  const archived=new Map<string,string>();for(const p of mapping.files){
    assert.ok(p.kind==='source'||p.kind==='producer');const key=p.kind+':'+p.name;assert.ok(!archived.has(key));archived.set(key,p.sha256);
    checked({file:sourceFile(path.dirname(context.provenanceArchive.file),p.path),sha256:p.sha256,bytes:p.bytes},4*1024*1024);
  }
  const proofEntries=Object.entries(packet.proofs)as [string,InheritedHeightPin][];assert.ok(proofEntries.length<=8);
  const proofs:any=Object.fromEntries(proofEntries.map(([key,pin])=>[key,json(pin)]));
  const proposal=proofs.proposal??proofs.proposals;assert.deepEqual(proposal.sourcePins,SOURCE);assert.equal(proposal.current.manifestSha256,CURRENT);assert.equal(proposal.original.manifestSha256,ORIGINAL);
  json(proposal.census);
  if(role==='driving')proofs.rawDynamicsSummary=json(proofs.dynamics.input);
  else{proofs.independentReplay=json(independent.replay);proofs.independentRays=json(independent.rayReplay);}
  assert.equal(packet.sourceInputs.length,2);assert.deepEqual(packet.sourceInputs.map((p:any)=>p.sha256).sort(),Object.values(SOURCE).sort());
  for(const pin of packet.sourceInputs)checked(pin,64*1024*1024);
  const mask=json(packet.mask);assert.equal(proposal.maskSha256,packet.mask.sha256);
  assert.ok(Array.isArray(mask.sourceFiles)&&mask.sourceFiles.length<=64);
  for(const p of mask.sourceFiles)checked({file:p.path,sha256:p.sha256,bytes:p.bytes},64*1024*1024);
  // Compare archived historical source closures, never today's evolved files.
  // Only compact approved JSON is traversed; raw traces remain streamed hashes.
  let visited=0;function provenance(value:any,depth=0){
    assert.ok(depth<=64&&++visited<=1_000_000,'Inherited compact evidence bound exceeded');
    if(typeof value==='number'){assert.ok(Number.isFinite(value),'Nonfinite compact regression value');return;}
    if(!value||typeof value!=='object')return;
    if(value.files&&!Array.isArray(value.files)&&typeof value.files==='object')for(const[name,sha]of Object.entries(value.files))assert.equal(archived.get('source:'+name),sha,'Historical source closure missing');
    for(const[key,v]of Object.entries(value)){
      if(key==='producerSha256'||key==='reviewerSha256')assert.ok([...archived].some(([name,sha])=>name.startsWith('producer:')&&sha===v),'Historical producer missing');
      provenance(v,depth+1);
    }
  }
  for(const v of [packet,independent,...Object.values(proofs)])provenance(v);
  if(independent.reviewer?.sha256)assert.ok([...archived].some(([key,sha])=>key.startsWith('producer:')&&sha===independent.reviewer.sha256));
  const manifest=(world:InheritedHeightWorld)=>json({file:sourceFile(world.directory,'manifest.json'),sha256:world.manifestSha256})as WorldManifest;
  const om=manifest(context.originalWorld),cm=manifest(context.currentWorld);
  const payload=(world:InheritedHeightWorld,ref:{path:string;sha256:string;bytes:number})=>decodeDeliverySimulation(checked({file:sourceFile(world.directory,ref.path),sha256:ref.sha256,bytes:ref.bytes},64*1024*1024,true)!,ref);
  assert.equal(inheritedBundleHash(decodeRoadGraph(payload(context.originalWorld,om.roads))),inheritedBundleHash(context.original),'Authority requires actual ORIGINAL graph');
  assert.equal(inheritedBundleHash(decodeRoadGraph(payload(context.currentWorld,cm.roads))),inheritedBundleHash(context.current),'Authority requires actual CURRENT graph including additions');
  const additions=[];for(const kind of ['nodes','lanes','connectors','footways','parking']as const){const oldIds=new Set(context.original[kind].map(r=>r.id));for(const r of context.current[kind])if(!oldIds.has(r.id))additions.push({kind,id:r.id,sha256:inheritedBundleHash(r)});}
  assert.equal(additions.length,43);assert.deepEqual(additions,packet.retainedCurrentAdditions);
  // Full gameplay/terrain pins protect the approved resolver definitions and
  // native ray context, even when a local cropped terrain was used by a replay.
  for(const[world,m]of [[context.originalWorld,om],[context.currentWorld,cm]]as const){payload(world,m.gameplay);payload(world,m.terrain);}
  const loadedCells=new Map<string,string>();let decodedBytes=0;
  function checkCells(world:InheritedHeightWorld,m:WorldManifest,pins:any[]){
    assert.ok(Array.isArray(pins)&&pins.length>0&&pins.length<=64&&new Set(pins.map(p=>p.cell??p.id)).size===pins.length);
    for(const p of pins){const id=p.cell??p.id,key=world.manifestSha256+':'+id,signature=inheritedBundleHash({id,stored:p.storedSha256,decoded:p.decodedSha256,bytes:p.decodedBytes});
      if(loadedCells.has(key)){assert.equal(loadedCells.get(key),signature,'Conflicting local floor identity');continue;}
      const cell=m.cells.find(c=>c.id===id);assert.ok(cell,'Required native floor missing');assert.equal(cell.collision.sha256,p.storedSha256);
      const bytes=payload(world,cell.collision);decodedBytes+=bytes.length;assert.ok(decodedBytes<=512*1024*1024);assert.equal(sourceSha256(bytes),p.decodedSha256);assert.equal(bytes.length,p.decodedBytes);
      const bundle=parseCollisionBundle(bytes);assert.equal(bundle.header.cell,id);assert.equal(bundle.header.originId,m.origin.id);loadedCells.set(key,signature);
    }
  }
  const raw=(p:any)=>checked({file:p.file,sha256:p.storedSha256??p.sha256},32*1024*1024);
  const witnesses:InheritedBundleWitness[]=[],afterRecords:BundleRecord[]=[];let samples=0,nominal=0,pairs=0,ticks=0,rays=0;
  for(const c of packet.cases){
    const witness=approval.records.find((r:any)=>r.id===c.id);assert.deepEqual(witness,{kind:policy.kind,id:c.id,beforeSha256:c.beforeSha256,afterSha256:c.afterSha256});
    assert.equal(inheritedBundleHash(c.before),c.beforeSha256);assert.equal(inheritedBundleHash(c.after),c.afterSha256);
    for(const graph of[context.original,context.current])assert.equal(inheritedBundleHash(graph[policy.kind].find(r=>r.id===c.id)),c.beforeSha256,'Inherited before record changed');
    const metadata=(r:BundleRecord)=>{const{points,...rest}=r;return rest;};assert.deepEqual(metadata(c.before),metadata(c.after));assertHorizontalSubdivision(c.before.points,c.after.points);
    const proposed=proposal.results.find((r:any)=>r.id===c.id);assert.ok(proposed);assert.deepEqual(proposed.original,c.before);assert.deepEqual(proposed.proposed,c.after);assert.equal(proposed.sourceWaySha256,c.sourceWaySha256);assert.deepEqual(proposed.sourceTags,c.sourceTags);assert.deepEqual(proposed.partIds,c.sourcePartIds);
    assert.equal(proposed.metadataUnchanged,true);assert.equal(proposed.piecewiseXZPreserved,true);
    assert.deepEqual(proposed.sourceFloorCells,c.oldAndCurrentFloor);checkCells(context.originalWorld,om,c.oldAndCurrentFloor.original);checkCells(context.currentWorld,cm,c.oldAndCurrentFloor.current);
    const dynamics=proofs.dynamics.cases.find((r:any)=>r.id===c.id),arithmetic=(proofs.rays??proofs.arithmetic).cases.find((r:any)=>r.id===c.id);assert.ok(dynamics&&arithmetic);
    assert.equal(dynamics.originalRecordSha256,c.beforeSha256);assert.equal(dynamics.proposedRecordSha256,c.afterSha256);checkCells(context.currentWorld,cm,dynamics.cells);checkCells(context.currentWorld,cm,arithmetic.cells);
    assert.deepEqual(arithmetic.failed,[]);assert.ok(Number.isFinite(arithmetic.maximumTOIResidualUlps)&&arithmetic.maximumTOIResidualUlps<=4);rays+=arithmetic.rayPairs;raw(arithmetic.raw);
    if(role==='driving'){
      assert.equal(c.physical.heightTolerance,.2);assert.equal(c.physical.failedBodySamples,0);assert.ok(c.physical.maximumHeightDeviation<.2);samples+=c.physical.samples;nominal+=c.physical.failedNominalEdgeSamples;
      assert.equal(arithmetic.sameColliderLiteralFaceClosureNormalXZHeading,true);assert.equal(c.nativeRuns.length,18);
      for(const run of c.nativeRuns){assert.equal(run.exactNativePoseRotationSpeedTyreAndUndersideTrajectoryPreserved,true);assert.equal(run.zeroContactTicks,0);assert.equal(run.terrainContacts,0);assert.ok(run.minimumOrientedUndersideClearance>0);assert.equal(run.rawPair.length,2);for(const pin of run.rawPair)raw(pin);pairs++;ticks+=run.ticks;}
    }else{
      assert.equal(c.physical.failureCount,0);assert.deepEqual(c.physical.failureCounts,{});assert.deepEqual(c.physical.failures,[]);assert.equal(c.physical.radius,.38);assert.ok(c.physical.maxHeightDeviation<.2);samples+=c.physical.samples;
      assert.equal(arithmetic.sameColliderLiteralFaceClosureNormalXZ,true);assert.equal(arithmetic.actualPedestrianGroundResultsReproduced,true);assert.equal(c.nativeRuns.length,6);
      for(const run of c.nativeRuns){assert.equal(run.exactTracePreserved,true);for(const side of[run.before,run.after]){assert.equal(side.status,'PASS');assert.equal(side.reached,true);for(const field of['missing','terrainCount','nonPublic','maskFailures'])assert.equal(side[field],0);raw(side.trace);}assert.equal(run.before.trace.decodedSha256,run.after.trace.decodedSha256);pairs++;ticks+=run.after.ticks;}
      for(const proof of[proofs.independentReplay,proofs.independentRays]){const selected=proof.cases.find((r:any)=>r.id===c.id);assert.ok(selected);checkCells(context.currentWorld,cm,selected.cells);if(selected.raw)raw(selected.raw);else for(const run of selected.runs){raw(run.before.trace);raw(run.after.trace);}}
    }
    witnesses.push(structuredClone(witness));afterRecords.push(structuredClone(c.after));
  }
  if(role==='driving'){
    assert.deepEqual({samples,nominal,pairs,ticks,rays},{samples:487202,nominal:349,pairs:144,ticks:57983,rays:12321});
    assert.equal(independent.checks.verifiedPhysicalTicks,ticks);assert.equal(independent.checks.verifiedActualNativeFaceRayPairs,rays);
    assert.equal(proofs.dynamics.summary.allActualNativePosesContactsAndClearancesBitIdentical,true);assert.equal(proofs.dynamics.summary.differentFloat32SteeringValues,192);
    assert.equal(proofs.dynamics.summary.maximumDoubleSteeringDifference,3.2518215550836338e-12);
  }else{
    assert.deepEqual({samples,pairs,ticks,rays},{samples:50193,pairs:42,ticks:15596,rays:4005});
    assert.equal(independent.counts.witnessCount,3824);assert.equal(independent.counts.rayPairs,rays);
    const changes=packet.cases.flatMap((c:any)=>c.raySummary.newlyValid.map((p:any)=>({id:c.id,station:typeof p==='number'?p:p.station})));
    assert.deepEqual(changes,approval.newlyValidPlacements.stations.map((station:number)=>({id:'w86356194',station})));
  }
  return{kind:policy.kind,ids:[...policy.ids],afterRecords,witnesses,originalHash:inheritedBundleHash(context.original),currentHash:inheritedBundleHash(context.current),
    receipt:{schemaVersion:1,kind:`literal-reviewed-inherited-${role}-height`,approvalSha256:policy.approval,packetSha256:policy.packet,independentReviewSha256:policy.review,provenanceArchiveSha256:policy.archive,originalManifestSha256:ORIGINAL,currentManifestSha256:context.currentWorld.manifestSha256,...(compatibility?{historicalEvidenceManifestSha256:CURRENT,worldCompatibility:compatibility}:{}),originalGraphSha256:inheritedBundleHash(context.original),currentGraphSha256:inheritedBundleHash(context.current),currentAdditionsPreserved:43,witnesses:structuredClone(witnesses),physical:{samples,bodyFailures:0,ordinaryHeightToleranceMetres:.2,nominalDiagnosticsRetained:nominal,noLegacyFloorException:true},finiteRegression:{pairedScenarios:pairs,ticks,rays,fullJavascriptStateExact:role==='walking',steeringArithmeticDifferencesRetained:role==='driving'},numericDisposition:structuredClone(approval.numericDisposition),...(role==='walking'?{newlyValidPlacements:structuredClone(approval.newlyValidPlacements)}:{nativeTrajectoryDisposition:structuredClone(approval.nativeTrajectoryDisposition)})},
    verifyInputs:()=>{for(const item of ledger.values())checked(item.pin,item.cap,false,false);},
  };
}
