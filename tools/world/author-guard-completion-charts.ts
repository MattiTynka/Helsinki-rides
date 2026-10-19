// Complete only the six reviewed Guard faces in a NEW atlas/profile.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';
import polygonClipping from 'polygon-clipping';
import {NodeIO} from '@gltf-transform/core';
import {ALL_EXTENSIONS} from '@gltf-transform/extensions';
import {MeshoptDecoder} from 'meshoptimizer';
import {facadeAtlasBytes,facadeChartSha256 as sha,facadeTriangleKey,validateFacadeChartProfile,type FacadeChart,type FacadeChartProfile,type FacadeChartTarget,type FacadeTriangle} from './lib/facade-charts.ts';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const previousDirectory='content/helsinki/district-expansion/facade-charts/canalside-v2';
const previousProfileSha='bab5283bb16f29162715f0173c65ff8f3f39c5d608dff3adbabf089318c009d0';
const previousArtSha='52649294ba19d27630d1759b08051a8ddfcbfaa8aa1266cf8384f51617050935';
export const GUARD_SOUTHEAST_PIXELS=[3,3,220,44] as const;
export const GUARD_RECESS_PIXELS=[3,52,220,44] as const;
type Engineering={source:{building:string;vtj:string;triangleIds:number[];baseIndexSha256:string;cityJsonSha256:string;cityBinSha256:string};chartFrameForEngineeringOnly:FacadeChart;levels:{lod0:{selected:(FacadeChartTarget&{vertices:FacadeTriangle})[]};lod2:{selected:FacadeChartTarget[]}}};
export type GuardCompletionLayout={recessChart:FacadeChart;chamferChart:FacadeChart;recessWorldStationBounds:readonly[number,number];recessSvgYBounds:readonly[number,number]};
const dot=(a:readonly number[],b:readonly number[])=>a.reduce((s,v,i)=>s+v*b[i]!,0);
const vertices=(e:Engineering)=>e.levels.lod0.selected.flatMap(t=>t.vertices);

export function guardCompletionLayout(previous:FacadeChartProfile,recess:Engineering,chamfer:Engineering):GuardCompletionLayout {
  const old=previous.charts.find(c=>c.id==='main-guard-south')!,r=recess.chartFrameForEngineeringOnly,c=chamfer.chartFrameForEngineeringOnly;
  const stations=vertices(recess).map(v=>dot(v.map((n,i)=>n-old.origin[i]!),old.uAxis));
  const minY=Math.min(...vertices(recess).map(v=>v[1])),maxY=Math.max(...vertices(recess).map(v=>v[1]));
  const oldBaseY=old.origin[1]+old.bounds[1],oldHeight=old.bounds[3]-old.bounds[1];
  // Using the same world-station axis gives the same six-bay rhythm despite the
  // slightly different source plane normal. Affine projection is exact here.
  const k=dot(r.uAxis,old.uAxis),offset=dot(r.origin.map((v,i)=>v-old.origin[i]!),old.uAxis);
  const minU=Math.min(...stations),maxU=Math.max(...stations);
  assert.ok(k>.9999 && minU>16 && maxU<34);
  return {recessChart:{...r,id:'main-guard-south-recess',bounds:[(minU-offset)/k,minY-r.origin[1],(maxU-offset)/k,maxY-r.origin[1]],pixels:GUARD_RECESS_PIXELS},
    chamferChart:{...c,id:'main-guard-southeast',pixels:GUARD_SOUTHEAST_PIXELS},recessWorldStationBounds:[minU,maxU],recessSvgYBounds:[oldHeight-(maxY-oldBaseY),oldHeight-(minY-oldBaseY)]};
}

