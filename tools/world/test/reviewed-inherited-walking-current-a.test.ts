import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {decodeRoadGraph,type RoadGraph} from '../../../packages/world-schema/src/index.ts';
import {decodeDeliverySimulation} from '../lib/delivery-city-payloads.ts';
import {readSourceFile,sourceSha256} from '../lib/source-files.ts';
import {withCorruptedRead} from './inherited-height-bundle-fixture.ts';
import {CURRENT_A_WALKING_APPROVAL_SHA256,readReviewedInheritedWalkingCurrentA as readAuthority,inheritedWalkingCurrentABaselines as baselines,assertReviewedInheritedWalkingCurrentAAfter as assertAfter,type CurrentAWalkingContext,type ReviewedInheritedWalkingCurrentA as Authority} from '../lib/reviewed-inherited-walking-current-a.ts';

const file='../evidence/inherited-walking-w292-root-approval-v3.json',available=fs.existsSync(file),pin={file,sha256:CURRENT_A_WALKING_APPROVAL_SHA256},ID='w29282225';
const hash=(value:unknown)=>sourceSha256(JSON.stringify(value));
let context:CurrentAWalkingContext,prepared:ReturnType<typeof readAuthority>,approval:any;
function fixture(){if(!context){approval=JSON.parse(fs.readFileSync(file,'utf8'));const graph=(w:{directory:string})=>{const m=JSON.parse(fs.readFileSync(w.directory+'/manifest.json','utf8'));return decodeRoadGraph(decodeDeliverySimulation(readSourceFile(w.directory,m.roads),m.roads));},sourceMask=approval.sourceMaskAmendment.normalizedFinalSourceMask,mask=JSON.parse(fs.readFileSync(sourceMask.file,'utf8'));context={original:graph(approval.originalWorld),current:graph(approval.currentWorld),originalWorld:approval.originalWorld,currentWorld:approval.currentWorld,sourcePins:{osmSha256:'a6bf71bae890ab60b4249c8546e6b7185ce37c9ede4137e9c4aefbd9a755e65a',streetPartsSha256:'1ac1409cf70cd6c3ad1ab7139fd6f365898d5c654e499616a1892d1b669645b2'},provenanceArchive:approval.provenanceArchive,otherRegistrationIds:['122961573:0:f0','86957349:0:f0'],sourceMask,coverage:{playArea:mask.qualification.expanded,supportedArea:mask.supportedArea}};}return context;}
function loaded(){if(!prepared)prepared=readAuthority(pin,fixture());return prepared;}

test('fabricated authority and unapproved literal identity fail before input access',()=>{
  assert.throws(()=>readAuthority({file:'unused',sha256:'0'.repeat(64)},{}as never),/Unapproved/);
  assert.throws(()=>baselines({}as Authority,{}as RoadGraph,{}as RoadGraph,[]),/Unrecognized/);
  assert.throws(()=>assertAfter({}as Authority,{}as never,{}as never,''),/Unrecognized/);
});

test('actual w292 binds different ORIGINAL and CURRENT records and preserves current-A tail and extras',{skip:!available},()=>{
  const p=loaded(),ctx=fixture();assert.notEqual(p.witness.beforeSha256,p.currentWitness.beforeSha256);assert.equal(p.witness.beforeSha256,'237811b0011b5c0e17aaf2c9b5e4e155acd49e4f80c432b3b6ddf052ea932a01');assert.equal(p.currentWitness.beforeSha256,'c389eab38b488580d6742bca33586ee99f15ce1c273fc1af3f3ccf492e425629');
  const after=p.currentBaseline.footways.find(r=>r.id===ID)!;assert.equal(after.points.length,162);assert.equal(hash(after),p.witness.afterSha256);assert.deepEqual(after.points.slice(158),ctx.current.footways.find(r=>r.id===ID)!.points.slice(9));
  for(const[before,next]of[[ctx.original,p.originalBaseline],[ctx.current,p.currentBaseline]]as const)for(const kind of['nodes','lanes','connectors','parking','footways']as const){assert.equal(before[kind].length,next[kind].length);for(let i=0;i<before[kind].length;i++)if(before[kind][i]!.id!==ID)assert.deepEqual(next[kind][i],before[kind][i]);}
  assert.equal(p.receipt.currentAdditionsPreserved,43);assert.equal(p.receipt.nativeMaskFaces,6);assert.equal(p.receipt.physical.samples,10098);assert.deepEqual(p.receipt.finiteRegression,{pairedScenarios:6,ticks:3244,rays:805,historicalStallsRetained:true});assert.ok(!JSON.stringify(p.receipt).includes('../')&&!JSON.stringify(p.receipt).includes('Users'));
  assertAfter(p.authority,after,ctx.coverage,ctx.sourceMask.sha256);after.points[158]![1]+=1;assert.equal(hash(baselines(p.authority,ctx.original,ctx.current,[]).currentBaseline.footways.find(r=>r.id===ID)),p.witness.afterSha256);assert.throws(()=>baselines(JSON.parse(JSON.stringify(p.authority)),ctx.original,ctx.current,[]),/Unrecognized/);
});

