import test from 'node:test';
import assert from 'node:assert/strict';
import {Document,NodeIO} from '@gltf-transform/core';
import {ALL_EXTENSIONS,EXTMeshoptCompression} from '@gltf-transform/extensions';
import {MeshoptEncoder,MeshoptDecoder} from 'meshoptimizer';
import {encodeCollisionBundle,parseCollisionBundle,type Vec3} from '../../../packages/world-schema/src/index.ts';
import {GlbBuilder,flatNormals} from '../lib/gltf.ts';
import {readFacadeGlb} from '../lib/facade-glb.ts';
import {decodeDeliveryCityGlb} from '../lib/delivery-city-payloads.ts';
import {measuredFaceKey,replaceMeasuredGroundCollision,replaceMeasuredGroundVisual,validateMeasuredGroundFaces,type MeasuredGroundFace} from '../lib/delivery-measured-ground.ts';
const points:Vec3[]=[[0,0,128],[0,0,132],[4,0,128]],face=():MeasuredGroundFace=>({cell:'c_p00_p01',kind:'pieces',tag:'road:asphalt',finish:'asphalt',use:'both',before:structuredClone(points),after:points.map(p=>[p[0],1,p[2]])});
const position=Float32Array.from(points.flat()),indices=new Uint32Array([0,1,2]),uv=new Float32Array([0,0,0,1,1,0]);
test('reviewed height patch rejects protected city, lowering and horizontal edits',()=>{
 const f=face();assert.equal(validateMeasuredGroundFaces([f],[-1,127,5,133],[-10,-10,10,0]).size,1);
 assert.throws(()=>validateMeasuredGroundFaces([f],[-1,127,5,133],[-10,-10,10,150]),/protected accepted/);
 const x=face();x.after[0]![0]+=.1;assert.throws(()=>validateMeasuredGroundFaces([x],[-1,127,5,133],[-10,-10,10,0]));
 const y=face();y.after[0]![1]=-1;assert.throws(()=>validateMeasuredGroundFaces([y],[-1,127,5,133],[-10,-10,10,0]),/upward correction/);
});
test('a triangle with exterior vertices cannot span the protected accepted interior',()=>{
 const f={...face(),before:[[-2,0,0],[2,0,0],[0,0,2]]as Vec3[],after:[[-2,1,0],[2,1,0],[0,1,2]]as Vec3[]};
 assert.throws(()=>validateMeasuredGroundFaces([f],[-3,-3,3,3],[-1,-1,1,1]),/patch region intersects protected/);
});
test('exact collision replacement leaves buildings and original position prefixes literal',()=>{
 const ground={id:'g',group:'ground' as const,ref:null,positions:position,indices,triangleTags:new Uint16Array([0])},building={...ground,id:'b',group:'buildings' as const,ref:'building',positions:Float32Array.from(position,v=>v+10),triangleTags:new Uint16Array([1])};
 const bytes=encodeCollisionBundle({originId:'fixture',frame:'X-east,Y-up,Z-south',cell:'c_p00_p01',surfaceTags:['road:asphalt','building']},[ground,building]);
 const result=replaceMeasuredGroundCollision(bytes,[face()]),after=parseCollisionBundle(result.bytes);
 assert.deepEqual(after.colliders[1],building);assert.deepEqual(after.colliders[0]!.positions.subarray(0,9),position);assert.deepEqual(Array.from(after.colliders[0]!.indices),[3,4,5]);
 assert.throws(()=>replaceMeasuredGroundCollision(result.bytes,[face()]),/missing an exact/);
});
test('near visual replacement preserves image/resource bytes, UVs and unrelated architecture',async()=>{
 const builder=new GlbBuilder('fixture');await builder.addMesh({name:'c_p00_p01_ground_asphalt',positions:position,normals:flatNormals(position,indices),uvs:uv,indices,materialName:'ground'},{name:'ground',unlit:true});
 await builder.addMesh({name:'building',positions:Float32Array.from(position,v=>v+10),normals:flatNormals(position,indices),uvs:uv,indices,materialName:'building'},{name:'building',unlit:true});
 const bytes=await builder.toGlb('fixture',{},'exact'),doc=await decodeDeliveryCityGlb(bytes),result=await replaceMeasuredGroundVisual(bytes,doc,[face()],false),after=await decodeDeliveryCityGlb(result.bytes);
 assert.deepEqual(readFacadeGlb(result.bytes).bin.subarray(0,readFacadeGlb(bytes).bin.length),readFacadeGlb(bytes).bin);
 const beforeBuilding=doc.getRoot().listNodes().find(n=>n.getName()==='building')!.getMesh()!.listPrimitives()[0]!,afterBuilding=after.getRoot().listNodes().find(n=>n.getName()==='building')!.getMesh()!.listPrimitives()[0]!;assert.deepEqual(afterBuilding.getAttribute('POSITION')!.getArray(),beforeBuilding.getAttribute('POSITION')!.getArray());
 const p=after.getRoot().listNodes().find(n=>n.getName().includes('_ground_'))!.getMesh()!.listPrimitives()[0]!,outPoints=Array.from(p.getIndices()!.getArray()!,i=>p.getAttribute('POSITION')!.getElement(i,[]));assert.equal(measuredFaceKey(outPoints),measuredFaceKey(face().after));assert.equal(result.stats.drawCalls,2);
});
test('coarse face replacement preserves the combined architecture and draw count',async()=>{
 await Promise.all([MeshoptEncoder.ready,MeshoptDecoder.ready]);const doc=new Document(),buffer=doc.createBuffer(),scene=doc.createScene(),material=doc.createMaterial(),P=Float32Array.from([...position,...Array.from(position,v=>v+10)]),C=new Float32Array(P.length).fill(.5),I=new Uint32Array([0,1,2,3,4,5]);
 const p=doc.createPrimitive().setMaterial(material).setAttribute('POSITION',doc.createAccessor().setType('VEC3').setBuffer(buffer).setArray(P)).setAttribute('COLOR_0',doc.createAccessor().setType('VEC3').setBuffer(buffer).setArray(C)).setIndices(doc.createAccessor().setType('SCALAR').setBuffer(buffer).setArray(I));scene.addChild(doc.createNode('c_p00_p01').setMesh(doc.createMesh().addPrimitive(p)));doc.getRoot().setExtras({cell:'c_p00_p01',level:'distant'});doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({method:EXTMeshoptCompression.EncoderMethod.FILTER});
 const io=new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.encoder':MeshoptEncoder,'meshopt.decoder':MeshoptDecoder}),bytes=await io.writeBinary(doc),result=await replaceMeasuredGroundVisual(bytes,await decodeDeliveryCityGlb(bytes),[face()],true),after=await decodeDeliveryCityGlb(result.bytes),q=after.getRoot().listNodes()[0]!.getMesh()!.listPrimitives()[0]!;
 assert.equal(result.stats.drawCalls,1);assert.equal(result.stats.triangles,2);assert.deepEqual(Array.from(q.getIndices()!.getArray()!).slice(3),[3,4,5]);assert.deepEqual(q.getAttribute('POSITION')!.getArray()!.slice(9,18),P.slice(9,18));
});
