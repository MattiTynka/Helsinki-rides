import type {OriginalWallArt} from '../author_senate_facade_charts.ts';
import type {ReferenceFacadeArt} from './delivery-new-area-facades-reference-art.ts';

/** The actual Kalevankatu43 frontage is a low wooden building on a rough stone
 * plinth, rather than another multi-storey masonry apartment facade. */
export function renderKalevankatu43Finish(w:OriginalWallArt,ground:number,a:ReferenceFacadeArt) {
  const blocked=(x:number,y:number)=>a.rows.some(r=>y>=ground+r.bottom-.2&&y<=ground+r.bottom+r.height+.4&&r.axes.some(axis=>Math.abs(x-axis)<r.width/2+.3));
  for(let y=ground+1.35;y<w.maxY-.35;y+=.24) {
    let start=0;
    for(let x=0;x<=w.width+.05;x+=.05) {
      if(blocked(x,y)||x>w.width) {if(x-start>.08)w.line(start,y,Math.min(x,w.width),y,'#ac956c',.024);start=x+.05;}
    }
  }
  for(let row=0;row<3;row++)for(let column=0;column*.84<w.width;column++) {
    const x=column*.84-(row%2)*.4,y=ground+row*.43;
    w.rect(Math.max(0,x),y,Math.min(.77,w.width-Math.max(0,x)),.37,(row+column)%3===0?'#777268':(row+column)%3===1?'#8c8475':'#69685f','k43-original-plinth-stone');
  }
}
