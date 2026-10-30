import test from 'node:test';import assert from 'node:assert/strict';
import {clipReviewedBridgeRoadSources} from '../lib/reviewed-bridge-source.ts';import {pointInPolygon,type LocalPolygon} from '../lib/geometry.ts';
const part:LocalPolygon={id:'deck',properties:{paatyyppi:'Silta',alatyyppi:'Ajorata (Silta)'},rings:[[[-10,-10],[10,-10],[10,10],[-10,10]]],bbox:[-10,-10,10,10]};
test('bridge road authority is exactly municipal source intersected with literal floor, preserving classification',()=>{
 const clipped=clipReviewedBridgeRoadSources([part],[{points:[[-1,4,-1],[-1,4,1],[1,4,1]]}]);assert.equal(clipped.length,1);assert.deepEqual(clipped[0]!.properties,part.properties);assert.equal(pointInPolygon([0,0.5],clipped[0]!.rings),false);assert.equal(pointInPolygon([-.5,-.5],clipped[0]!.rings),true);assert.equal(pointInPolygon([-5,0],clipped[0]!.rings),false);
 const away={...part,rings:[[[20,20],[30,20],[30,30],[20,30]]]as [number,number][][]};assert.deepEqual(clipReviewedBridgeRoadSources([away],[{points:[[-1,4,-1],[-1,4,1],[1,4,1]]}]),[]);
 assert.throws(()=>clipReviewedBridgeRoadSources([{...part,properties:{...part.properties,alatyyppi:'Rautatiesilta'}}],[{points:[[-1,4,-1],[-1,4,1],[1,4,1]]}]),/Unreviewed/);
});
