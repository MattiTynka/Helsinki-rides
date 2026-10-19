import {test} from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {TRAM_STRIPE,tramStripePng,tramStripeResidentBytes} from '../lib/tram-texture.ts';
test('original stripe encodes exact44x4 opaque bands and the measuring face sits on its documented boundary',async()=>{
 const{data,info}=await sharp(await tramStripePng()).raw().toBuffer({resolveWithObject:true});assert.equal(info.width,44);assert.equal(info.height,4);assert.equal(info.channels,4);
 for(let y=0;y<4;y++)for(let x=0;x<44;x++){const expected=x<6?[126,128,130,255]:x<20?[55,49,43,255]:[188,191,193,255];assert.deepEqual([...data.subarray((y*44+x)*4,(y*44+x+1)*4)],expected);}
 assert.equal(TRAM_STRIPE.measuringFaceU,20/44);assert.equal(tramStripeResidentBytes(),956);assert.equal(TRAM_STRIPE.license,'CC0-1.0');
});
