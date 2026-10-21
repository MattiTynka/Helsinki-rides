// Small architectural details observed on specific, source-bound elevations.
// This artwork contains no sampled photograph pixels or new world geometry.
import type {OriginalWallArt} from '../author_senate_facade_charts.ts';
import assert from 'node:assert/strict';
import type {ReferenceFacadeArt} from './delivery-new-area-facades-reference-art.ts';

const KALLIOLA_FLOORS={
  '103180613V':{id:'kalliolanrinne-3-south-20261021',bid:'BID_7198f6b1-790d-4a12-8d3c-96b9aadfae76',triangles:[24,25],top:35.649871826171875,heights:[15.072039124514847,14.892624548446278,14.686020636012294,14.415178010049413,14.036472157334627,13.660059151567694,13.332831706993218,12.96475356727295,12.642501628121625]},
  '103171059N':{id:'kalliolanrinne-4-north-20261021',bid:'BID_07bc68e5-e088-41cc-a7dc-ed34f7fe334c',triangles:[23,24],top:33.490318298339844,heights:[12.67215070172396,12.981728806930631,13.357794227781433,13.687272346696886,14.006069201509732,14.33436960833659,14.6669088121202,15.017580871541384,15.254881556136777]}
}as const;

/** These two observed sloping streets retain horizontal residential storeys.
 * A changed source face or floor needs a fresh architectural qualification. */
export function qualifyKalliolanrinneGround(p:{id:string;building:{id:string;vtj:string};triangles:number[];observedGroundProfile:{kind:string;manifestSha256:string;sampleHeights:number[];horizontalDatumFromNativeTop:number}},expected:string,maxY:number,samples:readonly{collision:{height:number}}[]){
  const pin=KALLIOLA_FLOORS[p.building.vtj as keyof typeof KALLIOLA_FLOORS];assert.ok(pin,'Unqualified Kalliolanrinne building');
  assert.equal(p.id,pin.id);assert.equal(p.building.id,pin.bid);assert.deepEqual(p.triangles,pin.triangles);
  assert.equal(expected,'071d4a782d12d04e7d1baf8b4c677224ae0b1afc6797d7aed29b5a9731ebed54');assert.equal(p.observedGroundProfile.manifestSha256,expected);assert.equal(p.observedGroundProfile.kind,'source-measured-sloped-plinth-horizontal-opening-bands');
  assert.equal(maxY,pin.top);assert.deepEqual(p.observedGroundProfile.sampleHeights,pin.heights);assert.equal(samples.length,9);
  samples.forEach((s,i)=>assert.ok(Math.abs(s.collision.height-pin.heights[i]!)<1e-6,'Requalify changed Kalliolanrinne street floor'));
  const datum=Math.max(...pin.heights);assert.equal(p.observedGroundProfile.horizontalDatumFromNativeTop,datum-pin.top);return datum;
}

export function renderKalliolanrinneSlopedBase(w:OriginalWallArt,datum:number,art:ReferenceFacadeArt,floors:readonly{u:number;collision:{height:number}}[]){
  assert.equal(floors.length,9);const edge=[[0,floors[0]!.collision.height+.45],...floors.map(s=>[s.u,s.collision.height+.45]),[w.width,floors.at(-1)!.collision.height+.45]];
  // Replace only the uniform plinth below the lowest residential opening.
  w.rect(0,w.minY,w.width,datum+.55-w.minY,art.wallColour,'kalliola-clear-horizontal-plinth');
  for(const o of art.groundOpenings)w.rect(o.x-o.width/2-.15,w.minY,o.width+.30,datum+o.bottom+o.height+.25-w.minY,art.wallColour,'kalliola-clear-source-entry-column');
  w.pieces.push(`<polygon data-feature="kalliola-observed-sloped-stone-plinth" points="0,${w.maxY-w.minY} ${edge.map(([u,y])=>`${u},${w.maxY-y!}`).join(' ')} ${w.width},${w.maxY-w.minY}" fill="#797367"/>`);
  const localFloor=(x:number)=>{if(x<=floors[0]!.u)return floors[0]!.collision.height;for(let i=1;i<floors.length;i++){const a=floors[i-1]!,b=floors[i]!;if(x<=b.u)return a.collision.height+(b.collision.height-a.collision.height)*(x-a.u)/(b.u-a.u);}return floors.at(-1)!.collision.height;};
  // Each observed entrance is a door of its own height, rather than a sheet of
  // glazing stretched to bridge the street's full 2.6m change in elevation.
  for(const[index,o]of art.groundOpenings.entries()){
    const bottom=localFloor(o.x)+o.bottom,top=bottom+o.height;
    w.rect(o.x-o.width/2-.14,bottom-.10,o.width+.28,top-bottom+.24,'#c6bda8',`kalliola-source-ground-entry-${index}-surround`);
    w.rect(o.x-o.width/2,bottom,o.width,top-bottom,'#70513d');
    for(const sign of[-1,1])w.rect(o.x+sign*o.width*.25-o.width*.18,bottom+.2,o.width*.36,Math.max(.2,top-bottom-.45),art.glassColour);
    w.line(o.x,bottom,o.x,top,'#9d8061',.07);
  }
}