test('exact AFTER, current-A seam, ordered XZ and nonpoint metadata remain narrow',{skip:!available},()=>{
  const p=loaded(),ctx=fixture(),after=baselines(p.authority,ctx.original,ctx.current,[]).currentBaseline.footways.find(r=>r.id===ID)!;
  for(const mutate of[(r:any)=>r.points[158][1]+=.001,(r:any)=>r.points[40][0]+=.001,(r:any)=>r.points.at(-1)[2]+=.001,(r:any)=>r.points.splice(40,1),(r:any)=>r.id='wother',(r:any)=>r.name='changed']){const changed=structuredClone(after);mutate(changed);assert.throws(()=>assertAfter(p.authority,changed,ctx.coverage,ctx.sourceMask.sha256),/Exact reviewed/);}
  const substituted={...ctx.current,footways:ctx.current.footways.map(r=>r.id===ID?structuredClone(ctx.original.footways.find(r=>r.id===ID)!):r)};assert.throws(()=>readAuthority(pin,{...ctx,current:substituted}),/Actual CURRENT/);assert.throws(()=>baselines(p.authority,ctx.original,substituted,[]),/another CURRENT/);
  const changed=structuredClone(ctx.current);changed.nodes[0]!.position[0]+=.01;assert.throws(()=>baselines(p.authority,ctx.original,changed,[]),/another CURRENT/);assert.throws(()=>readAuthority(pin,{...ctx,current:changed}),/actual CURRENT/);
});

test('historical mask, altered runtime coverage, overlap and world aliases cannot reuse approval',{skip:!available},()=>{
  const p=loaded(),ctx=fixture(),after=baselines(p.authority,ctx.original,ctx.current,[]).currentBaseline.footways.find(r=>r.id===ID)!;
  const changed=structuredClone(ctx.coverage);changed.supportedArea!.regions[0]!.outer[0]![0]+=.000001;assert.throws(()=>assertAfter(p.authority,after,changed,ctx.sourceMask.sha256),/coverage changed/);
  assert.throws(()=>assertAfter(p.authority,after,ctx.coverage,approval.sourceMaskAmendment.previousMask.sha256),/mask identity/);
  assert.throws(()=>readAuthority(pin,{...ctx,sourceMask:approval.sourceMaskAmendment.originalNormalizedSourceMask}),/approved final source mask/);
  assert.throws(()=>readAuthority(pin,{...ctx,coverage:changed}),/Runtime coverage differs/);
  for(const ids of[[ID],['duplicate','duplicate']])assert.throws(()=>baselines(p.authority,ctx.original,ctx.current,ids),/overlaps|Duplicate/);
  assert.throws(()=>readAuthority(pin,{...ctx,currentWorld:{...ctx.currentWorld,manifestSha256:'0'.repeat(64)}}));
  assert.throws(()=>readAuthority(pin,{...ctx,worldCompatibility:{file:'unused',sha256:'0'.repeat(64)}}),/compatibility alias/);
});

test('raw source, historical producer, mask normalization and exact native collision bytes are mandatory',{skip:!available},()=>{
  const ctx=fixture(),p=loaded(),m=JSON.parse(fs.readFileSync(ctx.currentWorld.directory+'/manifest.json','utf8')),cell=m.cells.find((c:any)=>c.id==='c_m10_p06'),mapping=JSON.parse(fs.readFileSync(ctx.provenanceArchive.file,'utf8'));
  for(const target of['../sources/raw-v2/street-parts/southwest-cumulative-20261029.geojson',ctx.currentWorld.directory+'/'+cell.collision.path,approval.sourceMaskAmendment.originalNormalizedSourceMask.file,ctx.sourceMask.file,ctx.provenanceArchive.file.replace('mapping.json',mapping.files[0].path)])withCorruptedRead(target,()=>assert.throws(()=>readAuthority(pin,ctx),/input changed/));
  withCorruptedRead(ctx.currentWorld.directory+'/'+cell.collision.path,()=>assert.throws(()=>p.verifyInputs(),/input changed/));p.verifyInputs();
});
