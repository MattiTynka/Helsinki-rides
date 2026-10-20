// Original architectural artwork. References establish layout; no photograph
// pixels are read or copied. Selection is bound to the municipal source triangles.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import sharp from 'sharp';
import {facadeChartSha256 as sha,facadeTriangleKey,validateFacadeTriangle,type FacadeChart,type FacadeTriangle} from './lib/facade-charts.ts';
import type {DeliveryFacadeProfile} from './apply_delivery_facade_charts.ts';

export class OriginalWallArt {
  readonly pieces:string[]=[];
  readonly width:number;readonly minY:number;readonly maxY:number;
  constructor(width:number,minY:number,maxY:number){this.width=width;this.minY=minY;this.maxY=maxY;}
  rect(x:number,y:number,w:number,h:number,colour:string,id=''){
    this.pieces.push(`<rect x="${x}" y="${this.maxY-y-h}" width="${w}" height="${h}" fill="${colour}"${id?` data-feature="${id}"`:''}/>`);
  }
  line(x1:number,y1:number,x2:number,y2:number,colour:string,width:number){this.pieces.push(`<path d="M${x1},${this.maxY-y1}L${x2},${this.maxY-y2}" stroke="${colour}" stroke-width="${width}" fill="none"/>`);}
  window(x:number,y:number,w:number,h:number,id:string,ornament:'plain'|'cornice'|'pediment'='plain'){
    this.rect(x-w/2-.13,y-.10,w+.26,h+.23,'#ece9dc',id+'-surround');this.rect(x-w/2,y,w,h,'#35494e',id);
    this.rect(x-w/2+.07,y+.07,w/2-.10,h-.14,'#6f8284');this.rect(x+.04,y+.07,w/2-.11,h-.14,'#53686d');
    this.line(x,y+.04,x,y+h-.04,'#d1d4c8',.055);for(const t of [.34,.68])this.line(x-w/2+.04,y+h*t,x+w/2-.04,y+h*t,'#c8cec4',.045);
    this.rect(x-w/2-.21,y-.19,w+.42,.11,'#d7d3c3');this.line(x-w/2-.17,y-.22,x+w/2+.17,y-.22,'#9c998a',.035);
    if(ornament!=='plain'){this.rect(x-w/2-.23,y+h+.11,w+.46,.13,'#f2ecdf');this.line(x-w/2-.25,y+h+.28,x+w/2+.25,y+h+.28,'#a49d8c',.04);}
    if(ornament==='pediment')this.pieces.push(`<path data-feature="${id}-pediment" d="M${x-w/2-.27},${this.maxY-y-h-.29}L${x},${this.maxY-y-h-.84}L${x+w/2+.27},${this.maxY-y-h-.29}Z" fill="#efebdc" stroke="#c7bfa9" stroke-width=".065"/>`);
  }
  door(x:number,y:number,w:number,h:number,id:string){
    this.rect(x-w/2-.18,y,w+.36,h+.23,'#e7e2d4',id+'-surround');this.rect(x-w/2,y,w,h,'#594a3a',id);
    for(const dx of [-w*.25,w*.25])for(const dy of [.15,h*.5])this.rect(x+dx-w*.19,y+dy,w*.38,h*.36,'#75634b');
    this.line(x,y,x,y+h,'#b5a58d',.045);this.rect(x-.08,y+h*.42,.16,.07,'#c4ae7c');
  }
  column(x:number,bottom:number,top:number,w:number,id:string,corinthian=false){
    this.rect(x-w*.75,bottom,w*1.5,.25,'#e5ddc9',id+'-base');this.rect(x-w*.59,bottom+.25,w*1.18,.22,'#e9e2d0');
    this.rect(x-w*.45,bottom+.47,w*.9,top-bottom-.94,'#e5ddc9',id);this.rect(x-w*.45,bottom+.47,w*.18,top-bottom-.94,'#b9b09b');
    for(let f=-2;f<=2;f++)this.line(x+f*w*.14,bottom+.55,x+f*w*.12,top-.5,'#c9bea7',.034);
    this.rect(x-w*.64,top-.46,w*1.28,.22,'#e5ddc9');this.rect(x-w*.77,top-.24,w*1.54,.24,'#e9e2d0');
    if(corinthian)for(const sign of [-1,1])this.pieces.push(`<path d="M${x+sign*w*.15},${this.maxY-top+.43}q${sign*w*.7},-.03 ${sign*w*.5},-.26q${-sign*w*.19},-.17 ${-sign*w*.35},.03" stroke="#aca997" stroke-width=".065" fill="none"/>`);
  }
  svg(pixels:readonly [number,number,number,number]){return `<svg x="${pixels[0]}" y="${pixels[1]}" width="${pixels[2]}" height="${pixels[3]}" viewBox="0 0 ${this.width} ${this.maxY-this.minY}" preserveAspectRatio="none">${this.pieces.join('')}</svg>`;}
}

