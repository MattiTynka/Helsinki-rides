import assert from 'node:assert/strict';
import fs from 'node:fs';
import {test} from 'node:test';
import sharp from 'sharp';
import {renderCanalsideAtlasSvg} from '../author-canalside-facade-charts.ts';
import {renderParliamentCombinedAtlasSvg,PARLIAMENT_PIXELS} from '../author-parliament-lower-chart.ts';
import {facadeAtlasBytes,facadeChartSha256,validateFacadeChartProfile,type FacadeChartProfile} from '../lib/facade-charts.ts';

test('south lower wing has eleven original arched openings and does not import reference pixels',()=>{
  const svg=renderParliamentCombinedAtlasSvg();
  assert.equal([...svg.matchAll(/data-feature="parliament-south-arched-opening-[0-9]+"/g)].length,11);
  assert.doesNotMatch(svg,/<image\b|href=|url\(/);
  assert.equal(facadeAtlasBytes(768,256)*3,3*1024*1024);
});
test('raster addition preserves all approved Palace/Guard pixels and all unused pixels outside third content',async()=>{
  const raster=(s:string)=>sharp(Buffer.from(s)).ensureAlpha().raw().toBuffer();
  const before=await raster(renderCanalsideAtlasSvg()),after=await raster(renderParliamentCombinedAtlasSvg());
  const [px,py,w,h]=PARLIAMENT_PIXELS;let changed=0;
  for(let y=0;y<256;y++)for(let x=0;x<768;x++) {
    const k=(y*768+x)*4;assert.equal(after[k+3],255);
    if(x>=px&&x<px+w&&y>=py&&y<py+h) {if(!before.subarray(k,k+4).equals(after.subarray(k,k+4)))changed++;}
    else assert.deepEqual(after.subarray(k,k+4),before.subarray(k,k+4),`Unapproved pixel ${x},${y} changed`);
  }
  assert.ok(changed>1000);
  // The approved old PNG remains the byte-exact original raster.
  const old=await sharp(fs.readFileSync('content/helsinki/district-expansion/facade-charts/canalside-v1/canalside-original.png')).ensureAlpha().raw().toBuffer();
  assert.deepEqual(old,before);
});
test('combined reviewed profile preserves old chart/source targets and adds only the two lower-wing faces',async()=>{
  const directory='content/helsinki/district-expansion/facade-charts/';
  const previous=JSON.parse(fs.readFileSync(directory+'canalside-v1/profile.json','utf8')) as FacadeChartProfile;
  const profile=JSON.parse(fs.readFileSync(directory+'canalside-v2/profile.json','utf8')) as FacadeChartProfile;
  validateFacadeChartProfile(profile);
  assert.deepEqual(profile.charts.slice(0,2),previous.charts);
  assert.deepEqual(profile.cells.slice(0,2),previous.cells);
  assert.equal(profile.cells.length,3);
  assert.equal(profile.maximumFallbackBytes,3*1024*1024);
  assert.equal(profile.cells[2]!.id,'c_m09_m03');
  assert.equal(profile.cells[2]!.detailed.length,2);assert.equal(profile.cells[2]!.distant.length,2);
  assert.deepEqual(profile.cells[2]!.detailed.map(t=>t.key).sort(),profile.cells[2]!.distant.map(t=>t.key).sort());
  const bytes=await sharp(Buffer.from(renderParliamentCombinedAtlasSvg())).ensureAlpha().png({compressionLevel:9,adaptiveFiltering:false}).toBuffer();
  assert.deepEqual(bytes,fs.readFileSync(directory+'canalside-v2/canalside-original.png'));
  assert.equal(profile.art.sha256,facadeChartSha256(bytes));
  const ledger=JSON.parse(fs.readFileSync(directory+'canalside-v2/source-ledger.json','utf8'));
  assert.deepEqual(ledger.source.sourceTriangleIds,[665,666]);
  assert.equal(ledger.previousApproved.changedPixelsOutsideNewChart,0);
});
