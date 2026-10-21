import test from'node:test';import assert from'node:assert/strict';
import{qualifyBernhardinkatuAnnexGround}from'../lib/delivery-new-area-facades-bernhardinkatu.ts';
import{qualifyPieniRoobertinkatuHotelGround}from'../lib/delivery-new-area-facades-pieni-roobertinkatu.ts';
test('named sloping plinth qualification rejects changed floors, another elevation or datum',()=>{
 const heights=[3.661027121524032,3.784860287658378,3.953103074864263,4.126093349026964,4.259414156245578,4.352760385320018,4.471213023201838,4.600925586245134,4.702118090039059],p={id:'bernhardinkatu-4-annex-north-20261021',building:{id:'BID_b3768187-2d44-4707-8248-2cecc2787a45',vtj:'103046324Y'},triangles:[213,214,215,216,217,258,259,260,261,274,275,276,277],observedGroundProfile:{kind:'source-measured-sloped-plinth-horizontal-opening-bands',manifestSha256:'a'.repeat(64),sampleHeights:heights,horizontalDatumFromNativeTop:-5.8}},samples=heights.map(height=>({collision:{height}}));
 assert.equal(qualifyBernhardinkatuAnnexGround(p,'a'.repeat(64),13,samples),7.2);
 assert.throws(()=>qualifyBernhardinkatuAnnexGround(p,'a'.repeat(64),13,samples.map((s,i)=>i===4?{collision:{height:s.collision.height+.01}}:s)),/Requalify/);
 assert.throws(()=>qualifyBernhardinkatuAnnexGround({...p,triangles:[...p.triangles,241]},'a'.repeat(64),13,samples));
 assert.throws(()=>qualifyBernhardinkatuAnnexGround({...p,observedGroundProfile:{...p.observedGroundProfile,horizontalDatumFromNativeTop:-5.7}},'a'.repeat(64),13,samples));
 assert.throws(()=>qualifyBernhardinkatuAnnexGround(p,'b'.repeat(64),13,samples));assert.throws(()=>qualifyBernhardinkatuAnnexGround({...p,building:{...p.building,id:'adjacent-BID'}},'a'.repeat(64),13,samples));
});
test('hotel floors qualify only its separately observed flat storey datum and exact source frontage',()=>{
 const heights=[7.527199324603793,7.33162233823497,7.08481568210537,6.782160997187472,6.5542204222062646,6.364132478007544,6.171263832580525,5.91788884946782,5.73765823304308],p={id:'pieni-roobertinkatu-1-3-hotel-south-20261021',building:{id:'BID_e21ed751-3931-4b4a-b18c-cd6273bff265',vtj:'103046274B'},triangles:[268,269,801,802,803,804,805,806,807,808,904,905,906,907],observedGroundProfile:{kind:'source-measured-sloped-base-horizontal-opening-bands',manifestSha256:'a'.repeat(64),sampleHeights:heights,horizontalDatumFromNativeTop:-22.7}},samples=heights.map(height=>({collision:{height}}));
 assert.equal(qualifyPieniRoobertinkatuHotelGround(p,'a'.repeat(64),28.444076538085938,samples),5.744076538085938);
 assert.throws(()=>qualifyPieniRoobertinkatuHotelGround({...p,building:{...p.building,vtj:'103046324Y'}},'a'.repeat(64),28.444076538085938,samples));
 assert.throws(()=>qualifyPieniRoobertinkatuHotelGround(p,'a'.repeat(64),28.444076538085938,samples.slice(1)));
 assert.throws(()=>qualifyPieniRoobertinkatuHotelGround(p,'a'.repeat(64),28.444076538085938,samples.map((s,i)=>i===8?{collision:{height:s.collision.height+.01}}:s)),/Requalify/);
 assert.throws(()=>qualifyPieniRoobertinkatuHotelGround({...p,triangles:[...p.triangles,562]},'a'.repeat(64),28.444076538085938,samples));
});
