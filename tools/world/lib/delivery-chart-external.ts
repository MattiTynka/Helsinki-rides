import assert from 'node:assert/strict';
import {readFacadeGlb} from './facade-glb.ts';
import {externalizeCellImages,packGlb} from './shared-textures.ts';
import {reduceNewCityImage} from './delivery-city-payloads.ts';
import {readKtx2Layout} from './ktx2-mips.ts';

/** Externalize exactly the newly appended atlas, removing only its new byte range.
 * Frozen BIN bytes and all old descriptor indices remain literal. This avoids
 * retaining a duplicate embedded atlas and avoids re-optimizing old geometry. */
export function externalizeAppendedFacadeChart(before:Uint8Array,after:Uint8Array){
 const old=readFacadeGlb(before),raw=readFacadeGlb(after),json=structuredClone(raw.json) as any;
 assert.deepEqual(raw.bin.subarray(0,old.bin.length),old.bin,'Original BIN prefix changed');
 assert.equal(json.images.length,(old.json.images?.length??0)+1,'Exactly one new chart image required');
 for(const name of ['bufferViews','accessors','images','textures','samplers','materials'])assert.deepEqual(json[name]?.slice(0,(old.json as any)[name]?.length??0)??[],(old.json as any)[name]??[],`Old ${name} changed`);
 const image=json.images.at(-1),viewId=image.bufferView,view=json.bufferViews[viewId];assert.equal(viewId,old.json.bufferViews.length,'New chart image must precede new geometry views');assert.equal(view.buffer,0);assert.ok(!view.extensions&&image.mimeType==='image/ktx2');
 const start=view.byteOffset??0,end=start+Math.ceil(view.byteLength/4)*4;assert.ok(start>=old.bin.length&&end<=raw.bin.length,'New chart image overlaps frozen geometry');
 const external=externalizeCellImages(after);assert.equal(external.images.length,1,'Existing images must already be external');const reduced=reduceNewCityImage(external.images[0]!);assert.equal(reduced.standard.sha256,external.images[0]!.sha256,'Dedicated chart Standard must retain its encoded top mip');
 const layout=readKtx2Layout(reduced.standard.bytes);assert.equal(layout.width,1024);assert.equal(layout.height,512);assert.ok(reduced.low);const low=readKtx2Layout(reduced.low.bytes);assert.equal(low.width,512);assert.equal(low.height,256);
 const result=readFacadeGlb(external.bytes).json as any;result.images.at(-1).uri='../'+reduced.standard.path;
 result.bufferViews.splice(viewId,1);
 const shift=(offset:number)=>{assert.ok(offset<start||offset>=end,'Non-image data overlaps appended chart');return offset>=end?offset-(end-start):offset;};
 for(const v of result.bufferViews.slice(old.json.bufferViews.length)){if(v.buffer===0)v.byteOffset=shift(v.byteOffset??0);const c=v.extensions?.EXT_meshopt_compression;if(c?.buffer===0)c.byteOffset=shift(c.byteOffset??0);}
 for(const a of result.accessors){if(a.bufferView!==undefined){assert.notEqual(a.bufferView,viewId);if(a.bufferView>viewId)a.bufferView--; }assert.equal(a.sparse,undefined,'Sparse charts are not supported');}
 for(const im of result.images)assert.equal(im.bufferView,undefined);
 result.buffers[0].byteLength=raw.bin.length-(end-start);const bin=Buffer.concat([raw.bin.subarray(0,start),raw.bin.subarray(end)]),bytes=packGlb(result,bin),final=readFacadeGlb(bytes);
 assert.deepEqual(final.bin.subarray(0,old.bin.length),old.bin);assert.deepEqual(final.json.bufferViews.slice(0,old.json.bufferViews.length),old.json.bufferViews);assert.deepEqual((final.json as any).accessors.slice(0,(old.json as any).accessors.length),(old.json as any).accessors);
 return{bytes,standard:reduced.standard,low:reduced.low,mip:reduced.mip,removedDuplicateBytes:end-start};
}
