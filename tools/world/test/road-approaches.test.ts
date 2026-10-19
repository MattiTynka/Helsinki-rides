import assert from 'node:assert/strict';
import { test } from 'node:test';
import { unsupportedRoadApproaches } from '../lib/road-approaches.ts';

const classes = new Set(['service', 'residential', 'unclassified']);
const way = (id: number, nodes: number[], tags: Record<string, string> = {}) => ({type:'way',id,nodes,tags:{highway:'service',...tags}});

test('parking portal excludes its approach chain but stops at a public junction', () => {
  const result = unsupportedRoadApproaches([
    {type:'node',id:1,tags:{amenity:'parking_entrance',parking:'underground'}},
    way(10,[0,1],{tunnel:'yes',layer:'-1'}), way(11,[1,2]), way(12,[2,3]),
    way(13,[3,4],{highway:'residential'}),way(14,[5,3],{highway:'residential'}),
  ],classes);
  assert.deepEqual(result.map(r=>r.wayId),[11,12]);
  assert.equal(result[0]!.connectedWayId,10);
});

test('a tunnel entrance node on a through street does not remove that street', () => {
  assert.deepEqual(unsupportedRoadApproaches([way(1,[1,2],{tunnel:'yes'}),way(2,[2,3],{highway:'residential'}),way(3,[4,2],{highway:'residential'})],classes),[]);
});

test('isolated building passage approach and a gated driveway are not through routes', () => {
  assert.deepEqual(unsupportedRoadApproaches([
    way(1,[1,2],{tunnel:'building_passage'}),way(2,[2,3],{service:'driveway'}),
    {type:'node',id:5,tags:{barrier:'gate'}},way(3,[4,5,6],{service:'driveway'}),
    way(4,[7,8],{service:'driveway'}),
  ],classes).map(r=>r.wayId),[2,3]);
});

test('surface parking entrances and explicitly open gates preserve their access roads', () => {
  assert.deepEqual(unsupportedRoadApproaches([
    {type:'node',id:1,tags:{amenity:'parking_entrance',parking:'surface'}},way(1,[1,2]),
    {type:'node',id:3,tags:{barrier:'gate',access:'yes'}},way(2,[3,4],{service:'driveway'}),
  ],classes),[]);
});

test('closed parking approach counts a repeated endpoint once and preserves the public junction', () => {
  const result = unsupportedRoadApproaches([
    {type:'node',id:1,tags:{amenity:'parking_entrance',parking:'underground'}},
    way(10,[1,2,3,1]), way(11,[2,4],{highway:'residential'}),
    way(12,[5,2],{highway:'residential'}),
  ],classes);
  assert.deepEqual(result.map(r=>r.wayId),[10]);
});

test('a ferry boarding spur is excluded while its public junction remains routable', () => {
  const result = unsupportedRoadApproaches([
    {type:'node',id:1,tags:{ferry:'yes',public_transport:'stop_position'}},
    {type:'way',id:90,nodes:[1,100],tags:{route:'ferry',motor_vehicle:'yes'}},
    way(10,[1,2]),way(11,[2,3]),
    way(12,[3,4],{highway:'residential'}),way(13,[5,3],{highway:'residential'}),
  ],classes);
  assert.deepEqual(result.map(row=>row.wayId),[10,11]);
  assert.equal(result[0]!.connectedWayId,90);
});

test('a ferry stop on a through street or a service road without a ferry route stays available', () => {
  const stop={type:'node',id:1,tags:{ferry:'yes'}};
  const ferry={type:'way',id:90,nodes:[1,100],tags:{route:'ferry'}};
  assert.deepEqual(unsupportedRoadApproaches([stop,ferry,way(10,[1,2]),way(11,[3,1])],classes),[]);
  assert.deepEqual(unsupportedRoadApproaches([stop,ferry,way(10,[1,2],{highway:'residential'})],classes),[]);
  assert.deepEqual(unsupportedRoadApproaches([stop,way(10,[1,2])],classes),[]);
});

test('underground parking propagates through an unnamed unclassified ramp to its public junction', () => {
  const result = unsupportedRoadApproaches([
    {type:'node',id:1,tags:{amenity:'parking_entrance',parking:'underground'}},
    way(10,[0,1],{tunnel:'yes',layer:'-2'}),
    way(11,[1,2],{highway:'unclassified',maxheight:'3.8'}),
    way(12,[2,3],{highway:'unclassified'}),
    way(13,[3,4],{highway:'unclassified',lanes:'3'}),
    way(14,[4,5],{highway:'unclassified'}),
    way(15,[5,6],{highway:'unclassified'}),
    way(16,[7,5],{highway:'residential',name:'Public street'}),
  ],classes);
  assert.deepEqual(result.map(row=>row.wayId),[11,12,13,14]);
  assert.deepEqual(result.map(row=>row.connectedWayId),[10,11,12,13]);
  assert.equal(result.at(-1)!.nodeId,4);
});

test('underground propagation preserves named unclassified streets in every language', () => {
  const names: Record<string,string>[] = [{name:'Road'},{'name:fi':'Katu'},{'name:sv':'Gatan'},{'name:se':'Geaidnu'},{ref:'100'}];
  for (const name of names) {
    const result = unsupportedRoadApproaches([
      {type:'node',id:1,tags:{amenity:'parking_entrance',parking:'underground'}},
      way(10,[0,1],{tunnel:'yes'}),way(11,[1,2]),
      way(12,[2,3],{highway:'unclassified',...name}),
    ],classes);
    assert.deepEqual(result.map(row=>row.wayId),[11]);
  }
});

test('unnamed unclassified propagation is not inferred from a ferry or another tunnel', () => {
  const ramp=way(12,[2,3],{highway:'unclassified'});
  assert.deepEqual(unsupportedRoadApproaches([
    way(10,[0,1],{tunnel:'building_passage'}),way(11,[1,2]),ramp,
  ],classes).map(row=>row.wayId),[11]);
  assert.deepEqual(unsupportedRoadApproaches([
    {type:'node',id:1,tags:{ferry:'yes'}},
    {type:'way',id:10,nodes:[0,1],tags:{route:'ferry'}},way(11,[1,2]),ramp,
  ],classes).map(row=>row.wayId),[11]);
});
