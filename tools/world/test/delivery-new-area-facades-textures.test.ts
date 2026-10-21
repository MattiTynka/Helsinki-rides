import assert from'node:assert/strict';import test from'node:test';import{mergeFacadeReducedTextures}from'../lib/delivery-new-area-facades-textures.ts';
test('Different source atlases sharing identical lower mips retain both Low-preset mappings',()=>{
 const low={path:'textures-m1/'+'a'.repeat(64)+'.ktx2',sha256:'a'.repeat(64),bytes:1024},one={...low,source:'textures/'+'b'.repeat(64)+'.ktx2'},two={...low,source:'textures/'+'c'.repeat(64)+'.ktx2'};
 assert.deepEqual(mergeFacadeReducedTextures([one,two,one]),[one,two]);assert.throws(()=>mergeFacadeReducedTextures([one,{...one,bytes:2048}]),/Conflicting low-mip mapping/);
});
