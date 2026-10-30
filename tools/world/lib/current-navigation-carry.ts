import assert from 'node:assert/strict';
import {assertOutsideOnlyRoadGraphRepair} from './road-outside-repair.ts';
import {isDeepStrictEqual} from 'node:util';
import {decodeRoadGraph, polylineLength, type RoadGraph, type GameplayBundle, type WorldManifest} from '../../../packages/world-schema/src/index.ts';
import {supportsVehicleTransition} from '../../../packages/sim/src/coverage-footprint.ts';
import {decodeDeliverySimulation} from './delivery-city-payloads.ts';
import {sourceFile, sourceSha256} from './source-files.ts';
import {deriveRoadPhysicalEnvelope, inspectRetainedPathExposure, inspectRoadAdmission, roadCoveragePose, type RoadCoverage, type RoadSourceElement} from './expansion-road-merge.ts';
import {inspectFootwayAdmission} from './expansion-footway-merge.ts';
import type {SerializedFloorWorld} from './serialized-road-floor.ts';

export interface CurrentNavigationPin {file:string;sha256:string}
export interface CurrentNavigationCarryBinding {historicalOsm:CurrentNavigationPin;candidateOsm:CurrentNavigationPin;sourceMask:CurrentNavigationPin}
export const CURRENT_NAVIGATION_GROUPS=['nodes','lanes','connectors','parking','footways'] as const;
type Group=typeof CURRENT_NAVIGATION_GROUPS[number];
type RecordType=RoadGraph[Group][number];
const hash=(v:unknown)=>sourceSha256(JSON.stringify(v));
const ORIGINAL='0e18e55e8730f01144eef72a80decffbb53cdd658222f87a7e8ad6f75f2c4260';
const CURRENT='d453fdd79db114c914322f0209121c34819206b294004bdcece2739f0f3b4701';
const ORIGINAL_GRAPH='0a51af6d65b2958a0de261c7110942b4b1a73ba18accddd6362e5eb1822713c0';
const CURRENT_GRAPH='f13771598ebe1eb7c44a26a568a724de0ec769df8eb00a0a1cd15ad0bb499676';
const HISTORICAL_OSM='a88dd8fffa93fc6018da4f7dc1f56056b20a416911cdc58db3f323e520bbde15';
const CANDIDATE_OSM='a6bf71bae890ab60b4249c8546e6b7185ce37c9ede4137e9c4aefbd9a755e65a';
declare const carryBrand:unique symbol;
export interface CurrentNavigationCarry {readonly[carryBrand]:true}
interface Bound {originalHash:string;currentHash:string;additions:Map<Group,readonly RecordType[]>;originalBaseline:RoadGraph;currentCoverage:RoadCoverage;originalRepairs:ReturnType<typeof assertOutsideOnlyRoadGraphRepair>;verifyInputs:()=>void}
const authorities=new WeakMap<object,Bound>();
function bound(authority:CurrentNavigationCarry){const b=authorities.get(authority);assert.ok(b,'Unrecognized current-navigation carry authority');return b;}

/** Literal copying of the actual current43 is not source, floor, access, or
 * inherited-Y authority. This first integration has no future-world alias. */
