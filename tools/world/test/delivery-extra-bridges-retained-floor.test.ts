import assert from 'node:assert/strict';
import {test} from 'node:test';
import {restoreNativeLowerFloor,closeNativeLowerKerbEdges} from '../lib/delivery-extra-bridges-retained-floor.ts';
import {supportNormal,type SupportTriangle} from '../lib/tram-support-repair.ts';
import type {ExtraBridgeNativeFace} from '../lib/delivery-extra-bridges-source.ts';
const floor=(x0:number,x1:number,y:number):ExtraBridgeNativeFace[]=>[
  [[x0,y,0],[x0,y,4],[x1,y,4]],[[x0,y,0],[x1,y,4],[x1,y,0]],
].map((points,i)=>({points:points as SupportTriangle,cell:'native',collider:'ground',triangle:i,tag:'road:gravel',group:'ground'}));
const domain:[number,number][][]=[[[0,0],[4,0],[4,4],[0,4]]];
const base={source:floor(0,4,-4),domain,upper:floor(0,4,0).map(f=>f.points),slabThickness:.65,minimumHeadroom:2.2};
test('restores lower native plane beneath a distinct upper floor without changing either input',()=>{
  const retained=floor(0,4,0),before=structuredClone(retained),r=restoreNativeLowerFloor({...base,retained});
  assert.deepEqual(retained,before);assert.equal(r.faces.length,2);assert.equal(r.proof.minimumMeasuredSlabClearance,3.35);
  for(const f of r.faces){assert.ok(supportNormal(f.points)[1]>.99);assert.ok(f.points.every(p=>p[1]===-4));}
});
test('subtracts only already retained coplanar lower floor while honoring the exact source ring',()=>{
  const r=restoreNativeLowerFloor({...base,domain:[[[1,1],[3,1],[3,3],[1,3]]],retained:[...floor(0,2,-4),...floor(0,4,0)]});
  assert.ok(r.faces.every(f=>f.points.every(p=>p[0]>=2&&p[0]<=3&&p[2]>=1&&p[2]<=3)));
  const area=r.faces.reduce((n,f)=>{const[a,b,c]=f.points;return n+Math.abs((b[0]-a[0])*(c[2]-a[2])-(b[2]-a[2])*(c[0]-a[0]))/2;},0);assert.equal(area,2);
});
test('uses every overlap vertex to reject a low sloping soffit missed by an average-height probe',()=>{
  const upper=floor(0,4,0).map(f=>f.points.map(p=>[p[0],p[0]-2,p[2]])as SupportTriangle);
  assert.throws(()=>restoreNativeLowerFloor({...base,retained:[],upper}),/slab clearance/);
});
test('retains nonlevel source-plane heights instead of flattening parking to one sampled elevation',()=>{
  const source=floor(0,4,-4).map(f=>({...f,points:f.points.map(p=>[p[0],p[1]+p[0]*.1,p[2]])as SupportTriangle})),r=restoreNativeLowerFloor({...base,source,retained:[]});
  for(const f of r.faces)for(const p of f.points)assert.ok(Math.abs(p[1]-(-4+p[0]*.1))<.000001);
});
test('rejects a redundant restoration or an authority with no real upper deck overlap',()=>{
  assert.throws(()=>restoreNativeLowerFloor({...base,retained:floor(0,4,-4)}),/No missing/);
  assert.throws(()=>restoreNativeLowerFloor({...base,retained:[],upper:floor(10,14,0).map(f=>f.points)}),/upper deck authority/);
});
test('closes only the actual low parking to raised-sidewalk kerb and faces the lower source domain',()=>{
  const restored=floor(0,4,-4).map(source=>({points:source.points,source})),retained=floor(4,5,-3.88).map(f=>({...f,tag:'raised:slabs'})),r=closeNativeLowerKerbEdges({restored,retained,domain,maximumRise:.25});
  assert.equal(r.faces.length,2);for(const f of r.faces){assert.ok(f.points.every(p=>p[0]===4));assert.ok(supportNormal(f.points)[0]<-.99);assert.ok(f.points.every(p=>p[1]>=-4&&p[1]<=-3.879999));}assert.equal(r.proof.horizontalFloorsChanged,false);
});
test('does not replace a literal existing vertical kerb or close a distinct upper bridge deck',()=>{
  const restored=floor(0,4,-4).map(source=>({points:source.points,source})),raised=floor(4,5,-3.88).map(f=>({...f,tag:'raised:slabs'})),walls:ExtraBridgeNativeFace[]=[[[4,-4,0],[4,-3.88,4],[4,-4,4]],[[4,-4,0],[4,-3.88,0],[4,-3.88,4]]].map((points,i)=>({points:points as SupportTriangle,cell:'native',collider:'kerb',triangle:i,tag:'kerb:slabs',group:'kerbs'}));
  assert.equal(closeNativeLowerKerbEdges({restored,retained:[...raised,...walls],domain,maximumRise:.25}).faces.length,0);
  assert.equal(closeNativeLowerKerbEdges({restored,retained:raised.map(f=>({...f,tag:'raised:slabs:bridge-reconstruction'})),domain,maximumRise:.25}).faces.length,0);
});

test('closes a thin actual native corner that a fixed two-centimetre side probe skips',()=>{
  const restored=floor(0,4,-4).map(source=>({points:source.points,source})),retained=floor(4,4.006,-3.88).map(f=>({...f,tag:'raised:slabs'}));
  const r=closeNativeLowerKerbEdges({restored,retained,domain,maximumRise:.25});
  assert.ok(r.faces.length>=2);assert.ok(r.faces.every(f=>f.points.every(p=>p[0]===4)));
  assert.ok(r.proof.segments.every(p=>p.maximumRise<.121));
});
test('closes an interior raised-island boundary while leaving native continuous T-junctions open',()=>{
  const restored=floor(0,4,-4).map(source=>({points:source.points,source})),retained=[...floor(2,3,-3.88),...floor(3,4,-3.88).map(f=>({...f,points:f.points.map(p=>[p[0],p[1],p[2]/2])as SupportTriangle})),...floor(3,4,-3.88).map(f=>({...f,points:f.points.map(p=>[p[0],p[1],p[2]/2+2])as SupportTriangle}))].map(f=>({...f,tag:'raised:slabs'}));
  const r=closeNativeLowerKerbEdges({restored,retained,domain,maximumRise:.25});
  assert.ok(r.faces.some(f=>f.points.every(p=>p[0]===2)));
  assert.equal(r.faces.filter(f=>f.points.every(p=>p[0]===3)).length,0);
  assert.ok(r.proof.boundaryCensus.some(p=>p.status==='continuous-raised-floor-on-both-sides'));
});
