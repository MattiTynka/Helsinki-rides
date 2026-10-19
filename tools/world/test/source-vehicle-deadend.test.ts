import assert from 'node:assert/strict';
import {readFileSync}from 'node:fs';
import test from 'node:test';
import {sourceVehicleDeadEnd,type VehicleDeadEndTrim}from '../lib/source-vehicle-deadend.ts';

const fixture=JSON.parse(readFileSync(new URL('./fixtures/source-road-registration.json',import.meta.url),'utf8')) as{
 deadEndElements:{type:string;id:number;nodes:number[];tags:Record<string,string>}[];
 declarations:{vehicleDeadEndTrims:VehicleDeadEndTrim[]};
};
const declaration=fixture.declarations.vehicleDeadEndTrims[0]!,classes=new Set(['living_street','residential','service']);

test('actual northern planting trim preserves all source motor driveways and legal tags',()=>{
 const before=JSON.stringify(fixture.deadEndElements),result=sourceVehicleDeadEnd(fixture.deadEndElements,declaration,classes),raw=fixture.deadEndElements.find(e=>e.id===22505405)!;
 assert.deepEqual(result.removedNodeIds,[25470397]);assert.equal(result.nodes[0],8879808377);
 assert.ok(result.nodes.includes(9580495095));assert.ok(result.nodes.includes(471408589));
 assert.equal(result.rawTags.highway,'living_street');assert.equal(result.rawTags.access,undefined);
 assert.deepEqual(result.nodes,raw.nodes.slice(1));assert.equal(JSON.stringify(fixture.deadEndElements),before);
 assert.deepEqual(result.pedestrianConnections.map(e=>e.wayId).sort((a,b)=>a-b),[138982503,959744724]);
});

test('dead-end trim rejects any removed motor connection including tagged-private access',()=>{
 const extra={type:'way',id:123,nodes:[25470397,888],tags:{highway:'service',access:'private'}};
 assert.throws(()=>sourceVehicleDeadEnd([...fixture.deadEndElements,extra],declaration,classes),/motor-road connection/);
 assert.throws(()=>sourceVehicleDeadEnd(fixture.deadEndElements,{...declaration,stopNodeId:471408589},classes),/motor-road connection/);
});

test('dead-end trim cannot drop the whole street or infer pedestrian access from missing data',()=>{
 assert.throws(()=>sourceVehicleDeadEnd(fixture.deadEndElements,{...declaration,stopNodeId:1375811124},classes),/interior source node/);
 assert.throws(()=>sourceVehicleDeadEnd(fixture.deadEndElements,{...declaration,sourceEndpointNodeId:123},classes),/source node/);
 assert.throws(()=>sourceVehicleDeadEnd(fixture.deadEndElements.filter(e=>e.id===22505405),declaration,classes),/positive source pedestrian/);
});