/** Six central columns/five opening axes; each side wing has four axes. */
export function renderArchiveWall(wall:OriginalWallArt,role:'archive-centre'|'archive-wing',ground:number){
  const W=wall.width,top=wall.maxY;
  wall.rect(0,wall.minY,W,top-wall.minY,'#bea99a');wall.rect(0,wall.minY,W,ground-wall.minY+.60,'#7c7c73','archive-granite-plinth');
  wall.rect(0,ground+.60,W,3.95,'#dedbd0','archive-cream-rusticated-ground');
  for(let y=ground+.68;y<ground+4.5;y+=.48)wall.line(0,y,W,y,'#b9b9ad',.035);
  wall.rect(0,ground+4.55,W,.22,'#f0ede0');wall.rect(0,top-2.62,W,.28,'#f4f0e4');wall.rect(0,top-1.8,W,.32,'#e9e6da');wall.rect(0,top-.68,W,.36,'#f5f0e5');wall.line(0,top-.72,W,top-.72,'#969889',.08);
  const axes=role==='archive-centre'?5:4,step=W/(axes+.4),left=(W-step*(axes-1))/2;
  for(let i=0;i<axes;i++){
    const x=left+i*step;wall.window(x,ground+5.18,1.55,3.25,`${role}-middle-${i+1}`,'cornice');wall.window(x,ground+10.4,1.55,3.0,`${role}-upper-${i+1}`,'plain');
    if(role==='archive-wing'){
      wall.window(x,ground+1.0,.70,1.68,`${role}-barred-base-${i+1}`);for(const k of [-.2,0,.2])wall.line(x+k,ground+1.0,x+k,ground+2.68,'#434a46',.045);
    }
  }
  if(role==='archive-centre'){
    for(let i=0;i<6;i++)wall.column(.65+i*(W-1.3)/5,ground+4.9,top-2.55,.85,`archive-corinthian-column-${i+1}`,true);
    for(let i=0;i<3;i++)wall.door(W/2+(i-1)*step,ground+.22,1.75,3.7,`archive-entrance-${i+1}`);
    // The visible balustrade belongs to the raised central plinth, below the windows.
    wall.rect(.8,ground+4.75,W-1.6,.16,'#f3efe1');for(let x=1.1;x<W-.9;x+=.58)wall.rect(x,ground+4.06,.14,.69,'#eeeadd');wall.rect(.8,ground+4.0,W-1.6,.12,'#dddacb');
  }else{
    for(let i=0;i<5;i++){const x=i*W/4;wall.rect(x-.39,ground+4.8,.78,top-ground-7.42,'#e5ddc9',`archive-wing-pilaster-${i+1}`);wall.rect(x-.55,top-2.6,1.1,.2,'#f2edde');}
  }
}

