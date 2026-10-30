import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {parseTerrain,validateWorldManifest,validateGameplayBundle,validateRoadGraph,encodePackedRoadGraph,decodeRoadGraph,type WorldManifest,type GameplayBundle,type FileRef,type SimulationFileRef} from '../../packages/world-schema/src/index.ts';
import {deliveryFile,readDeliveryFile,freshDeliveryDirectory} from './lib/delivery-city.ts';
import {deliverySha,decodeDeliverySimulation,encodeDeliverySimulation} from './lib/delivery-city-payloads.ts';
import {decodeDeliveryRoadFile} from './lib/delivery-road-file.ts';
import {prepareAppendRoads,type DeliveryRoadBinding} from './lib/delivery-city-roads.ts';
import {readQualifiedSupportedArea,assertSupportedAreaPreservesAccepted,type SupportedAreaInput} from './lib/delivery-supported-area.ts';
import {assertCurrentPlayableNavigationPreserved} from './lib/delivery-navigation-preservation.ts';
import {resolveAppendDeliveryBudget,linkOrCopyDeliveryFile,type AppendDeliveryBudget} from './lib/delivery-city-files.ts';
import {bindDeliveryProducer,verifyDeliveryProducer,publicDeliveryProducer} from './lib/delivery-city-provenance.ts';

interface WorldPin {directory:string;manifestSha256:string}
export interface DeliveryNavigationPlan {
 schemaVersion:1;kind:'final-serialized-city-navigation';world:WorldPin;acceptedWorld:WorldPin;
 roads:DeliveryRoadBinding;roadMerge:DeliveryRoadBinding;outsideProjection?:DeliveryRoadBinding;
 supportedArea:SupportedAreaInput;nativeIndices:DeliveryRoadBinding[];nativeMetadata:DeliveryRoadBinding[];
 release:string;delivery:AppendDeliveryBudget;
}
type PublishedManifest=WorldManifest&{publicationFiles?:SimulationFileRef[]};
/** A final metadata-only stage: all new coverage must already have source-bound
 * qualification against these exact serialized colliders. Geometry stays literal. */
