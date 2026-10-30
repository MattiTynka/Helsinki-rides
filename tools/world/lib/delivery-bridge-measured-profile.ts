import assert from 'node:assert/strict';
import {pointInPolygon} from './geometry.ts';
import {extraBridgeLocal,type ExtraBridgeFrame} from './delivery-extra-bridges-source.ts';
import {extraBridgeDeckHeight,extraBridgePartSide,validateExtraBridgeDeck,type ExtraBridgeDeckProfile,type ExtraBridgeBand} from './delivery-extra-bridges-mesh.ts';
import {sourceSha256} from './source-files.ts';

export interface BridgeLaserWitness {
  pointIndex:number;runtimeXZ:[number,number];heightN2000:number;station:number;lateral:number;partId:number;
  class:17;pointSourceId:number;returnNumber:number;numberOfReturns:number;
}
export interface BridgeLaserBand {role:string;stationBin:number;count:number;median:BridgeLaserWitness}
export interface MeasuredBridgeFitPolicy {
  sourceFrame:ExtraBridgeFrame;originHeightN2000:number;measuredPartIds:readonly number[];
  fitBand:string;stationExtent:readonly[number,number];stationBinMetres:number;minimumBandPoints:number;
  maximumStationGapMetres:number;maximumCrownMetres:number;maximumMedianResidualMetres:number;
  /** Optional complete source band fits. One measured role may not set another
   * role's rise; every emitted band must have its own declared fitting samples. */
  fitByBand?:readonly{band:ExtraBridgeBand;sourceBand:string}[];
}
/** Fit only the already documented crown degree of freedom. Bank sections,
 * footprints, slab thickness and native joins never move to satisfy a fit or
 * lower-floor clearance. Measured medians constrain an authored approximation;
 * they do not establish an unobserved underside or hidden lower floor. */
