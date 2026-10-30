import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type {RoadGraph,RoadLane} from '../../../packages/world-schema/src/index.ts';
import {sourceFile,sourceSha256} from './source-files.ts';
import type {InheritedHeightContext,InheritedHeightPin,InheritedHeightWorld} from './reviewed-inherited-road-height.ts';
import {assertBoundedInheritedGraph,assertInheritedBundleDisjoint,inheritedBundleHash as hash,type InheritedBundleWitness} from './inherited-height-bundle-evidence.ts';
import {readReviewedInheritedDrivingHeight,assertReviewedInheritedDrivingAfter} from './reviewed-inherited-driving-height.ts';
import {readReviewedInheritedWalkingHeight,assertReviewedInheritedWalkingAfter} from './reviewed-inherited-walking-height.ts';
import {readReviewedInheritedWalkingEdge,assertReviewedInheritedWalkingEdgeAfter,qualifyReviewedInheritedWalkingEdgeDisposition} from './reviewed-inherited-walking-edge.ts';
import {readReviewedInheritedWalkingAvoidance,assertReviewedInheritedWalkingAvoidanceAfter,qualifyReviewedInheritedWalkingAvoidanceDisposition} from './reviewed-inherited-walking-avoidance.ts';
import {readReviewedInheritedRoughDriving,assertReviewedInheritedRoughDrivingAfter,inspectReviewedInheritedRoughDriving} from './reviewed-inherited-rough-driving.ts';
import {readReviewedInheritedWalkingDrains,assertReviewedInheritedWalkingDrainAfter,qualifyReviewedInheritedWalkingDrainEdges,type ReviewedInheritedWalkingDrainsAuthority}from './reviewed-inherited-walking-drains.ts';
import {readReviewedInheritedWalkingCurrentA,assertReviewedInheritedWalkingCurrentAAfter}from './reviewed-inherited-walking-current-a.ts';
import {readReviewedInheritedHietaDriving,assertReviewedInheritedHietaDrivingAfter,inspectReviewedInheritedHietaDriving}from './reviewed-inherited-hieta-driving.ts';
import type {RoadCoverage} from './expansion-road-merge.ts';
import {readReviewedPlazaServiceCorridors,assertReviewedPlazaHeightAfter,type ReviewedPlazaSourceAuthority,type ReviewedPlazaFloorAuthority} from './reviewed-plaza-service-corridors.ts';

interface Entry {approval:InheritedHeightPin;provenanceArchive:InheritedHeightPin;provenanceSupplement?:InheritedHeightPin;officialProducerSupplement?:InheritedHeightPin}
export interface RoadInheritanceBundleBinding {schemaVersion:1;worldCompatibility?:InheritedHeightPin;drivingEight?:Entry;walkingSeven?:Entry;walkingEdge?:Entry;walkingAvoidance?:Entry;roughDriving?:Entry;walkingDrains?:Entry;walkingCurrentA?:Entry;hietaDriving?:Entry;plazaService?:Entry;sourceMask?:InheritedHeightPin}
const IDS={drivingEight:['9776916:0:f0','9776916:0:b0','86533504:0:f1','86533504:0:f2','4236417:0:f0','80715855:0:f0','80715855:0:b0','123813196:0:f0'],walkingSeven:['w28692747','w86356194','w37282867','w86597184','w123812236','w123812246','w618189329'],walkingEdge:['w28842927'],walkingAvoidance:['w28322529'],roughDriving:['24479833:0:f0','24673380:0:f0','123813196:0:f1'],walkingDrains:['w123812255','w1442691114'],walkingCurrentA:['w29282225'],hietaDriving:['86533504:0:f0'],plazaService:['314403243:1:f0','314403243:1:b0','1271953697:0:f0','1271953697:0:b0']};
type Role=keyof typeof IDS;
type Record=RoadLane|RoadGraph['footways'][number];
export interface InheritedWalkingSourceAuthority{authority:ReviewedInheritedWalkingDrainsAuthority;currentWorld:InheritedHeightWorld;sourcePins:InheritedHeightContext['sourcePins'];otherRegistrationIds:readonly string[]}
export interface PlazaRoadRoles {sourceAuthority:ReviewedPlazaSourceAuthority;floorAuthority:ReviewedPlazaFloorAuthority}
interface Member {plaza?:ReturnType<typeof readReviewedPlazaServiceCorridors>;walkingSources?:InheritedWalkingSourceAuthority;role:Role;witnesses:InheritedBundleWitness[];receipt:unknown;originalBaseline:RoadGraph;currentBaseline:RoadGraph;assertAfter:(r:Record)=>unknown;verifyInputs:()=>void;inspect?:(roads:RoadGraph,world:InheritedHeightWorld,coverage:RoadCoverage)=>unknown}
interface Bound {originalHash:string;currentHash:string;world:InheritedHeightWorld;ids:string[];members:Member[];verifyInputs:()=>void}
declare const brand:unique symbol;
export interface AdditionalInheritedRoadAuthority {readonly[brand]:true}
const authorities=new WeakMap<object,Bound>();
function required(a:AdditionalInheritedRoadAuthority){const b=authorities.get(a);assert.ok(b,'Unrecognized inherited bundle authority');return b;}

