import assert from 'node:assert/strict';
import test from 'node:test';
import {OriginalWallArt} from '../author_senate_facade_charts.ts';
import {readObservedWallFinish,renderObservedWallFinish,observedFinishFaceGroups,observedFinishAtlasLayout} from '../lib/delivery-new-area-facades-observed-finish.ts';
import sharp from'sharp';
test('An observed finish cannot silently introduce floors, openings or executable markup',()=>{
  assert.throws(()=>readObservedWallFinish({kind:'plain',colour:'#aaaaaa',windows:8}));
  assert.throws(()=>readObservedWallFinish({kind:'plain',colour:'#aaaaaa" onload="alert(1)'}));
  assert.throws(()=>readObservedWallFinish({kind:'brick',colour:'#aa7766',mortarColour:'#998877',moduleWidth:0,moduleHeight:.08}));
  const plain=new OriginalWallArt(9,13,30);renderObservedWallFinish(plain,{kind:'plain',colour:'#aa7766'});assert.equal(plain.pieces.length,1);assert.doesNotMatch(plain.pieces.join(''),/window|door|floor|passage/);
  const brick=new OriginalWallArt(9,13,30);renderObservedWallFinish(brick,{kind:'brick',colour:'#aa7766',mortarColour:'#998877',moduleWidth:.32,moduleHeight:.13});assert.doesNotMatch(brick.pieces.join(''),/NaN|Infinity|window|door|floor|passage|href/);assert.ok(brick.pieces.length>100);
});
test('Independent bay-return planes cannot become an ambiguous selector union',()=>{
  const planes=[{id:'left',faces:[{part:0,triangle:1}]},{id:'right',faces:[{part:0,triangle:2}]}],plain={kind:'plain' as const,colour:'#bb765f'};
  assert.deepEqual(observedFinishFaceGroups({planes},plain),planes);
  assert.throws(()=>observedFinishFaceGroups({faces:planes[0]!.faces,planes},plain),/Exactly one/);
  assert.throws(()=>observedFinishFaceGroups({planes:[planes[0],{...planes[1],faces:planes[0]!.faces}]},plain),/Repeated native face/);
  assert.deepEqual(observedFinishFaceGroups({planes},{kind:'brick',colour:'#bb765f',mortarColour:'#988877',moduleWidth:.32,moduleHeight:.14}),planes);
});
test('Different width brick returns keep physical module scale in separate bounded charts',async()=>{
 const planes=[{id:'broad',width:9,height:20},{id:'narrow',width:1.8,height:20},{id:'short',width:3,height:8},{id:'lip',width:.42,height:20}],finish={kind:'brick' as const,colour:'#ffffff',mortarColour:'#000000',moduleWidth:.5,moduleHeight:.2},layout=observedFinishAtlasLayout(planes,finish);assert.equal(layout.size,1024);assert.equal(layout.sharedPlainTile,false);
 const pieces=planes.map((p,i)=>{const wall=new OriginalWallArt(p.width,0,p.height);renderObservedWallFinish(wall,finish);return wall.svg(layout.pixels[i]!);}),svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024"><rect width="100%" height="100%" fill="#ffffff"/>${pieces.join('')}</svg>`,{data}=await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({resolveWithObject:true});
 const regions=layout.pixels;for(let i=0;i<regions.length;i++){const[x,y,w,h]=regions[i]!,p=planes[i]!;assert.ok(x>=8&&y>=8&&x+w<=1016&&y+h<=1016);for(let j=0;j<i;j++){const[q,r,s,t]=regions[j]!;assert.ok(x>=q+s+8||q>=x+w+8||y>=r+t+8||r>=y+h+8,'Independent physical charts require gutters');}for(const alpha of data.filter((_,i)=>i%4===3))assert.equal(alpha,255);if(p.width<1)continue;
  const sample=(u:number)=>{const px=Math.round(x+u/p.width*w),py=Math.floor(y+(1-.05/p.height)*h);return Math.min(...[-1,0,1].map(dx=>data[(py*1024+px+dx)*4]!));};assert.ok(sample(.5)<sample(.25)-20,'Mortar module must occur at the same physical .5m on differently sized walls');}
 const mono=observedFinishAtlasLayout([planes[0]!],finish);assert.deepEqual(mono.pixels,[[2,2,508,508]]);assert.equal(mono.size,512);const plain=observedFinishAtlasLayout(planes,{kind:'plain',colour:'#ffffff'});assert.equal(plain.size,512);assert.ok(plain.pixels.every(p=>p.join(',')==='2,2,508,508'));
});
