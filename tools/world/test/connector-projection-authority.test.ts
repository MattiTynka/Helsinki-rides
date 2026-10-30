import assert from 'node:assert/strict';
import test from 'node:test';
import {polylineLength,type RoadGraph,type RoadLane,type Vec3} from '../../../packages/world-schema/src/index.ts';
import {repairNewStraightConnectorOvershoot} from '../lib/road-connector-repair.ts';
import {verifyConnectorProjectionRepair} from '../lib/connector-projection-authority.ts';
import {sourceSha256} from '../lib/source-files.ts';
const hash=(v:unknown)=>sourceSha256(JSON.stringify(v));
function fixture(){
  const lane=(id:string,from:string,to:string,points:Vec3[]):RoadLane=>({id,wayId:1,from,to,points,length:polylineLength(points),name:'',highway:'residential',width:3,index:0,count:1,surface:'asphalt',speedLimit:8});
  const old=lane('1:0:f0','n1','n2',[[-10,0,0],[0,0,0]]),fresh=lane('2:0:f0','n2','n3',[[-.02,0,0],[10,0,0]]),accepted:RoadGraph={schemaVersion:2,originId:'fixture',source:{id:'s',sha256:'a'.repeat(64),license:'fixture',attribution:'fixture'},nodes:[],lanes:[old],connectors:[],footways:[],parking:[]};
  const connector={id:old.id+'>'+fresh.id,from:old.id,to:fresh.id,node:'n2',turn:'straight' as const,points:[[0,0,0],[.1,0,0],[-.1,0,0],[-.02,0,0]]as Vec3[],length:.38},original={...accepted,lanes:[old,fresh],connectors:[connector]},project=()=>({height:0}),result=repairNewStraightConnectorOvershoot(accepted,original,[fresh.id],[connector.id],project);
  return {accepted,original,projected:structuredClone(result.graph),witness:structuredClone(result.witness),newLaneIds:[fresh.id],connectorIds:[connector.id],newFootwayIds:[],project};
}
test('recomputes the exact bounded short-connector repair while recovering source endpoints',()=>{
  const input=fixture(),result=verifyConnectorProjectionRepair(input);assert.deepEqual(result.beforeRepair,input.original);assert.equal(result.receipt.junctions,1);assert.equal(result.receipt.changes,2);assert.notEqual(result.beforeRepair,input.original);
});
test('rejects changed final geometry, stale native height and unused or accepted edit authority',()=>{
  const f=fixture();(f.projected.lanes[1]!.points[0] as number[])[2]=.01;assert.throws(()=>verifyConnectorProjectionRepair(f),/final record drift/);
  assert.throws(()=>verifyConnectorProjectionRepair({...fixture(),project:()=>({height:.1})}),/reproduce/);
  assert.throws(()=>verifyConnectorProjectionRepair({...fixture(),newLaneIds:[]}),/unselected source/);
  const a=fixture();a.accepted={...a.accepted,lanes:a.original.lanes};assert.throws(()=>verifyConnectorProjectionRepair(a),/accepted records/);
});
test('a rehashed forged rollback line still cannot change the reviewed source corridor',()=>{
  const f=fixture(),change=f.witness.changes.find(c=>c.kind==='lanes')!,before=structuredClone(change.before) as RoadLane;
  (before.points[0] as number[])[2]=.02;change.before=before;change.beforeSha256=hash(before);
  assert.throws(()=>verifyConnectorProjectionRepair(f),/horizontal endpoint|horizontal bend|horizontal geometry/);
});
test('unlisted endpoint edits, another connector and larger rehashed trims remain rejected',()=>{
 const unlisted=fixture();(unlisted.projected.lanes[0]!.points.at(-1) as number[])[0]=unlisted.projected.lanes[0]!.points.at(-1)![0]-.01;assert.throws(()=>verifyConnectorProjectionRepair(unlisted));
 const other=fixture();other.witness.changes[1]!.id='different-connector';assert.throws(()=>verifyConnectorProjectionRepair(other),/unselected/);
 const larger=fixture(),change=larger.witness.changes.find(c=>c.kind==='lanes')!,after=structuredClone(change.after)as RoadLane;(after.points[0]as number[])[0]=after.points[0]![0]+.1;(after as {length:number}).length=polylineLength(after.points);change.after=after;change.afterSha256=hash(after);(larger.projected.lanes as RoadLane[])[1]=structuredClone(after);assert.throws(()=>verifyConnectorProjectionRepair(larger),/reproduce/);
});
