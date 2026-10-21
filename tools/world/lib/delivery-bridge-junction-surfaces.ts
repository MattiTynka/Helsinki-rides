import assert from 'node:assert/strict';
import type {Vec3,FileRef} from '../../../packages/world-schema/src/index.ts';
import type {BridgeFace} from './bridge-reconstruction.ts';
import {junctionFaceSha,type JunctionFloorBank} from './delivery-bridge-junction-mouths.ts';
import {buildJunctionTravelProfile,type JunctionTravelProfile} from './delivery-bridge-junction-profile.ts';
import polygonClipping from 'polygon-clipping';
import {buildJunctionDomainRows} from './delivery-bridge-junction-domain-rows.ts';
import {clipJunctionRibbonDomain} from './delivery-bridge-junction-ribbon-domain.ts';
import {encodeJunctionSourceDomain} from './delivery-bridge-junction-domain-encoding.ts';

export interface JunctionFloorSource {
  points:readonly[Vec3,Vec3,Vec3];
  uvs:readonly[readonly[number,number],readonly[number,number],readonly[number,number]]|null;
  nearBinding?:{kind:'NO_FULL_NEAR_TRIANGLE_NO_UV_CLAIM';file:FileRef;groundTriangles:number;groundFaceInventorySha256:string};
  source:JunctionFloorBank['source'];
  tag:'road:asphalt'|'road:asphalt:bridge-reconstruction'|'raised:asphalt:bridge-reconstruction'|'raised:slabs:bridge-junction'|'raised:asphalt'|'raised:slabs';
  masks:readonly (readonly [number,number][])[];
}
/** A decoded floor can witness an original skin endpoint outside the repair
 * footprint without gaining floor-cut or new ROAD authority. */
export type JunctionFloorWitness=Pick<JunctionFloorSource,'points'|'source'|'tag'>;
/** Newly authored ramps use the pinned native asphalt repeat chart, keeping
 * their mesh independent of irrelevant old bank tessellation. Original
 * source UVs are retained on every outside fragment by the partitioner. */
