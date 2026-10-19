// Add original lower-wing art to a NEW combined atlas; approved v1 art stays immutable.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';
import {renderCanalsideAtlasSvg} from './author-canalside-facade-charts.ts';
import {facadeAtlasBytes, facadeChartSha256 as sha, validateFacadeChartProfile, type FacadeChart, type FacadeChartProfile, type FacadeChartTarget} from './lib/facade-charts.ts';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
export const PARLIAMENT_PIXELS=[505,161,262,93] as const;
const LENGTH=38.003547, HEIGHT=7.31000018119812;
const oldDirectory='content/helsinki/district-expansion/facade-charts/canalside-v1';
const oldProfileHash='46de315aa3c0003157284a94a6352283ff2b8fffb96f9d8c577effe64b3649ff';
const referenceDirectory='data/evidence/district-expansion-20261018/blank-canalside-facades-v1/references';
const sourcePlanesPath='data/evidence/district-expansion-20261018/parliament-lower-wing-source-planes-v1.json';
const sourcePlanesHash='a657ff2448e32b50aedc4eb74cced477b59eaf17d39d00af5f32c3548b20b6b7';
const imageHash='72b7de38508a3b7e57c0cf84ae11e6b10f4050e52ffcfea53fd7ba1edb1df072';
const references=[
  {title:'Parliament House, tree-free aerial showing both complete lower wings, Helsinki City Museum architecture record, image2',url:'https://www.finna.fi/Record/hkm.C070A514-709A-4A40-9F6D-D8413A6AD6D4',role:'appearance-reference-only' as const},
  {title:'Parliament official aerial, Lev Karavanov / Mostphotos',url:'https://www.parliament.fi/fi/vieraile-ja-osallistu/eduskuntatalo',role:'appearance-reference-only' as const},
];

export function renderParliamentCombinedAtlasSvg():string {
  const parts:string[]=[];
  const rect=(x:number,y:number,w:number,h:number,c:string,extra='')=>parts.push(`<rect x="${x}" y="${HEIGHT-y-h}" width="${w}" height="${h}" fill="${c}" ${extra}/>`);
  const line=(x1:number,y1:number,x2:number,y2:number,c:string,w:number)=>parts.push(`<path d="M${x1},${HEIGHT-y1} L${x2},${HEIGHT-y2}" stroke="${c}" stroke-width="${w}" fill="none"/>`);
  rect(0,0,LENGTH,HEIGHT,'#c8b5ab');
  // Staggered joints and deterministic authored stone variation, no photo sampling.
  let row=0;
  for(let y=0;y<HEIGHT;y+=.42,row++) {
    for(let x=-(row%2)*1.23;x<LENGTH;x+=2.46) {
      const n=((row*17+Math.round(x*13))%7+7)%7;
      const colours=['#cab8ae','#c2b2a9','#cbbdb3','#c6b2a7','#cebbb0','#c3b5ad','#c7b9b0'];
      rect(Math.max(0,x),y,Math.min(LENGTH,x+2.46)-Math.max(0,x),Math.min(.42,HEIGHT-y),colours[n]!);
      if(x>0)line(x,y,x,Math.min(HEIGHT,y+.42),'#9a928a',.024);
    }
    line(0,y,LENGTH,y,'#a59a91',.024);
  }
  rect(0,0,LENGTH,.25,'#928b80');
  rect(0,6.58,LENGTH,.11,'#d5c7ba');
  rect(0,7.04,LENGTH,.14,'#e0d0bf');
  rect(0,7.18,LENGTH,.13,'#aaa093');
  for(let i=0;i<11;i++) {
    const cx=(i+.5)*LENGTH/11, r=.70, bottom=.28, spring=4.85;
    const opening=`M${cx-r},${HEIGHT-bottom} L${cx-r},${HEIGHT-spring} A${r},${r} 0 0 1 ${cx+r},${HEIGHT-spring} L${cx+r},${HEIGHT-bottom} Z`;
    parts.push(`<path d="${opening}" data-feature="parliament-south-arched-opening-${i+1}" fill="#30494f" stroke="#a19080" stroke-width=".12"/>`);
    line(cx,bottom,cx,spring+r,'#84948c',.055);
    for(let y=1.2;y<spring;y+=.87)line(cx-r+.07,y,cx+r-.07,y,'#738580',.045);
    line(cx-r+.06,spring,cx+r-.06,spring,'#8f9a8e',.055);
    line(cx-r+.08,.47,cx+r-.08,.47,'#1c3338',.10);
  }
  const p=PARLIAMENT_PIXELS;
  const child=`<svg x="${p[0]}" y="${p[1]}" width="${p[2]}" height="${p[3]}" viewBox="0 0 ${LENGTH} ${HEIGHT}" preserveAspectRatio="none">${parts.join('')}</svg>`;
  const previous=renderCanalsideAtlasSvg(),end=previous.lastIndexOf('</svg>');
  return previous.slice(0,end)+child+previous.slice(end);
}