export function prepareCurrentNavigationCarry(binding:CurrentNavigationCarryBinding,context:{original:RoadGraph;current:RoadGraph;rawCandidate:RoadGraph;originalWorld:SerializedFloorWorld;currentWorld:SerializedFloorWorld;coverage:RoadCoverage;read:(pin:CurrentNavigationPin,cap?:number)=>Uint8Array}){
  assert.deepEqual(Object.keys(binding).sort(),['candidateOsm','historicalOsm','sourceMask']);
  assert.equal(context.originalWorld.manifestSha256,ORIGINAL);assert.equal(context.currentWorld.manifestSha256,CURRENT,'Unreviewed current-navigation parent');
  assert.equal(hash(context.original),ORIGINAL_GRAPH);assert.equal(hash(context.current),CURRENT_GRAPH,'Actual current43 graph required');
  assert.equal(binding.historicalOsm.sha256,HISTORICAL_OSM);assert.equal(binding.candidateOsm.sha256,CANDIDATE_OSM);assert.equal(context.rawCandidate.source.sha256,CANDIDATE_OSM);
  const pins:{pin:CurrentNavigationPin;cap:number}[]=[],read=(pin:CurrentNavigationPin,cap=64*1024*1024)=>{assert.deepEqual(Object.keys(pin).sort(),['file','sha256']);assert.ok(typeof pin.file==='string'&&pin.file.length<=4096);assert.match(pin.sha256,/^[a-f0-9]{64}$/);const bytes=context.read(pin,cap);assert.ok(bytes.length>0&&bytes.length<=cap);assert.equal(sourceSha256(bytes),pin.sha256);pins.push({pin:structuredClone(pin),cap});return bytes;};
  const json=(pin:CurrentNavigationPin,cap?:number):any=>JSON.parse(Buffer.from(read(pin,cap)).toString());
  const manifests=[context.originalWorld,context.currentWorld].map(w=>json({file:sourceFile(w.directory,'manifest.json'),sha256:w.manifestSha256},16*1024*1024)as WorldManifest);
  const payload=(world:SerializedFloorWorld,ref:WorldManifest['roads'])=>decodeDeliverySimulation(read({file:sourceFile(world.directory,ref.path),sha256:ref.sha256}),ref);
  const graphs=[context.original,context.current];for(let i=0;i<2;i++){assert.equal(manifests[i]!.origin.id,graphs[i]!.originId);assert.deepEqual(decodeRoadGraph(payload([context.originalWorld,context.currentWorld][i]!,manifests[i]!.roads)),graphs[i]);}
  const currentGameplay=JSON.parse(payload(context.currentWorld,manifests[1]!.gameplay).toString())as GameplayBundle;
  const originalGameplay=JSON.parse(payload(context.originalWorld,manifests[0]!.gameplay).toString())as GameplayBundle;assert.deepEqual(currentGameplay.vehicleDefinitions,originalGameplay.vehicleDefinitions);
  const mask=json(binding.sourceMask,2_000_000);assert.equal(mask.qualification.status,'PASS_SOURCE_QUALIFIED_SUPPORTED_AREA');assert.deepEqual(context.coverage,{playArea:mask.qualification.expanded,supportedArea:mask.supportedArea},'Carry coverage differs from pinned final mask');
  const historical=json(binding.historicalOsm)as{elements:RoadSourceElement[]},fresh=json(binding.candidateOsm)as{elements:RoadSourceElement[]};
  const maps=[historical,fresh].map(osm=>{assert.ok(Array.isArray(osm.elements)&&osm.elements.length<=2_000_000);const m=new Map(osm.elements.map(e=>[`${e.type}/${e.id}`,e]));assert.equal(m.size,osm.elements.length);return m;});
  const additions=new Map<Group,readonly RecordType[]>(),witnesses: {kind:Group;id:string;currentSha256:string;rawCandidateSha256:string|null;rawCandidateConflict:boolean}[]=[];
  for(const kind of CURRENT_NAVIGATION_GROUPS){const old=new Set(context.original[kind].map(r=>r.id));assert.equal(old.size,context.original[kind].length);assert.equal(new Set(context.current[kind].map(r=>r.id)).size,context.current[kind].length);const records=context.current[kind].filter(r=>!old.has(r.id));additions.set(kind,structuredClone(records));for(const r of records){const raw=context.rawCandidate[kind].find(x=>x.id===r.id);witnesses.push({kind,id:r.id,currentSha256:hash(r),rawCandidateSha256:raw?hash(raw):null,rawCandidateConflict:!!raw&&!isDeepStrictEqual(raw,r)});}}
  assert.deepEqual(Object.fromEntries([...additions].map(([kind,rows])=>[kind,rows.length])),{nodes:8,lanes:16,connectors:17,parking:0,footways:2});
  // Current originals carry earlier outside-only repairs as a separate data
  // baseline. They grant no protected-Y, source, floor or new-access authority.
  const originalBaseline=structuredClone(context.original);
  for(const kind of CURRENT_NAVIGATION_GROUPS){const currentById=new Map(context.current[kind].map(r=>[r.id,r]));(originalBaseline as any)[kind]=context.original[kind].map(r=>{const actual=currentById.get(r.id);assert.ok(actual,'Current graph removed an original record');return structuredClone(actual);});}
  const originalRepairs=assertOutsideOnlyRoadGraphRepair(context.original,originalBaseline,originalGameplay);
  assert.equal(originalRepairs.length,7,'Unexpected current-original repair census');
  assert.deepEqual(originalRepairs.map(r=>[r.kind,r.id]),[['lanes','122948203:0:f0'],['lanes','122948203:0:b0'],['lanes','333061570:0:f0'],['lanes','333061570:0:b0'],['footways','w692229813'],['footways','w29282225'],['footways','w1552575431']]);
  const requiredWays=new Set<number>(),requiredNodes=new Set<number>();
  for(const r of additions.get('nodes')!)requiredNodes.add(Number(r.id.slice(1)));
  for(const r of additions.get('lanes')!as RoadGraph['lanes']){requiredWays.add(r.wayId);requiredNodes.add(Number(r.from.slice(1)));requiredNodes.add(Number(r.to.slice(1)));}
  for(const r of additions.get('footways')!)requiredWays.add(Number(r.id.slice(1)));
  for(const r of additions.get('connectors')!as RoadGraph['connectors']){requiredNodes.add(Number(r.node.slice(1)));for(const id of[r.from,r.to]){const lane=context.current.lanes.find(l=>l.id===id);assert.ok(lane);requiredWays.add(lane.wayId);}}
  for(const repair of originalRepairs){const r=originalBaseline[repair.kind].find(r=>r.id===repair.id)!;if(repair.kind==='lanes'){const lane=r as RoadGraph['lanes'][number];requiredWays.add(lane.wayId);requiredNodes.add(Number(lane.from.slice(1)));requiredNodes.add(Number(lane.to.slice(1)));}else{assert.equal(repair.kind,'footways');requiredWays.add(Number(r.id.slice(1)));}}
  for(const id of requiredWays){const way=maps[0]!.get('way/'+id);assert.ok(way?.nodes?.length);assert.deepEqual(maps[1]!.get('way/'+id),way,'Current carried way changed in raw source');for(const node of way.nodes)requiredNodes.add(node);}
  for(const id of requiredNodes){assert.ok(Number.isSafeInteger(id)&&id>0);const old=maps[0]!.get('node/'+id);assert.ok(old);assert.deepEqual(maps[1]!.get('node/'+id),old,'Current carried node changed in raw source');}
  const relations=(osm:typeof historical)=>osm.elements.filter(e=>e.type==='relation'&&e.members?.some(m=>m.type==='way'&&requiredWays.has(m.ref)||m.type==='node'&&requiredNodes.has(m.ref))).sort((a,b)=>a.id-b.id);
  assert.deepEqual(relations(fresh),relations(historical),'Carried source relation closure changed');
  const envelope=deriveRoadPhysicalEnvelope(currentGameplay.vehicleDefinitions),paths:unknown[]=[],currentCoverage:RoadCoverage={playArea:currentGameplay.playArea,supportedArea:currentGameplay.supportedArea};
  for(const kind of['lanes','connectors','footways']as const)for(const r of additions.get(kind)!as {id:string;points:RoadGraph['lanes'][number]['points']}[]){
    assert.deepEqual(inspectRetainedPathExposure([r],currentCoverage,context.coverage),[],'Carried path gains new centreline access requiring qualification');
    assert.deepEqual(inspectRetainedPathExposure([r],context.coverage,currentCoverage),[],'Carried path loses current centreline access');
    const range=[[0,polylineLength(r.points)]]as[number,number][],before:ReturnType<typeof inspectFootwayAdmission>|ReturnType<typeof inspectRoadAdmission>=kind==='footways'?inspectFootwayAdmission(r.points,range,currentCoverage):inspectRoadAdmission(r.points,range,currentCoverage,envelope),after:typeof before=kind==='footways'?inspectFootwayAdmission(r.points,range,context.coverage):inspectRoadAdmission(r.points,range,context.coverage,envelope);
    assert.deepEqual(after,before,'Current carried footprint admission changed; copying grants no new access');paths.push({kind,id:r.id,admission:after});
  }
  const junctions=[];for(const connector of additions.get('connectors')!as RoadGraph['connectors']){const a=context.current.lanes.find(l=>l.id===connector.from),b=context.current.lanes.find(l=>l.id===connector.to);assert.ok(a&&b);for(const definition of envelope.definitions)for(const[end,p,q]of[['entrance',roadCoveragePose(a.points,polylineLength(a.points)),roadCoveragePose(connector.points,0)],['exit',roadCoveragePose(connector.points,polylineLength(connector.points)),roadCoveragePose(b.points,0)]]as const){const before=supportsVehicleTransition(currentCoverage,definition,p,q),after=supportsVehicleTransition(context.coverage,definition,p,q);assert.equal(after,before,'Carried junction gains or loses access');junctions.push({id:connector.id,definition:definition.id,end,admitted:after});}}
  const originalHash=hash(context.original),currentHash=hash(context.current),candidateHash=hash(context.rawCandidate),coverageHash=hash(context.coverage);
  const verifyInputs=()=>{for(const{pin,cap}of pins){const b=context.read(pin,cap);assert.ok(b.length>0&&b.length<=cap);assert.equal(sourceSha256(b),pin.sha256,'Current carry input changed');}assert.equal(hash(context.original),originalHash);assert.equal(hash(context.current),currentHash);assert.equal(hash(context.rawCandidate),candidateHash);assert.equal(hash(context.coverage),coverageHash);};verifyInputs();
  const authority=Object.freeze({})as CurrentNavigationCarry;authorities.set(authority,{originalHash,currentHash,additions,originalBaseline,currentCoverage,originalRepairs,verifyInputs});
  return{authority,receipt:{kind:'literal-actual-current-navigation-carry',binding:structuredClone(binding),originalWorld:structuredClone(context.originalWorld),currentWorld:structuredClone(context.currentWorld),originalGraphSha256:originalHash,currentGraphSha256:currentHash,rawCandidateGraphSha256:candidateHash,records:witnesses,originalOutsideRepairs:structuredClone(originalRepairs),originalOutsideRepairCount:originalRepairs.length,originalOutsideBaselineSha256:hash(originalBaseline),originalOutsideRepairsRequireFinalExposureQualification:true,sourceWays:[...requiredWays].sort((a,b)=>a-b).map(id=>({id,sha256:hash(maps[0]!.get('way/'+id))})),sourceNodes:[...requiredNodes].sort((a,b)=>a-b).map(id=>({id,sha256:hash(maps[0]!.get('node/'+id))})),sourceRelationsSha256:hash(relations(historical)),currentGameplaySha256:manifests[1]!.gameplay.sha256,paths,junctions,noNewAccessGranted:true,noSourceFloorOrHeightOverride:true},verifyInputs};
}

