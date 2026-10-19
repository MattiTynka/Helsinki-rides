import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RAUHANKATU19_MASTER_SHA256, RAUHANKATU19_WEST, rauhankatu19Restoration } from '../lib/rauhankatu19-facade-restoration.ts';
type Point = readonly [number,number];
function worldUv(n:number,z:number):number[] {
  for(const t of RAUHANKATU19_WEST){const[a,b,c]=t.world,d=(b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1]),u=((b[1]-c[1])*(n-c[0])+(c[0]-b[0])*(z-c[1]))/d,v=((c[1]-a[1])*(n-c[0])+(a[0]-c[0])*(z-c[1]))/d;
    if(u<0||v<0||u+v>1)continue;return[0,1].map(k=>u*t.uv[0][k]!+v*t.uv[1][k]!+(1-u-v)*t.uv[2][k]!);
  }throw Error('test sample outside actual west chart');
}
const size=1024;
function fixture(){const data=new Uint8Array(size*size*4);for(let i=0;i<data.length;i+=4)data.set([200,200,200,173],i);
  // One independent clear source glass rectangle and bright pier stone, not12 prepainted output windows.
  for(let n=242.98;n<244.43;n+=.015)for(let z=10.70;z<14.91;z+=.015){const uv=worldUv(n,z),i=(Math.floor(uv[1]!*size)*size+Math.floor(uv[0]!*size))*4;data.set([40,45,50,173],i);}
  return{width:size,height:size,data,pngSha256:RAUHANKATU19_MASTER_SHA256};
}
const at=(data:Uint8Array,n:number,z:number)=>{const uv=worldUv(n,z),i=(Math.floor(uv[1]!*size)*size+Math.floor(uv[0]!*size))*4;return data[i]!;};
test('Rauhankatu19 produces12 aligned tall and basement axes rather than equal-height east rows',()=>{
  const source=fixture(),output=new Uint8Array(size*size*4).fill(180);rauhankatu19Restoration.apply(5,output,size,size,new Map([[5,source]]));
  const axis=(z:number)=>{let previous=false,count=0;for(let n=231.96;n<257.59;n+=.012){const dark=at(output,n,z)<100;if(dark&&!previous)count++;previous=dark;}return count;};
  assert.equal(axis(14),12);assert.equal(axis(10),12);assert.equal(axis(7),12);
  for(let bay=0;bay<12;bay++){const n=231.94101+(bay+.5)*(257.61599-231.94101)/12;assert.ok(at(output,n,14)<100);assert.ok(at(output,n,10)<100);assert.ok(at(output,n,7)<100);assert.ok(at(output,n,8.5)>150,'continuous stone band between tall hall and basement');}
});
function inside(tri:readonly Point[],x:number,y:number){const s=tri.map((a,i)=>{const b=tri[(i+1)%3]!;return(b[0]-a[0])*(y-a[1])-(b[1]-a[1])*(x-a[0]);});return s.every(v=>v>=-1e-8)||s.every(v=>v<=1e-8);}
test('Rauhankatu19 preserves other wall charts, alpha and immutable source; South entrance page is a no-op',()=>{
  const source=fixture(),sourceBefore=source.data.slice(),output=new Uint8Array(size*size*4).fill(180),before=output.slice();rauhankatu19Restoration.apply(5,output,size,size,new Map([[5,source]]));let changed=0;
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){const i=(y*size+x)*4;assert.equal(output[i+3],before[i+3]);if([0,1,2].every(ch=>output[i+ch]===before[i+ch]))continue;assert.ok(RAUHANKATU19_WEST.some(t=>inside(t.uv,(x+.5)/size,(y+.5)/size)));changed++;}
  assert.ok(changed>50000);assert.deepEqual(source.data,sourceBefore);
  const south=before.slice();assert.deepEqual(rauhankatu19Restoration.apply(6,south,size,size,new Map()),[]);assert.deepEqual(south,before);
});
test('Rauhankatu19 rejects changed source identity and malformed dimensions before writes',()=>{
  const source=fixture(),output=new Uint8Array(size*size*4).fill(180),before=output.slice();
  assert.throws(()=>rauhankatu19Restoration.apply(5,output,size,size,new Map([[5,{...source,pngSha256:'changed'}]])),/master changed/);
  assert.throws(()=>rauhankatu19Restoration.apply(5,output,size,size,new Map([[5,{...source,height:512}]])),/dimensions invalid/);assert.deepEqual(output,before);
});
