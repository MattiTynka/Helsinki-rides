import assert from 'node:assert/strict';
import {test} from 'node:test';
import {extraBridgeDeckHeight,buildExtraBridgeDeck,validateExtraBridgeDeck,type ExtraBridgeDeckProfile} from '../lib/delivery-extra-bridges-mesh.ts';
import {extraBridgeWorld} from '../lib/delivery-extra-bridges-source.ts';
import {fitMeasuredBridgeDeck,type BridgeLaserBand,type MeasuredBridgeFitPolicy} from '../lib/delivery-bridge-measured-profile.ts';
const source={cell:'native',collider:'native-bank',triangle:0,sha256:'a'.repeat(64)};
function fixture(){
  const profile:ExtraBridgeDeckProfile={surfaceMethod:'native-bank-piecewise-planar-ruled-sections-v1',frame:{origin:[10,20],direction:[1,0]},banks:[{s:-2,segments:[{t0:-3,t1:3,y0:0,y1:0,role:'road',sourcePartIds:[1],source},{t0:3,t1:5,y0:.15,y1:.15,role:'walk',sourcePartIds:[2],source}]},{s:22,segments:[{t0:-3,t1:3,y0:.1,y1:.1,role:'road',sourcePartIds:[1],source},{t0:3,t1:5,y0:.25,y1:.25,role:'walk',sourcePartIds:[2],source}]}],upperParts:[{id:1,role:'road',tag:'road:asphalt',rings:[[[8,17],[32,17],[32,23],[8,23],[8,17]]],sha256:'b'.repeat(64)},{id:2,role:'walk',tag:'raised:asphalt',rings:[[[8,23],[32,23],[32,25],[8,25],[8,23]]],sha256:'c'.repeat(64)}],crownMetres:0,deckThicknessMetres:.3,maximumGrade:.15};
  const measured={...profile,crownMetres:.5},policy:MeasuredBridgeFitPolicy={sourceFrame:profile.frame,originHeightN2000:7.5,measuredPartIds:[1,2],fitBand:'road-centre',stationExtent:[0,20],stationBinMetres:2,minimumBandPoints:15,maximumStationGapMetres:2,maximumCrownMetres:1,maximumMedianResidualMetres:.1},bands:BridgeLaserBand[]=[];
  for(const[role,partId,t]of[['road-centre',1,0],['east-walk',2,4]]as const)for(let bin=0;bin<20;bin+=2){const s=bin+1;bands.push({role,stationBin:bin,count:100,median:{pointIndex:bands.length,runtimeXZ:extraBridgeWorld(profile.frame,s,t),heightN2000:extraBridgeDeckHeight(measured,s,t,partId===1?'road':'walk',partId)+7.5,station:s,lateral:t,partId,class:17,pointSourceId:12,returnNumber:1,numberOfReturns:1}});}
  return{profile,policy,bands};
}
test('laser crown fit retains native banks and source footprints and independently qualifies raised sidepath observations',()=>{
  const{profile,policy,bands}=fixture(),before=structuredClone(profile),out=fitMeasuredBridgeDeck(profile,bands,policy);assert.ok(Math.abs(out.profile.crownMetres-.5)<1e-12);assert.deepEqual(profile,before);assert.deepEqual(out.profile.banks,before.banks);assert.deepEqual(out.profile.upperParts,before.upperParts);assert.equal(out.profile.deckThicknessMetres,.3);assert.equal(out.proof.residuals.length,20);assert.ok(out.proof.maximumAbsoluteMedianResidualMetres<1e-12);
});
test('a good centre fit cannot conceal wrong sidepath height, a missing source role or a bank/axis change',()=>{
  const{profile,policy,bands}=fixture(),bad=structuredClone(bands);bad.find(b=>b.role==='east-walk')!.median.heightN2000+=.3;assert.throws(()=>fitMeasuredBridgeDeck(profile,bad,policy),/measured profile mismatch/);
  assert.throws(()=>fitMeasuredBridgeDeck(profile,bands.filter(b=>b.role==='road-centre'),policy),/no laser witness/);
  const moved=structuredClone(profile);moved.frame.origin[0]+=.01;assert.throws(()=>fitMeasuredBridgeDeck(moved,bands,policy),/frame differs/);
  const bank=structuredClone(profile);bank.banks[0].segments.filter(s=>s.role==='walk').forEach(s=>{s.y0+=.4;s.y1+=.4;});assert.throws(()=>fitMeasuredBridgeDeck(bank,bands,policy),/measured profile mismatch/);
});
test('unclassified points, spatial witness changes and longitudinal source gaps fail without filling a surface',()=>{
  const{profile,policy,bands}=fixture();for(const change of[(b:BridgeLaserBand)=>(b.median.class as number)=2,(b:BridgeLaserBand)=>b.median.runtimeXZ[0]+=.1,(b:BridgeLaserBand)=>b.median.partId=999,(b:BridgeLaserBand)=>b.count=2]){const bad=structuredClone(bands);change(bad[0]!);assert.throws(()=>fitMeasuredBridgeDeck(profile,bad,policy));}
  assert.throws(()=>fitMeasuredBridgeDeck(profile,bands.filter(b=>b.stationBin!==10),policy),/Unmeasured longitudinal/);
  const negative=bands.map(b=>({...b,median:{...b.median,heightN2000:b.median.heightN2000-1}}));assert.throws(()=>fitMeasuredBridgeDeck(profile,negative,policy),/crown.*limits/);
});

