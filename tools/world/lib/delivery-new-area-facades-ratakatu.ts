import type {OriginalWallArt} from '../author_senate_facade_charts.ts';

/** Individually inspected salmon Jugend street elevation at Ratakatu11–13.
 * Native three-bay projections supply the shape. These are original details. */
export function renderRatakatu13Details(w:OriginalWallArt,ground:number) {
  const cream='#b9b8a6';
  w.rect(0,ground+13.36,w.width,.24,cream,'r13-observed-ornamental-belt');
  for(let x=.8;x<w.width-.3;x+=1.12)w.pieces.push(`<circle data-feature="r13-original-frieze-rosette" cx="${x}" cy="${w.maxY-ground-13.48}" r=".16" fill="#d1ccba" stroke="#989d91" stroke-width=".035"/>`);
  for(const x of [13.4,22.2])w.rect(x-.09,ground+3.5,.18,Math.max(.01,w.maxY-ground-4.5),'#c7866d','r13-central-bay-edge');
  for(const x of [15.7,19.85]) {
    w.window(x,ground+16.5,1.48,1.65,'r13-central-upper-opening','cornice');
    w.rect(x-.95,ground+18.42,1.9,.18,cream,'r13-central-upper-hood');
  }
  const centre=17.8,left=centre-1.65,right=centre+1.65,top=ground+3.02;
  w.pieces.push(`<path data-feature="r13-observed-arched-entry" d="M ${left} ${w.maxY-top} Q ${centre} ${w.maxY-top-1.28} ${right} ${w.maxY-top}" fill="none" stroke="#a79b7c" stroke-width=".25"/>`);
  for(const x of [2.5,10.65,25.1,33.05])for(const dx of [-1.85,-1.48,1.48,1.85])w.rect(x+dx-.06,ground+4.4,.12,.62,cream,'r13-original-lower-window-ornament');
}
