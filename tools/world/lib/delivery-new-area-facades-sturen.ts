import type{OriginalWallArt}from'../author_senate_facade_charts.ts';import type{ReferenceFacadeArt}from'./delivery-new-area-facades-reference-art.ts';
/** Individually observed Sturenkatu7 has two stacks of brown balconies. */
export function renderSturen7Balconies(w:OriginalWallArt,ground:number){
 for(let row=0;row<6;row++)for(const x of[w.width*.075,w.width*.925]){const y=ground+3.3+row*3;w.rect(x-.38,y,.76,1.78,'#6d7569','s7-balcony-door');w.rect(x-.29,y+.1,.58,1.52,'#9ba6a0');w.line(x,y,x,y+1.78,'#cbc4ae',.07);w.rect(x-.92,y-.19,1.84,.18,'#665343','s7-balcony-slab');w.rect(x-.84,y-.01,1.68,.65,'#79644e','s7-brown-balcony-face');w.line(x-.89,y+.66,x+.89,y+.66,'#4b4d45',.06);}
}
/** Sturenkatu9's stone-like yellow surface is individually observed. Sparse
 * original colour marks stop outside every opening; no photograph is sampled. */
export function renderSturen9StoneFinish(w:OriginalWallArt,ground:number,a:ReferenceFacadeArt){
 for(let row=0;ground+3.45+row*.23<w.maxY-.2;row++)for(let column=0;column*.31<w.width;column++){
  const x=column*.31,y=ground+3.45+row*.23,hash=((row*73856093)^(column*19349663))>>>0;if(hash%5>1)continue;
  if(a.rows.some(r=>y<ground+r.bottom+r.height+.3&&y+.18>ground+r.bottom-.3&&r.axes.some(axis=>x<axis+r.width/2+.3&&x+.24>axis-r.width/2-.3)))continue;
  if(a.bands.some(b=>{const h=(b.from==='ground'?ground:w.maxY)+b.offset;return y<h+b.height+.12&&y+.18>h-.12;}))continue;
  w.rect(x,y,Math.min(.24,w.width-x),.15,hash%2?'#b79e62':'#aa925c','s9-original-stone-tone');
 }
}
