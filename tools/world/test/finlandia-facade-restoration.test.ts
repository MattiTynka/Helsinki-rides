import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {FINLANDIA_MAPPING_SHA,finlandiaMapping,finlandiaPixel,finlandiaRestoration} from '../lib/finlandia-facade-restoration.ts';

function fixture() {
  return new Map(finlandiaMapping.masters.map(m=> {
    const data=new Uint8Array(m.width*m.height*4);
    for(let i=0;i<data.length;i+=4) data.set([143,151,157,173],i);
    return [m.page,{width:m.width,height:m.height,pngSha256:m.pngSha256,data}] as const;
  }));
}
function inside(triangle: readonly (readonly number[])[],u:number,v:number) {
  const[a,b,c]=triangle as [readonly number[],readonly number[],readonly number[]];
  const d=(b[1]!-c[1]!)*(a[0]!-c[0]!)+(c[0]!-b[0]!)*(a[1]!-c[1]!);
  if(Math.abs(d)<1e-12) return false;
  const wa=((b[1]!-c[1]!)*(u-c[0]!)+(c[0]!-b[0]!)*(v-c[1]!))/d;
  const wb=((c[1]!-a[1]!)*(u-c[0]!)+(a[0]!-c[0]!)*(v-c[1]!))/d;
  return wa>=0&&wb>=0&&wa+wb<=1;
}
function atAlong(chart:typeof finlandiaMapping.charts[number],s:number) {
  // A point on the exact wall plane, obtained from its first source vertex and tangent.
  const p=chart.tris[0]!.xyz[0]!,start=chart.normal[1]*p[0]-chart.normal[0]*p[1];
  return [p[0]+(s-start)*chart.normal[1],p[1]-(s-start)*chart.normal[0]] as const;
}

test('Finlandia mapping is pinned to one building, original wall triangles and five exact masters',()=>{
  assert.equal(createHash('sha256').update(readFileSync('content/assets/facades/finlandia/wall-mapping.json')).digest('hex'),FINLANDIA_MAPPING_SHA);
  assert.equal(finlandiaMapping.building.vtj,'1032092665');
  assert.deepEqual(finlandiaRestoration.targetPages,[1006,1008,1011,1013,1016]);
  for(const support of finlandiaRestoration.supportFiles!) assert.equal(createHash('sha256').update(readFileSync(support.file)).digest('hex'),support.sha256);
  for(const c of finlandiaMapping.charts) {
    assert.ok(Math.abs(c.normal[2])<.001);
    for(const t of c.tris) for(const uv of t.uv) assert.ok(uv.every(n=>Number.isFinite(n)&&n>=0&&n<=1));
  }
});

test('Finlandia refuses missing, rehashed and truncated source masters before any write',()=>{
  const sources=fixture(),output=new Uint8Array(256*256*4).fill(37),before=output.slice();
  for(const invalid of ['missing','hash','pixels','dimensions']) {
    const broken=new Map(sources),source=broken.get(1013)!;
    if(invalid==='missing')broken.delete(1013);
    if(invalid==='hash')broken.set(1013,{...source,pngSha256:'incorrect'});
    if(invalid==='pixels')broken.set(1013,{...source,data:new Uint8Array(4)});
    if(invalid==='dimensions')broken.set(1013,{...source,width:512});
    assert.throws(()=>finlandiaRestoration.apply(1006,output,256,256,broken),/master 1013 changed/);
    assert.deepEqual(output,before);
  }
  assert.throws(()=>finlandiaRestoration.apply(1006,output,255,256,sources),/dimensions invalid/);
  assert.deepEqual(finlandiaRestoration.apply(900,output,256,256,new Map()),[]);
  assert.deepEqual(output,before);
});

