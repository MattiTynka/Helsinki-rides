import assert from 'node:assert/strict';import type {Document} from '@gltf-transform/core';import type {GroundPiece} from './ground.ts';
import {restoreNativeShoreVisual} from './delivery-native-shore.ts';import {readFacadeGlb} from './facade-glb.ts';
/** Empty water domain makes the existing attribute-preserving writer append-only. */
export async function appendPartitionGroundVisual(bytes:Uint8Array,doc:Document,pieces:readonly GroundPiece[],coarse:boolean){
 const result=await restoreNativeShoreVisual({bytes,doc,pieces,coarse,domain:[],nearWater:[],seaY:-7.3});
 for(const p of result.proofs){assert.equal(p.removedWater,0);assert.equal(p.remainingClippedWater,0);}
 const before=readFacadeGlb(bytes).bin,after=readFacadeGlb(result.bytes).bin;assert.deepEqual(after.subarray(0,before.length),before,'All original vertex, index, image and attribute bytes must remain literal');return result;
}
