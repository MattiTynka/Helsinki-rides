import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {decodeRoadGraph, type RoadGraph} from '../../../packages/world-schema/src/index.ts';
import {decodeDeliverySimulation} from '../lib/delivery-city-payloads.ts';
import {sourceFile,readSourceFile,sourceSha256} from '../lib/source-files.ts';
import {pointInPolygon} from '../lib/geometry.ts';
import type {InheritedHeightContext} from '../lib/reviewed-inherited-road-height.ts';
import {readReviewedInheritedWalkingDrains as readAuthority,inheritedWalkingDrainBaselines as baselines,assertReviewedInheritedWalkingDrainAfter as assertAfter,qualifyReviewedInheritedWalkingDrainSources as sources,qualifyReviewedInheritedWalkingDrainEdges as edges,type ReviewedInheritedWalkingDrainsAuthority as Authority} from '../lib/reviewed-inherited-walking-drains.ts';
import {withCorruptedRead} from './inherited-height-bundle-fixture.ts';
const file='../evidence/inherited-walking-drains-root-approval-v2.json',available=fs.existsSync(file),hash=(v:unknown)=>sourceSha256(JSON.stringify(v));
function fixture(){
  const bytes=fs.readFileSync(file),approval=JSON.parse(bytes.toString()),graph=(world:{directory:string})=>{const m=JSON.parse(fs.readFileSync(sourceFile(world.directory,'manifest.json'),'utf8'));return decodeRoadGraph(decodeDeliverySimulation(readSourceFile(world.directory,m.roads),m.roads));};
  const context:InheritedHeightContext={original:graph(approval.originalWorld),current:graph(approval.currentWorld),originalWorld:approval.originalWorld,currentWorld:approval.currentWorld,sourcePins:{osmSha256:'a6bf71bae890ab60b4249c8546e6b7185ce37c9ede4137e9c4aefbd9a755e65a',streetPartsSha256:'1ac1409cf70cd6c3ad1ab7139fd6f365898d5c654e499616a1892d1b669645b2'},provenanceArchive:approval.provenanceArchive,otherRegistrationIds:[]};
  return{pin:{file,sha256:sourceSha256(bytes)},context,approval,packet:JSON.parse(fs.readFileSync(approval.packet.file,'utf8'))};
}
let f:ReturnType<typeof fixture>,b:ReturnType<typeof readAuthority>;
function loaded(){if(!b){f=fixture();b=readAuthority(f.pin,f.context);}return b;}
test('drains: fabricated tokens, arbitrary approvals and unrelated world successors fail closed',()=>{
  assert.throws(()=>readAuthority({file:'unused',sha256:'0'.repeat(64)},{} as never),/Unapproved/);
  assert.throws(()=>baselines({} as Authority,{} as RoadGraph,{} as RoadGraph,[]),/Unrecognized/);
  assert.throws(()=>sources({} as Authority,{} as never),/Unrecognized/);
  assert.throws(()=>edges({} as Authority,{} as never),/Unrecognized/);
});
test('drains: exact two detached baselines preserve every other original/current record',{skip:!available},()=>{
  const a=loaded();assert.equal(a.witnesses.length,2);assert.equal(a.receipt.currentAdditionsPreserved,43);assert.equal(a.receipt.physical.samples,12045);assert.equal(a.receipt.physical.rawOrdinarySourceFailuresRetained,128);assert.equal(a.receipt.physical.noLegacyFloorException,true);
  for(const[before,after]of [[f.context.original,a.originalBaseline],[f.context.current,a.currentBaseline]]as const)for(const kind of['nodes','lanes','connectors','footways','parking']as const)for(const record of before[kind]){const actual=after[kind].find(r=>r.id===record.id),w=a.witnesses.find(w=>w.kind===kind&&w.id===record.id);if(w)assert.equal(hash(actual),w.afterSha256);else assert.deepEqual(actual,record);}
  assert.ok(!JSON.stringify(a.receipt).includes('../')&&!JSON.stringify(a.receipt).includes('Users'));
  const after=a.originalBaseline.footways.find(r=>r.id===a.witnesses[0]!.id)!;(after.points[0]as number[])[1]=after.points[0]![1]+1;
  assert.notDeepEqual(after,a.currentBaseline.footways.find(r=>r.id===after.id));assert.deepEqual(baselines(a.authority,f.context.original,f.context.current,[]).currentBaseline,a.currentBaseline);
  assert.throws(()=>baselines(JSON.parse(JSON.stringify(a.authority)),f.context.original,f.context.current,[]),/Unrecognized/);
});
test('drains: exact AFTER and disjoint ownership reject Y/XZ/metadata/identity substitutions',{skip:!available},()=>{
  const a=loaded(),record=a.currentBaseline.footways.find(r=>r.id===a.witnesses[0]!.id)!;assert.deepEqual(assertAfter(a.authority,record,[]),a.witnesses[0]);
  for(const mutate of [(r:any)=>r.points[2][1]+=.000001,(r:any)=>r.points[2][0]+=.000001,(r:any)=>r.points.splice(2,0,[...r.points[2]]),(r:any)=>r.id='w123812256',(r:any)=>r.extra=true]){const changed=structuredClone(record);mutate(changed);assert.throws(()=>assertAfter(a.authority,changed,[]),/Exact reviewed|Unlisted/);}
  assert.throws(()=>assertAfter(a.authority,record,[record.id]),/overlaps/);assert.throws(()=>baselines(a.authority,f.context.original,f.context.current,['duplicate','duplicate']),/Duplicate/);
  const current=structuredClone(f.context.current),addition=current.lanes.find(r=>!f.context.original.lanes.some(o=>o.id===r.id))!;(addition as any).width+=.01;
  assert.throws(()=>baselines(a.authority,f.context.original,current,[]),/another CURRENT/);
  assert.throws(()=>readAuthority(f.pin,{...f.context,sourcePins:{...f.context.sourcePins,osmSha256:'0'.repeat(64)}}));
  assert.throws(()=>readAuthority(f.pin,{...f.context,currentWorld:{...f.context.currentWorld,manifestSha256:'0'.repeat(64)}}),/Unreviewed drain floor/);
});
test('drains: source grant stays clipped to the exact record, with original municipal subtype',{skip:!available},()=>{
  const a=loaded();for(const c of f.packet.cases){const record=a.currentBaseline.footways.find(r=>r.id===c.id)!,input={record,currentWorld:f.context.currentWorld,sourcePins:f.context.sourcePins,otherRegistrationIds:[]};const grant=sources(a.authority,input);
    assert.ok(grant.parts.length>0);for(const p of grant.parts){assert.equal(p.properties.paatyyppi,'Varusteet');assert.equal(p.properties.alatyyppi,'Pintavesikourut');}
    for(const failed of c.physical.failures)assert.ok(grant.parts.some(p=>pointInPolygon([failed.point[0],-failed.point[2]],p.rings)));
    const raw=c.reviewedClippedDrainSourceEligibility.drain;assert.ok(raw.rings.flat().some((q:[number,number])=>!grant.parts.some(p=>pointInPolygon(q,p.rings))),'Full feature must not be admitted');
    grant.parts[0]!.rings[0]![0]![0]+=100;const again=sources(a.authority,input);assert.notDeepEqual(grant.parts,again.parts);
    assert.throws(()=>sources(a.authority,{...input,record:{...record,id:'w1533067599'}}),/Unlisted/);assert.throws(()=>sources(a.authority,{...input,sourcePins:{...input.sourcePins,streetPartsSha256:'0'.repeat(64)}}));
  }
});
test('drains: the two exact edge-ray exceptions require the complete ordered batch',{skip:!available},()=>{
  const a=loaded(),record=a.currentBaseline.footways.find(r=>r.id==='w123812255')!,certificates=f.approval.numericDisposition.certificates;
  const d=edges(a.authority,{record,certificates,otherRegistrationIds:[]});assert.equal(d.ordinaryStrictRayIdentityFailuresRetained,2);assert.equal(d.sameNormalClaim,false);
  for(const changed of [certificates.slice(0,1),[...certificates].reverse(),[certificates[0],certificates[0]],certificates.map((v:any,i:number)=>i?{...v,pointFloat32:[v.pointFloat32[0]+.001,v.pointFloat32[1]]}:v)])assert.throws(()=>edges(a.authority,{record,certificates:changed,otherRegistrationIds:[]}));
  assert.throws(()=>edges(a.authority,{record:a.currentBaseline.footways.find(r=>r.id==='w1442691114')!,certificates,otherRegistrationIds:[]}));
});
test('drains: only the 74 explicitly named previously-invalid placements are disclosed',{skip:!available},()=>{
  const a=loaded();assert.equal(a.receipt.newlyValidPlacements.length,1);assert.equal(a.receipt.newlyValidPlacements[0].recordId,'w1442691114');assert.equal(a.receipt.newlyValidPlacements[0].stations.length,74);assert.deepEqual(a.receipt.newlyValidPlacements[0].stations,f.packet.cases[1].raySummary.newlyValid.map((v:any)=>v.station));assert.equal(a.receipt.finiteRegression.rays,620);assert.equal(a.receipt.finiteRegression.ticks,3724);
});
test('drains: tampered native floor, terrain, raw source, trace or historical producer rejects at use',{skip:!available},()=>{
  const a=loaded(),m=JSON.parse(fs.readFileSync(f.context.currentWorld.directory+'/manifest.json','utf8')),cell=m.cells.find((c:any)=>c.id===f.packet.cases[0].oldAndCurrentFloor.current[0].cell),mapping=JSON.parse(fs.readFileSync(f.approval.provenanceArchive.file,'utf8')),archiveDir=f.approval.provenanceArchive.file.replace(/[/\\][^/\\]+$/,'');
  for(const input of [f.context.currentWorld.directory+'/'+cell.collision.path,f.context.currentWorld.directory+'/'+m.terrain.path,f.packet.sourceInputs[0].file,f.packet.cases[0].nativeRuns[0].before.trace.file,archiveDir+'/'+mapping.files[0].path])withCorruptedRead(input,()=>assert.throws(()=>a.verifyInputs(),/input changed/));
});
