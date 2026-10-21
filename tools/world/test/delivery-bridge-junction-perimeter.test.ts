import test from 'node:test';
import assert from 'node:assert/strict';
import type {BridgeFace} from '../lib/bridge-reconstruction.ts';
import type {Vec3} from '../../../packages/world-schema/src/index.ts';
import {junctionFloorPerimeter} from '../lib/delivery-bridge-junction-perimeter.ts';
const face=(points:[Vec3,Vec3,Vec3]):BridgeFace=>({points,uvs:[[0,0],[0,0],[0,0]],role:'road',material:'asphalt',collision:true});
test('actual perimeter cancels an internal T junction exactly without adding interior skins',()=>{
 const faces=[face([[0,0,0],[0,0,2],[1,0,0]]),face([[1,0,0],[0,0,2],[1,0,2]]),face([[1,0,0],[1,0,1],[2,0,0]]),face([[2,0,0],[1,0,1],[2,0,2]]),face([[1,0,1],[1,0,2],[2,0,2]])],p=junctionFloorPerimeter(faces);
 assert.equal(p.proof.maximumInternalEdgeHeightMismatchMetres,0);assert.ok(p.edges.every(([a,b])=>!(a[0]===1&&b[0]===1)));assert.equal(p.edges.reduce((n,[a,b])=>n+Math.hypot(b[0]-a[0],b[2]-a[2]),0),8);
});
test('duplicate floors, reversed winding and a real greater-than-1mm T seam cannot gain boundary authority',()=>{
 const a=face([[0,0,0],[0,0,2],[1,0,0]]);assert.throws(()=>junctionFloorPerimeter([a,a]),/duplicate perimeter authority/);assert.throws(()=>junctionFloorPerimeter([face([a.points[0],a.points[2],a.points[1]])]),/reversed/);
 const b=face([[1,.01,0],[0,0,2],[1,0,2]]);assert.throws(()=>junctionFloorPerimeter([a,b]),/1mm C0/);
 const tiny=face([[0,0,0],[0,0,Math.fround(1e-8)],[Math.fround(1e-8),0,0]]);assert.equal(junctionFloorPerimeter([tiny]).edges.length,3);
});