/** Sturenkatu 8: two tall blue glazed stair bays across its red/cream front. */
export function renderSturen8StairGlazing(w:OriginalWallArt,ground:number){
  const brickTop=ground+6.15;
  const axes=Array.from({length:16},(_,i)=>(i+.5)*w.width/16).filter(x=>[.18,.80].every(f=>Math.abs(x-w.width*f)>2.5));
  const openings=axes.flatMap(x=>[.85,3.85].map(y=>[x-.70,ground+y-.18,x+.70,ground+y+1.59]as const));
  function horizontal(y:number){let cursor=0;for(const hole of openings.filter(h=>y>=h[1]&&y<=h[3]).sort((a,b)=>a[0]-b[0])){if(hole[0]>cursor)w.line(cursor,y,hole[0],y,'#967e6b',.022);cursor=Math.max(cursor,hole[2]);}if(cursor<w.width)w.line(cursor,y,w.width,y,'#967e6b',.022);}
  function vertical(x:number,lo:number,hi:number){let cursor=lo;for(const hole of openings.filter(h=>x>=h[0]&&x<=h[2]&&h[3]>lo&&h[1]<hi).sort((a,b)=>a[1]-b[1])){if(hole[1]>cursor)w.line(x,cursor,x,Math.min(hi,hole[1]),'#967e6b',.018);cursor=Math.max(cursor,hole[3]);}if(cursor<hi)w.line(x,cursor,x,hi,'#967e6b',.018);}
  for(let y=ground+.18;y<brickTop;y+=.22){
    horizontal(y);
    const shift=Math.round((y-ground)/.22)%2?.31:0;
    for(let x=shift;x<w.width;x+=.62)vertical(x,y,Math.min(y+.22,brickTop));
  }
  for(const [index,fraction]of[.18,.80].entries()){
    const centre=w.width*fraction,bottom=ground+.14,top=w.maxY-.65,width=1.82;
    w.rect(centre-width*.95,bottom,width*1.9,top-bottom,'#5d9d9b',`sturen8-stair-${index}-turquoise-tile`);
    w.rect(centre-width/2,bottom,width,top-bottom,'#56727b',`sturen8-stair-${index}-glass`);
    for(let y=bottom;y<top;y+=1.12)w.line(centre-width/2,y,centre+width/2,y,'#a1b4b6',.07);
    w.line(centre,bottom,centre,top,'#a1b4b6',.07);
    w.rect(centre-width/2,bottom,width,2.3,'#477e90',`sturen8-stair-${index}-entrance`);
    w.rect(centre-width/2+.12,bottom+.22,width-.24,1.92,'#3f626c');
  }
  // Small square ventilators are visible directly below the flat roof line.
  for(let x=.8;x<w.width;x+=2.9)w.rect(x,w.maxY-.42,.21,.17,'#66635b','sturen8-roof-vent');
}

/** The residential ground floor between Sturenkatu 13's two projecting bays
 * has a low stone basement, while the flanks have shop glazing. */
export function renderSturen13GroundDetails(w:OriginalWallArt,ground:number){
  assert.ok(Math.abs(w.width-41.88386030197921)<.0001,'Sturen13 details require its literal source-projected elevation');
  const left=17.05874012372544,right=30.32719197389404;
  w.rect(left,w.minY,right-left,ground+3.28-w.minY,'#ded6ba','sturen13-residential-ground-wall');
  w.rect(left,w.minY,right-left,ground+.27-w.minY,'#978572','sturen13-low-stone-basement');
  for(const[index,x]of[18.8,21.65,24.5,27.4].entries()){
    const y=ground+.65,width=1.2,height=1.68;
    w.rect(x-width/2-.12,y-.12,width+.24,height+.24,'#e8e3cf',`sturen13-ground-window-${index}-surround`);
    w.rect(x-width/2,y,width,height,'#dfdfd2');
    w.rect(x-width/2+.09,y+.09,width-.18,height-.18,'#80969a');
    w.line(x,y,x,y+height,'#dfdfd2',.07);
    w.rect(x-.65,ground+.03,1.3,.19,'#687477',`sturen13-basement-vent-${index}`);
  }
}

