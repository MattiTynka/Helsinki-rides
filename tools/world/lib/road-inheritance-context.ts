import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import type {GameplayBundle,RoadGraph,RoadLane,RoadConnector,Vec3} from '../../../packages/world-schema/src/index.ts';
import {sourceSha256} from './source-files.ts';
import {registeredRetainedRoadBaseline,type RetainedRoadAuthority} from './retained-road-review-context.ts';
import {inheritedRoadHeightBaselines,inheritedLegacyProbeIdentity,qualifyReviewedInheritedLegacyProbes,readReviewedInheritedRoadHeight,type InheritedHeightPin,type InheritedHeightContext,type InheritedHeightWorld,type ReviewedInheritedRoadHeightAuthority} from './reviewed-inherited-road-height.ts';
import {inspectRoadPhysicalSupport,RoadCollisionSupport,type RoadCoverage,type RoadPhysicalEnvelope,type RoadSupportTriangle} from './expansion-road-merge.ts';
import {additionalInheritanceBaselines,type AdditionalInheritedRoadAuthority} from './inherited-road-bundle-context.ts';
import {itameriOutsideBaselines,type ReviewedItameriOutsideRegistration}from './reviewed-itameri-outside-registration.ts';
import {kopernikRegistrationBaselines,type ReviewedKopernikRegistration}from './reviewed-kopernik-registration.ts';
import type {LocalPolygon} from './geometry.ts';

export interface RoadInheritanceBinding {approval:InheritedHeightPin;provenanceArchive:InheritedHeightPin;worldCompatibility?:InheritedHeightPin}
type Coverage=Pick<GameplayBundle,'playArea'|'supportedArea'>;
const hash=(value:unknown)=>sourceSha256(JSON.stringify(value));
declare const compositionBrand:unique symbol;
export interface ComposedRoadAuthority {readonly [compositionBrand]:true}
export type OutsideRoadAuthority=RetainedRoadAuthority|ComposedRoadAuthority;
interface Bound {originalHash:string;coverageHash:string;baseline:RoadGraph;exact:Map<string,RoadLane|RoadGraph['footways'][number]>;horizontal:Set<string>}
const compositions=new WeakMap<object,Bound>();
const coverageHash=(coverage:Coverage)=>hash({playArea:coverage.playArea,supportedArea:coverage.supportedArea});

export function prepareRoadInheritance(binding:RoadInheritanceBinding,context:Omit<InheritedHeightContext,'provenanceArchive'>){
  assert.deepEqual(Object.keys(binding).sort(),['approval','provenanceArchive',...(binding.worldCompatibility?['worldCompatibility']:[])].sort());
  return readReviewedInheritedRoadHeight(binding.approval,{...context,provenanceArchive:binding.provenanceArchive,...(binding.worldCompatibility?{worldCompatibility:binding.worldCompatibility}:{})});
}

/** Compose only opaque independently constructed authorities. The actual current
 * graph is mandatory for inherited height; it is never inferred from candidate roads. */
