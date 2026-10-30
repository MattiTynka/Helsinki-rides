import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {decodeRoadGraph, type RoadGraph} from '../../../packages/world-schema/src/index.ts';
import {decodeDeliverySimulation} from '../lib/delivery-city-payloads.ts';
import {readSourceFile, sourceSha256} from '../lib/source-files.ts';
import {readReviewedKopernikRegistration as readAuthority, kopernikRegistrationBaselines as baselines, assertReviewedKopernikAfter as assertAfter, assertReviewedKopernikCurrentRegistration as jointCurrent, KOPERNIK_REGISTRATION_APPROVAL, type KopernikRegistrationContext, type ReviewedKopernikRegistration as Authority} from '../lib/reviewed-kopernik-registration.ts';
const file='../evidence/kopernikuksentie-registration-root-approval-v1.json',available=fs.existsSync(file),approval={file,sha256:KOPERNIK_REGISTRATION_APPROVAL},hash=(v:unknown)=>sourceSha256(JSON.stringify(v));
const ids=['123812227:0:f0','123812227:0:b0'];
function fixture(final=false):KopernikRegistrationContext {
  const originalWorld={directory:'../accepted-world/world/senate-20261025-civilian-flee',manifestSha256:'0e18e55e8730f01144eef72a80decffbb53cdd658222f87a7e8ad6f75f2c4260'},currentWorld={directory:'../work/cumulative-city-east-walking-seam-v1/world',manifestSha256:'d453fdd79db114c914322f0209121c34819206b294004bdcece2739f0f3b4701'};
  const graph=(w:typeof originalWorld)=>{const m=JSON.parse(fs.readFileSync(w.directory+'/manifest.json','utf8'));return decodeRoadGraph(decodeDeliverySimulation(readSourceFile(w.directory,m.roads),m.roads));};
  const sourceMask={file:final?'../evidence/w29282225-supported-area-source-qualified-v4.json':'../evidence/cumulative-southwest-supported-area-source-v2.json',sha256:final?'1200b9fe57f38c4a51fd0c536455817ffe0640b102727fd40b551cebb3ea4c80':'d7ac8e4150fb5984a94b3956614cb74f21e3b82c37a99efb76b60bef81354923'},mask=JSON.parse(fs.readFileSync(sourceMask.file,'utf8'));
  return{original:graph(originalWorld),current:graph(currentWorld),originalWorld,currentWorld,sourceMask,coverage:{playArea:mask.qualification.expanded,supportedArea:mask.supportedArea},sourcePins:{osmSha256:'a6bf71bae890ab60b4249c8546e6b7185ce37c9ede4137e9c4aefbd9a755e65a',streetPartsSha256:'1ac1409cf70cd6c3ad1ab7139fd6f365898d5c654e499616a1892d1b669645b2'},provenanceArchive:{file:'../evidence/kopernikuksentie-root-approval-provenance-v1/mapping.json',sha256:'0042f71771bd7d9e99a7f5d47b8c3dc4413a3ee7b7a6eedaacd94a579b4357b9'},otherRegistrationIds:['122961573:0:f0','86957349:0:f0'],read:(pin,cap=16*1024*1024)=>{const stat=fs.lstatSync(pin.file);assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=cap);return fs.readFileSync(pin.file);}};
}
let context:KopernikRegistrationContext,prepared:ReturnType<typeof readAuthority>;
function load(){if(!prepared){context=fixture();prepared=readAuthority(approval,context);}return prepared;}

test('arbitrary approval and forged Kopernik authority cannot authorize protected XZ',()=>{
  assert.throws(()=>readAuthority({...approval,sha256:'0'.repeat(64)},{}as never),/Unapproved/);
  assert.throws(()=>baselines({}as Authority,{}as RoadGraph,{}as RoadGraph,[]),/Unrecognized/);
  assert.throws(()=>assertAfter({}as Authority,{}as never),/Unrecognized/);
  assert.throws(()=>jointCurrent({}as Authority,{}as RoadGraph,{}as RoadGraph),/Unrecognized/);
});