export function fitMeasuredBridgeDeck(profile:ExtraBridgeDeckProfile,bands:readonly BridgeLaserBand[],policy:MeasuredBridgeFitPolicy){
  assert.deepEqual(profile.frame,policy.sourceFrame,'Measured bridge frame differs from native source axis');assert.ok(Number.isFinite(policy.originHeightN2000));assert.ok(policy.measuredPartIds.length>0&&new Set(policy.measuredPartIds).size===policy.measuredPartIds.length);assert.ok(policy.stationExtent[0]<policy.stationExtent[1]);
  assert.ok(policy.stationBinMetres>0&&policy.stationBinMetres<=5&&policy.maximumStationGapMetres>=policy.stationBinMetres&&policy.maximumStationGapMetres<=5);assert.ok(Number.isInteger(policy.minimumBandPoints)&&policy.minimumBandPoints>=3);assert.ok(policy.maximumCrownMetres>0&&policy.maximumCrownMetres<=12);assert.ok(policy.maximumMedianResidualMetres>0&&policy.maximumMedianResidualMetres<=.25,'A measured profile needs an explicit bounded residual policy');
  const partById=new Map(profile.upperParts.map(p=>[p.id,p])),measured=new Set(policy.measuredPartIds),keys=new Set<string>();for(const id of measured)assert.ok(partById.has(id),'Measured source part is absent from native profile');assert.ok(bands.length>0&&bands.length<=4096);
  for(const b of bands){assert.ok(typeof b.role==='string'&&b.role.length>0&&Number.isInteger(b.count)&&b.count>=policy.minimumBandPoints,'A measured band lacks sufficient source points');assert.ok(Number.isFinite(b.stationBin)&&Math.abs(b.stationBin/policy.stationBinMetres-Math.round(b.stationBin/policy.stationBinMetres))<1e-10);const key=b.role+':'+b.stationBin;assert.ok(!keys.has(key),'Duplicate source measurement band');keys.add(key);
    const p=b.median,part=partById.get(p.partId);assert.ok(part&&measured.has(p.partId),'Laser witness names an undeclared source part');assert.equal(p.class,17,'Upper deck fit requires classified bridge-deck points');assert.ok(Number.isSafeInteger(p.pointIndex)&&p.pointIndex>=0&&Number.isInteger(p.pointSourceId)&&p.pointSourceId>=0&&Number.isInteger(p.returnNumber)&&Number.isInteger(p.numberOfReturns)&&p.returnNumber>=1&&p.returnNumber<=p.numberOfReturns&&p.numberOfReturns<=15);assert.ok(p.runtimeXZ.length===2&&p.runtimeXZ.every(Number.isFinite)&&Number.isFinite(p.heightN2000));assert.ok(pointInPolygon(p.runtimeXZ,part.rings),'Laser witness is outside its exact municipal source footprint');const[s,t]=extraBridgeLocal(profile.frame,p.runtimeXZ);assert.ok(Math.abs(s-p.station)<1e-8&&Math.abs(t-p.lateral)<1e-8,'Laser witness station/position differs');assert.ok(s>=b.stationBin&&s<b.stationBin+policy.stationBinMetres&&s>=policy.stationExtent[0]&&s<=policy.stationExtent[1],'Laser band is outside the measured span');
  }
  for(const id of measured)assert.ok(bands.some(b=>b.median.partId===id),'A measured upper part has no laser witness');
  for(const role of new Set(bands.map(b=>b.role))){const rows=bands.filter(b=>b.role===role).sort((a,b)=>a.stationBin-b.stationBin);assert.ok(rows.length>=3,'A source role needs longitudinal measurements');assert.ok(rows[0]!.stationBin-policy.stationExtent[0]<=policy.maximumStationGapMetres&&policy.stationExtent[1]-(rows.at(-1)!.stationBin+policy.stationBinMetres)<=policy.maximumStationGapMetres,'Measured role does not reach both bridge ends');for(let i=1;i<rows.length;i++)assert.ok(rows[i]!.stationBin-rows[i-1]!.stationBin<=policy.maximumStationGapMetres,'Unmeasured longitudinal bridge gap');}
  const fitting=bands.filter(b=>b.role===policy.fitBand);assert.ok(fitting.length>=3,'No complete measured fitting band');assert.ok(fitting.every(b=>partById.get(b.median.partId)!.role==='road'),'The common crown must be fitted to measured road deck');
  // A zero crown uses the legacy two-row triangulation. Derive the intercept
  // from two positive crowns so every fitted value uses identical quarter rows.
  assert.equal(profile.crownByBand,undefined,'Fit source banks before adding measured crown overrides');
  const one={...profile,crownMetres:1},two={...profile,crownMetres:2},at=(p:BridgeLaserWitness,c:ExtraBridgeDeckProfile)=>extraBridgeDeckHeight(c,p.station,p.lateral,partById.get(p.partId)!.role,p.partId)+policy.originHeightN2000;
  const fit=(rows:readonly BridgeLaserBand[])=>{let numerator=0,denominator=0;for(const b of rows){const p=b.median,a=at(p,one),coefficient=at(p,two)-a,intercept=a-coefficient;assert.ok(coefficient>0,'Measured fitting point has no crown leverage');numerator+=coefficient*(p.heightN2000-intercept);denominator+=coefficient*coefficient;}const crown=numerator/denominator;assert.ok(Number.isFinite(crown)&&crown>0&&crown<=policy.maximumCrownMetres,'Measured crown is outside explicit authored limits');return crown;};
  const crownMetres=fit(fitting),crownByBand:Partial<Record<ExtraBridgeBand,number>>={};
  if(policy.fitByBand!==undefined){
    const bandFor=(p:BridgeLaserWitness):ExtraBridgeBand=>{const part=partById.get(p.partId)!;return`${part.role}:${extraBridgePartSide(profile,part.role,p.lateral,part.id)}` as ExtraBridgeBand;};
    const required=new Set(profile.upperParts.flatMap(p=>p.rings.flat().map(v=>`${p.role}:${extraBridgePartSide(profile,p.role,extraBridgeLocal(profile.frame,v)[1],p.id)}`)));
    assert.ok(Array.isArray(policy.fitByBand)&&policy.fitByBand.length===required.size,'Measured fits must cover every emitted source band');
    for(const assignment of policy.fitByBand as readonly{band:ExtraBridgeBand;sourceBand:string}[]){assert.ok(required.delete(assignment.band),'Duplicate or unknown measured source band');const rows=bands.filter(b=>b.role===assignment.sourceBand);assert.ok(rows.length>=3&&rows.every(b=>bandFor(b.median)===assignment.band),'Source measurements do not belong to the declared band');if(assignment.band==='road:0')assert.equal(assignment.sourceBand,policy.fitBand,'Road crown fitting band differs');crownByBand[assignment.band]=fit(rows);}
    assert.equal(required.size,0);assert.equal(crownByBand['road:0'],crownMetres);
  }
  const fitted={...profile,crownMetres,...(policy.fitByBand?{crownByBand}: {})},residuals=bands.map(b=>{const modelN2000=at(b.median,fitted);return{role:b.role,stationBin:b.stationBin,count:b.count,source:b.median,modelN2000,deltaMetres:modelN2000-b.median.heightN2000};});
  for(const r of residuals)assert.ok(Math.abs(r.deltaMetres)<=policy.maximumMedianResidualMetres,`Native-bank measured profile mismatch ${r.role}/${r.stationBin}/part${r.source.partId}: ${r.deltaMetres}m`);
  const grade=validateExtraBridgeDeck(fitted);assert.deepEqual(fitted.banks,profile.banks);assert.deepEqual(fitted.upperParts,profile.upperParts);
  return{profile:fitted,proof:{schemaVersion:1,status:'MEASURED_BANDS_QUALIFIED_NATIVE_SERIALIZATION_AND_LOWER_PASSAGES_PENDING',method:policy.fitByBand?'Independent least squares crowns on declared classified source bands; every-role and every-source-part residual checks':'Least squares crown on classified road medians; independent every-role and every-source-part residual checks',nativeProfileSha256:sourceSha256(JSON.stringify(profile)),laserBandsSha256:sourceSha256(JSON.stringify(bands)),policy,crownMetres,...(policy.fitByBand?{crownByBand}: {}),maximumAbsoluteMedianResidualMetres:Math.max(...residuals.map(r=>Math.abs(r.deltaMetres))),nativeBanksAndFootprintsUnchanged:true,deckThicknessAuthoredNotMeasured:profile.deckThicknessMetres,grade,residuals}};
}
