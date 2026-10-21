import assert from 'node:assert/strict';
import {test} from 'node:test';
import {projectPublicCityOsm} from '../lib/delivery-city-osm.ts';
import {roadLaneLayout} from '../lib/road-lane-layout.ts';
import {unsupportedRoadApproaches} from '../lib/road-approaches.ts';
test('public OSM projection preserves road/water topology and removes contributor/contact metadata',()=>{const source:any={elements:[{type:'node',id:1,lat:60.1,lon:24.9,user:'private',uid:99,tags:{barrier:'gate',name:'private node name','contact:email':'private@example.invalid'}},{type:'node',id:2,lat:60.2,lon:24.91},{type:'node',id:3,lat:60.3,lon:24.92},{type:'way',id:4,nodes:[1,2,3,1],tags:{highway:'service',name:'Public street',width:'3.5',email:'private@example.invalid'}},{type:'relation',id:5,members:[{type:'way',ref:4,role:'outer'}],tags:{type:'multipolygon',natural:'water'}}]};const projected=projectPublicCityOsm(source as any);assert.deepEqual(projected.elements.map(e=>[e.type,e.id]),source.elements.map((e:any)=>[e.type,e.id]));assert.equal(projected.elements[0]!.lat,60.1);assert.deepEqual(projected.elements[3]!.nodes,[1,2,3,1]);assert.equal(projected.elements[3]!.tags!.name,'Public street');assert.doesNotMatch(JSON.stringify(projected),/private|contact|uid|user|email/);});
test('projection preserves source lane placement and tram multi-track refusal',()=>{
  const source:any={elements:[{type:'node',id:1,lat:60,lon:24},{type:'node',id:2,lat:60.01,lon:24},{type:'way',id:3,nodes:[1,2],tags:{highway:'primary',oneway:'yes',lanes:'3',placement:'middle_of:2','placement:start':'transition'}},{type:'way',id:4,nodes:[1,2],tags:{railway:'tram',tracks:'2',gauge:'1000'}}]};
  const projected=projectPublicCityOsm(source),road=projected.elements.find(e=>e.id===3)!;
  assert.deepEqual(roadLaneLayout(road.tags!,3),roadLaneLayout(source.elements[2]!.tags!,3));
  assert.notDeepEqual(roadLaneLayout({...road.tags,placement:undefined} as any,3),roadLaneLayout(road.tags!,3));
  assert.equal(projected.elements.find(e=>e.id===4)!.tags!.tracks,'2');
});
test('namespaced street names and references stop inherited garage exclusions',()=>{
  for(const key of ['name:fi','ref','ref:local']){
    const source:any={elements:[{type:'node',id:1,tags:{amenity:'parking_entrance',parking:'underground'}},{type:'node',id:2},{type:'node',id:3},{type:'way',id:4,nodes:[1,2],tags:{highway:'service'}},{type:'way',id:5,nodes:[2,3],tags:{highway:'unclassified',[key]:'Public road'}}]};
    const projected=projectPublicCityOsm(source),drivable=new Set(['service','unclassified']);
    assert.deepEqual(unsupportedRoadApproaches(projected.elements,drivable),unsupportedRoadApproaches(source.elements,drivable));
    assert.deepEqual(unsupportedRoadApproaches(projected.elements,drivable).map(e=>e.wayId),[4]);
  }
});
test('water-body intermittency and salinity survive the public projection',()=>{
  const source:any={elements:[{type:'node',id:1,lat:60,lon:24},{type:'node',id:2,lat:60,lon:24.001},{type:'node',id:3,lat:60.001,lon:24},{type:'way',id:649206604,nodes:[1,2,3,1],tags:{natural:'water',intermittent:'yes',seasonal:'spring',contact:'discard'}},{type:'relation',id:298749,members:[{type:'way',ref:649206604,role:'outer'}],tags:{type:'multipolygon',natural:'water',water:'pond',salt:'no'}}]};
  const output=projectPublicCityOsm(source);assert.deepEqual(output.elements.find(e=>e.id===649206604)!.tags,{natural:'water',intermittent:'yes',seasonal:'spring'});assert.equal(output.elements.find(e=>e.id===298749)!.tags!.salt,'no');assert.doesNotMatch(JSON.stringify(output),/contact|discard/);
});
