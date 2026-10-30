import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {readReviewedRoadGradeAuthoring,assertReviewedRoadGradeFaces,TELAKKAKATU_AUTHORING_REVIEW_SHA256,assertFiniteTelakkakatuRapierEvidence,type ReviewedRoadGradeAuthority} from '../lib/reviewed-road-grade-authoring.ts';
const file=fileURLToPath(new URL('../../../../evidence/telakkakatu-authoring-review-v2.json',import.meta.url));
const read=(pin:{file:string})=>fs.readFileSync(pin.file);
test('arbitrary review hashes and fabricated authority cannot grant authoring permission',()=>{
  let called=false;assert.throws(()=>readReviewedRoadGradeAuthoring({file:'unused',sha256:'0'.repeat(64)},()=>{called=true;return Buffer.from('{}');}),/Unapproved/);assert.equal(called,false);
  assert.throws(()=>assertReviewedRoadGradeFaces({} as ReviewedRoadGradeAuthority,[],[],[],'0'.repeat(64)),/approved source reader/);
});
test('numeric recovery checks reject the original object-subtraction case and nonfinite or inaccurate rays',()=>{
  const fixture=()=>({status:'PASS_ACTUAL_SERIALIZED_NATIVE_RAPIER_SUPPORT_NO_SAFETY_TERRAIN_CONTACT',failures:[],probes:Array.from({length:930},()=>({expectedY:2,hit:{y:2.00001,normalY:1,surface:{group:'ground'}}})),dynamics:Array.from({length:12},()=>({fallbackWheelContacts:0,groundContacts:100,finalWheelContacts:[true,true,true,true]})),body:{failures:[],heightToleranceMetres:.2,maxHeightDeviation:.1}});
  assert.ok(assertFiniteTelakkakatuRapierEvidence(fixture()).maximumHeightError<.002);
  for(const mutate of[(p:any)=>{p.expectedY={height:2,triangles:[]};},(p:any)=>{p.expectedY=NaN;},(p:any)=>{p.hit.y=Infinity;},(p:any)=>{delete p.hit.normalY;},(p:any)=>{p.hit.y=2.003;}]){const p=fixture();mutate(p.probes[0]);assert.throws(()=>assertFiniteTelakkakatuRapierEvidence(p));}
  const short=fixture();short.probes.pop();assert.throws(()=>assertFiniteTelakkakatuRapierEvidence(short));const contact=fixture();contact.dynamics[0]!.fallbackWheelContacts=1;assert.throws(()=>assertFiniteTelakkakatuRapierEvidence(contact));
});
test('exact licensed local authoring profile accepts only its literal native faces and actual terrain',{skip:!fs.existsSync(file)},()=>{
  const bound=readReviewedRoadGradeAuthoring({file,sha256:TELAKKAKATU_AUTHORING_REVIEW_SHA256},read),args=[bound.authority,bound.preflight.changes,bound.proposal.patchRegion,[-1792,-2304,800,768],bound.impact.terrain.decodedSha256] as const;
  assert.equal(assertReviewedRoadGradeFaces(...args).measuredSurveyPreservationClaim,false);
  const changed=structuredClone(bound.preflight.changes);changed[0].after[0][1]=Math.fround(changed[0].after[0][1]+.001);assert.throws(()=>assertReviewedRoadGradeFaces(bound.authority,changed,args[2],args[3],args[4]),/exact approved native delta/);
  assert.throws(()=>assertReviewedRoadGradeFaces(...[...args.slice(0,4),'0'.repeat(64)] as unknown as Parameters<typeof assertReviewedRoadGradeFaces>),/Safety terrain differs/);
  assert.throws(()=>assertReviewedRoadGradeFaces(bound.authority,args[1],[-1144,767,-1092,1172],args[3],args[4]));
  bound.preflight.changes[0].after[0][1]+=1;assert.throws(()=>assertReviewedRoadGradeFaces(bound.authority,bound.preflight.changes,args[2],args[3],args[4]),/exact approved native delta/);
});
test('stale linked source bytes reject even when the approved review is exact',{skip:!fs.existsSync(file)},()=>{
  assert.throws(()=>readReviewedRoadGradeAuthoring({file,sha256:TELAKKAKATU_AUTHORING_REVIEW_SHA256},pin=>pin.file.includes('street-parts')?Buffer.from('{}'):read(pin)),/input changed/);
});
