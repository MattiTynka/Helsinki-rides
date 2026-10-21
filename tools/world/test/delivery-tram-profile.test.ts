import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {geodeticToGk25} from '../../../packages/world-schema/src/index.ts';
import {prepareDeliveryTramProfile} from '../prepare_delivery_tram_profile.ts';

test('public tram extraction keeps exact complete source axes, strips contributor fields, and accounts every exclusion',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'delivery-tram-profile-'));
 try{
  const write=(name:string,value:unknown)=>{const file=path.join(dir,name);fs.writeFileSync(file,JSON.stringify(value));return file;},[e,n]=geodeticToGk25(60.17,24.95),manifest={origin:{id:'o',originProjected:[e,n,7.5]}},world=path.join(dir,'world');fs.mkdirSync(world);write('world/manifest.json',manifest);
  const raw={elements:[{type:'node',id:1,lat:60.17,lon:24.9499,user:'private fixture contributor',uid:123,timestamp:'2020-01-01'}, {type:'node',id:2,lat:60.17,lon:24.9501,user:'private fixture contributor'}, {type:'node',id:3,lat:60.17,lon:24.96}, {type:'node',id:4,lat:60.17,lon:24.961},
   {type:'way',id:80,nodes:[1,2],tags:{railway:'tram',gauge:'1000'}}, {type:'way',id:81,nodes:[1,2],tags:{railway:'tram',gauge:'1000'},user:'private fixture contributor',uid:123}, {type:'way',id:82,nodes:[3,4],tags:{railway:'tram'}}, {type:'way',id:83,nodes:[1,2],tags:{railway:'tram',tunnel:'yes'}}, {type:'way',id:84,nodes:[1,2],tags:{railway:'tram',gauge:'1435'}}, {type:'way',id:85,nodes:[1,2],tags:{railway:'tram',tracks:'2'}}, {type:'way',id:86,nodes:[1,2],tags:{railway:'tram',bridge:'yes',layer:'1'}}]};
  const osm=write('osm.json',raw),digest=createHash('sha256').update(fs.readFileSync(osm)).digest('hex'),ledger=write('ledger.json',{snapshots:{current:{sha256:digest,url:'https://api.openstreetmap.org/api/0.6/map.json?bbox=24.94,60.16,24.96,60.18',retrievedAt:'2026-10-19T00:00:00Z',acquisition:'Pinned source compilation',parts:[]}}}),existing=write('existing.json',{tracks:[{wayId:80}]}),scope=write('scope.json',{playArea:{minX:-1,minZ:-1,maxX:1,maxZ:1}}),out=path.join(dir,'output');
  const profile=prepareDeliveryTramProfile({world,osm,ledger,existingProfiles:[existing],scope,out}),extractText=fs.readFileSync(path.join(out,'osm-tracks.json'),'utf8'),extract=JSON.parse(extractText),ways=extract.elements.filter((p:any)=>p.type==='way');
  assert.deepEqual(profile.tracks.map(t=>t.wayId),[81,86]);assert.deepEqual(profile.contextTracks.map(t=>t.wayId),[80]);assert.deepEqual(profile.excluded.map(t=>[t.wayId,t.reason]),[[80,'EXISTING_WAY_PRESERVED'],[82,'OUTSIDE_PLAYABLE_SCOPE'],[83,'TUNNEL_NOT_SURFACE'],[84,'UNQUALIFIED_GAUGE'],[85,'MULTITRACK_AXIS']]);
  assert.deepEqual(ways.map((w:any)=>w.id),[80,81,86]);assert.deepEqual(ways.find((w:any)=>w.id===81).nodes,[1,2]);assert.deepEqual(ways.find((w:any)=>w.id===81).tags,raw.elements.find(p=>p.id===81)!.tags);
  assert.ok(!extractText.includes('private fixture contributor'));assert.ok(!extractText.includes('timestamp'));assert.ok(extract.elements.every((p:any)=>p.user===undefined&&p.uid===undefined));assert.equal(profile.tracks[0]!.points.length,2);assert.ok(profile.tracks[0]!.points[0]!.x<-1&&profile.tracks[0]!.points[1]!.x>1,'Complete nodes remain outside clip bounds for actual continuation tangents');
  assert.ok(Math.abs(profile.coverage.newAxisMetresInPlayableScope-4)<.00001);assert.equal(profile.tracks[1]!.deckAuthority!.straightBankPlaneIsNotAuthority,true);
  const ledgerText=fs.readFileSync(path.join(out,'source-ledger.json'),'utf8');assert.ok(ledgerText.includes('ODbL-1.0'));assert.ok(!ledgerText.includes(dir));assert.equal(JSON.parse(ledgerText).source.originalSha256,digest);
  const repaired=prepareDeliveryTramProfile({world,osm,ledger,existingProfiles:[existing],scope,out:path.join(dir,'with-tail'),existingTailWayIds:[80]});assert.equal(repaired.coverage.newWays,2);assert.equal(repaired.coverage.existingRibbonRepairWays,1);assert.equal(repaired.contextTracks.length,0);assert.equal(repaired.tracks.find(t=>t.wayId===80)!.role,'uncovered-existing-ribbon');assert.deepEqual(repaired.existingTailWayIds,[80]);
  assert.throws(()=>prepareDeliveryTramProfile({world,osm,ledger,existingProfiles:[existing],scope,out:path.join(dir,'bad-tail'),existingTailWayIds:[999]}),/not an accepted source/);
  assert.throws(()=>prepareDeliveryTramProfile({world,osm,ledger,existingProfiles:[existing],scope,out}),/Fresh public/);
  const wrong=write('wrong-ledger.json',{snapshots:{current:{sha256:'0'.repeat(64)}}});assert.throws(()=>prepareDeliveryTramProfile({world,osm,ledger:wrong,existingProfiles:[existing],scope,out:path.join(dir,'wrong')}),/pinned acquisition/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
