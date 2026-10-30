import assert from 'node:assert/strict';
import path from 'node:path';
import {parseCollisionBundle,type RoadGraph,type Vec3} from '../../../packages/world-schema/src/index.ts';
import {RoadCollisionSupport,isPublicWalkingGroundTag,type RoadSupportTriangle} from './expansion-road-merge.ts';
import {sourceFile,sourceSha256} from './source-files.ts';
import type {SerializedFloorWorld} from './serialized-road-floor.ts';
import{validateNorthernFootwayRegistration}from'./northern-footway-registration.ts';
import {assertBridgeLevelClosure,type NativeLowerWitness} from './bridge-level-closure.ts';
import {readLayeredSourceParts,sourcePartsForTriangle} from './layered-bridge-source.ts';
import {loadGeoJsonPolygons} from './geometry.ts';
import {prepareReviewedBridgeWalkingSeam,EAST_BRIDGE_WALKING_SEAM_PUBLICATION} from './reviewed-bridge-walking-seam.ts';
interface Pin {file:string;sha256:string}
type Level='upperRoad'|'upperWalking'|'northernLower';
interface Witness extends RoadSupportTriangle {triangleSha256:string;sourcePartIds:number[]}
export function literalLevelSupport(all:readonly RoadSupportTriangle[],selected:readonly Witness[],walking:boolean){
  assert.ok(selected.length>0&&selected.length<=10000);const map=new Map(all.map(t=>[t.id,t])),ids=new Set<string>();
  const triangles=selected.map(w=>{assert.ok(!ids.has(w.id),'Duplicate selected floor face');ids.add(w.id);const actual=map.get(w.id);assert.ok(actual,'Selected floor face is absent from final HCOL');assert.deepEqual(actual.points,w.points,'Selected floor geometry changed');assert.equal(actual.tag,w.tag);assert.equal(sourceSha256(JSON.stringify(w.points)),w.triangleSha256);assert.ok(w.sourcePartIds.length>0&&w.sourcePartIds.every(Number.isSafeInteger));return actual;});
  const accepts=(tag:string)=>walking?(isPublicWalkingGroundTag(tag)||/^raised:(asphalt|slabs|setts|cobble|gravel):bridge-reconstruction$/.test(tag)):tag.startsWith('road:');
  assert.ok(triangles.every(t=>accepts(t.tag)),'Selected floor has an unrelated surface tag');return new RoadCollisionSupport(triangles,accepts);
}
/** Inventory only selects an explicit serialized level for authoring projection. It does not
 * waive public source, bridge clearance, vehicle/capsule, mask or final route acceptance. */
