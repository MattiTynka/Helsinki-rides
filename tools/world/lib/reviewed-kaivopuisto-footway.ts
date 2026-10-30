import assert from 'node:assert/strict';
import path from 'node:path';
import polygonClipping from 'polygon-clipping';
import {decodeRoadGraph, geodeticToGk25, supportsSegment, validateWorldManifest, type RoadGraph, type Vec3, type WorldManifest} from '../../../packages/world-schema/src/index.ts';
import type {LocalPolygon} from './geometry.ts';
import type {RoadSourceElement} from './expansion-road-merge.ts';
import {sourceFile, sourceSha256} from './source-files.ts';
import {assertHorizontalSubdivision} from './road-horizontal-subdivision.ts';
import {readSerializedRoadFloor, type SerializedFloorWorld} from './serialized-road-floor.ts';
import {decodeDeliverySimulation} from './delivery-city-payloads.ts';

export const KAIVOPUISTO_FOOTWAY_APPROVAL_SHA256='e8f42d3885df4d7b8b2311a27077cc6b764f976a017475fce14729baa4afd4ae';
const PACKET='97cc28015f208681687dea2010cfb902928d18666374eccccd61cb542961d4e7';
const REVIEW='0eae750b07a8cf8d57bd7553ba9f9d4ffd5454f53f0d1de191245d94b3387ab8';
const ARCHIVE='87ce8e4043ec37ffa779fe1b0ddec5e4cce9dd413ef42eed657e96163c78dcc9';
const AFTER='cbfeb733e8b4789cfa9e2d80358272bbaf02a643299983b395248d52c093a8ad';
const TERRAIN='cff1a6a5122d4c39ccc3a4ae04a459a07306c7141aac58426834f72019b46711';
const ID='w87075617';
interface Pin {file:string;sha256:string;bytes?:number}
type Footway=RoadGraph['footways'][number];
const hash=(value:unknown)=>sourceSha256(JSON.stringify(value));
declare const authorityBrand:unique symbol;
export interface ReviewedKaivopuistoFootway {readonly[authorityBrand]:true}
interface Bound {registered:Footway;nodes:Map<number,Vec3>;sourceWaySha256:string;receipt:object}
const authorities=new WeakMap<object,Bound>();

/** One source-contained NEW walking trace. No accepted-record, driving, bridge,
 * stair, floor-selection, physical-tolerance or arbitrary registration permission. */