test('actual literal pair requalifies ordinary source/body while preserving all other records and43A additions',{skip:!available},()=>{
  const q=load();assert.deepEqual(q.witnesses.map(w=>w.id),ids);assert.equal(q.receipt.registrationNotHeightOnly,true);assert.equal(q.receipt.jointPairRequired,true);assert.equal(q.receipt.sourcePoses,3875);assert.equal(q.receipt.sourceTransitions,3869);assert.equal(q.receipt.unsupportedKnotsRejected,88);assert.deepEqual(q.receipt.physical.map(p=>p.samples),[189903,174364]);assert.ok(q.receipt.physical.every(p=>p.bodyFailures===0));assert.deepEqual(q.receipt.physical.map(p=>p.nominalFailuresRetained),[642,538]);assert.deepEqual(q.receipt.physical.map(p=>p.standaloneEndpointFailuresRetained),[175,160]);
  for(const[old,next]of[[context.original,q.originalBaseline],[context.current,q.currentBaseline]])for(const kind of['nodes','lanes','connectors','footways','parking']as const){assert.equal(old![kind].length,next![kind].length);for(let i=0;i<old![kind].length;i++)if(!ids.includes(old![kind][i]!.id))assert.deepEqual(next![kind][i],old![kind][i]);}
  for(const id of ids){const a=context.current.lanes.find(l=>l.id===id)!,b=q.currentBaseline.lanes.find(l=>l.id===id)!;assert.equal(b.points.length,379);assert.deepEqual([a.points[0],a.points.at(-1)],[b.points[0],b.points.at(-1)]);assert.notDeepEqual(a.points,b.points);assert.equal(a.length,b.length);assertAfter(q.authority,b);}
  assert.equal(jointCurrent(q.authority,context.current,q.currentBaseline).length,2);assert.ok(!JSON.stringify(q.receipt).includes('../')&&!JSON.stringify(q.receipt).includes('Users'));q.verifyInputs();
});

test('detached baselines and joint guard reject partial pair, changed endpoint, cost or arbitrary record',{skip:!available},()=>{
  const q=load(),fresh=baselines(q.authority,context.original,context.current,[]),first=fresh.currentBaseline.lanes.find(l=>l.id===ids[0])!;first.points[3]![0]+=.001;
  assert.throws(()=>jointCurrent(q.authority,context.current,fresh.currentBaseline),/Both exact/);assert.throws(()=>assertAfter(q.authority,first),/Exact reviewed/);
  const stable=baselines(q.authority,context.original,context.current,[]),partial={...stable.currentBaseline,lanes:stable.currentBaseline.lanes.map(l=>l.id===ids[1]?context.current.lanes.find(r=>r.id===l.id)!:l)};assert.throws(()=>jointCurrent(q.authority,context.current,partial),/Both exact/);
  for(const change of[(l:any)=>l.points[0][2]+=.001,(l:any)=>l.points.at(-1)[1]+=.001,(l:any)=>l.length+=.001,(l:any)=>l.width+=.1,(l:any)=>l.from='nother',(l:any)=>l.id='other']){const lane=structuredClone(stable.currentBaseline.lanes.find(l=>l.id===ids[0])!);change(lane);assert.throws(()=>assertAfter(q.authority,lane));}
  assert.throws(()=>baselines(JSON.parse(JSON.stringify(q.authority)),context.original,context.current,[]),/Unrecognized/);
  assert.deepEqual(jointCurrent(q.authority,context.current,stable.currentBaseline).map(w=>w.afterSha256),q.witnesses.map(w=>w.afterSha256));
});

test('registration overlap and changed currentA graph cannot inherit the protected pair',{skip:!available},()=>{
  const q=load();for(const id of ids){assert.throws(()=>baselines(q.authority,context.original,context.current,[id]),/overlaps/);assert.throws(()=>readAuthority(approval,{...context,otherRegistrationIds:[id]}),/overlaps/);}
  const changed=structuredClone(context.current);changed.footways.at(-1)!.points[0]![1]+=.001;
  assert.throws(()=>jointCurrent(q.authority,changed,q.currentBaseline),/another current/);assert.throws(()=>baselines(q.authority,context.original,changed,[]));assert.throws(()=>readAuthority(approval,{...context,current:changed}),/Actual CURRENT/);
});

