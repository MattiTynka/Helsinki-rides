// Original line/colour interpretation of the two actually inspected office fronts.
import assert from 'node:assert/strict';
import type {OriginalWallArt} from '../author_senate_facade_charts.ts';
import {renderObservedWallFinish,type ObservedWallFinish} from './delivery-new-area-facades-observed-finish.ts';

export function renderAnonymousOfficeCorner(w:OriginalWallArt,ground:number,finish:ObservedWallFinish) {
  assert.equal(finish.kind,'brick');assert.ok(ground>8&&ground<8.1);
  renderObservedWallFinish(w,finish);
  const top=Math.min(w.maxY,ground+3.45);
  if(top>w.minY){w.rect(0,w.minY,w.width,top-w.minY,'#b6ad9d','office-corner-source-bound-stone-base');for(const dy of [.35,1.4,2.5,3.35])if(ground+dy>w.minY&&ground+dy<top)w.line(0,ground+dy,w.width,ground+dy,'#827d72',.025);}
}

export function renderAnonymousOffice(w:OriginalWallArt,ground:number,side:'south'|'east',mainBayRange?:readonly[number,number]) {
  assert.ok(side==='south'||side==='east');
  assert.ok(w.width>=15&&w.width<=21&&w.maxY-ground>=17&&w.maxY-ground<=23);
  const W=w.width,top=w.maxY,brick='#9b6755',mortar='#876350',stone='#b6ad9d',metal='#9b8d76',glass='#9aa5a5';
  w.rect(0,w.minY,W,top-w.minY,brick,'office-red-masonry');
  for(let y=ground+3.5;y<top;y+=.24) {
    w.line(0,y,W,y,mortar,.018);
    const row=Math.round((y-ground-3.5)/.24);
    for(let x=(row%2)*.25;x<W;x+=.5)w.line(x,y,x,y+.24,mortar,.012);
  }
  w.rect(0,w.minY,W,Math.max(.01,ground+3.45-w.minY),stone,'office-stone-base');
  for(const y of [.35,1.4,2.5,3.35])w.line(0,ground+y,W,ground+y,'#827d72',.025);
  for(let x=.1;x<W;x+=2)w.line(x,ground,x,ground+3.4,'#8c867b',.025);
  // The eastern front has three parallel native plates. Its seven main bays
  // belong only to the middle plate, not across either physical return edge.
  if(side==='east')assert.ok(mainBayRange&&mainBayRange[0]>0&&mainBayRange[1]<W&&mainBayRange[1]-mainBayRange[0]>9&&mainBayRange[1]-mainBayRange[0]<10);
  else assert.equal(mainBayRange,undefined);
  const left=side==='south'?W*.29:mainBayRange![0],right=side==='south'?W*.90:mainBayRange![1];
  const count=side==='south'?6:7,step=(right-left)/count;
  // The native attic steps back at24.4m. The observed top lights belong wholly
  // to that upper plane; crossing the step split each light into two images.
  const rows=[{y:4.05,h:3.12},{y:8.00,h:2.55},{y:11.75,h:2.55},{y:top-ground-2.45,h:1.9}];
  for(let c=0;c<count;c++) {
    const x=left+c*step+.10,width=step-.21;
    w.rect(x-.075,ground+3.8,.15,Math.min(top-ground-3.8,15.6),stone,'office-continuous-upright-'+c);
    for(const[r,row]of rows.entries()) {
      assert.ok(ground+row.y+row.h<=top+.1);
      w.rect(x,ground+row.y,width,row.h,metal,`office-${side}-frame-${r}-${c}`);
      w.rect(x+.06,ground+row.y+.07,width-.12,row.h-.14,glass,`office-${side}-glass-${r}-${c}`);
      // The observed modern lights have a fine vertical division, no historic lintels/sills.
      w.line(x+width*.52,ground+row.y,x+width*.52,ground+row.y+row.h,metal,.035);
    }
  }
  const strip=side==='south'?W*.125:W*.91;
  for(const[r,row]of rows.entries()) {
    const width=side==='south'?1.15:1.05,h=r===0?2.9:r===3?1.9:2.15;
    w.rect(strip-width/2,ground+row.y,width,h,metal,`office-${side}-strip-frame-${r}`);
    w.rect(strip-width/2+.065,ground+row.y+.07,width-.13,h-.14,glass,`office-${side}-strip-glass-${r}`);
  }
  for(let c=0;c<3;c++) {
    const x=left+c*(right-left)/3,width=(right-left)/3-.25;
    w.rect(x,ground+.3,width,2.55,'#8c9b9b',`office-shop-light-${c}`);
    w.line(x+width*.5,ground+.3,x+width*.5,ground+2.85,metal,.07);
  }
  const entrance=side==='south'?W*.13:W*.91;
  w.rect(entrance-.62,ground+.05,1.24,2.95,'#4a4741','office-recessed-entrance');
  w.rect(entrance-.48,ground+.17,.96,2.68,'#667675','office-entrance-glass');
  w.line(entrance,ground+.17,entrance,ground+2.85,metal,.06);
  w.rect(0,top-.26,W,.22,'#676b65','office-roof-edge');
}
