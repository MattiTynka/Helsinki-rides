// Individually reference-qualified Jugend fronts. Original vectors; no photo pixels.
import assert from 'node:assert/strict';
import type { OriginalWallArt } from '../author_senate_facade_charts.ts';

function dividedWindow(w: OriginalWallArt, x: number, y: number, width: number, height: number,
  id: string, frame: string, arch = false) {
  w.rect(x-width/2-.10,y-.10,width+.20,height+.20,'#a8a18a',id+'-stone-surround');
  w.rect(x-width/2,y,width,height,frame,id+'-frame');
  const inset=.10,glassWidth=(width-3*inset)/2;
  for(const left of [x-width/2+inset,x+inset/2]) {
    w.rect(left,y+inset,glassWidth,height-inset*2,'#627575',id+'-glass');
    w.line(left,y+height*.72,left+glassWidth,y+height*.72,frame,.065);
    for(const f of [.82,.91])w.line(left,y+height*f,left+glassWidth,y+height*f,frame,.035);
  }
  w.rect(x-width/2-.13,y-.15,width+.26,.12,'#b7ae94',id+'-sill');
  if(arch) {
    // SVG's vertical coordinate is measured down from the elevation top.
    const top=w.maxY-y-height;
    w.pieces.push(`<path data-feature="${id}-shallow-arch" d="M ${x-width/2-.12} ${top+.2} Q ${x} ${top-.42} ${x+width/2+.12} ${top+.2}" fill="none" stroke="#b7ae94" stroke-width=".14"/>`);
  }
}
function shopBase(w:OriginalWallArt,ground:number,colour:string,axes:readonly number[]) {
  w.rect(0,w.minY,w.width,Math.max(.15,ground-w.minY+3.2),colour,'dark-stone-shop-base');
  for(const x of axes) {
    w.rect(x-1.18,ground+.35,2.36,2.60,'#4f6464','broad-shop-glazing');
    w.line(x,ground+.35,x,ground+2.95,'#a69d86',.10);
  }
  w.rect(0,ground+3.20,w.width,.18,'#908471','shop-belt');
}
function balcony(w:OriginalWallArt,x:number,y:number,width:number) {
  w.rect(x-width/2,y-.20,width,.20,'#b4aa90','balcony-slab');
  w.line(x-width/2,y+.72,x+width/2,y+.72,'#555c55',.08);
  for(let u=x-width/2;u<x+width/2;u+=.18)w.line(u,y,u,y+.72,'#555c55',.045);
}
export function renderBulevardi11(w:OriginalWallArt,ground:number) {
  assert.ok(w.width>36&&w.width<38&&w.maxY-ground>27&&w.maxY-ground<30);
  w.rect(0,w.minY,w.width,w.maxY-w.minY,'#a48d67','b11-ochre-upper-plaster');
  w.rect(0,w.minY,w.width,ground+11.3-w.minY,'#987363','b11-redbrown-lower-plaster');
  shopBase(w,ground,'#5d5a52',[2.8,8.7,12.9,19.4,24.4,30.6,34.6]);
  const axes=[2.65,8.35,10.7,14.1,18.75,20.95,25.7,28.6,32.2,34.8];
  const bottoms=[4.05,8.10,12.14,16.12,20.12],heights=[2.45,2.40,2.38,2.30,1.45];
  for(let row=0;row<5;row++)for(const[i,x]of axes.entries()) {
    const width=i===3?1.75:i===4||i===5?.88:i===0?1.15:1.35;
    dividedWindow(w,x,ground+bottoms[row]!,width,heights[row]!,`b11-${row}-${i}`,'#a3aaa0',row===4);
  }
  // The rounded native corner rises beyond the main cornice.
  for(const x of [1.4,3.5,5.6])dividedWindow(w,x,ground+24.05,.78,1.5,`b11-turret-${x}`,'#a3aaa0',true);
  for(const[x,y,width]of[[3.4,11.5,4.0],[20.0,11.5,4.4],[20.0,19.45,4.4],[32.8,15.55,4.7]]as const)balcony(w,x,ground+y,width);
  for(const y of [3.3,11.4,22.3])w.rect(0,ground+y,w.width,.13,'#b8aa8b','b11-frieze');
  w.rect(17.45,ground+.08,1.85,3.18,'#705139','b11-oak-entry');
  for(const x of [17.8,18.5])w.rect(x,ground+.50,.44,1.8,'#8c7150','b11-entry-panel');
}
export function renderBulevardi13(w:OriginalWallArt,ground:number) {
  assert.ok(w.width>30&&w.width<32&&w.maxY-ground>22&&w.maxY-ground<25);
  w.rect(0,w.minY,w.width,w.maxY-w.minY,'#838773','b13-muted-olive-plaster');
  shopBase(w,ground,'#605f55',[2.5,6.5,11.5,16.5,21.3,26.6,29]);
  // Varied narrow and wide lights follow the asymmetrical flat and curved bays.
  const axes=[1.7,4.8,8.1,11.6,14.6,18.7,22.8,25.4,28.8];
  for(let row=0;row<4;row++)for(const[i,x]of axes.entries()) {
    dividedWindow(w,x,ground+4.15+row*4.05,i===2||i===5?1.70:1.14,row===3?2.05:2.65,
      `b13-${row}-${i}`,'#715946');
  }
  // Native turret and raised bay tops retain their own original shape.
  for(const x of [22.8,25.4,28.8])dividedWindow(w,x,ground+21.1,.95,1.8,`b13-turret-${x}`,'#715946');
  w.rect(0,ground+3.40,w.width,.13,'#ada58b','b13-ground-cornice');
  for(const x of [9.5,17.0,21.1])w.rect(x,ground+3.6,.13,17.8,'#979a83','b13-subtle-vertical-bay-edge');
  w.rect(13.1,ground+.12,1.75,3.0,'#66503d','b13-timber-entry');
  w.rect(13.35,ground+.50,1.25,1.95,'#718080','b13-entry-lights');
}

