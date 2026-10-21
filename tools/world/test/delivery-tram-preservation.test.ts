import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GlbBuilder,flatNormals} from '../lib/gltf.ts';
import {readFacadeGlb} from '../lib/facade-glb.ts';
import {appendTramVisualGlb} from '../lib/append-tram-glb.ts';
import {decodeDeliveryTramGlb,existingDeliveryRailMask,proveDeliveryTramPreservation} from '../lib/tram-delivery.ts';
import {tramStripePng} from '../lib/tram-texture.ts';
import {drapeTramFootprints,tramFootprints,DEFAULT_TRAM_PROFILE,type TramMesh,type TramGroundTriangle} from '../lib/tram-visuals.ts';

const tiny:TramMesh={positions:[.1,.003,.5,.9,.003,.5,.9,.003,.56],normals:[0,1,0,0,1,0,0,1,0],colours:[.49,.52,.54,.49,.52,.54,.49,.52,.54],uvs:[20/44,.5,20/44,.5,1,.5],indices:[0,2,1],bindings:[],stats:{expectedArea:.024,coveredArea:.024,missingArea:0,maximumLiftError:0,triangles:1}};
async function fixture(coarse=false,count=1,primitives=1,external=false){
 const builder=new GlbBuilder('fixture'),positions=new Float32Array([0,0,-3,10,0,-3,10,0,3,0,0,3]),indices=new Uint32Array([0,3,2,0,2,1]);
 for(let i=0;i<count;i++)await builder.addMesh({name:i?`accepted_repair_${i}`:'cell_ground_asphalt',positions,indices,normals:flatNormals(positions,indices),materialName:'stone'},{name:'stone',unlit:false});
 if(coarse)for(const mesh of builder.doc.getRoot().listMeshes()){
  const p=mesh.listPrimitives()[0]!,buffer=builder.doc.getRoot().listBuffers()[0]!;p.setAttribute('COLOR_0',builder.doc.createAccessor().setType('VEC3').setBuffer(buffer).setArray(new Float32Array(12).fill(.4)));
  for(let i=1;i<primitives;i++)mesh.addPrimitive(p.clone());
 }
 if(external){const texture=builder.doc.createTexture('shared original image').setMimeType('image/png').setImage(await tramStripePng());builder.doc.getRoot().listMaterials()[0]!.setBaseColorTexture(texture);}
 const bytes=await builder.toGlb('source-copyright',{},'exact');
 if(!external)return{bytes,images:new Map<string,Uint8Array>()};
 const raw=readFacadeGlb(bytes),j=raw.json as any,image=j.images[0],view=j.bufferViews[image.bufferView],payload=raw.bin.slice(view.byteOffset??0,(view.byteOffset??0)+view.byteLength);delete image.bufferView;image.uri='../textures/pinned-original.png';
 return{bytes:serialize(j,raw.bin),images:new Map([[image.uri,payload]])};
}
function serialize(json:any,bin:Uint8Array){const text=Buffer.from(JSON.stringify(json)),pad=Buffer.alloc((text.length+3)&~3,0x20);text.copy(pad);const out=Buffer.alloc(28+pad.length+bin.length);out.writeUInt32LE(0x46546c67,0);out.writeUInt32LE(2,4);out.writeUInt32LE(out.length,8);out.writeUInt32LE(pad.length,12);out.writeUInt32LE(0x4e4f534a,16);pad.copy(out,20);out.writeUInt32LE(bin.length,20+pad.length);out.writeUInt32LE(0x004e4942,24+pad.length);Buffer.from(bin).copy(out,28+pad.length);return out;}

