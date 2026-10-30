import assert from 'node:assert/strict';
import {test} from 'node:test';
import {encodeCollisionBundle,encodeTerrain,parseCollisionBundle,type GameplayBundle,type RoadGraph} from '../../../packages/world-schema/src/index.ts';
import {qualifyScopedBridgePassage,qualifyScopedBridgePassageWithNativeMotion} from '../lib/delivery-bridge-passages.ts';
import {buildExtraBridgeDeck,type ExtraBridgeDeckProfile} from '../lib/delivery-extra-bridges-mesh.ts';
import type {ExtraBridgeNativeFace} from '../lib/delivery-extra-bridges-source.ts';
import type {SupportTriangle} from '../lib/tram-support-repair.ts';
const floor=(z0:number,z1:number,y0:number,y1:number):SupportTriangle[]=>[[[-8,y0,z0],[8,y1,z1],[8,y0,z0]],[[-8,y0,z0],[-8,y1,z1],[8,y1,z1]]];
function fixture(wall=false){
  const triangles=[...floor(-8,-.05,0,0),...floor(-.05,.05,0,.1),...floor(.05,8,.1,.1)],positions=Float32Array.from(triangles.flat(2)),indices=Uint32Array.from({length:triangles.length*3},(_,i)=>i);
  const colliders=[{id:'lower',group:'ground' as const,ref:null,positions,indices,triangleTags:new Uint16Array(triangles.length)}];
  if(wall)(colliders as any[]).push({id:'wall',group:'props',ref:null,positions:Float32Array.from([-8,0,0,-8,3,0,8,3,0,8,0,0]),indices:Uint32Array.from([0,1,2,0,2,3]),triangleTags:new Uint16Array(2)});
  const bytes=encodeCollisionBundle({originId:'fixture',frame:'X-east,Y-up,Z-south',cell:'fixture',surfaceTags:['raised:slabs']},colliders),bundle=parseCollisionBundle(bytes),native:ExtraBridgeNativeFace[]=[];
  const lower=bundle.colliders[0]!;for(let i=0;i<triangles.length;i++)native.push({cell:'fixture',collider:'lower',triangle:i,tag:'raised:slabs',group:'ground',points:[0,1,2].map(k=>Array.from(lower.positions.subarray(lower.indices[i*3+k]!*3,lower.indices[i*3+k]!*3+3)))as SupportTriangle});
  const profile:ExtraBridgeDeckProfile={surfaceMethod:'native-bank-piecewise-planar-ruled-sections-v1',frame:{origin:[0,0],direction:[1,0]},banks:[-3,3].map(s=>({s,segments:[{t0:-2,t1:2,y0:3,y1:3,role:'road',sourcePartIds:[10],source:{cell:'fixture',collider:'upper-bank',triangle:0,sha256:'a'.repeat(64)}}]}))as ExtraBridgeDeckProfile['banks'],upperParts:[{id:10,role:'road',tag:'road:asphalt',rings:[[[-3,-2],[3,-2],[3,2],[-3,2],[-3,-2]]],sha256:'b'.repeat(64)}],crownMetres:0,deckThicknessMetres:.3,maximumGrade:.15};
  const gameplay={originId:'fixture',killHeight:-20,playArea:{minX:-10,maxX:10,minZ:-10,maxZ:10}}as GameplayBundle,roads={schemaVersion:2,originId:'fixture',nodes:[],lanes:[],connectors:[],parking:[],footways:[]}as unknown as RoadGraph;
  return{options:{axis:[[0,-4],[0,4]]as[number,number][],bodyRadiusMetres:.69,sourceParts:[{id:1,name:'source public path',tag:'raised:slabs',rings:[[[-8,-8],[8,-8],[8,8],[-8,8],[-8,-8]]]as[number,number][][]}],native,upperFloors:buildExtraBridgeDeck(profile).faces.filter(f=>f.role==='road'||f.role==='footway').map(f=>f.points),deckThicknessMetres:.3,minimumClearanceMetres:2.2},motion:{profile,gameplay,roads,cells:[{id:'fixture',bytes}],terrainBytes:encodeTerrain({x0:-10,z0:-10,nx:3,nz:3,resolution:10,heights:new Float32Array(9).fill(-1)})}};
}
test('explicit native transition mode earns coverage with six actual controller traversals while legacy normal screen stays strict',async()=>{
  const f=fixture(),before=structuredClone(f.options.native);assert.throws(()=>qualifyScopedBridgePassage(f.options),/complete native floor/);
  const result=await qualifyScopedBridgePassageWithNativeMotion(f.options,f.motion,{maximumTrackErrorMetres:.22});assert.equal(result.motion.runs.length,6);assert.ok(result.motion.runs.every(r=>r.continuousExpandedCapsuleSweeps>0));assert.ok(result.minimumClearanceMetres>=2.59);assert.deepEqual(f.options.native,before);
});
test('motion exception rejects a real obstacle, changed collision witnesses and a body envelope too small for track error',async()=>{
  const blocked=fixture(true);await assert.rejects(()=>qualifyScopedBridgePassageWithNativeMotion(blocked.options,blocked.motion,{maximumTrackErrorMetres:.22}),/obstacle|blocked|corridor/);
  const changed=fixture();changed.options.native[0]!.points[0][1]+=.01;await assert.rejects(()=>qualifyScopedBridgePassageWithNativeMotion(changed.options,changed.motion,{maximumTrackErrorMetres:.22}),/differs from serialized/);
  const small=fixture();await assert.rejects(()=>qualifyScopedBridgePassageWithNativeMotion({...small.options,bodyRadiusMetres:.55},small.motion,{maximumTrackErrorMetres:.22}),/track deviation/);
});