/** The observed Porthania courtyard has continuous glazing ribbons, not punched classical windows. */
export function renderPorthaniaWall(wall:OriginalWallArt,role:'porthania-five-ribbons'|'porthania-low-glass',ground:number){
  const W=wall.width,top=wall.maxY;wall.rect(0,wall.minY,W,top-wall.minY,'#d4d5d0');
  const module=.82;
  if(role==='porthania-low-glass'){
    wall.rect(0,ground,W,top-ground-.30,'#405a57','porthania-pavilion-glazing');
    for(let x=.16;x<W;x+=module){wall.rect(x,ground+.12,module-.19,top-ground-.53,'#749089');wall.line(x,ground,x,top-.3,'#c9ccc2',.07);}
    wall.rect(0,top-.30,W,.30,'#67877c','porthania-pavilion-copper-fascia');return;
  }
  const step=(top-ground-.9)/5;
  wall.rect(0,ground,W,step-.55,'#3c5553','porthania-ground-glazing');
  for(let x=.13;x<W;x+=module*1.5){wall.rect(x,ground+.16,module*1.5-.24,step-.83,'#768f8a');wall.rect(x-.05,ground,.10,step-.55,'#294f43');}
  for(let row=1;row<5;row++){
    const y=ground+row*step+.35,h=step*.45;wall.rect(0,y,W,h,'#3e5256',`porthania-ribbon-${row}`);
    for(let x=.12;x<W;x+=module){wall.rect(x,y+.07,module-.16,h-.14,'#718387');wall.line(x,y,x,y+h,'#c0c7bf',.055);}
    wall.line(0,y-.08,W,y-.08,'#b3b8b0',.055);wall.line(0,y+h+.10,W,y+h+.10,'#f0f0e7',.06);
  }
  // Fine vertical grooves belong to the opaque spandrels. They do not create new openings.
  for(let row=0;row<5;row++){
    const bottom=row===0?ground+step-.48:ground+row*step+.47+step*.45,finish=Math.min(top-.22,ground+(row+1)*step+.25);
    for(let x=.08;x<W;x+=.16)wall.line(x,bottom,x,finish,'#bfc2ba',.018);
  }
  wall.rect(0,top-.23,W,.23,'#b5bbb3','porthania-roof-edge');
}

/** Physical left/east to right/west: Brummer14, Remander16, Sederholm18. */
export function renderAleksanterinkatuNorth(wall:OriginalWallArt,ground:number){
  const segments=[{start:0,end:16.535,top:6.323,colour:'#d6a898',role:'brummer'},
    {start:16.535,end:35.155,top:9.768,colour:'#dfc17f',role:'remander'},
    {start:35.155,end:wall.width,top:6.611,colour:'#e3e1d6',role:'sederholm'}];
  for(const s of segments){
    const W=s.end-s.start,axis=(i:number)=>s.start+1.2+i*(W-2.4)/6;
    wall.rect(s.start,wall.minY,W,wall.maxY-wall.minY,s.colour,`${s.role}-plaster`);wall.rect(s.start,wall.minY,W,ground-wall.minY+.44,'#777a73',`${s.role}-stone-plinth`);
    const belt=s.role==='remander'?ground+3.88:ground+4.27;wall.rect(s.start,belt,W,.17,'#eee8d7');wall.rect(s.start,s.top-.52,W,.20,'#f2edde');wall.line(s.start,s.top-.57,s.end,s.top-.57,'#a4a18f',.045);
    if(s.role==='remander'){
      for(let i=0;i<7;i++){
        wall.window(axis(i),ground+4.55,1.13,2.6,`remander-middle-${i+1}`,i>=2&&i<=4?'pediment':'cornice');
        wall.window(axis(i),ground+8.63,1.13,2.4,`remander-upper-${i+1}`,'cornice');
      }
      // Current Street View: three eastern windows, a narrow glazed door,
      // another window, then the wider museum entrance at the western end.
      for(let i=0;i<3;i++)wall.window(axis(i),ground+.85,1.12,2.02,`remander-ground-window-${i+1}`);
      wall.rect(axis(3)-.43,ground+.10,.86,2.93,'#405753','remander-narrow-glazed-door');wall.line(axis(3),ground+.10,axis(3),ground+3.03,'#dadbce',.045);
      wall.window(axis(4),ground+.85,1.12,2.02,'remander-ground-window-4');
      const entrance=(axis(5)+axis(6))/2;wall.rect(entrance-1.03,ground+.08,2.06,3.04,'#4b5148','remander-museum-entrance');wall.rect(entrance-1.15,ground+3.12,2.30,.21,'#eeeadc');wall.line(entrance,ground+.08,entrance,ground+3.12,'#8e9282',.06);
    }else if(s.role==='sederholm'){
      for(let i=0;i<7;i++){
        wall.window(axis(i),ground+4.95,1.22,2.83,`sederholm-upper-${i+1}`);
        wall.rect(axis(i)-.76,ground+4.45,1.52,.12,'#eeeadd');for(let k=0;k<7;k++)wall.rect(axis(i)-.66+k*.22,ground+4.57,.075,.36,'#eeecdf');wall.rect(axis(i)-.76,ground+4.93,1.52,.10,'#f2edde');
        if(i<2)wall.door(axis(i),ground+.12,1.14,3.40,`sederholm-eastern-door-${i+1}`);else wall.window(axis(i),ground+.55,1.19,3.00,`sederholm-ground-window-${i-1}`);
      }
      for(let i=0;i<=7;i++){const x=s.start+i*W/7;wall.rect(x-.14,ground+4.37,.28,s.top-ground-4.89,'#f1eee2',`sederholm-pilaster-${i+1}`);}
      for(let y=ground+.64;y<ground+4.15;y+=.48)wall.line(s.start,y,s.end,y,'#c3c4b8',.028);
      // The municipal mesh has no north-facing central gable above this eave.
      // Do not paint it over the top windows or alter the accepted roof geometry.
    }else{
      for(let i=0;i<7;i++)wall.window(axis(i),ground+4.95,1.15,2.53,`brummer-upper-${i+1}`,'cornice');
      // The clear April 2023 panorama resolves the parked-car occlusion in the
      // official historic photograph: eastmost and centre doors, five windows.
      for(let i=0;i<7;i++){
        if(i===0||i===3)wall.door(axis(i),ground+.10,1.17,3.17,`brummer-ground-door-${i===0?1:2}`);
        else{
          wall.window(axis(i),ground+.88,1.15,2.18,`brummer-ground-window-${i<3?i:i-1}`);
          for(const sign of [-1,1]){
            const x=axis(i)+sign*.82-.17;wall.rect(x,ground+.78,.34,2.37,'#564238',`brummer-shutter-${i}-${sign}`);
            for(let k=1;k<=2;k++)wall.line(x+.04,ground+.78+k*.78,x+.30,ground+.78+k*.78,'#83705a',.04);
          }
          wall.rect(axis(i)-.26,ground+.14,.52,.12,'#404b48',`brummer-basement-vent-${i}`);
        }
      }
      wall.rect(s.start,ground+3.96,W,.27,'#eae4d7','brummer-ornamental-frieze');
      for(let i=0;i<7;i++)wall.pieces.push(`<circle cx="${axis(i)}" cy="${wall.maxY-ground-4.10}" r=".075" fill="#c0b6a4"/>`);
    }
  }
}

