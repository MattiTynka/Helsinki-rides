import assert from 'node:assert/strict';
import {gunzipSync} from 'node:zlib';
import type {FileRef,WorldManifest} from '../../../packages/world-schema/src/index.ts';
import {readDeliveryFile} from './delivery-city.ts';
import {decodeDeliverySimulation,deliverySha,MAX_DELIVERY_DECODED_BYTES} from './delivery-city-payloads.ts';
import type {DeliveryBridgeRoadAuthority} from './delivery-city-road-registration.ts';
import {physicalRoadContract,type DeliveryRoadPhysicalContract} from './delivery-city-road-lineage.ts';
import{readDeliveryJunctionRoadDerivatives}from'./delivery-city-road-junction-lineage.ts';
const asRecord=(v:unknown):Record<string,unknown>=>{assert.ok(v&&typeof v==='object'&&!Array.isArray(v),'Road authority must be an object');return v as Record<string,unknown>;};
const number=(v:unknown)=>{assert.ok(typeof v==='number'&&Number.isFinite(v),'Road mask coordinate must be finite');return v;};
/** Legacy publication FileRefs were opaque gzip blobs. Read only a known
 * reconstruction publication path and return explicit typed metadata. */
export function decodeRoadAuthorityPublication(bytes:Uint8Array,ref:FileRef){
 assert.equal(bytes.length,ref.bytes);assert.equal(deliverySha(bytes),ref.sha256);
 assert.match(ref.path,/^publication\/(?:bridge-reconstruction|hameentie-reconstruction|extra-bridges\/[a-z0-9-]+\/reconstruction)\.json\.gz$/);
 const typed=ref as FileRef&{compression?:'gzip';decodedBytes?:number;decodedSha256?:string};
 const raw=typed.compression?decodeDeliverySimulation(bytes,typed):gunzipSync(bytes,{maxOutputLength:MAX_DELIVERY_DECODED_BYTES});
 assert.ok(raw.length>0&&raw.length<=MAX_DELIVERY_DECODED_BYTES);let value:unknown;
 try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));}catch(error){throw new Error(`Invalid road authority JSON: ${ref.path}`,{cause:error});}
 return{value,ref:{...ref,compression:'gzip' as const,decodedBytes:raw.length,decodedSha256:deliverySha(raw)}};
}
export function normalizeDeliveryRoadAuthority(value:unknown,ordinal:number):DeliveryBridgeRoadAuthority{
 const r=asRecord(value),id=r.id??r.bridge;assert.ok(typeof id==='string'&&/^[a-z][a-z0-9-]{2,63}$/.test(id),'Road authority ID is invalid');
 assert.ok(Array.isArray(r.sourceWayIds)&&r.sourceWayIds.length,'Road authority needs exact source way IDs');const sourceWayIds=r.sourceWayIds.map(v=>{assert.ok(Number.isSafeInteger(v)&&v>0,'Road source way ID is invalid');return v as number;});assert.equal(new Set(sourceWayIds).size,sourceWayIds.length);
 const floorTag=r.floorTag??'road:asphalt:bridge-reconstruction';assert.equal(floorTag,'road:asphalt:bridge-reconstruction','An upper road cannot be authorized by footway, terrain or arbitrary floor tags');
 assert.ok(Array.isArray(r.masks)&&r.masks.length,'Road authority has no exact floor masks');const maskIds=new Set<string>();
 const masks=r.masks.map((v,i)=>{const m=asRecord(v);assert.ok(Array.isArray(m.polygon)&&m.polygon.length===3,'Only exact authored ROAD triangles authorize the road graph');const polygon=m.polygon.map(v=>{assert.ok(Array.isArray(v)&&v.length===2);return[number(v[0]),number(v[1])]as[number,number];}),computed=[Math.min(...polygon.map(p=>p[0])),Math.min(...polygon.map(p=>p[1])),Math.max(...polygon.map(p=>p[0])),Math.max(...polygon.map(p=>p[1]))],bounds=m.boundsXZ;assert.ok(Array.isArray(bounds)&&bounds.length===4);bounds.forEach((v,j)=>assert.equal(number(v),computed[j],'Road mask bounds differ from its actual triangle'));const[a,b,c]=polygon as[[number,number],[number,number],[number,number]];assert.ok(Math.abs((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]))>0,'Road mask has zero projected area');const mid=typeof m.id==='string'?m.id:`${id}-publication-${ordinal}-road-${i}`;assert.ok(mid.length&&mid.length<240&&!maskIds.has(mid),'Road mask identity is invalid/duplicate');maskIds.add(mid);return{id:mid,polygon,boundsXZ:computed};});
 return{id,sourceWayIds,floorTag,masks};
}
/** Exact collapsed source projections have no upper-floor area. Preserve the
 * literal record in the publication ledger; never grow it by a tolerance. */
