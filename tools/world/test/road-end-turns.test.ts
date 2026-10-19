import {test} from 'node:test';
import assert from 'node:assert/strict';
import {sourceCutRoadEnds} from '../lib/road-end-turns.ts';
const classes=new Set(['secondary','service','unclassified']);
const way=(id:number,nodes:number[],tags:Record<string,string>={})=>({type:'way',id,nodes,tags:{highway:'secondary',...tags}});

test('an excluded source bridge continuation cannot become a synthetic dead-end reversal',()=>{
  const approach=way(24467093,[265983298,281170163,30555903]);
  const bridge=way(24336449,[30555903,13181128190,264006705],{bridge:'yes',layer:'1'});
  assert.deepEqual(sourceCutRoadEnds([approach,bridge],classes,[approach],new Set([24336449])),[
    {nodeId:30555903,retainedWayId:24467093,unsupportedWayIds:[24336449]},
  ]);
});

test('a true driveway end with only a pedestrian continuation keeps its existing turnaround',()=>{
  const driveway=way(177536271,[1371700237,1420465678,1879613976],{highway:'service',service:'driveway'});
  const footpath=way(697756591,[1879613976,5607518657,1425702156],{highway:'footway'});
  assert.deepEqual(sourceCutRoadEnds([driveway,footpath],classes,[driveway],new Set()),[]);
  assert.deepEqual(sourceCutRoadEnds([driveway,footpath],classes,[driveway],new Set([697756591])),[]);
});

test('retained continuations, real vehicle junctions and access-only filtering do not create source-cut ends',()=>{
  const a=way(1,[1,2]),b=way(2,[2,3]),branch=way(3,[4,2]);
  assert.deepEqual(sourceCutRoadEnds([a,b],classes,[a,b],new Set([2])),[]);
  assert.deepEqual(sourceCutRoadEnds([a,b,branch],classes,[a,branch],new Set([2])),[]);
  assert.deepEqual(sourceCutRoadEnds([a,way(2,[2,3],{access:'private'})],classes,[a],new Set()),[]);
});
