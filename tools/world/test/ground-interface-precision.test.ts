import assert from 'node:assert/strict';
import test from 'node:test';
import polygonClipping from 'polygon-clipping';
import {groundInterfaceBoolean} from '../lib/ground-interface-seals.ts';
import type {Pt} from '../lib/geometry.ts';

test('actual western curb touching a wall does not abort closure qualification or create positive-area coverage',()=>{
  const input:Pt[][][]=[[[[0,7.343454837799072],[1,7.314445495605469],[1,7.26743745803833],[0,7.205029487609863]]],
    [[[0.9999999999999998,7.26743745803833],[1.0135257723534796,7.3017258644104],[1.0135257723534796,7.324573040008545]]]];
  const original=JSON.stringify(input),displacements:number[]=[];
  assert.throws(()=>polygonClipping.intersection(input[0]!,input[1]!),/Cannot read properties of null/,'negative control from frozen strip-v4');
  assert.deepEqual(groundInterfaceBoolean('intersection',input,4,d=>displacements.push(d)),[]);
  assert.equal(displacements.length,1);assert.ok(displacements[0]!<1e-9);assert.equal(JSON.stringify(input),original);
});

test('successful section booleans retain exact polygons without entering precision recovery',()=>{
  const input:Pt[][][]=[[[[0,1],[1,1],[1,0],[0,0]]],[[[.5,.5],[1,.5],[1,0],[.5,0]]]];
  assert.deepEqual(groundInterfaceBoolean('difference',input,2,()=>assert.fail('unnecessary retry')),polygonClipping.difference(input[0]!,input[1]!));
});
