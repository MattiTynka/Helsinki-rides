// Original procedural artwork; CC0-1.0. No map, photograph or reference pixels.
import sharp from 'sharp';
export const TRAM_STRIPE={width:44,height:4,guardPixels:6,groovePixels:14,headPixels:24,measuringFaceU:20/44,license:'CC0-1.0'} as const;
export function tramStripeResidentBytes(){let width:number=TRAM_STRIPE.width,height:number=TRAM_STRIPE.height,bytes=0;for(;;){bytes+=width*height*4;if(width===1&&height===1)return bytes;width=Math.max(1,Math.floor(width/2));height=Math.max(1,Math.floor(height/2));}}
let cached:Promise<Buffer>|undefined;
export function tramStripePng():Promise<Buffer>{
  return cached??=(()=>{
    const rgba=Buffer.alloc(TRAM_STRIPE.width*TRAM_STRIPE.height*4);
    for(let y=0;y<TRAM_STRIPE.height;y++)for(let x=0;x<TRAM_STRIPE.width;x++){
      const colour=x<TRAM_STRIPE.guardPixels?[126,128,130]:x<TRAM_STRIPE.guardPixels+TRAM_STRIPE.groovePixels?[55,49,43]:[188,191,193];
      rgba.set([...colour,255],(y*TRAM_STRIPE.width+x)*4);
    }
    return sharp(rgba,{raw:{width:TRAM_STRIPE.width,height:TRAM_STRIPE.height,channels:4}}).png({compressionLevel:9}).toBuffer();
  })();
}
