import assert from 'node:assert/strict';
import {parseCollisionBundle,type WorldManifest} from '../../../packages/world-schema/src/index.ts';
import {sourceSha256,sourceFile} from './source-files.ts';
import {decodeDeliverySimulation} from './delivery-city-payloads.ts';
import type {MeasuredGroundFace} from './delivery-measured-ground.ts';
import type {AuthoredGradePin} from './reviewed-road-grade-authoring.ts';

export const EHRENSTROM_AUTHORING_REVIEW_SHA256='b1e0dcbb125ee1ecc4e8a9a986f63bd08582a46740685f4131f9bdac3c06f5a7';
const PROPOSAL='5e8d274b8379ceb84c236ac29ad5e6febab638d3a08abe8582d8ee6d4850afb3';
const PARENT='874796ad7f00bcc5729ea154d7677c7060a4759e74706e60b4970665f5b9c7ff';
const TERRAIN_BEFORE='63c4896535ff8090e602bfe99ae22407ff9a7b7d63ebf54547a0fd2eaa2059cb';
const TERRAIN_AFTER='cff1a6a5122d4c39ccc3a4ae04a459a07306c7141aac58426834f72019b46711';
const COLLISION_AFTER='b79b0818f01301f854bed7f2bc12800587a38b1cd58755b8cb8c966b7e2f3ab8';
declare const authorityBrand:unique symbol;
export interface ReviewedEhrenstromGradeAuthority {readonly [authorityBrand]:true}
export interface EhrenstromTerrainNode {index:number;x:number;z:number;before:number;after:number;delta:number;beforeBits:number;afterBits:number}
interface Bound {faces:MeasuredGroundFace[];region:number[];nodes:EhrenstromTerrainNode[];cell:any;terrain:any;literal:{collider:string;triangle:number;pointsSha256:string}[]}
const authorities=new WeakMap<object,Bound>();
function finite(value:unknown,label:string):void {if(typeof value==='number')assert.ok(Number.isFinite(value),`${label} must be finite`);else if(value&&typeof value==='object')for(const[k,v]of Object.entries(value))finite(v,`${label}.${k}`);}

/** The finite numeric test is independent of JSON/hash validation: a bad probe
 * calculation must not pass merely because comparisons with NaN are false. */
export function assertFiniteEhrenstromRapierEvidence(proof:any){
  assert.equal(proof.status,'PASS_PRIVATE_SERIALIZED_HCOL_TERRAIN_RAPIER_NOT_APPLIED_WORLD');assert.deepEqual(proof.failures,[]);
  assert.ok(Array.isArray(proof.probes)&&proof.probes.length===639);assert.ok(Array.isArray(proof.dynamics)&&proof.dynamics.length===9);
  finite(proof.probes,'Recovery ray');finite(proof.dynamics,'Suspension probe');let maximumHeightError=0;
  for(const p of proof.probes){assert.ok(Number.isFinite(p.expectedY)&&Number.isFinite(p.hit?.y)&&Number.isFinite(p.hit?.normalY),'Recovery ray height and normal must be finite numbers');assert.equal(p.hit.surface?.group,'ground');assert.ok(p.hit.normalY>=.98&&p.hit.normalY<=1.000001);const error=Math.abs(p.expectedY-p.hit.y);assert.ok(error<.002,'Recovery ray differs from native support');maximumHeightError=Math.max(maximumHeightError,error);}
  for(const d of proof.dynamics){assert.equal(d.fallbackContacts,0);assert.equal(d.minWheelContactsAfterTwoSeconds,4);assert.deepEqual(d.finalWheelContacts,[true,true,true,true]);assert.ok(Number.isFinite(d.minY)&&Number.isFinite(d.maxY)&&d.minY<=d.maxY);assert.ok(['lumi-gt','patrol','revontuli'].includes(d.definition)&&[205,218,232].includes(d.station));}
  assert.equal(new Set(proof.dynamics.map((d:any)=>`${d.definition}:${d.station}`)).size,9);
  return{probes:639,suspensionProbes:9,maximumHeightError};
}

/** One literal signed-authoring authority. This does not extend the generic
 * measured-survey or Telakkakatu upward-only contracts. */
