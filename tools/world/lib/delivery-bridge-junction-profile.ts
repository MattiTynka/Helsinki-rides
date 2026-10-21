import assert from 'node:assert/strict';
import type {Vec3} from '../../../packages/world-schema/src/index.ts';
import {junctionFaceSha,type JunctionFloorBank} from './delivery-bridge-junction-mouths.ts';

export interface JunctionBankKnot {
  offset:number;
  point:Vec3;
  plane:readonly[Vec3,Vec3,Vec3];
  source:JunctionFloorBank['source'];
  role?:'parent-road'|'parent-foot-in-source-carriageway'|'retained-native-upper-carriageway';
  /** Literal decoded support tag; explicit walking stages must never infer it
   * from whether the support is an inner or outer bank. */
  surfaceTag?:string;
}
export interface JunctionTravelProfile {
  id:string;
  sourceWayIds:number[];
  centres:{sourceNode:number;x:number;z:number}[];
  /** Both rows use the same signed offset interval, measured from their
   * actual source-axis centres. Knots are decoded face/edge intersections. */
  inner:JunctionBankKnot[];
  outer:JunctionBankKnot[];
  /** Exact named carriageway boundary intersections. A main-road mouth may
   * continue its two pinned branch-side source edges to the inner ROAD row. */
  widths?:{atMetres:number;left:number;right:number;sourcePartIds:number[]}[];
  normalSigns:[number,number];
  velocityRampFraction:number;
  maximumLongitudinalGrade:number;
  transverseInterpolation?:'physical-source-offset';
  /** The exact named source union may trim a source-width continuation at a
   * curved junction. It cannot add floor beyond either source authority. */
  sourceDomainClip?:'source-width-ribbon';
  /** Explicit authored mesh density for curved source charts. It changes no
   * source station, domain, bank, height function or grade limit. */
  stationSpacingMetres?:number;
  /** Interpolation across a source median is only a parameter chart. The
   * compiler must clip it to the pinned carriageway domain before export. */
  nonAreaBankIntervals?:{bank:'inner'|'outer';left:number;right:number;reason:'SOURCE_MEDIAN_NO_FLOOR_AUTHORITY'}[];
}

/** One scalar blend for the WHOLE cross-section keeps every transverse
 * difference inside the convex envelope of the literal two bank profiles.
 * Independent per-face Hermite tangents do not have that property. */
export function junctionTravelBlend(u:number,rampFraction:number){
  assert.ok(u>=0&&u<=1&&rampFraction>0&&rampFraction<.5);
  if(u<rampFraction)return u*u/(2*rampFraction*(1-rampFraction));
  if(u>1-rampFraction)return 1-(1-u)*(1-u)/(2*rampFraction*(1-rampFraction));
  return (u-rampFraction/2)/(1-rampFraction);
}
const distance=(a:readonly number[],b:readonly number[])=>Math.hypot(b[0]!-a[0]!,b[1]!-a[1]!);
export function junctionTravelLengths(centres:JunctionTravelProfile['centres']){const result=[0];for(let i=1;i<centres.length;i++){const a=centres[i-1]!,b=centres[i]!,d=Math.hypot(b.x-a.x,b.z-a.z);assert.ok(d>.01,'Source junction axis contains duplicate XZ stations');result.push(result.at(-1)!+d);}return result;}
/** Actual mapped axis and its smooth cross-row normal. The derivative at a
 * fixed physical offset distinguishes travel grade from inherited crossfall. */
