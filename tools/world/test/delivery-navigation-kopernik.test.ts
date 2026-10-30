import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {decodeRoadGraph,type GameplayBundle,type RoadGraph,type Vec3} from '../../../packages/world-schema/src/index.ts';
import {readSourceFile} from '../lib/source-files.ts';
import {decodeDeliverySimulation} from '../lib/delivery-city-payloads.ts';
import {readReviewedKopernikRegistration,KOPERNIK_REGISTRATION_APPROVAL,type KopernikRegistrationContext,type ReviewedKopernikRegistration} from '../lib/reviewed-kopernik-registration.ts';
import {assertCurrentPlayableNavigationPreserved as preserve} from '../lib/delivery-navigation-preservation.ts';

const approval={file:'../evidence/kopernikuksentie-registration-root-approval-v1.json',sha256:KOPERNIK_REGISTRATION_APPROVAL};
const available=fs.existsSync(approval.file),ids=['123812227:0:f0','123812227:0:b0'];
let fixture:ReturnType<typeof load>|undefined;
function load(){
  const originalWorld={directory:'../accepted-world/world/senate-20261025-civilian-flee',manifestSha256:'0e18e55e8730f01144eef72a80decffbb53cdd658222f87a7e8ad6f75f2c4260'},currentWorld={directory:'../work/cumulative-city-east-walking-seam-v1/world',manifestSha256:'d453fdd79db114c914322f0209121c34819206b294004bdcece2739f0f3b4701'};
  const readWorld=(w:typeof originalWorld)=>{const m=JSON.parse(fs.readFileSync(w.directory+'/manifest.json','utf8'));return{graph:decodeRoadGraph(decodeDeliverySimulation(readSourceFile(w.directory,m.roads),m.roads)),gameplay:JSON.parse(Buffer.from(decodeDeliverySimulation(readSourceFile(w.directory,m.gameplay),m.gameplay)).toString())as GameplayBundle};};
  const old=readWorld(originalWorld),current=readWorld(currentWorld),sourceMask={file:'../evidence/w29282225-supported-area-source-qualified-v4.json',sha256:'1200b9fe57f38c4a51fd0c536455817ffe0640b102727fd40b551cebb3ea4c80'},mask=JSON.parse(fs.readFileSync(sourceMask.file,'utf8'));
  const context:KopernikRegistrationContext={original:old.graph,current:current.graph,originalWorld,currentWorld,sourceMask,coverage:{playArea:mask.qualification.expanded,supportedArea:mask.supportedArea},sourcePins:{osmSha256:'a6bf71bae890ab60b4249c8546e6b7185ce37c9ede4137e9c4aefbd9a755e65a',streetPartsSha256:'1ac1409cf70cd6c3ad1ab7139fd6f365898d5c654e499616a1892d1b669645b2'},provenanceArchive:{file:'../evidence/kopernikuksentie-root-approval-provenance-v1/mapping.json',sha256:'0042f71771bd7d9e99a7f5d47b8c3dc4413a3ee7b7a6eedaacd94a579b4357b9'},otherRegistrationIds:[],read:(pin,cap=16*1024*1024)=>{const stat=fs.lstatSync(pin.file);assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=cap);return fs.readFileSync(pin.file);}};
  return{context,coverage:current.gameplay,prepared:readReviewedKopernikRegistration(approval,context)};
}
function real(){return fixture??=load();}

test('current preservation cannot consume a fabricated horizontal-registration token',()=>{
  const graph={originId:'fixture',nodes:[],lanes:[],connectors:[],parking:[],footways:[]}as unknown as RoadGraph;
  assert.throws(()=>preserve(graph,graph,{playArea:{minX:0,maxX:10,minZ:0,maxZ:10}},graph,graph,graph,{}as ReviewedKopernikRegistration),/Unrecognized/);
});

test('actual joint Kopernik current guard preserves43A and reports its protected XZ repair honestly',{skip:!available},()=>{
  const{context:c,coverage,prepared:p}=real();
  assert.throws(()=>preserve(c.current,p.currentBaseline,coverage,c.original,p.originalBaseline));
  const proof=preserve(c.current,p.currentBaseline,coverage,c.original,p.originalBaseline,c.current,p.authority);
  assert.equal(proof.earlierExpansionRecordsPreserved,43);assert.equal(proof.reviewedHeightCorrections.length,0);
  assert.deepEqual(proof.reviewedCurrentHorizontalRegistrations.map(r=>r.id),ids);
  assert.equal(proof.continuousCurrentPlayableGeometryPreserved,false);assert.equal(proof.continuousReviewedCurrentPlayableGeometryPreserved,true);
  const edits=[(g:RoadGraph)=>{const at=g.lanes.findIndex(l=>l.id===ids[1]);(g.lanes as RoadGraph['lanes'][number][])[at]=structuredClone(c.current.lanes.find(l=>l.id===ids[1])!);},
    (g:RoadGraph)=>{(g.lanes.find(l=>l.id===ids[0])!.points as Vec3[])[3]![0]+=.001;},
    (g:RoadGraph)=>{const added=g.footways.find(r=>!c.original.footways.some(o=>o.id===r.id))!;(added.points as Vec3[])[0]![1]+=.001;},
    (g:RoadGraph)=>{(g.nodes as unknown[]).pop();}];
  for(const edit of edits){const changed=structuredClone(p.currentBaseline);edit(changed);assert.throws(()=>preserve(c.current,changed,coverage,c.original,p.originalBaseline,c.current,p.authority));}
  assert.throws(()=>preserve(c.current,p.currentBaseline,coverage,c.original,p.originalBaseline,p.currentBaseline,p.authority));
});

test('joint registration composes with a separate height-only preservation fixture',{skip:!available},()=>{
  const{context:c,coverage,prepared:p}=real(),heights=structuredClone(c.current),next=structuredClone(p.currentBaseline);
  const id=c.current.lanes.find(l=>!ids.includes(l.id))!.id;
  const heightLane=heights.lanes.find(l=>l.id===id)!;for(const point of heightLane.points)(point as number[])[1]!+=.001;
  next.lanes[next.lanes.findIndex(l=>l.id===id)]=structuredClone(heightLane);
  // This exercises preservation composition only; the synthetic height record
  // supplies no source/physical authority and is never a world-write fixture.
  const proof=preserve(c.current,next,coverage,c.original,p.originalBaseline,heights,p.authority);
  assert.equal(proof.reviewedHeightCorrections.length,1);assert.equal(proof.reviewedCurrentHorizontalRegistrations.length,2);assert.equal(proof.earlierExpansionRecordsPreserved,43);
  assert.throws(()=>preserve(c.current,next,coverage,c.original,p.originalBaseline,c.current,p.authority));
});
