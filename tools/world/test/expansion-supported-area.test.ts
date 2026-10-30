import assert from 'node:assert/strict';
import {test} from 'node:test';
import {composeExpansionSupportedArea} from '../lib/expansion-supported-area.ts';
import {containsSupportedArea} from '../../../packages/world-schema/src/index.ts';

test('source mask preserves accepted area, excludes an unqualified crossing and drops disconnected public islands',()=>{
  const result=composeExpansionSupportedArea({accepted:[0,0,10,10],region:[0,10,10,20],
    publicPolygons:[[[[1,9],[4,9],[4,16],[1,16]]],[[[7,18],[9,18],[9,20],[7,20]]]],
    excludedPolygons:[[[[1,14],[4,14],[4,15],[1,15]]]]});
  const coverage={playArea:{minX:0,minZ:0,maxX:10,maxZ:20},supportedArea:result.supportedArea};
  assert.equal(containsSupportedArea(coverage,2,12),true);
  assert.equal(containsSupportedArea(coverage,2,14.5),false);
  assert.equal(containsSupportedArea(coverage,2,15.5),false);
  assert.equal(containsSupportedArea(coverage,8,19),false);
  assert.equal(containsSupportedArea(coverage,9,9),true);
  assert.equal(result.excludedDisconnectedComponents,2);
});
