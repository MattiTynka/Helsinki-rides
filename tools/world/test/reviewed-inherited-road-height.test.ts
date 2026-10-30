import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {decodeRoadGraph, type RoadGraph} from '../../../packages/world-schema/src/index.ts';
import {decodeDeliverySimulation} from '../lib/delivery-city-payloads.ts';
import {sourceFile, readSourceFile} from '../lib/source-files.ts';
import {readReviewedInheritedRoadHeight,inheritedRoadHeightBaselines,inheritedLegacyProbeIdentity,qualifyReviewedInheritedLegacyProbes,INHERITED_ROAD_HEIGHT_APPROVAL_SHA256,INHERITED_ROAD_HEIGHT_PROVENANCE_SHA256,type InheritedHeightContext,type ReviewedInheritedRoadHeightAuthority,type InheritedLegacyProbe} from '../lib/reviewed-inherited-road-height.ts';

const approvalFile=fileURLToPath(new URL('../../../../evidence/laivasillankatu-inherited-y-root-approval-v1.json',import.meta.url));
const approval={file:approvalFile,sha256:INHERITED_ROAD_HEIGHT_APPROVAL_SHA256},available=fs.existsSync(approvalFile);
function context():InheritedHeightContext{
  const root=JSON.parse(fs.readFileSync(approvalFile,'utf8')),originalWorld={directory:'../accepted-world/world/senate-20261025-civilian-flee',manifestSha256:root.acceptedManifestSha256},currentWorld=root.reviewedWorld;
  const graph=(world:{directory:string})=>{const m=JSON.parse(fs.readFileSync(sourceFile(world.directory,'manifest.json'),'utf8'));return decodeRoadGraph(decodeDeliverySimulation(readSourceFile(world.directory,m.roads),m.roads));};
  return{original:graph(originalWorld),current:graph(currentWorld),originalWorld,currentWorld,sourcePins:{osmSha256:'a6bf71bae890ab60b4249c8546e6b7185ce37c9ede4137e9c4aefbd9a755e65a',streetPartsSha256:'1ac1409cf70cd6c3ad1ab7139fd6f365898d5c654e499616a1892d1b669645b2'},provenanceArchive:{file:'../evidence/laivasillankatu-provenance-archive-v1/mapping.json',sha256:INHERITED_ROAD_HEIGHT_PROVENANCE_SHA256},otherRegistrationIds:[]};
}
let cached:ReturnType<typeof readReviewedInheritedRoadHeight>|undefined,ctx:InheritedHeightContext;
function loaded(){if(!cached){ctx=context();cached=readReviewedInheritedRoadHeight(approval,ctx);}return cached;}
function probes():InheritedLegacyProbe[]{
  const packet=JSON.parse(fs.readFileSync('../evidence/laivasillankatu-inherited-y-review-packet-v1.json','utf8')),proposal=JSON.parse(fs.readFileSync(packet.proposal.file,'utf8')),legacy=JSON.parse(fs.readFileSync(packet.unchangedLegacyFloor.file,'utf8')),nominal=new Set(proposal.physical.nominalFailures.map((p:any)=>JSON.stringify(p.point)));
  return legacy.misses.map((m:any)=>{const p={recordId:'59804323:0:f0',kind:nominal.has(JSON.stringify(m.point))?'laneWidthCollision':'bodyCollision',point:m.point}as Omit<InheritedLegacyProbe,'sampleIdentity'>;return{...p,sampleIdentity:inheritedLegacyProbeIdentity(p)};});
}

test('arbitrary approvals and fabricated or deserialized authority cannot grant inherited-height permission',()=>{
  assert.throws(()=>readReviewedInheritedRoadHeight({file:'unused',sha256:'0'.repeat(64)},{}as InheritedHeightContext),/Unapproved inherited/);
  const fake={}as ReviewedInheritedRoadHeightAuthority;
  assert.throws(()=>inheritedRoadHeightBaselines(fake,{}as RoadGraph,{}as RoadGraph,[]),/Unrecognized/);
  assert.throws(()=>qualifyReviewedInheritedLegacyProbes(fake,{}as never),/Unrecognized/);
  assert.throws(()=>inheritedLegacyProbeIdentity({recordId:'other',kind:'bodyCollision',point:[1,2,3]}));
  assert.throws(()=>inheritedLegacyProbeIdentity({recordId:'59804323:0:f0',kind:'bodyCollision',point:[1,NaN,3]}));
});

