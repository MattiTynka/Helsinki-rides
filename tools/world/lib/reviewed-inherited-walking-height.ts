import assert from 'node:assert/strict';
import type {RoadGraph} from '../../../packages/world-schema/src/index.ts';
import type {InheritedHeightContext,InheritedHeightPin} from './reviewed-inherited-road-height.ts';
import {readClosedInheritedHeightEvidence,inheritedBundleHash,assertInheritedBundleDisjoint,assertBoundedInheritedGraph} from './inherited-height-bundle-evidence.ts';

declare const authorityBrand:unique symbol;
export interface ReviewedInheritedWalkingHeightAuthority{readonly [authorityBrand]:true}
type Bound=ReturnType<typeof readClosedInheritedHeightEvidence>;
const authorities=new WeakMap<object,Bound>();
function required(authority:ReviewedInheritedWalkingHeightAuthority){const b=authorities.get(authority);assert.ok(b,'Unrecognized inherited-walking-height authority');return b;}

/** Only the independently approved literal seven-record packet. This token
 * grants no floor, XZ, physical-sampling, or other inherited-case exception. */
export function readReviewedInheritedWalkingHeight(approval:InheritedHeightPin,context:InheritedHeightContext){
  const b=readClosedInheritedHeightEvidence('walking',approval,context),authority=Object.freeze({})as ReviewedInheritedWalkingHeightAuthority;
  authorities.set(authority,b);
  return{authority,...inheritedWalkingHeightBaselines(authority,context.original,context.current,context.otherRegistrationIds),witnesses:structuredClone(b.witnesses),receipt:structuredClone(b.receipt),verifyInputs:b.verifyInputs};
}

export function inheritedWalkingHeightBaselines(authority:ReviewedInheritedWalkingHeightAuthority,original:RoadGraph,current:RoadGraph,otherRegistrationIds:readonly string[]){
  const b=required(authority);assertInheritedBundleDisjoint(otherRegistrationIds,b.ids);assertBoundedInheritedGraph(original);assertBoundedInheritedGraph(current);
  assert.equal(inheritedBundleHash(original),b.originalHash,'Inherited authority belongs to another ORIGINAL graph');
  assert.equal(inheritedBundleHash(current),b.currentHash,'Inherited authority belongs to another CURRENT graph');
  const corrected=(graph:RoadGraph):RoadGraph=>({...structuredClone(graph),footways:graph.footways.map(r=>structuredClone(b.afterRecords.find(a=>a.id===r.id)??r)as RoadGraph['footways'][number])});
  return{originalBaseline:corrected(original),currentBaseline:corrected(current)};
}

/** Use at projection handoff: generic recomputation or one extra point is not
 * the reviewed record. Rehash the original evidence before final publication. */
export function assertReviewedInheritedWalkingAfter(authority:ReviewedInheritedWalkingHeightAuthority,record:RoadGraph['footways'][number],otherRegistrationIds:readonly string[]){
  const b=required(authority);assertInheritedBundleDisjoint(otherRegistrationIds,b.ids);const witness=b.witnesses.find(w=>w.id===record.id);
  assert.ok(witness,'Unlisted inherited walking record');assert.equal(inheritedBundleHash(record),witness.afterSha256,'Exact reviewed inherited after record required');
  return structuredClone(witness);
}
