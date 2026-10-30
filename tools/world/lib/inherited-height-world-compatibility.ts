import assert from 'node:assert/strict';
import {decodeRoadGraph,type RoadGraph,type WorldManifest} from '../../../packages/world-schema/src/index.ts';
import {decodeDeliverySimulation} from './delivery-city-payloads.ts';
import {sourceFile,sourceSha256} from './source-files.ts';
import type {InheritedHeightPin,InheritedHeightWorld} from './reviewed-inherited-road-height.ts';

const HISTORICAL='fe78e6a00102dc33f80c9685b1b204465c2d21e5d470ef20586ca1dddd3817c2';
const CURRENT='d453fdd79db114c914322f0209121c34819206b294004bdcece2739f0f3b4701';
export const INHERITED_D453_COMPATIBILITY_APPROVAL_SHA256='31374c50613e6a587ff8c7aa091dcbf317d5888789e477599598d04183c3fa29';
const PROPOSAL='ca06f5b11476d40e6027842eda8d73993ce836c00f723e36c6e1f2bb4a154fbd';
const hash=(v:unknown)=>sourceSha256(JSON.stringify(v));
type Checked=(pin:InheritedHeightPin,cap:number,retain:boolean)=>Buffer|undefined;

/** This is one literal successor, not a manifest alias. The caller's bounded
 * reader retains every compared byte pin for its final verifyInputs replay. */
export function verifyInheritedHeightWorldCompatibility(approvalPin:InheritedHeightPin|undefined,current:InheritedHeightWorld,currentGraph:RoadGraph,recordApprovalSha256:string,checked:Checked){
  if(current.manifestSha256===HISTORICAL){assert.equal(approvalPin,undefined,'Compatibility is only for the explicit d453 successor');return undefined;}
  assert.equal(current.manifestSha256,CURRENT,'Unapproved inherited current world');assert.ok(approvalPin,'Exact d453 compatibility approval required');assert.equal(approvalPin.sha256,INHERITED_D453_COMPATIBILITY_APPROVAL_SHA256,'Unapproved inherited world compatibility');
  const json=(pin:InheritedHeightPin,cap=1024*1024):any=>JSON.parse(checked(pin,cap,true)!.toString()),approval=json(approvalPin),proposal=json(approval.proposal);
  assert.equal(approval.proposal.sha256,PROPOSAL);assert.equal(approval.historical.manifestSha256,HISTORICAL);assert.equal(approval.candidate.manifestSha256,CURRENT);
  assert.ok(approval.approvals.some((p:InheritedHeightPin)=>p.sha256===recordApprovalSha256),'Compatibility does not authorize this inherited case');
  assert.deepEqual(approval.records,proposal.records);assert.equal(approval.records.length,18);assert.deepEqual(approval.localFloorCells,proposal.localFloorCells);assert.equal(approval.localFloorCells.length,42);
  const historical=approval.historical as InheritedHeightWorld;
  const manifest=(w:InheritedHeightWorld)=>json({file:sourceFile(w.directory,'manifest.json'),sha256:w.manifestSha256},16*1024*1024)as WorldManifest;
  const hm=manifest(historical),cm=manifest(current);
  assert.equal(hm.cells.length,cm.cells.length);assert.equal(new Set(cm.cells.map(c=>c.id)).size,cm.cells.length);
  assert.deepEqual(Object.keys(hm).filter(k=>hash((hm as any)[k])!==hash((cm as any)[k])),['worldReleaseId','builtAt','cells','publicationFiles']);
  assert.deepEqual(hm.cells.filter(h=>hash(h)!==hash(cm.cells.find(c=>c.id===h.id))).map(c=>c.id),['c_m16_p06']);
  const payload=(world:InheritedHeightWorld,ref:{path:string;sha256:string;bytes:number})=>decodeDeliverySimulation(checked({file:sourceFile(world.directory,ref.path),sha256:ref.sha256,bytes:ref.bytes},64*1024*1024,true)!,ref);
  assert.deepEqual(approval.metadata,proposal.metadata);assert.deepEqual(approval.metadata.map((p:any)=>p.kind),['roads','gameplay','terrain']);
  for(const p of approval.metadata){const key=p.kind as 'roads'|'gameplay'|'terrain';assert.deepEqual(hm[key],p.stored);assert.deepEqual(cm[key],p.stored);const before=payload(historical,hm[key]),after=payload(current,cm[key]);assert.ok(Buffer.from(before).equals(Buffer.from(after)),'Inherited metadata bytes changed');assert.equal(sourceSha256(after),p.decodedSha256);assert.equal(after.length,p.decodedBytes);}
  const actual=decodeRoadGraph(payload(current,cm.roads));assert.equal(hash(actual),approval.actualRoadGraphSha256);assert.equal(hash(currentGraph),hash(actual),'Compatibility requires actual current graph');
  for(const r of approval.records)assert.equal(hash([...actual.lanes,...actual.footways].find(c=>c.id===r.id)),r.beforeSha256,'Compatibility before record changed');
  assert.equal(new Set(approval.localFloorCells.map((p:any)=>p.cell)).size,42);
  let decodedBytes=0;for(const p of approval.localFloorCells){assert.notEqual(p.cell,'c_m16_p06');const old=hm.cells.find(c=>c.id===p.cell),cell=cm.cells.find(c=>c.id===p.cell);assert.ok(old&&cell);assert.deepEqual(old,cell);assert.equal(hash(cell),p.cellManifestSha256);assert.equal(cell.collision.sha256,p.storedSha256);
    const before=payload(historical,old.collision),after=payload(current,cell.collision);decodedBytes+=after.length;assert.ok(decodedBytes<=512*1024*1024);assert.ok(Buffer.from(before).equals(Buffer.from(after)),'Inherited local floor changed');assert.equal(sourceSha256(after),p.decodedSha256);assert.equal(after.length,p.decodedBytes);
  }
  for(const p of Object.values(approval.sourcePins)as InheritedHeightPin[])checked(p,64*1024*1024,false);
  return{approvalSha256:approvalPin.sha256,proposalSha256:PROPOSAL,historicalManifestSha256:HISTORICAL,currentManifestSha256:CURRENT,localFloorCells:42,records:18,fullGraphGameplayTerrainLiteral:true};
}