test('literal packet constructs detached original/current baselines and streams the raw trace in bounded chunks',{skip:!available},()=>{
  ctx=context();const beforeOriginal=JSON.stringify(ctx.original),beforeCurrent=JSON.stringify(ctx.current),open=fs.openSync,read=fs.readSync,close=fs.closeSync,traceFds=new Set<number>();let traceBytes=0,maxRequest=0;
  try{
    (fs as any).openSync=(file:any,...args:any[])=>{const fd=(open as any)(file,...args);if(String(file).includes('laivasillankatu-native-drive-v4.json'))traceFds.add(fd);return fd;};
    (fs as any).readSync=(fd:number,buffer:Buffer,offset:number,length:number,position:any)=>{const n=(read as any)(fd,buffer,offset,length,position);if(traceFds.has(fd)){traceBytes+=n;maxRequest=Math.max(maxRequest,length);}return n;};
    (fs as any).closeSync=(fd:number)=>{traceFds.delete(fd);return close(fd);};
    cached=readReviewedInheritedRoadHeight(approval,ctx);
  }finally{fs.openSync=open;fs.readSync=read;fs.closeSync=close;}
  assert.equal(traceBytes,121390202);assert.ok(maxRequest<=65536);assert.equal(JSON.stringify(ctx.original),beforeOriginal);assert.equal(JSON.stringify(ctx.current),beforeCurrent);
  const b=cached!;assert.equal(b.receipt.currentAdditionsPreserved,43);assert.equal(b.witness.beforeSha256,'95a6f68a5df5636314dc9ded65d23b21bb30a0807a2b86151ca8f8642b74b438');assert.equal(b.witness.afterSha256,'89786a50872bca22703314305e8a6e039ad13ac1fd01bd120bc711c24daa9daa');
  assert.ok(!JSON.stringify(b.receipt).includes('Users'));assert.ok(!JSON.stringify(b.receipt).includes('../'));
  const lane=b.originalBaseline.lanes.find(l=>l.id===b.witness.id)!;lane.points[10]![1]+=1;
  assert.notDeepEqual(lane,b.currentBaseline.lanes.find(l=>l.id===lane.id));
  const fresh=inheritedRoadHeightBaselines(b.authority,ctx.original,ctx.current,[]);assert.deepEqual(fresh.originalBaseline.lanes.find(l=>l.id===lane.id),fresh.currentBaseline.lanes.find(l=>l.id===lane.id));
  assert.throws(()=>inheritedRoadHeightBaselines(JSON.parse(JSON.stringify(b.authority)),ctx.original,ctx.current,[]),/Unrecognized/);
});

test('Y, XZ, width, length, IDs, source, topology and current A edits do not become another approved baseline',{skip:!available},()=>{
  const b=loaded();
  for(const mutate of[(l:any)=>l.points[10][1]+=.001,(l:any)=>l.points[10][0]+=.001,(l:any)=>l.width+=.01,(l:any)=>l.length+=.01,(l:any)=>l.id='another-case',(l:any)=>l.wayId++,(l:any)=>l.from='nother']){
    const altered=structuredClone(ctx.original);mutate(altered.lanes.find(l=>l.id==='59804323:0:f0'));assert.throws(()=>inheritedRoadHeightBaselines(b.authority,altered,ctx.current,[]),/another ORIGINAL/);
    assert.throws(()=>readReviewedInheritedRoadHeight(approval,{...ctx,original:altered}),/before lane changed/);
  }
  const current=structuredClone(ctx.current),addition=current.lanes.find(l=>!ctx.original.lanes.some(o=>o.id===l.id))!;assert.ok(addition);(addition as any).speedLimit+=1;
  assert.throws(()=>inheritedRoadHeightBaselines(b.authority,ctx.original,current,[]),/another CURRENT/);
  assert.throws(()=>readReviewedInheritedRoadHeight(approval,{...ctx,current}),/actual CURRENT/);
  for(const otherRegistrationIds of [['59804323:0:f0'],['other','other']]){
    assert.throws(()=>readReviewedInheritedRoadHeight(approval,{...ctx,otherRegistrationIds}),/overlaps|Duplicate/);
    assert.throws(()=>inheritedRoadHeightBaselines(b.authority,ctx.original,ctx.current,otherRegistrationIds),/overlaps|Duplicate/);
  }
  assert.throws(()=>readReviewedInheritedRoadHeight(approval,{...ctx,sourcePins:{...ctx.sourcePins,osmSha256:'0'.repeat(64)}}));
  assert.throws(()=>readReviewedInheritedRoadHeight(approval,{...ctx,provenanceArchive:{...ctx.provenanceArchive,sha256:'0'.repeat(64)}}),/provenance/);
  assert.throws(()=>readReviewedInheritedRoadHeight(approval,{...ctx,currentWorld:{...ctx.currentWorld,manifestSha256:'0'.repeat(64)}}));
});