export function renderPorthaniaEast(wall:OriginalWallArt,role:'porthania-east-five-ribbons'|'porthania-east-glass-inset'|'porthania-east-blank-tile',ground:number){
  const W=wall.width,top=wall.maxY;wall.rect(0,wall.minY,W,top-wall.minY,'#dedfd8');
  // Original small rectangular ceramic/concrete module; no photographic pixels.
  if(role!=='porthania-east-glass-inset')for(let y=wall.minY;y<top;y+=.22){
    wall.line(0,y,W,y,'#c5c9bf',.012);for(let x=.12+(Math.round((y-wall.minY)/.22)%2)*.21;x<W;x+=.42)wall.line(x,y,x,Math.min(top,y+.22),'#c7cbc1',.011);
  }
  if(role==='porthania-east-five-ribbons'){
    const h=1.65,low=ground+.40,high=top-.33-h;
    for(let row=0;row<5;row++){
      const y=low+row*(high-low)/4;wall.rect(0,y,W,h,'#42575b',`porthania-east-ribbon-${row+1}`);
      for(let x=.12;x<W;x+=.78){wall.rect(x,y+.06,.63,h-.12,'#6b7f83');wall.line(x,y,x,y+h,'#2d3839',.045);}
      wall.line(0,y-.06,W,y-.06,'#a8b1aa',.045);
      if(row===0)for(let x=.06;x<W;x+=.16)wall.line(x,y,x,y+h,'#303d39',.045);
    }
  }else if(role==='porthania-east-glass-inset'){
    wall.pieces.push('<defs><linearGradient id="porthania-original-glass" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#8ba3a8"/><stop offset="1" stop-color="#456962"/></linearGradient></defs>');
    const step=(top-ground-.25)/5;wall.rect(0,ground,W,top-ground,'#283432');
    for(let row=0;row<5;row++){
      const y=ground+row*step+.10,h=step*.78;wall.rect(.10,y,W-.20,h,'url(#porthania-original-glass)',`porthania-east-glass-floor-${row+1}`);
      for(let x=.12;x<W;x+=.86)wall.line(x,y,x,y+h,'#303d3b',.055);wall.line(0,y+h,W,y+h,'#939f96',.055);
      if(row===0)for(let x=.04;x<W;x+=.16)wall.line(x,y,x,y+h,'#1d2926',.05);
    }
  }
  wall.rect(0,top-.20,W,.20,'#b8beb4','porthania-east-flat-coping');
}

