import assert from'node:assert/strict';import{test}from'node:test';import fs from'node:fs';import path from'node:path';import os from'node:os';import sharp from'sharp';
import{OriginalWallArt}from'../author_senate_facade_charts.ts';
import{renderAlexanderTheatre,type TheatreFrame}from'../lib/alexander-theatre-facade.ts';
import{authorTheatreFacades,type TheatreSourcePlan}from'../author_alexander_theatre_facades.ts';
const plan=JSON.parse(fs.readFileSync(new URL('../../../content/helsinki/city-expansion-20261021/theatre-facade/plan.json',import.meta.url),'utf8')) as TheatreSourcePlan;
function draw(role:TheatreFrame['role']){const frame=plan.frames.find(f=>f.role===role)!;assert.ok(frame);const wall=new OriginalWallArt(frame.width,frame.minY,frame.maxY);renderAlexanderTheatre(wall,frame,[[0,1.05],[frame.width,1.25]]);return{frame,wall,svg:wall.pieces.join('')};}

test('theatre Albert front keeps independently observed three central portals/windows, two windows per wing and four central pilasters',()=>{
  const{svg}=draw('albertinkatu');for(const row of ['lower-arch','upper-rect']){
    assert.equal((svg.match(new RegExp(`data-feature="albertinkatu-source-plane-2-${row}-\\d"`,'g'))??[]).length,3);
    for(const group of [12,13])assert.equal((svg.match(new RegExp(`data-feature="albertinkatu-source-plane-${group}-${row}-\\d"`,'g'))??[]).length,2);
  }
  assert.equal((svg.match(/data-feature="albertinkatu-central-cream-pilaster-\d"/g)??[]).length,4);
  assert.equal((svg.match(/data-feature="theatre-albert-three-unit-canopy-\d"/g)??[]).length,3);assert.equal((svg.match(/data-feature="theatre-albert-canopy-iron-bracket-/g)??[]).length,6);
  assert.equal((svg.match(/data-feature="albertinkatu-source-plane-2-lower-arch-\d-wood-glazed-entrance-assembly"/g)??[]).length,3);
  assert.equal((svg.match(/data-feature="albertinkatu-source-plane-2-lower-arch-\d-entrance-glazed-panel-/g)??[]).length,6);
  for(const group of [12,13])assert.ok(!svg.includes(`albertinkatu-source-plane-${group}-lower-arch-1-wood-glazed-entrance-assembly`));
  assert.ok(svg.includes('theatre-albert-joined-canopy-head'));
  assert.ok(svg.includes('albertinkatu-small-front-pediment-relief'));assert.ok(!svg.includes('semicircular-attic-opening'));
});

test('the qualified high Albert gable has one separate semicircular opening while Bulevardi keeps its unique balcony and three-window flanks',()=>{
  const attic=draw('albert-attic').svg,bulevardi=draw('bulevardi').svg;
  assert.equal((attic.match(/data-feature="theatre-high-gable-semicircular-attic-opening"/g)??[]).length,1);assert.ok(attic.includes('theatre-high-gable-raking-cream-cornice'));assert.ok(!attic.includes('lower-arch'));
  for(const group of [6,7])for(const row of ['lower-arch','upper-rect'])assert.equal((bulevardi.match(new RegExp(`data-feature="bulevardi-source-plane-${group}-${row}-\\d"`,'g'))??[]).length,3);
  assert.equal((bulevardi.match(/data-feature="theatre-bulevardi-central-balcony-floor"/g)??[]).length,1);
});

test('theatre atlas layout is opaque original vector artwork and selected municipal triangles never duplicate',async()=>{
  const slots=plan.frames.map(f=>f.pixels);for(let i=0;i<slots.length;i++)for(let j=i+1;j<slots.length;j++){const a=slots[i]!,b=slots[j]!;assert.ok(a[0]+a[2]<=b[0]||b[0]+b[2]<=a[0]||a[1]+a[3]<=b[1]||b[1]+b[3]<=a[1]);}
  const triangles=plan.frames.flatMap(f=>f.triangleGroups.flat());assert.equal(triangles.length,new Set(triangles).size);assert.ok(plan.source.version==='305259202062');
  const{wall}=draw('albertinkatu'),svg=`<svg xmlns="http://www.w3.org/2000/svg" width="768" height="384"><rect width="100%" height="100%" fill="#c18a7d"/>${wall.svg([1,1,766,382])}</svg>`;assert.ok(!svg.includes('<image'));const raw=await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer();for(let i=3;i<raw.length;i+=4)assert.equal(raw[i],255);
});

test('a draft cannot accidentally produce a publication-bound theatre profile',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'theatre-author-guard-')),out=path.join(root,'not-created');
  await assert.rejects(()=>authorTheatreFacades({plan:'not-read',cityModel:'not-read',ground:'not-read',out,draft:false}),/publication authoring requires an actual baseline/);
  assert.equal(fs.existsSync(out),false);
  await assert.rejects(()=>authorTheatreFacades({plan:'not-read',cityModel:'not-read',ground:'not-read',out,baseline:'not-read',draft:true}),/Draft mode cannot bind a world/);
  assert.equal(fs.existsSync(out),false);fs.rmdirSync(root);
});