test('exact original native collision bytes remain mandatory at construction and authority reuse',{skip:!available},()=>{
  const b=loaded(),lane=inheritedRoadHeightBaselines(b.authority,ctx.original,ctx.current,[]).currentBaseline.lanes.find(l=>l.id===b.witness.id)!,batch=probes(),manifest=JSON.parse(fs.readFileSync(sourceFile(ctx.currentWorld.directory,'manifest.json'),'utf8')),selected=manifest.cells.find((c:any)=>c.id==='c_p01_p05'),needle=selected.collision.path.split('/').at(-1),open=fs.openSync,read=fs.readSync,close=fs.closeSync,targets=new Set<number>();let changed=false;
  try{
    (fs as any).openSync=(file:any,...args:any[])=>{const fd=(open as any)(file,...args);if(String(file).endsWith(needle))targets.add(fd);return fd;};
    (fs as any).readSync=(fd:number,buffer:Buffer,offset:number,length:number,position:any)=>{const n=(read as any)(fd,buffer,offset,length,position);if(targets.has(fd)&&n>0&&!changed){buffer[offset]=buffer[offset]!^1;changed=true;}return n;};
    (fs as any).closeSync=(fd:number)=>{targets.delete(fd);return close(fd);};
    assert.throws(()=>readReviewedInheritedRoadHeight(approval,ctx),/input changed/);assert.equal(changed,true);
    changed=false;assert.throws(()=>qualifyReviewedInheritedLegacyProbes(b.authority,{lane,currentWorld:ctx.currentWorld,otherRegistrationIds:[],probes:batch}),/input changed/);assert.equal(changed,true);
  }finally{fs.openSync=open;fs.readSync=read;fs.closeSync=close;}
});

test('the complete190 body plus8 nominal failed probes receive a separate disposition without altering failures',{skip:!available},()=>{
  const b=loaded(),lane=inheritedRoadHeightBaselines(b.authority,ctx.original,ctx.current,[]).currentBaseline.lanes.find(l=>l.id===b.witness.id)!,batch=probes(),before=JSON.stringify(batch);
  const disposition=qualifyReviewedInheritedLegacyProbes(b.authority,{lane,currentWorld:ctx.currentWorld,otherRegistrationIds:[],probes:batch});
  assert.equal(JSON.stringify(batch),before);assert.equal(disposition.failedBodyProbesRetained,190);assert.equal(disposition.failedNominalProbesRetained,8);assert.equal(disposition.ordinaryResultStillFailed,true);assert.equal(disposition.ordinaryHeightToleranceMetres,.2);
  const fresh=[...batch].reverse();assert.deepEqual(qualifyReviewedInheritedLegacyProbes(b.authority,{lane,currentWorld:ctx.currentWorld,otherRegistrationIds:[],probes:fresh}),disposition);
});

test('legacy disposition rejects missing, extra, duplicate, rehashed moved, recategorized and other-record probes or stale floor',{skip:!available},()=>{
  const b=loaded(),lane=inheritedRoadHeightBaselines(b.authority,ctx.original,ctx.current,[]).currentBaseline.lanes.find(l=>l.id===b.witness.id)!,base={lane,currentWorld:ctx.currentWorld,otherRegistrationIds:[]};
  for(const mutate of[(p:InheritedLegacyProbe[])=>p.pop(),(p:InheritedLegacyProbe[])=>p.push(p[0]!), (p:InheritedLegacyProbe[])=>{p[1]=structuredClone(p[0]!);},(p:InheritedLegacyProbe[])=>{p[0]!.point[1]+=.000001;p[0]!.sampleIdentity=inheritedLegacyProbeIdentity(p[0]!);},(p:InheritedLegacyProbe[])=>{p[0]!.kind=p[0]!.kind==='bodyCollision'?'laneWidthCollision':'bodyCollision';p[0]!.sampleIdentity=inheritedLegacyProbeIdentity(p[0]!);},(p:InheritedLegacyProbe[])=>{p[0]!.recordId='another-case';},(p:InheritedLegacyProbe[])=>{p[0]!.point[0]=Infinity;}]){const batch=probes();mutate(batch);assert.throws(()=>qualifyReviewedInheritedLegacyProbes(b.authority,{...base,probes:batch}));}
  const modified=structuredClone(lane);modified.points[10]![1]+=.001;assert.throws(()=>qualifyReviewedInheritedLegacyProbes(b.authority,{...base,lane:modified,probes:probes()}),/exact reviewed after/);
  assert.throws(()=>qualifyReviewedInheritedLegacyProbes(b.authority,{...base,probes:probes(),otherRegistrationIds:[lane.id]}),/overlaps/);
  assert.throws(()=>qualifyReviewedInheritedLegacyProbes(b.authority,{...base,probes:probes(),currentWorld:{...ctx.currentWorld,manifestSha256:'0'.repeat(64)}}));
  assert.throws(()=>qualifyReviewedInheritedLegacyProbes(b.authority,{...base,probes:probes(),currentWorld:{...ctx.currentWorld,directory:ctx.originalWorld.directory}}),/another serialized floor/);
});
