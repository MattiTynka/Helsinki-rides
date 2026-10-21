// Original elevations of the individually observed Hämeentie street fronts.
// Street View informs layout only; these drawings contain no photograph pixels.
import assert from 'node:assert/strict';
import type {OriginalWallArt} from '../author_senate_facade_charts.ts';
export type HameentieGround=readonly (readonly[number,number])[];
export function hameentieGroundAt(profile:HameentieGround,u:number){
 assert.ok(profile.length>=2);if(u<=profile[0]![0])return profile[0]![1];
 for(let i=1;i<profile.length;i++){const a=profile[i-1]!,b=profile[i]!;if(u<=b[0])return a[1]+(b[1]-a[1])*(u-a[0])/(b[0]-a[0]);}return profile.at(-1)![1];
}
function glass(w:OriginalWallArt,x:number,y:number,width:number,height:number,id:string,frame='#6f5248'){
 w.rect(x-width/2-.055,y-.055,width+.11,height+.11,frame,id);w.rect(x-width/2,y,width,height,'#6d858b');
 w.rect(x-width/2+.05,y+.07,width*.37,height-.14,'#92a2a4');w.line(x+width*.02,y,x+width*.02,y+height,frame,.055);
}
function base(w:OriginalWallArt,p:HameentieGround,height:number){
 const points=[[0,w.maxY-w.minY],[w.width,w.maxY-w.minY],...[...p].reverse().map(([u,y])=>[u,w.maxY-y-height])];
 w.pieces.push(`<polygon data-feature="native-ground-following-plinth" points="${points.map(p=>p.join(',')).join(' ')}" fill="#6b6662"/>`);
}
/** Six residential rows, a shallow service ribbon, three four-bay sections. */
export function renderHameentie25(w:OriginalWallArt,p:HameentieGround){
 const W=w.width,top=w.maxY,ground=Math.max(...p.map(q=>q[1]));w.rect(0,w.minY,W,top-w.minY,'#c2b69b');
 const shopTop=ground+3.05,service=ground+4.12,upperBottom=ground+6.12,upperTop=top-2.12,step=(upperTop-upperBottom)/5;
 assert.ok(step>2&&step<4,'Six observed residential rows do not fit this native elevation');
 for(let section=0;section<3;section++){
  const left=section*W/3,right=(section+1)*W/3;
  for(let j=0;j<=4;j++)w.line(left+j*(right-left)/4,service+.54,left+j*(right-left)/4,top-.25,'#9e998a',.018);
  for(let row=0;row<6;row++)for(let col=0;col<4;col++){
   const x=left+(col+.5)*(right-left)/4,y=upperBottom+row*step,width=(col%2?1.7:2.28)*W/37;
   glass(w,x,y,width,1.48,`h25-residential-${section+1}-${row+1}-${col+1}`);
  }
  for(let col=0;col<4;col++)glass(w,left+(col+.5)*(right-left)/4,service,(right-left)/4-.34,.49,`h25-service-${section+1}-${col+1}`);
  if(section){w.rect(left-.39,shopTop,.78,top-shopTop-.2,'#ae795d',`h25-salmon-divider-${section}`);w.rect(left-.46,shopTop,.11,top-shopTop-.2,'#e0ddd1');w.rect(left+.35,shopTop,.11,top-shopTop-.2,'#e0ddd1');}
 }
 for(let row=0;row<6;row++)w.line(0,upperBottom+row*step-.27,W,upperBottom+row*step-.27,'#a59e8e',.022);
 for(let col=0;col<12;col++){const x=(col+.5)*W/12,y=hameentieGroundAt(p,x)+.24;glass(w,x,y,W/12-.16,shopTop-y-.14,`h25-shop-${col+1}`,'#424943');}
 w.rect(0,shopTop-.02,W,.20,'#405043','h25-dark-shop-head');w.rect(0,shopTop-.43,W,.23,'#a8aa3c','h25-yellow-green-shop-fascia');
 base(w,p,.22);w.rect(0,top-.21,W,.21,'#4e5350','h25-flat-dark-roof-cap');
}
/** Five upper rows in the pink front, flanked by the observed recessed axes. */
export function renderHameentie23(w:OriginalWallArt,p:HameentieGround){
 const W=w.width,top=w.maxY,ground=Math.max(...p.map(q=>q[1])),shopTop=ground+3.85,first=ground+4.7,last=top-2.60,step=(last-first)/4;
 assert.ok(step>3&&step<5.5,'Five observed upper rows do not fit this native elevation');
 w.rect(0,w.minY,W,top-w.minY,'#c5a89b');w.rect(0,ground,W,3.93,'#c7b5a9');
 for(let y=ground+.48;y<shopTop;y+=.58)w.line(0,y,W,y,'#9d8c82',.035);
 const pitch=W/9;
 for(const side of[0,8]){w.rect(side*pitch+.20,shopTop,pitch-.40,top-shopTop-.7,'#aa8d7e',`h23-recessed-side-${side}`);w.rect(side*pitch+.27,shopTop,.14,top-shopTop-.7,'#8d7e70');}
 for(let row=0;row<5;row++)for(let col=0;col<9;col++){
  const x=(col+.5)*pitch,y=first+row*step,width=(col===0||col===8?1.12:1.35),height=row<2?2.10:1.65;
  glass(w,x,y,width,height,`h23-upper-${row+1}-${col+1}`,'#545c54');w.line(x-width/2,y+height*.65,x+width/2,y+height*.65,'#555d56',.06);
  w.rect(x-width/2-.11,y-.14,width+.22,.10,'#b4aa98');
  if(row===2&&[2,4,6].includes(col)){w.rect(x-width/2-.24,y+height+.20,width+.48,.15,'#b8b3a2');w.line(x-width/2-.27,y+height+.37,x+width/2+.27,y+height+.37,'#8e8f7d',.055);}
 }
 for(let col=0;col<9;col++){
  const x=(col+.5)*pitch,y=hameentieGroundAt(p,x)+.26;
  if(col===4){w.rect(x-.76,y,1.52,shopTop-y-.12,'#85623c','h23-central-timber-door');w.rect(x-.63,y+1.7,1.26,1.1,'#526c68');w.line(x,y,x,shopTop-.16,'#b0966c',.06);}
  else glass(w,x,y,pitch-.42,shopTop-y-.17,`h23-shop-${col+1}`,'#56655c');
 }
 const centre=W/2,pedimentY=first+2.45;w.rect(centre-.94,first-.16,1.88,2.58,'#c8c4b6');glass(w,centre,first,1.31,2.10,'h23-central-surrounded-window','#545c54');
 w.pieces.push(`<path data-feature="h23-single-central-pediment" d="M${centre-1.16},${top-pedimentY}L${centre},${top-pedimentY-.54}L${centre+1.16},${top-pedimentY}Z" fill="#c4c1b2" stroke="#858b80" stroke-width=".07"/>`);
 w.rect(0,shopTop+.12,W,.18,'#8c9588','h23-ground-belt');w.rect(0,top-.67,W,.20,'#bfc2ac');w.rect(0,top-.27,W,.27,'#d6d2bf');
 for(let x=.20;x<W;x+=.44)w.rect(x,top-.61,.14,.17,'#878d7a');base(w,p,.28);
}

