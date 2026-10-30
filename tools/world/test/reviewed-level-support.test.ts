import test from 'node:test';import assert from 'node:assert/strict';
import {RoadCollisionSupport} from '../lib/expansion-road-merge.ts';
import {reviewedSheetSupport} from '../lib/reviewed-level-support.ts';
test('an authored deck owns only its literal sheet while distant approach ground stays usable',()=>{
 const ground=new RoadCollisionSupport([{id:'approach',tag:'road:asphalt',points:[[-20,0,-20],[-20,0,20],[20,0,20]]}]);
 const deck=new RoadCollisionSupport([{id:'upper',tag:'road:asphalt',points:[[-2,4,-2],[-2,4,2],[2,4,2]]}]);const support=reviewedSheetSupport(deck,ground);
 assert.equal(support.at(-10,0,0)?.triangle,'approach');assert.equal(support.at(-1,4,0)?.triangle,'upper');assert.equal(support.at(-1,0,0),null);
});
