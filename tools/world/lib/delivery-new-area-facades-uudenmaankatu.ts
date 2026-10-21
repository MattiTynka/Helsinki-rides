import type {OriginalWallArt} from '../author_senate_facade_charts.ts';

/** Uudenmaankatu 36: the August 2024 street reference shows a gated central
 * passage between two pale fluted piers, with a triangular entrance hood. */
export function renderUudenmaankatu36Entrance(w:OriginalWallArt,ground:number) {
  const x=w.width/2,top=ground+4.5;
  for(const sign of[-1,1])w.column(x+sign*1.47,ground+.16,top,.48,'u36-entrance-pier-'+sign);
  w.rect(x-1.96,top-.08,3.92,.23,'#c8c1b2','u36-entrance-architrave');
  w.pieces.push(`<path data-feature="u36-triangular-entrance-hood" d="M${x-2.05},${w.maxY-top-.18}L${x},${w.maxY-top-.94}L${x+2.05},${w.maxY-top-.18}Z" fill="#c8c1b2" stroke="#a69f91" stroke-width=".08"/>`);
  for(let dx=-.98;dx<=1;dx+=.245)w.line(x+dx,ground+.12,x+dx,ground+3.94,'#575b54',.035);
  w.line(x-1.2,ground+1.2,x+1.2,ground+1.2,'#575b54',.045);
  w.line(x-1.2,ground+2.8,x+1.2,ground+2.8,'#575b54',.045);
}