export function prepareBridgeLevelProjectors(input:Pin,world:SerializedFloorWorld,triangles:readonly RoadSupportTriangle[],candidate:RoadGraph,read:(p:Pin,cap?:number)=>Buffer){
  const inventory=JSON.parse(read(input,32*1024*1024).toString());assert.equal(inventory.schemaVersion,1);assert.equal(inventory.kind,'source-bound-bridge-level-selector-candidates');
  assert.equal(inventory.world.sha256,world.manifestSha256);const manifest=JSON.parse(read(inventory.world,16*1024*1024).toString());assert.equal(manifest.origin.id,candidate.originId);
  assert.equal(inventory.candidateRoads.sha256,sourceSha256(read(inventory.candidateRoads,64*1024*1024)));assert.deepEqual(JSON.parse(read(inventory.candidateRoads,64*1024*1024).toString()),candidate);
  const profileBytes=read(inventory.profile),profile=JSON.parse(profileBytes.toString()),osm=JSON.parse(read(inventory.osm).toString()),parts=read(inventory.sourceParts);assert.equal(sourceSha256(parts),profile.sources.streetParts.sha256);assert.equal(inventory.osm.sha256,profile.sources.osm.sha256);assert.equal(inventory.osm.sha256,candidate.source.sha256);
  assert.ok(manifest.publicationFiles.some((ref:{sha256:string})=>ref.sha256===inventory.profile.sha256),'Bridge level profile must be published in this exact source world');
  const ways=new Map<number,any>(osm.elements.filter((e:any)=>e.type==='way').map((e:any)=>[e.id,e]));
  for(const cell of inventory.cells){const actual=manifest.cells.find((c:any)=>c.id===cell.cell);assert.ok(actual);assert.deepEqual(actual.collision,cell.collision);}
  assert.equal(inventory.northPassage.sha256,profile.sourceQualifiedLowerPassages.open[0].sha256);
  const passage=JSON.parse(read(inventory.northPassage,32*1024*1024).toString());
  assert.equal(passage.status,'PASS_SCOPED_NATIVE_CHARACTER_TRANSITIONS_PENDING_FINAL_SERIALIZED_WORLD');
  const lowerPartIds=passage.proof.sourcePartIds as number[];
  assert.ok(lowerPartIds.length>0&&lowerPartIds.every(id=>profile.lowerSource.partIds.includes(id)));
  const streets=JSON.parse(parts.toString()),lowerParts=lowerPartIds.flatMap(id=>readLayeredSourceParts(streets,[id],profile.sourcePartNames?.[id]??profile.lowerSource.name));
  // This input is covered by the passage hash in the published profile. Read the
  // full native cells: the passage's small diagnostic ROI omits valid approach
  // faces and therefore cannot establish the complete lower-role closure.
  const nativeIndexPin=passage.inputs[2] as Pin,nativeIndex=JSON.parse(read(nativeIndexPin,16*1024*1024).toString());
  assert.equal(nativeIndex.schemaVersion,1);assert.equal(nativeIndex.originId,candidate.originId);
  const originalLower:NativeLowerWitness[]=[];
  for(const selectedCell of inventory.cells){
    const cell=nativeIndex.cells.find((c:any)=>c.id===selectedCell.cell);assert.ok(cell);
    const file=sourceFile(path.dirname(nativeIndexPin.file),cell.collision.path),bundle=parseCollisionBundle(read({file,sha256:cell.collision.sha256},64*1024*1024));
    assert.equal(bundle.header.cell,cell.id);assert.equal(bundle.header.originId,candidate.originId);
    for(const collider of bundle.colliders)if(collider.group==='ground')for(let i=0;i<collider.indices.length;i+=3){
      const points=Array.from(collider.indices.subarray(i,i+3),j=>Array.from(collider.positions.subarray(j*3,j*3+3))as Vec3)as[Vec3,Vec3,Vec3],tag=bundle.header.surfaceTags[collider.triangleTags[i/3]!]!,sourcePartIds=sourcePartsForTriangle(points,lowerParts,tag);
      if(sourcePartIds.length)originalLower.push({id:`native:${cell.id}:${collider.id}:${i/3}`,cell:cell.id,points,tag,sourcePartIds});
    }
  }
  const seamRefs=manifest.publicationFiles.filter((ref:{path:string})=>ref.path===EAST_BRIDGE_WALKING_SEAM_PUBLICATION);assert.ok(seamRefs.length<=1,'Duplicate published walking seam profile');
  const additions=seamRefs.map((ref:{path:string;sha256:string})=>prepareReviewedBridgeWalkingSeam({profileBytes:read({file:sourceFile(world.directory,ref.path),sha256:ref.sha256},128*1024),baseProfileBytes:profileBytes,sourcePins:{osmSha256:inventory.osm.sha256,streetPartsSha256:inventory.sourceParts.sha256},parts:loadGeoJsonPolygons(inventory.sourceParts.file,manifest.origin.originProjected[0],manifest.origin.originProjected[1],p=>String(p.osan_id)),way:ways.get(42438829),floor:triangles}));
  const levelClosure=assertBridgeLevelClosure(profile.deck,originalLower,triangles,inventory,inventory.cells.map((c:any)=>c.cell),additions.map((a:ReturnType<typeof prepareReviewedBridgeWalkingSeam>)=>a.authority));
  const levels=new Map<Level,RoadCollisionSupport>();for(const level of ['upperRoad','upperWalking','northernLower']as const)levels.set(level,literalLevelSupport(triangles,inventory[level],level!=='upperRoad'));
  const records=new Map<string,Level>(),witnesses:unknown[]=[],registrations=new Map<string,ReturnType<typeof validateNorthernFootwayRegistration>>();
  assert.ok(Array.isArray(inventory.records)&&inventory.records.length>0&&inventory.records.length<=1000);
  for(const ref of inventory.records){assert.ok(['lane','connector','footway'].includes(ref.kind));assert.ok(levels.has(ref.level));const key=ref.kind+':'+ref.id;assert.ok(!records.has(key));
    const record=ref.kind==='lane'?candidate.lanes.find(r=>r.id===ref.id):ref.kind==='connector'?candidate.connectors.find(r=>r.id===ref.id):candidate.footways.find(r=>r.id===ref.id);assert.ok(record);assert.equal(sourceSha256(JSON.stringify(record)),ref.recordSha256,'Selected source graph record changed');
    if(ref.kind==='connector'){const connector=record as RoadGraph['connectors'][number],from=candidate.lanes.find(r=>r.id===connector.from)!,to=candidate.lanes.find(r=>r.id===connector.to)!;assert.ok(from&&to);assert.deepEqual([from.wayId,to.wayId],ref.sourceWayIds);assert.equal(connector.node,'n'+ref.nodeId);}
    else{const wayId=ref.kind==='lane'?(record as RoadGraph['lanes'][number]).wayId:Number(ref.id.slice(1)),way=ways.get(wayId);assert.ok(way);assert.equal(ref.wayId,wayId);assert.equal(sourceSha256(JSON.stringify(way)),ref.sourceWaySha256);assert.notEqual(wayId,124124301,'Unqualified southern lower passage remains closed');}
    if(ref.level==='northernLower'){assert.equal(ref.kind,'footway');assert.equal(ref.wayId,739516012);assert.equal(inventory.northPassage.sha256,profile.sourceQualifiedLowerPassages.open[0].sha256);assert.deepEqual(ref.registration,inventory.northRegistration);assert.ok(ref.registration);const registration=validateNorthernFootwayRegistration(ref.registration,inventory.northPassage,candidate,osm,manifest.origin,triangles,read);registrations.set(ref.id,registration);}
    assert.ok(ref.kind==='footway'?ref.level!=='upperRoad':ref.level==='upperRoad','A vehicle record cannot use a walking level');records.set(key,ref.level);witnesses.push(ref);
  }
  return{records,registrations,inventory,walkingAdditions:additions,projectFor(kind:'lane'|'connector'|'footway',id:string,fallback:(x:number,z:number)=>{height:number;triangles:string[]}|null){const level=records.get(kind+':'+id);if(!level)return fallback;const selected=levels.get(level)!;return(x:number,z:number)=>selected.project(x,z)??fallback(x,z);},receipt:{schemaVersion:1,status:'EXPLICIT_SOURCE_SERIALIZED_LEVELS_PROJECTED_PENDING_ALL_FINAL_GATES',inventory:input,manifestSha256:world.manifestSha256,profileSha256:inventory.profile.sha256,sourceOsmSha256:inventory.osm.sha256,sourcePartsSha256:inventory.sourceParts.sha256,levelClosure,walkingAdditions:additions.map((a:ReturnType<typeof prepareReviewedBridgeWalkingSeam>)=>a.proof),records:witnesses,registrations:[...registrations.values()].map(r=>r.receipt),levelTriangleIds:Object.fromEntries((['upperRoad','upperWalking','northernLower']as const).map(k=>[k,inventory[k].map((w:Witness)=>w.id)]))}};
}
