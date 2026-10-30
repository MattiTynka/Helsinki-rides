import test from 'node:test';
import assert from 'node:assert/strict';
import {selectQualifiedTransitLaneSurfaces} from '../lib/road-merge-reviews.ts';
import type {ReviewedRecordSurface} from '../lib/expansion-road-merge.ts';
test('a reviewed two-direction crossing admits only the selected lane and records unused eligibility',()=>{
  const surface:ReviewedRecordSurface={parts:[],sourceWitnesses:{alreadyQualified:true}},qualified=new Map([['176821966:0:b0',surface],['176821966:0:f0',surface]]);
  const result=selectQualifiedTransitLaneSurfaces(qualified,new Set(['176821966:0:b0','176821966:0:b0>8013666:0:b0']));
  assert.deepEqual([...result.selected.keys()],['176821966:0:b0']);assert.deepEqual(result.unselectedEligibleIds,['176821966:0:f0']);assert.equal(qualified.size,2);
  assert.throws(()=>selectQualifiedTransitLaneSurfaces(qualified,new Set(['other'])),/Unused reviewed/);
});