/** The observed long brick office wing has seven rows of small plain glazing. */
export function renderHameentie19Brick(w:OriginalWallArt,p:HameentieGround){
 const W=w.width,top=w.maxY;w.rect(0,w.minY,W,top-w.minY,'#795b4e');
 // Fine original masonry joints are continuous through the window piers.
 for(let y=w.minY,row=0;y<top;y+=.16,row++){
  w.line(0,y,W,y,'#9d8270',.009);for(let x=(row%2)*.13;x<W;x+=.27)w.line(x,y,x,Math.min(top,y+.16),'#967b68',.008);
 }
 const lowest=Math.max(...p.map(q=>q[1]))+.55,highest=top-2.0,step=(highest-lowest)/6,modules=Math.round(W/1.80);
 assert.ok(step>2.5&&step<4.6,'Seven observed office rows do not fit this native plane');
 for(let row=0;row<7;row++)for(let col=0;col<modules;col++){
  const x=(col+.5)*W/modules,y=lowest+row*step;glass(w,x,y,.88,1.36,`h19-brick-office-${row+1}-${col+1}`,'#56564e');w.rect(x-.49,y-.10,.98,.07,'#b9aaa0');
 }
 // The hedge belongs to the street scene; no plant silhouette is baked here.
 base(w,p,.28);w.rect(0,top-.18,W,.18,'#a5a299','h19-plain-roof-cap');
}

/** Cream six-row corner front adjoining the modern panels of number25. */
export function renderHameentie27(w:OriginalWallArt,p:HameentieGround){
 const W=w.width,top=w.maxY,ground=Math.max(...p.map(q=>q[1])),head=ground+3.55,first=ground+4.35,last=top-2.15,step=(last-first)/5,columns=Math.max(2,Math.round(W/3.2));
 assert.ok(step>2&&step<3.8,'Six observed residential rows do not fit the native front');
 w.rect(0,w.minY,W,top-w.minY,'#cfbf9b');
 for(let row=0;row<6;row++)for(let col=0;col<columns;col++){
  const x=(col+.5)*W/columns,y=first+row*step,h=row===0?1.82:1.52;
  w.rect(x-.77,y-.08,1.54,h+.16,'#e6e0c9',`h27-pale-surround-${row+1}-${col+1}`);glass(w,x,y,1.29,h,`h27-upper-${row+1}-${col+1}`,'#b4b9b0');w.line(x-.645,y+h*.66,x+.645,y+h*.66,'#c6c9bc',.055);
 }
 for(const x of[.18,W-.18]){w.rect(x-.13,head,.26,top-head-.36,'#e9e3cc','h27-pale-edge-pier');w.line(x+.13,head,x+.13,top-.36,'#a69f89',.045);}
 for(let col=0;col<columns;col++){const x=(col+.5)*W/columns,y=hameentieGroundAt(p,x)+.25;glass(w,x,y,W/columns-.44,head-y-.17,`h27-shop-${col+1}`,'#6d6c58');}
 w.rect(0,head+.12,W,.16,'#b7ae95','h27-ground-belt');w.rect(0,top-.50,W,.17,'#e5dfc7');w.rect(0,top-.17,W,.17,'#9f9780','h27-plain-roof-edge');base(w,p,.24);
}

