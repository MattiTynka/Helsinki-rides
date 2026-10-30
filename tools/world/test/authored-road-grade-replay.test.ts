import test from 'node:test';
import assert from 'node:assert/strict';
import type {GroundPiece} from '../lib/ground.ts';
import {replayAuthoredRoadGradeDelta} from '../lib/authored-road-grade-replay.ts';
const piece = (tag = 'road:asphalt', y = -1): GroundPiece => ({cell:'c_p00_p01',finish:'asphalt',level:tag.startsWith('road:')?'road':'raised',tag,positions:[2,y,132,4,y,132,2,y,134],indices:[0,1,2],uvs:[0,0,1,0,0,1]});
const shifted = (p: GroundPiece) => ({...structuredClone(p),positions:p.positions.map((v,i)=>i%3===1?v+.25:v)});
test('replays exact native metadata and complete floor/curb coincidence closure',()=>{
  const original={pieces:[piece(),piece('raised:asphalt',-.88)],kerbs:[piece('curb',-.94)]},candidate={pieces:original.pieces.map(shifted),kerbs:original.kerbs.map(shifted)};
  const result=replayAuthoredRoadGradeDelta(original,candidate,{pieces:[0,1],kerbs:[0]});assert.equal(result.changes.length,3);assert.equal(result.coincidentGroups.length,3);assert.ok(result.coincidentGroups.every(g=>g.references===3&&g.delta===.25));assert.equal(result.nativeIndicesUVsFinishesAndCoincidentOffsetsPreserved,true);
});
test('rejects omitted coincident outside pieces, changed curb offsets and separated levels',()=>{
  const original={pieces:[piece(),piece('raised:asphalt',-.88)],kerbs:[]};
  assert.throws(()=>replayAuthoredRoadGradeDelta(original,{pieces:[shifted(original.pieces[0]!)],kerbs:[]},{pieces:[0],kerbs:[]}),/omitted a coincident/);
  const changed={pieces:original.pieces.map(shifted),kerbs:[]};changed.pieces[1]!.positions[1]!+=.01;assert.throws(()=>replayAuthoredRoadGradeDelta(original,changed,{pieces:[0,1],kerbs:[]}),/offsets differ/);
  const levels={pieces:[piece(),piece('raised:asphalt',4)],kerbs:[]};assert.throws(()=>replayAuthoredRoadGradeDelta(levels,{pieces:levels.pieces.map(shifted),kerbs:[]},{pieces:[0,1],kerbs:[]}),/separated physical level/);
});
test('rejects changed horizontal positions, indices, UVs and unrelated finish metadata',()=>{
  const original={pieces:[piece()],kerbs:[]};
  for(const mutate of[(p:GroundPiece)=>{p.positions[0]!+=.001;},(p:GroundPiece)=>{p.indices[0]=2;},(p:GroundPiece)=>{p.uvs[0]=.2;},(p:GroundPiece)=>{(p as {tag:string}).tag='road:gravel';}]){const p=shifted(original.pieces[0]!);mutate(p);assert.throws(()=>replayAuthoredRoadGradeDelta(original,{pieces:[p],kerbs:[]},{pieces:[0],kerbs:[]}));}
});
