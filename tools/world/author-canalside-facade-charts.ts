// Original, reference-led artwork for two explicitly selected source wall planes.
// The photograph files are evidence only: this author never reads image pixels.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';
import {facadeAtlasBytes, facadeChartSha256, validateFacadeChartProfile, type FacadeChart, type FacadeChartProfile, type FacadeChartTarget} from './lib/facade-charts.ts';

export const ATLAS_SIZE = [768, 256] as const;
export const PALACE_PIXELS = [1, 1, 766, 158] as const;
export const GUARD_PIXELS = [1, 161, 500, 93] as const;
const PALACE_LENGTH = 71.14972212152172, PALACE_HEIGHT = 15.615142345428467;
const GUARD_LENGTH = 50.93013047325209, GUARD_HEIGHT = 8.896848678588867;
const LOW_LENGTH = 21.315, HIGH_LENGTH = PALACE_LENGTH - LOW_LENGTH;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sha = facadeChartSha256;
const sourcePins = {
  palace: '0981ce764b633b8405695fbf6446d8600a68dbebe1b34401043eaf4c8c87ddcc',
  guard: '1a48b02f467e101f9da12705aa700021a470ba00784d816ed9d8fb73e4a4d1d2',
};
const references = [
  {title: 'Presidential Palace: official exterior photographs, Matti Porre / Office of the President', url: 'https://www.presidentti.fi/en/pictures/presidential-palace/', role: 'appearance-reference-only' as const},
  {title: 'Presidentinlinna nähtynä Mariankadun puolelta, Finnish Heritage Agency, HK6532_246', url: 'https://www.finna.fi/Record/museovirasto.CD4234EC063271791B3E54AC4FF9844D', role: 'appearance-reference-only' as const},
  {title: 'Presidentinlinna Mariankadun puolelta, Finnish Heritage Agency, 7137_495', url: 'https://www.finna.fi/Record/museovirasto.9434E8449CCD91F7DF6016F25860D541', role: 'appearance-reference-only' as const},
  {title: 'Main Guard canal elevation, Volker von Bonin / Finnish Heritage Agency, published by Yle', url: 'https://yle.fi/a/3-11446975', role: 'appearance-reference-only' as const},
];

class WallArt {
  readonly pieces: string[] = [];
  readonly width: number;
  readonly height: number;
  constructor(width: number, height: number) {this.width=width;this.height=height;}
  rect(x: number, y: number, w: number, h: number, colour: string, extra = '') {
    this.pieces.push(`<rect x="${x}" y="${this.height-y-h}" width="${w}" height="${h}" fill="${colour}" ${extra}/>`);
  }
  line(x1: number, y1: number, x2: number, y2: number, colour: string, width: number) {
    this.pieces.push(`<path d="M${x1},${this.height-y1} L${x2},${this.height-y2}" fill="none" stroke="${colour}" stroke-width="${width}"/>`);
  }
  window(x: number, y: number, w: number, h: number, id: string, ornament = false) {
    this.rect(x-w/2-.14,y-.12,w+.28,h+.26,'#f0ece0',`data-feature="${id}-surround"`);
    this.rect(x-w/2,y,w,h,'#334c50',`data-feature="${id}"`);
    this.rect(x-w/2+.08,y+.08,w/2-.12,h-.16,'#637a7a');
    this.line(x,y,x,y+h,'#d1d3c5',.07);
    this.line(x-w/2,y+h*.45,x+w/2,y+h*.45,'#c3cbc3',.06);
    this.rect(x-w/2-.20,y-.21,w+.40,.13,'#d6cfb9');
    if (ornament) {
      this.rect(x-w/2-.24,y+h+.20,w+.48,.13,'#f2eee1');
      this.line(x-w/2-.24,y+h+.40,x+w/2+.24,y+h+.40,'#c6bca3',.08);
    }
  }
  svg(pixels: readonly [number,number,number,number]) {
    return `<svg x="${pixels[0]}" y="${pixels[1]}" width="${pixels[2]}" height="${pixels[3]}" viewBox="0 0 ${this.width} ${this.height}" preserveAspectRatio="none">${this.pieces.join('')}</svg>`;
  }
}