export function readReviewedKaivopuistoFootway(approvalPin:Pin,input:{
 accepted:RoadGraph;candidate:RoadGraph;world:SerializedFloorWorld;
 sourcePins:{osmSha256:string;streetPartsSha256:string};
 osm:{elements:RoadSourceElement[]};parts:readonly LocalPolygon[];
 read:(pin:Pin,cap?:number)=>Uint8Array;
}){
 assert.equal(approvalPin.sha256,KAIVOPUISTO_FOOTWAY_APPROVAL_SHA256,'Unapproved Kaivopuisto walking registration');
 assert.ok(!input.accepted.footways.some(f=>f.id===ID),'New walking registration cannot replace an accepted footway');
 const pins:{pin:Pin;cap:number}[]=[];
 const read=(pin:Pin,cap=16*1024*1024)=>{assert.deepEqual(Object.keys(pin).sort(),(pin.bytes===undefined?['file','sha256']:['file','sha256','bytes']).sort());assert.match(pin.sha256,/^[a-f0-9]{64}$/);const bytes=input.read(pin,cap);assert.ok(bytes.length>0&&bytes.length<=cap);if(pin.bytes!==undefined)assert.equal(bytes.length,pin.bytes);assert.equal(sourceSha256(bytes),pin.sha256,'Approved walking input changed');pins.push({pin:structuredClone(pin),cap});return bytes;};
 const json=(pin:Pin,cap?:number):any=>JSON.parse(Buffer.from(read(pin,cap)).toString());
 const approval=json(approvalPin,65536);assert.equal(approval.kind,'literal-new-kaivopuisto-footway-registration-approval');assert.equal(approval.packet.sha256,PACKET);assert.equal(approval.independentReview.sha256,REVIEW);assert.equal(approval.provenanceArchive.sha256,ARCHIVE);
 const packet=json(approval.packet),review=json(approval.independentReview),qualification=json(packet.qualification);
 assert.equal(review.status,'PASS_INDEPENDENT_EXACT_SOURCE_FLOAT32_NATIVE_AND_SIX_CHARACTER_REPLAY_PROPOSAL_ONLY');assert.equal(review.packet.sha256,PACKET);assert.equal(review.allFieldsExceptRedirectedProducerHashExactlyReproduced,true);
 read(review.independentSource);read(review.replayed);read(packet.producer);read(packet.packager);
 assert.equal(packet.kind,'kaivopuisto-source-contained-new-footway');assert.equal(packet.recordId,ID);assert.equal(packet.afterRecordSha256,AFTER);
 assert.equal(qualification.record.afterSha256,AFTER);assert.equal(hash(qualification.record.after),AFTER);assert.equal(qualification.record.beforeSha256,packet.beforeRecordSha256);assert.equal(hash(qualification.record.before),packet.beforeRecordSha256);
 const registered=qualification.record.after as Footway,before=qualification.record.before as Footway;
 const originalGraph=decodeRoadGraph(read(packet.originalGraph,64*1024*1024)),proposedGraph=decodeRoadGraph(read(packet.proposedGraph,64*1024*1024));
 assert.deepEqual(originalGraph.footways.find(f=>f.id===ID),before);assert.deepEqual(proposedGraph.footways.find(f=>f.id===ID),registered);
 const other=(g:RoadGraph)=>({...g,footways:g.footways.filter(f=>f.id!==ID)});assert.deepEqual(other(originalGraph),other(proposedGraph),'Walking proposal changes another graph record');
 for(const pin of Object.values(packet.sources)as Pin[])read(pin,64*1024*1024);
 assert.deepEqual(input.sourcePins,{osmSha256:packet.sources.osm.sha256,streetPartsSha256:packet.sources.parts.sha256});assert.equal(input.candidate.source.sha256,input.sourcePins.osmSha256);
 const mapping=json(approval.provenanceArchive,2*1024*1024);assert.equal(mapping.packetSha256,PACKET);assert.equal(mapping.independentReviewSha256,REVIEW);assert.equal(mapping.files.length,55);
 for(const p of mapping.files)read({file:sourceFile(path.dirname(approval.provenanceArchive.file),p.path),sha256:p.sha256,bytes:p.bytes},4*1024*1024);
 const manifestBytes=read({file:sourceFile(input.world.directory,'manifest.json'),sha256:input.world.manifestSha256}),manifest=JSON.parse(Buffer.from(manifestBytes).toString())as WorldManifest;assert.deepEqual(validateWorldManifest(manifest),[]);assert.equal(manifest.origin.id,input.candidate.originId);assert.equal(manifest.origin.id,input.accepted.originId);
 const terrainStored=read({file:sourceFile(input.world.directory,manifest.terrain.path),sha256:manifest.terrain.sha256,bytes:manifest.terrain.bytes},64*1024*1024);assert.equal(sourceSha256(decodeDeliverySimulation(terrainStored,manifest.terrain)),TERRAIN,'Qualified walking safety terrain changed');
 const region=qualification.world.region as[number,number,number,number];assert.deepEqual(region,[25,1323,76,1377]);
 const floor=readSerializedRoadFloor(input.world,region,manifest.origin.id);
 assert.deepEqual(floor.receipt.cells.map(c=>({cell:c.cell,decodedSha256:c.decodedSha256,decodedBytes:c.decodedBytes})),qualification.world.cells.map((c:any)=>({cell:c.cell,decodedSha256:c.decodedSha256,decodedBytes:c.decodedBytes})),'Complete local walking collision closure changed');
 const actual=new Map(floor.triangles.map(f=>[f.id,f]));assert.equal(qualification.faces.length,75);for(const f of qualification.faces){const{sha256,...face}=f;assert.equal(hash(face),sha256);assert.deepEqual(actual.get(f.id),face,'Qualified walking floor face changed');}
 const way=input.osm.elements.find(w=>w.type==='way'&&w.id===87075617);assert.ok(way?.nodes?.length===6&&way.tags);assert.equal(hash(way),packet.sourceWaySha256,'Walking OSM identity or access changed');assert.equal(way.tags.highway,'footway');assert.ok(!way.tags.bridge&&!way.tags.tunnel&&!['private','no'].includes(way.tags.foot??way.tags.access??''));
 const nodes=new Map<number,Vec3>();for(const[index,id]of way.nodes.entries()){const node=input.osm.elements.find(n=>n.type==='node'&&n.id===id);assert.ok(node&&Number.isFinite(node.lat)&&Number.isFinite(node.lon));const[e,n]=geodeticToGk25(node.lat!,node.lon!),p=before.points[index]!;assert.ok(Math.hypot(p[0]-e+manifest.origin.originProjected[0],p[2]+n-manifest.origin.originProjected[1])<.002);assert.ok(registered.points.some(q=>q[0]===p[0]&&q[2]===p[2]),'Source walking node moved');nodes.set(id,[...p]);}
 const parts=packet.source.parts.map((p:any)=>{const actual=input.parts.find(part=>part.id===p.id);assert.ok(actual);assert.equal(hash(actual),p.sha256,'Walking municipal source changed');assert.ok(actual.properties.paatyyppi==='Kevyt liikenne'&&actual.properties.alatyyppi!=='Portaat'||actual.properties.paatyyppi==='Ajorata'&&['Ajorata','Koroke'].includes(String(actual.properties.alatyyppi)));return actual as LocalPolygon;});
 const union=polygonClipping.union(...parts.map((p:LocalPolygon)=>p.rings.map(r=>r.map(([x,n])=>[x,-n]as[number,number])))as[polygonClipping.Polygon,...polygonClipping.Polygon[]]);
 const coverage={playArea:{minX:25,minZ:1323,maxX:76,maxZ:1377},supportedArea:{schemaVersion:1 as const,regions:union.map((p,i)=>({id:'source-'+i,outer:p[0]!.slice(0,-1),holes:p.slice(1).map(r=>r.slice(0,-1))}))}};
 for(let i=1;i<packet.authoredAxis.length;i++)assert.ok(supportsSegment(coverage,packet.authoredAxis[i-1],packet.authoredAxis[i],.56),'Reviewed walking axis leaves its complete public source corridor');
 assert.equal(qualification.physical.failures.length,0);assert.equal(qualification.physical.samples,3893);assert.ok(qualification.physical.maxHeightDeviation<=.2);assert.equal(qualification.runs.length,6);for(const run of qualification.runs)assert.ok(run.passed&&run.maxTrack<=.22&&!run.terrainGroundTicks&&!run.missingGroundTicks&&!run.nonPublicSourceTicks&&!run.nonPublicSurfaceTicks);
 const receipt={kind:'literal-source-only-kaivopuisto-new-footway-registration',approvalSha256:approvalPin.sha256,packetSha256:PACKET,independentReviewSha256:REVIEW,provenanceSha256:ARCHIVE,recordId:ID,registeredRecordSha256:AFTER,sourceWaySha256:packet.sourceWaySha256,sourcePins:input.sourcePins,sourcePartIds:packet.source.partIds,sourceNodeXZPreserved:6,finalManifestSha256:input.world.manifestSha256,completeLocalCollisionDecodedClosure:floor.receipt.cells.map(c=>({cell:c.cell,decodedSha256:c.decodedSha256})),sourceMembershipOnly:true,ordinaryFloorAndCapsuleGatesRequired:true};
 const authority=Object.freeze({})as ReviewedKaivopuistoFootway;authorities.set(authority,{registered:structuredClone(registered),nodes,sourceWaySha256:packet.sourceWaySha256,receipt:structuredClone(receipt)});
 const record=input.candidate.footways.find(f=>f.id===ID);assert.ok(record,'Reviewed new walking record absent');assertReviewedKaivopuistoFootwayProjection(authority,record);
 return{authority,registered:structuredClone(registered),receipt:structuredClone(receipt),verifyInputs:()=>{for(const p of pins)assert.equal(sourceSha256(input.read(p.pin,p.cap)),p.pin.sha256);const again=readSerializedRoadFloor(input.world,region,manifest.origin.id);assert.deepEqual(again.receipt,floor.receipt);}};
}

export function assertReviewedKaivopuistoFootwayProjection(authority:ReviewedKaivopuistoFootway,record:Footway){
 const data=authorities.get(authority);assert.ok(data,'Unverified Kaivopuisto walking authority');assert.equal(record.id,ID);const{points:a,...am}=data.registered,{points:b,...bm}=record;assert.deepEqual(bm,am,'Walking source metadata changed');assertHorizontalSubdivision(a,b);
 return{sourceWaySha256:data.sourceWaySha256,sourcePoints:structuredClone(data.registered.points),sourceNodePoints:new Map([...data.nodes].map(([id,p])=>[id,[...p]as Vec3])),receipt:{...structuredClone(data.receipt),projectedRecordSha256:hash(record),approvedOrderedXZPreserved:true}};
}
