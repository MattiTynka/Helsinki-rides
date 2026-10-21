import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import {combineDeliveryOriginalFacadeProfiles} from '../combine_delivery_original_facade_profiles.ts';
import {deliverySha as sha} from '../lib/delivery-city-payloads.ts';

test('Independently pinned elevations keep asymmetric orientation, four-pixel gutter and exact source bindings in one block atlas',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'helsinki-original-block-'));
  try {
    const inputs=[];const originals=[];
    for(const [i,colour]of ['#df3020','#208030'].entries()) {
      const dir=path.join(root,String(i));fs.mkdirSync(dir);
      const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="100%" height="100%" fill="${colour}"/><svg x="2" y="2" width="1020" height="1020" viewBox="0 0 10 10"><rect width="10" height="10" fill="${colour}"/><rect x="0" y="0" width="2" height="10" fill="#eeeeee"/></svg></svg>`;
      const png=await sharp(Buffer.from(svg)).ensureAlpha().png({compressionLevel:9}).toBuffer();
      const chart={id:'chart-'+i,buildingId:'building-'+i,origin:[i,0,0],uAxis:[1,0,0],vAxis:[0,1,0],bounds:[0,0,10,10],pixels:[2,2,1020,1020]};
      const p={schemaVersion:1,id:'original-'+i,baselineManifestSha256:'1'.repeat(64),source:{cityJsonSha256:'2'.repeat(64),cityBinSha256:'3'.repeat(64),originId:'test'},art:{path:'facade.png',sha256:sha(png),width:1024,height:1024,license:'CC0-1.0',attribution:'Original fixture art',references:[]},material:{name:'original-'+i,unlit:true,roughness:.95,doubleSided:false},charts:[chart],cells:[{id:'same-owner',baselineLevels:{lod0:'4'.repeat(64)},buildings:[{id:'building-'+i,vtj:null}],faces:[{key:'exact-native-face-'+i,chart:chart.id}]}]};
      const bytes=Buffer.from(JSON.stringify(p));for(const [name,data]of Object.entries({'profile.json':bytes,'facade.svg':svg,'facade.png':png}))fs.writeFileSync(path.join(dir,name),data);inputs.push({profile:path.join(dir,'profile.json'),sha256:sha(bytes)});originals.push(p);
    }
    const out=path.join(root,'combined');await combineDeliveryOriginalFacadeProfiles({inputs,out,id:'block'});
    const result=JSON.parse(fs.readFileSync(path.join(out,'profile.json'),'utf8'));
    for(let i=0;i<2;i++){assert.deepEqual({...result.charts[i],pixels:originals[i]!.charts[0]!.pixels},originals[i]!.charts[0]);assert.deepEqual(result.cells[0].faces[i],originals[i]!.cells[0]!.faces[0]);}
    const raw=await sharp(path.join(out,'facade.png')).raw().toBuffer({resolveWithObject:true});const pixel=(x:number,y:number)=>[...raw.data.subarray((y*raw.info.width+x)*4,(y*raw.info.width+x)*4+3)];
    assert.deepEqual(pixel(20,500),[238,238,238]);assert.deepEqual(pixel(300,500),[223,48,32]);assert.deepEqual(pixel(530,500),[238,238,238]);assert.deepEqual(pixel(800,500),[32,128,48]);
    for(const x of [510,511,512,513])assert.deepEqual(pixel(x,500),[201,192,163]);
    const bad={...originals[1],cells:[{...originals[1]!.cells[0],id:'neighbor-owner'}]},badPath=path.join(root,'1','bad.json'),badBytes=Buffer.from(JSON.stringify(bad));fs.writeFileSync(badPath,badBytes);
    await assert.rejects(combineDeliveryOriginalFacadeProfiles({inputs:[inputs[0]!,{profile:badPath,sha256:sha(badBytes)}],out:path.join(root,'rejected'),id:'wrong-owner'}));assert.ok(!fs.existsSync(path.join(root,'rejected')));
  } finally {assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(root).startsWith('helsinki-original-block-'));fs.rmSync(root,{recursive:true,force:true});}
});
