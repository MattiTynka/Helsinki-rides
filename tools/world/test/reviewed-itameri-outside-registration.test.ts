import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {decodeRoadGraph,type RoadGraph,type RoadConnector} from '../../../packages/world-schema/src/index.ts';
import {decodeDeliverySimulation} from '../lib/delivery-city-payloads.ts';import {readSourceFile,sourceSha256} from '../lib/source-files.ts';
import {readReviewedItameriOutsideRegistration as readAuthority,itameriOutsideBaselines as baselines,assertReviewedItameriOutsideAfter as assertAfter,ITAMERI_RETAINED_OUTSIDE_APPROVAL,type ItameriOutsideContext,type ItameriOutsidePin,type ReviewedItameriOutsideRegistration as Authority} from '../lib/reviewed-itameri-outside-registration.ts';
const file='../evidence/itameri-retained-outside-root-approval-v1.json',available=fs.existsSync(file),approval={file,sha256:ITAMERI_RETAINED_OUTSIDE_APPROVAL},hash=(v:unknown)=>sourceSha256(JSON.stringify(v));
function context():ItameriOutsideContext {
  const originalWorld={directory:'../accepted-world/world/senate-20261025-civilian-flee',manifestSha256:'0e18e55e8730f01144eef72a80decffbb53cdd658222f87a7e8ad6f75f2c4260'},currentWorld={directory:'../work/cumulative-city-east-walking-seam-v1/world',manifestSha256:'d453fdd79db114c914322f0209121c34819206b294004bdcece2739f0f3b4701'};
  const graph=(w:typeof originalWorld)=>{const m=JSON.parse(fs.readFileSync(w.directory+'/manifest.json','utf8'));return decodeRoadGraph(decodeDeliverySimulation(readSourceFile(w.directory,m.roads),m.roads));},mask=JSON.parse(fs.readFileSync('../evidence/cumulative-southwest-supported-area-source-v2.json','utf8'));
  return{original:graph(originalWorld),current:graph(currentWorld),originalWorld,currentWorld,coverage:{playArea:mask.qualification.expanded,supportedArea:mask.supportedArea},selectedNewConnectors:[],otherRegistrationIds:['122961573:0:f0'],read:(p:ItameriOutsidePin,cap=64*1024*1024)=>{const s=fs.lstatSync(p.file);assert.ok(s.isFile()&&!s.isSymbolicLink()&&s.size<=cap);const b=fs.readFileSync(p.file);assert.equal(sourceSha256(b),p.sha256);return b;}};
}
let ctx:ItameriOutsideContext,prepared:ReturnType<typeof readAuthority>;
function loaded(){if(!prepared){ctx=context();prepared=readAuthority(approval,ctx);}return prepared;}
test('arbitrary approval and fabricated authority do not permit an outside endpoint change',()=>{
  assert.throws(()=>readAuthority({file:'unused',sha256:'0'.repeat(64)},{}as never),/Unapproved/);
  assert.throws(()=>baselines({}as Authority,{}as RoadGraph,{}as RoadGraph,[],[]),/Unrecognized/);
  assert.throws(()=>assertAfter({}as Authority,{}as never),/Unrecognized/);
});
test('actual exact869after passes source/native/parallel margins and preserves all other records',{skip:!available},()=>{
  const p=loaded(),id=p.witness.id,lane=p.originalBaseline.lanes.find(l=>l.id===id)!;assert.equal(lane.points.length,79);assert.equal(hash(lane),'63a4e40251f50233bee5ceea20164ee263cc9c3d35d8a473c52fa14c7d4db2b3');assert.equal(lane.length,37.12772913784751);assert.equal(p.receipt.vehicleBodySamples,43717);assert.equal(p.receipt.parallelClearancePairs,9);assert.deepEqual(p.receipt.nominalFailuresRetained,{laneWidthSource:77,laneWidthCollision:70});
  for(const [before,after]of[[ctx.original,p.originalBaseline],[ctx.current,p.currentBaseline]])for(const kind of['nodes','lanes','connectors','parking','footways']as const){assert.equal(before![kind].length,after![kind].length);for(let i=0;i<before![kind].length;i++)if(before![kind][i]!.id!==id)assert.deepEqual(after![kind][i],before![kind][i]);}
  assert.ok(!JSON.stringify(p.receipt).includes('../')&&!JSON.stringify(p.receipt).includes('Users'));
  lane.points[0]![1]+=1;const fresh=baselines(p.authority,ctx.original,ctx.current,ctx.otherRegistrationIds,[]);assert.equal(hash(fresh.originalBaseline.lanes.find(l=>l.id===id)),p.witness.afterSha256);assert.deepEqual(fresh.currentBaseline.lanes.find(l=>l.id===id),fresh.originalBaseline.lanes.find(l=>l.id===id));
  assert.throws(()=>baselines(JSON.parse(JSON.stringify(p.authority)),ctx.original,ctx.current,[],[]),/Unrecognized/);
});
test('exact AFTER endpoint, protected seam, metadata, parallel and source substitutions reject',{skip:!available},()=>{
  const p=loaded(),lane=baselines(p.authority,ctx.original,ctx.current,[],[]).originalBaseline.lanes.find(l=>l.id===p.witness.id)!;
  for(const mutate of[(l:any)=>l.points[0][0]+=.001,(l:any)=>l.points.find((q:number[])=>q[0]===-1792)[1]+=.001,(l:any)=>l.points.at(-1)[2]+=.001,(l:any)=>l.length+=.001,(l:any)=>l.from='nother',(l:any)=>l.id='122961573:0:f0']){const changed=structuredClone(lane);mutate(changed);assert.throws(()=>assertAfter(p.authority,changed),/Exact reviewed/);}
  const changed=structuredClone(ctx.current);changed.lanes.find(l=>l.id==='86957349:0:f1')!.points[0]![2]+=.01;assert.throws(()=>baselines(p.authority,ctx.original,changed,[],[]),/another CURRENT/);assert.throws(()=>readAuthority(approval,{...ctx,current:changed}),/Actual CURRENT/);
});
test('no new incoming connector or overlapping registration can inherit the endpoint approval',{skip:!available},()=>{
  const p=loaded(),incoming={...ctx.current.connectors[0],id:'unapproved',to:p.witness.id}as RoadConnector;
  assert.throws(()=>readAuthority(approval,{...ctx,selectedNewConnectors:[incoming]}),/No new incoming/);
  assert.throws(()=>baselines(p.authority,ctx.original,ctx.current,[],[incoming]),/No new incoming/);
  assert.throws(()=>assertAfter(p.authority,p.currentBaseline.lanes.find(l=>l.id===p.witness.id)!,[incoming]),/No new incoming/);
  for(const ids of[[p.witness.id],['duplicate','duplicate']])assert.throws(()=>baselines(p.authority,ctx.original,ctx.current,ids,[]),/overlaps|Duplicate/);
  assert.throws(()=>readAuthority(approval,{...ctx,currentWorld:{...ctx.currentWorld,manifestSha256:'0'.repeat(64)}}));
});
test('rawsource, actualHCOL and frozen producer bytes are mandatory before and after issuance',{skip:!available},()=>{
  const p=loaded(),m=JSON.parse(fs.readFileSync(ctx.currentWorld.directory+'/manifest.json','utf8')),collision=m.cells.find((c:any)=>c.id==='c_m15_p05').collision.path,base=ctx.read;
  for(const needle of['southwest-cumulative-20261029.geojson',collision,'source/tools/world/lib/geometry.ts']){
    const read:ItameriOutsideContext['read']=(pin,cap)=>{const b=Buffer.from(base(pin,cap));if(pin.file.replaceAll('\\','/').includes(needle))b[0]=b[0]!^1;return b;};
    assert.throws(()=>readAuthority(approval,{...ctx,read}),/input changed/);
  }
  const actualRead=fs.readFileSync;let corrupted=false;
  try{(fs as any).readFileSync=(f:any,...args:any[])=>{const b=(actualRead as any)(f,...args);if(String(f).replaceAll('\\','/').includes(collision)&&Buffer.isBuffer(b)){const copy=Buffer.from(b);copy[0]=copy[0]!^1;corrupted=true;return copy;}return b;};assert.throws(()=>p.verifyInputs());assert.equal(corrupted,true);}finally{fs.readFileSync=actualRead;}
});