/** Fixed named constructors only. A candidate graph or caller supplied after
 * record cannot create an inherited-height capability. */
export function prepareAdditionalRoadInheritance(binding:RoadInheritanceBundleBinding,context:Omit<InheritedHeightContext,'provenanceArchive'|'worldCompatibility'>&{coverage?:RoadCoverage}){
  assert.equal(binding.schemaVersion,1);const roles=(Object.keys(IDS)as Role[]).filter(k=>Object.hasOwn(binding,k));assert.ok(roles.length>0);
  assert.deepEqual(Object.keys(binding).sort(),['schemaVersion',...(binding.worldCompatibility?['worldCompatibility']:[]),...(roles.some(role=>role==='walkingCurrentA'||role==='plazaService')?['sourceMask']:[]),...roles].sort());
  const ids=roles.flatMap(k=>IDS[k]);assert.equal(new Set(ids).size,ids.length);assertInheritedBundleDisjoint(context.otherRegistrationIds,ids);
  const members:Member[]=[],extraPins:InheritedHeightPin[]=[];
  const json=(pin:InheritedHeightPin)=>{const file=sourceFile(path.dirname(pin.file),path.basename(pin.file)),stat=fs.statSync(file);assert.ok(stat.isFile()&&stat.size>0&&stat.size<=16*1024*1024);const bytes=fs.readFileSync(file);assert.equal(sourceSha256(bytes),pin.sha256);if(pin.bytes!==undefined)assert.equal(pin.bytes,bytes.length);extraPins.push({file,sha256:pin.sha256,bytes:bytes.length});return JSON.parse(bytes.toString());};
  for(const role of roles){
    const entry=binding[role]!;assert.deepEqual(Object.keys(entry).sort(),['approval','provenanceArchive',...(role==='walkingAvoidance'?['provenanceSupplement']:[]),...(role==='plazaService'?['officialProducerSupplement']:[])].sort());
    const otherRegistrationIds=[...context.otherRegistrationIds,...ids.filter(id=>!IDS[role].includes(id))];
    const {coverage,...baseContext}=context;const common={...baseContext,provenanceArchive:entry.provenanceArchive,otherRegistrationIds,...(['drivingEight','walkingSeven','walkingEdge','walkingAvoidance'].includes(role)&&binding.worldCompatibility?{worldCompatibility:binding.worldCompatibility}:{})};
    if(role==='plazaService'){
      assert.ok(binding.sourceMask&&coverage&&entry.officialProducerSupplement,'Plaza roles require exact mask, coverage and official producer supplement');
      const read=(pin:InheritedHeightPin,cap=64*1024*1024)=>{const file=sourceFile(path.dirname(pin.file),path.basename(pin.file)),stat=fs.lstatSync(file);assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&stat.size>0&&stat.size<=cap);const bytes=fs.readFileSync(file);assert.equal(sourceSha256(bytes),pin.sha256);return bytes;};
      const b=readReviewedPlazaServiceCorridors(entry.approval,{...common,sourceMask:binding.sourceMask,coverage,officialProducerSupplement:entry.officialProducerSupplement,read});
      members.push({...b,plaza:b,role,witnesses:b.receipt.heightCorrections.map(w=>({kind:'lanes' as const,...w})),assertAfter:r=>assertReviewedPlazaHeightAfter(b.heightAuthority,r as RoadLane)});
    }else if(role==='drivingEight'){
      const b=readReviewedInheritedDrivingHeight(entry.approval,common);members.push({...b,role,assertAfter:r=>assertReviewedInheritedDrivingAfter(b.authority,r as RoadLane,otherRegistrationIds)});
    }else if(role==='walkingSeven'){
      const b=readReviewedInheritedWalkingHeight(entry.approval,common);members.push({...b,role,assertAfter:r=>assertReviewedInheritedWalkingAfter(b.authority,r,otherRegistrationIds)});
    }else if(role==='roughDriving'){
      const b=readReviewedInheritedRoughDriving(entry.approval,common);members.push({...b,role,assertAfter:r=>assertReviewedInheritedRoughDrivingAfter(b.authority,r as RoadLane,otherRegistrationIds),inspect:(roads,world,coverage)=>b.witnesses.map(w=>{const lane=roads.lanes.find(r=>r.id===w.id);assert.ok(lane);return inspectReviewedInheritedRoughDriving(b.authority,{lane,currentWorld:world,otherRegistrationIds,coverage});})});
    }else if(role==='hietaDriving'){
      const b=readReviewedInheritedHietaDriving(entry.approval,common);members.push({...b,role,witnesses:[b.witness],assertAfter:r=>assertReviewedInheritedHietaDrivingAfter(b.authority,r as RoadLane,otherRegistrationIds),inspect:(roads,world,coverage)=>{const lane=roads.lanes.find(r=>r.id===b.witness.id);assert.ok(lane);return inspectReviewedInheritedHietaDriving(b.authority,{lane,currentWorld:world,otherRegistrationIds,coverage});}});
    }else if(role==='walkingCurrentA'){
      assert.ok(binding.sourceMask&&coverage,'Current-A walking requires its exact source mask and runtime coverage');const b=readReviewedInheritedWalkingCurrentA(entry.approval,{...common,sourceMask:binding.sourceMask,coverage});members.push({...b,role,witnesses:[b.witness],assertAfter:r=>assertReviewedInheritedWalkingCurrentAAfter(b.authority,r,coverage,binding.sourceMask!.sha256)});
    }else if(role==='walkingDrains'){
      const b=readReviewedInheritedWalkingDrains(entry.approval,common),approval=json(entry.approval);members.push({...b,role,walkingSources:{authority:b.authority,currentWorld:structuredClone(common.currentWorld),sourcePins:structuredClone(common.sourcePins),otherRegistrationIds:[...otherRegistrationIds]},assertAfter:r=>assertReviewedInheritedWalkingDrainAfter(b.authority,r,otherRegistrationIds),inspect:roads=>{const record=roads.footways.find(r=>r.id==='w123812255');assert.ok(record);return qualifyReviewedInheritedWalkingDrainEdges(b.authority,{record,otherRegistrationIds,certificates:approval.numericDisposition.certificates});}});
    }else{
      // The sealed raw batches are read only after the closed constructor has
      // verified their literal approval/provenance/floor context.
      if(role==='walkingEdge'){
        const b=readReviewedInheritedWalkingEdge(entry.approval,common),approval=json(entry.approval),packet=json(approval.packet),c=packet.cases[0];
        members.push({...b,role,witnesses:[b.witness],assertAfter:r=>assertReviewedInheritedWalkingEdgeAfter(b.authority,r,otherRegistrationIds),inspect:roads=>{const record=roads.footways.find(r=>r.id===b.witness.id);assert.ok(record);return qualifyReviewedInheritedWalkingEdgeDisposition(b.authority,{record,otherRegistrationIds,failedStrictIdentityProbes:c.raySummary.failedStrictIdentityProbes,ordinaryAxisRuns:c.nativeRuns});}});
      }else{
        const b=readReviewedInheritedWalkingAvoidance(entry.approval,{...common,provenanceSupplement:entry.provenanceSupplement}),approval=json(entry.approval),packet=json(approval.packet),c=packet.cases[0];
        members.push({...b,role,witnesses:[b.witness],assertAfter:r=>assertReviewedInheritedWalkingAvoidanceAfter(b.authority,r,otherRegistrationIds),inspect:roads=>{const record=roads.footways.find(r=>r.id===b.witness.id);assert.ok(record);return qualifyReviewedInheritedWalkingAvoidanceDisposition(b.authority,{record,otherRegistrationIds,failedStrictIdentityProbes:c.raySummary.failedStrictIdentityProbes,ordinaryAxisRuns:c.nativeRuns});}});
      }
    }
  }
  const verifyInputs=()=>{for(const member of members)member.verifyInputs();for(const pin of extraPins){const bytes=fs.readFileSync(pin.file);assert.equal(bytes.length,pin.bytes);assert.equal(sourceSha256(bytes),pin.sha256,'Inherited bundle packet changed');}};
  const authority=Object.freeze({})as AdditionalInheritedRoadAuthority,bound={originalHash:hash(context.original),currentHash:hash(context.current),world:structuredClone(context.currentWorld),ids,members,verifyInputs};authorities.set(authority,bound);
  const witnesses=members.flatMap(m=>m.witnesses);assert.deepEqual(witnesses.map(w=>w.id).sort(),[...ids].sort());
  return{authority,...additionalInheritanceBaselines(authority,context.original,context.current,context.otherRegistrationIds),witnesses:structuredClone(witnesses),receipt:{schemaVersion:1,kind:'closed-inherited-road-height-bundle',originalManifestSha256:context.originalWorld.manifestSha256,currentManifestSha256:context.currentWorld.manifestSha256,originalGraphSha256:bound.originalHash,currentGraphSha256:bound.currentHash,roles:members.map(m=>({role:m.role,authority:m.receipt})),witnesses:structuredClone(witnesses),currentAdditionsPreserved:43},verifyInputs};
}

