import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Document,NodeIO} from '@gltf-transform/core';
import {ALL_EXTENSIONS,EXTMeshoptCompression} from '@gltf-transform/extensions';
import {MeshoptEncoder,MeshoptDecoder} from 'meshoptimizer';
import {encodeCollisionBundle,parseCollisionBundle} from '../../../packages/world-schema/src/index.ts';
import {GlbBuilder,flatNormals} from '../lib/gltf.ts';
import {appendExtraBridgeGlb} from '../lib/delivery-extra-bridges-glb.ts';
import {appendBridgeCollision} from '../lib/bridge-reconstruction.ts';
import type {ExtraBridgeFace} from '../lib/delivery-extra-bridges-mesh.ts';
import {decodeDeliveryCityGlb} from '../lib/delivery-city-payloads.ts';
import {deliveryFrontierMesh,deliveryGroundProvenance,patchDeliveryFrontierCollision,replaceDeliveryFrontierVisual} from '../lib/delivery-city-frontier.ts';
import {deliveryNativeGroundFinish} from '../lib/delivery-frontier-selection.ts';
import {readFacadeGlb} from '../lib/facade-glb.ts';

const cell='c_m13_p05',P=Float32Array.from([0,0,0,4,0,0,4,0,4,0,0,4]),I=Uint32Array.from([0,2,1,0,3,2]);
const faces:ExtraBridgeFace[]=[
  {points:[[0,2,0],[4,2,4],[4,2,0]],role:'road',material:'asphalt',uvs:[[0,0],[4,4],[4,0]],collision:true,sourcePartIds:[1]},
  {points:[[0,2,0],[0,2,4],[4,2,4]],role:'road',material:'asphalt',uvs:[[0,0],[0,4],[4,4]],collision:true,sourcePartIds:[1]},
  {points:[[0,2,0],[4,2,0],[4,2.2,0]],role:'curb',material:'asphalt',uvs:[[0,0],[4,0],[4,.2]],collision:true,sourcePartIds:[2]},
];
async function fixture(){
  const builder=new GlbBuilder(cell);await builder.addMesh({name:`${cell}_ground_asphalt`,positions:P,indices:I,normals:flatNormals(P,I),uvs:Float32Array.from([0,0,4,0,4,4,0,4]),materialName:'asphalt'},{name:'asphalt',unlit:false});
  const near=await appendExtraBridgeGlb(await builder.toGlb('fixture',{},'exact'),faces,{cell,bridgeId:'lansilinkki',coarse:false,externalImages:new Map()});
  const doc=new Document(),buffer=doc.createBuffer(),p=doc.createPrimitive().setAttribute('POSITION',doc.createAccessor().setBuffer(buffer).setType('VEC3').setArray(P.slice())).setAttribute('COLOR_0',doc.createAccessor().setBuffer(buffer).setType('VEC3').setArray(new Float32Array(P.length).fill(.4))).setIndices(doc.createAccessor().setBuffer(buffer).setType('SCALAR').setArray(I.slice()));doc.createScene().addChild(doc.createNode(cell).setMesh(doc.createMesh().addPrimitive(p)));
  doc.getRoot().setExtras({level:'distant',cell});await Promise.all([MeshoptEncoder.ready,MeshoptDecoder.ready]);doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({method:EXTMeshoptCompression.EncoderMethod.FILTER});
  const io=new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.encoder':MeshoptEncoder,'meshopt.decoder':MeshoptDecoder});
  const far=await appendExtraBridgeGlb(await io.writeBinary(doc),faces,{cell,bridgeId:'lansilinkki',coarse:true,externalImages:new Map()});
  const collision=appendBridgeCollision(encodeCollisionBundle({originId:'test',frame:'X-east,Y-up,Z-south',cell,surfaceTags:['road:asphalt']},[{id:'ordinary',group:'ground',ref:null,positions:P,indices:I,triangleTags:new Uint16Array(2)}]),faces,cell);
  return{near,far,collision};
}
test('authored bridge names and metadata are protected while unknown ordinary finishes fail closed',()=>{
  for(const name of[`${cell}_ground_extra_bridge_lansilinkki_0`,`${cell}_ground_bridge_asphalt`])assert.equal(deliveryNativeGroundFinish(name),null);
  assert.equal(deliveryNativeGroundFinish('renamed_ground_deck',{extraBridge:'lansilinkki'}),null);
  assert.equal(deliveryNativeGroundFinish('renamed_ground_deck',{bridgeReconstruction:true}),null);
  assert.equal(deliveryNativeGroundFinish(`${cell}_ground_frontier_asphalt`),'asphalt');
  assert.throws(()=>deliveryNativeGroundFinish(`${cell}_ground_unrecognized`),/Unknown native ground finish/);
});
test('in-band accepted extra bridge keeps exact near attributes, coarse faces and all bridge collision',async()=>{
  const{near,far,collision}=await fixture(),authority=await decodeDeliveryCityGlb(near),oldNode=authority.getRoot().listNodes().find(n=>n.getName()===`${cell}_ground_extra_bridge_lansilinkki_0`)!;assert.ok(oldNode);
  const pieces=[{cell,finish:'asphalt' as const,level:'road' as const,tag:'road:asphalt',positions:[0,-1,0,4,-1,0,4,-1,4,0,-1,4],uvs:[0,0,4,0,4,4,0,4],indices:[0,2,1,0,3,2]}];
  for(const[bytes,coarse]of[[near,false],[far,true]]as const){
    const out=await replaceDeliveryFrontierVisual({bytes,authority,collision,region:[-1,-1,5,5],pieces,coarse,cell,copyright:'fixture',images:new Map()}),after=await decodeDeliveryCityGlb(out.bytes,new Map(out.newImages.map(i=>[`../${i.path}`,i.bytes])));
    assert.deepEqual(readFacadeGlb(out.bytes).bin.subarray(0,readFacadeGlb(bytes).bin.length),readFacadeGlb(bytes).bin);
    if(!coarse){const next=after.getRoot().listNodes().find(n=>n.getName()===oldNode.getName())!;assert.deepEqual(next.getExtras(),oldNode.getExtras());const oldPrimitive=oldNode.getMesh()!.listPrimitives()[0]!,newPrimitive=next.getMesh()!.listPrimitives()[0]!;for(const semantic of oldPrimitive.listSemantics())assert.deepEqual(newPrimitive.getAttribute(semantic)!.getArray(),oldPrimitive.getAttribute(semantic)!.getArray());assert.deepEqual(newPrimitive.getIndices()!.getArray(),oldPrimitive.getIndices()!.getArray());}
    const triangles=after.getRoot().listNodes().flatMap(n=>n.getMesh()?.listPrimitives()??[]).flatMap(p=>{const mesh=deliveryFrontierMesh(p);return Array.from({length:mesh.indices.length/3},(_,t)=>[0,1,2].map(k=>Array.from(mesh.attributes.POSITION!.subarray(mesh.indices[t*3+k]!*3,mesh.indices[t*3+k]!*3+3))));});
    for(const face of faces)assert.equal(triangles.filter(t=>JSON.stringify(t)===JSON.stringify(face.points.map(p=>p.map(Math.fround)))).length,1,'Each authored face remains exactly once');
    assert.equal(triangles.filter(t=>t.every(p=>p[1]===0)).length,0,'Ordinary old terrain is still replaced');
    if(coarse)assert.equal(out.audits.reduce((n,a)=>n+a.unselectedTriangles,0),faces.length);
  }
  const before=parseCollisionBundle(collision),patched=patchDeliveryFrontierCollision(collision,[-1,-1,5,5],pieces),after=parseCollisionBundle(patched.bytes);assert.equal(patched.protectedAuthoredBridgeColliders.length,2);for(const c of before.colliders.slice(1))assert.deepEqual(after.colliders.find(n=>n.id===c.id),c);assert.ok(Array.from(after.colliders[0]!.positions).some((v,i)=>i%3===1&&v===-1));
});
test('retriangulated bridge floor with new vertices cannot become ordinary HCOL cut authority',async()=>{
  const{near,collision}=await fixture(),authority=await decodeDeliveryCityGlb(near),mesh={attributes:{POSITION:Float32Array.from([1,2,1,3,2,3,3,2,1])},components:{POSITION:3},normalized:{POSITION:false},indices:Uint32Array.from([0,1,2])};
  const provenance=deliveryGroundProvenance(authority,collision);assert.equal(provenance.classify(mesh,0),'protected-authored-bridge-floor');assert.equal(provenance.select(mesh,0),false);
  const noVisualAuthority=deliveryGroundProvenance(new Document(),collision);assert.equal(noVisualAuthority.select(mesh,0),false);
});
