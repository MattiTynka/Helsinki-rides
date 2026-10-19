import assert from 'node:assert/strict';
import fs from 'node:fs';
import {test} from 'node:test';
import sharp from 'sharp';
import {facadeChartSha256,facadeChartUv,validateFacadeChartProfile,validateFacadeTriangle,type FacadeChartProfile} from '../lib/facade-charts.ts';
import {guardCompletionLayout,renderGuardCompletionAtlasSvg,proveUnusedAtlasStrips,GUARD_SOUTHEAST_PIXELS,GUARD_RECESS_PIXELS} from '../author-guard-completion-charts.ts';

const base='content/helsinki/district-expansion/facade-charts/';
const previous=JSON.parse(fs.readFileSync(base+'canalside-v2/profile.json','utf8')) as FacadeChartProfile;
const profile=JSON.parse(fs.readFileSync(base+'canalside-v3/profile.json','utf8')) as FacadeChartProfile;
const read=(dir:string)=>JSON.parse(fs.readFileSync(`data/evidence/district-expansion-20261018/${dir}/source-fit.json`,'utf8'));
const recess=read('facade-chart-guard-recess-engineering-v1'),chamfer=read('facade-chart-guard-se-chamfer-engineering-v1'),layout=guardCompletionLayout(previous,recess,chamfer);
test('v3 retains prior declarations/targets and adds only six Guard source faces',()=>{
  validateFacadeChartProfile(profile);assert.deepEqual(profile.charts.slice(0,3),previous.charts);
  assert.equal(profile.cells.length,3);assert.equal(profile.maximumFallbackBytes,3145728);
  for(let i=0;i<3;i++) {const before=previous.cells[i]!,after=profile.cells[i]!;if(before.id!=='c_p02_p00')assert.deepEqual(after,before);else {assert.deepEqual(after.detailed.slice(0,12),before.detailed);assert.deepEqual(after.distant.slice(0,12),before.distant);assert.equal(after.detailed.length,18);assert.equal(after.distant.length,18);}}
  for(const [e,c]of [[recess,layout.recessChart],[chamfer,layout.chamferChart]] as const)for(const t of e.levels.lod0.selected)validateFacadeTriangle(t.vertices,c);
});
test('recess maps only original world bays3/4 and preserves window/sill/plinth world height',()=>{
  const old=previous.charts.find(c=>c.id==='main-guard-south')!,c=layout.recessChart,[u0,u1]=layout.recessWorldStationBounds;
  const centres=Array.from({length:6},(_,i)=>(i+.5)*(old.bounds[2]-old.bounds[0])/6);
  assert.deepEqual(centres.map((u,i)=>({u,bay:i+1})).filter(p=>p.u>=u0&&p.u<=u1).map(p=>p.bay),[3,4]);
  for(const t of recess.levels.lod0.selected)for(const v of t.vertices) {
    const frontU=v.reduce((sum:number,n:number,i:number)=>sum+(n-old.origin[i]!)*old.uAxis[i]!,0),uv=facadeChartUv(v,c,768,256);
    const norm=(uv[0]*768-c.pixels[0]-.5)/(c.pixels[2]-1);
    assert.ok(Math.abs(norm-(frontU-u0)/(u1-u0))<1e-7);
  }
  const baseY=old.origin[1]+old.bounds[1],oldHeight=old.bounds[3]-old.bounds[1];
  for(const worldY of [baseY,baseY+1.48,baseY+4.15,baseY+5.29,baseY+5.60]) {
    const inNewV=worldY-c.origin[1],chartY=(c.bounds[3]-inNewV)/(c.bounds[3]-c.bounds[1]);
    const svgY=(oldHeight-(worldY-baseY)-layout.recessSvgYBounds[0])/(layout.recessSvgYBounds[1]-layout.recessSvgYBounds[0]);
    assert.ok(Math.abs(chartY-svgY)<1e-12);
  }
  assert.ok(-layout.recessSvgYBounds[0]>.90&&-layout.recessSvgYBounds[0]<.92);
});
test('new original art has five SE arches/windows and keeps every pixel outside approved unused strips exact',async()=>{
  const svg=renderGuardCompletionAtlasSvg(fs.readFileSync(base+'canalside-v2/canalside-original.svg','utf8'),layout);
  assert.equal([...svg.matchAll(/data-feature="guard-southeast-blind-arcade-[0-9]+"/g)].length,5);
  assert.equal([...svg.matchAll(/data-feature="guard-southeast-high-window-[0-9]+"/g)].length,5);
  assert.doesNotMatch(svg,/guard-southeast-door|<image\b|href=|url\(/);
  const png=await sharp(Buffer.from(svg)).ensureAlpha().png({compressionLevel:9,adaptiveFiltering:false}).toBuffer();assert.deepEqual(png,fs.readFileSync(base+'canalside-v3/canalside-original.png'));assert.equal(facadeChartSha256(png),profile.art.sha256);
  const old=await sharp(base+'canalside-v2/canalside-original.png').ensureAlpha().raw().toBuffer(),next=await sharp(png).ensureAlpha().raw().toBuffer();let changed=0;
  for(let y=0;y<256;y++)for(let x=0;x<768;x++){const k=(y*768+x)*4;assert.equal(next[k+3],255);if(!old.subarray(k,k+4).equals(next.subarray(k,k+4))){changed++;assert.ok([GUARD_SOUTHEAST_PIXELS,GUARD_RECESS_PIXELS].some(([a,b,w,h])=>x>=a&&x<a+w&&y>=b&&y<b+h));}}
  assert.equal(changed,19360);
});
test('actual rendered old UVs prove both new strips unused by all28 protected source faces with1pixel margin',async()=>{
  const proof=await proveUnusedAtlasStrips(previous);assert.deepEqual(proof.rows.map(r=>r.sourceTriangles),[14,12,2]);
  for(const row of proof.rows)for(const strip of row.strips)assert.equal(strip.usedTriangleOverlapPixels2,0);
});
