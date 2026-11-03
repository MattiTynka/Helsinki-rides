import assert from 'node:assert/strict';
import {test} from 'node:test';
import {summarizeFlightFrames} from '../lib/flight-smoothness.mjs';
const options={expectedDurationMs:2000};
function capture(){return {start:100,end:2100,startFrameTime:100,finalFrameTime:2100,error:null,
  frames:Array.from({length:125},(_,i)=>({t:116+i*16,ms:16})),
  samples:Array.from({length:9},(_,i)=>({t:100+i*250,tick:i*15,player:{position:[0,100,i*20],mode:'flying',alive:true,speed:80},aircraft:{crashed:false,grounded:false}}))};}
test('flight qualification requires real progress and both frame/sample boundaries',()=>{
  assert.equal(summarizeFlightFrames(capture(),options).status,'PASS');
  for(const mutate of [d=>d.samples.pop(),d=>d.samples.shift(),d=>d.samples[4].tick=d.samples[3].tick,
    d=>d.frames.splice(0),d=>d.frames.shift(),d=>d.frames.pop(),d=>d.frames.splice(30,1),
    d=>d.frames[3].t=d.frames[2].t,d=>d.end=1500,d=>d.error='collector failed']){
    const d=capture();mutate(d);assert.equal(summarizeFlightFrames(d,options).status,'FAIL');
  }
});
test('a rare large freeze fails the maximum even when p99 remains smooth',()=>{
  const d=capture();d.frames[20].ms=500;for(let i=20;i<d.frames.length;i++)d.frames[i].t+=484;d.finalFrameTime+=484;d.end+=484;
  const result=summarizeFlightFrames(d,options);assert.equal(result.p99Ms,16);assert.equal(result.framesOver100,1);
  assert.equal(result.gates.maximumFrame,false);assert.equal(result.status,'FAIL');
});
test('a freeze in the unfinished last frame fails even before another presentation',()=>{
  const d=capture();d.end+=300;d.samples.push({...d.samples.at(-1),t:d.end,tick:138});
  const result=summarizeFlightFrames(d,options);assert.equal(result.unfinishedFrameMs,300);assert.equal(result.maximumMs,300);
  assert.equal(result.gates.frameP99,true);assert.equal(result.gates.maximumFrame,false);assert.equal(result.status,'FAIL');
  d.frames=d.frames.slice(0,62);d.finalFrameTime=d.frames.at(-1).t;
  assert.equal(summarizeFlightFrames(d,options).status,'FAIL','a truncated smooth prefix cannot hide the unpresented tail');
});
test('a crashed or grounded aircraft and incomplete flight cannot certify smooth flight',()=>{
  for(const mutate of [d=>d.samples.at(-1).aircraft.crashed=true,d=>d.samples.at(-1).aircraft.grounded=true,
    d=>d.samples.at(-1).player.speed=0,d=>d.samples.at(-1).player.mode='onFoot',d=>d.samples.at(-1).player.position=[0,100,0]]){
    const d=capture();mutate(d);assert.equal(summarizeFlightFrames(d,options).status,'FAIL');
  }
});