export function additionalInheritanceBaselines(authority:AdditionalInheritedRoadAuthority,original:RoadGraph,current:RoadGraph,otherRegistrationIds:readonly string[]){
  const b=required(authority);assertInheritedBundleDisjoint(otherRegistrationIds,b.ids);assertBoundedInheritedGraph(original);assertBoundedInheritedGraph(current);assert.equal(hash(original),b.originalHash,'Inherited bundle belongs to another ORIGINAL graph');assert.equal(hash(current),b.currentHash,'Inherited bundle belongs to another CURRENT graph');
  const apply=(graph:RoadGraph,field:'originalBaseline'|'currentBaseline')=>{let result=structuredClone(graph);for(const member of b.members)for(const w of member.witnesses){const record=member[field][w.kind].find(r=>r.id===w.id);assert.ok(record);member.assertAfter(record);result={...result,[w.kind]:result[w.kind].map(r=>structuredClone(r.id===w.id?record:r))};}return result;};
  return{originalBaseline:apply(original,'originalBaseline'),currentBaseline:apply(current,'currentBaseline')};
}

export function inspectAdditionalInheritanceDispositions(authority:AdditionalInheritedRoadAuthority,input:{roads:RoadGraph;currentWorld:InheritedHeightWorld;coverage:RoadCoverage;otherRegistrationIds:readonly string[]}){
  const b=required(authority);assertInheritedBundleDisjoint(input.otherRegistrationIds,b.ids);assert.equal(input.currentWorld.manifestSha256,b.world.manifestSha256);assert.equal(fs.realpathSync(input.currentWorld.directory),fs.realpathSync(b.world.directory),'Inherited bundle belongs to another floor');
  const results=[];for(const member of b.members){for(const w of member.witnesses){const record=input.roads[w.kind].find(r=>r.id===w.id);assert.ok(record);member.assertAfter(record);}if(member.inspect)results.push({role:member.role,observations:member.inspect(input.roads,input.currentWorld,input.coverage)});}
  b.verifyInputs();return{schemaVersion:1,kind:'closed-inherited-ordinary-failures-retained',currentManifestSha256:b.world.manifestSha256,results};
}

