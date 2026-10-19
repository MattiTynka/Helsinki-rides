import assert from 'node:assert/strict';
import {test} from 'node:test';
import {preserveTreePlacements} from '../lib/tree-preservation.ts';

test('expanded roads retain accepted tree placement and collider policy', () => {
  const old = [{id:'accepted',position:[1,2,3],colliderHeight:0}];
  const result = preserveTreePlacements(old,[{...old[0]!,colliderHeight:3.3},{id:'new',position:[5,6,7],colliderHeight:3.3}]);
  assert.equal(result.trees[0],old[0]);
  assert.deepEqual(result.colliderOverrides,['accepted']);
  assert.equal(result.trees.length,2);
});

test('missing or moved accepted trees fail instead of being concealed by preservation', () => {
  const old = [{id:'accepted',position:[1,2,3],colliderHeight:0}];
  assert.throws(()=>preserveTreePlacements(old,[]),/omits accepted/);
  assert.throws(()=>preserveTreePlacements(old,[{...old[0]!,position:[1,2.5,3]}]),/position changed/);
  assert.throws(()=>preserveTreePlacements(old,[old[0]!,old[0]!]),/duplicate/);
});
