import type {OriginalWallArt} from '../author_senate_facade_charts.ts';

/** Individually observed Hietalahdenkatu7 has six continuous glazed balcony
 * ribbons with pale panel spandrels; it does not have punched heritage windows. */
export function renderHietalahdenkatu7Ribbons(w:OriginalWallArt,ground:number) {
  w.rect(0,ground+3.3,w.width,w.maxY-ground-3.3,'#c6cac6','h7-pale-balcony-panels');
  for(let row=0;row<6;row++) {
    const y=ground+3.35+row*3.2,height=row===5?1.95:2.22;
    w.rect(.16,y,w.width-.32,height,'#71848a','h7-continuous-glazed-ribbon');
    for(let column=0;column<12;column++) {
      const left=.16+column*(w.width-.32)/12,width=(w.width-.32)/12;
      w.rect(left+.06,y+.06,width-.12,height-.12,(column+row)%3===0?'#839497':(column+row)%3===1?'#728789':'#8e9d9c','h7-original-glass-tone');
      w.line(left,y,left,y+height,'#dfe0d5',.075);
      w.line(left+width/2,y,left+width/2,y+height,'#bfcac5',.025);
    }
    w.line(.16,y+.3,w.width-.16,y+.3,'#d9dfd7',.065);
    w.rect(0,y-.2,w.width,.18,'#949d98','h7-balcony-slab-edge');
  }
  w.rect(0,w.maxY-.25,w.width,.25,'#959e99','h7-roof-edge');
}
