import test from 'node:test';
import assert from 'node:assert/strict';
import {clipJunctionCarriagewayFloor} from '../lib/delivery-bridge-junction-domain.ts';
import type {BridgeFace} from '../lib/bridge-reconstruction.ts';
const faces:BridgeFace[]=[{points:[[0,0,-2],[4,0,-2],[0,0,2]],uvs:[[0,0],[1,0],[0,1]],material:'asphalt',role:'road',collision:true},{points:[[4,0,-2],[4,0,2],[0,0,2]],uvs:[[1,0],[1,1],[0,1]],material:'asphalt',role:'road',collision:true}];
test('a common chart produces literal roads on both sides of a source median and no floor in the median',()=>{
 const result=clipJunctionCarriagewayFloor(faces,[[[[0,-2],[4,-2],[4,-.5],[0,-.5],[0,-2]]],[[[0,.5],[4,.5],[4,2],[0,2],[0,.5]]]]);
 let area=0;for(const f of result.faces){const[a,b,c]=f.points;area+=((b[2]-a[2])*(c[0]-a[0])-(b[0]-a[0])*(c[2]-a[2]))/2;assert.ok(f.points.every(p=>p[2]<=-.5)||f.points.every(p=>p[2]>=.5));assert.ok(f.collision&&f.role==='road');}assert.equal(area,12);assert.equal(result.proof.medianChartHasNoFloorAuthority,true);
});
test('encoded-zero source components gain no authority while tiny positive encoded areas are all retained',()=>{
 const zero=clipJunctionCarriagewayFloor(faces,[[[[1,0],[1.00000000001,0],[1.00000000001,1],[1,1],[1,0]]]]);assert.equal(zero.faces.length,0);assert.ok(zero.proof.nonAreaSourceComponents.length);assert.equal(zero.proof.encodedPositiveArea,0);
 const tiny=clipJunctionCarriagewayFloor(faces,[[[[1,0],[1.000001,0],[1.000001,1],[1,1],[1,0]]]]);assert.ok(tiny.faces.length);assert.ok(tiny.proof.encodedPositiveArea>0);assert.equal(tiny.proof.emittedPositiveArea,tiny.proof.encodedPositiveArea);
 assert.throws(()=>clipJunctionCarriagewayFloor([{...faces[0]!,role:'curb'}],[[[[0,-2],[4,-2],[4,2],[0,2],[0,-2]]]]));
});