export function readReviewedEhrenstromRoadGrade(pin:AuthoredGradePin,read:(pin:AuthoredGradePin,cap?:number)=>Buffer){
  assert.equal(pin.sha256,EHRENSTROM_AUTHORING_REVIEW_SHA256,'Unapproved Ehrenstrom signed authoring review');
  const checked=(p:AuthoredGradePin,cap=32*1024*1024)=>{assert.deepEqual(Object.keys(p).sort(),['file','sha256']);assert.match(p.sha256,/^[a-f0-9]{64}$/);const b=read(p,cap);assert.ok(b.length>0&&b.length<=cap);assert.equal(sourceSha256(b),p.sha256,'Approved Ehrenstrom input changed');return b;};
  const json=(p:AuthoredGradePin)=>JSON.parse(checked(p).toString());
  const review=json(pin);assert.equal(review.rootReview.decision,'APPROVE_EXACT_SIGNED_NATIVE_PROFILE_AND_82_LITERAL_TERRAIN_NODES_ONLY');assert.equal(review.kind,'bounded-current-mesh-crossfall-road-authoring');assert.equal(review.proposal.sha256,PROPOSAL);assert.equal(review.sourceWorld.manifestSha256,PARENT);assert.deepEqual(review.sourcePartIds,['41236']);assert.equal(review.laneId,'825173902:0:b0');
  const proposal=json(review.proposal),preflight=json(review.preflight),qualification=json(review.sourceQualification),forward=json(review.forwardBinding),physical=json(review.physical),impact=json(review.impact),structure=json(review.structureSeparation),rapier=json(review.rapier),terrainProposal=json(review.terrainProposal),seams=json(review.existingSeamSeparation),mask=json(review.compositeMask);
  assert.deepEqual(proposal.sourceWorld,review.sourceWorld);assert.deepEqual(rapier.world,review.sourceWorld);assert.deepEqual(impact.sourceWorld,review.sourceWorld);assert.equal(forward.newProposalSha256,PROPOSAL);assert.deepEqual(forward.sourceWorld,review.sourceWorld);
  assert.equal(proposal.boundaryPiecewiseGeometryPreserved,true);assert.equal(proposal.sourceAgreementMetres,0);assert.deepEqual(proposal.sourceParts.map((p:any)=>p.id),['41236']);assert.equal(review.authoring.maximumLongitudinalExtrapolation,0);assert.ok(review.authoring.maximumLateralExtension<=2);assert.equal(review.authoring.maximumNativeBoundaryTransitionRetreat,.2287717676682148);
  assert.equal(preflight.status,'PASS_EXACT_NATIVE_TO_CURRENT_DELIVERY_REBASE');assert.equal(preflight.proposalSha256,qualification.proposalSha256);assert.equal(preflight.sourceManifestSha256,qualification.sourceWorld.manifestSha256);assert.equal(preflight.changes.length,1123);assert.equal(preflight.discardedExactDegenerate.length,252);assert.equal(qualification.native.uniquePhysicalFaces,859);assert.equal(qualification.native.formerlyFlatRoadFacesAbovePoint98,true);assert.equal(qualification.native.noPreviouslySteepRoadFaceWorsened,true);
  assert.equal(physical.after.proof.failureCounts.bodyCollision??0,0);assert.ok(Number.isFinite(physical.after.proof.maxHeightDeviation)&&physical.after.proof.maxHeightDeviation<.2);assert.deepEqual(mask.failures,[]);assert.equal(mask.poseChecks,3378);assert.equal(mask.transitionChecks,3375);
  assert.deepEqual(impact.failures,[]);assert.deepEqual(structure,impact);assert.equal(impact.census.cells,775);assert.ok(impact.closestStructureBox.distance>1.6&&impact.trees.minimumChangedFaceSeparation>8&&impact.trees.minimumTerrainInfluenceSeparation>11);
  assert.equal(seams.status,'PASS_EXISTING_558_SEAM_FACES_AND_24_COMMON_NATIVE_FLANKS_LITERAL_AND_SPATIALLY_DISJOINT');assert.equal(seams.uniqueLiteralTriangles,582);assert.equal(seams.addedSeamFaces.triangles,558);assert.equal(seams.commonNativeFlanks.triangles,24);assert.ok(seams.commonNativeFlanks.minimumChangedFaceXZBoxSeparation>67&&seams.commonNativeFlanks.minimumTerrainInfluenceXZBoxSeparation>71);
  assertFiniteEhrenstromRapierEvidence(rapier);assert.equal(rapier.privateCollisionDecodedSha256,COLLISION_AFTER);assert.equal(rapier.terrainOriginalSha256,TERRAIN_BEFORE);assert.equal(rapier.terrainCandidateDecodedSha256,TERRAIN_AFTER);assert.equal(rapier.matchedNativeFaces,859);
  assert.equal(terrainProposal.changedNodes,82);assert.equal(terrainProposal.changes.length,82);assert.equal(terrainProposal.terrainDecodedSha256,TERRAIN_BEFORE);assert.equal(terrainProposal.newMinimumContinuousClearance,.2500100023256452);assert.ok(terrainProposal.maximumLowering<.362);assert.equal(review.terrain.candidateDecodedSha256,TERRAIN_AFTER);
  assert.ok(Array.isArray(review.sourceInputs)&&review.sourceInputs.length===14);for(const p of review.sourceInputs)checked(p,128*1024*1024);
  // Historical preflight is permitted only through this exact published parent
  // chain, with the complete selected cell and terrain refs compared literally.
  const current=json({file:sourceFile(review.sourceWorld.directory,'manifest.json'),sha256:PARENT}),historical=json({file:sourceFile(qualification.sourceWorld.directory,'manifest.json'),sha256:preflight.sourceManifestSha256}),cell=current.cells.find((c:any)=>c.id==='c_p01_p13');assert.ok(cell);
  assert.deepEqual(cell,historical.cells.find((c:any)=>c.id===cell.id));for(const k of['terrain','scenery','gameplay','roads','assets'])assert.deepEqual(current[k],historical[k]);
  assert.equal(sourceSha256(JSON.stringify(cell)),forward.parentComparison.unchangedCellRecordSha256);assert.equal(cell.collision.sha256,rapier.originalCollisionStoredSha256);assert.equal(current.terrain.sha256,terrainProposal.terrainStoredSha256);
  for(const proof of preflight.proofs){assert.equal(proof.cell,cell.id);assert.equal(proof.collision.inputSha256,cell.collision.sha256);for(const v of proof.visual)assert.equal(v.inputSha256,cell.visual[v.level].sha256);}
  const terrain=decodeDeliverySimulation(checked({file:sourceFile(review.sourceWorld.directory,current.terrain.path),sha256:current.terrain.sha256},64*1024*1024),current.terrain);assert.equal(sourceSha256(terrain),TERRAIN_BEFORE);
  const collision=decodeDeliverySimulation(checked({file:sourceFile(review.sourceWorld.directory,cell.collision.path),sha256:cell.collision.sha256},64*1024*1024),cell.collision);assert.equal(sourceSha256(collision),rapier.originalCollisionDecodedSha256);assert.equal(sourceSha256(collision),seams.originalCollisionDecodedSha256);
  const authority=Object.freeze({})as ReviewedEhrenstromGradeAuthority;authorities.set(authority,{faces:structuredClone(preflight.changes),region:[...proposal.patchRegion],nodes:structuredClone(terrainProposal.changes),cell:structuredClone(cell),terrain:structuredClone(current.terrain),literal:structuredClone(seams.literalOccurrences)});
  assertEhrenstromLiteralSeams(authority,collision);replayReviewedEhrenstromTerrain(authority,terrain,terrainProposal.changes);
  return{authority,review,proposal,preflight,qualification,physical,impact,structure,rapier,terrainProposal,forward,seams};
}

