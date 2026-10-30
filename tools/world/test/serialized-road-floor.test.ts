import test from 'node:test';import assert from 'node:assert/strict';
import {encodeCollisionBundle} from '../../../packages/world-schema/src/index.ts';
import {roadTrianglesFromCollision} from '../lib/serialized-road-floor.ts';
const make=()=>encodeCollisionBundle({originId:'origin',cell:'c_p00_p00',frame:'X-east,Y-up,Z-south',surfaceTags:['road:asphalt','raised:setts','building']},[
  {id:'ground',group:'ground',ref:null,positions:new Float32Array([0,2,0,0,2,1,1,2,0,0,5,0,0,5,1,1,5,0]),indices:new Uint32Array([0,1,2,3,4,5]),triangleTags:new Uint16Array([0,1])},
  {id:'building',group:'buildings',ref:'building',positions:new Float32Array([0,9,0,0,9,1,1,9,0]),indices:new Uint32Array([0,1,2]),triangleTags:new Uint16Array([2])}]);
test('serialized floor keeps distinct authored levels and exact surface identities',()=>{const t=roadTrianglesFromCollision(make(),'c_p00_p00','origin');assert.equal(t.length,2);assert.deepEqual(t.map(t=>[t.tag,t.points[0][1]]),[['road:asphalt',2],['raised:setts',5]]);assert.equal(t[0]!.id,'serialized:c_p00_p00:ground:0');});
test('serialized floor never substitutes another cell or origin',()=>{assert.throws(()=>roadTrianglesFromCollision(make(),'c_p01_p00','origin'));assert.throws(()=>roadTrianglesFromCollision(make(),'c_p00_p00','other'));});