export function applyDeliveryNavigation(value:unknown,out:string) {
 const plan=value as DeliveryNavigationPlan;assert.ok(plan&&typeof plan==='object'&&!Array.isArray(plan));
 const fields=['schemaVersion','kind','world','acceptedWorld','roads','roadMerge','supportedArea','nativeIndices','nativeMetadata','release','delivery',...('outsideProjection'in plan?['outsideProjection']:[])];assert.deepEqual(Object.keys(plan).sort(),fields.sort());
 assert.equal(plan.schemaVersion,1);assert.equal(plan.kind,'final-serialized-city-navigation');assert.match(plan.release,/^[a-z0-9][a-z0-9-]{0,95}$/);const delivery=resolveAppendDeliveryBudget(plan.delivery),producer=bindDeliveryProducer(new URL(import.meta.url)),pins=new Map<string,string>();
 const read=(ref:DeliveryRoadBinding,cap=16*1024*1024)=>{assert.deepEqual(Object.keys(ref).sort(),['file','sha256']);assert.match(ref.sha256,/^[a-f0-9]{64}$/);const info=fs.lstatSync(ref.file);assert.ok(info.isFile()&&!info.isSymbolicLink()&&info.size>0&&info.size<=cap,'Navigation input is not a bounded ordinary file');const b=fs.readFileSync(ref.file);assert.equal(deliverySha(b),ref.sha256,'Navigation input changed: '+path.basename(ref.file));pins.set(path.resolve(ref.file),ref.sha256);return b;};
 const manifest=(ref:WorldPin)=>{assert.deepEqual(Object.keys(ref).sort(),['directory','manifestSha256']);const m=JSON.parse(read({file:path.join(ref.directory,'manifest.json'),sha256:ref.manifestSha256},32*1024*1024).toString())as PublishedManifest;assert.deepEqual(validateWorldManifest(m),[]);return m;};
 const current=manifest(plan.world),accepted=manifest(plan.acceptedWorld);assert.deepEqual(current.origin,accepted.origin);
 const gameplay=(root:string,m:WorldManifest)=>{const g=JSON.parse(decodeDeliverySimulation(readDeliveryFile(root,m.gameplay),m.gameplay).toString())as GameplayBundle;assert.deepEqual(validateGameplayBundle(g),[]);return g;};
 const currentGameplay=gameplay(plan.world.directory,current),acceptedGameplay=gameplay(plan.acceptedWorld.directory,accepted),originalRoads=decodeDeliveryRoadFile(decodeDeliverySimulation(readDeliveryFile(plan.acceptedWorld.directory,accepted.roads),accepted.roads)),currentRoads=decodeDeliveryRoadFile(decodeDeliverySimulation(readDeliveryFile(plan.world.directory,current.roads),current.roads));
 const terrain=parseTerrain(decodeDeliverySimulation(readDeliveryFile(plan.world.directory,current.terrain),current.terrain)),expanded={minX:terrain.x0,minZ:terrain.z0,maxX:terrain.x0+(terrain.nx-1)*terrain.resolution,maxZ:terrain.z0+(terrain.nz-1)*terrain.resolution};
 const mask=readQualifiedSupportedArea(plan.supportedArea,{manifestSha256:plan.acceptedWorld.manifestSha256,originId:current.origin.id,gameplay:acceptedGameplay},expanded);
 assertSupportedAreaPreservesAccepted(mask.supportedArea,currentGameplay,expanded);
 assert.ok(Array.isArray(plan.nativeIndices)&&plan.nativeIndices.length>0&&plan.nativeIndices.length<=8);assert.ok(Array.isArray(plan.nativeMetadata)&&plan.nativeMetadata.length>0&&plan.nativeMetadata.length<=8);
 const nativeIndices=plan.nativeIndices.map(ref=>{const index=JSON.parse(read(ref).toString());assert.equal(index.originId,current.origin.id);assert.ok(Array.isArray(index.cells)&&index.cells.length>0);return ref.sha256;});
 const nativeCaches=plan.nativeMetadata.map(ref=>{const metadata=JSON.parse(read(ref).toString());assert.equal(metadata.kind,'native-delivery-ground-cache');const b=read({file:metadata.cache.path,sha256:metadata.cache.sha256},512*1024*1024);assert.equal(b.length,metadata.cache.bytes);return metadata.cache.sha256;});
 const merge=JSON.parse(read(plan.roadMerge).toString());assert.equal(merge.finalSerializedWorld?.manifestSha256,plan.world.manifestSha256,'Road merge is not qualified on this final structural world');assert.equal(path.resolve(merge.finalSerializedWorld.directory),path.resolve(plan.world.directory));assert.ok(Array.isArray(merge.supportInputs)&&merge.supportInputs.every((r:any)=>r.kind==='final'),'Navigation stage requires final serialized collision qualification');
 const prepared=prepareAppendRoads({roads:plan.roads,roadMerge:plan.roadMerge,outsideProjection:plan.outsideProjection},{accepted:originalRoads,current:currentRoads,acceptedManifestSha256:plan.acceptedWorld.manifestSha256,acceptedRoadsSha256:accepted.roads.sha256,gameplay:acceptedGameplay,supportedAreaSha256:plan.supportedArea.sha256,nativeIndices,nativeCaches,collisions:current.cells.map(c=>({kind:'final',cell:c.id,decodedSha256:c.collision.decodedSha256??c.collision.sha256})),finalWorldManifestSha256:plan.world.manifestSha256});
 assert.deepEqual(validateRoadGraph(prepared.graph),[]);const preservation=assertCurrentPlayableNavigationPreserved(currentRoads,prepared.graph,currentGameplay,originalRoads,prepared.registeredAcceptedBaseline,prepared.correctedCurrentBaseline??currentRoads,prepared.kopernikRegistration),nextGameplay={...structuredClone(currentGameplay),playArea:expanded,supportedArea:mask.supportedArea};assert.deepEqual(validateGameplayBundle(nextGameplay),[]);
 const {playArea:oldBounds,supportedArea:oldMask,...oldValues}=currentGameplay,{playArea:newBounds,supportedArea:newMask,...newValues}=nextGameplay;assert.deepEqual(newValues,oldValues,'Navigation attachment changed unrelated gameplay values');
 const packed=encodePackedRoadGraph(prepared.graph);assert.deepEqual(decodeRoadGraph(packed),prepared.graph);assert.ok(packed.length<=64*1024*1024,'Navigation exceeds unchanged decoded payload cap');
 const files=new Map<string,Uint8Array>(),put=(name:string,b:Uint8Array)=>{assert.ok(!files.has(name));files.set(name,b);return{path:name,bytes:b.length,sha256:deliverySha(b)};},encoded=(prefix:string,b:Uint8Array)=>{const e=encodeDeliverySimulation(b);return{...put(`${prefix}.${deliverySha(b).slice(0,16)}.gz`,e.bytes),compression:e.compression,decodedBytes:e.decodedBytes,decodedSha256:e.decodedSha256};};
 const next:any=structuredClone(current);next.roads=encoded('roads/navigation.bin',packed);const gbytes=Buffer.from(JSON.stringify(nextGameplay)+'\n');next.gameplay=put(`gameplay/navigation.${deliverySha(gbytes).slice(0,16)}.json`,gbytes);
 const proof={schemaVersion:1,kind:plan.kind,status:'SOURCE_AND_FINAL_HCOL_NAVIGATION_CANDIDATE_RUNTIME_PENDING',sourceManifestSha256:plan.world.manifestSha256,acceptedManifestSha256:plan.acceptedWorld.manifestSha256,producer:publicDeliveryProducer(producer),supportedArea:mask.proof,roads:prepared.proof,currentPlayableNavigation:preservation,currentGameplaySha256:current.gameplay.sha256,outputGameplaySha256:next.gameplay.sha256,outputRoadsSha256:next.roads.sha256,preserved:{allCurrentNonCoverageGameplayValues:true,allCurrentAssetsTexturesCellsTerrainAndScenery:true},delivery};
 next.publicationFiles=[...current.publicationFiles??[],encoded('publication/navigation',Buffer.from(JSON.stringify(proof)+'\n'))];next.worldReleaseId=plan.release;next.builtAt=new Date().toISOString();
 const rest=(m:PublishedManifest)=>Object.fromEntries(Object.entries(m).filter(([key])=>!['roads','gameplay','publicationFiles','worldReleaseId','builtAt'].includes(key)));assert.deepEqual(rest(next),rest(current));assert.deepEqual(validateWorldManifest(next),[]);
 const refs=new Map<string,FileRef>();function collect(v:any){if(!v||typeof v!=='object')return;if(typeof v.path==='string'&&typeof v.bytes==='number'&&typeof v.sha256==='string'){const ref={path:v.path,bytes:v.bytes,sha256:v.sha256};if(refs.has(ref.path))assert.deepEqual(refs.get(ref.path),ref);refs.set(ref.path,ref);}for(const child of Object.values(v))collect(child);}collect(next);
 const bytes=Buffer.from(JSON.stringify(next,null,1)+'\n'),worldBytes=bytes.length+[...refs.values()].reduce((n,r)=>n+r.bytes,0);assert.ok(delivery.inclusive?worldBytes<=delivery.worldBudgetBytes:worldBytes<delivery.worldBudgetBytes);assert.ok(refs.size+1<10000);
 const verify=()=>{prepared.verifyInputs();const repeat=readQualifiedSupportedArea(plan.supportedArea,{manifestSha256:plan.acceptedWorld.manifestSha256,originId:current.origin.id,gameplay:acceptedGameplay},expanded);assert.deepEqual(repeat,mask);verifyDeliveryProducer(producer);for(const[file,digest]of pins)assert.equal(deliverySha(fs.readFileSync(file)),digest,'Navigation input changed before publication');};verify();freshDeliveryDirectory(plan.world.directory,out,[plan.acceptedWorld.directory]);
 for(const ref of refs.values()){const target=deliveryFile(out,ref.path);fs.mkdirSync(path.dirname(target),{recursive:true});const b=files.get(ref.path);if(b)fs.writeFileSync(target,b,{flag:'wx'});else linkOrCopyDeliveryFile(deliveryFile(plan.world.directory,ref.path),target,ref);}verify();fs.writeFileSync(path.join(out,'manifest.json'),bytes,{flag:'wx'});
 const result={status:proof.status,manifestSha256:deliverySha(bytes),worldBytes,files:refs.size+1,preservation};fs.writeFileSync(out+'.receipt.json',JSON.stringify(result,null,2)+'\n',{flag:'wx'});return result;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){const{values}=parseArgs({options:{plan:{type:'string'},out:{type:'string'}}});assert.ok(values.plan&&values.out);const b=fs.readFileSync(values.plan);assert.ok(b.length<=128*1024);console.log(JSON.stringify(applyDeliveryNavigation(JSON.parse(b.toString()),values.out)));}