/** The opposite Kalliolanrinne elevations have visibly different fenestration. */
export function renderKalliolanrinneDetails(w:OriginalWallArt,ground:number,number:3|4){
  assert.ok(Math.abs(w.width-(number===3?37.995652964618074:37.99926193068396))<.0001,'Kalliolanrinne details require their exact selected source plane');
  if(number===3){
    for(const x of[1.9,w.width-1.9])for(const[storey,bottom]of[4.3,7.8,11.3,14.8,18.3].entries()){
      w.rect(x-.67,ground+bottom,.95,1.9,'#778b8a',`kalliola3-balcony-door-${storey}`);
      w.rect(x-1.2,ground+bottom-.4,2.4,.7,'#b8bbae',`kalliola3-balcony-front-${storey}`);
      w.rect(x-1.2,ground+bottom-.51,2.4,.11,'#a4a89c');
      w.line(x-1.2,ground+bottom+.35,x+1.2,ground+bottom+.35,'#6c776e',.045);
      for(let dx=-1.15;dx<1.2;dx+=.15)w.line(x+dx,ground+bottom-.35,x+dx,ground+bottom+.35,'#808b81',.026);
    }
    return;
  }
  const axes=Array.from({length:7},(_,i)=>3+i*(w.width-6)/6);
  for(const bottom of[.8,3.8,6.8,9.8,12.8,15.8])for(const[index,x]of axes.entries()){
    if(bottom===.8&&index===3)continue;
    for(const dx of[-.45,.45])w.line(x+dx,ground+bottom,x+dx,ground+bottom+1.7,'#74624c',.065);
    if(x+2.3<w.width)w.rect(x+2.15,ground+bottom+1.2,.13,.13,'#929184','kalliola4-square-wall-vent');
  }
}

export function renderPorvoonkatu10Stairs(w:OriginalWallArt,ground:number,art:ReferenceFacadeArt,floors:readonly{u:number;collision:{height:number}}[]){
  assert.ok(Math.abs(w.width-50.69883823424652)<.0001,'Porvoonkatu stairs require their literal source plane');
  assert.equal(floors.length,9);const floorAt=(x:number)=>{if(x<=floors[0]!.u)return floors[0]!.collision.height;for(let i=1;i<floors.length;i++){const a=floors[i-1]!,b=floors[i]!;if(x<=b.u)return a.collision.height+(b.collision.height-a.collision.height)*(x-a.u)/(b.u-a.u);}return floors.at(-1)!.collision.height;};
  const bays=[.31,.78].map(f=>f*w.width),holes=art.groundOpenings.map(o=>[o.x-o.width/2-.12,ground+o.bottom-.12,o.x+o.width/2+.12,ground+o.bottom+o.height+.12]as const);
  for(let y=ground+.27;y<ground+4.4;y+=.32){let cursor=0;for(const h of holes.filter(h=>y>=h[1]&&y<=h[3]).sort((a,b)=>a[0]-b[0])){if(h[0]>cursor)w.line(cursor,y,h[0],y,'#aa8771',.016);cursor=Math.max(cursor,h[2]);}if(cursor<w.width)w.line(cursor,y,w.width,y,'#aa8771',.016);}
  for(let x=0;x<w.width;x+=.32){let cursor=ground+.27;for(const h of holes.filter(h=>x>=h[0]&&x<=h[2]).sort((a,b)=>a[1]-b[1])){if(h[1]>cursor)w.line(x,cursor,x,Math.min(ground+4.4,h[1]),'#aa8771',.016);cursor=Math.max(cursor,h[3]);}if(cursor<ground+4.4)w.line(x,cursor,x,ground+4.4,'#aa8771',.016);}
  for(const[index,x]of bays.entries()){
    const bottom=floorAt(x)+.12,top=w.maxY-.62;
    w.rect(x-2,bottom,4,top-bottom-.25,'#68a1a0',`porvoo10-stair-tile-${index}`);
    for(let dx=-2;dx<2;dx+=.28)w.line(x+dx,bottom,x+dx,top-.25,'#548c8a',.018);
    w.rect(x-.9,bottom,1.8,top-bottom,'#527785',`porvoo10-stair-glass-${index}`);
    w.line(x,bottom,x,top,'#b3c3ba',.07);for(let y=bottom;y<top;y+=.95)w.line(x-.9,y,x+.9,y,'#b3c3ba',.07);
    w.rect(x+.03,bottom,.84,2.5,'#376a8b',`porvoo10-blue-door-${index}`);
    for(let y=bottom+.16;y<bottom+2.4;y+=.8)w.rect(x+.12,y,.65,.65,'#4f727c');
  }
  for(let x=.8;x<w.width;x+=3.1)w.rect(x,w.maxY-.52,.22,.16,'#63665b','porvoo10-eave-vent');
}