test('external shared images must be explicitly pinned, and append preserves their definitions and original bytes',async()=>{
 const{bytes,images}=await fixture(false,1,1,true);
 await assert.rejects(decodeDeliveryTramGlb(bytes,new Map()),/Missing manifest-pinned/);
 const first=await appendTramVisualGlb(bytes,tiny,{cell:'cell',coarse:false,externalImages:images}),shift={...tiny,positions:tiny.positions.map((v,i)=>i%3===2?v+1:v)};
 // This second append exercises the external-image decoding branch while
 // proving actual existing-rail ownership and overlap, rather than fetching.
 const next=await appendTramVisualGlb(first,shift,{cell:'cell',coarse:false,externalImages:images}),old=await decodeDeliveryTramGlb(first,images),doc=await decodeDeliveryTramGlb(next,images);
 assert.equal(proveDeliveryTramPreservation(first,next,old,doc,false).originalBinPrefix,true);
 assert.equal(doc.getRoot().listTextures()[0]!.getImage()!.length,images.values().next().value!.length);
 await assert.rejects(appendTramVisualGlb(first,tiny,{cell:'cell',coarse:false,externalImages:images}),/already appended/);
});

test('old Float32 rail footprints retain ownership at a crossing and a masked append passes the actual overlap gate',async()=>{
 const{bytes,images}=await fixture(),g:TramGroundTriangle[]=[[[0,0,-3],[0,0,3],[10,0,3]],[[0,0,-3],[10,0,3],[10,0,-3]]].map((vertices,i)=>({id:String(i),vertices,visual:{node:'cell_ground_asphalt',primitive:0,triangle:i},collision:{collider:'g:cell',triangles:[i]},tag:'road:asphalt'})) as TramGroundTriangle[];
 const track=(id:number,points:[number,number,number][])=>({wayId:id,tags:{railway:'tram'},points:points.map(([nodeId,x,z])=>({nodeId,x,z}))}),bounds={minX:0,maxX:10,minZ:-3,maxZ:3};
 const original=drapeTramFootprints(tramFootprints([track(1,[[1,0,0],[2,10,0]])]),g,bounds),first=await appendTramVisualGlb(bytes,original,{cell:'cell',coarse:false}),old=await decodeDeliveryTramGlb(first,images),mask=existingDeliveryRailMask(old),incoming=tramFootprints([track(2,[[3,5,-3],[4,5,3]])]);
 const raw=drapeTramFootprints(incoming,g,bounds);await assert.rejects(appendTramVisualGlb(first,raw,{cell:'cell',coarse:false}),/overlaps/);
 const clipped=drapeTramFootprints(incoming,g,bounds,false,DEFAULT_TRAM_PROFILE,mask.polygons);assert.ok(clipped.stats.excludedExistingArea!>.04);assert.equal(clipped.coverage!.unresolvedArea,0);
 const next=await appendTramVisualGlb(first,clipped,{cell:'cell',coarse:false}),doc=await decodeDeliveryTramGlb(next,images);assert.equal(proveDeliveryTramPreservation(first,next,old,doc,false).originalDecodedGeometryPrefixes,true);assert.equal(mask.nodes[0],'cell_tram_visuals');
});

test('latest repaired coarse cells need an explicit bounded draw contract and retain every old primitive',async()=>{
 const{bytes,images}=await fixture(true,4,2,true),old=await decodeDeliveryTramGlb(bytes,images);
 await assert.rejects(appendTramVisualGlb(bytes,tiny,{cell:'cell',coarse:true,externalImages:images}),/bounded existing meshes/);
 await assert.rejects(appendTramVisualGlb(bytes,tiny,{cell:'cell',coarse:true,externalImages:images,coarseLimits:{meshes:4,primitivesPerMesh:1}}),/primitive count/);
 const next=await appendTramVisualGlb(bytes,tiny,{cell:'cell',coarse:true,externalImages:images,coarseLimits:{meshes:4,primitivesPerMesh:2}}),doc=await decodeDeliveryTramGlb(next,images),proof=proveDeliveryTramPreservation(bytes,next,old,doc,true);
 assert.equal(proof.coarsePrimitivesGrown,1);assert.equal(doc.getRoot().listMeshes().reduce((n,m)=>n+m.listPrimitives().length,0),8);assert.equal(doc.getRoot().listTextures().length,old.getRoot().listTextures().length);
 await assert.rejects(appendTramVisualGlb(bytes,tiny,{cell:'cell',coarse:true,externalImages:images,coarseLimits:{meshes:33,primitivesPerMesh:2}}),/Invalid coarse rail limits/);
});
