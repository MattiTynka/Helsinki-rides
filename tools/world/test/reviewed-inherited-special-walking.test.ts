import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {decodeRoadGraph,type RoadGraph} from '../../../packages/world-schema/src/index.ts';
import {decodeDeliverySimulation} from '../lib/delivery-city-payloads.ts';
import {readSourceFile,sourceSha256} from '../lib/source-files.ts';
import {withCorruptedRead} from './inherited-height-bundle-fixture.ts';
import {readReviewedInheritedWalkingEdge,inheritedWalkingEdgeBaselines,assertReviewedInheritedWalkingEdgeAfter,qualifyReviewedInheritedWalkingEdgeDisposition} from '../lib/reviewed-inherited-walking-edge.ts';
import {readReviewedInheritedWalkingAvoidance,inheritedWalkingAvoidanceBaselines,assertReviewedInheritedWalkingAvoidanceAfter,qualifyReviewedInheritedWalkingAvoidanceDisposition} from '../lib/reviewed-inherited-walking-avoidance.ts';
const hash=(v:unknown)=>sourceSha256(JSON.stringify(v));
for(const [id,read,baselines,after,disposition]of[
 ['w28842927',readReviewedInheritedWalkingEdge,inheritedWalkingEdgeBaselines,assertReviewedInheritedWalkingEdgeAfter,qualifyReviewedInheritedWalkingEdgeDisposition],
 ['w28322529',readReviewedInheritedWalkingAvoidance,inheritedWalkingAvoidanceBaselines,assertReviewedInheritedWalkingAvoidanceAfter,qualifyReviewedInheritedWalkingAvoidanceDisposition],
]as const){
 const file=`../evidence/inherited-walking-${id}-root-approval-v1.json`,available=fs.existsSync(file);let b:any,ctx:any,packet:any,approval:any;
 function loaded(){if(!b){const bytes=fs.readFileSync(file);approval=JSON.parse(bytes.toString());packet=JSON.parse(fs.readFileSync(approval.packet.file,'utf8'));const graph=(w:any)=>{const m=JSON.parse(fs.readFileSync(w.directory+'/manifest.json','utf8'));return decodeRoadGraph(decodeDeliverySimulation(readSourceFile(w.directory,m.roads),m.roads));};ctx={original:graph(approval.originalWorld),current:graph(approval.currentWorld),originalWorld:approval.originalWorld,currentWorld:approval.currentWorld,sourcePins:{osmSha256:'a6bf71bae890ab60b4249c8546e6b7185ce37c9ede4137e9c4aefbd9a755e65a',streetPartsSha256:'1ac1409cf70cd6c3ad1ab7139fd6f365898d5c654e499616a1892d1b669645b2'},provenanceArchive:approval.provenanceArchive,otherRegistrationIds:[],...(id==='w28322529'?{provenanceSupplement:{file:'../evidence/inherited-walking-w28322529-provenance-supplement-root-approval-v1.json',sha256:'6f5c9e8f8657406663864def06a2d7131daaf3581fcaa1297d9d83e3220d6b08'}}:{})};b=read({file,sha256:sourceSha256(bytes)},ctx);}return b;}
 test(`${id}: fabricated authority and arbitrary approval cannot grant a special disposition`,()=>{
  assert.throws(()=>read({file:'unused',sha256:'0'.repeat(64)},{}as never),/Unapproved/);
  assert.throws(()=>baselines({}as never,{}as RoadGraph,{}as RoadGraph,[]),/Unrecognized/);
  assert.throws(()=>disposition({}as never,{}as never),/Unrecognized/);
 });
 test(`${id}: actual literal correction preserves all unselected records and detached currentA graph`,{skip:!available},()=>{
  const bound=loaded();assert.equal(bound.receipt.currentAdditionsPreserved,43);const c=packet.cases[0];assert.equal(bound.receipt.physical.failures,0);assert.equal(bound.receipt.physical.heightToleranceMetres,.2);
  for(const [old,next]of[[ctx.original,bound.originalBaseline],[ctx.current,bound.currentBaseline]])for(const kind of['nodes','lanes','connectors','footways','parking'])for(const r of old[kind]){const got=next[kind].find((x:any)=>x.id===r.id);if(kind==='footways'&&r.id===id)assert.equal(hash(got),c.afterSha256);else assert.deepEqual(got,r);}
  const oldHash=hash(ctx.current);bound.currentBaseline.footways.find((r:any)=>r.id===id).points[0][1]+=.001;assert.equal(hash(ctx.current),oldHash);
  const fresh=baselines(bound.authority,ctx.original,ctx.current,[]);assert.equal(hash(fresh.currentBaseline.footways.find(r=>r.id===id)),c.afterSha256);
  assert.ok(!JSON.stringify(bound.receipt).includes('../')&&!JSON.stringify(bound.receipt).includes('Users'));
 });
 test(`${id}: wrongY/XZ/identity/current additions/overlapping authority are rejected`,{skip:!available},()=>{
  const bound=loaded(),r=packet.cases[0].after;assert.equal(after(bound.authority,r,[]).id,id);
  for(const mutate of[(v:any)=>v.points[0][1]+=.000001,(v:any)=>v.points[0][0]+=.000001,(v:any)=>v.id='w28692747',(v:any)=>v.extra='source']){const v=structuredClone(r);mutate(v);assert.throws(()=>after(bound.authority,v,[]),/Exact|Unlisted/);}
  assert.throws(()=>baselines(bound.authority,ctx.original,ctx.current,[id]),/overlaps/);
  const changed=structuredClone(ctx.current);changed.nodes[0].x=1;assert.throws(()=>baselines(bound.authority,ctx.original,changed,[]),/another CURRENT/);
  if(id==='w28322529')assert.throws(()=>read({file,sha256:sourceSha256(fs.readFileSync(file))},{...ctx,provenanceSupplement:undefined}),/supplement required/);
 });
 test(`${id}: complete failed ray and axis batches remain failed; mutations cannot expand disposition`,{skip:!available},()=>{
  const bound=loaded(),c=packet.cases[0],input={record:c.after,otherRegistrationIds:[],failedStrictIdentityProbes:c.raySummary.failedStrictIdentityProbes,ordinaryAxisRuns:c.nativeRuns},original=hash(input),result=disposition(bound.authority,input);
  assert.equal(hash(input),original);assert.equal(result.ordinaryStrictRayResult,'RETHINK_SUPPORT_IDENTITY_OR_ARITHMETIC');assert.equal(result.ordinaryAxisTrackingFailedRuns,id==='w28322529'?6:0);assert.equal(result.noGenericRayOrTrackingTolerance,true);
  for(const mutate of[(v:any)=>v.failedStrictIdentityProbes[0].after.x+=.000001,(v:any)=>v.failedStrictIdentityProbes[0].before.normal[0]+=1e-9,(v:any)=>v.failedStrictIdentityProbes[0].after.cell='c_m16_p06',(v:any)=>v.failedStrictIdentityProbes.pop(),(v:any)=>v.ordinaryAxisRuns.pop(),(v:any)=>v.ordinaryAxisRuns[0].after.maxTrack=0,(v:any)=>v.ordinaryAxisRuns[0].after.status='INVENTED_PASS']){const v=structuredClone(input);mutate(v);assert.throws(()=>disposition(bound.authority,v));}
 });
 test(`${id}: explicit d453 compatibility rechecks the full42cell world and rejects unbound successors`,{skip:!available},()=>{
  loaded();const currentWorld={directory:'../work/cumulative-city-east-walking-seam-v1/world',manifestSha256:'d453fdd79db114c914322f0209121c34819206b294004bdcece2739f0f3b4701'},worldCompatibility={file:'../evidence/inherited-height-d453-compatibility-root-approval-v1.json',sha256:'31374c50613e6a587ff8c7aa091dcbf317d5888789e477599598d04183c3fa29'},pin={file,sha256:sourceSha256(fs.readFileSync(file))};
  assert.throws(()=>read(pin,{...ctx,currentWorld}),/compatibility approval required/);
  assert.throws(()=>read(pin,{...ctx,currentWorld,worldCompatibility:{...worldCompatibility,sha256:'0'.repeat(64)}}),/Unapproved/);
  assert.throws(()=>read(pin,{...ctx,currentWorld:{...currentWorld,manifestSha256:'0'.repeat(64)},worldCompatibility}),/Unapproved inherited current world/);
  const forwarded=read(pin,{...ctx,currentWorld,worldCompatibility});assert.equal(forwarded.receipt.currentManifestSha256,currentWorld.manifestSha256);assert.equal(forwarded.receipt.historicalEvidenceManifestSha256,ctx.currentWorld.manifestSha256);assert.equal(forwarded.receipt.worldCompatibility!.localFloorCells,42);
  const actual=JSON.parse(fs.readFileSync(currentWorld.directory+'/manifest.json','utf8')),distant=actual.cells.find((c:any)=>c.id==='c_p02_p07');withCorruptedRead(currentWorld.directory+'/'+distant.collision.path,()=>assert.throws(()=>forwarded.verifyInputs(),/input changed/));
 });
 test(`${id}: changed actualedge/currentA collider, terrain and raw trace fail reuse`,{skip:!available},()=>{
  const bound=loaded(),m=JSON.parse(fs.readFileSync(ctx.currentWorld.directory+'/manifest.json','utf8')),edgeCell=approval.exactEdgeDisposition.after.cell,cell=m.cells.find((c:any)=>c.id===edgeCell),c=packet.cases[0];
  for(const target of[ctx.currentWorld.directory+'/'+cell.collision.path,ctx.currentWorld.directory+'/'+m.terrain.path,c.raySummary.raw.file,c.nativeRuns[0].after.trace.file])withCorruptedRead(target,()=>assert.throws(()=>bound.verifyInputs(),/input changed/));
 });
}