test('only exact final1200 mask may reuse local geometry with unchanged source/body and closed tails',{skip:!available},()=>{
  const final=fixture(true),q=readAuthority(approval,final);assert.equal(q.receipt.historicalMaskSha256,'d7ac8e4150fb5984a94b3956614cb74f21e3b82c37a99efb76b60bef81354923');assert.equal(q.receipt.actualMaskSha256,final.sourceMask.sha256);assert.deepEqual(q.receipt.maskCompatibility.crop,[-128,640,0,897]);assert.ok(q.receipt.maskCompatibility.minimumInflatedHullCropMargin>0);assert.equal(q.receipt.unsupportedKnotsRejected,88);assert.deepEqual(q.witnesses,load().witnesses);q.verifyInputs();
  const future=structuredClone(final.coverage);future.supportedArea!.regions[0]!.outer[0]![0]+=.001;
  assert.throws(()=>readAuthority(approval,{...final,coverage:future}),/Actual pinned/);
  assert.throws(()=>readAuthority(approval,{...final,sourceMask:{...final.sourceMask,sha256:'0'.repeat(64)}}),/Unreviewed/);
  assert.throws(()=>readAuthority(approval,{...final,currentWorld:{...final.currentWorld,manifestSha256:'0'.repeat(64)}}),/future/);
});

test('raw source, archived producer, actual collision and terrain bytes are bound',{skip:!available},()=>{
  load();const m=JSON.parse(fs.readFileSync(context.currentWorld.directory+'/manifest.json','utf8')),cell=m.cells.find((c:any)=>c.id==='c_m01_p05').collision.path,archiveEntry=JSON.parse(fs.readFileSync(context.provenanceArchive.file,'utf8'))[0].archiveFile,base=context.read;
  for(const needle of['southwest-cumulative-20261029.geojson',archiveEntry,cell,m.terrain.path]){let hit=false;const read:KopernikRegistrationContext['read']=(pin,cap)=>{const bytes=Buffer.from(base(pin,cap));if(pin.file.replaceAll('\\','/').includes(needle)){bytes[0]=bytes[0]!^1;hit=true;}return bytes;};assert.throws(()=>readAuthority(approval,{...context,read}),/input changed/);assert.ok(hit);}
});

test('issued authority final verification catches later collision and mask-input changes',{skip:!available},()=>{
  const q=load(),base=context.read,m=JSON.parse(fs.readFileSync(context.currentWorld.directory+'/manifest.json','utf8')),cell=m.cells.find((c:any)=>c.id==='c_m01_p05').collision.path;
  try{context.read=(pin,cap)=>{const bytes=Buffer.from(base(pin,cap));if(pin.file.replaceAll('\\','/').includes(cell))bytes[0]=bytes[0]!^1;return bytes;};assert.throws(()=>q.verifyInputs(),/input changed/);}finally{context.read=base;}
  const original=context.coverage.supportedArea!.regions[0]!.id;try{(context.coverage.supportedArea!.regions[0] as any).id+='-future';assert.throws(()=>q.verifyInputs());}finally{(context.coverage.supportedArea!.regions[0] as any).id=original;}
  q.verifyInputs();
});

test('each authority consumer rejects a real copied archive changed after construction',{skip:!available},()=>{
  const copied=fixture(),source=copied.provenanceArchive.file,entries=JSON.parse(fs.readFileSync(source,'utf8')) as {archiveFile:string}[];
  const directory=fs.mkdtempSync('../work/kopernik-guard-tamper-'),sourceDirectory=source.slice(0,source.lastIndexOf('/'));
  fs.copyFileSync(source,directory+'/mapping.json');for(const entry of entries)fs.copyFileSync(sourceDirectory+'/'+entry.archiveFile,directory+'/'+entry.archiveFile);
  copied.provenanceArchive={...copied.provenanceArchive,file:directory+'/mapping.json'};
  const q=readAuthority(approval,copied),lane=q.currentBaseline.lanes.find(l=>l.id===ids[0])!,file=directory+'/'+entries[0]!.archiveFile,bytes=fs.readFileSync(file);
  bytes[0]=bytes[0]!^1;fs.writeFileSync(file,bytes);
  assert.throws(()=>baselines(q.authority,copied.original,copied.current,[]),/input changed after qualification/);
  assert.throws(()=>assertAfter(q.authority,lane),/input changed after qualification/);
  assert.throws(()=>jointCurrent(q.authority,copied.current,q.currentBaseline),/input changed after qualification/);
});
