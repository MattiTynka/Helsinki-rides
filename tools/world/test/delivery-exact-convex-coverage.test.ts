import test from'node:test';import assert from'node:assert/strict';
import{exactConvexCoverage,hasExactPolygonArea}from'../lib/delivery-exact-convex-coverage.ts';
import{deliveryRoadSourceCutCoverage}from'../lib/delivery-city-road-projection.ts';
import fs from'node:fs';
test('exact convex subtraction keeps a microscopic genuine uncovered strip and accepts complete triangulated coverage',()=>{
 const box=[[291,-997],[293,-997],[293,-995],[291,-995]],a=[[291,-997],[293,-997],[291,-995]],b=[[293,-997],[293,-995],[291,-995]];
 assert.equal(exactConvexCoverage([box],[a,b],[]).exactPositiveResiduals,0);
 const clipped=[[291+1e-9,-997],[293,-997],[293,-995],[291+1e-9,-995]];
 const missing=exactConvexCoverage([box],[clipped],[]);assert.ok(missing.exactPositiveResiduals>0);assert.ok(missing.unexplainedArea>0);
 assert.equal(exactConvexCoverage([box],[[...box].reverse()],[]).exactPositiveResiduals,0);
});
test('a positive area remains proof-visible even when ordinary numeric area underflows',()=>{
 const tiny=[[0,0],[1e-200,0],[0,1e-200]];assert.ok(hasExactPolygonArea(tiny));const proof=exactConvexCoverage([tiny],[],[]);assert.equal(proof.exactPositiveResiduals,1);assert.equal(proof.unexplainedArea,0);
 assert.equal(exactConvexCoverage([tiny],[tiny],[]).exactPositiveResiduals,0);
});
test('source-cut coverage retains the existing80micrometre construction bound and rejects a millimetre gap',()=>{
 const wanted=[{id:'source',polygon:[[0,0],[0,2],[2,0]]}],floor=(d:number)=>[{points:[[d,12,d],[d,12,2-d],[2-d,12,d]]}];
 assert.equal(deliveryRoadSourceCutCoverage(wanted,floor(.00002)).exactPositiveResiduals,0);
 assert.ok(deliveryRoadSourceCutCoverage(wanted,floor(.001)).exactPositiveResiduals>0);
});
test('concave input is rejected instead of claiming convex proof for arbitrary source geometry',()=>{assert.throws(()=>exactConvexCoverage([[[0,0],[2,0],[1,.5],[2,2],[0,2]]],[],[]),/convex/);});
test('actual owner-clipped bridge floor cannot excuse the larger unsplit source-cut mask',()=>{
 const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/junction-owner-floor-gap.json',import.meta.url),'utf8'));
 const proof=deliveryRoadSourceCutCoverage(fixture.portions,fixture.replacementFaces.map((points:number[][])=>({points})));
 assert.equal(proof.status,'MISSING_CANONICAL_FLOOR_PROJECTION');assert.ok(proof.exactPositiveResiduals>0);assert.ok(proof.unexplainedArea>2e-7);
});
