import assert from 'node:assert/strict';
import {test} from 'node:test';
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {OriginalWallArt,type GroupedFacadePlan} from '../author_senate_facade_charts.ts';
import {renderEtelaesplanadi12North,renderCityFacade} from '../lib/city-facade-art.ts';
import {chartForSourceTriangles} from '../author_senate_facade_charts.ts';

test('Eteläesplanadi12 keeps six upper bays, ten openings per row, five ground arches and its unique centre door',async()=>{
  const wall=new OriginalWallArt(30.04,-2.14,24.061);renderEtelaesplanadi12North(wall,-1.5);const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="768" height="640"><rect width="768" height="640" fill="#ddd"/>${wall.svg([1,1,766,638])}</svg>`;
  for(let row=1;row<=4;row++)assert.equal((svg.match(new RegExp(`data-feature="etela12-row${row}-opening-\\d+"`,'g'))??[]).length,10);
  assert.equal((svg.match(/data-feature="etela12-row2-ogee-lintel-\d+"/g)??[]).length,6);assert.equal((svg.match(/data-feature="etela12-row4-ogee-lintel-\d+"/g)??[]).length,6);
  assert.equal((svg.match(/data-feature="etela12-ground-shop-arch-\d+"/g)??[]).length,4);assert.equal((svg.match(/data-feature="etela12-central-wood-entry"/g)??[]).length,1);
  const raw=await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer();for(let i=3;i<raw.length;i+=4)assert.equal(raw[i],255);
  assert.equal(renderCityFacade(new OriginalWallArt(30,-2,24),'unreferenced-building',0),false);
});

test('modern fronts keep their distinct observed row/group and passage structure',()=>{
  const draw=(id:string,w:number,bottom:number,top:number,g:number)=>{const wall=new OriginalWallArt(w,bottom,top);assert.equal(renderCityFacade(wall,id,g,[[0,g-.5],[w,g+.5]]),true);return wall.pieces.join('');};
  const fab16=draw('fabianinkatu16-east',34.96,-4.42,16.57,-4.16),fab18=draw('fabianinkatu18-east',50.09,-3.94,21.16,-2.23);
  for(const [svg,prefix]of [[fab16,'fabian16'],[fab18,'fabian18']] as const){for(let row=1;row<=4;row++)assert.ok(svg.includes(`${prefix}-upper-row${row}-module-`));assert.ok(!svg.includes(`${prefix}-upper-row5-`));assert.ok(svg.includes('measured-sloping-granite-plinth'));}
  assert.equal((fab16.match(/data-feature="fabian16-central-recessed-passage"/g)??[]).length,1);
  const east=draw('aleksanterinkatu9-east-south',23.08,-5.52,17.99,-4.22),west=draw('aleksanterinkatu9-west-south',38.48,-5.10,21.27,-5.04);
  for(let row=1;row<=4;row++){
    assert.equal((east.match(new RegExp(`data-feature="aleks9-east-row${row}-group-\\d"`,'g'))??[]).length,3);
    assert.equal((east.match(new RegExp(`data-feature="aleks9-east-row${row}-group\\d-pane-\\d"`,'g'))??[]).length,12);
    assert.ok(west.includes(`data-feature="aleks9-west-ribbon-${row}"`));
  }
  assert.equal((east.match(/data-feature="aleks9-east-shop-level-\d"/g)??[]).length,2);assert.equal((west.match(/data-feature="aleks9-west-shop-level-\d"/g)??[]).length,2);
});

test('thin municipal edge triangles keep the strict plane gate despite Float32 cross-product noise',()=>{
  const tri=[[-169.139404296875,-4.419920921325684,74.74779510498047],[-168.76104736328125,16.51605796813965,82.37094116210938],[-168.75914001464844,16.51007652282715,82.40919494628906]] as const;
  const chart=chartForSourceTriangles('thin','municipal-edge',[tri],[1,1,100,100]);assert.equal(chart.planeToleranceMetres,.002);
  assert.throws(()=>chartForSourceTriangles('folded','bad-source',[[[0,0,0],[5,5,0],[5,0,.1]]],[1,1,100,100]),/plane/);
});

test('referenced northern historic fronts retain separate styles and distinctive opening counts',()=>{
  const draw=(id:string,w:number,bottom:number,top:number,g:number)=>{const wall=new OriginalWallArt(w,bottom,top);assert.ok(renderCityFacade(wall,id,g));return wall.pieces.join('');};
  const fab26=draw('fabianinkatu26-east',29.84,4.43,25.52,6.56),fab28=draw('fabianinkatu28-east',29.84,6.82,29.95,8.35),mannerheim=draw('mannerheimintie5-central-southwest',26.05,-3.33,23.48,-.91);
  assert.equal((fab26.match(/data-feature="fabian26-granite-main-arch-\d"/g)??[]).length,5);
  for(let row=1;row<=2;row++)assert.equal((fab26.match(new RegExp(`data-feature="fabian26-upper-row${row}-central-axis-\\d"`,'g'))??[]).length,4);
  assert.equal((fab26.match(/data-feature="fabian26-north-return-pedestrian-arch"/g)??[]).length,1);
  for(let row=1;row<=3;row++){assert.equal((fab28.match(new RegExp(`data-feature="fabian28-upper-row${row}-regular-\\d"`,'g'))??[]).length,8);assert.equal((fab28.match(new RegExp(`data-feature="fabian28-oriel-\\d-level-${row}"`,'g'))??[]).length,2);}
  assert.equal((fab28.match(/data-feature="fabian28-left-centre-arched-entry"/g)??[]).length,1);
  assert.equal((mannerheim.match(/data-feature="mannerheim5-main-round-arch-\d"/g)??[]).length,5);assert.equal((mannerheim.match(/data-feature="mannerheim5-central-kaivopiha-passage"/g)??[]).length,1);
  for(let row=1;row<=3;row++)assert.equal((mannerheim.match(new RegExp(`data-feature="mannerheim5-rect-row${row}-axis-\\d"`,'g'))??[]).length,5);
  assert.ok(fab28.includes('#c8ac69'));assert.ok(!fab26.includes('#c8ac69'));
});

test('Kamp uses three tall rows, low round attic and exactly the single observed wooden portal',()=>{
  const wall=new OriginalWallArt(87.35,-5.59,24.53);assert.ok(renderCityFacade(wall,'kamp-south',-4.62));const svg=wall.pieces.join('');
  assert.equal((svg.match(/data-feature="kamp-observed-single-wood-portal"/g)??[]).length,1);
  assert.ok(!svg.includes('kamp-observed-single-wood-portal-2'));
  const rows=[1,2,3].map(row=>(svg.match(new RegExp(`data-feature="kamp-tall-row${row}-axis-\\d+"`,'g'))??[]).length);assert.ok(rows[0]!>=14);assert.deepEqual(rows,[rows[0],rows[0],rows[0]]);
  assert.equal((svg.match(/data-feature="kamp-low-round-arched-attic-\d+"/g)??[]).length,rows[0]);assert.ok(svg.includes('kamp-unverified-upper-source-colour'));
});

test('frozen public facade atlases bind nine municipal owners to five original opaque source artifacts',async()=>{
  const root=fileURLToPath(new URL('../../../content/helsinki/city-facades/',import.meta.url)),planBytes=fs.readFileSync(path.join(root,'plan.json')),plan=JSON.parse(planBytes.toString()) as GroupedFacadePlan,sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
  assert.equal(plan.schemaVersion,2);assert.equal(plan.groups.length,5);assert.equal(plan.groups.flatMap(g=>g.buildings).length,9);
  for(const group of plan.groups){
    const dir=path.join(root,'v1',group.cell),png=fs.readFileSync(path.join(dir,'facade.png')),svg=fs.readFileSync(path.join(dir,'facade.svg')),p=JSON.parse(fs.readFileSync(path.join(dir,'profile.json'),'utf8')),ledger=JSON.parse(fs.readFileSync(path.join(dir,'source-ledger.json'),'utf8'));
    assert.equal(p.art.sha256,sha(png));assert.equal(ledger.production.artSha256,sha(png));assert.equal(ledger.production.svgSha256,sha(svg));assert.equal(ledger.planSha256,sha(planBytes));assert.equal(p.art.license,'CC0-1.0');assert.equal(ledger.production.referencePixelsCopied,false);
    assert.equal(p.baselineManifestSha256,plan.baselineManifestSha256);assert.deepEqual(p.source,plan.source);assert.deepEqual(p.cells[0].buildings,group.buildings.map(b=>({id:b.id,vtj:b.vtj})));
    assert.ok(p.art.width<=1024&&p.art.height<=1024);assert.ok(!svg.toString().includes('<image'));assert.ok(p.art.references.every((r:{role:string})=>r.role==='appearance-reference-only'));
    const raw=await sharp(png).ensureAlpha().raw().toBuffer();for(let i=3;i<raw.length;i+=4)assert.equal(raw[i],255);
  }
});
