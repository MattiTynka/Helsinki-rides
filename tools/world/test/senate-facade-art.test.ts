import assert from 'node:assert/strict';
import {test} from 'node:test';
import sharp from 'sharp';
import fs from 'node:fs';
import {facadeChartSha256 as sha,facadeAtlasBytes} from '../lib/facade-charts.ts';
import {OriginalWallArt,renderArchiveWall,renderPorthaniaWall,renderPorthaniaEast,renderAleksanterinkatuNorth,chartForSourceTriangles} from '../author_senate_facade_charts.ts';
import type {FacadeTriangle} from '../lib/facade-charts.ts';

test('Archive central elevation keeps six columns, five opening axes and three distinct entrances',async()=>{
  const wall=new OriginalWallArt(18.65,3.76,26.13);renderArchiveWall(wall,'archive-centre',6.1);const art=wall.svg([1,1,250,300]);
  assert.equal((art.match(/data-feature="archive-corinthian-column-\d+"/g)??[]).length,6);
  assert.equal((art.match(/data-feature="archive-centre-middle-\d+"/g)??[]).length,5);
  assert.equal((art.match(/data-feature="archive-centre-upper-\d+"/g)??[]).length,5);
  assert.equal((art.match(/data-feature="archive-entrance-\d+"/g)??[]).length,3);
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="256" height="304"><rect width="256" height="304" fill="#ddd"/>${art}</svg>`;
  const raw=await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer();for(let i=3;i<raw.length;i+=4)assert.equal(raw[i],255);
});
test('Archive wing has four axes and barred lower windows without central columns or repeated entrance doors',()=>{
  const wall=new OriginalWallArt(17.45,3.76,24.85);renderArchiveWall(wall,'archive-wing',6.1);const art=wall.svg([1,1,250,300]);
  assert.equal((art.match(/data-feature="archive-wing-middle-\d+"/g)??[]).length,4);
  assert.equal((art.match(/data-feature="archive-wing-upper-\d+"/g)??[]).length,4);
  assert.equal((art.match(/data-feature="archive-wing-barred-base-\d+"/g)??[]).length,4);
  assert.ok(!art.includes('archive-corinthian-column')&&!art.includes('archive-entrance'));
});
test('Source chart preparation rejects roof or off-plane selections instead of painting unconfirmed geometry',()=>{
  const wall:FacadeTriangle=[[0,0,0],[2,0,0],[2,2,0]],offPlane:FacadeTriangle=[[0,0,.01],[2,0,.01],[2,2,.01]],roof:FacadeTriangle=[[0,1,0],[2,1,0],[2,1,2]];
  assert.deepEqual(chartForSourceTriangles('front','building',[wall],[1,1,10,10]).bounds,[0,0,2,2]);
  assert.throws(()=>chartForSourceTriangles('front','building',[wall,offPlane],[1,1,10,10]),/outside chart.*plane/);
  assert.throws(()=>chartForSourceTriangles('front','building',[roof],[1,1,10,10]));
});
test('Porthania uses five continuous glazing levels and a separate low pavilion, without classical punched openings',()=>{
  const wall=new OriginalWallArt(17,-6.3,23.3);renderPorthaniaWall(wall,'porthania-five-ribbons',-.6);const art=wall.svg([1,1,300,382]);
  assert.equal((art.match(/data-feature="porthania-ribbon-\d+"/g)??[]).length,4);assert.ok(art.includes('porthania-ground-glazing'));
  assert.ok(!art.includes('-surround')&&!art.includes('pediment')&&!art.includes('column'));
  const pavilion=new OriginalWallArt(13,-6.3,2.8);renderPorthaniaWall(pavilion,'porthania-low-glass',-.6);const low=pavilion.svg([1,1,130,382]);
  assert.ok(low.includes('porthania-pavilion-glazing')&&low.includes('porthania-pavilion-copper-fascia'));assert.ok(!low.includes('porthania-ribbon-'));
});
test('Aleksanterinkatu compound keeps three distinct elevations and asymmetric museum entrances',()=>{
  const wall=new OriginalWallArt(54.24,-4.77,9.77);renderAleksanterinkatuNorth(wall,-2.6);const art=wall.svg([1,1,766,254]);
  for(const role of ['brummer','remander','sederholm'])assert.equal((art.match(new RegExp(`data-feature="${role}-upper-\\d+"`,'g'))??[]).length,7);
  assert.equal((art.match(/data-feature="remander-middle-\d+-pediment"/g)??[]).length,3);
  assert.ok(art.includes('remander-museum-entrance')&&art.includes('remander-narrow-glazed-door'));
  assert.equal((art.match(/data-feature="sederholm-eastern-door-\d+"/g)??[]).length,2);
  assert.equal((art.match(/data-feature="brummer-ground-door-\d+"/g)??[]).length,2);
  assert.equal((art.match(/data-feature="brummer-ground-window-\d+"/g)??[]).length,5);
  assert.equal((art.match(/data-feature="brummer-shutter-\d+--?1"/g)??[]).length,10);
  assert.ok(!art.includes('sederholm-upper-4-pediment'),'Missing north gable must not be painted over the existing upper window');
});
test('Porthania east keeps the northern five ribbons, five glass floors and blank south tile as separate architecture',()=>{
  const north=new OriginalWallArt(20,-6.3,20.25);renderPorthaniaEast(north,'porthania-east-five-ribbons',2.7);const ribbons=north.svg([1,1,350,381]);
  assert.equal((ribbons.match(/data-feature="porthania-east-ribbon-\d+"/g)??[]).length,5);
  const inset=new OriginalWallArt(9,-6.3,25.31);renderPorthaniaEast(inset,'porthania-east-glass-inset',2.7);const glass=inset.svg([1,1,190,381]);
  assert.equal((glass.match(/data-feature="porthania-east-glass-floor-\d+"/g)??[]).length,5);assert.ok(glass.includes('linearGradient'));
  const blank=new OriginalWallArt(5.75,-6.3,23.98);renderPorthaniaEast(blank,'porthania-east-blank-tile',2.7);const tile=blank.svg([1,1,218,381]);
  assert.ok(!tile.includes('ribbon-')&&!tile.includes('glass-floor-')&&!tile.includes('-surround'));
});
test('Shipped original art remains opaque, within the declared atlas budget and bound to its source/reference ledgers',async()=>{
  const root='content/helsinki/senate-facades',planBytes=fs.readFileSync(`${root}/plan.json`),plan=JSON.parse(planBytes.toString());
  for(const building of plan.buildings){
    const dir=`${root}/v1/${building.vtj}`,profile=JSON.parse(fs.readFileSync(`${dir}/profile.json`,'utf8')),ledger=JSON.parse(fs.readFileSync(`${dir}/source-ledger.json`,'utf8'));
    const png=fs.readFileSync(`${dir}/facade.png`),svg=fs.readFileSync(`${dir}/facade.svg`),raw=await sharp(png).ensureAlpha().raw().toBuffer({resolveWithObject:true});
    assert.equal(sha(png),profile.art.sha256);assert.equal(sha(png),ledger.production.artSha256);assert.equal(sha(svg),ledger.production.svgSha256);assert.equal(sha(planBytes),ledger.planSha256);
    assert.equal(raw.info.width,profile.art.width);assert.equal(raw.info.height,profile.art.height);assert.ok(facadeAtlasBytes(raw.info.width,raw.info.height)<=3*1024*1024);
    for(let i=3;i<raw.data.length;i+=4)assert.equal(raw.data[i],255);
    assert.equal(profile.art.license,'CC0-1.0');assert.equal(ledger.production.referencePixelsCopied,false);assert.deepEqual(profile.source,plan.source);assert.equal(profile.baselineManifestSha256,plan.baselineManifestSha256);
    assert.equal(new Set(profile.cells[0].faces.map((f:any)=>f.key)).size,profile.cells[0].faces.length);
    for(const reference of profile.art.references)assert.equal(reference.role,'appearance-reference-only');
  }
});
