import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Document} from '@gltf-transform/core';
import {selectCoarseGroundCorrespondence} from '../lib/ground-seal-colour.ts';

function fixture(){
  const document=new Document(),buffer=document.createBuffer(),scene=document.createScene();
  function primitive(positions:number[],indices:number[],colour:number[]){return document.createPrimitive().setAttribute('POSITION',document.createAccessor().setBuffer(buffer).setType('VEC3').setArray(Float32Array.from(positions))).setAttribute('COLOR_0',document.createAccessor().setBuffer(buffer).setType('VEC3').setArray(Float32Array.from(positions.flatMap((_,i)=>i%3===0?colour:[])))).setIndices(document.createAccessor().setBuffer(buffer).setType('SCALAR').setArray(Uint32Array.from(indices)));}
  const ground=[0,0,0,1,0,0,1,0,1],source=primitive(ground,[0,2,1],[.1,.2,.3]);
  return{document,scene,primitive,source,ground};
}
test('selects appended coarse ground and exact colours instead of first-node architecture sharing vertices',()=>{
  const f=fixture(),architecture=f.primitive([0,0,0,1,0,0,1,5,1],[0,2,1],[1,0,0]),opposite=f.primitive(f.ground,[0,1,2],[1,0,1]),actual=f.primitive(f.ground,[2,1,0],[.17,.23,.31]);
  f.scene.addChild(f.document.createNode('original-cell').setMesh(f.document.createMesh().addPrimitive(architecture).addPrimitive(opposite)));
  f.scene.addChild(f.document.createNode('append:original-cell').setMesh(f.document.createMesh().addPrimitive(actual)));
  const selected=selectCoarseGroundCorrespondence(f.source,f.document,'fixture');assert.equal(selected.nodeName,'append:original-cell');assert.equal(selected.primitiveIndex,0);assert.equal(selected.matchedTriangles,1);assert.equal(selected.samples.length,3);
  for(const sample of selected.samples)assert.deepEqual(sample.colour,Array.from(Float32Array.from([.17,.23,.31])));
  assert.deepEqual(architecture.getAttribute('COLOR_0')!.getArray(),Float32Array.from([1,0,0,1,0,0,1,0,0]));
});
test('rejects position-only correspondence and reversed triangles without inventing colours',()=>{
  const f=fixture();f.scene.addChild(f.document.createNode('wall').setMesh(f.document.createMesh().addPrimitive(f.primitive(f.ground,[0,1,2],[1,0,0]))));
  assert.throws(()=>selectCoarseGroundCorrespondence(f.source,f.document,'no-ground'),/Exact coarse ground triangle colour correspondence required: no-ground/);
});
