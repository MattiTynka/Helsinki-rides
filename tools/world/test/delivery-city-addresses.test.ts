import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {encodeCollisionBundle,encodeTerrain,type GameplayBundle,type RoadGraph,type CellDescriptor,type BuildingRecord} from '../../../packages/world-schema/src/index.ts';
import {parseAddressSelection,deriveSelectedAddresses,prepareAddressSources,appendAddressPrefix,type AddressSelectionDocument,type AddressSourceAuthority} from '../lib/delivery-address-sources.ts';
import {inspectAddressTargets} from '../lib/delivery-address-physical.ts';
import {prepareAppendAddresses} from '../lib/delivery-city-addresses.ts';
import {sourceSha256} from '../lib/source-files.ts';
const hash='a'.repeat(64),gameplay={originId:'fixture',playArea:{minX:-10,maxX:10,minZ:-10,maxZ:10},supportedArea:{schemaVersion:1,regions:[{id:'public',outer:[[-9,-9],[9,-9],[9,9],[-9,9]]}]},killHeight:-20,addresses:[{label:'Old street 1',position:[-5,0],headingDeg:90}],landmarks:[{label:'Old landmark',position:[-5,1],headingDeg:0}],preserved:{value:'literal'}}as unknown as GameplayBundle;
const entry={label:'New street 2',position:[2,0]as[number,number],headingDeg:0},building={id:'BID_new',vtj:'vtj-new',registerId:'new-register'}as BuildingRecord;
const feature={type:'Feature',id:'register.2',properties:{vtj_prt:'vtj-new',id:'new-register',katunimi_suomi:'New street',osoitenumero:'2'},geometry:{type:'Polygon',coordinates:[[[1001,1999],[1003,1999],[1003,2001],[1001,2001],[1001,1999]]]}};
const register={type:'FeatureCollection',features:[feature]};
const authority:AddressSourceAuthority={acceptedManifestSha256:hash,origin:{id:'fixture',originProjected:[1000,2000,0]},acceptedGameplay:gameplay,acceptedBuildings:[{id:'BID_old',vtj:'vtj-old',registerId:'old-register'}as BuildingRecord],newBuildings:[building],regions:[[0,-5,10,5]]};
const document=():AddressSelectionDocument=>({schemaVersion:1,kind:'source-bound-additive-addresses',acceptedManifestSha256:hash,originId:'fixture',snapshot:'fixture-snapshot',sourceJobSha256:hash,registerLedger:{file:'unused-ledger',sha256:hash},register:{file:'unused-register',sha256:hash},entries:[{entry,source:{featureId:feature.id,featureSha256:sourceSha256(JSON.stringify(feature)),polygonIndex:0,vtj:'vtj-new',buildingId:'BID_new'}}]});
const roads={schemaVersion:2,originId:'fixture',nodes:[],lanes:[{id:'new-lane',points:[[-5,0,0],[5,0,0]],length:10}],connectors:[],parking:[],footways:[]}as unknown as RoadGraph;
const flat=(x0=-5,z0=-5,x1=5,z1=5,y=0)=>({positions:Float32Array.from([x0,y,z0,x1,y,z0,x1,y,z1,x0,y,z1]),indices:Uint32Array.from([0,2,1,0,3,2])});
function physical(options:{parts?:ReturnType<typeof flat>[];tag?:string;wall?:boolean;terrainY?:number}={}){
  const parts=options.parts??[flat()],colliders=parts.map((p,i)=>({id:'ground-'+i,group:'ground' as const,ref:null,...p,triangleTags:new Uint16Array(2)}));if(options.wall)(colliders as any[]).push({id:'obstruction',group:'props',ref:null,positions:Float32Array.from([.15,0,-1,.15,2,-1,.15,2,1,.15,0,1]),indices:Uint32Array.from([0,1,2,0,2,3]),triangleTags:new Uint16Array(2)});
  const raw=encodeCollisionBundle({originId:'fixture',frame:'X-east,Y-up,Z-south',cell:'cell',surfaceTags:[options.tag??'road:asphalt']},colliders),terrainBytes=encodeTerrain({x0:-10,z0:-10,resolution:10,nx:3,nz:3,heights:new Float32Array(9).fill(options.terrainY??-1)}),cell={id:'cell',boundsXZ:[-5,-5,5,5],collision:{path:'cell.hcol',bytes:raw.length,sha256:sourceSha256(raw),triangles:colliders.reduce((n,c)=>n+c.indices.length/3,0),boundsXZ:[-5,-5,5,5]}}as unknown as CellDescriptor;
  return{gameplay,roads,terrainBytes,terrainDecodedSha256:sourceSha256(terrainBytes),cells:[cell],readCollision:()=>raw};
}
test('addresses are literal register centroids with one new stable owner and immutable old gameplay prefix',()=>{
  const parsed=parseAddressSelection(document()),entries=deriveSelectedAddresses(parsed,register,authority);assert.deepEqual(entries,[entry]);const next=appendAddressPrefix(gameplay,entries);assert.deepEqual(next.addresses,[...gameplay.addresses,entry]);assert.deepEqual({...next,addresses:gameplay.addresses},gameplay);assert.equal(next.addresses[0],gameplay.addresses[0]);
  assert.throws(()=>parseAddressSelection({...document(),unexpected:true}),/fields differ/);
  for(const patch of[{position:[2.1,0]},{label:'Different street 2'},{headingDeg:90}]){const d=structuredClone(document());Object.assign(d.entries[0]!.entry,patch);assert.throws(()=>deriveSelectedAddresses(d,register,authority),/literal register/);}
  assert.throws(()=>deriveSelectedAddresses(parsed,register,{...authority,newBuildings:[{...building,id:'BID_changed'}]}),/owner differs/);
  assert.throws(()=>deriveSelectedAddresses(parsed,register,{...authority,newBuildings:[building,{...building,id:'duplicate-vtj'}]}),/unambiguous/);
  assert.throws(()=>deriveSelectedAddresses(parsed,register,{...authority,acceptedBuildings:[{...building,id:'BID_accepted-old-vintage'}]}),/accepted building identity/);
  assert.throws(()=>deriveSelectedAddresses(parsed,register,{...authority,regions:[[5,5,10,10]]}),/outside selected/);
  assert.throws(()=>appendAddressPrefix(gameplay,[{...entry,label:' OLD   LANDMARK '}]),/collision/);
  assert.throws(()=>deriveSelectedAddresses({...parsed,entries:[...parsed.entries,...parsed.entries]},register,authority),/collides/);
});
test('final serialized physical qualification rejects fallback terrain, water, interior holes, blocked capsule and stale HCOL',async()=>{
  const entries=[{label:'Probe',position:[0,2]as[number,number],headingDeg:0}],okay=await inspectAddressTargets(entries,physical());assert.equal(okay.proof.status,'PASS_FINAL_SERIALIZED_ADDRESS_TARGETS');assert.deepEqual(okay.results[0].target,[0,0]);okay.verifyInputs();
  const cases=[
    [physical({parts:[]}),/central-floor/],
    [physical({tag:'water:sea'}),/central-floor/],
    [physical({terrainY:2}),/levels-differ/],
    [physical({wall:true}),/capsule/],
    [physical({parts:[flat(-5,-5,.08,5),flat(.18,-5,5,5),flat(.08,-5,.18,.08),flat(.08,.18,.18,5)]}),/complete-native-support/],
  ]as const;
  for(const[input,reason]of cases){const out=await inspectAddressTargets(entries,input);assert.equal(out.proof.status,'REJECTED_ADDRESS_TARGETS');assert.match(out.results[0].reason,reason);}
  const longSlope=flat(-10,-10,10,10);for(let i=1;i<longSlope.positions.length;i+=3)longSlope.positions[i]=longSlope.positions[i-1]!*.1;const sloped=await inspectAddressTargets(entries,physical({parts:[longSlope]}));assert.equal(sloped.proof.status,'PASS_FINAL_SERIALIZED_ADDRESS_TARGETS','Local support on a long native slope must be clipped before testing its height band');
  const wrong=physical();(wrong.cells[0]!.collision as any).sha256=hash;await assert.rejects(()=>inspectAddressTargets(entries,wrong),/collision differs/);
});
test('source ledger and final HCOL combine into a reproducible append gate; source mutations cannot be published',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'helsinki-addresses-')),write=(name:string,value:unknown)=>{const file=path.join(root,name),bytes=Buffer.from(JSON.stringify(value)+'\n');fs.writeFileSync(file,bytes);return{file,sha256:sourceSha256(bytes)};};
  try{
    const reg=write('register.geojson',register),ledger=write('ledger.json',{schemaVersion:1,source:{id:'helsinki-building-register-wfs',crs:'EPSG:3879',axisOrder:'easting,northing',units:'metres',license:'CC BY 4.0',attribution:'Fixture'},snapshots:{'fixture-snapshot':{path:'register.geojson',bytes:fs.statSync(reg.file).size,sha256:reg.sha256,sourceJobSha256:hash,conflicts:0}}}),selection=write('selection.json',{...document(),register:reg,registerLedger:ledger}),prepared=prepareAppendAddresses(selection,authority),qualified=await prepared.qualifyFinal(physical());
    assert.deepEqual(qualified.gameplay.addresses,[...gameplay.addresses,entry]);assert.equal(qualified.proof.physical.targets[0].status,'QUALIFIED');assert.ok(qualified.proof.producer.closures.some(c=>'packages/sim/src/character.ts'in c.files));assert.ok(qualified.proof.producer.closures.some(c=>'packages/world-schema/src/supported-area.ts'in c.files));qualified.verifyInputs();
    const unqualified=physical({tag:'water'});await assert.rejects(()=>prepared.qualifyFinal(unqualified),/failed final serialized HCOL/);
    fs.appendFileSync(reg.file,' ');assert.throws(qualified.verifyInputs);assert.throws(()=>prepareAddressSources(selection,authority),/file changed/);
  }finally{const resolved=path.resolve(root);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(resolved).startsWith('helsinki-addresses-'));fs.rmSync(resolved,{recursive:true,force:true});}
});
