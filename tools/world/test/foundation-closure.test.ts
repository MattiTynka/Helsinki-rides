import assert from 'node:assert/strict';
import test from 'node:test';
import {Document} from '@gltf-transform/core';
import {buildFoundationClosure, foundationMaterial, type FoundationRepair} from '../lib/foundation-closure.ts';

const edge: FoundationRepair = {building:'source-building',vtj:'source-vtj',cell:'c_p01_p00',materialName:'palette',
  edgeRuntime:[[128,2,0],[130,2,0]],uv:[[0.5,0.25],[0.5,0.25]],exterior:[0,1],reason:'Measured frozen skirt gap'};

test('foundation strips preserve the source edge and bury below the lowest adjacent support', () => {
  const mesh = buildFoundationClosure(edge, (x,z) => x - 130 + z);
  assert.equal(mesh.audit.closedSegments,4);
  for(let i=0;i<mesh.positions.length;i+=3){
    const [x,y,z]=mesh.positions.slice(i,i+3);
    assert.equal(z,0,'A foundation must never pave a horizontal land area');
    assert.ok(y!<=2);assert.ok(x!>=128&&x!<=130);
    if(y!==2)assert.ok(y!<=x!-130+0.01-0.3+1e-10);
    assert.deepEqual(mesh.uvs.slice(i/3*2,i/3*2+2),[0.5,0.25]);
  }
  assert.equal(mesh.indices.length,4*12);
});

test('a fully buried frozen skirt receives no redundant strip', () => {
  assert.equal(buildFoundationClosure(edge,()=>3).indices.length,0);
});

test('unbounded, missing, or excessive support fails instead of creating invented foundations', () => {
  assert.throws(()=>buildFoundationClosure(edge,()=>null),/lacks dry ground/);
  assert.throws(()=>buildFoundationClosure(edge,()=>-20),/over 8m/);
  assert.throws(()=>buildFoundationClosure({...edge,exterior:[1,1]},()=>0));
});

test('source validation binds an actual transformed skirt edge and its palette UV without changing it', () => {
  const doc=new Document(), buffer=doc.createBuffer(), material=doc.createMaterial('palette');
  const positions=doc.createAccessor().setBuffer(buffer).setType('VEC3').setArray(new Float32Array([0,4,0,2,4,0,2,2,0,0,2,0]));
  const uvs=doc.createAccessor().setBuffer(buffer).setType('VEC2').setArray(new Float32Array([.5,.25,.5,.25,.5,.25,.5,.25]));
  const indices=doc.createAccessor().setBuffer(buffer).setType('SCALAR').setArray(new Uint32Array([0,1,2,0,2,3]));
  const primitive=doc.createPrimitive().setAttribute('POSITION',positions).setAttribute('TEXCOORD_0',uvs).setIndices(indices).setMaterial(material);
  const node=doc.createNode('source_palette').setTranslation([128,0,0]).setMesh(doc.createMesh().addPrimitive(primitive));
  doc.createScene().addChild(node);
  const before=Array.from(positions.getArray()!);
  assert.equal(foundationMaterial(doc,edge),material);
  assert.deepEqual(Array.from(positions.getArray()!),before);
  assert.throws(()=>foundationMaterial(doc,{...edge,uv:[[.1,.1],[.1,.1]]}),/not present/);
  node.setName('cell_ground_foundation');
  assert.throws(()=>foundationMaterial(doc,edge),/not present/,'New ground cannot attest an original source skirt');
});
