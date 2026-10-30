import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {renderBulevardi46Svg} from '../author_bulevardi46_facade.ts';
import {createBulevardi46Restoration,BULEVARDI46_MASTER_PNG_SHA256,BULEVARDI46_ART_SHA256} from '../lib/bulevardi46-facade-restoration.ts';

test('reference-led artwork retains fifteen axes, thirty upper windows and three unique entrances',()=>{
  const svg=renderBulevardi46Svg();
  assert.equal([...svg.matchAll(/id="bay-\d+"/g)].length,15);
  assert.equal([...svg.matchAll(/id="top-\d+-[ab]"/g)].length,30);
  assert.deepEqual([...svg.matchAll(/data-entrance-axis="(\d+)"/g)].map(m=>Number(m[1])),[1,7,9]);
  assert.equal([...svg.matchAll(/id="basement-\d+"/g)].length,12);
});
test('source-bound repair preserves every alpha and every pixel outside the original front quad',async()=>{
  const module=createBulevardi46Restoration(109),input=module.externalSources![0]!,bytes=fs.readFileSync(input.file);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),BULEVARDI46_ART_SHA256);
  const decoded=await sharp(bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const art={width:decoded.info.width,height:decoded.info.height,data:decoded.data,sha256:BULEVARDI46_ART_SHA256};
  const sources=new Map([[109,{width:1024,height:1024,data:new Uint8Array(),pngSha256:BULEVARDI46_MASTER_PNG_SHA256}]]);
  const external=new Map([[input.id,art]]),w=192,h=160,rgba=new Uint8Array(w*h*4);
  for(let i=0;i<rgba.length;i++)rgba[i]=(i*37)%256;
  const before=rgba.slice(),proof=module.apply(109,rgba,w,h,sources,external);
  assert.ok(proof[0]!.changedTexels>1000);
  // Independent convex-quad half-plane containment; not the repair's triangle interpolation.
  const quad=[[.05939701199531555,.6801159381866455],[.08692052215337753,.9867411255836487],[.9977792501449585,.44385480880737305],[.9771727323532104,.13762277364730835]];
  const inside=(x:number,y:number)=>{
    const signs=quad.map((a,i)=>{const b=quad[(i+1)%4]!;return (b[0]!-a[0]!)*(y-a[1]!)-(b[1]!-a[1]!)*(x-a[0]!);});
    return signs.every(n=>n<=0)||signs.every(n=>n>=0);
  };
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const offset=(y*w+x)*4;assert.equal(rgba[offset+3],before[offset+3]);
    if(!inside((x+.5)/w,(y+.5)/h))assert.deepEqual(rgba.subarray(offset,offset+4),before.subarray(offset,offset+4));
  }
  const unaffected=before.slice();assert.deepEqual(module.apply(108,unaffected,w,h,sources,external),[]);assert.deepEqual(unaffected,before);
  const wrong=before.slice();
  assert.throws(()=>module.apply(109,wrong,w,h,new Map([[109,{...sources.get(109)!,pngSha256:'0'.repeat(64)}]]),external),/master/);
  assert.deepEqual(wrong,before);
  assert.throws(()=>module.apply(109,wrong,w,h,sources,new Map([[input.id,{...art,sha256:'0'.repeat(64)}]])),/artwork/);
  assert.deepEqual(wrong,before);
});
