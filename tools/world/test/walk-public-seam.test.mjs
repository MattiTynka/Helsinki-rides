import assert from 'node:assert/strict';
import {test} from 'node:test';
import {qualifyPublicPavingSeam} from '../lib/walk-public-seam.mjs';
const box=(a,b,c,d)=>[[[[a,b],[c,b],[c,d],[a,d],[a,b]]]];
const parts=[{id:58144,geometry:box(-60,10,-57,32)},{id:58145,geometry:box(-56.999996,10,-54,32)}];
const shape={vertices:Float32Array.from([-58,0,19,-58,0,22,-56,0,22,-56,0,19]),indices:Uint32Array.from([0,1,2,0,2,3])};
const scene={identities:new Map([[1,{cell:'actual',id:'paving'}]]),world:{physics:{getCollider:()=>({shape})},surfaceAt:()=>({group:'ground',tag:'paving'})}};
test('named micron registration seam requires whole literal native floor and both source boundaries',()=>{
 const gap=box(-57,20,-56.999996,21),proof=qualifyPublicPavingSeam(gap,parts,scene);
 assert.ok(proof.gapAreaSquareMetres>0);assert.ok(proof.nativeFaces.length);assert.equal(proof.worldAndMaskUnmodified,true);
 assert.throws(()=>qualifyPublicPavingSeam(gap,parts,{...scene,identities:new Map()}),/native floor/);
 assert.throws(()=>qualifyPublicPavingSeam(box(-57,20,-56.99,21),parts,scene));
 assert.throws(()=>qualifyPublicPavingSeam(gap,[{...parts[0],id:1},parts[1]],scene));
});