export function composeReviewedRoadBaselines(original:RoadGraph,coverage:Coverage,retained?:RetainedRoadAuthority,inherited?:{authority:ReviewedInheritedRoadHeightAuthority;current:RoadGraph},additional?:{authority:AdditionalInheritedRoadAuthority;current:RoadGraph},itameri?:{authority:ReviewedItameriOutsideRegistration;current:RoadGraph;selectedNewConnectors:readonly RoadConnector[]},kopernik?:{authority:ReviewedKopernikRegistration;current:RoadGraph}){
  const registered=retained?registeredRetainedRoadBaseline(retained,original,coverage):structuredClone(original);
  const retainedIds=registered.lanes.filter((lane,i)=>!isDeepStrictEqual(lane,original.lanes[i])).map(lane=>lane.id);
  if(itameri){const outside=itameriOutsideBaselines(itameri.authority,original,itameri.current,retainedIds,itameri.selectedNewConnectors);for(let i=0;i<original.lanes.length;i++){const old=original.lanes[i]!,after=outside.originalBaseline.lanes[i]!;if(isDeepStrictEqual(old,after))continue;assert.ok(!retainedIds.includes(old.id));(registered.lanes as RoadLane[])[i]=structuredClone(after);retainedIds.push(old.id);}}
  const exact=new Map<string,RoadLane|RoadGraph['footways'][number]>(),horizontal=new Set<string>();let correctedCurrentBaseline:RoadGraph|undefined;
  if(inherited){
    assert.deepEqual(coverage.playArea,{minX:-1792,maxX:800,minZ:-2304,maxZ:768},'Inherited authority requires the original accepted rectangle');
    assert.equal(coverage.supportedArea,undefined,'Inherited authority cannot replace original accepted coverage');
    const corrected=inheritedRoadHeightBaselines(inherited.authority,original,inherited.current,retainedIds);
    correctedCurrentBaseline=corrected.currentBaseline;
    for(let i=0;i<original.lanes.length;i++){
      const old=original.lanes[i]!,after=corrected.originalBaseline.lanes[i]!;
      if(isDeepStrictEqual(old,after))continue;
      assert.ok(!retainedIds.includes(old.id),'Inherited height overlaps retained XZ registration');exact.set('lanes:'+old.id,structuredClone(after));
      (registered.lanes as RoadLane[])[i]=structuredClone(after);
    }

  }
  if(additional){
    assert.deepEqual(coverage.playArea,{minX:-1792,maxX:800,minZ:-2304,maxZ:768},'Inherited authority requires the original accepted rectangle');assert.equal(coverage.supportedArea,undefined);
    if(inherited)assert.deepEqual(additional.current,inherited.current,'Inherited groups use different current graphs');
    const otherIds=[...retainedIds,...[...exact.values()].map(r=>r.id)],corrected=additionalInheritanceBaselines(additional.authority,original,additional.current,otherIds);
    correctedCurrentBaseline??=structuredClone(additional.current);
    for(const kind of['lanes','footways']as const)for(let i=0;i<original[kind].length;i++){
      const old=original[kind][i]!,after=corrected.originalBaseline[kind][i]!;if(isDeepStrictEqual(old,after))continue;assert.ok(!otherIds.includes(old.id),'Inherited groups overlap');
      exact.set(kind+':'+old.id,structuredClone(after));(registered[kind]as (RoadLane|RoadGraph['footways'][number])[])[i]=structuredClone(after);
      const currentIndex=correctedCurrentBaseline[kind].findIndex(r=>r.id===old.id);assert.ok(currentIndex>=0);const currentAfter=corrected.currentBaseline[kind].find(r=>r.id===old.id);assert.ok(currentAfter);(correctedCurrentBaseline[kind]as (RoadLane|RoadGraph['footways'][number])[])[currentIndex]=structuredClone(currentAfter);
    }
  }
  if(itameri)itameriOutsideBaselines(itameri.authority,original,itameri.current,[...retainedIds.filter(id=>id!=='86957349:0:f0'),...[...exact.values()].map(r=>r.id)],itameri.selectedNewConnectors);
  if(kopernik){
    if(inherited)assert.deepEqual(kopernik.current,inherited.current);if(additional)assert.deepEqual(kopernik.current,additional.current);
    const corrected=kopernikRegistrationBaselines(kopernik.authority,original,kopernik.current,[...retainedIds,...[...exact.values()].map(r=>r.id)]);
    for(let i=0;i<original.lanes.length;i++){const before=original.lanes[i]!,after=corrected.originalBaseline.lanes[i]!;if(isDeepStrictEqual(before,after))continue;(registered.lanes as RoadLane[])[i]=structuredClone(after);exact.set('lanes:'+after.id,structuredClone(after));horizontal.add('lanes:'+after.id);}
  }
  // The current-world baseline is height-only. Retained XZ/length authority
  // belongs to registeredAcceptedBaseline and must not enter the writer's
  // separate current-record Y/subdivision preservation branch.
  const authority=Object.freeze({})as ComposedRoadAuthority;compositions.set(authority,{originalHash:hash(original),coverageHash:coverageHash(coverage),baseline:structuredClone(registered),exact,horizontal});
  return{authority,registeredAcceptedBaseline:registered,...(correctedCurrentBaseline?{correctedCurrentBaseline}:{}),literalInheritedIds:[...exact.values()].map(r=>r.id),literalInheritedRecords:[...exact].map(([key,r])=>({kind:key.startsWith('lanes:')?'lanes' as const:'footways' as const,id:r.id}))};
}
export function reviewedRoadBaseline(authority:OutsideRoadAuthority|undefined,original:RoadGraph,coverage:Coverage){
  if(!authority)return original;
  const bound=compositions.get(authority);if(!bound)return registeredRetainedRoadBaseline(authority as RetainedRoadAuthority,original,coverage);
  assert.equal(hash(original),bound.originalHash,'Road composition belongs to another ORIGINAL graph');assert.equal(coverageHash(coverage),bound.coverageHash,'Road composition belongs to another accepted coverage');return structuredClone(bound.baseline);
}
/** Returns true only after checking the exact approved record. Call before the
 * generic projector/assertion, which would insert an unapproved boundary knot. */