test('Finlandia authoring retains every outside-chart texel, alpha and all raw source buffers',()=>{
  const sources=fixture(),sourceHashes=new Map([...sources].map(([page,s])=>[page,createHash('sha256').update(s.data).digest('hex')]));
  const size=256;
  for(const page of finlandiaRestoration.targetPages) {
    const output=new Uint8Array(size*size*4).fill(211),before=output.slice();
    const evidence=finlandiaRestoration.apply(page,output,size,size,sources);
    assert.ok(evidence.some(e=>e.changedTexels>0));
    const triangles=finlandiaMapping.charts.filter(c=>c.page===page).flatMap(c=>c.tris);
    let outside=0,changed=0;
    for(let y=0;y<size;y++)for(let x=0;x<size;x++) {
      const i=(y*size+x)*4;assert.equal(output[i+3],211);
      if(output[i]!==211||output[i+1]!==211||output[i+2]!==211)changed++;
      if(triangles.some(t=>inside(t.uv,(x+.5)/size,(y+.5)/size)))continue;
      outside++;assert.deepEqual(output.slice(i,i+4),before.slice(i,i+4));
    }
    assert.ok(outside>1000);assert.ok(changed>0);
  }
  for(const[page,source]of sources)assert.equal(createHash('sha256').update(source.data).digest('hex'),sourceHashes.get(page));
});

test('Finlandia protects clean existing windows, the original stair and unresolved end-wall openings',()=>{
  const sources=fixture(),north=finlandiaMapping.charts.find(c=>c.id==='1006-2')!,ret=finlandiaMapping.charts.find(c=>c.id==='1013-0')!,end=finlandiaMapping.charts.find(c=>c.id==='1016-18')!;
  for(const h of [-5,0,5,10]) {const p=atAlong(north,-49);assert.equal(finlandiaPixel(north,...p,h,sources),null);}
  for(const h of [-1,0,.6,1.2]) {const p=atAlong(ret,-69);assert.equal(finlandiaPixel(ret,...p,h,sources),null);}
  for(const s of [1018,1025,1026.9]) for(const h of [-5,-2,0,1.7]) {const p=atAlong(end,s);assert.equal(finlandiaPixel(end,...p,h,sources),null);}
  for(const s of [1024.7,1025,1030,1031.1])for(const h of [2.3,3,4.9]){const p=atAlong(end,s);assert.equal(finlandiaPixel(end,...p,h,sources),null);}
  for(const s of [1017,1023,1033,1042]){const p=atAlong(end,s);assert.ok(finlandiaPixel(end,...p,3,sources));}
  for(const s of [1033,1042])for(const h of [-2,0,2]){const p=atAlong(end,s);assert.ok(finlandiaPixel(end,...p,h,sources));}
  const clearCurve=finlandiaMapping.charts.find(c=>c.profile==='congress-curves'&&c.tris[0]!.xyz[0]![1]>658.3)!;
  assert.equal(finlandiaPixel(clearCurve,-1022,665,12,sources),null);
  // A confirmed reconstructed window/door remains glass, with authored frames rather than marble.
  const window=atAlong(north,-33.5),door=atAlong(ret,-47.6);
  const wall=atAlong(north,-36);
  assert.notDeepEqual(finlandiaPixel(north,...window,0,sources),finlandiaPixel(north,...wall,0,sources));
  assert.ok(finlandiaPixel(ret,...door,-.5,sources));
});

test('Finlandia exposes only the two reviewed lower-column bands to the existing granite donor',()=>{
  const sources=fixture(),end=finlandiaMapping.charts.find(c=>c.id==='1016-18')!;
  const lower=finlandiaMapping.profiles['congress-end'].protected.slice(0,2);
  assert.deepEqual(lower,[[1017,1019.6,-5.8,1.7],[1024.3,1027.1,-5.8,1.7]]);
  const expected=[143,151,157].map(v=>v*.72);
  for(const s of [1017.01,1018.3,1019.59,1024.31,1025.7,1027.09]) {
    const p=atAlong(end,s);
    assert.equal(finlandiaPixel(end,...p,1.699,sources),null);
    for(const h of [1.701,1.8,2.199])assert.deepEqual(finlandiaPixel(end,...p,h,sources),expected);
  }
  // This correction must not erase the upper opening bank where the bands overlap it.
  for(const s of [1024.61,1025.7,1027.09])for(const h of [2.2,3,4.95]) {
    const p=atAlong(end,s);assert.equal(finlandiaPixel(end,...p,h,sources),null);
  }
});