/** Six rows and the observed triple-window bay on the pale curved street wall. */
export function renderHameentie52(w:OriginalWallArt,p:HameentieGround){
 const W=w.width,top=w.maxY,ground=Math.max(...p.map(q=>q[1])),head=ground+3.45,first=ground+4.15,last=top-1.85,step=(last-first)/5,bay=W*.4;
 assert.ok(step>2&&step<3.8,'Six observed upper rows do not fit this native curve');
 w.rect(0,w.minY,W,top-w.minY,'#dbd2aa');w.rect(bay-1.70,head,3.40,top-head-.16,'#ded8ba','h52-central-projecting-bay-tone');
 const axes=Math.max(6,Math.round(W/2.65));
 for(let row=0;row<6;row++){
  const y=first+row*step,h=row===0?1.88:1.50;
  for(let col=0;col<axes;col++){const x=(col+.5)*W/axes;if(Math.abs(x-bay)<2.05)continue;glass(w,x,y,1.02,h,`h52-upper-${row+1}-${col+1}`,'#bbbeb0');w.line(x-.56,y-.09,x+.56,y-.09,'#777c70',.06);}
  for(let col=0;col<3;col++){const x=bay+(col-1)*1.0;w.rect(x-.49,y-.1,.98,h+.22,'#eee8d0',`h52-bay-surround-${row+1}-${col+1}`);glass(w,x,y,.77,h,`h52-bay-${row+1}-${col+1}`,'#b4b9ac');}
  w.rect(bay-1.71,y-.32,3.42,.18,'#c1bca4');
 }
 w.rect(0,w.minY,W,head-w.minY,'#393a34','h52-dark-tiled-shop-base');
 for(let y=w.minY;y<head;y+=.18)w.line(0,y,W,y,'#737569',.012);for(let x=0;x<W;x+=.18)w.line(x,w.minY,x,head,'#6e7167',.012);
 for(let col=0;col<axes;col++){const x=(col+.5)*W/axes,y=hameentieGroundAt(p,x)+.27;glass(w,x,y,W/axes-.35,head-y-.26,`h52-wood-framed-shop-${col+1}`,'#967450');for(let yy=y+.24;yy<head-.3;yy+=.24)w.line(x-W/axes*.38,yy,x+W/axes*.38,yy,'#5e695d',.018);}
 w.rect(0,head+.11,W,.16,'#d3c9aa','h52-pale-shop-fascia');w.rect(0,top-.15,W,.15,'#b3ab8d','h52-plain-cornice');base(w,p,.22);
}

/** Seven plain upper rows above the observed brown-stone shop frontage. */
export function renderHameentie36Yellow(w:OriginalWallArt,p:HameentieGround){
 const W=w.width,top=w.maxY,ground=Math.max(...p.map(q=>q[1])),head=ground+3.28,first=ground+3.91,last=top-1.62,step=(last-first)/6,columns=Math.max(8,Math.round(W/2.05));
 assert.ok(step>2.1&&step<3.9,'Seven observed upper rows do not fit the native yellow front');
 w.rect(0,w.minY,W,top-w.minY,'#c7b68a');
 for(let row=0;row<7;row++)for(let col=0;col<columns;col++){
  const x=(col+.5)*W/columns,y=first+row*step,h=row===0?1.79:1.47;
  w.rect(x-.58,y-.055,1.16,h+.12,'#ad9869',`h36-recess-${row+1}-${col+1}`);
  glass(w,x,y,.94,h,`h36-upper-${row+1}-${col+1}`,'#d2d2b9');
  w.line(x-.49,y-.09,x+.49,y-.09,'#a8a89a',.055);
 }
 w.rect(0,w.minY,W,head-w.minY,'#967d66','h36-brown-stone-shop-base');
 const shops=Math.max(5,Math.round(W/4.1));
 for(let col=0;col<shops;col++){
  const x=(col+.5)*W/shops,y=hameentieGroundAt(p,x)+.26,width=W/shops-.48;
  glass(w,x,y,width,head-y-.27,`h36-shop-${col+1}`,'#98764c');
  w.rect(x-width/2-.08,head-.55,width+.16,.42,'#41423e',`h36-dark-shop-awning-${col+1}`);
 }
 w.rect(0,head+.05,W,.18,'#d4d2bf','h36-light-shop-cornice');w.rect(0,head+.26,W,.07,'#6b7069');
 base(w,p,.22);w.rect(0,top-.18,W,.18,'#887a5b','h36-shallow-roof-edge');
}