export function junctionTravelFrame(profile:JunctionTravelProfile,s:number){
 const lengths=junctionTravelLengths(profile.centres);assert.ok(s>=0&&s<=lengths.at(-1)!);let i=0;while(i+1<lengths.length&&lengths[i+1]!<s)i++;if(i===profile.centres.length-1)i--;
 const a=profile.centres[i]!,b=profile.centres[i+1]!,length=lengths[i+1]!-lengths[i]!,u=(s-lengths[i]!)/length;
 const normal=(j:number)=>{const a=profile.centres[Math.max(0,j-1)]!,b=profile.centres[Math.min(profile.centres.length-1,j+1)]!,d=Math.hypot(b.x-a.x,b.z-a.z);return[-(b.z-a.z)/d,(b.x-a.x)/d] as [number,number];},A=normal(i),B=normal(i+1),v=A.map((n,k)=>n+(B[k]!-n)*u),dv=A.map((n,k)=>(B[k]!-n)/length),n=Math.hypot(...v),dot=v[0]!*dv[0]!+v[1]!*dv[1]!,sign=profile.normalSigns[0];
 assert.ok(n>.99,'Source junction axis makes an unqualified reversal');assert.ok(sign===1||sign===-1);assert.equal(sign,profile.normalSigns[1]);
 return{origin:[a.x+(b.x-a.x)*u,a.z+(b.z-a.z)*u] as [number,number],normal:v.map(x=>x/n*sign) as [number,number],axisDerivative:[(b.x-a.x)/length,(b.z-a.z)/length] as [number,number],normalDerivative:v.map((x,k)=>(dv[k]!/n-x*dot/n**3)*sign) as [number,number]};
}
function planeHeight(plane:readonly[Vec3,Vec3,Vec3],x:number,z:number){
  const[a,b,c]=plane,det=(b[0]-a[0])*(c[2]-a[2])-(b[2]-a[2])*(c[0]-a[0]);
  assert.ok(det!==0,'A vertical source face cannot authorize a floor bank');
  const gx=((b[1]-a[1])*(c[2]-a[2])-(c[1]-a[1])*(b[2]-a[2]))/det;
  const gz=((b[0]-a[0])*(c[1]-a[1])-(c[0]-a[0])*(b[1]-a[1]))/det;
  const u=((x-a[0])*(c[2]-a[2])-(z-a[2])*(c[0]-a[0]))/det;
  const v=((b[0]-a[0])*(z-a[2])-(b[2]-a[2])*(x-a[0]))/det;
  assert.ok(u>=-1e-7&&v>=-1e-7&&u+v<=1+1e-7,'Junction bank knot is outside its literal decoded source face');
  return a[1]+gx*(x-a[0])+gz*(z-a[2]);
}
function bankHeight(bank:readonly JunctionBankKnot[],offset:number){
  assert.ok(offset>=bank[0]!.offset-1e-10&&offset<=bank.at(-1)!.offset+1e-10,'Junction query exceeds its literal native bank');
  let i=0;while(i+1<bank.length&&bank[i+1]!.offset<offset)i++;
  if(i===bank.length-1)return bank[i]!.point[1];
  const a=bank[i]!,b=bank[i+1]!,u=(offset-a.offset)/(b.offset-a.offset);
  return a.point[1]+(b.point[1]-a.point[1])*u;
}
export function junctionPhysicalOffsetHeight(profile:JunctionTravelProfile,s:number,offset:number){const length=junctionTravelLengths(profile.centres).at(-1)!,blend=junctionTravelBlend(s/length,profile.velocityRampFraction),sample=(bank:readonly JunctionBankKnot[])=>bankHeight(bank,Math.max(bank[0]!.offset,Math.min(bank.at(-1)!.offset,offset)));return sample(profile.inner)*(1-blend)+sample(profile.outer)*blend;}

/** A source-bound longitudinal ramp. This does not grant source-face deletion
 * authority: the caller must separately pin each selected physical/visual
 * face, its level and its municipal-domain intersection. */