export function currentCarryIds(authority:CurrentNavigationCarry,kind:Group){return bound(authority).additions.get(kind)!.map(r=>r.id);}
export function carryCurrentNavigation(authority:CurrentNavigationCarry,original:RoadGraph,target:RoadGraph){const b=bound(authority);assert.equal(hash(original),b.originalHash);const result=structuredClone(target);for(const kind of CURRENT_NAVIGATION_GROUPS){const carried=b.additions.get(kind)!,byId=new Map(carried.map(r=>[r.id,r]));assert.equal(new Set(result[kind].map(r=>r.id)).size,result[kind].length);(result as any)[kind]=result[kind].map(r=>structuredClone(byId.get(r.id)??r));for(const r of carried)if(!result[kind].some(x=>x.id===r.id))(result[kind]as RecordType[]).push(structuredClone(r));}return result;}
export function assertCurrentNavigationCarry(authority:CurrentNavigationCarry,original:RoadGraph,current:RoadGraph,proposed:RoadGraph){const b=bound(authority);assert.equal(hash(original),b.originalHash);assert.equal(hash(current),b.currentHash);for(const kind of CURRENT_NAVIGATION_GROUPS)for(const r of b.additions.get(kind)!){const rows=proposed[kind].filter(p=>p.id===r.id);assert.equal(rows.length,1,'Current carried record omitted/duplicated');assert.deepEqual(rows[0],r,'Current carried record changed');}return true;}

/** Detached actual-current original records. Consumers must apply opaque
 * reviewed overrides separately and still account from the original graph. */
export function currentOriginalNavigation(authority:CurrentNavigationCarry,original:RoadGraph){
 const b=bound(authority);b.verifyInputs();assert.equal(hash(original),b.originalHash);return{baseline:structuredClone(b.originalBaseline),coverage:structuredClone(b.currentCoverage),repairs:structuredClone(b.originalRepairs)};
}