type Engineering={source:{building:string;vtj:string;triangleIds:number[];cityJsonSha256:string;cityBinSha256:string;baseIndexSha256:string};sourceAreaMetres2:number;chartFrameForEngineeringOnly:FacadeChart;levels:{lod0:{sha256:string;selected:FacadeChartTarget[]};lod2:{sha256:string;selected:FacadeChartTarget[]}}};
const targets=(rows:FacadeChartTarget[])=>rows.map(t=>({node:t.node,primitive:t.primitive,triangle:t.triangle,key:t.key,chart:'parliament-south-lower-wing'}));
export async function authorParliamentLowerChart(engineeringFile:string,output:string) {
  const previousBytes=fs.readFileSync(path.join(root,oldDirectory,'profile.json'));assert.equal(sha(previousBytes),oldProfileHash);
  const previous=JSON.parse(previousBytes.toString()) as FacadeChartProfile;
  assert.equal(sha(fs.readFileSync(path.join(root,sourcePlanesPath))),sourcePlanesHash);
  assert.equal(sha(fs.readFileSync(path.join(root,referenceDirectory,'parliament-architecture-museum-2.jpg'))),imageHash);
  const engineeringBytes=fs.readFileSync(engineeringFile);
  assert.equal(sha(engineeringBytes),'7621e8f7192a21f551bbad75cf7b2979abf80ee9a6963e4e8b104138cbccb031','Reviewed Parliament selectors changed');
  const e=JSON.parse(engineeringBytes.toString()) as Engineering;
  assert.equal(e.source.building,'BID_31acb401-f0ce-43c6-aed2-167cbed5d05e');assert.equal(e.source.vtj,'1031902037');
  assert.deepEqual(e.source.triangleIds,[665,666]);assert.equal(e.source.baseIndexSha256,previous.baseCellsIndexSha256,'Use the same initial base; root rebinds the complete profile once final hashes are known');
  assert.equal(e.source.cityJsonSha256,previous.source.cityJsonSha256);assert.equal(e.source.cityBinSha256,previous.source.cityBinSha256);
  assert.equal(e.levels.lod0.selected.length,2);assert.equal(e.levels.lod2.selected.length,2);
  assert.ok(!fs.existsSync(output),'Fresh combined artwork output required');fs.mkdirSync(output,{recursive:true});
  const svg=renderParliamentCombinedAtlasSvg(),png=await sharp(Buffer.from(svg)).ensureAlpha().png({compressionLevel:9,adaptiveFiltering:false}).toBuffer();
  const profile:FacadeChartProfile={...previous,id:'canalside-and-parliament-lower-wing-v2',art:{...previous.art,sha256:sha(png),attribution:'Original procedural Palace east, Main Guard south and Parliament south lower-wing artwork, Helsinki browser-game project (2026), CC0-1.0. Reference photographs are not reproduced.',references:[...previous.art.references,...references]},maximumFallbackBytes:facadeAtlasBytes(768,256)*3,
    charts:[...previous.charts,{...e.chartFrameForEngineeringOnly,id:'parliament-south-lower-wing',pixels:PARLIAMENT_PIXELS}],cells:[...previous.cells,{id:'c_m09_m03',lod0Sha256:e.levels.lod0.sha256,lod2Sha256:e.levels.lod2.sha256,buildings:[{id:e.source.building,vtj:e.source.vtj}],detailed:targets(e.levels.lod0.selected),distant:targets(e.levels.lod2.selected)}]};
  validateFacadeChartProfile(profile);
  fs.writeFileSync(path.join(output,'canalside-original.svg'),svg);fs.writeFileSync(path.join(output,'canalside-original.png'),png);fs.writeFileSync(path.join(output,'profile.json'),JSON.stringify(profile,null,2)+'\n');
  const before=await sharp(fs.readFileSync(path.join(root,oldDirectory,'canalside-original.png'))).ensureAlpha().raw().toBuffer(),after=await sharp(png).ensureAlpha().raw().toBuffer();
  let changed=0,outside=0;for(let y=0;y<256;y++)for(let x=0;x<768;x++){const k=(y*768+x)*4;if(!before.subarray(k,k+4).equals(after.subarray(k,k+4))){changed++;if(x<505||x>=767||y<161||y>=254)outside++;}}
  assert.equal(outside,0,'Approved Palace/Guard atlas pixels changed');
  const ledger={schemaVersion:1,id:profile.id,status:'ORIGINAL_ART_FOR_REVIEW_NOT_APPLIED',production:{kind:'original-procedural',license:'CC0-1.0',attribution:profile.art.attribution,referencePixelsCopied:false,geometryChanged:false,art:{path:'canalside-original.png',sha256:sha(png)},profile:{path:'profile.json',sha256:sha(fs.readFileSync(path.join(output,'profile.json')))}},
    previousApproved:{profilePath:`${oldDirectory}/profile.json`,sha256:oldProfileHash,palaceAndGuardChartDeclarationsAndSelectorsUnchanged:true,palaceAndGuardPixelsBitIdentical:true,changedAtlasPixels:changed,changedPixelsOutsideNewChart:outside},
    source:{building:e.source.building,vtj:e.source.vtj,sourcePart:0,sourceTriangleIds:[665,666],engineering:{path:path.relative(root,engineeringFile).replaceAll('\\','/'),sha256:sha(engineeringBytes)},planeDiagnosis:{path:sourcePlanesPath,sha256:sourcePlanesHash},sourceAreaMetres2:e.sourceAreaMetres2,exclusions:'Separate 6.405m stair-side return source661/662; all other wings; source faces above Y11; all authored main-front columns and upper artwork; floors and HCOL.'},
    references:references.map(r=>({...r,productionUse:false})),openedReferences:[{path:`${referenceDirectory}/parliament-architecture-museum-2.jpg`,sha256:imageHash,opened:true,observation:'Tree-free oblique aerial shows the complete south lower front wing with eleven tall round-arched openings, a thin top band and stone courses. Source plane extent/orientation matches this wing beyond the main stairs.'},{path:`${referenceDirectory}/parliament-official-aerial.jpg`,sha256:'df6c581eb44d3038ec4afb03851bfd28c17ee2a42cdbf4b4208d81c393159d01',opened:true,observation:'Contemporary official aerial corroborates extant round arches and pink-gray stone; canopy obscures several exact bay positions, so historical tree-free view supplies the complete count.'}],
    layout:{southLowerWing:{lengthMetres:LENGTH,heightMetres:HEIGHT,archedOpenings:11,openingArrangement:'One evenly spaced row; original flat glazing/grid approximation, not a claim about which doors are open or which interiors exist.',surface:'Pink-gray granite coursing and narrow top stone band.'}},
    approximations:['Metre positions, aperture widths/heights, glazing subdivisions and stone colour/joints are authored visual approximations from opened reference and source dimensions.','No copied reference pixels, tree silhouettes, painted reflections or added mesh geometry.','Source solid wall/collision remains; this chart does not create an enterable building.','Textureless distant source triangles receive a corner-colour approximation only, not full window detail.'],
    memory:{width:768,height:256,ownerCells:3,rgbaMipBytesPerOwner:facadeAtlasBytes(768,256),aggregateFallbackBytes:profile.maximumFallbackBytes},application:{applied:false,initialBase:'data/work/district-expansion-20261018/cells-closed-v2',futureCandidateRebindRequiresNewProfile:true}};
  fs.writeFileSync(path.join(output,'source-ledger.json'),JSON.stringify(ledger,null,2)+'\n');
  return {output,artSha256:sha(png),profileSha256:sha(fs.readFileSync(path.join(output,'profile.json'))),ledgerSha256:sha(fs.readFileSync(path.join(output,'source-ledger.json'))),preservation:{changedPixels:changed,outsideNewChart:outside},maximumFallbackBytes:profile.maximumFallbackBytes};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length,6,'Usage: node tools/world/author-parliament-lower-chart.ts --engineering <source-fit.json> --out <fresh-directory>');assert.equal(process.argv[2],'--engineering');assert.equal(process.argv[4],'--out');
  console.log(JSON.stringify(await authorParliamentLowerChart(path.resolve(process.argv[3]!),path.resolve(process.argv[5]!)),null,2));
}
