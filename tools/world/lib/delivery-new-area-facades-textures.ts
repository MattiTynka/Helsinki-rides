import assert from'node:assert/strict';
import type{ReducedTextureRef}from'../../../packages/world-schema/src/index.ts';
/** Distinct full-resolution sources may legitimately share identical low mips. */
export function mergeFacadeReducedTextures(refs:readonly ReducedTextureRef[]):ReducedTextureRef[]{
 const bySource=new Map<string,ReducedTextureRef>();for(const ref of refs){const previous=bySource.get(ref.source);if(previous)assert.deepEqual(previous,ref,'Conflicting low-mip mapping for one source atlas');else bySource.set(ref.source,ref);}return[...bySource.values()];
}