export interface SenateFacadePlan {
  schemaVersion:1;id:string;baselineManifestSha256:string;
  source:{cityJsonSha256:string;cityBinSha256:string;originId:string};
  references:DeliveryFacadeProfile['art']['references'];
  referenceEvidence?:{url:string;evidenceFile:string;sha256:string;openedPages:number[];productionUse:false}[];
  buildings:{id:string;vtj:string;cell:string;atlas:[number,number];
    elevations:{id:string;triangles:number[];pixels:[number,number,number,number];renderer:string;ground:number;notes:string}[];
    limitations:string[]}[];
}
function sourceTriangles(city:any,bin:Buffer,id:string):FacadeTriangle[]{
  const b=city.buildings.find((q:any)=>q.id===id);assert.ok(b&&b.parts.length===1,'This authored selector expects the pinned single-part blank source building');const p=b.parts[0],r=p.positions,s=p.indices;
  const P=new Float32Array(bin.buffer.slice(bin.byteOffset+r.offset,bin.byteOffset+r.offset+r.bytes)),I=new Uint32Array(bin.buffer.slice(bin.byteOffset+s.offset,bin.byteOffset+s.offset+s.bytes));
  return Array.from({length:I.length/3},(_,t)=>[0,1,2].map(k=>{const v=I[t*3+k]!*3;return [P[v]!,P[v+2]!,-P[v+1]!] as const;}) as unknown as FacadeTriangle);
}
export function chartForSourceTriangles(id:string,building:string,triangles:readonly FacadeTriangle[],pixels:FacadeChart['pixels']):FacadeChart{
  assert.ok(triangles.length);const t=triangles.reduce((best,t)=>Math.hypot(t[1][0]-t[0][0],t[1][2]-t[0][2])>Math.hypot(best[1][0]-best[0][0],best[1][2]-best[0][2])?t:best);
  const a=t[1].map((v,k)=>v-t[0][k]!),b=t[2].map((v,k)=>v-t[0][k]!),n=[a[1]!*b[2]!-a[2]!*b[1]!,0,a[0]!*b[1]!-a[1]!*b[0]!],len=Math.hypot(n[0]!,n[2]!);assert.ok(len>0);
  const u=[n[2]!/len,0,-n[0]!/len] as const,origin=[t[0][0],0,t[0][2]] as const,vs=triangles.flatMap(t=>[...t]),us=vs.map(v=>(v[0]-origin[0])*u[0]+(v[2]-origin[2])*u[2]),ys=vs.map(v=>v[1]);
  const chart:FacadeChart={id,building,origin,uAxis:u,vAxis:[0,1,0],bounds:[Math.min(...us),Math.min(...ys),Math.max(...us),Math.max(...ys)],pixels,planeToleranceMetres:.002};
  for(const t of triangles)validateFacadeTriangle(t,chart);return chart;
}
export async function authorSenateFacadeCharts(args:{plan:string;cityModel:string;baseline:string;out:string}){
  const plan=JSON.parse(fs.readFileSync(args.plan,'utf8')) as SenateFacadePlan;assert.equal(plan.schemaVersion,1);assert.ok(!fs.existsSync(args.out),'Fresh authored output required');
  const sourceBytes=fs.readFileSync(path.join(args.cityModel,'city-model.json'));assert.equal(sha(sourceBytes),plan.source.cityJsonSha256);const city=JSON.parse(sourceBytes.toString()),bin=fs.readFileSync(path.join(args.cityModel,city.binary.file));assert.equal(sha(bin),plan.source.cityBinSha256);
  const baselineBytes=fs.readFileSync(path.join(args.baseline,'manifest.json'));assert.equal(sha(baselineBytes),plan.baselineManifestSha256);const baseline=JSON.parse(baselineBytes.toString());
  const outputs=[];fs.mkdirSync(args.out,{recursive:true});
  for(const building of plan.buildings){
    const triangles=sourceTriangles(city,bin,building.id),charts:FacadeChart[]=[],faces:{key:string;chart:string}[]=[],pieces:string[]=[];
    for(const elevation of building.elevations){
      const selected=elevation.triangles.map(i=>{assert.ok(Number.isSafeInteger(i)&&triangles[i]);return triangles[i]!;}),chart=chartForSourceTriangles(elevation.id,building.id,selected,elevation.pixels);charts.push(chart);
      for(const t of selected)faces.push({key:facadeTriangleKey(t),chart:chart.id});
      const wall=new OriginalWallArt(chart.bounds[2]-chart.bounds[0],chart.bounds[1],chart.bounds[3]);
      if(elevation.renderer==='archive-centre'||elevation.renderer==='archive-wing')renderArchiveWall(wall,elevation.renderer,elevation.ground);
      else if(elevation.renderer==='porthania-five-ribbons'||elevation.renderer==='porthania-low-glass')renderPorthaniaWall(wall,elevation.renderer,elevation.ground);
      else if(elevation.renderer==='aleksanterinkatu-north')renderAleksanterinkatuNorth(wall,elevation.ground);
      else if(elevation.renderer==='porthania-east-five-ribbons'||elevation.renderer==='porthania-east-glass-inset'||elevation.renderer==='porthania-east-blank-tile')renderPorthaniaEast(wall,elevation.renderer,elevation.ground);
      else throw new Error(`Unreviewed facade renderer: ${elevation.renderer}`);
      pieces.push(wall.svg(elevation.pixels));
    }
    const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${building.atlas[0]}" height="${building.atlas[1]}"><rect width="100%" height="100%" fill="#d9d7cb"/>${pieces.join('')}</svg>`,png=await sharp(Buffer.from(svg)).ensureAlpha().png({compressionLevel:9,adaptiveFiltering:false}).toBuffer();
    const name=building.vtj,dir=path.join(args.out,name);fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,'facade.svg'),svg);fs.writeFileSync(path.join(dir,'facade.png'),png);
    const owner=baseline.cells.find((c:any)=>c.id===building.cell);assert.ok(owner.buildings.some((b:any)=>b.id===building.id&&b.vtj===building.vtj));
    const profile:DeliveryFacadeProfile={schemaVersion:1,id:`${plan.id}-${building.vtj}`,baselineManifestSha256:plan.baselineManifestSha256,source:plan.source,
      art:{path:'facade.png',sha256:sha(png),width:building.atlas[0],height:building.atlas[1],license:'CC0-1.0',attribution:'Original reference-led facade artwork by the Helsinki Rides project (2026). Appearance references are not reproduced.',references:plan.references},
      material:{name:`senate-original-${building.vtj}`,unlit:true,roughness:.95,doubleSided:true},charts,
      cells:[{id:building.cell,building:building.id,vtj:building.vtj,baselineLevels:Object.fromEntries(Object.entries(owner.visual).map(([level,ref]:any)=>[level,ref.sha256])),faces}]};
    fs.writeFileSync(path.join(dir,'profile.json'),JSON.stringify(profile,null,2)+'\n');
    const ledger={schemaVersion:1,production:{kind:'original-procedural',license:profile.art.license,referencePixelsCopied:false,artSha256:sha(png),svgSha256:sha(svg)},planSha256:sha(fs.readFileSync(args.plan)),source:plan.source,baselineManifestSha256:plan.baselineManifestSha256,
      building:building.id,vtj:building.vtj,elevations:building.elevations,limitations:building.limitations,dimensions:'Source plane bounds are exact municipal geometry; opening positions, dimensions and colours are authored approximations fitted to observed architectural rhythm. No survey accuracy is claimed.',references:plan.references,referenceEvidence:plan.referenceEvidence??[],runtimeAcceptance:'REQUIRED'};
    fs.writeFileSync(path.join(dir,'source-ledger.json'),JSON.stringify(ledger,null,2)+'\n');outputs.push({building:building.id,profile:path.join(dir,'profile.json'),artSha256:sha(png),charts:charts.length,sourceTriangles:faces.length});
  }
  return outputs;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const {values}=parseArgs({options:{plan:{type:'string'},'city-model':{type:'string'},baseline:{type:'string'},out:{type:'string'}}});assert.ok(values.plan&&values['city-model']&&values.baseline&&values.out);
  console.log(JSON.stringify(await authorSenateFacadeCharts({plan:values.plan,cityModel:values['city-model'],baseline:values.baseline,out:values.out}),null,2));
}
