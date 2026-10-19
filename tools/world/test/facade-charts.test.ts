import assert from 'node:assert/strict';
import {test} from 'node:test';
import {facadeAtlasBytes, facadeAtlasBc7Bytes, facadeChartUv, facadeTriangleKey, proveFacadeCoverage, validateFacadeTriangle,
  validateFacadeChartProfile, sampleFacadeChartColour, type FacadeChart, type FacadeChartProfile, type FacadeTriangle} from '../lib/facade-charts.ts';

const chart:FacadeChart={id:'east',building:'building',origin:[0,0,0],uAxis:[1,0,0],vAxis:[0,1,0],bounds:[0,0,2,2],pixels:[2,2,12,12],planeToleranceMetres:.001};
const a:FacadeTriangle=[[0,0,0],[2,0,0],[2,2,0]],b:FacadeTriangle=[[0,0,0],[2,2,0],[0,2,0]];
const h='a'.repeat(64);
function profile():FacadeChartProfile{return {schemaVersion:1,id:'fixture',baseCellsIndexSha256:h,source:{cityJsonSha256:h,cityBinSha256:h,originId:'origin'},
  art:{path:'authored.png',sha256:h,width:16,height:16,kind:'original-procedural',license:'CC0-1.0',attribution:'Test original art',references:[]},maximumFallbackBytes:3*1024*1024,
  material:{name:'authored',unlit:false,roughness:.9,doubleSided:false},charts:[chart],cells:[{id:'cell',lod0Sha256:h,lod2Sha256:h,buildings:[{id:'building',vtj:null}],
    detailed:[{node:'facades',primitive:0,triangle:0,key:facadeTriangleKey(a),chart:'east'}],distant:[{node:'distant',primitive:0,triangle:0,key:facadeTriangleKey(a),chart:'east'}]}]};}

test('triangle binding permits cyclic order, rejects reverse winding and detects native Float32 changes',()=>{
  assert.equal(facadeTriangleKey(a),facadeTriangleKey([a[1],a[2],a[0]]));
  assert.notEqual(facadeTriangleKey(a),facadeTriangleKey([a[0],a[2],a[1]]));
  assert.notEqual(facadeTriangleKey(a),facadeTriangleKey([[0,0,0],[2.000001,0,0],[2,2,0]]));
});
test('physical chart projection maps upward V to atlas top without touching geometry',()=>{
  assert.deepEqual(facadeChartUv([0,2,0],chart,16,16),[2.5/16,2.5/16]);
  assert.deepEqual(facadeChartUv([2,0,0],chart,16,16),[13.5/16,13.5/16]);
  assert.throws(()=>facadeChartUv([2,0,.003],chart,16,16),/plane/);
  assert.throws(()=>facadeChartUv([3,0,0],chart,16,16),/bounds/);
  assert.throws(()=>validateFacadeTriangle([[0,0,0],[1,0,0],[0,0,1]],chart),/wall faces/);
});
test('distant correspondence requires the whole coarse face inside the selected source union, including concavities',()=>{
  assert.equal(proveFacadeCoverage([[0,2,0],[2,0,0],[2,2,0]],[a,b],chart).outsideAreaMetres2,0);
  assert.throws(()=>proveFacadeCoverage(b,[a],chart),/outside selected/);
  const hole:FacadeTriangle[]=[[[0,0,0],[2,0,0],[0,1,0]],[[0,1,0],[2,2,0],[0,2,0]]];
  assert.throws(()=>proveFacadeCoverage(a,hole,chart),/outside selected/);
});
test('strict profile bounds aggregate duplicated atlas fallback memory and rejects ambiguous targets',()=>{
  const p=profile();validateFacadeChartProfile(p);assert.ok(facadeAtlasBytes(768,768)<=3*1024*1024);
  assert.equal(facadeAtlasBytes(768,768),3145720);assert.equal(facadeAtlasBc7Bytes(768,768),786480);
  assert.throws(()=>validateFacadeChartProfile({...p,unexpected:true}),/profile fields/);
  assert.throws(()=>validateFacadeChartProfile({...p,art:{...p.art,width:769}}),/768/);
  assert.throws(()=>validateFacadeChartProfile({...p,art:{...p.art,width:768,height:768},cells:[p.cells[0]!,{...p.cells[0]!,id:'second'}]}),/Aggregate/);
  assert.throws(()=>validateFacadeChartProfile({...p,cells:[{...p.cells[0]!,detailed:[...p.cells[0]!.detailed,...p.cells[0]!.detailed]}]}),/Duplicate/);
  assert.throws(()=>validateFacadeChartProfile({...p,charts:[{...chart,uAxis:[2,0,0]}]}),/orthonormal/);
});
test('distant colours sample opaque original art in linear space',()=>{
  const image={width:16,height:16,data:new Uint8Array(16*16*4)};for(let i=0;i<image.data.length;i+=4)image.data.set([128,255,0,255],i);
  const colour=sampleFacadeChartColour([1,1,0],chart,image);assert.ok(Math.abs(colour[0]-.2158605001)<1e-9);assert.equal(colour[1],1);assert.equal(colour[2],0);
  image.data.fill(0);assert.throws(()=>sampleFacadeChartColour([1,1,0],chart,image),/opaque/);
});
