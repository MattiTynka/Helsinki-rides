import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type {AddressEntry,BuildingRecord,GameplayBundle,WorldManifest} from '../../../packages/world-schema/src/index.ts';
import {centroid,cleanRing,ensureCcw,signedArea} from './geometry.ts';
import {sourceSha256} from './source-files.ts';

export interface AddressFileBinding {file:string;sha256:string}
export interface AddressSourceSelection {entry:AddressEntry;source:{featureId:string;featureSha256:string;polygonIndex:number;vtj:string;buildingId:string}}
export interface AddressSelectionDocument {
  schemaVersion:1;kind:'source-bound-additive-addresses';acceptedManifestSha256:string;originId:string;
  snapshot:string;sourceJobSha256:string;registerLedger:AddressFileBinding;register:AddressFileBinding;entries:AddressSourceSelection[];
}
export interface AddressSourceAuthority {
  acceptedManifestSha256:string;origin:WorldManifest['origin'];acceptedGameplay:GameplayBundle;
  acceptedBuildings:readonly BuildingRecord[];newBuildings:readonly BuildingRecord[];
  regions:readonly(readonly[number,number,number,number])[];
}
const object=(value:unknown,keys:readonly string[],message:string):Record<string,any>=>{assert.ok(value&&typeof value==='object'&&!Array.isArray(value),message);assert.deepEqual(Object.keys(value).sort(),[...keys].sort(),message+' fields differ');return value as Record<string,any>;};
const digest=(value:unknown)=>{assert.ok(typeof value==='string'&&/^[a-f0-9]{64}$/.test(value),'Invalid address source digest');return value;};
const text=(value:unknown,label:string)=>{assert.ok(typeof value==='string'&&value.trim().length>0&&value.length<=256&&!/[\u0000-\u001f\u007f]/.test(value),'Invalid '+label);return value;};
export const addressLabelKey=(label:string)=>label.normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleLowerCase('fi');
function binding(value:unknown):AddressFileBinding{const v=object(value,['file','sha256'],'Address file binding');assert.ok(typeof v.file==='string'&&v.file.length>0&&v.file.length<=4096);return{file:v.file,sha256:digest(v.sha256)};}
export function parseAddressSelection(value:unknown):AddressSelectionDocument{
  const v=object(value,['schemaVersion','kind','acceptedManifestSha256','originId','snapshot','sourceJobSha256','registerLedger','register','entries'],'Address selection');assert.equal(v.schemaVersion,1);assert.equal(v.kind,'source-bound-additive-addresses');digest(v.acceptedManifestSha256);digest(v.sourceJobSha256);text(v.originId,'address origin');text(v.snapshot,'address snapshot');assert.ok(Array.isArray(v.entries)&&v.entries.length>0&&v.entries.length<=4096,'Address selection must contain 1..4096 entries');
  for(const item of v.entries){const row=object(item,['entry','source'],'Address row'),entry=object(row.entry,['label','position','headingDeg'],'Address entry'),source=object(row.source,['featureId','featureSha256','polygonIndex','vtj','buildingId'],'Address source');text(entry.label,'address label');assert.ok(Array.isArray(entry.position)&&entry.position.length===2&&entry.position.every((n:unknown)=>typeof n==='number'&&Number.isFinite(n)));assert.equal(entry.headingDeg,0,'Register addresses retain the established zero heading');text(source.featureId,'feature ID');digest(source.featureSha256);assert.ok(Number.isSafeInteger(source.polygonIndex)&&source.polygonIndex>=0&&source.polygonIndex<1024);text(source.vtj,'VTJ');text(source.buildingId,'building owner ID');}
  return{...v,registerLedger:binding(v.registerLedger),register:binding(v.register)}as AddressSelectionDocument;
}
/** Source centroids and labels are recomputed. A reviewed witness cannot move an
 * address or reuse an accepted building merely by changing its BID. */
