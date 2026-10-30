import assert from 'node:assert/strict';
import test from 'node:test';
import type {RoadGraph} from '../../../packages/world-schema/src/index.ts';
import {registeredRetainedRoadBaseline, prepareRetainedRoadRegistrations, type RetainedRoadAuthority} from '../lib/retained-road-review-context.ts';
import {assertOutsideOnlyRoadGraphRepair} from '../lib/road-outside-repair.ts';

const graph: RoadGraph = {schemaVersion:2,originId:'fixture',source:{id:'source',sha256:'a'.repeat(64),attribution:'Fixture',license:'CC0'},nodes:[],lanes:[{id:'122961573:0:f0',wayId:122961573,from:'n1',to:'n2',index:0,count:1,width:3,length:10,points:[[-1790,2,0],[-1800,2,0]],name:'Itameri',highway:'tertiary',surface:'asphalt',speedLimit:8}],connectors:[],parking:[],footways:[]};
const coverage = {playArea:{minX:-1792,maxX:800,minZ:-2304,maxZ:768}};
test('a plain map, receipt, clone or fabricated object cannot authorize an accepted XZ edit',()=>{
  const edited=structuredClone(graph);(edited.lanes[0] as any).points=[[-1790,2,0],[-1792,2,0],[-1796,2,-.05],[-1800,2,0]];
  assert.throws(()=>assertOutsideOnlyRoadGraphRepair(graph,edited,coverage),/original XZ vertex|source XZ polyline/);
  for(const forged of [{},new Map([[graph.lanes[0]!.id,edited.lanes[0]]]),{kind:'recomputed-retained-road-registrations',bindings:[]}]){
    assert.throws(()=>registeredRetainedRoadBaseline(forged as RetainedRoadAuthority,graph,coverage),/Unrecognized retained-road authority/);
    assert.throws(()=>assertOutsideOnlyRoadGraphRepair(graph,edited,coverage,forged as RetainedRoadAuthority),/Unrecognized retained-road authority/);
  }
});
test('the authority constructor rejects absent or multiple approvals before reading inputs',()=>{
  const unread=()=>{throw new Error('Unexpected input read');};
  for(const bindings of [[],[{},{ }]])assert.throws(()=>prepareRetainedRoadRegistrations(bindings as any,{read:unread} as any),/Exactly one reviewed/);
});
test('unregistered outside-Y repairs retain their original behavior and accounting',()=>{
  const edited=structuredClone(graph);(edited.lanes[0] as any).points=[[-1790,2,0],[-1792,2,0],[-1800,2.1,0]];
  const changes=assertOutsideOnlyRoadGraphRepair(graph,edited,coverage);
  assert.equal(changes.length,1);assert.equal(changes[0]!.id,graph.lanes[0]!.id);assert.equal(changes[0]!.acceptedPiecewiseGeometryPreserved,true);
});