export interface JunctionSurfaceOptions {surfaceKind:'road'|'footway';surfaceTag:string}
export function compileJunctionFloorSurfaces(profile:JunctionTravelProfile,sources:readonly JunctionFloorSource[],domain?:polygonClipping.MultiPolygon,surface?:JunctionSurfaceOptions){
  const walking=surface?.surfaceKind==='footway',scale=surface?.surfaceTag==='raised:slabs:bridge-junction'?2:6;
  if(surface){assert.ok(surface.surfaceKind==='road'||walking,'Unknown junction floor kind');assert.ok(walking?['raised:asphalt:bridge-reconstruction','raised:slabs:bridge-junction'].includes(surface.surfaceTag):surface.surfaceTag==='road:asphalt:bridge-reconstruction','Wrong explicit junction floor tag');if(walking)assert.ok(domain,'Walking floor requires its exact named source domain');}
  assert.ok(!(profile.nonAreaBankIntervals?.length)||domain,'A non-area median chart requires its pinned carriageway clipping domain');
  assert.ok(sources.length>0&&sources.length<50_000);
  const sourceIds=new Set<string>();let maximumNativeChartDifference=0,maximumBridgeChartDifference=0;const sourceFloorsWithoutFullNearTwin:unknown[]=[];
  for(const s of sources){
    const id=`${s.source.cell}/${s.source.collider}/${s.source.triangle}`;assert.ok(!sourceIds.has(id),'Duplicate junction source-floor identity');sourceIds.add(id);
    assert.equal(junctionFaceSha(s.points),s.source.orderedFloat32Sha256,'Selected literal floor source changed');
    assert.ok(s.masks.length);if(s.uvs)assert.ok(s.uvs.flat().every(Number.isFinite));else{assert.equal(s.nearBinding?.kind,'NO_FULL_NEAR_TRIANGLE_NO_UV_CLAIM','An absent original source UV needs a bound complete near census');assert.match(s.nearBinding.groundFaceInventorySha256,/^[a-f0-9]{64}$/);assert.ok(Number.isSafeInteger(s.nearBinding.groundTriangles)&&s.nearBinding.groundTriangles>0);sourceFloorsWithoutFullNearTwin.push({source:s.source,nearBinding:s.nearBinding,sourceUvClaim:false});}
    assert.ok((walking?['raised:asphalt:bridge-reconstruction','raised:slabs:bridge-junction','raised:asphalt','raised:slabs']:['road:asphalt','road:asphalt:bridge-reconstruction','raised:asphalt:bridge-reconstruction']).includes(s.tag),'An unrelated/lower material cannot enter the upper junction surface');
    const native=s.tag==='road:asphalt';if(s.uvs){const uvs=s.uvs;s.points.forEach((p,i)=>{const expected=native?[p[0]/6,-p[2]/6]:[p[0]/4,p[2]/4],error=Math.max(...expected.map((v,k)=>Math.abs(v-uvs[i]![k]!)));if(native)maximumNativeChartDifference=Math.max(maximumNativeChartDifference,error);else maximumBridgeChartDifference=Math.max(maximumBridgeChartDifference,error);});}
  }
  const ramp=buildJunctionTravelProfile(profile,.5),faces:BridgeFace[]=[];
  for(let t=0;t<ramp.indices.length;t+=3){const points=[0,1,2].map(k=>ramp.positions[ramp.indices[t+k]!]!)as[Vec3,Vec3,Vec3];faces.push({points,uvs:points.map(p=>[Math.fround(p[0]/6),Math.fround(-p[2]/6)])as BridgeFace['uvs'],material:'asphalt',role:'road',collision:true});}
  const innerSeam=profile.inner.map(k=>{const p=k.point,old=[p[0]/4,p[2]/4],next=[p[0]/scale,-p[2]/scale],repeatPhase=old.map((v,i)=>{const delta=Math.abs(v-next[i]!);return Math.min(delta%1,1-delta%1);});return{source:k.source,point:p,oldBridgeUv:old,newNativeUv:next,repeatPhaseDifference:repeatPhase};});
  let actualDomain=domain,sourceDomainEncoding:ReturnType<typeof encodeJunctionSourceDomain>['proof']|undefined;
  if(profile.sourceDomainClip!==undefined){assert.equal(profile.sourceDomainClip,'source-width-ribbon');assert.ok(domain,'A source-width intersection requires its literal named source union');const polygons=faces.map(f=>[f.points.map(p=>[p[0],p[2]]as[number,number])]);assert.ok(polygons.length);const ribbon=polygonClipping.union(polygons[0]!,...polygons.slice(1)),encoded=encodeJunctionSourceDomain(polygonClipping.intersection(domain,ribbon));sourceDomainEncoding=encoded.proof;actualDomain=encoded.polygons;assert.ok(actualDomain.length,'Source-width ribbon has no actual named source coverage');}
  const clipped=actualDomain?(profile.sourceDomainClip?clipJunctionRibbonDomain(profile,faces,actualDomain):buildJunctionDomainRows(profile,actualDomain)):null;
  const emitted=clipped?.faces??faces,typedFaces=walking?emitted.map(f=>({...f,role:'footway' as const,material:scale===2?'granite' as const:'asphalt' as const,uvs:f.points.map(p=>[Math.fround(p[0]/scale),Math.fround(-p[2]/scale)])as BridgeFace['uvs']})):emitted;
  if(sourceDomainEncoding&&clipped)assert.ok(sourceDomainEncoding.maximumSourceQuantizationMetres+clipped.proof.maximumSourceQuantizationMetres<=.00008,'Complete source-domain encoding exceeds the existing 80 micrometre construction bound');
  return{faces:typedFaces,proof:{...ramp.proof,sourceDomain:clipped?.proof??null,...(profile.sourceDomainClip?{sourceDomainClip:profile.sourceDomainClip,sourceDomainEncoding}:{}),nonAreaBankIntervals:profile.nonAreaBankIntervals??[],authoredTriangles:emitted.length,sourceFloors:sources.length,sourceFloorsWithoutFullNearTwin,...(surface?{surfaceKind:surface.surfaceKind,surfaceTag:surface.surfaceTag}:{}),newFloorUv:{kind:'native-world-repeat',scaleMetres:scale,u:`east/${scale}`,v:`north/${scale}`,originalOutsideUvsLiteral:true,newFloorOriginalSourceUvClaim:false,maximumObservedNativeSourceChartDifference:maximumNativeChartDifference,maximumObservedBridgeSourceChartDifference:maximumBridgeChartDifference,innerSeam,appearanceAcceptanceRequired:true},sourceFloorBindings:sources.map(s=>({source:s.source,tag:s.tag,masks:s.masks}))}};
}