/** Uses already-authored SVG shape primitives, never reference-photo pixels. */
export function renderGuardCompletionAtlasSvg(previousSvg:string,layout:GuardCompletionLayout):string {
  const match=previousSvg.match(/<svg x="1" y="161"[^>]*>([\s\S]*?)<\/svg>/);assert.ok(match,'Approved Guard original SVG is absent');
  const [u0,u1]=layout.recessWorldStationBounds,[y0,y1]=layout.recessSvgYBounds;
  const rec=GUARD_RECESS_PIXELS,recess=`<svg x="${rec[0]}" y="${rec[1]}" width="${rec[2]}" height="${rec[3]}" viewBox="${u0} ${y0} ${u1-u0} ${y1-y0}" preserveAspectRatio="none"><rect x="${u0}" y="${y0}" width="${u1-u0}" height="${y1-y0}" fill="#a7bac0"/>${match[1]}</svg>`;
  const b=layout.chamferChart.bounds,width=b[2]-b[0],height=b[3]-b[1],parts:string[]=[];
  const rect=(x:number,y:number,w:number,h:number,c:string,extra='')=>parts.push(`<rect x="${x}" y="${height-y-h}" width="${w}" height="${h}" fill="${c}" ${extra}/>`);
  const line=(x1:number,y1:number,x2:number,y2:number,c:string,w:number)=>parts.push(`<path d="M${x1},${height-y1} L${x2},${height-y2}" stroke="${c}" stroke-width="${w}" fill="none"/>`);
  rect(0,0,width,height,'#a7bac0');rect(0,0,width,1.48,'#777b75');
  for(let y=.28;y<1.48;y+=.40)line(0,y,width,y,'#545f5e',.035);
  for(let x=.2;x<width;x+=1.55)line(x,0,x,1.48,'#606b68',.035);
  rect(0,1.48,width,.17,'#e1e3da');rect(0,5.60,width,.24,'#ecece2');
  rect(0,height-.78,width,.22,'#ecece2');rect(0,height-.40,width,.23,'#e6e7dd');rect(0,height-.17,width,.17,'#687c80');
  const bay=width/5;
  for(let i=0;i<=5;i++){const x=i*bay;rect(x-.29,1.65,.58,height-2.43,'#e9e9df');for(let y=1.88;y<height-.78;y+=.5)line(x-.29,y,x+.29,y,'#c2c9c6',.035);}
  for(let i=0;i<5;i++){
    const cx=(i+.5)*bay,r=bay*.39,base=5.92;
    parts.push(`<path data-feature="guard-southeast-blind-arcade-${i+1}" d="M${cx-r},${height-base} A${r},${r} 0 0 1 ${cx+r},${height-base}" fill="none" stroke="#eff0e5" stroke-width=".25"/>`);
    parts.push(`<path d="M${cx-r+.20},${height-base} A${r-.20},${r-.20} 0 0 1 ${cx+r-.20},${height-base}" fill="none" stroke="#7e989f" stroke-width=".07"/>`);
    rect(cx-.72,4.02,1.44,1.10,'#f0ece0');rect(cx-.59,4.15,1.18,.84,'#334c50',`data-feature="guard-southeast-high-window-${i+1}"`);
    line(cx,4.15,cx,4.99,'#c3cbc3',.055);line(cx-.59,4.57,cx+.59,4.57,'#c3cbc3',.045);
  }
  const p=GUARD_SOUTHEAST_PIXELS,chamferSvg=`<svg x="${p[0]}" y="${p[1]}" width="${p[2]}" height="${p[3]}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">${parts.join('')}</svg>`;
  const end=previousSvg.lastIndexOf('</svg>');return previousSvg.slice(0,end)+chamferSvg+recess+previousSvg.slice(end);
}

