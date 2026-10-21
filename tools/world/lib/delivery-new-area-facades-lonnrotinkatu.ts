import type {OriginalWallArt} from '../author_senate_facade_charts.ts';

/** Two observed bay-window stacks on Lönnrotinkatu28. The native wall is flat;
 * these are original painted recess/edge cues and never imply added geometry. */
export function renderLonnrotinkatu28Bays(w:OriginalWallArt,ground:number) {
  for(const x of [w.width*.275,w.width*.635]) {
    w.rect(x-1.45,ground+4.25,2.9,Math.max(.01,w.maxY-ground-4.25),'#cfbf8f','l28-bay-plaster');
    w.rect(x+1.28,ground+4.25,.17,Math.max(.01,w.maxY-ground-4.25),'#a79c79','l28-bay-edge');
    for(let row=0;row<4;row++) {
      const y=ground+4.65+row*3.2,height=row===3?1.55:2.15;
      w.rect(x-1.2,y-.12,2.4,height+.24,'#d9d7c9','l28-bay-stone-surround');
      w.rect(x-1.04,y,2.08,height,'#8a9490','l28-bay-glazing');
      for(const edge of [-1.04,-.55,.55,1.04])w.line(x+edge,y,x+edge,y+height,'#e0ded0',.08);
      w.line(x-1.04,y+height*.7,x+1.04,y+height*.7,'#e0ded0',.07);
      w.rect(x-1.34,y-.2,2.68,.16,'#a49c7e','l28-bay-sill');
    }
  }
}
