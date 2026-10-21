import test from 'node:test';
import assert from 'node:assert/strict';
import {retainJunctionSourceUnion} from '../lib/delivery-bridge-junction-mesh.ts';
const mesh={attributes:{POSITION:Float32Array.from([0,0,0,8,0,0,0,0,8]),TEXCOORD_0:Float32Array.from([0,0,1,0,0,1])},components:{POSITION:3,TEXCOORD_0:2},normalized:{POSITION:false,TEXCOORD_0:false},indices:Uint32Array.of(0,1,2)};
test('a dense mask tessellation is unioned once and retains the same literal source-plane complement and UVs',()=>{
 const masks:[number,number][][]=[];for(let x=0;x<4;x+=.25)for(let z=0;z<8;z+=.25)masks.push([[x,z],[x+.25,z],[x,z+.25]],[[x+.25,z],[x+.25,z+.25],[x,z+.25]]);
 const out=retainJunctionSourceUnion(mesh,new Map([[0,masks]]));assert.deepEqual(out.mesh.attributes.POSITION!.subarray(0,9),mesh.attributes.POSITION);assert.deepEqual(out.mesh.attributes.TEXCOORD_0!.subarray(0,6),mesh.attributes.TEXCOORD_0);assert.equal(out.mesh.indices.length,3);
 for(const i of out.mesh.indices){const p=out.mesh.attributes.POSITION!.subarray(i*3,i*3+3),uv=out.mesh.attributes.TEXCOORD_0!.subarray(i*2,i*2+2);assert.ok(p[0]!>=4);assert.equal(uv[0],p[0]!/8);assert.equal(uv[1],p[2]!/8);}
});
test('a genuinely positive encoded source residual survives and a selected vertical skin clips in its literal affine plane',()=>{
 const tiny={...mesh,attributes:{POSITION:Float32Array.from([0,0,0,1,0,0,0,0,1]),TEXCOORD_0:mesh.attributes.TEXCOORD_0}},edge=1-2**-24,tinyMasks:[number,number][][]=[[[-1,-1],[edge,-1],[edge,2],[-1,2]]],out=retainJunctionSourceUnion(tiny,new Map([[0,tinyMasks]]));assert.equal(out.mesh.indices.length,3);const P=Array.from(out.mesh.indices,i=>Array.from(out.mesh.attributes.POSITION!.subarray(i*3,i*3+3)));assert.ok(Math.abs((P[1]![0]!-P[0]![0]!)*(P[2]![2]!-P[0]![2]!)-(P[1]![2]!-P[0]![2]!)*(P[2]![0]!-P[0]![0]!))>0);
 const vertical={...mesh,attributes:{POSITION:Float32Array.from([0,0,0,0,1,0,0,0,8]),TEXCOORD_0:mesh.attributes.TEXCOORD_0}},wallMasks:[number,number][][]=[[[-1,-1],[1,-1],[1,4],[-1,4]]],wall=retainJunctionSourceUnion(vertical,new Map([[0,wallMasks]]));assert.equal(wall.mesh.indices.length,3);for(const i of wall.mesh.indices)assert.ok(wall.mesh.attributes.POSITION![i*3+2]!>=4);
});