/** All bay counts come from opened elevation photographs; dimensions are an approximation. */
export function renderCanalsideAtlasSvg(): string {
  const palace = new WallArt(PALACE_LENGTH,PALACE_HEIGHT);
  palace.rect(0,0,PALACE_LENGTH,PALACE_HEIGHT,'#ead9a8');
  // The low south wing occupies a separate source height envelope.
  palace.rect(0,0,PALACE_LENGTH,.66,'#91928a');
  for(let y=.2;y<.7;y+=.28) palace.line(0,y,PALACE_LENGTH,y,'#6f7775',.025);
  for(let x=0;x<PALACE_LENGTH;x+=1.05) palace.line(x,0,x,.66,'#6f7775',.025);
  for(let y=.94;y<4.8;y+=.42) palace.line(0,y,PALACE_LENGTH,y,'#ccb98d',.028);
  for(let y=1.36;y<4.8;y+=.84) for(let x=.75;x<PALACE_LENGTH;x+=2.4) palace.line(x,y-.42,x,y,'#d4c29c',.022);
  palace.rect(0,4.66,LOW_LENGTH,.20,'#f2ead7');
  palace.rect(0,5.10,LOW_LENGTH,.21,'#f1eddf');
  palace.rect(0,5.31,LOW_LENGTH,.13,'#b4ad96');
  for(let i=0;i<7;i++) palace.window(1.42+i*2.58,1.24,1.22,2.22,`palace-low-window-${i+1}`);
  const lowDoor = 20.0;
  palace.rect(lowDoor-.62,.52,1.24,3.39,'#454f4c','data-feature="palace-low-canopy-door"');
  palace.rect(lowDoor-.80,3.91,1.6,.18,'#dedbcf');
  palace.rect(lowDoor-.99,4.08,1.98,.20,'#464e49');
  palace.line(lowDoor-.77,3.91,lowDoor-.95,4.10,'#41473f',.09);
  palace.line(lowDoor+.77,3.91,lowDoor+.95,4.10,'#41473f',.09);
  palace.line(lowDoor,.55,lowDoor,3.76,'#9b9d8c',.05);

  const first = LOW_LENGTH+1.66, spacing=(HIGH_LENGTH-3.32)/13;
  const axis = (i:number)=>first+i*spacing;
  palace.rect(LOW_LENGTH,4.54,HIGH_LENGTH,.26,'#f0e9d5');
  palace.rect(LOW_LENGTH,9.24,HIGH_LENGTH,.13,'#f4eddc');
  palace.rect(LOW_LENGTH,13.18,HIGH_LENGTH,.19,'#f4eddd');
  palace.rect(LOW_LENGTH,13.55,HIGH_LENGTH,.29,'#f1eadb');
  palace.rect(LOW_LENGTH,13.84,HIGH_LENGTH,.12,'#a6a18e');
  // The east elevation is not the nineteen-bay Ionic south frontage.
  for(let i=0;i<14;i++) palace.window(axis(i),5.14,1.45,3.04,`palace-middle-window-${i+1}`,true);
  for(let i=0;i<9;i++) palace.window(axis(i),10.02,1.18,2.18,`palace-upper-single-${i+1}`);
  const triple=(axis(9)+axis(10))/2;
  for(let i=0;i<3;i++) palace.window(triple+(i-1)*.77,10.02,.58,2.18,`palace-upper-triple-${i+1}`);
  for(let i=11;i<14;i++) palace.window(axis(i),10.02,1.18,2.18,`palace-upper-single-${i-1}`);
  for(let i=0;i<7;i++) palace.window(axis(i),1.22,1.13,2.19,`palace-ground-window-${i+1}`);
  const entrance=axis(7);
  palace.rect(entrance-1.25,.53,2.5,3.86,'#f0e9d8','data-feature="palace-mariankatu-entrance-surround"');
  palace.rect(entrance-.83,.53,1.66,3.22,'#3e4d4c','data-feature="palace-mariankatu-entrance"');
  palace.line(entrance,.53,entrance,3.75,'#999f94',.07);
  palace.rect(entrance-.97,3.77,1.94,.25,'#e9e4d8');
  // The remaining northern ground bays are photographed blind rusticated plaster.
  for(const x of [LOW_LENGTH,LOW_LENGTH+HIGH_LENGTH*.276]) palace.rect(x-.12,4.8,.24,9.02,'#d9c79f');

  const guard = new WallArt(GUARD_LENGTH,GUARD_HEIGHT);
  guard.rect(0,0,GUARD_LENGTH,GUARD_HEIGHT,'#a7bac0');
  guard.rect(0,0,GUARD_LENGTH,1.48,'#777b75');
  for(let y=.28;y<1.48;y+=.40) guard.line(0,y,GUARD_LENGTH,y,'#545f5e',.035);
  for(let x=.2;x<GUARD_LENGTH;x+=1.55) guard.line(x,0,x,1.48,'#606b68',.035);
  guard.rect(0,1.48,GUARD_LENGTH,.17,'#e1e3da');
  guard.rect(0,5.60,GUARD_LENGTH,.24,'#ecece2');
  guard.rect(0,8.03,GUARD_LENGTH,.26,'#ecece2');
  guard.rect(0,8.38,GUARD_LENGTH,.25,'#e6e7dd');
  guard.rect(0,8.63,GUARD_LENGTH,.16,'#687c80');
  const bay=GUARD_LENGTH/6;
  for(let i=0;i<=6;i++) {
    const x=i*bay;
    guard.rect(x-.80,1.64,1.60,6.38,'#e9e9df');
    for(let y=1.88;y<8.03;y+=.5) guard.line(x-.80,y,x+.80,y,'#c2c9c6',.045);
  }
  for(let i=0;i<6;i++) {
    const cx=(i+.5)*bay,r=3.21,base=5.92;
    // These are blind stucco arcades, not full-height glazed openings.
    guard.pieces.push(`<path data-feature="guard-blind-arcade-${i+1}" d="M${cx-r},${GUARD_HEIGHT-base} A${r},${r*.66} 0 0 1 ${cx+r},${GUARD_HEIGHT-base}" fill="none" stroke="#eff0e5" stroke-width=".38"/>`);
    guard.pieces.push(`<path d="M${cx-r+.29},${GUARD_HEIGHT-base} A${r-.29},${(r-.29)*.66} 0 0 1 ${cx+r-.29},${GUARD_HEIGHT-base}" fill="none" stroke="#7e989f" stroke-width=".10"/>`);
    guard.window(cx,4.15,2.08,1.14,`guard-high-window-${i+1}`);
  }
  guard.rect(4.5*bay-.72,.10,1.44,2.55,'#4b5550','data-feature="guard-service-door-bay-5"');
  guard.rect(4.5*bay-.88,.10,.16,2.71,'#e3e4d9');
  guard.rect(4.5*bay+.72,.10,.16,2.71,'#e3e4d9');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="768" height="256"><rect width="768" height="256" fill="#d6d4c6"/>${palace.svg(PALACE_PIXELS)}${guard.svg(GUARD_PIXELS)}</svg>`;
}

type Engineering = {source:{building:string;vtj:string;cityJsonSha256:string;cityBinSha256:string;baseIndexSha256:string};chartFrameForEngineeringOnly:FacadeChart;levels:{lod0:{sha256:string;selected:FacadeChartTarget[]};lod2:{sha256:string;selected:FacadeChartTarget[]}}};
function readEngineering(relative:string,pin:string):Engineering {const bytes=fs.readFileSync(path.resolve(root,relative));assert.equal(sha(bytes),pin,'Engineering source selector hash changed');return JSON.parse(bytes.toString());}
function selected(rows:readonly FacadeChartTarget[],chart:string):FacadeChartTarget[] {return rows.map(t=>({node:t.node,primitive:t.primitive,triangle:t.triangle,key:t.key,chart}));}
export async function authorCanalsideCharts(output:string) {
  const palacePath='data/evidence/district-expansion-20261018/facade-chart-engineering-v1/source-fit.json';
  const guardPath='data/evidence/district-expansion-20261018/facade-chart-guard-engineering-v1/source-fit.json';
  const p=readEngineering(palacePath,sourcePins.palace),g=readEngineering(guardPath,sourcePins.guard);
  assert.deepEqual(p.source.cityJsonSha256,g.source.cityJsonSha256);assert.equal(p.source.baseIndexSha256,g.source.baseIndexSha256);
  const base=path.resolve(root,'data/work/district-expansion-20261018/cells-closed-v2/cells.json');assert.equal(sha(fs.readFileSync(base)),p.source.baseIndexSha256,'Initial profile must bind selected closure candidate');
  assert.ok(!fs.existsSync(output),'Fresh artwork output directory required');fs.mkdirSync(output,{recursive:true});
  const svg=renderCanalsideAtlasSvg(),png=await sharp(Buffer.from(svg)).ensureAlpha().png({compressionLevel:9,adaptiveFiltering:false}).toBuffer();
  fs.writeFileSync(path.join(output,'canalside-original.svg'),svg);fs.writeFileSync(path.join(output,'canalside-original.png'),png);
  const profile:FacadeChartProfile={schemaVersion:1,id:'canalside-palace-east-main-guard-south-v1',baseCellsIndexSha256:p.source.baseIndexSha256,
    source:{cityJsonSha256:p.source.cityJsonSha256,cityBinSha256:p.source.cityBinSha256,originId:'senate-square-statue-v2'},
    art:{path:'canalside-original.png',sha256:sha(png),width:768,height:256,kind:'original-procedural',license:'CC0-1.0',attribution:'Original procedural Palace east and Main Guard south facade artwork, Helsinki browser-game project (2026). Reference photographs are not reproduced.',references},
    maximumFallbackBytes:facadeAtlasBytes(768,256)*2,material:{name:'canalside-original-palace-guard',unlit:true,roughness:.95,doubleSided:true},
    charts:[{...p.chartFrameForEngineeringOnly,id:'palace-east',pixels:PALACE_PIXELS},{...g.chartFrameForEngineeringOnly,id:'main-guard-south',pixels:GUARD_PIXELS}],
    cells:[{id:'c_p01_p00',lod0Sha256:p.levels.lod0.sha256,lod2Sha256:p.levels.lod2.sha256,buildings:[{id:p.source.building,vtj:p.source.vtj}],detailed:selected(p.levels.lod0.selected,'palace-east'),distant:selected(p.levels.lod2.selected,'palace-east')},
      {id:'c_p02_p00',lod0Sha256:g.levels.lod0.sha256,lod2Sha256:g.levels.lod2.sha256,buildings:[{id:g.source.building,vtj:g.source.vtj}],detailed:selected(g.levels.lod0.selected,'main-guard-south'),distant:selected(g.levels.lod2.selected,'main-guard-south')}]};
  validateFacadeChartProfile(profile);fs.writeFileSync(path.join(output,'profile.json'),JSON.stringify(profile,null,2)+'\n');
  const refsDirectory='data/evidence/district-expansion-20261018/blank-canalside-facades-v1/references';
  const opened=['presidentinlinna-ulkoa.jpg','palace-east-heritage-a.jpg','palace-east-heritage-b.jpg','palace-east-heritage-c.jpg','main-guard-museum-wide.jpg','main-guard-citymuseum.jpg','main-guard-museum-portico.jpg'];
  const ledger={schemaVersion:1,id:profile.id,status:'ORIGINAL_ART_FOR_REVIEW_NOT_APPLIED',production:{kind:'original-procedural',license:'CC0-1.0',attribution:profile.art.attribution,art:{path:'canalside-original.png',sha256:sha(png)},svg:{path:'canalside-original.svg',sha256:sha(svg)},profile:{path:'profile.json',sha256:sha(fs.readFileSync(path.join(output,'profile.json')))},referencePixelsCopied:false,sourceGeometryChanged:false},
    sourceBindings:[{path:palacePath,sha256:sourcePins.palace},{path:guardPath,sha256:sourcePins.guard}],
    referenceRoute:{streetView:'Attempted sanctioned Chrome and in-app-browser Street View; neither browser is enabled; cua.getState returned no browser/app surfaces. No headless Maps/browser bypass used.',fallback:'Actually opened official President and Finnish Heritage Agency/museum photographs. Photograph files remain evidence only.'},
    references:references.map(r=>({...r,productionUse:false})),openedFiles:opened.map(name=>({path:`${refsDirectory}/${name}`,sha256:sha(fs.readFileSync(path.resolve(root,refsDirectory,name))),opened:true})),
    layout:{palaceEast:{sourceFaceTriangles:14,sourceAreaMetres2:810.2306386600922,direction:'Image left is south (u=-71.149722), right is north (u=0).',southLowWing:{approximateLengthMetres:LOW_LENGTH,rectangularWindows:7,canopyDoors:1},highWing:{middleWindows:14,upperSingleWindows:12,upperThreeLightGroups:1,upperThreeLightOpenings:3,groundWindows:7,mariankatuEntrances:1,northGroundRemainder:'blind rusticated plaster, no added windows'},excluded:'South Ionic frontage, west and courtyard elevations, roofs, nonselected faces.'},
      mainGuardSouth:{sourceFaceTriangles:12,sourceAreaMetres2:311.37019621909093,direction:'Image left is west, right is east.',blindArcades:6,smallHighWindows:6,serviceDoorBayFromWest:5,excluded:'West portico, southeast chamfer, courtyard and separately textured BID_ff36e6db-4dc7-4610-b2ab-6db26acfaed3.'}},
    approximations:['Opening positions and dimensions, cornice/moulding widths, masonry joints and colours are authored approximations fitted to source plane dimensions and opened photographs; no engineering survey accuracy is claimed.','Glazing is flat original artwork, without inferred interior rooms or reflected photographed trees.','Historical photographs establish east opening layout; official contemporary exterior photos corroborate pale yellow plaster/white trim/stone plinth.','Main Guard south blue-gray plaster is supported by the opened colour photo and contemporary article; the west portico column pattern is intentionally excluded.'],
    memory:{atlasWidth:768,atlasHeight:256,ownerCells:2,rgba8FullMipChainBytesPerOwner:facadeAtlasBytes(768,256),aggregateFallbackBytes:profile.maximumFallbackBytes},application:{applied:false,initialBase:'data/work/district-expansion-20261018/cells-closed-v2',futureRebind:'After final floor-phase hashes are known, bind exact unchanged source triangle keys to the fresh candidate before application.'}};
  fs.writeFileSync(path.join(output,'source-ledger.json'),JSON.stringify(ledger,null,2)+'\n');
  return {output,profileSha256:sha(fs.readFileSync(path.join(output,'profile.json'))),artSha256:sha(png),ledgerSha256:sha(fs.readFileSync(path.join(output,'source-ledger.json'))),maximumFallbackBytes:profile.maximumFallbackBytes};
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  assert.equal(process.argv.length,4,'Usage: node tools/world/author-canalside-facade-charts.ts --out <fresh-directory>');assert.equal(process.argv[2],'--out');
  console.log(JSON.stringify(await authorCanalsideCharts(path.resolve(process.argv[3]!)),null,2));
}
