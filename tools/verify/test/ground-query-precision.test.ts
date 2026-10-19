import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {TriMeshCollider} from '../../../packages/world-schema/src/index.ts';
import {nativeGroundPoint,proveGroundRayEdge} from '../lib/ground-query-precision.ts';

function floor(id:string,minX:number,maxX:number,y=0):TriMeshCollider{return{id,group:'ground',ref:null,positions:Float32Array.from([minX,y,-1,maxX,y,-1,maxX,y,1,minX,y,1]),indices:Uint32Array.from([0,2,1,0,3,2]),triangleTags:new Uint16Array(2)};}
const hit=(y:number)=>({y,surface:{group:'ground'}}),shape=(height:number)=>({height,surface:{group:'ground'}});
test('a coincident cell edge ray miss needs strict mesh support, opposing rays, and centered shape support',()=>{
 const proof=proveGroundRayEdge({colliders:[floor('left',-1,0),floor('right',0,1)],height:()=>0,ray:x=>x===0?null:hit(0),sphere:()=>shape(0),x:0,z:.3});
 assert.equal(proof.pass,true);assert.equal(proof.center,null);assert.equal(proof.triangles.length,2);assert.ok(proof.triangles.every(t=>t.barycentric.some(v=>v===0)));
});
test('a finite 0.2 mm collision gap fails even when neighbouring rays and the sphere bridge it',()=>{
 const proof=proveGroundRayEdge({colliders:[floor('left',-1,-.0001),floor('right',.0001,1)],height:()=>0,ray:x=>Math.abs(x)<.0001?null:hit(0),sphere:()=>shape(0),x:0,z:.3});
 assert.equal(proof.neighbors[0]!.aligned,true);assert.equal(proof.neighbors[1]!.aligned,true);assert.equal(proof.shape?.height,0);assert.equal(proof.meshHeight,null);assert.equal(proof.pass,false);
});
test('a genuinely displaced collider fails even if all collision queries agree with one another',()=>{
 const proof=proveGroundRayEdge({colliders:[floor('shifted',-1,1,.12)],height:()=>0,ray:()=>hit(.12),sphere:()=>shape(.12),x:0,z:.3});
 assert.ok(Math.abs(proof.meshHeight!-.12)<1e-7);assert.equal(proof.pass,false);assert.ok(proof.neighbors.every(n=>!n.aligned));
});
test('visual and collider queries use the actual Float32 point when rounding crosses an existing curb',()=>{
 const boundary=1024.0001220703125,requested=1024.00008,visual=(x:number)=>x>=boundary?.12:0,query=nativeGroundPoint(requested,.3);
 assert.equal(visual(requested),0);assert.equal(query.x,boundary);assert.ok(Math.abs(query.x-requested)<.0001);
 const proof=proveGroundRayEdge({colliders:[floor('road',1023,boundary),floor('curb',boundary,1025,.12)],height:visual,ray:x=>hit(visual(x)),sphere:()=>shape(.12),x:requested,z:.3});
 assert.equal(proof.pass,true);assert.equal(proof.visual,.12);assert.deepEqual(proof.query,query);assert.ok(Math.abs(proof.meshHeight!-.12)<1e-7);
});