/** Only the observed Kirstinkatu9 street plane has this tile/balcony family. */
export function renderKirstinkatu9Details(w:OriginalWallArt,ground:number,art:ReferenceFacadeArt,floors:readonly{u:number;collision:{height:number}}[]){
 assert.ok(Math.abs(w.width-26.537143349974258)<1e-7);assert.equal(floors.length,9);
 const holes=art.rows.flatMap(r=>r.axes.map(x=>[x-r.width/2-.18,ground+r.bottom-.18,x+r.width/2+.18,ground+r.bottom+r.height+.18]));
 holes.push(...art.groundOpenings.map(o=>[o.x-o.width/2-.15,w.minY,o.x+o.width/2+.15,ground+o.bottom+o.height+.2]));
 for(let y=ground+1.5;y<w.maxY-.3;y+=.18){let cursor=0;for(const h of holes.filter(h=>y>=h[1]!&&y<=h[3]!).sort((a,b)=>a[0]!-b[0]!)){if(h[0]!>cursor)w.line(cursor,y,h[0]!,y,'#b6b8ad',.012);cursor=Math.max(cursor,h[2]!);}if(cursor<w.width)w.line(cursor,y,w.width,y,'#b6b8ad',.012);}
 for(let x=0;x<w.width;x+=.18){let cursor=ground+1.5;for(const h of holes.filter(h=>x>=h[0]!&&x<=h[2]!).sort((a,b)=>a[1]!-b[1]!)){if(h[1]!>cursor)w.line(x,cursor,x,Math.min(w.maxY-.3,h[1]!),'#b6b8ad',.012);cursor=Math.max(cursor,h[3]!);}if(cursor<w.maxY-.3)w.line(x,cursor,x,w.maxY-.3,'#b6b8ad',.012);}
 for(const x of[6,21.1])for(const bottom of[4.85,7.9,10.95,14,17.05]){
  w.rect(x-1.05,ground+bottom-.8,2.55,.16,'#9b9d91','kirsti9-balcony-soffit');
  w.rect(x-1.1,ground+bottom-.65,2.6,.85,'#c1c4b8','kirsti9-light-balcony-front');
  w.line(x-1.1,ground+bottom+.25,x+1.5,ground+bottom+.25,'#8f9b94',.045);
  for(let u=x-1.05;u<x+1.5;u+=.16)w.line(u,ground+bottom-.6,u,ground+bottom+.25,'#9eaaa1',.026);
 }
 // The garage opens off its lower access floor. Keep its actual doorway
 // height local rather than stretching it to the higher street datum.
 const garage=art.groundOpenings.find(o=>o.kind==='passage');assert.ok(garage);
 const x=garage.x,left=x-garage.width/2,at=(u:number)=>{if(u<=floors[0]!.u)return floors[0]!.collision.height;for(let i=1;i<floors.length;i++){const a=floors[i-1]!,b=floors[i]!;if(u<=b.u)return a.collision.height+(b.collision.height-a.collision.height)*(u-a.u)/(b.u-a.u);}return floors.at(-1)!.collision.height;},bottom=at(x)+garage.bottom;
 w.rect(left-.12,w.minY,garage.width+.24,ground+3.2-w.minY,art.wallColour,'kirsti9-clear-stretched-garage');
 w.rect(left-.1,bottom-.1,garage.width+.2,garage.height+.2,'#a6a89b','kirsti9-garage-surround');
 w.rect(left,bottom,garage.width,garage.height,'#454b48','kirsti9-fixed-height-garage');
 for(let y=bottom+.15;y<bottom+garage.height;y+=.22)w.line(left,y,left+garage.width,y,'#5d635d',.025);
}

export function renderJosafatinkatu7Details(w:OriginalWallArt,ground:number){
 assert.ok(Math.abs(w.width-53.25011984235789)<1e-7,'Only the observed Josafatinkatu7 west return');
 for(const x of[.12,.5,.88].map(f=>f*w.width)){
  w.rect(x-2.8,ground+1.25,5.6,w.maxY-ground-1.55,'#526365','josafat7-dark-balcony-ribbon');
  w.line(x,ground+1.25,x,w.maxY-.3,'#9caaa5',.06);
  for(const bottom of[1.7,4.7,7.7,10.7,13.7,16.7]){
   w.rect(x-2.8,ground+bottom-.45,5.6,.13,'#a6afa6','josafat7-balcony-slab');
   w.rect(x-2.8,ground+bottom-.3,5.6,.72,'#394f59','josafat7-dark-glass-balustrade');
   for(let u=x-2.7;u<x+2.8;u+=1.05)w.line(u,ground+bottom-.3,u,ground+bottom+.4,'#8a9c9b',.036);
   w.line(x-2.8,ground+bottom+.43,x+2.8,ground+bottom+.43,'#9caaa5',.045);
  }
 }
}
