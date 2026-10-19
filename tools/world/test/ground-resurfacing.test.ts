import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createResurfacingSelector,nativeFloat32CoverageProof,pavingUv,validateResurfacingPlan,type ResurfacingPlan,type SurfaceTriangle} from '../lib/ground-resurfacing.ts';
import {originalPavingTexture,pavingBc7MipBytes,pavingRgbaMipBytes,pavingPatternCoordinates,fanRadialCourseMetres} from '../lib/paving-textures.ts';
import type {LocalPolygon} from '../lib/geometry.ts';
const h='a'.repeat(64);
export function fixturePlan():ResurfacingPlan{return {schemaVersion:1,id:'fixture',baseCellsIndexSha256:h,streetPartsSha256:h,originSha256:h,minimumNormalY:.7,texture:{size:256,seed:20261018,stonesPerSide:10,jointMetres:.004},regions:[{id:'stone',partIds:['1'],expectedMaterials:['Nupukivi'],existingFinishes:['setts'],pattern:'setts',basis:{originXZ:[0,0],alongXZ:[1,0]},tileMetres:[2,1],referenceIds:['fixture-reference']}]};}
const source:LocalPolygon={id:'1',properties:{materiaali:'Nupukivi',alatyyppi:'Ajorata'},bbox:[0,-4,4,0],rings:[[[0,0],[4,0],[4,-4],[0,-4]],[[1,-1],[2,-1],[2,-2],[1,-2]]]};
const tri:SurfaceTriangle={node:'c_ground_setts',primitive:0,triangle:0,finish:'setts',points:[[0,0,0],[0,0,1],[1,0,0]]};
test('whole source coverage honours holes and rejects partial faces rather than painting their centroid',()=>{
  const select=createResurfacingSelector(fixturePlan(),[source]);assert.equal(select(tri).target?.region,'stone');
  assert.equal(select({...tri,points:[[.5,0,.5],[.5,0,2.5],[2.5,0,.5]]}).rejection?.reason,'partial-source-coverage');
  assert.deepEqual(select({...tri,points:[[1.1,0,1.1],[1.1,0,1.7],[1.7,0,1.1]]}),{});
  assert.equal(select({...tri,points:[[-.1,0,0],[0,0,1],[1,0,0]]}).rejection?.reason,'partial-source-coverage');
});
test('fan cubes have ten-centimetre physical radial courses and periodic seams on both axes',()=>{
  assert.equal(fanRadialCourseMetres(2,10),.1);
  // Along the actual x=0 fan radius, successive course joints are .05 UV
  // apart: the selected 2 m physical repeat makes that exactly .10 m.
  for(const v of [.25,.3,.35])assert.ok(pavingPatternCoordinates(0,v,10,'fan-cobble').ex<1e-12);
  for(const v of [.275,.325])assert.ok(Math.abs(pavingPatternCoordinates(0,v,10,'fan-cobble').ex-.5)<1e-12);
  for(const [u,v]of [[0,.25],[.125,.75],[.875,.125],[.5,0],[.125,.375]]){
    const a=pavingPatternCoordinates(u!,v!,10,'fan-cobble');assert.deepEqual(a,pavingPatternCoordinates(u!+1,v!,10,'fan-cobble'));assert.deepEqual(a,pavingPatternCoordinates(u!,v!+1,10,'fan-cobble'));
  }
  assert.throws(()=>validateResurfacingPlan({...fixturePlan(),texture:{...fixturePlan().texture,stonesPerSide:9}}),/even/);
});
test('source material, source identities, explicit finish and vertical closure guards fail closed',()=>{
  const plan=fixturePlan();assert.throws(()=>createResurfacingSelector(plan,[{...source,properties:{materiaali:'Asfalttibetoni'}}]),/material mismatch/);
  assert.throws(()=>createResurfacingSelector(plan,[]),/Missing\/duplicate/);
  assert.throws(()=>createResurfacingSelector(plan,[{...source,properties:{materiaali:'Nupukivi',alatyyppi:'Portaat'}}]),/Protected/);
  const select=createResurfacingSelector(plan,[source]);assert.deepEqual(select({...tri,finish:'yard'}),{});assert.deepEqual(select({...tri,points:[[0,0,0],[0,1,0],[1,0,0]]}),{});
  const second={...plan.regions[0]!,id:'other'};assert.equal(createResurfacingSelector({...plan,regions:[...plan.regions,second]},[source])(tri).rejection?.reason,'ambiguous-region-overlap');
});
test('native Float32 boundary proof admits a twenty-micron rounding witness but rejects a real sliver and hole',()=>{
  const p:LocalPolygon={id:'1',properties:source.properties,bbox:[1000.00002,-2,1002,0],rings:[[[1000.00002,0],[1002,0],[1002,-2],[1000.00002,-2]]]};
  const t:SurfaceTriangle={...tri,points:[[1000,0,0],[1000,0,1],[1001,0,0]]},select=createResurfacingSelector(fixturePlan(),[p]),q=select(t);
  assert.ok(q.target?.nativeCoverage);assert.ok(q.target.nativeCoverage.maximumOutsideDistanceMetres>19e-6);assert.ok(q.target.nativeCoverage.maximumOutsideDistanceMetres<q.target.nativeCoverage.boundMetres);
  const real={...p,bbox:[1000.1,-2,1002,0] as [number,number,number,number],rings:[[[1000.1,0],[1002,0],[1002,-2],[1000.1,-2]]] as LocalPolygon['rings']};assert.equal(createResurfacingSelector(fixturePlan(),[real])(t).rejection?.reason,'partial-source-coverage');
  const hole={...p,rings:[...p.rings,[[1000.2,-.2],[1000.4,-.2],[1000.4,-.4],[1000.2,-.4]]] as LocalPolygon['rings']};assert.equal(createResurfacingSelector(fixturePlan(),[hole])(t).rejection?.reason,'partial-source-coverage');
});
test('a native corner fragment decomposes into exact capsule-proven diagnostic triangles only',()=>{
  const e=2**-18,outer=[[[[1000,0],[1002,0],[1002,2],[1000,2]]]],outside=[[[[1000-e,-e],[1001,-e],[1001,0],[1000,0],[1000,1],[1000-e,1]]]];
  const proof=nativeFloat32CoverageProof([[1000,0,0],[1000,0,1],[1001,0,0]],outside as any,outer as any);
  assert.ok(proof);assert.ok(proof.fragments.some(f=>f.diagnosticTriangle));for(const f of proof.fragments)assert.ok(f.maximumDistanceMetres<=proof.boundMetres);assert.ok(proof.maximumDiagnosticDepth<=12);
});
test('physical world basis maintains exact cell-boundary phase and rectangular stone scale',()=>{
  const r=fixturePlan().regions[0]!;assert.deepEqual(pavingUv([128,9,4],r),[64,4]);assert.deepEqual(pavingUv([128,-2,4],r),[64,4]);
  assert.deepEqual(pavingUv([.2,0,.1],r),[.1,.1]);assert.throws(()=>validateResurfacingPlan({...fixturePlan(),regions:[{...r,basis:{originXZ:[0,0],alongXZ:[2,0]}}]}),/unit length/);
  assert.throws(()=>validateResurfacingPlan({...fixturePlan(),unexpected:1}),/fields/);
  const bounded={...fixturePlan(),regions:[{...r,runtimeBoundsXZ:[0,0,.5,4] as [number,number,number,number]}]};
  assert.equal(createResurfacingSelector(bounded,[source])(tri).rejection?.reason,'partial-source-coverage');
});
test('original stone albedo is deterministic, opaque, bounded and has explicit per-owner residency costs',()=>{
  const a=originalPavingTexture(fixturePlan().texture),b=originalPavingTexture(fixturePlan().texture);assert.deepEqual(a,b);assert.equal(a.width,256);
  for(let i=3;i<a.data.length;i+=4)assert.equal(a.data[i],255);
  assert.equal(pavingRgbaMipBytes(256),349524);assert.equal(pavingBc7MipBytes(256),87408);assert.ok(18*pavingBc7MipBytes(256)<1.51*1024**2);
  assert.notDeepEqual(a.data,originalPavingTexture({...fixturePlan().texture,seed:2}).data);
  assert.notDeepEqual(a.data,originalPavingTexture(fixturePlan().texture,'fan-cobble').data);
});