const polygon=(r:readonly number[],padding=0):polygonClipping.Polygon=>{const x=r[0]!-padding,y=r[1]!-padding,w=r[2]!+2*padding,h=r[3]!+2*padding;return[[[x,y],[x+w,y],[x+w,y+h],[x,y+h],[x,y]]];};
const area=(m:polygonClipping.MultiPolygon)=>m.reduce((s,p)=>s+p.reduce((a,r,i)=>{let z=0;for(let j=0;j<r.length-1;j++)z+=r[j]![0]*r[j+1]![1]-r[j+1]![0]*r[j]![1];return a+(i?-1:1)*Math.abs(z)/2;},0),0);
/** Read the actual currently rendered UVs, including Float32 encoding. */
export async function proveUnusedAtlasStrips(profile:FacadeChartProfile) {
  const base=path.join(root,'data/work/district-expansion-20261018/cells-charts-v2'),indexBytes=fs.readFileSync(path.join(base,'cells.json')),index=JSON.parse(indexBytes.toString());
  await MeshoptDecoder.ready;const io=new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({'meshopt.decoder':MeshoptDecoder}),rows=[];
  for(const selected of profile.cells){const cell=index.cells.find((c:{id:string})=>c.id===selected.id);assert.ok(cell);const bytes=fs.readFileSync(path.join(base,cell.visual.lod0.path));assert.equal(sha(bytes),cell.visual.lod0.sha256);
    const keys=new Set(selected.detailed.map(t=>t.key)),doc=await io.readBinary(bytes),triangles:readonly[number,number][][]=[];
    for(const node of doc.getRoot().listNodes())for(const primitive of node.getMesh()?.listPrimitives()??[]){const P=primitive.getAttribute('POSITION')!,I=primitive.getIndices()!,UV=primitive.getAttribute('TEXCOORD_0'),M=node.getWorldMatrix();
      for(let t=0;t<I.getCount()/3;t++){const ids=[0,1,2].map(k=>I.getScalar(t*3+k)),v=ids.map(i=>{const q=P.getElement(i,[]);return[Math.fround(M[0]!*q[0]!+M[4]!*q[1]!+M[8]!*q[2]!+M[12]!),Math.fround(M[1]!*q[0]!+M[5]!*q[1]!+M[9]!*q[2]!+M[13]!),Math.fround(M[2]!*q[0]!+M[6]!*q[1]!+M[10]!*q[2]!+M[14]!)];}) as unknown as FacadeTriangle;
        if(keys.has(facadeTriangleKey(v))){assert.ok(UV);(triangles as [number,number][][]).push(ids.map(i=>{const q=UV.getElement(i,[]);return[q[0]!*768,q[1]!*256];}));}}
    }
    assert.equal(triangles.length,keys.size);const strips=[GUARD_SOUTHEAST_PIXELS,GUARD_RECESS_PIXELS].map(rect=>{const overlap=triangles.reduce((s,t)=>s+area(polygonClipping.intersection([[...t,t[0]!]] as polygonClipping.Polygon,polygon(rect,1))),0);assert.equal(overlap,0,'New chart touches a used old texel footprint');return{pixels:rect,paddingPixels:1,usedTriangleOverlapPixels2:overlap};});
    rows.push({cell:selected.id,lod0Sha256:sha(bytes),sourceTriangles:triangles.length,strips,actualUvTriangles:triangles});
  }
  return{indexPath:'data/work/district-expansion-20261018/cells-charts-v2/cells.json',indexSha256:sha(indexBytes),basis:'Actual old Float32 rendered UV triangle union, expanded new rectangles by1pixel for conservative base-level texel taps.',rows,limitation:'Full mip-chain pixels necessarily change; final native close/distant visual review remains required.'};
}

