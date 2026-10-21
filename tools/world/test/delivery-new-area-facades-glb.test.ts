import assert from'node:assert/strict';import test from'node:test';import{GlbBuilder,encodeKtx2}from'../lib/gltf.ts';import{applyNativeFacadeAppearance,type NativeAppearanceFace}from'../lib/delivery-new-area-facades-glb.ts';import{facadeTriangleKey,type FacadeTriangle}from'../lib/facade-charts.ts';import{readFacadeGlb}from'../lib/facade-glb.ts';import{deliverySha,decodeDeliveryCityGlb,deliveryGeometryStats,embedDeliveryImages}from'../lib/delivery-city-payloads.ts';import{validateBytes}from'gltf-validator';
const a:FacadeTriangle=[[0,0,0],[2,0,0],[2,3,0]],b:FacadeTriangle=[[0,0,0],[2,3,0],[0,3,0]],ground:FacadeTriangle=[[4,0,0],[4,0,2],[6,0,0]],sourceFace:NativeAppearanceFace={key:facadeTriangleKey(a),points:a,uv:[[0,1],[1,1],[1,0]],colour:[[1,.2,.1],[.2,1,.1],[.1,.2,1]],building:'BID-source',polygon:'source-poly'};
async function fixture(coarse=false){const builder=new GlbBuilder('source'),positions=Float32Array.from([...a.flat(),...b.flat()]);await builder.addMesh({name:'native-buildings',positions,indices:Uint32Array.from([1,2,0,3,4,5]),uvs:new Float32Array(12).fill(.5),materialName:'wall'},{name:'wall',unlit:true});if(coarse){const p=builder.doc.getRoot().listMeshes()[0]!.listPrimitives()[0]!;p.setAttribute('COLOR_0',builder.doc.createAccessor().setType('VEC3').setBuffer(builder.doc.getRoot().listBuffers()[0]!).setArray(new Float32Array(18).fill(.4)));}
await builder.addMesh({name:'cell_ground_stone',positions:Float32Array.from(ground.flat()),indices:Uint32Array.from([0,1,2]),materialName:'ground'},{name:'ground',unlit:false});return builder.toGlb('Municipal test source',{},'exact');}
test('Actual compressed external texture transfer preserves source BIN, selected XYZ/winding and ground',async()=>{
 const before=await fixture(),raw={width:128,height:128,data:new Uint8Array(128*128*4).fill(255)},encoded=await encodeKtx2(raw,'facade'),uri='../textures/'+deliverySha(encoded)+'.ktx2',images=new Map([[uri,encoded]]),result=await applyNativeFacadeAppearance(before,{expected:deliverySha(before),images:new Map(),faces:[sourceFace],distant:false,atlas:{uri,bytes:encoded,width:128,height:128,gpuBytes:22000},profileSha256:'a'.repeat(64)}),old=readFacadeGlb(before),next=readFacadeGlb(result.bytes);
 assert.deepEqual(next.bin.subarray(0,old.bin.length),old.bin);assert.equal(deliveryGeometryStats(result.bytes).triangles,3);assert.equal(result.proof.addedDraws,1);assert.equal((next.json.images as any[]).at(-1).uri,uri);assert.equal((next.json.images as any[]).at(-1).bufferView,undefined);assert.equal((await validateBytes(embedDeliveryImages(result.bytes,images),{maxIssues:50})).issues.numErrors,0);
 const doc=await decodeDeliveryCityGlb(result.bytes,images),node=doc.getRoot().listNodes().find(n=>n.getName()==='native-buildings')!,added=node.getMesh()!.listPrimitives()[1]!,P=added.getAttribute('POSITION')!,UV=added.getAttribute('TEXCOORD_0')!;for(let i=0;i<P.getCount();i++){const v=P.getElement(i,[]),source=a.findIndex(p=>p.every((n,k)=>n===v[k]));assert.ok(source>=0);assert.deepEqual(UV.getElement(i,[]),sourceFace.uv[source]);}
});
test('Distant appearance updates existing colour draw, retaining unselected colours and no images',async()=>{
 const before=await fixture(true),result=await applyNativeFacadeAppearance(before,{expected:deliverySha(before),images:new Map(),faces:[sourceFace],distant:true,profileSha256:'b'.repeat(64)}),doc=await decodeDeliveryCityGlb(result.bytes),oldDoc=await decodeDeliveryCityGlb(before),p=doc.getRoot().listNodes().find(n=>n.getName()==='native-buildings')!.getMesh()!.listPrimitives()[0]!,old=oldDoc.getRoot().listNodes().find(n=>n.getName()==='native-buildings')!.getMesh()!.listPrimitives()[0]!;
 assert.equal(deliveryGeometryStats(result.bytes).drawCalls,deliveryGeometryStats(before).drawCalls);assert.equal(deliveryGeometryStats(result.bytes).triangles,3);assert.equal(doc.getRoot().listTextures().length,0);assert.deepEqual(p.getAttribute('COLOR_0')!.getArray()!.subarray(0,18),old.getAttribute('COLOR_0')!.getArray());assert.equal(result.proof.addedDraws,0);assert.equal((await validateBytes(result.bytes,{maxIssues:50})).issues.numErrors,0);
 await assert.rejects(applyNativeFacadeAppearance(before,{expected:deliverySha(before),images:new Map(),faces:[{...sourceFace,key:facadeTriangleKey(ground),points:ground}],distant:true,profileSha256:'b'.repeat(64)}),/Ground or infrastructure/);
});
test('Only explicit distant exact-key subsets may retain source faces absent from a simplified tier',async()=>{
 const before=await fixture(true),absent:FacadeTriangle=[[8,0,0],[10,0,0],[10,3,0]],missing={...sourceFace,key:facadeTriangleKey(absent),points:absent},args={expected:deliverySha(before),images:new Map<string,Uint8Array>(),faces:[sourceFace,missing],distant:true,profileSha256:'c'.repeat(64)};
 await assert.rejects(applyNativeFacadeAppearance(before,args),/absent in this exact tier/);
 const result=await applyNativeFacadeAppearance(before,{...args,allowUnmappedDistantFaces:true});
 assert.equal(result.proof.selectedFaces,1);assert.equal(result.proof.distantCoverage!.unmappedNativeSourceFaceCount,1);
 assert.equal(result.proof.distantCoverage!.unmappedNativeSourceWallArea,3);assert.equal(result.proof.distantCoverage!.fullTextureRepairClaimed,false);
 assert.equal(result.proof.addedDraws,0);assert.equal(deliveryGeometryStats(result.bytes).triangles,deliveryGeometryStats(before).triangles);
 const doc=await decodeDeliveryCityGlb(result.bytes),old=await decodeDeliveryCityGlb(before),p=doc.getRoot().listNodes().find(n=>n.getName()==='native-buildings')!.getMesh()!.listPrimitives()[0]!,q=old.getRoot().listNodes().find(n=>n.getName()==='native-buildings')!.getMesh()!.listPrimitives()[0]!;
 // The other actual coarse triangle keeps its original indices and colours.
 assert.deepEqual(Array.from(p.getIndices()!.getArray()!.subarray(3)),Array.from(q.getIndices()!.getArray()!.subarray(3)));
 assert.deepEqual(p.getAttribute('COLOR_0')!.getArray()!.subarray(0,18),q.getAttribute('COLOR_0')!.getArray());
 await assert.rejects(applyNativeFacadeAppearance(before,{...args,distant:false,allowUnmappedDistantFaces:true}),/Only distant/);
});
test('A fully selected original primitive changes its material in place without an empty draw',async()=>{
 const before=await fixture(),image=await encodeKtx2({width:128,height:128,data:new Uint8Array(128*128*4).fill(255)},'facade'),uri='../textures/'+deliverySha(image)+'.ktx2',other={...sourceFace,key:facadeTriangleKey(b),points:b};
 const result=await applyNativeFacadeAppearance(before,{expected:deliverySha(before),images:new Map(),faces:[sourceFace,other],distant:false,
   atlas:{uri,bytes:image,width:128,height:128,gpuBytes:22000},profileSha256:'d'.repeat(64)});
 assert.equal(result.proof.selectedFaces,2);assert.equal(result.proof.addedDraws,0);
 assert.equal(deliveryGeometryStats(result.bytes).drawCalls,deliveryGeometryStats(before).drawCalls);
 assert.equal(deliveryGeometryStats(result.bytes).triangles,deliveryGeometryStats(before).triangles);
 assert.deepEqual(readFacadeGlb(result.bytes).bin.subarray(0,readFacadeGlb(before).bin.length),readFacadeGlb(before).bin);
 assert.equal((await validateBytes(embedDeliveryImages(result.bytes,new Map([[uri,image]])),{maxIssues:50})).issues.numErrors,0);
});
