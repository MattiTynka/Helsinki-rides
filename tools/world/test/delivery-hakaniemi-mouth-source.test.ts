import assert from 'node:assert/strict';
import {test}from'node:test';
import {hakaniemiNativeRowSpan,hakaniemiNorthOuterNode}from'../author_delivery_hakaniemi_mouths.ts';
import type{Vec3}from'../../../packages/world-schema/src/index.ts';

test('only the reviewed adjacent original north node can extend the source bank',()=>{
  assert.equal(hakaniemiNorthOuterNode(),12766532820);assert.equal(hakaniemiNorthOuterNode('1014149567'),1014149567);
  for(const input of [0,12766532823,1014149568,NaN,'arbitrary'])assert.throws(()=>hakaniemiNorthOuterNode(input),/Unreviewed/);
});

test('source bank ends on literal decoded Float32 triangle edges despite a raw polygon endpoint outside the floor',()=>{
  const face:[[number,number,number],[number,number,number],[number,number,number]]=[[0,0,0],[4,1,0],[4,1,4]],span=hakaniemiNativeRowSpan(face,[2,-1],[0,1]);assert.ok(span);assert.equal(span.from.offset,1);assert.equal(span.to.offset,3);assert.deepEqual(span.from.point,[2,.5,0]);assert.deepEqual(span.to.point,[2,.5,2]);assert.ok(2.0000001>span.to.point[2]);assert.ok([span.from,span.to].every(k=>k.edgeParameter>=0&&k.edgeParameter<=1));
});
test('triangle reversal retains the same physical bank and source plane height',()=>{
  const t:readonly[Vec3,Vec3,Vec3]=[[297.17169189453125,-4.158914566040039,-986.59912109375],[298.6024169921875,-3.6857857704162598,-976.114013671875],[310.66058349609375,-3.5165460109710693,-973.1760864257812]],P=[300,-990]as const,N=[0,1]as const,a=hakaniemiNativeRowSpan(t,P,N),b=hakaniemiNativeRowSpan([t[2],t[1],t[0]],P,N);assert.ok(a&&b);assert.deepEqual(a.from.point.map(Math.fround),b.from.point.map(Math.fround));assert.deepEqual(a.to.point.map(Math.fround),b.to.point.map(Math.fround));
});
test('a point contact or zero-area vertical skin cannot become a full-width floor bank',()=>{
  assert.equal(hakaniemiNativeRowSpan([[0,0,0],[2,0,0],[0,0,2]],[2,0],[0,1]),null);
  assert.equal(hakaniemiNativeRowSpan([[0,0,0],[0,2,0],[0,2,2]],[1,0],[0,1]),null);
});
