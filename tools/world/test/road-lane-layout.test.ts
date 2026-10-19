import assert from 'node:assert/strict';
import test from 'node:test';
import {roadLaneLayout} from '../lib/road-lane-layout.ts';

test('two-way single lane is one shared physical corridor with both directions', () => {
  const layout=roadLaneLayout({highway:'residential',lanes:'1'},3);
  assert.deepEqual(layout.offsets,{forward:[0],backward:[0]});
  assert.equal(layout.physicalLanes,1);assert.equal(layout.forward,1);assert.equal(layout.backward,1);
});
test('unlaned service defaults to a shared corridor without losing access directions', () => {
  for(const service of ['driveway','parking_aisle','']){
    const layout=roadLaneLayout({highway:'service',service},3);
    assert.deepEqual(layout.offsets,{forward:[0],backward:[0]});assert.equal(layout.width,3);
  }
  assert.deepEqual(roadLaneLayout({highway:'service',lanes:'2'},3).offsets,{forward:[1.5],backward:[1.5]});
  assert.deepEqual(roadLaneLayout({highway:'service',oneway:'yes'},3).offsets,{forward:[0],backward:[]});
});
test('unlaned living streets retain two directions on one physical corridor',()=>{
 assert.deepEqual(roadLaneLayout({highway:'living_street'},3).offsets,{forward:[0],backward:[0]});
 assert.deepEqual(roadLaneLayout({highway:'living_street',lanes:'2'},3).offsets,{forward:[1.5],backward:[1.5]});
});
test('explicit source width bounds a shared physical corridor, not two widened lanes', () => {
  const layout=roadLaneLayout({highway:'service',width:'2.4 m'},3);
  assert.equal(layout.width,2.4);assert.equal(layout.widthSource,'width');assert.equal(layout.physicalLanes,1);
  // The total width of an ordinary multilane street may include parking; do not
  // reinterpret it as a surveyed driving-lane width without per-lane evidence.
  assert.equal(roadLaneLayout({highway:'residential',width:'10',lanes:'2'},3).width,3);
});
test('source Eteläinen Rautatiekatu placement puts lane one left of its right-edge axis', () => {
  const layout=roadLaneLayout({highway:'secondary',oneway:'yes',lanes:'3',placement:'right_of:1'},3.25);
  assert.deepEqual(layout.offsets.forward,[-1.625,1.625,4.875]);
  assert.deepEqual(layout.appliedPlacements,[{key:'placement',value:'right_of:1'}]);assert.deepEqual(layout.diagnostics,[]);
});
test('left/middle/right placement follows source lane numbering and direction', () => {
  assert.deepEqual(roadLaneLayout({oneway:'yes',lanes:'3',placement:'middle_of:2'},3).offsets.forward,[-3,0,3]);
  assert.deepEqual(roadLaneLayout({oneway:'yes',lanes:'3',placement:'left_of:2'},3).offsets.forward,[-1.5,1.5,4.5]);
  const directional=roadLaneLayout({lanes:'4','lanes:forward':'2','lanes:backward':'2','placement:backward':'middle_of:1'},3);
  assert.deepEqual(directional.offsets,{forward:[1.5,4.5],backward:[0,3]});
});
test('ambiguous and unsupported placement is reported, never guessed or closed', () => {
  const cases:Record<string,string>[]=[{lanes:'3',placement:'right_of:1'},{oneway:'yes',lanes:'3',placement:'transition'},{oneway:'yes',lanes:'2',placement:'right_of:9'},{oneway:'-1',lanes:'2',placement:'left_of:1'}];
  for(const tags of cases){
    const layout=roadLaneLayout(tags,3);assert.equal(layout.diagnostics.length,1);assert.equal(layout.appliedPlacements.length,0);assert.ok(layout.forward+layout.backward>0);
  }
  assert.equal(roadLaneLayout({highway:'service',width:'2;3'},3).diagnostics[0]!.code,'unsupported-width');
  assert.throws(()=>roadLaneLayout({lanes:'1','lanes:forward':'2'},3),/conflicting/);
});