/** Only the opaque, exact-record drain role is forwarded to walking source
 * membership. Returned polygons are never mixed into global municipal parts. */
export function additionalInheritedWalkingSources(authority:AdditionalInheritedRoadAuthority,original:RoadGraph,current:RoadGraph,otherRegistrationIds:readonly string[]){
 const b=required(authority);additionalInheritanceBaselines(authority,original,current,otherRegistrationIds);const result=new Map<string,InheritedWalkingSourceAuthority>();for(const m of b.members)if(m.walkingSources)for(const w of m.witnesses){assert.equal(w.kind,'footways');result.set(w.id,{...m.walkingSources,currentWorld:structuredClone(m.walkingSources.currentWorld),sourcePins:structuredClone(m.walkingSources.sourcePins),otherRegistrationIds:[...m.walkingSources.otherRegistrationIds]});}return result;
}

/** All sixteen exact AFTER records are authoring data. Only the four separately
 * approved height witnesses enter the protected baseline above. */
export function additionalPlazaRecords(authority:AdditionalInheritedRoadAuthority){
 const b=required(authority);b.verifyInputs();return b.members.flatMap(m=>m.plaza?.reviewedRecords.map(r=>structuredClone(r))??[]);
}
export function additionalPlazaRoles(authority:AdditionalInheritedRoadAuthority){
 const b=required(authority);b.verifyInputs();const result=new Map<string,PlazaRoadRoles>();
 for(const m of b.members)if(m.plaza)for(const r of m.plaza.reviewedRecords)result.set(r.id,{sourceAuthority:m.plaza.sourceAuthority,floorAuthority:m.plaza.floorAuthority});return result;
}
