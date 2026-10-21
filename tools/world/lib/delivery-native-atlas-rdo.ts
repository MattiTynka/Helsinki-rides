import assert from 'node:assert/strict';
import {readFacadeGlb} from './facade-glb.ts';
import {packGlb} from './shared-textures.ts';
import {readKtx2Layout,assertSameLevels} from './ktx2-mips.ts';
import {deliverySha} from './delivery-city-payloads.ts';

export function qualifyNativeAtlasDerivative(before:Uint8Array,after:Uint8Array,low:Uint8Array){
  const a=readKtx2Layout(before),b=readKtx2Layout(after);assert.deepEqual([b.width,b.height,b.levelCount,b.supercompression],[a.width,a.height,a.levelCount,a.supercompression],'RDO cannot change resolution, mips or format');assert.equal(a.supercompression,2);assert.deepEqual(Buffer.from(after.subarray(12,20)),Buffer.from(before.subarray(12,20)));assert.deepEqual(Buffer.from(after.subarray(b.dfd[0],b.dfd[0]+b.dfd[1])),Buffer.from(before.subarray(a.dfd[0],a.dfd[0]+a.dfd[1])),'Colour/alpha interpretation cannot change');assertSameLevels(after,low);
  return{beforeSha256:deliverySha(before),afterSha256:deliverySha(after),lowSha256:deliverySha(low),width:a.width,height:a.height,levels:a.levelCount};
}
/** Every old buffer, accessor, material and image property except the pinned
 * external URI stays literal. A protected accepted image is never replaced. */
export function patchNativeAtlasUris(bytes:Uint8Array,mapping:ReadonlyMap<string,string>,protectedHashes:ReadonlySet<string>){
  const raw=readFacadeGlb(bytes),json=structuredClone(raw.json)as any,changes:{index:number;before:string;after:string}[]=[];
  for(const[index,image]of(json.images??[]).entries()){
    if(typeof image.uri!=='string'||!mapping.has(image.uri))continue;
    assert.match(image.uri,/^\.\.\/textures\/[a-f0-9]{64}\.ktx2$/);const digest=image.uri.slice('../textures/'.length,-'.ktx2'.length);assert.ok(!protectedHashes.has(digest),'An immutable accepted texture cannot be re-encoded');const after=mapping.get(image.uri)!;assert.match(after,/^\.\.\/textures\/[a-f0-9]{64}\.ktx2$/);if(after===image.uri)continue;changes.push({index,before:image.uri,after});image.uri=after;
  }
  if(!changes.length)return{bytes:bytes.slice(),changes};const out=packGlb(json,raw.bin),next=readFacadeGlb(out);assert.deepEqual(next.bin,raw.bin);const restored=structuredClone(next.json)as any;for(const change of changes)restored.images[change.index].uri=change.before;assert.deepEqual(restored,raw.json,'Only exact source image URIs may change');return{bytes:out,changes};
}
