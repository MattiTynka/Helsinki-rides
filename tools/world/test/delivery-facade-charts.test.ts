import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {GlbBuilder,flatNormals} from '../lib/gltf.ts';
import {readFacadeGlb} from '../lib/facade-glb.ts';
import {facadeChartSha256 as sha,facadeTriangleKey,type FacadeChart,type FacadeTriangle} from '../lib/facade-charts.ts';
import {applyFacadeChartsToGlb,readFacadeChartTriangles} from '../lib/facade-chart-glb.ts';
import {deliveryFacadeImages,rebindDeliveryFacadeFaces} from '../apply_delivery_facade_charts.ts';

const A:FacadeTriangle=[[0,0,0],[2,0,0],[2,2,0]],B:FacadeTriangle=[[0,0,0],[2,2,0],[0,2,0]],C:FacadeTriangle=[[3,0,0],[4,0,0],[4,2,0]];
const chart:FacadeChart={id:'front',building:'original',origin:[0,0,0],uAxis:[1,0,0],vAxis:[0,1,0],bounds:[0,0,2,2],pixels:[1,1,14,14],planeToleranceMetres:.001};
const align=(n:number)=>(n+3)&~3;
function encode(json:any,bin:Uint8Array){
  const text=Buffer.from(JSON.stringify(json)),j=Buffer.alloc(align(text.length),32);text.copy(j);const out=Buffer.alloc(28+j.length+align(bin.length));
  out.writeUInt32LE(0x46546c67,0);out.writeUInt32LE(2,4);out.writeUInt32LE(out.length,8);out.writeUInt32LE(j.length,12);out.writeUInt32LE(0x4e4f534a,16);j.copy(out,20);out.writeUInt32LE(align(bin.length),20+j.length);out.writeUInt32LE(0x004e4942,24+j.length);out.set(bin,28+j.length);return out;
}
async function fixture(){
  const b=new GlbBuilder('delivery'),P=Float32Array.from([...A.flat(),...B.flat(),...C.flat()]),I=Uint32Array.from({length:9},(_,i)=>i);
  await b.addMesh({name:'facades',positions:P,indices:I,normals:flatNormals(P,I),uvs:new Float32Array(18).fill(.5),materialName:'old'},
    {name:'old',textureKind:'facade',texture:{width:8,height:8,data:new Uint8Array(8*8*4).fill(255)},unlit:true});
  const original=readFacadeGlb(await b.toGlb('fixture',{},'exact')),json=structuredClone(original.json) as any,image=json.images[0],view=json.bufferViews[image.bufferView],payload=original.bin.slice(view.byteOffset,view.byteOffset+view.byteLength);
  const relative=`textures/${sha(payload)}.ktx2`,uri='../'+relative;delete image.bufferView;image.uri=uri;
  const bytes=encode(json,original.bin);return {bytes,payload,uri,relative,ref:{path:'cells/frozen.glb',bytes:bytes.length,sha256:sha(bytes)},imageRef:{path:relative,bytes:payload.length,sha256:sha(payload)}};
}

test('external delivery charts resolve only pinned local images and preserve every existing external descriptor and BIN byte',async()=>{
  const f=await fixture(),root=mkdtempSync(path.join(os.tmpdir(),'delivery-facade-'));
  try{
    mkdirSync(path.join(root,'textures'));writeFileSync(path.join(root,f.relative),f.payload);
    const images=deliveryFacadeImages(root,f.ref,f.bytes,[f.imageRef]),faces=[A,B].map(t=>({key:facadeTriangleKey(t),chart:'front'}));
    const targets=await rebindDeliveryFacadeFaces(f.bytes,images,faces,[chart]);assert.equal(targets.length,2);
    const art=await sharp({create:{width:16,height:16,channels:4,background:'#e4cb9c'}}).png().toBuffer();
    const result=await applyFacadeChartsToGlb(f.bytes,{expectedSha256:sha(f.bytes),charts:[chart],targets,externalImages:images,
      atlas:{name:'original-art',image:art,mimeType:'image/png',width:16,height:16},maximumFallbackBytes:4096,material:{name:'art',unlit:true,roughness:.9,doubleSided:true},extras:{license:'CC0-1.0'}});
    const old=readFacadeGlb(f.bytes),next=readFacadeGlb(result.bytes);assert.deepEqual(next.bin.subarray(0,old.bin.length),old.bin);assert.deepEqual(next.json.images![0],old.json.images![0]);
    const before=await readFacadeChartTriangles(f.bytes,images),after=await readFacadeChartTriangles(result.bytes,images);assert.deepEqual(after.map(t=>t.key).sort(),before.map(t=>t.key).sort());
    assert.throws(()=>deliveryFacadeImages(root,f.ref,f.bytes,[]),/manifest owner/);
    writeFileSync(path.join(root,f.relative),Buffer.from('corrupt'));assert.throws(()=>deliveryFacadeImages(root,f.ref,f.bytes,[f.imageRef]),/size changed/);
    await assert.rejects(rebindDeliveryFacadeFaces(f.bytes,new Map(),faces,[chart]),/Missing pinned external image/);
  }finally{rmSync(root,{recursive:true,force:true});}
});
test('delivery face rebinding rejects absent source faces, reversed winding, duplicate selectors and remote image URIs',async()=>{
  const f=await fixture(),images=new Map([[f.uri,f.payload]]),faces=[{key:facadeTriangleKey(A),chart:'front'}];
  await assert.rejects(rebindDeliveryFacadeFaces(f.bytes,images,[...faces,...faces],[chart]),/Duplicate source face/);
  await assert.rejects(rebindDeliveryFacadeFaces(f.bytes,images,[{key:facadeTriangleKey([A[0],A[2],A[1]]),chart:'front'}],[chart]),/absent or changed/);
  const old=readFacadeGlb(f.bytes),json=structuredClone(old.json) as any;json.images[0].uri='https://example.com/untrusted.ktx2';
  assert.throws(()=>deliveryFacadeImages('.',f.ref,encode(json,old.bin),[]),/local payload/);
});
