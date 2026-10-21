import assert from 'node:assert/strict';import test from 'node:test';
import {classifyFacadeTriangle,closestFacadeAxis,facadeRayIntersection} from '../lib/delivery-new-area-facades.ts';
test('Null roofs and undersides remain distinct from missing wall detail',()=>{
  assert.equal(classifyFacadeTriangle([[0,0,0],[0,3,0],[4,0,0]]).kind,'wall');
  assert.equal(classifyFacadeTriangle([[0,0,0],[0,0,3],[4,0,0]]).kind,'roof');
  assert.equal(classifyFacadeTriangle([[0,0,0],[4,0,0],[0,0,3]]).kind,'underside');
  assert.equal(classifyFacadeTriangle([[0,0,0],[0,0,0],[0,0,0]]).kind,'degenerate');
});
test('Street qualification uses finite segments and an explicit distance bound',()=>{
 const axes=[{id:1,name:'Public',highway:'residential',points:[[0,0],[10,0]] as const}];
 assert.equal(closestFacadeAxis([5,3],axes)?.distance,3);assert.equal(closestFacadeAxis([50,3],axes,20),null);
 assert.deepEqual(closestFacadeAxis([12,0],axes)?.point,[10,0]);
});
test('Occluded courtyard faces are not promoted as visible street facades',()=>{
 const wall=[[5,0,-2],[5,4,-2],[5,0,2]] as const;
 assert.equal(facadeRayIntersection([0,1,0],[10,1,0],wall),.5);
 assert.equal(facadeRayIntersection([0,5,0],[10,5,0],wall),null);
 assert.equal(facadeRayIntersection([5,1,0],[10,1,0],wall),null);
});