export function buildJunctionTravelProfile(profile:JunctionTravelProfile,stationSpacing=.25){
  if(profile.stationSpacingMetres!==undefined){assert.ok(Number.isFinite(profile.stationSpacingMetres)&&profile.stationSpacingMetres>=.01&&profile.stationSpacingMetres<=.5,'Authored source-chart spacing must be explicitly bounded');stationSpacing=profile.stationSpacingMetres;}
  assert.ok(profile.id&&profile.sourceWayIds.length&&profile.centres.length>=2);
  assert.ok(stationSpacing>0&&stationSpacing<=.5);
  assert.ok(profile.maximumLongitudinalGrade>0&&profile.maximumLongitudinalGrade<=.15);
  const lengths=junctionTravelLengths(profile.centres);
  const length=lengths.at(-1)!;
  for(const interval of profile.nonAreaBankIntervals??[]){assert.ok(interval.bank==='inner'||interval.bank==='outer');assert.equal(interval.reason,'SOURCE_MEDIAN_NO_FLOOR_AUTHORITY');assert.ok(Number.isFinite(interval.left)&&Number.isFinite(interval.right)&&interval.left<interval.right);const bank=profile[interval.bank];assert.ok(interval.left>=bank[0]!.offset&&interval.right<=bank.at(-1)!.offset,'A non-area bank interval exceeds its literal parameter bank');}
  for(const bank of[profile.inner,profile.outer]){
    assert.ok(bank.length>=2);
    for(let i=0;i<bank.length;i++){
      const k=bank[i]!;assert.ok(k.point.every(Number.isFinite)&&Number.isFinite(k.offset));
      assert.equal(junctionFaceSha(k.plane),k.source.orderedFloat32Sha256,'Pinned decoded junction bank face changed');
      assert.ok(Math.abs(planeHeight(k.plane,k.point[0],k.point[2])-k.point[1])<=1e-6,'Bank knot no longer lies on its literal decoded plane');
      if(i)assert.ok(k.offset>bank[i-1]!.offset,'Bank knots must retain strictly ordered offsets');
    }
  }
  const innerLeft=profile.inner[0]!.offset,innerWidth=profile.inner.at(-1)!.offset-innerLeft;
  const outerLeft=profile.outer[0]!.offset,outerWidth=profile.outer.at(-1)!.offset-outerLeft;
  assert.ok(innerWidth>0&&outerWidth>0);
  const widths=profile.widths??[{atMetres:0,left:innerLeft,right:profile.inner.at(-1)!.offset,sourcePartIds:profile.sourceWayIds},{atMetres:length,left:outerLeft,right:profile.outer.at(-1)!.offset,sourcePartIds:profile.sourceWayIds}];
  assert.equal(widths[0]!.atMetres,0);assert.equal(widths.at(-1)!.atMetres,length);
  assert.equal(widths[0]!.left,innerLeft);assert.equal(widths[0]!.right,profile.inner.at(-1)!.offset);
  assert.equal(widths.at(-1)!.left,outerLeft);assert.equal(widths.at(-1)!.right,profile.outer.at(-1)!.offset);
  widths.forEach((w,i)=>{assert.ok(w.right>w.left&&w.sourcePartIds.length);if(i)assert.ok(w.atMetres>widths[i-1]!.atMetres);});
  const offsets=[...new Set([...profile.outer.map(k=>k.offset),...profile.inner.map((k,i)=>i===0?outerLeft:i===profile.inner.length-1?profile.outer.at(-1)!.offset:outerLeft+(k.offset-innerLeft)/innerWidth*outerWidth)])].sort((a,b)=>a-b);
  assert.ok(innerLeft<=0&&innerLeft+innerWidth>=0&&outerLeft<=0&&outerLeft+outerWidth>=0,'Both literal bank rows must contain their actual public source axis');
  const innerAxisY=bankHeight(profile.inner,0),outerAxisY=bankHeight(profile.outer,0);
  const normals=profile.centres.map((c,i)=>{
    const a=profile.centres[Math.max(0,i-1)]!,b=profile.centres[Math.min(profile.centres.length-1,i+1)]!,d=Math.hypot(b.x-a.x,b.z-a.z);
    return[-(b.z-a.z)/d,(b.x-a.x)/d]as[number,number];
  });
  assert.ok(profile.normalSigns.every(s=>s===1||s===-1));
  // The sign is an explicit source-axis convention, never inferred from a
  // character camera or the placement of a nearby lower road.
  const sign=profile.normalSigns[0];assert.equal(sign,profile.normalSigns[1]);
  function rawAt(s:number,offset:number):Vec3{
    assert.ok(s>=0&&s<=length);let i=0;while(i+1<lengths.length&&lengths[i+1]!<s)i++;
    if(i===profile.centres.length-1)i--;
    const a=profile.centres[i]!,b=profile.centres[i+1]!,u=(s-lengths[i]!)/(lengths[i+1]!-lengths[i]!);
    let nx=normals[i]![0]+(normals[i+1]![0]-normals[i]![0])*u,nz=normals[i]![1]+(normals[i+1]![1]-normals[i]![1])*u;
    const n=Math.hypot(nx,nz);assert.ok(n>.99,'Source junction axis makes an unqualified reversal');nx=nx/n*sign;nz=nz/n*sign;
    assert.ok(offset>=outerLeft-1e-10&&offset<=outerLeft+outerWidth+1e-10,'Junction query exceeds its literal native bank');
    let wi=0;while(wi+1<widths.length&&widths[wi+1]!.atMetres<s)wi++;if(wi===widths.length-1)wi--;
    const wa=widths[wi]!,wb=widths[wi+1]!,wu=(s-wa.atMetres)/(wb.atMetres-wa.atMetres),left=wa.left+(wb.left-wa.left)*wu,right=wa.right+(wb.right-wa.right)*wu,width=right-left;
    const fraction=(offset-outerLeft)/outerWidth,t=left+width*fraction,blend=junctionTravelBlend(s/length,profile.velocityRampFraction);
    // Anchor the longitudinal profile at the ACTUAL public source axis,
    // rather than a width-dependent midpoint. A notch on one source edge
    // must not heave the stationary opposite edge of the carriageway.
    const shape=(fraction:number)=>(bankHeight(profile.inner,innerLeft+innerWidth*fraction)-innerAxisY)/innerWidth*(1-blend)+(bankHeight(profile.outer,outerLeft+outerWidth*fraction)-outerAxisY)/outerWidth*blend;
    const y=profile.transverseInterpolation==='physical-source-offset'?junctionPhysicalOffsetHeight(profile,s,t):innerAxisY*(1-blend)+outerAxisY*blend+width*(shape(fraction)-shape(-left/width));
    return[a.x+(b.x-a.x)*u+nx*t,y,a.z+(b.z-a.z)*u+nz*t];
  }
  const at=(s:number,offset:number):Vec3=>rawAt(s,offset).map(Math.fround)as Vec3;
  // Exact WFS sides are clipped once by the physical-offset domain compiler.
  // Their old width-sampling lattice is not a second longitudinal boundary.
  const breaks=[...new Set(profile.transverseInterpolation==='physical-source-offset'?[...lengths,length*profile.velocityRampFraction,length*(1-profile.velocityRampFraction)]:[...widths.map(w=>w.atMetres),...lengths])].sort((a,b)=>a-b);
  const stations=breaks.flatMap((s,i)=>i===breaks.length-1?[s]:Array.from({length:Math.ceil((breaks[i+1]!-s)/stationSpacing)},(_,j)=>s+(breaks[i+1]!-s)*j/Math.ceil((breaks[i+1]!-s)/stationSpacing)));
  const positions=stations.flatMap(s=>offsets.map(t=>at(s,t))),indices:number[]=[];
  let maximumLongitudinalGrade=0,maximumTransverseGrade=0,maximumBankError=0,maximumTransverseQuantizationBound=0;let maximumLongitudinalWitness:unknown=null;
  let sourceBankTransverseEnvelope=0;for(const bank of[profile.inner,profile.outer])for(let i=1;i<bank.length;i++)sourceBankTransverseEnvelope=Math.max(sourceBankTransverseEnvelope,Math.abs(bank[i]!.point[1]-bank[i-1]!.point[1])/distance([bank[i-1]!.point[0],bank[i-1]!.point[2]],[bank[i]!.point[0],bank[i]!.point[2]]));
  for(let i=0;i<stations.length;i++)for(let j=0;j<offsets.length;j++){
    const p=positions[i*offsets.length+j]!;
    if(i&&!profile.transverseInterpolation){const q=positions[(i-1)*offsets.length+j]!,d=Math.hypot(p[0]-q[0],p[2]-q[2]);assert.ok(d>0,'Float32 longitudinal junction edge collapsed');const grade=Math.abs(p[1]-q[1])/d;if(grade>maximumLongitudinalGrade){maximumLongitudinalGrade=grade;maximumLongitudinalWitness={stations:[stations[i-1],stations[i]],offset:offsets[j],points:[q,p],lengthXZ:d};}}
    if(j){
      const q=positions[i*offsets.length+j-1]!,d=Math.hypot(p[0]-q[0],p[2]-q[2]);assert.ok(d>0,'Float32 transverse junction edge collapsed');
      const a=rawAt(stations[i]!,offsets[j-1]!),b=rawAt(stations[i]!,offsets[j]!),rawDistance=Math.hypot(b[0]-a[0],b[2]-a[2]),rawDelta=Math.abs(b[1]-a[1]);
      const quantizationBound=rawDelta*Math.abs(1/d-1/rawDistance)+(Math.abs(p[1]-b[1])+Math.abs(q[1]-a[1]))/d;
      const actual=Math.abs(p[1]-q[1])/d;
      maximumTransverseGrade=Math.max(maximumTransverseGrade,actual);maximumTransverseQuantizationBound=Math.max(maximumTransverseQuantizationBound,quantizationBound);
      assert.ok(rawDelta/rawDistance<=sourceBankTransverseEnvelope+1e-9,'Authored junction creates a NEW transverse peak before quantization');
      assert.ok(actual<=sourceBankTransverseEnvelope+quantizationBound+1e-9,'Exported junction transverse peak exceeds its measured Float32 error bound');
    }
    if(i===0||i===stations.length-1){const t=i===0?innerLeft+(offsets[j]!-outerLeft)/outerWidth*innerWidth:offsets[j]!;maximumBankError=Math.max(maximumBankError,Math.abs(p[1]-bankHeight(i===0?profile.inner:profile.outer,t)));}
    if(i&&j){const a=(i-1)*offsets.length+j-1,b=a+1,c=i*offsets.length+j-1,d=c+1;for(const tri of[[a,b,c],[b,d,c]]){const[A,B,C]=tri.map(k=>positions[k]!)as[Vec3,Vec3,Vec3],ny=(B[2]-A[2])*(C[0]-A[0])-(B[0]-A[0])*(C[2]-A[2]);assert.ok(ny!==0,'A positive junction floor triangle collapsed after Float32 conversion');indices.push(...(ny>0?tri:[tri[0]!,tri[2]!,tri[1]!]));}}
  }
  assert.ok(maximumBankError<=.001,'Junction ramp no longer C0 at its exact decoded bank');
  if(profile.transverseInterpolation==='physical-source-offset'){
    const physicalOffsets=[...new Set([0,...profile.inner.map(k=>k.offset),...profile.outer.map(k=>k.offset)])];
    const axis=(s:number,t:number):Vec3=>{let i=0;while(i+1<lengths.length&&lengths[i+1]!<s)i++;if(i===profile.centres.length-1)i--;const u=(s-lengths[i]!)/(lengths[i+1]!-lengths[i]!),a=profile.centres[i]!,b=profile.centres[i+1]!,nx=normals[i]![0]+(normals[i+1]![0]-normals[i]![0])*u,nz=normals[i]![1]+(normals[i+1]![1]-normals[i]![1])*u,n=Math.hypot(nx,nz);return[Math.fround(a.x+(b.x-a.x)*u+nx/n*t),Math.fround(junctionPhysicalOffsetHeight(profile,s,t)),Math.fround(a.z+(b.z-a.z)*u+nz/n*t)];};
    for(let i=1;i<stations.length;i++)for(const t of physicalOffsets){const a=axis(stations[i-1]!,t),b=axis(stations[i]!,t),d=Math.hypot(b[0]-a[0],b[2]-a[2]);assert.ok(d>0,'Actual source-offset travel edge collapsed');const grade=Math.abs(b[1]-a[1])/d;if(grade>maximumLongitudinalGrade){maximumLongitudinalGrade=grade;maximumLongitudinalWitness={stations:[stations[i-1],stations[i]],physicalSourceOffset:t,points:[a,b],lengthXZ:d};}}
  }
  assert.ok(maximumLongitudinalGrade<=profile.maximumLongitudinalGrade,`New longitudinal motor/ped ramp grade exceeds its source-qualified limit: ${JSON.stringify({id:profile.id,maximumLongitudinalGrade,limit:profile.maximumLongitudinalGrade,length,witness:maximumLongitudinalWitness})}`);
  return{positions,indices,at,rawAt,stations,proof:{id:profile.id,length,stations:stations.length,transverseKnots:offsets.length,maximumLongitudinalGrade,maximumLongitudinalWitness,maximumTransverseGrade,sourceBankTransverseEnvelope,maximumTransverseQuantizationBound,maximumBankErrorMetres:maximumBankError,longitudinalLimit:profile.maximumLongitudinalGrade,bankBlend:profile.transverseInterpolation==='physical-source-offset'?'shared-monotone-physical-source-offset':'shared-monotone-C1-progress-source-axis-anchor',transverseInterpolation:profile.transverseInterpolation??'normalized-source-width',sourceBankDerivativesNotClaimedC1:true,sourcePlaneHashes:[...profile.inner,...profile.outer].map(k=>k.source)}};
}
