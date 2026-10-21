import sharp from'sharp';import{renderReferenceFacade}from'../lib/delivery-new-area-facades-reference-art.ts';
import assert from'node:assert/strict';import test from'node:test';
import {qualifyRegisteredFacadeGround,renderRegisteredSlopedFacadeBase,type FacadeGroundRegistryEntry,type RegisteredFloorSample}from'../lib/delivery-new-area-facades-ground-registry.ts';
import {OriginalWallArt}from'../author_senate_facade_charts.ts';import {deliverySha}from'../lib/delivery-city-payloads.ts';import type{ReferenceFacadeArt}from'../lib/delivery-new-area-facades-reference-art.ts';
const manifest='a'.repeat(64),frame={origin:[0,0]as const,axis:[1,0]as const,width:10,minY:0,maxY:12};
const art:ReferenceFacadeArt={wallColour:'#d2b291',groundColour:'#b89a82',surroundColour:'#f1dcc3',frameColour:'#6d746d',glassColour:'#9caaa8',groundHeight:4,rows:[],groundOpenings:[{x:2,bottom:.2,width:1,height:3.4,kind:'door'},{x:8,bottom:.2,width:1,height:3.4,kind:'glazing'},{x:5,bottom:.2,width:1,height:3.4,kind:'glazing'}],bands:[],rustication:null};
function fixture(){
 const samples:RegisteredFloorSample[]=Array.from({length:9},(_,i)=>({u:i*1.25,x:i*1.25,z:2,collision:{height:i*.25,cell:'cell',collider:'g:cell',group:'ground',tag:'raised:asphalt'},visual:{y:i*.25,cell:'cell',key:'native-floor-'+i,node:'cell_ground_asphalt'}}));
 const p={id:'explicit-authored-case',building:{id:'BID_exact',vtj:'exact-vtj',owner:'cell'},source:{cityJsonSha256:'b'.repeat(64),cityBinSha256:'c'.repeat(64),originId:'source-origin'},triangles:[10,11],art:structuredClone(art),references:[{url:'https://www.google.com/maps/',role:'appearance-reference-only'}],observedGroundProfile:{kind:'named-source-floor-profile',path:'ground-profile.json',sha256:'d'.repeat(64)}};
 const facets=[{part:0,triangle:10,key:'native-face-a'},{part:0,triangle:11,key:'native-face-b'}];
 const entry:FacadeGroundRegistryEntry={schemaVersion:1,id:p.id,building:structuredClone(p.building),source:structuredClone(p.source),sourceFacets:structuredClone(facets),frame:structuredClone(frame),manifestSha256:manifest,datum:{nativeRoofY:12,offset:-9},nineFloorSamples:structuredClone(samples),qualification:{artSha256:deliverySha(Buffer.from(JSON.stringify(p.art))),referencesSha256:deliverySha(Buffer.from(JSON.stringify(p.references))),observations:['Actual source-qualified public facade has horizontal upper bands and a sloped stone plinth.']},finish:{plinthHeight:.5,plinthColour:'#8a8477',floorFollowingGlazingIndices:[1]}};
 return{p,entry,facets,samples};
}
test('finite named slope registry rejects unknown cases, neighboring geometry, altered references and changed actual floor pairs',()=>{
 const f=fixture();assert.equal(qualifyRegisteredFacadeGround(f.entry,f.p,manifest,frame,f.facets,f.samples).datum,3);
 for(const mutate of[(v:ReturnType<typeof fixture>)=>{v.p.id='unknown';},(v:ReturnType<typeof fixture>)=>{v.p.building.id='BID_neighbor';},(v:ReturnType<typeof fixture>)=>{v.facets[0]!.key='other-plane';},(v:ReturnType<typeof fixture>)=>{v.samples[4]!.collision.height+=.01;},(v:ReturnType<typeof fixture>)=>{v.samples[4]!.visual.key='other-ground-triangle';},(v:ReturnType<typeof fixture>)=>{v.p.art.rows.push({bottom:7,height:2,width:1,axes:[3],header:'none'});},(v:ReturnType<typeof fixture>)=>{v.p.references[0]!.url='https://example.org/';},(v:ReturnType<typeof fixture>)=>{v.entry.frame.maxY+=.01;},(v:ReturnType<typeof fixture>)=>{v.entry.datum.nativeRoofY+=.01;},(v:ReturnType<typeof fixture>)=>{v.entry.finish.floorFollowingGlazingIndices=[0];}]){const v=fixture();mutate(v);assert.throws(()=>qualifyRegisteredFacadeGround(v.entry,v.p,manifest,frame,v.facets,v.samples));}
 assert.throws(()=>qualifyRegisteredFacadeGround(f.entry,f.p,'e'.repeat(64),frame,f.facets,f.samples));
});
test('registered base retains observed door height on a slope and draws the stone behind the door',()=>{
 const f=fixture(),wall=new OriginalWallArt(10,0,12);renderRegisteredSlopedFacadeBase(wall,3,art,f.samples,f.entry.finish);
 const door=wall.pieces.find(p=>p.includes('data-feature="registry-ground-0"'))!,glazing=wall.pieces.find(p=>p.includes('data-feature="registry-ground-1"'))!;
 assert.ok(door&&glazing);const y=(s:string)=>Number(s.match(/\by="([^"]+)"/)![1]),height=(s:string)=>Number(s.match(/\bheight="([^"]+)"/)![1]);
 assert.ok(Math.abs(height(door)-3.4)<1e-9);assert.ok(height(glazing)>height(door));const ordinary=wall.pieces.find(p=>p.includes('data-feature="registry-ground-2"'))!;assert.ok(Math.abs(height(ordinary)-3.4)<1e-9,'Ordinary ground window retains its observed level sill and height');
 assert.ok(Math.abs(y(glazing)-(12-6.6))<1e-9,'Observed glazing head remains at the horizontal datum');
 assert.ok(wall.pieces.findIndex(p=>p.includes('registry-source-floor-plinth'))<wall.pieces.indexOf(door));
 assert.ok(wall.pieces.every(p=>!p.includes('observed-row-')),'No invented upper floors or openings');
});

test('a level ground window cannot be silently painted below the actual street',()=>{const f=fixture();assert.throws(()=>renderRegisteredSlopedFacadeBase(new OriginalWallArt(10,0,12),0,art,f.samples,{...f.entry.finish,floorFollowingGlazingIndices:[]}));});

test('registry integration preserves a real low window row instead of clearing the whole ground storey',async()=>{const f=fixture(),a={...structuredClone(art),groundOpenings:[],rows:[{bottom:1,height:1,width:1,axes:[5],header:'none' as const}]},w=new OriginalWallArt(10,0,12);renderReferenceFacade(w,3,a,{skipGroundOpenings:true});renderRegisteredSlopedFacadeBase(w,3,a,f.samples,{...f.entry.finish,floorFollowingGlazingIndices:[]});const svg='<svg xmlns="http://www.w3.org/2000/svg" width="200" height="240">'+w.svg([0,0,200,240])+'</svg>',{data,info}=await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({resolveWithObject:true}),offset=(150*info.width+95)*info.channels;assert.deepEqual([...data.subarray(offset,offset+3)],[156,170,168]);});
