import assert from 'node:assert/strict';
import {test} from 'node:test';
import {CATANI_PHOTO_SHA,esplanadiMapping,esplanadiPixel,esplanadiRestoration} from '../lib/esplanadi-facade-restoration.ts';
function fixture(){
  const data=(w:number,h:number)=>{const d=new Uint8Array(w*h*4);for(let i=0;i<d.length;i+=4)d.set([154,142,130,173],i);return d;};
  return {sources:new Map(esplanadiMapping.masters.map(m=>[m.page,{width:m.width,height:m.height,data:data(m.width,m.height),pngSha256:m.pngSha256}])),externals:new Map([['esplanadi-catani-valtonen',{width:900,height:1200,data:data(900,1200),sha256:CATANI_PHOTO_SHA}]])};
}
function inside(p:readonly (readonly number[])[],x:number,y:number){let hit=false;for(let i=0,j=p.length-1;i<p.length;j=i++){const a=p[i]!,b=p[j]!;if((a[1]!>y)!==(b[1]!>y)&&x<(b[0]!-a[0]!)*(y-a[1]!)/(b[1]!-a[1]!)+a[0]!)hit=!hit;}return hit;}
test('Esplanadi masks retain alpha, source buffers and every pixel outside the selected wall triangles',()=>{
  const {sources,externals}=fixture(),size=256;
  for(const page of esplanadiRestoration.targetPages){const output=new Uint8Array(size*size*4).fill(211),before=output.slice();const original=sources.get(page)!.data.slice();const evidence=esplanadiRestoration.apply(page,output,size,size,sources,externals);assert.ok(evidence.length);const triangles=esplanadiMapping.buildings.flatMap(b=>b.charts.filter(c=>c.page===page).flatMap(c=>c.tris));let outside=0;
    for(let y=0;y<size;y++)for(let x=0;x<size;x++){const i=(y*size+x)*4;assert.equal(output[i+3],211);if(triangles.some(t=>inside(t.uv,(x+.5)/size,(y+.5)/size)))continue;outside++;assert.deepEqual(output.slice(i,i+4),before.slice(i,i+4));}
    assert.ok(outside>1000);assert.deepEqual(sources.get(page)!.data,original);
  }
});
test('Esplanadi rejects mismatched masters and external photographs before mutating targets',()=>{
  const {sources,externals}=fixture(),output=new Uint8Array(256*256*4).fill(37),before=output.slice();
  const broken=new Map(sources);broken.set(677,{...broken.get(677)!,pngSha256:'wrong'});
  assert.throws(()=>esplanadiRestoration.apply(698,output,256,256,broken,externals),/master 677 changed/);
  assert.throws(()=>esplanadiRestoration.apply(698,output,256,256,sources,new Map()),/photograph missing/);
  const truncated=new Map(externals);truncated.set('esplanadi-catani-valtonen',{...externals.get('esplanadi-catani-valtonen')!,data:new Uint8Array(4)});
  assert.throws(()=>esplanadiRestoration.apply(698,output,256,256,sources,truncated),/dimensions invalid/);
  assert.deepEqual(esplanadiRestoration.apply(28,output,256,256,new Map()),[]);assert.deepEqual(output,before);
});
test('Esplanadi preserves the Merkurius central entrance and Gronqvist upper floors and balcony structures',()=>{
  const {sources,externals}=fixture(),merkurius=esplanadiMapping.buildings.find(b=>b.name==='Pohjoisesplanadi_33')!,gronqvist=esplanadiMapping.buildings.find(b=>b.name==='Mikonkatu_2')!;
  for(const h of [-4,-2,0,2,8,18])assert.equal(esplanadiPixel(merkurius,-343,h,sources,externals),null);
  for(const h of [8,12,18,24])assert.equal(esplanadiPixel(gronqvist,-405,h,sources,externals),null);
  assert.equal(esplanadiPixel(gronqvist,-415.34,5,sources,externals),null);
  assert.equal(esplanadiPixel(gronqvist,-375.66,5,sources,externals),null);
});