export function assertReviewedEhrenstromParent(authority:ReviewedEhrenstromGradeAuthority,manifest:WorldManifest){const b=authorities.get(authority);assert.ok(b,'Ehrenstrom authority must come from the approved reader');assert.deepEqual(manifest.cells.find(c=>c.id==='c_p01_p13'),b.cell);assert.deepEqual(manifest.terrain,b.terrain);}
export function assertReviewedEhrenstromFaces(authority:ReviewedEhrenstromGradeAuthority,faces:readonly MeasuredGroundFace[],region:readonly number[],accepted:readonly number[],terrainSha256:string){
  const b=authorities.get(authority);assert.ok(b,'Ehrenstrom authority must come from the approved reader');assert.deepEqual(faces,b.faces,'Signed faces differ from exact approved native delta');assert.deepEqual(region,b.region);assert.deepEqual(accepted,[-1792,-2304,800,768]);assert.equal(terrainSha256,TERRAIN_BEFORE,'Qualified safety terrain changed');assert.ok(region[1]!>accepted[3]!);
  for(const f of faces)for(let i=0;i<3;i++){const a=f.before[i]!,n=f.after[i]!;assert.ok([...a,...n].every(v=>Number.isFinite(v)&&Math.fround(v)===v));assert.equal(a[0],n[0]);assert.equal(a[2],n[2]);assert.ok(n[1]-a[1]>=-.60&&n[1]-a[1]<=.074);assert.ok(a[0]>=region[0]!&&a[0]<=region[2]!&&a[2]>=region[1]!&&a[2]<=region[3]!);}
  return{kind:'literal-reviewed-ehrenstrom-signed-road-authoring',reviewSha256:EHRENSTROM_AUTHORING_REVIEW_SHA256,proposalSha256:PROPOSAL,measuredSurveyPreservationClaim:false,acceptedInteriorPreserved:true,safetyTerrainBeforeDecodedSha256:TERRAIN_BEFORE,safetyTerrainAfterDecodedSha256:TERRAIN_AFTER};
}
export function replayReviewedEhrenstromTerrain(authority:ReviewedEhrenstromGradeAuthority,decoded:Uint8Array,nodes:readonly EhrenstromTerrainNode[]){
  const b=authorities.get(authority);assert.ok(b,'Ehrenstrom authority must come from the approved reader');assert.deepEqual(nodes,b.nodes,'Terrain nodes differ from exact approved indices and bits');assert.equal(sourceSha256(decoded),TERRAIN_BEFORE,'Qualified safety terrain changed');const out=Buffer.from(decoded);assert.equal(out.subarray(0,4).toString(),'HTER');assert.equal(out.readUInt32LE(4),1);assert.equal(out.length,59275424);const nx=out.readUInt32LE(20),nz=out.readUInt32LE(24),x0=out.readFloatLE(8),z0=out.readFloatLE(12),resolution=out.readFloatLE(16),seen=new Set<number>();
  for(const n of nodes){finite(n,'Terrain node');assert.ok(Number.isSafeInteger(n.index)&&n.index>=0&&n.index<nx*nz&&!seen.has(n.index));seen.add(n.index);assert.equal(x0+n.index%nx*resolution,n.x);assert.equal(z0+Math.floor(n.index/nx)*resolution,n.z);assert.equal(out.readUInt32LE(28+n.index*4),n.beforeBits);assert.equal(out.readFloatLE(28+n.index*4),n.before);assert.ok(n.after<n.before&&n.before-n.after<.362);out.writeUInt32LE(n.afterBits,28+n.index*4);assert.equal(out.readFloatLE(28+n.index*4),n.after);assert.equal(n.after-n.before,n.delta);}
  assert.equal(seen.size,82);assert.equal(sourceSha256(out),TERRAIN_AFTER,'Terrain replay differs from the exact Rapier-tested field');assert.ok(out.subarray(0,28).equals(Buffer.from(decoded.subarray(0,28))));return{bytes:out,proof:{reviewSha256:EHRENSTROM_AUTHORING_REVIEW_SHA256,beforeDecodedSha256:TERRAIN_BEFORE,afterDecodedSha256:TERRAIN_AFTER,changedNodes:82,headerAndAllOtherSamplesPreserved:true,changes:structuredClone(b.nodes)}};
}
function assertEhrenstromLiteralSeams(authority:ReviewedEhrenstromGradeAuthority,decoded:Uint8Array){const b=authorities.get(authority);assert.ok(b);const bundle=parseCollisionBundle(decoded),colliders=new Map(bundle.colliders.map(c=>[c.id,c]));for(const row of b.literal){const c=colliders.get(row.collider);assert.ok(c);const points=Array.from(c.indices.subarray(row.triangle*3,row.triangle*3+3),i=>Array.from(c.positions.subarray(i*3,i*3+3)));assert.equal(sourceSha256(JSON.stringify(points)),row.pointsSha256,'Existing seam or common native flank changed');}}
export function assertReviewedEhrenstromCollision(authority:ReviewedEhrenstromGradeAuthority,cell:string,decoded:Uint8Array){assert.ok(authorities.has(authority),'Ehrenstrom authority must come from the approved reader');assert.equal(cell,'c_p01_p13');assert.equal(sourceSha256(decoded),COLLISION_AFTER,'Signed cell differs from exact Rapier-tested collision');assertEhrenstromLiteralSeams(authority,decoded);}
