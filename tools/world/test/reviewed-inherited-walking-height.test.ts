import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type {RoadGraph} from '../../../packages/world-schema/src/index.ts';
import {sourceSha256} from '../lib/source-files.ts';
import {readReviewedInheritedWalkingHeight as readAuthority,inheritedWalkingHeightBaselines as baselines,assertReviewedInheritedWalkingAfter as assertAfter,type ReviewedInheritedWalkingHeightAuthority as Authority} from '../lib/reviewed-inherited-walking-height.ts';
import {bundleFixture,withCorruptedRead} from './inherited-height-bundle-fixture.ts';
const available=fs.existsSync('../evidence/inherited-walking-seven-root-approval-v1.json');
let fixture:ReturnType<typeof bundleFixture>,bound:ReturnType<typeof readAuthority>;
const hash=(v:unknown)=>sourceSha256(JSON.stringify(v));
function loaded(){if(!bound){fixture=bundleFixture('walking-seven');bound=readAuthority(fixture.pin,fixture.context);}return bound;}

test('walking: fabricated/deserialized tokens and arbitrary case approvals are rejected',()=>{
  assert.throws(()=>readAuthority({file:'unused',sha256:'0'.repeat(64)},{}as never),/Unapproved/);
  assert.throws(()=>baselines({}as Authority,{}as RoadGraph,{}as RoadGraph,[]),/Unrecognized/);
  assert.throws(()=>assertAfter({}as Authority,{}as never,[]),/Unrecognized/);
});

test('walking: exact seven records preserve both detached baselines and every43currentA addition',{skip:!available},()=>{
  fixture=bundleFixture('walking-seven');const before=[hash(fixture.context.original),hash(fixture.context.current)],open=fs.openSync,read=fs.readSync,close=fs.closeSync,fds=new Set<number>();let rawBytes=0,maxRead=0;
  try{
    (fs as any).openSync=(file:any,...args:any[])=>{const fd=(open as any)(file,...args);if(String(file).endsWith('.json.gz'))fds.add(fd);return fd;};
    (fs as any).readSync=(fd:number,buffer:Buffer,offset:number,length:number,position:any)=>{const n=(read as any)(fd,buffer,offset,length,position);if(fds.has(fd)){rawBytes+=n;maxRead=Math.max(maxRead,length);}return n;};
    (fs as any).closeSync=(fd:number)=>{fds.delete(fd);return close(fd);};
    bound=readAuthority(fixture.pin,fixture.context);
  }finally{fs.openSync=open;fs.readSync=read;fs.closeSync=close;}
  assert.ok(rawBytes>100000&&maxRead<=65536);assert.deepEqual([hash(fixture.context.original),hash(fixture.context.current)],before);
  assert.equal(bound.witnesses.length,7);assert.equal(bound.receipt.currentAdditionsPreserved,43);assert.equal(bound.receipt.physical.noLegacyFloorException,true);assert.equal(bound.receipt.physical.ordinaryHeightToleranceMetres,.2);
  assert.ok(!JSON.stringify(bound.receipt).includes('../')&&!JSON.stringify(bound.receipt).includes('Users'));
  const ids=new Set(bound.witnesses.map(w=>w.id));
  for(const [original,corrected]of[[fixture.context.original,bound.originalBaseline],[fixture.context.current,bound.currentBaseline]]as const)for(const k of['nodes','lanes','connectors','footways','parking']as const)for(const r of original[k]){const after=corrected[k].find(a=>a.id===r.id);if(k==='footways'&&ids.has(r.id))assert.equal(hash(after),bound.witnesses.find(w=>w.id===r.id)!.afterSha256);else assert.deepEqual(after,r);}
  const changed=bound.originalBaseline.footways.find(r=>ids.has(r.id))!;(changed.points[0]as number[])[1]=changed.points[0]![1]+1;
  assert.notDeepEqual(changed,bound.currentBaseline.footways.find(r=>r.id===changed.id));
  assert.deepEqual(baselines(bound.authority,fixture.context.original,fixture.context.current,[]).originalBaseline.footways.find(r=>r.id===changed.id),bound.currentBaseline.footways.find(r=>r.id===changed.id));
  assert.throws(()=>baselines(JSON.parse(JSON.stringify(bound.authority)),fixture.context.original,fixture.context.current,[]),/Unrecognized/);
});

