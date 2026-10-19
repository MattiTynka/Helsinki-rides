import assert from 'node:assert/strict';
import fs from 'node:fs';
import {test} from 'node:test';
import sharp from 'sharp';
import {renderCanalsideAtlasSvg, PALACE_PIXELS, GUARD_PIXELS} from '../author-canalside-facade-charts.ts';
import {facadeAtlasBytes, facadeChartSha256, validateFacadeChartProfile, type FacadeChartProfile} from '../lib/facade-charts.ts';

const directory='content/helsinki/district-expansion/facade-charts/canalside-v1';
test('opened east elevation layout retains distinct low wing, three-light group and blind north ground floor',()=>{
  const svg=renderCanalsideAtlasSvg();
  const features=(prefix:string)=>[...svg.matchAll(new RegExp(`data-feature="${prefix}-[0-9]+"`,'g'))].length;
  assert.equal(features('palace-low-window'),7);
  assert.equal(features('palace-middle-window'),14);
  assert.equal(features('palace-upper-single'),12);
  assert.equal(features('palace-upper-triple'),3);
  assert.equal(features('palace-ground-window'),7);
  assert.equal(features('guard-blind-arcade'),6);
  assert.equal(features('guard-high-window'),6);
  for(const id of ['palace-low-canopy-door','palace-mariankatu-entrance','guard-service-door-bay-5']) assert.equal(svg.split(`data-feature="${id}"`).length-1,1);
  assert.doesNotMatch(svg,/<image\b|href=|url\(/,'Only original shape primitives, no copied photograph pixels');
});
test('original atlas is deterministic, opaque and stays inside the two-owner fallback cap',async()=>{
  const bytes=fs.readFileSync(`${directory}/canalside-original.png`);
  const regenerated=await sharp(Buffer.from(renderCanalsideAtlasSvg())).ensureAlpha().png({compressionLevel:9,adaptiveFiltering:false}).toBuffer();
  assert.deepEqual(regenerated,bytes);
  const decoded=await sharp(bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  assert.deepEqual([decoded.info.width,decoded.info.height,decoded.info.channels],[768,256,4]);
  for(let k=3;k<decoded.data.length;k+=4) assert.equal(decoded.data[k],255);
  assert.equal(facadeAtlasBytes(768,256)*2,2097152);
  const profile=JSON.parse(fs.readFileSync(`${directory}/profile.json`,'utf8')) as FacadeChartProfile;
  validateFacadeChartProfile(profile);
  assert.equal(profile.art.sha256,facadeChartSha256(bytes));
  assert.equal(profile.maximumFallbackBytes,2097152);
  assert.deepEqual(profile.charts.map(c=>c.pixels),[PALACE_PIXELS,GUARD_PIXELS]);
});
test('profile has only the reviewed source planes, with exact detailed/distant source key parity',()=>{
  const profile=JSON.parse(fs.readFileSync(`${directory}/profile.json`,'utf8')) as FacadeChartProfile;
  assert.deepEqual(profile.cells.map(c=>[c.id,c.detailed.length,c.distant.length]),[['c_p01_p00',14,14],['c_p02_p00',12,12]]);
  for(const cell of profile.cells) assert.deepEqual(cell.detailed.map(t=>t.key).sort(),cell.distant.map(t=>t.key).sort());
  assert.deepEqual(profile.charts.map(c=>c.building),['BID_cd5696b3-bb16-4aad-b2e3-cb1ee2fa2b08','BID_582cc5c9-65ce-4d61-ab46-f8f1b31b5731']);
});
