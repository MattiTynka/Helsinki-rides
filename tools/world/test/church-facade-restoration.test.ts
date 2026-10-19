import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHURCH_MASTER_HASHES, CHURCH_SOUTH_CHARTS, churchRestoration } from '../lib/church-facade-restoration.ts';
import type { FacadeSourceImage } from '../lib/facade-restoration-types.ts';

type Point=readonly[number,number];
const size=1024;
function fixture(){
  const data=new Uint8Array(size*size*4);for(let i=0;i<data.length;i+=4)data.set([220,220,205,173],i);
  return new Map<number,FacadeSourceImage>([23,24].map(page=>[page,{width:size,height:size,data:data.slice(),pngSha256:CHURCH_MASTER_HASHES.get(page)!}]));
}
function bary(p:Point,t:readonly Point[]):number[]|null{
  const[a,b,c]=t as[Point,Point,Point],d=(b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1]);
  const u=((b[1]-c[1])*(p[0]-c[0])+(c[0]-b[0])*(p[1]-c[1]))/d,v=((c[1]-a[1])*(p[0]-c[0])+(a[0]-c[0])*(p[1]-c[1]))/d;
  return u<0||v<0||u+v>1?null:[u,v,1-u-v];
}
function at(data:Uint8Array,east:number,z:number):number{
  for(const t of CHURCH_SOUTH_CHARTS){const q=bary([east,z],t.world);if(!q)continue;const uv=[0,1].map(k=>q.reduce((s,w,i)=>s+w*t.uv[i]![k]!,0));return data[(Math.floor(uv[1]!*size)*size+Math.floor(uv[0]!*size))*4]!;}
  throw Error('test probe outside south charts');
}
test('church has five nave window axes, one tower-base axis and alternating hood types',()=>{
  const output=new Uint8Array(size*size*4).fill(180);churchRestoration.apply(24,output,size,size,fixture());
  // Reference-observed axes are independently specified here, not prepainted into the donor fixture.
  const axes=[-59.82,-56.27,-52.73,-49.18,-45.63];
  for(const x of[...axes,-64.85])assert.ok(at(output,x,12.0)<130,'dark rectangular window mullions');
  for(const x of[-61.7,-58.05,-54.5,-50.95,-47.4,-43.8])assert.ok(at(output,x,12.0)>200,'plain wall between the five windows');
  for(const i of[0,2,4])assert.ok(at(output,axes[i]!,14.35)<205,'triangular hood face on odd-numbered bays');
  for(const i of[1,3])assert.ok(at(output,axes[i]!,14.35)>210,'circular ornament has an open plaster centre');
});
test('church preserves every other shared chart, upper tower, alpha, source masters and all page23 pixels',()=>{
  const sources=fixture(),sourceBefore=sources.get(23)!.data.slice(),output=new Uint8Array(size*size*4).fill(180),before=output.slice();
  churchRestoration.apply(24,output,size,size,sources);let changed=0,protectedUpper=0;
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const i=(y*size+x)*4;assert.equal(output[i+3],before[i+3]);
    const positions=CHURCH_SOUTH_CHARTS.flatMap(t=>{const q=bary([(x+.5)/size,(y+.5)/size],t.uv);return q?[q.reduce((s,w,j)=>s+w*t.world[j]![1]!,0)]:[];});
    const edited=[0,1,2].some(ch=>output[i+ch]!==before[i+ch]);
    if(edited){assert.ok(positions.some(z=>z<16.55),'change must be below the lower cornice in one of four church triangles');changed++;}
    if(positions.length&&positions.every(z=>z>=16.55)){assert.ok(!edited);protectedUpper++;}
  }
  assert.ok(changed>50000);assert.ok(protectedUpper>5000);assert.deepEqual(sources.get(23)!.data,sourceBefore);
  const page23=before.slice();assert.deepEqual(churchRestoration.apply(23,page23,size,size,sources),[]);assert.deepEqual(page23,before);
});
test('church rejects changed source identity or malformed dimensions before writing',()=>{
  const sources=fixture(),output=new Uint8Array(size*size*4).fill(180),before=output.slice();
  sources.set(23,{...sources.get(23)!,pngSha256:'changed'});assert.throws(()=>churchRestoration.apply(24,output,size,size,sources),/master page23 changed/);assert.deepEqual(output,before);
  const valid=fixture();valid.set(24,{...valid.get(24)!,height:512});assert.throws(()=>churchRestoration.apply(24,output,size,size,valid),/dimensions invalid/);assert.deepEqual(output,before);
});
