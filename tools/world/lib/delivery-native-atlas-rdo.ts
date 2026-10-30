import assert from 'node:assert/strict';
import {readFacadeGlb} from './facade-glb.ts';
import {packGlb} from './shared-textures.ts';
import {readKtx2Layout,assertSameLevels} from './ktx2-mips.ts';
import {deliverySha} from './delivery-city-payloads.ts';

/** Check every declared material, including variant/unselected-scene materials. A shared
 * selected image may never acquire a normal-map, alpha-mask or blend use through an alias. */
export function assertOpaqueNativeAtlasImageUses(bytes:Uint8Array,selectedUris:ReadonlySet<string>){
  const json=readFacadeGlb(bytes).json as any,selectedImages=new Set<number>();
  for(const[index,image]of(json.images??[]).entries())if(selectedUris.has(image.uri))selectedImages.add(index);
  if(!selectedImages.size)return 0;
  const selectedTextures=new Set<number>();
  for(const[index,texture]of(json.textures??[]).entries()){
    const sources=[texture.source,...Object.values(texture.extensions??{}).map((value:any)=>value.source)];
    if(sources.some(source=>selectedImages.has(source)))selectedTextures.add(index);
  }
  let uses=0;
  const inspect=(value:any,slot:string,material:any)=>{
    if(!value||typeof value!=='object')return;
    for(const[key,child]of Object.entries(value)){
      const here=slot?`${slot}.${key}`:key;
      if(child&&typeof child==='object'&&/texture$/i.test(key)&&selectedTextures.has((child as any).index)){
        assert.equal(here,'pbrMetallicRoughness.baseColorTexture','Native RDO selected image has non-albedo use');
        assert.equal(material.alphaMode??'OPAQUE','OPAQUE','Native RDO selected image must be opaque');
        assert.ok(Object.keys(material.extensions??{}).every(extension=>extension==='KHR_materials_unlit'),'Native RDO selected material has unqualified extensions');uses++;
      }else inspect(child,here,material);
    }
  };
  for(const material of json.materials??[])inspect(material,'',material);
  assert.ok(uses>0,'Selected native RDO image has no qualified material use');return uses;
}

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
