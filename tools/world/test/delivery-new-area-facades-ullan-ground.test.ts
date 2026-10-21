import assert from 'node:assert/strict';import test from 'node:test';
import {qualifyUllanlinnankatuGround} from '../lib/delivery-new-area-facades-ullanlinnankatu.ts';
const heights=[8.557571464620576,8.37327312531439,8.110969300463287,7.891733689723078,7.678180524792582,7.424544583495978,7.100790107488814,6.861199504900773,6.697105804321257];
const plan=()=>({id:'ullanlinnankatu-1-kasarmikatu-main-east-20261021',building:{id:'BID_55bf0fcd-8aad-4096-b661-ef1502b76486',vtj:'103046315N',owner:'c_m03_p05'},triangles:[499,500],observedGroundProfile:{kind:'source-measured-sloped-shop-base-horizontal-upper-bands',manifestSha256:'fresh-pinned-manifest',sampleHeights:[...heights],mainNativeRoofY:25.743934631347656,horizontalDatumFromMainNativeRoof:-17.18636316672708}});
test('named sloping shop-base qualification retains a level measured upper datum',()=>{
 assert.equal(qualifyUllanlinnankatuGround(plan(),'fresh-pinned-manifest',25.743934631347656,heights.map(height=>({collision:{height}}))),heights[0]);
 for(const mutate of[(p:ReturnType<typeof plan>)=>{p.triangles.push(495);},(p:ReturnType<typeof plan>)=>{p.building.id='neighbor';},(p:ReturnType<typeof plan>)=>{p.observedGroundProfile.horizontalDatumFromMainNativeRoof=.1;},(p:ReturnType<typeof plan>)=>{p.observedGroundProfile.sampleHeights[0]!+=.01;}]){const p=plan();mutate(p);assert.throws(()=>qualifyUllanlinnankatuGround(p,'fresh-pinned-manifest',25.743934631347656,heights.map(height=>({collision:{height}}))));}
 const changed=heights.map(height=>({collision:{height}}));changed[4]!.collision.height+=.01;assert.throws(()=>qualifyUllanlinnankatuGround(plan(),'fresh-pinned-manifest',25.743934631347656,changed));
 assert.throws(()=>qualifyUllanlinnankatuGround(plan(),'different-manifest',25.743934631347656,heights.map(height=>({collision:{height}}))));
});