test('walking: any original/current metadata or source-role substitution fails closed',{skip:!available},()=>{
  const b=loaded(),c=fixture.context,id=b.witnesses[0]!.id;
  for(const mutate of[(r:any)=>r.points[0][1]+=.001,(r:any)=>r.points[0][0]+=.001,(r:any)=>r.id='different',(r:any)=>r.extraSource='invented']){
    const original=structuredClone(c.original);mutate(original.footways.find(r=>r.id===id));assert.throws(()=>baselines(b.authority,original,c.current,[]),/another ORIGINAL/);
  }
  const current=structuredClone(c.current),addition=current.lanes.find(r=>!c.original.lanes.some(o=>o.id===r.id))!;(addition as any).width+=.01;
  assert.throws(()=>baselines(b.authority,c.original,current,[]),/another CURRENT/);
  assert.throws(()=>readAuthority(fixture.pin,{...c,current}),/actual CURRENT/);
  for(const otherRegistrationIds of[[id],['same','same']]){assert.throws(()=>readAuthority(fixture.pin,{...c,otherRegistrationIds}),/overlaps|Duplicate/);assert.throws(()=>baselines(b.authority,c.original,c.current,otherRegistrationIds),/overlaps|Duplicate/);}
  assert.throws(()=>readAuthority(fixture.pin,{...c,sourcePins:{...c.sourcePins,osmSha256:'0'.repeat(64)}}));
  assert.throws(()=>readAuthority(fixture.pin,{...c,provenanceArchive:{...c.provenanceArchive,sha256:'0'.repeat(64)}}),/provenance/);
  assert.throws(()=>readAuthority(fixture.pin,{...c,currentWorld:{...c.currentWorld,manifestSha256:'d453fdd79db114c914322f0209121c34819206b294004bdcece2739f0f3b4701'}}));
});

test('walking: exact AFTER contract rejects reprojected Y, extra knots, XZ and unlisted identities',{skip:!available},()=>{
  const b=loaded(),fresh=baselines(b.authority,fixture.context.original,fixture.context.current,[]),lane=fresh.currentBaseline.footways.find(r=>r.id===b.witnesses[0]!.id)!;
  assert.deepEqual(assertAfter(b.authority,lane,[]),b.witnesses[0]);
  for(const mutate of[(r:any)=>r.points[1][1]+=.000001,(r:any)=>r.points[1][0]+=.000001,(r:any)=>r.points.splice(2,0,[...r.points[1]]),(r:any)=>r.id='59804323:0:f0',(r:any)=>r.id='w28842927',(r:any)=>r.extra='arbitrary']){const copy=structuredClone(lane);mutate(copy);assert.throws(()=>assertAfter(b.authority,copy,[]),/Exact reviewed|Unlisted/);}
  assert.throws(()=>assertAfter(b.authority,lane,[lane.id]),/overlaps/);
});

test('walking: changed native floor, terrain, raw trace and historical source fail at reuse',{skip:!available},()=>{
  const b=loaded(),m=JSON.parse(fs.readFileSync(fixture.context.currentWorld.directory+'/manifest.json','utf8')),case0=fixture.packet.cases[0],cell=m.cells.find((c:any)=>c.id===case0.oldAndCurrentFloor.current[0].cell),mapping=JSON.parse(fs.readFileSync(fixture.approval.provenanceArchive.file,'utf8'));
  const trace=case0.nativeRuns[0].before.trace.file;
  const archiveDir=fixture.approval.provenanceArchive.file.replace(/[/\\][^/\\]+$/,'');
  for(const file of[fixture.context.currentWorld.directory+'/'+cell.collision.path,fixture.context.currentWorld.directory+'/'+m.terrain.path,trace,archiveDir+'/'+mapping.files[0].path])withCorruptedRead(file,()=>assert.throws(()=>b.verifyInputs(),/input changed/));
});

test('walking:only the six named newly valid placements are admitted by this metadata case',{skip:!available},()=>{const b=loaded();assert.equal(b.receipt.physical.samples,50193);assert.ok('newlyValidPlacements'in b.receipt);assert.equal(b.receipt.newlyValidPlacements!.recordId,'w86356194');assert.equal(b.receipt.newlyValidPlacements!.stations.length,6);assert.equal(b.receipt.finiteRegression.ticks,15596);assert.equal(b.receipt.finiteRegression.rays,4005);});