test('independently measured raised sidepaths fit their own crown while keeping every native bank and the legacy shared result',()=>{
  const{profile,policy,bands}=fixture(),measured={...profile,crownMetres:.5,crownByBand:{'road:0':.5,'walk:1':.72}},input=bands.map(b=>({...b,median:{...b.median,heightN2000:extraBridgeDeckHeight(measured,b.median.station,b.median.lateral,b.median.partId===1?'road':'walk',b.median.partId)+7.5}}));
  assert.throws(()=>fitMeasuredBridgeDeck(profile,input,policy),/measured profile mismatch/);
  const fitting:MeasuredBridgeFitPolicy={...policy,fitByBand:[{band:'road:0',sourceBand:'road-centre'},{band:'walk:1',sourceBand:'east-walk'}]},out=fitMeasuredBridgeDeck(profile,input,fitting);
  assert.ok(Math.abs(out.profile.crownByBand!['walk:1']!-.72)<1e-12);assert.ok(Math.abs(out.profile.crownByBand!['road:0']!-.5)<1e-12);assert.ok(out.proof.maximumAbsoluteMedianResidualMetres<1e-12);assert.deepEqual(out.profile.banks,profile.banks);
  for(const bank of profile.banks)for(const role of ['road','walk']as const)for(const t of role==='road'?[-2,0,2]:[3.2,4,4.8])assert.ok(Math.abs(extraBridgeDeckHeight(out.profile,bank.s,t,role,role==='road'?1:2)-extraBridgeDeckHeight({...profile,crownMetres:.5},bank.s,t,role,role==='road'?1:2))<1e-12);
  const shared={...profile,crownMetres:.5};assert.deepEqual(buildExtraBridgeDeck({...shared,crownByBand:{'road:0':.5,'walk:1':.5}}).faces,buildExtraBridgeDeck(shared).faces);
  assert.throws(()=>fitMeasuredBridgeDeck(profile,input,{...fitting,fitByBand:[{band:'road:0',sourceBand:'road-centre'}]}),/every emitted/);
  assert.throws(()=>fitMeasuredBridgeDeck(profile,input,{...fitting,fitByBand:[{band:'road:0',sourceBand:'road-centre'},{band:'walk:1',sourceBand:'road-centre'}]}),/do not belong/);
  assert.throws(()=>validateExtraBridgeDeck({...shared,crownByBand:{'walk:1':12}}),/longitudinal grade/);
  assert.throws(()=>validateExtraBridgeDeck({...shared,crownByBand:{'walk:-1':.5}}),/Unknown source/);
  assert.throws(()=>validateExtraBridgeDeck({...shared,crownByBand:{'walk:1':NaN}}),/Invalid source/);
});
