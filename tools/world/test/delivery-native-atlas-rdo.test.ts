import {test} from 'node:test';
import assert from 'node:assert/strict';
import {encodeToKTX2} from 'ktx2-encoder';
import {packGlb} from '../lib/shared-textures.ts';
import {readFacadeGlb} from '../lib/facade-glb.ts';
import {dropTopMip} from '../lib/ktx2-mips.ts';
import {qualifyNativeAtlasDerivative,patchNativeAtlasUris} from '../lib/delivery-native-atlas-rdo.ts';

test('only an explicitly selected source URI changes; accepted shared-image aliases and other geometry are protected',()=>{
  const a='a'.repeat(64),b='b'.repeat(64),c='c'.repeat(64),uri=(s:string)=>`../textures/${s}.ktx2`,json={asset:{version:'2.0'},buffers:[{byteLength:4}],images:[{uri:uri(a),mimeType:'image/ktx2',name:'new native'},{uri:uri(b),mimeType:'image/ktx2',name:'other'}],nodes:[{name:'geometry',extras:{sourceKey:'literal'}}],extras:{nativeSource:'unchanged'}},source=packGlb(json,new Uint8Array([1,2,3,4])),result=patchNativeAtlasUris(source,new Map([[uri(a),uri(c)]]),new Set([b]));assert.equal(result.changes.length,1);const next=readFacadeGlb(result.bytes);assert.equal((next.json.images![0]as any).uri,uri(c));assert.deepEqual(next.json.nodes,json.nodes);assert.deepEqual(Array.from(next.bin),[1,2,3,4]);assert.equal((next.json.images![1]as any).uri,uri(b));assert.throws(()=>patchNativeAtlasUris(source,new Map([[uri(b),uri(c)]]),new Set([b])),/immutable accepted/);assert.deepEqual(patchNativeAtlasUris(source,new Map([[uri(c),uri(a)]]),new Set()).bytes,source);
});
test('actual UASTC RDO retains colour interpretation, dimensions and every final Low mip byte; changed resolution and corrupt tails fail',async()=>{
  const image={width:64,height:64,data:Uint8Array.from({length:64*64*4},(_,i)=>i%4===3?255:(i*19+Math.floor(i/29)*37)%256)},options={isUASTC:true,generateMipmap:true,isPerceptual:true,isSetKTX2SRGBTransferFunc:true,needSupercompression:true,qualityLevel:160,compressionLevel:2,uastcLDRQualityLevel:1,imageDecoder:async()=>image};
  const before=await encodeToKTX2(image.data,options),after=await encodeToKTX2(image.data,{...options,enableRDO:true,rdoQualityLevel:2});
  const low=dropTopMip(after),q=qualifyNativeAtlasDerivative(before,after,low);assert.deepEqual([q.width,q.height],[64,64]);const corrupt=low.slice();corrupt[corrupt.length-1]=corrupt[corrupt.length-1]!^1;assert.throws(()=>qualifyNativeAtlasDerivative(before,after,corrupt));assert.throws(()=>qualifyNativeAtlasDerivative(before,low,dropTopMip(low)),/resolution/);const colour=after.slice(),view=new DataView(colour.buffer,colour.byteOffset,colour.byteLength),dfd=view.getUint32(48,true);colour[dfd+14]=colour[dfd+14]!^1;assert.throws(()=>qualifyNativeAtlasDerivative(before,colour,low),/interpretation/);
});
