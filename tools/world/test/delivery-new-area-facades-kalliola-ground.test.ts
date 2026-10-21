import assert from'node:assert/strict';import test from'node:test';import fs from'node:fs';
import{qualifyKalliolanrinneGround}from'../lib/delivery-new-area-facades-root-north.ts';
test('observed Kalliolanrinne slope permits only its two exact fronts and unchanged native floor samples',()=>{
 for(const[slug,top]of[['kalliolanrinne-3-south',35.649871826171875],['kalliolanrinne-4-north',33.490318298339844]]as const){
  const p=JSON.parse(fs.readFileSync(new URL(`../../../content/assets/facades/new-area/root-north/${slug}/plan.json`,import.meta.url),'utf8')),samples=p.observedGroundProfile.sampleHeights.map((height:number)=>({collision:{height}})),pin=p.observedGroundProfile.manifestSha256;
  assert.equal(qualifyKalliolanrinneGround(p,pin,top,samples),Math.max(...p.observedGroundProfile.sampleHeights));
  const changed=structuredClone(samples);changed[4].collision.height+=.01;assert.throws(()=>qualifyKalliolanrinneGround(p,pin,top,changed),/changed/);
  const wrong=structuredClone(p);wrong.triangles.push(100);assert.throws(()=>qualifyKalliolanrinneGround(wrong,pin,top,samples));wrong.triangles=p.triangles;wrong.building.id='neighbor';assert.throws(()=>qualifyKalliolanrinneGround(wrong,pin,top,samples));
  assert.throws(()=>qualifyKalliolanrinneGround(p,'a'.repeat(64),top,samples));assert.throws(()=>qualifyKalliolanrinneGround(p,pin,top+.1,samples));
 }
});
