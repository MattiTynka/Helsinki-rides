import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {estatesRestoration,ESTATES_INPUTS,estatesFrontPixel,estatesSidePixel,estatesRearPixel} from '../lib/estates-facade-restoration.ts';
import type {FacadeSources,FacadeExternalSources} from '../lib/facade-restoration-types.ts';
const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
const cityHashes=new Map([[55,'627bcedf4eebdd268e8d188a26af9404150f1dfc35a676991654b60cca528605'],[56,'60390bd3805cdb5aebc1294e039388928a02d0b56cc209ad4775946071f0070e'],[58,'87015bd2a771c57e4ae59c337844304fa028d1fab3a1f5899f1157639c85904d']]);
const native:FacadeSources=new Map([...cityHashes].map(([page,pngSha256])=>[page,{width:128,height:128,data:new Uint8Array(128*128*4),pngSha256}]));
const external=new Map();
for(const descriptor of estatesRestoration.externalSources!){const bytes=fs.readFileSync(descriptor.file);assert.equal(sha(bytes),descriptor.sha256);const {data,info}=await sharp(bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});external.set(descriptor.id,{width:info.width,height:info.height,data,sha256:descriptor.sha256});}
const donors={front:external.get('estates-front-2021'),park:external.get('estates-park-2022')};
const wallMap=JSON.parse(fs.readFileSync('content/assets/facades/estates/wall-mapping.json','utf8')) as {walls:{page:number;triangles:{uvs:[number,number][]}[]}[]};
function inside(poly:[number,number][],x:number,y:number){let result=false;for(let i=0,j=poly.length-1;i<poly.length;j=i++){const a=poly[i]!,b=poly[j]!;if((a[1]>y)!==(b[1]>y)&&x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0])result=!result;}return result;}

test('Estates original wall masks bound all writes and retain alpha, donors and unrelated roof page',()=>{
 const size=128,donorHashes=[...external.values()].map(v=>sha(v.data));
 for(const page of [55,56,58]){
 const before=new Uint8Array(size*size*4).fill(173),target=before.slice();
 const records=estatesRestoration.apply(page,target,size,size,native,external);assert.ok(records[0]!.changedTexels>100);
 const polygons=wallMap.walls.filter(w=>w.page===page).flatMap(w=>w.triangles.map(t=>t.uvs.map(([u,v])=>[u,1-v] as [number,number])));
 let unchanged=0,changed=0;
 for(let y=0;y<size;y++)for(let x=0;x<size;x++){const i=(y*size+x)*4;assert.equal(target[i+3],173);if(!polygons.some(p=>inside(p,(x+.5)/size,(y+.5)/size))){assert.deepEqual(target.subarray(i,i+4),before.subarray(i,i+4));unchanged++;}else changed++;}
 assert.ok(changed>100&&unchanged>100);
 }
 assert.deepEqual([...external.values()].map(v=>sha(v.data)),donorHashes);
 const roof=new Uint8Array(128*128*4).fill(91),before=roof.slice();assert.deepEqual(estatesRestoration.apply(57,roof,128,128,new Map()),[]);assert.deepEqual(roof,before);
});

test('Estates missing or changed source identity fails before writing',()=>{
 const target=new Uint8Array(128*128*4).fill(87),before=target.slice();
 assert.throws(()=>estatesRestoration.apply(56,target,128,128,new Map(),external),/master/);
 assert.throws(()=>estatesRestoration.apply(56,target,128,128,native),/external donor/);
 const changed=new Map(external);changed.set('estates-front-2021',{...donors.front,sha256:'changed'});
 assert.throws(()=>estatesRestoration.apply(56,target,128,128,native,changed),/external donor/);
 assert.deepEqual(target,before);
});

test('Estates actual photos retain distinct front crest, rectangular side windows and five rear arches',()=>{
 const rgb=(fn:(c:number)=>number)=>[0,1,2].map(fn);
 const luminance=(a:number[])=>a.reduce((s,v)=>s+v,0)/3;
 // Independent geometric stations in the visible window interiors versus their plaster piers.
 for(let i=0;i<3;i++){
 const window=rgb(ch=>[.44,.48,.52].reduce((sum,u)=>sum+estatesSidePixel(donors,(i+u)/3,13.7,ch),0)/3);
 const pier=rgb(ch=>estatesSidePixel(donors,(i+.04)/3,13.7,ch));
 assert.ok(luminance(window)+35<luminance(pier),`side axis ${i}`);
 }
 for(let i=0;i<5;i++){
 const window=rgb(ch=>estatesRearPixel(donors,(i+.5)/5,13.7,ch));
 const pier=rgb(ch=>estatesRearPixel(donors,(i+.04)/5,13.7,ch));
 assert.ok(luminance(window)+35<luminance(pier),`rear axis ${i}`);
 }
 const crest=rgb(ch=>estatesFrontPixel(donors,189.7,8.8,ch,true));
 assert.ok(Math.max(...crest)-Math.min(...crest)>25,'unique colored front crest survives');
});

test('rear corner frozen native UV probes replace photographed balustrade with stone and keep the window above',()=>{
 const size=2048,target=new Uint8Array(size*size*4).fill(173);
 estatesRestoration.apply(58,target,size,size,native,external);
 const read=(u:number,v:number)=>Array.from(target.subarray((Math.floor((1-v)*size)*size+Math.floor(u*size))*4,(Math.floor((1-v)*size)*size+Math.floor(u*size))*4+3));
 // Frozen from surveyed rear northeast corner: north203.3, height2.2 and2.65 metres.
 // The first station previously sampled the dark balustrade at photo(1330,1028).
 for(const [u,v] of [[.3897155373478652,.5851130707439882],[.38976193290716754,.5781772537758212]]){
  const rgb=read(u!,v!);assert.ok(rgb.reduce((a,b)=>a+b,0)/3>150,`corner plinth remains occluded: ${rgb}`);
 }
 // Fixed window-height texel at north207.3,height4.5: this is above the repair boundary.
 assert.deepEqual(read(.3058428453158568,.5551109493300226),[97,98,76]);
});