export function partitionDeliveryRoadAreaMasks(value:unknown,ordinal:number){
 const r=asRecord(value);assert.ok(Array.isArray(r.masks));const positive:unknown[]=[],nonArea:any[]=[];
 for(const [index,raw]of r.masks.entries()){const m=asRecord(raw);assert.ok(Array.isArray(m.polygon)&&m.polygon.length===3);const p=m.polygon.map(v=>{assert.ok(Array.isArray(v)&&v.length===2);return[number(v[0]),number(v[1])]as[number,number];}),[a,b,c]=p as[[number,number],[number,number],[number,number]],det=(b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]);if(det===0)nonArea.push({bridge:r.id??r.bridge,originalOrdinal:index,status:'NON_AREA_NO_UPPER_AUTHORITY',record:structuredClone(raw),projectedDeterminant:0});else positive.push({...m,id:m.id??`${r.id??r.bridge}-publication-${ordinal}-road-${index}`});}
 return{value:{...r,masks:positive},nonArea,sourceMaskCount:r.masks.length,positiveMaskCount:positive.length};
}
export function canonicalDeliveryRoadCollisionFiles(publicationPath:string,publication:Record<string,unknown>,contract:Record<string,unknown>){
 if(Array.isArray(contract.collisionFiles)&&contract.collisionFiles.length)return contract.collisionFiles;
 const match=publicationPath.match(/^publication\/extra-bridges\/([a-z0-9-]+)\/reconstruction\.json\.gz$/);assert.ok(match,'Road contract lacks explicit encoded canonical collision lineage');assert.equal(publication.kind,'source-bound-extra-bridge');assert.equal(publication.profileId,match[1]);assert.equal(contract.id,match[1]);assert.ok(Array.isArray(publication.updates)&&publication.updates.length);const ids=new Set<string>();return publication.updates.map(v=>{const u=asRecord(v),after=asRecord(u.after),ref=asRecord(after.collision);assert.ok(typeof u.cell==='string'&&!ids.has(u.cell));ids.add(u.cell);assert.ok(typeof ref.path==='string'&&typeof ref.bytes==='number'&&typeof ref.sha256==='string');return{cell:u.cell,...ref};});
}
export function readDeliveryRoadAuthorities(world:string,manifest:WorldManifest,expectedBridges=8){
 assert.ok(Number.isSafeInteger(expectedBridges)&&expectedBridges>0&&expectedBridges<=8);const refs=(manifest as WorldManifest&{publicationFiles?:FileRef[]}).publicationFiles??[],selected=refs.filter(r=>/^publication\/(?:bridge-reconstruction|hameentie-reconstruction|extra-bridges\/[a-z0-9-]+\/reconstruction)\.json\.gz$/.test(r.path)),ids=new Set<string>(),publications:any[]=[],authorities:DeliveryBridgeRoadAuthority[]=[],contracts:DeliveryRoadPhysicalContract[]=[];
 for(const ref of selected){const decoded=decodeRoadAuthorityPublication(readDeliveryFile(world,ref),ref),object=asRecord(decoded.value);assert.ok(Array.isArray(object.roadGraphContract),'Reconstruction publication lacks roadGraphContract');const parts=object.roadGraphContract.map((v,i)=>partitionDeliveryRoadAreaMasks(v,i)),raw=parts.map(p=>p.value),local=raw.map((v,i)=>normalizeDeliveryRoadAuthority(v,i));for(const [index,a]of local.entries()){assert.ok(!ids.has(a.id),'Conflicting bridge road authority');ids.add(a.id);authorities.push(a);contracts.push(physicalRoadContract({...raw[index],collisionFiles:canonicalDeliveryRoadCollisionFiles(ref.path,object,raw[index]!)},a));}publications.push({ref:decoded.ref,bridgeIds:local.map(a=>a.id),sourceMaskCount:parts.reduce((n,p)=>n+p.sourceMaskCount,0),positiveMaskCount:parts.reduce((n,p)=>n+p.positiveMaskCount,0),nonAreaMasks:parts.flatMap(p=>p.nonArea)});}
 assert.equal(authorities.length,expectedBridges,`Need all ${expectedBridges} candidate-bound bridge ROAD contracts`);
 const derivatives=readDeliveryJunctionRoadDerivatives(world,manifest,authorities,selected);
 for(const derivative of derivatives){for(const recipe of derivative.profile.recipes){const authority=authorities.find(a=>a.id===recipe.parentBridge)!;authority.sourceWayIds=[...new Set([...authority.sourceWayIds,...recipe.sourceWayIds])];}
  for(const[id,authority]of authorities.map(a=>[a.id,a]as const)){const added=derivative.newRoadFaces.filter(f=>f.parentBridge===id).map((f,index)=>{const polygon=f.points.map(p=>[p[0]!,p[2]!]as[number,number]);return{id:`${id}-junction-${derivative.publication.stageId??'diagnostic'}-${index}`,polygon,boundsXZ:[Math.min(...polygon.map(p=>p[0])),Math.min(...polygon.map(p=>p[1])),Math.max(...polygon.map(p=>p[0])),Math.max(...polygon.map(p=>p[1]))]as[number,number,number,number]};});authority.masks.push(...added);contracts.find(c=>c.id===id)!.masks.push(...added);}
  publications.push({ref:derivative.ref,kind:'ordered-exact-source-junction-derivative',profileRef:derivative.profileRef,bridgeIds:[...new Set(derivative.profile.recipes.map((r:any)=>r.parentBridge))],positiveMaskCount:derivative.newRoadFaces.length});
 }
 for(const contract of contracts)contract.junctionDerivatives=derivatives;
 return{authorities,publications,contracts};
}
