import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import v8 from 'node:v8';
import {fileURLToPath} from 'node:url';
import {readReviewedEhrenstromRoadGrade,EHRENSTROM_AUTHORING_REVIEW_SHA256,assertFiniteEhrenstromRapierEvidence,assertReviewedEhrenstromFaces,replayReviewedEhrenstromTerrain,assertReviewedEhrenstromCollision,assertReviewedEhrenstromParent,type ReviewedEhrenstromGradeAuthority} from '../lib/reviewed-ehrenstrom-road-grade.ts';
import {readReviewedRoadGradeAuthoring} from '../lib/reviewed-road-grade-authoring.ts';
import {sourceSha256,sourceFile} from '../lib/source-files.ts';
import {decodeDeliverySimulation} from '../lib/delivery-city-payloads.ts';
import {replaceMeasuredGroundCollision} from '../lib/delivery-measured-ground.ts';
import {replayAuthoredRoadGradeDelta} from '../lib/authored-road-grade-replay.ts';

const file=fileURLToPath(new URL('../../../../evidence/ehrenstrom-authoring-review-v2.json',import.meta.url));
const read=(pin:{file:string})=>fs.readFileSync(pin.file);
test('only the exact Ehren review can grant signed authoring; fabricated and generic roles reject before reads',()=>{
  let called=false;const reader=()=>{called=true;return Buffer.from('{}');};
  assert.throws(()=>readReviewedEhrenstromRoadGrade({file:'unused',sha256:'0'.repeat(64)},reader),/Unapproved/);assert.equal(called,false);
  assert.throws(()=>readReviewedRoadGradeAuthoring({file:'unused',sha256:EHRENSTROM_AUTHORING_REVIEW_SHA256},reader),/Unapproved/);assert.equal(called,false);
  assert.throws(()=>assertReviewedEhrenstromFaces({}as ReviewedEhrenstromGradeAuthority,[],[],[],'0'.repeat(64)),/approved reader/);
});
function rayFixture(){return{status:'PASS_PRIVATE_SERIALIZED_HCOL_TERRAIN_RAPIER_NOT_APPLIED_WORLD',failures:[],probes:Array.from({length:639},()=>({s:200,offset:0,x:220,z:1737,expectedY:2,terrainSampleY:1.8,hit:{y:2.00001,normalY:1,surface:{group:'ground'}}})),dynamics:['lumi-gt','patrol','revontuli'].flatMap(definition=>[205,218,232].map(station=>({definition,station,fallbackContacts:0,minWheelContactsAfterTwoSeconds:4,finalWheelContacts:[true,true,true,true],minY:2,maxY:2.2,final:{x:220,y:2,z:1737}})))};}
test('finite numeric ray and suspension checks reject object subtraction, hidden NaN, duplicate probes and terrain fallback',()=>{
  assert.ok(assertFiniteEhrenstromRapierEvidence(rayFixture()).maximumHeightError<.002);
  for(const mutate of[(p:any)=>{p.expectedY={height:2};},(p:any)=>{p.expectedY=NaN;},(p:any)=>{p.hit.y=Infinity;},(p:any)=>{p.hit.normalY=undefined;},(p:any)=>{p.hit.normalY=.97;},(p:any)=>{p.x=NaN;},(p:any)=>{p.hit.y=2.003;}]){const f=rayFixture();mutate(f.probes[0]);assert.throws(()=>assertFiniteEhrenstromRapierEvidence(f));}
  for(const mutate of[(p:any)=>{p.dynamics[1]=p.dynamics[0];},(p:any)=>{p.dynamics[0].fallbackContacts=1;},(p:any)=>{p.dynamics[0].final.y=NaN;},(p:any)=>{p.dynamics[0].finalWheelContacts[0]=false;},(p:any)=>{p.probes.pop();}]){const f=rayFixture();mutate(f);assert.throws(()=>assertFiniteEhrenstromRapierEvidence(f));}
});
test('linked wrong signed profile, native forward proof and source bytes reject',{skip:!fs.existsSync(file)},()=>{
  for(const needle of['authoring-v4/proposal','authoring-v4/forward-binding','terrain-lowering-proposal','street-parts'])assert.throws(()=>readReviewedEhrenstromRoadGrade({file,sha256:EHRENSTROM_AUTHORING_REVIEW_SHA256},pin=>pin.file.includes(needle)?Buffer.from('{}'):read(pin)),/input changed/);
});
test('approved real native coincidence replay, exact582 seam/flank closure and82 terrain bits accept; altered deltas/nodes/parent reject',{skip:!fs.existsSync(file)},()=>{
  const b=readReviewedEhrenstromRoadGrade({file,sha256:EHRENSTROM_AUTHORING_REVIEW_SHA256},read),manifest=JSON.parse(fs.readFileSync(sourceFile(b.review.sourceWorld.directory,'manifest.json'),'utf8'));
  assertReviewedEhrenstromParent(b.authority,manifest);
  const metadataPin=b.review.sourceInputs.find((p:any)=>p.file.endsWith('native-cache.pinned.json'));assert.ok(metadataPin);const metadata=JSON.parse(read(metadataPin).toString());
  const originalBytes=fs.readFileSync(metadata.cache.path);assert.equal(sourceSha256(originalBytes),metadata.cache.sha256);const original=v8.deserialize(originalBytes),candidateBytes=fs.readFileSync(b.proposal.cache.file);assert.equal(sourceSha256(candidateBytes),b.proposal.cache.sha256);
  const replay=replayAuthoredRoadGradeDelta(original.ground,v8.deserialize(candidateBytes),b.proposal.pieceMapping);assert.deepEqual(replay.changes,b.preflight.changes);assert.deepEqual(replay.discardedExactDegenerate,b.preflight.discardedExactDegenerate);assert.equal(replay.coincidentGroups.length,119); // Two of121 reviewed groups retreat to zero.
  const terrain=decodeDeliverySimulation(fs.readFileSync(sourceFile(b.review.sourceWorld.directory,manifest.terrain.path)),manifest.terrain),args=[b.authority,replay.changes,b.proposal.patchRegion,[-1792,-2304,800,768],sourceSha256(terrain)]as const;
  assert.equal(assertReviewedEhrenstromFaces(...args).measuredSurveyPreservationClaim,false);
  const patched=replayReviewedEhrenstromTerrain(b.authority,terrain,b.terrainProposal.changes);assert.equal(sourceSha256(patched.bytes),'cff1a6a5122d4c39ccc3a4ae04a459a07306c7141aac58426834f72019b46711');
  const old=Buffer.from(terrain),changed=new Set<number>(b.terrainProposal.changes.map((n:any)=>n.index));assert.ok(old.subarray(0,28).equals(patched.bytes.subarray(0,28)));let changedCount=0;for(let i=28;i<old.length;i+=4)if(old.readUInt32LE(i)!==patched.bytes.readUInt32LE(i)){assert.ok(changed.has((i-28)/4));changedCount++;}assert.equal(changedCount,82);
  for(const mutate of[(n:any)=>{n.index++;},(n:any)=>{n.beforeBits^=1;},(n:any)=>{n.afterBits^=1;},(n:any)=>{n.after-=.001;}]){const nodes=structuredClone(b.terrainProposal.changes);mutate(nodes[0]);assert.throws(()=>replayReviewedEhrenstromTerrain(b.authority,terrain,nodes),/exact approved indices and bits/);}
  const stale=Buffer.from(terrain);stale[28]=stale[28]!^1;assert.throws(()=>replayReviewedEhrenstromTerrain(b.authority,stale,b.terrainProposal.changes),/safety terrain changed/);
  const faces=structuredClone(replay.changes);faces[0]!.after[0]![1]=Math.fround(faces[0]!.after[0]![1]-.01);assert.throws(()=>assertReviewedEhrenstromFaces(b.authority,faces,args[2],args[3],args[4]),/exact approved native delta/);
  const alteredParent=structuredClone(manifest);alteredParent.terrain.sha256='0'.repeat(64);assert.throws(()=>assertReviewedEhrenstromParent(b.authority,alteredParent));
  const cell=manifest.cells.find((c:any)=>c.id==='c_p01_p13'),raw=decodeDeliverySimulation(fs.readFileSync(sourceFile(b.review.sourceWorld.directory,cell.collision.path)),cell.collision),result=replaceMeasuredGroundCollision(raw,replay.changes);assertReviewedEhrenstromCollision(b.authority,cell.id,result.bytes);assert.throws(()=>assertReviewedEhrenstromCollision(b.authority,cell.id,raw),/exact Rapier-tested/);
});
