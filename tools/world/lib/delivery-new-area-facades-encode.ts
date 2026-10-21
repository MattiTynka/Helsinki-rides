import assert from 'node:assert/strict';
import {encodeKtx2,type RgbaImage} from './gltf.ts';
export type NativeFacadeRdoQuality=0|1;
export function nativeFacadeEncoderRecipe(quality:NativeFacadeRdoQuality=0) {
  assert.ok(quality===0||quality===1,'Only the measured immutable facade recipes are supported');
  return{id:quality?'uastc-facade-rdo-q1-v1':'uastc-facade-legacy-q0-v1',rdoQuality:quality,sameSourceRgbaAndDimensions:true,topMipDrops:0};
}
/** Optional new-atlas recipe only. Legacy game/world encoders are unchanged. */
export async function encodeNativeFacadeAtlas(image:RgbaImage,quality:NativeFacadeRdoQuality=0):Promise<Uint8Array> {
  nativeFacadeEncoderRecipe(quality);if(quality===0)return encodeKtx2(image,'facade');
  assert.equal(image.data.length,image.width*image.height*4);const{encodeToKTX2}=await import('ktx2-encoder'),write=process.stdout.write.bind(process.stdout);
  process.stdout.write=(()=>true)as typeof process.stdout.write;
  try{return await encodeToKTX2(image.data,{isUASTC:true,generateMipmap:true,isPerceptual:true,isSetKTX2SRGBTransferFunc:true,needSupercompression:true,qualityLevel:160,compressionLevel:2,uastcLDRQualityLevel:1,enableRDO:true,rdoQualityLevel:1,imageDecoder:async()=>({width:image.width,height:image.height,data:image.data})});}
  finally{process.stdout.write=write;}
}
