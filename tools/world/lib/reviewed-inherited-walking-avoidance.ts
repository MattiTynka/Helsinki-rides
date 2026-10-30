import assert from 'node:assert/strict';
import type {RoadGraph} from '../../../packages/world-schema/src/index.ts';
import type {InheritedHeightContext,InheritedHeightPin} from './reviewed-inherited-road-height.ts';
import {readSpecialWalkingEvidence,type SpecialWalkingContext} from './inherited-special-walking-evidence.ts';
import {assertBoundedInheritedGraph,assertInheritedBundleDisjoint,inheritedBundleHash as hash} from './inherited-height-bundle-evidence.ts';

declare const authorityBrand:unique symbol;
export interface ReviewedInheritedWalkingAvoidanceAuthority{readonly [authorityBrand]:true}
const authorities=new WeakMap<object,ReturnType<typeof readSpecialWalkingEvidence>>();
function required(authority:ReviewedInheritedWalkingAvoidanceAuthority){const b=authorities.get(authority);assert.ok(b,'Unrecognized inherited walking avoidance authority');return b;}

/** The literal w28322529 approval only, with its failed ordinary checks retained. */
export function readReviewedInheritedWalkingAvoidance(approval:InheritedHeightPin,context:SpecialWalkingContext){
  const b=readSpecialWalkingEvidence('w28322529',approval,context),authority=Object.freeze({})as ReviewedInheritedWalkingAvoidanceAuthority;authorities.set(authority,b);
  return{authority,...inheritedWalkingAvoidanceBaselines(authority,context.original,context.current,context.otherRegistrationIds),witness:structuredClone(b.witness),receipt:structuredClone(b.receipt),verifyInputs:b.verifyInputs};
}
export function inheritedWalkingAvoidanceBaselines(authority:ReviewedInheritedWalkingAvoidanceAuthority,original:RoadGraph,current:RoadGraph,otherRegistrationIds:readonly string[]){
  const b=required(authority);assertInheritedBundleDisjoint(otherRegistrationIds,[b.id]);assertBoundedInheritedGraph(original);assertBoundedInheritedGraph(current);
  assert.equal(hash(original),b.originalHash,'Special authority belongs to another ORIGINAL graph');assert.equal(hash(current),b.currentHash,'Special authority belongs to another CURRENT graph');
  const corrected=(g:RoadGraph):RoadGraph=>({...structuredClone(g),footways:g.footways.map(r=>structuredClone(r.id===b.id?b.after:r))});
  return{originalBaseline:corrected(original),currentBaseline:corrected(current)};
}
export function assertReviewedInheritedWalkingAvoidanceAfter(authority:ReviewedInheritedWalkingAvoidanceAuthority,record:RoadGraph['footways'][number],otherRegistrationIds:readonly string[]){
  const b=required(authority);assertInheritedBundleDisjoint(otherRegistrationIds,[b.id]);assert.equal(record.id,b.id,'Unlisted special walking record');assert.equal(hash(record),b.witness.afterSha256,'Exact special walking AFTER required');return structuredClone(b.witness);
}
/** An observational disposition only. Neither the ray nor tracking result is
 * replaced by PASS; the complete recorded batches must match the approval. */
export function qualifyReviewedInheritedWalkingAvoidanceDisposition(authority:ReviewedInheritedWalkingAvoidanceAuthority,input:{record:RoadGraph['footways'][number];otherRegistrationIds:readonly string[];failedStrictIdentityProbes:readonly unknown[];ordinaryAxisRuns:readonly unknown[]}){
  const b=required(authority);assertReviewedInheritedWalkingAvoidanceAfter(authority,input.record,input.otherRegistrationIds);
  assert.ok(Array.isArray(input.failedStrictIdentityProbes)&&input.failedStrictIdentityProbes.length===1);assert.ok(Array.isArray(input.ordinaryAxisRuns)&&input.ordinaryAxisRuns.length===6);
  assert.equal(hash(input.failedStrictIdentityProbes),hash(b.failedProbes),'Exact failed special ray batch required');assert.equal(hash(input.ordinaryAxisRuns),hash(b.axisRuns),'Exact ordinary axis-run batch required');b.verifyInputs();return structuredClone(b.disposition);
}