export function isLiteralInheritedRoad(authority:OutsideRoadAuthority|undefined,original:RoadGraph,coverage:Coverage,kind:string,record:{id:string}){
  if(!authority)return false;const bound=compositions.get(authority);if(!bound||!bound.exact.has(kind+':'+record.id))return false;
  reviewedRoadBaseline(authority,original,coverage);assert.deepEqual(record,bound.exact.get(kind+':'+record.id),'Inherited road differs from the exact approved AFTER record');return true;
}

export function isLiteralHorizontalRegistration(authority:OutsideRoadAuthority|undefined,original:RoadGraph,coverage:Coverage,kind:string,record:{id:string}){
  return isLiteralInheritedRoad(authority,original,coverage,kind,record)&&compositions.get(authority!)!.horizontal.has(kind+':'+record.id);
}

/** Observe the unchanged ordinary .20m sampler on the approved legacy interval.
 * Its 190 body and eight nominal failures are retained, then independently
 * matched against the complete approved literal probe set. */
export function inspectInheritedLegacyDisposition(authority:ReviewedInheritedRoadHeightAuthority,input:{lane:RoadLane;currentWorld:InheritedHeightWorld;otherRegistrationIds:readonly string[];triangles:readonly RoadSupportTriangle[];parts:readonly LocalPolygon[];coverage:RoadCoverage;envelope:RoadPhysicalEnvelope}){
  assert.equal(hash(input.envelope.definitions),'bdc7451dab6157088d952b942acbf73a80a6d4e780d6132fa48a1ad9f34a65f3','Legacy diagnostic uses different vehicle definitions');
  const support=new RoadCollisionSupport(input.triangles),misses:Vec3[]=[];
  const observed={at(x:number,y:number,z:number){const hit=support.at(x,y,z);if(!hit)misses.push([x,y,z]);return hit;}};
  const physical=inspectRoadPhysicalSupport(input.lane.id,input.lane.points,input.lane.width,['41182','42151'],input.parts,observed,input.coverage,input.envelope,[[191.61737577364184,220.97963333409058]],true);
  assert.equal(physical.failureCount,190);assert.deepEqual(physical.failureCounts,{bodyCollision:190});assert.equal(physical.nominalFailureCount,8);assert.deepEqual(physical.nominalFailureCounts,{laneWidthCollision:8});assert.equal(misses.length,198);
  const nominal=new Set(physical.nominalFailures.map(f=>hash(f.point))),probes=misses.map(point=>{const probe={recordId:input.lane.id,kind:nominal.has(hash(point))?'laneWidthCollision' as const:'bodyCollision' as const,point};return{...probe,sampleIdentity:inheritedLegacyProbeIdentity(probe)};});
  const disposition=qualifyReviewedInheritedLegacyProbes(authority,{lane:input.lane,currentWorld:input.currentWorld,otherRegistrationIds:input.otherRegistrationIds,probes});
  return{physical,observedFailedProbes:probes,disposition};
}
