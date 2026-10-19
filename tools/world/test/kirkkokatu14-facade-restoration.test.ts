import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KIRKKOKATU14_FACES, KIRKKOKATU14_SOURCES, kirkkokatu14Restoration } from '../lib/kirkkokatu14-facade-restoration.ts';

const size = 1024;
type P = readonly [number, number];
function weights(p: P, a: P, b: P, c: P): readonly [number, number, number] | null {
  const det=(b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1]);
  const u=((b[1]-c[1])*(p[0]-c[0])+(c[0]-b[0])*(p[1]-c[1]))/det, v=((c[1]-a[1])*(p[0]-c[0])+(a[0]-c[0])*(p[1]-c[1]))/det;
  return Math.min(u,v,1-u-v)>=-1e-8?[u,v,1-u-v]:null;
}
function pixelAt(e: number, h: number, faceId = 0): readonly [number, number] {
  const face=KIRKKOKATU14_FACES.find(f=>f.id===faceId)!;
  for(const tri of face.triangles){const w=weights([e,h],...tri.map(v=>[v[0],v[1]]as P)as[P,P,P]);if(!w)continue;return[face.page,(Math.floor(w.reduce((s,q,i)=>s+q*tri[i]![3],0)*size)*size+Math.floor(w.reduce((s,q,i)=>s+q*tri[i]![2],0)*size))*4];}
  throw Error('fixture point outside source chart');
}
function fixture(){
  const sources=new Map<number,{width:number;height:number;data:Uint8Array;pngSha256:string}>(KIRKKOKATU14_SOURCES.map(identity=>{const data=new Uint8Array(size*size*4);for(let i=0;i<data.length;i+=4)data.set([90,100,110,173],i);return[identity.page,{width:size,height:size,data,pngSha256:identity.sha256}];}));
  // Finite native pane interior: no pre-existing mullions may be mistaken for authored ground classes.
  for(let e=100.73;e<101.10;e+=.015)for(let h=7.98;h<8.50;h+=.015){const[page,index]=pixelAt(e,h);sources.get(page as 59)!.data.set([12,24,36,173],index);}
  return sources;
}
function output(sources: ReturnType<typeof fixture>){return new Map([...sources].map(([page,source])=>{const data=source.data.slice();kirkkokatu14Restoration.apply(page,data,size,size,sources);return[page,data];}));}
function read(images: Map<number,Uint8Array>,e:number,h:number,face=0){const[page,index]=pixelAt(e,h,face);return[...images.get(page)!.subarray(index,index+4)];}

test('Kirkkokatu14 keeps the asymmetric wide-east and paired-west ground classes and a pointed gated portal',()=>{
  const sources=fixture(),images=output(sources);
  for(const axis of [116.30,121.72])assert.ok(read(images,axis+.17,3.8)[1]!<55,'east wide ground glass missing');
  for(const axis of [101.47,106.08]){
    for(const d of [-.48,.48])assert.ok(read(images,axis+d+.08,3.8)[1]!<55,'west paired glass missing');
    assert.ok(read(images,axis,3.8)[1]!>70,'a pair must retain its central masonry pier');
  }
  assert.ok(read(images,111.38,3.8)[0]!<20,'the portal is an opaque dark gate/recess, not an ordinary window');
  assert.ok(read(images,111.38,5.15)[0]!<20,'pointed portal apex missing');
  assert.ok(read(images,112.80,5.15)[0]!>45,'portal shoulders must close rather than create a rectangular opening');
  assert.ok(read(images,116.47,2.05)[1]!>65,'wide east windows do not extend into the lower stone base');
  assert.ok(read(images,101.47-.48+.08,2.05)[1]!<55,'west narrow windows have their observed taller profile');
});

test('literal clear upper walls/balcony/roof and alpha remain untouched across every shared page',()=>{
  const sources=fixture(),images=output(sources);
  for(const face of KIRKKOKATU14_FACES){const e=(face.minE+face.maxE)/2;const[page,index]=pixelAt(e,17.0,face.id);assert.deepEqual([...images.get(page)!.subarray(index,index+4)],[...sources.get(page as 59)!.data.subarray(index,index+4)]);}
  for(const[page,data]of images)for(let i=3;i<data.length;i+=4)assert.equal(data[i],173,`alpha changed on page${page}`);
  for(const point of [[111.38,13.4],[111.38,19],[118,11.0],[101.47,10.8]]as const){const[page,index]=pixelAt(point[0],point[1]);assert.deepEqual([...images.get(page)!.subarray(index,index+4)],[...sources.get(page as 59)!.data.subarray(index,index+4)]);}
});

test('every modified texel belongs to a source-bound street triangle; unrelated shared charts remain exact',()=>{
  const sources=fixture(),images=output(sources);let changes=0;
  for(const[page,data]of images){const original=sources.get(page as 59)!.data,mask=new Uint8Array(size*size);
    for(const face of KIRKKOKATU14_FACES.filter(f=>f.page===page))for(const tri of face.triangles){const p=tri.map(v=>[v[2],v[3]]as P)as[P,P,P];for(let y=Math.max(0,Math.floor(Math.min(...p.map(v=>v[1]))*size));y<=Math.min(size-1,Math.ceil(Math.max(...p.map(v=>v[1]))*size));y++)for(let x=Math.max(0,Math.floor(Math.min(...p.map(v=>v[0]))*size));x<=Math.min(size-1,Math.ceil(Math.max(...p.map(v=>v[0]))*size));x++)if(weights([(x+.5)/size,(y+.5)/size],...p))mask[y*size+x]=1;}
    for(let i=0;i<data.length;i+=4)if(data[i]!==original[i]||data[i+1]!==original[i+1]||data[i+2]!==original[i+2]){changes++;assert.equal(mask[i/4],1,`outside street charts page${page} texel${i/4}`);}
  }
  assert.ok(changes>30000);
});

test('source identity/dimensions fail before writing and irrelevant pages are no-ops',()=>{
  const sources=fixture(),source=sources.get(60)!,data=source.data.slice(),before=data.slice();
  assert.deepEqual(kirkkokatu14Restoration.apply(58,data,size,size,new Map()),[]);
  assert.throws(()=>kirkkokatu14Restoration.apply(60,data,size,size,new Map([...sources].map(([page,im])=>[page,page===59?{...im,pngSha256:'unknown'}:im]))),/master changed/);
  assert.throws(()=>kirkkokatu14Restoration.apply(60,data,size,size,new Map([...sources].map(([page,im])=>[page,page===60?{...im,height:512}:im]))),/dimensions invalid/);
  assert.deepEqual(data,before);
  assert.deepEqual(source.data,before,'native donors must never be changed by a target apply');
});