export function deriveSelectedAddresses(document:AddressSelectionDocument,register:unknown,authority:AddressSourceAuthority):AddressEntry[]{
  assert.equal(document.acceptedManifestSha256,authority.acceptedManifestSha256,'Address accepted manifest differs');assert.equal(document.originId,authority.origin.id,'Address origin differs');
  const data=register as any;assert.ok(data&&data.type==='FeatureCollection'&&Array.isArray(data.features)&&data.features.length<=200_000,'Invalid bounded building register');
  const features=new Map<string,any>();for(const feature of data.features){const id=String(feature.id??'');assert.ok(id&&id.length<=256&&!features.has(id),'Missing or duplicate register feature ID');features.set(id,feature);}
  const oldIds=new Set(authority.acceptedBuildings.map(b=>b.id)),oldIdentities=new Set(authority.acceptedBuildings.flatMap(b=>[b.vtj,b.registerId].filter((v):v is string=>typeof v==='string'&&v.length>0))),labels=new Set([...authority.acceptedGameplay.addresses,...authority.acceptedGameplay.landmarks].map(e=>addressLabelKey(e.label))),owners=new Map<string,BuildingRecord[]>();
  for(const b of authority.newBuildings){assert.ok(!oldIds.has(b.id),'New address authority reuses accepted BID');if(b.vtj){const group=owners.get(b.vtj)??[];group.push(b);owners.set(b.vtj,group);}}
  assert.ok(authority.regions.length>0&&authority.regions.every(r=>r.length===4&&r.every(Number.isFinite)&&r[0]<r[2]&&r[1]<r[3]),'Invalid address expansion regions');
  return document.entries.map(({entry,source})=>{
    const feature=features.get(source.featureId);assert.ok(feature,'Missing address register feature');assert.equal(sourceSha256(JSON.stringify(feature)),source.featureSha256,'Address feature bytes differ');
    const p=feature.properties;assert.ok(p&&typeof p==='object'&&!Array.isArray(p));const vtj=String(p.vtj_prt??p.c_vtj_prt??'');assert.equal(vtj,source.vtj,'Address VTJ differs');assert.ok(!oldIdentities.has(vtj)&&!oldIdentities.has(String(p.id??'')),'Address belongs to an accepted building identity');
    const owned=owners.get(vtj);assert.ok(owned&&owned.length===1,'Address needs one unambiguous new building owner');assert.equal(owned[0]!.id,source.buildingId,'Address building owner differs');
    const street=text(String(p.katunimi_suomi??'').trim(),'register street'),number=text(String(p.osoitenumero??'').trim(),'register number'),label=street+' '+number,key=addressLabelKey(label);assert.ok(!labels.has(key),'Address collides with an accepted/new address or landmark label');labels.add(key);
    const geometry=feature.geometry,polygons=geometry?.type==='Polygon'?[geometry.coordinates]:geometry?.type==='MultiPolygon'?geometry.coordinates:null;assert.ok(Array.isArray(polygons)&&source.polygonIndex<polygons.length,'Address source polygon missing');const ring=polygons[source.polygonIndex]?.[0];assert.ok(Array.isArray(ring)&&ring.length>=4&&ring.length<=100_000,'Invalid address footprint ring');const[E0,N0]=authority.origin.originProjected;
    const local=ensureCcw(cleanRing(ring.map((point:unknown)=>{assert.ok(Array.isArray(point)&&point.length>=2&&typeof point[0]==='number'&&Number.isFinite(point[0])&&typeof point[1]==='number'&&Number.isFinite(point[1]));return[point[0]-E0,point[1]-N0];})));assert.ok(local.length>=3&&Number.isFinite(signedArea(local))&&signedArea(local)!==0,'Degenerate address source ring');const c=centroid(local),round=(n:number)=>Math.round(n*10)/10||0,position:[number,number]=[round(c[0]),round(-c[1])];assert.ok(authority.regions.some(r=>position[0]>=r[0]&&position[0]<r[2]&&position[1]>=r[1]&&position[1]<r[3]),'Address centroid is outside selected new regions');
    const derived:AddressEntry={label,position,headingDeg:0};assert.deepEqual(entry,derived,'Address differs from literal register-derived entry');return derived;
  });
}
export function prepareAddressSources(input:AddressFileBinding,authority:AddressSourceAuthority){
  const pins:{file:string;sha256:string;bytes:number}[]=[],read=(ref:AddressFileBinding,cap:number)=>{binding(ref);const stat=fs.lstatSync(ref.file);assert.ok(stat.isFile()&&!stat.isSymbolicLink()&&stat.size>0&&stat.size<=cap,'Address input is not a bounded ordinary file');const bytes=fs.readFileSync(ref.file);assert.equal(sourceSha256(bytes),ref.sha256,'Address source file changed');pins.push({...ref,bytes:bytes.length});return bytes;};
  const document=parseAddressSelection(JSON.parse(read(input,4*1024*1024).toString())),ledger=JSON.parse(read(document.registerLedger,16*1024*1024).toString()),registerBytes=read(document.register,128*1024*1024),snapshot=ledger.snapshots?.[document.snapshot];assert.equal(ledger.schemaVersion,1);assert.equal(ledger.source?.id,'helsinki-building-register-wfs');assert.equal(ledger.source?.crs,'EPSG:3879');assert.equal(ledger.source?.axisOrder,'easting,northing');assert.equal(ledger.source?.units,'metres');assert.ok(ledger.source?.license&&ledger.source?.attribution,'Address register lacks source attribution');assert.ok(snapshot,'Address snapshot absent from ledger');assert.equal(snapshot.sourceJobSha256,document.sourceJobSha256);assert.equal(snapshot.conflicts,0,'Unresolved address source conflicts');assert.equal(snapshot.sha256,document.register.sha256);assert.equal(snapshot.bytes,registerBytes.length);assert.equal(path.resolve(path.dirname(document.registerLedger.file),snapshot.path),path.resolve(document.register.file),'Address snapshot payload path differs');
  const entries=deriveSelectedAddresses(document,JSON.parse(registerBytes.toString()),authority),entriesSha256=sourceSha256(JSON.stringify(entries)),authoritySha256=sourceSha256(JSON.stringify(authority));
  return{entries,document,proof:{entriesValueSha256:entriesSha256,authorityValueSha256:authoritySha256,selectionSha256:input.sha256,registerLedgerSha256:document.registerLedger.sha256,registerSha256:document.register.sha256,snapshot:document.snapshot,sourceJobSha256:document.sourceJobSha256,witnesses:document.entries.map(e=>e.source)},verifyInputs:()=>{assert.equal(sourceSha256(JSON.stringify(entries)),entriesSha256,'Derived address entries changed');assert.equal(sourceSha256(JSON.stringify(authority)),authoritySha256,'Address ownership authority changed');for(const ref of pins){const b=fs.readFileSync(ref.file);assert.equal(b.length,ref.bytes);assert.equal(sourceSha256(b),ref.sha256,'Address source changed during qualification');}}};
}
export function appendAddressPrefix(gameplay:GameplayBundle,entries:readonly AddressEntry[]):GameplayBundle{
  const labels=new Set([...gameplay.addresses,...gameplay.landmarks].map(e=>addressLabelKey(e.label)));for(const entry of entries){const key=addressLabelKey(entry.label);assert.ok(!labels.has(key),'Address label collision');labels.add(key);}
  const next={...gameplay,addresses:[...gameplay.addresses,...entries]};assert.deepEqual({...next,addresses:next.addresses.slice(0,gameplay.addresses.length)},gameplay,'Address append changed accepted gameplay');return next;
}