export async function authorGuardCompletion(recessFile:string,chamferFile:string,output:string) {
  const previousBytes=fs.readFileSync(path.join(root,previousDirectory,'profile.json'));assert.equal(sha(previousBytes),previousProfileSha);const previous=JSON.parse(previousBytes.toString()) as FacadeChartProfile;
  const oldPng=fs.readFileSync(path.join(root,previousDirectory,'canalside-original.png'));assert.equal(sha(oldPng),previousArtSha);
  const read=(file:string,ids:number[],pin:string)=>{const bytes=fs.readFileSync(file);assert.equal(sha(bytes),pin,'Reviewed Guard source selector receipt changed');const e=JSON.parse(bytes.toString()) as Engineering;assert.equal(e.source.building,'BID_582cc5c9-65ce-4d61-ab46-f8f1b31b5731');assert.deepEqual(e.source.triangleIds,ids);assert.equal(e.source.baseIndexSha256,previous.baseCellsIndexSha256);assert.equal(e.source.cityJsonSha256,previous.source.cityJsonSha256);assert.equal(e.source.cityBinSha256,previous.source.cityBinSha256);assert.equal(e.levels.lod0.selected.length,ids.length);assert.equal(e.levels.lod2.selected.length,ids.length);return{e,sha256:sha(bytes),path:path.relative(root,file).replaceAll('\\','/')};};
  const recess=read(recessFile,[117,120,121,122],'68f5192f77c9d24ed526bfdba28e65105cbc347c59628e627e8cb966b47ab012'),chamfer=read(chamferFile,[164,165],'41f8596f26f0688a37e163624f1519ff9ecb9bcaad8533903d831022bb6d23b4'),layout=guardCompletionLayout(previous,recess.e,chamfer.e),packing=await proveUnusedAtlasStrips(previous);
  const svg=renderGuardCompletionAtlasSvg(fs.readFileSync(path.join(root,previousDirectory,'canalside-original.svg'),'utf8'),layout),png=await sharp(Buffer.from(svg)).ensureAlpha().png({compressionLevel:9,adaptiveFiltering:false}).toBuffer();
  const targets=(e:Engineering,chart:string)=>e.levels.lod0.selected.map(t=>({node:t.node,primitive:t.primitive,triangle:t.triangle,key:t.key,chart})),distant=(e:Engineering,chart:string)=>e.levels.lod2.selected.map(t=>({node:t.node,primitive:t.primitive,triangle:t.triangle,key:t.key,chart}));
  const profile:FacadeChartProfile={...previous,id:'canalside-three-landmarks-guard-complete-v3',art:{...previous.art,sha256:sha(png),references:[...previous.art.references,{title:'Complete Main Guard southeast elevation: five blind arches and five high windows, Helsinki City Museum architecture record, image2',url:'https://www.finna.fi/Record/hkm.E7295B4D-1D26-4351-9F57-1D2A3DC096A2',role:'appearance-reference-only'}]},charts:[...previous.charts,layout.recessChart,layout.chamferChart],cells:previous.cells.map(c=>c.id==='c_p02_p00'?{...c,detailed:[...c.detailed,...targets(recess.e,layout.recessChart.id),...targets(chamfer.e,layout.chamferChart.id)],distant:[...c.distant,...distant(recess.e,layout.recessChart.id),...distant(chamfer.e,layout.chamferChart.id)]}:c)};
  validateFacadeChartProfile(profile);assert.equal(profile.maximumFallbackBytes,facadeAtlasBytes(768,256)*3);
  const before=await sharp(oldPng).ensureAlpha().raw().toBuffer(),after=await sharp(png).ensureAlpha().raw().toBuffer();let changed=0,outside=0;
  for(let y=0;y<256;y++)for(let x=0;x<768;x++){const k=(y*768+x)*4;if(!before.subarray(k,k+4).equals(after.subarray(k,k+4))){changed++;if(![GUARD_SOUTHEAST_PIXELS,GUARD_RECESS_PIXELS].some(([a,b,w,h])=>x>=a&&x<a+w&&y>=b&&y<b+h))outside++;}}
  assert.equal(outside,0);assert.ok(!fs.existsSync(output),'Fresh v3 directory required');fs.mkdirSync(output,{recursive:true});fs.writeFileSync(path.join(output,'canalside-original.svg'),svg);fs.writeFileSync(path.join(output,'canalside-original.png'),png);fs.writeFileSync(path.join(output,'profile.json'),JSON.stringify(profile,null,2)+'\n');
  const ref='data/evidence/district-expansion-20261018/blank-canalside-facades-v1/references/main-guard-museum-2.jpg';
  const ledger={schemaVersion:1,id:profile.id,status:'ORIGINAL_ART_FOR_REVIEW_NOT_APPLIED',production:{kind:'original-procedural',license:'CC0-1.0',attribution:profile.art.attribution,referencePixelsCopied:false,geometryChanged:false,art:{path:'canalside-original.png',sha256:sha(png)},profile:{path:'profile.json',sha256:sha(fs.readFileSync(path.join(output,'profile.json')))}},previousApproved:{profilePath:previousDirectory+'/profile.json',profileSha256:previousProfileSha,artSha256:previousArtSha,oldChartDeclarationsUnchanged:true,oldTargetSelectorsUnchanged:true,changedAtlasPixels:changed,changedPixelsOutsideTwoUnusedStrips:outside,usedPalaceGuardParliamentBaseTexelsUnchanged:true},sourceBindings:[{path:recess.path,sha256:recess.sha256},{path:chamfer.path,sha256:chamfer.sha256}],layout,
    guardRecess:{sourceTriangleIds:[117,120,121,122],worldStationBounds:layout.recessWorldStationBounds,southRhythm:'Original six-bay world stations are cropped, not restarted: only bays3 and4 fall in the recess.',verticalMapping:'Existing window/sill/plinth worldY is preserved exactly. The approximately0.91m extra source height above the main front has original blue plaster without invented openings.',sourceGeometryUnchanged:true},
    guardSoutheast:{sourceTriangleIds:[164,165],blindArcades:5,smallHighWindows:5,doorsAdded:0,reference:'Complete southeast plane visible in actually opened primary CityMuseum architecture record image2. The older colour wide crops this elevation and supplies colour/material corroboration only.'},
    references:[{path:ref,sha256:sha(fs.readFileSync(path.join(root,ref))),recordUrl:'https://www.finna.fi/Record/hkm.E7295B4D-1D26-4351-9F57-1D2A3DC096A2',index:2,opened:true,role:'appearance-reference-only',productionPixels:false}],packingProof:packing,
    unchangedBackgroundSourceArt:[{building:'BID_9a46dd48-ee3e-4ab1-a3fa-4f99b02a4b5b',vtj:'1030176577',address:'Pohjoisranta2',reason:'Original source-flat distant background, not applied texture loss; outside these named facade charts.'},{building:'BID_7f599675-2086-4b5a-8335-5a802dc3b6ac',vtj:'1030176588',address:'Pohjoisranta2',reason:'Original source-flat distant background, not applied texture loss; outside these named facade charts.'}],
    approximations:['Dimensions, stone joints, ornament thickness and flat glazing are original visual approximations; no reference photographs are embedded.','Additional recess height is a source massing discrepancy relative to the flat street elevation photograph; extra top blue plaster is not a claim of a surveyed cornice or hidden opening.','Source positions, winding, buildings, roofs, ground, HCOL and all unrelated source faces remain unchanged.'],memory:{atlas:[768,256],ownerCells:3,fullRgbaMipBytes:profile.maximumFallbackBytes},application:{applied:false,initialBase:'cells-closed-v2',requiresNewFinalCandidateProfile:true},limitations:['Source-art limitations of the two identified distant Pohjoisranta2 records remain.','TexturelessLOD2 retains corner-colour approximation; final actual close/distant appearance and budgets require native review.']};
  fs.writeFileSync(path.join(output,'source-ledger.json'),JSON.stringify(ledger,null,2)+'\n');return{output,artSha256:sha(png),profileSha256:sha(fs.readFileSync(path.join(output,'profile.json'))),ledgerSha256:sha(fs.readFileSync(path.join(output,'source-ledger.json'))),changedPixels:changed,outsideApprovedStrips:outside,memoryBytes:profile.maximumFallbackBytes};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){assert.equal(process.argv.length,8,'Usage: node tools/world/author-guard-completion-charts.ts --recess <source-fit.json> --chamfer <source-fit.json> --out <fresh-directory>');assert.equal(process.argv[2],'--recess');assert.equal(process.argv[4],'--chamfer');assert.equal(process.argv[6],'--out');console.log(JSON.stringify(await authorGuardCompletion(path.resolve(process.argv[3]!),path.resolve(process.argv[5]!),path.resolve(process.argv[7]!)),null,2));}
