// Appearance-only original detail on the individually observed Eteläranta2 south front.
import assert from'node:assert/strict';import type{OriginalWallArt}from'../author_senate_facade_charts.ts';import type{ReferenceFacadeArt}from'./delivery-new-area-facades-reference-art.ts';
export function renderEtelaranta2SouthDetails(w:OriginalWallArt,ground:number,art:ReferenceFacadeArt){
 assert.ok(Math.abs(w.width-48.8391753978511)<1e-7);assert.equal(art.rows.length,2);assert.equal(art.rows[0]!.axes.length,17);
 for(const x of[.28,6.67,41.64,w.width-.48]){
  w.rect(x,ground+5.35,.25,Math.max(.2,w.maxY-ground-5.65),'#d7d3c3','etelaranta-observed-upper-pilaster');
  w.rect(x-.14,w.maxY-1.16,.53,.23,'#dfd9c9','etelaranta-pilaster-cap');
 }
 for(const x of art.rows[0]!.axes){
  w.rect(x-.83,ground+5.7,1.66,.17,'#d8d1c1','etelaranta-middle-sill-belt');
  w.pieces.push(`<ellipse data-feature="etelaranta-original-small-roundel" cx="${x}" cy="${w.maxY-ground-5.92}" rx=".13" ry=".1" fill="#e4ddce" stroke="#aaa99a" stroke-width=".025"/>`);
 }
 const cornice=w.maxY-.82;
 w.rect(0,cornice-.2,w.width,.14,'#8c8071','etelaranta-cornice-shadow');
 for(let x=.15;x<w.width-.1;x+=.38)w.rect(x,cornice,.19,.22,'#ddd7c7','etelaranta-original-dentils');
 w.rect(0,cornice+.28,w.width,.11,'#d7d0c0','etelaranta-dentil-cap');
 // The source does not model a projecting balcony. An original flat rail motif records its appearance only.
 const left=28.9,width=7.0,bottom=ground+5.93;
 w.rect(left-.2,bottom-.2,width+.4,.22,'#9b998b','etelaranta-balcony-stone-base');
 w.line(left,bottom,left+width,bottom,'#4c5350',.10);w.line(left,bottom+1.05,left+width,bottom+1.05,'#4c5350',.075);
 for(let x=left;x<=left+width;x+=.24)w.line(x,bottom,x,bottom+1.05,'#5b615a',.035);
 for(let x=left+.23;x<left+width-.15;x+=.48)w.pieces.push(`<ellipse data-feature="etelaranta-original-railing-scroll" cx="${x}" cy="${w.maxY-bottom-.54}" rx=".17" ry=".27" fill="none" stroke="#626760" stroke-width=".025"/>`);
}

export function renderEtelaranta2WestDetails(w:OriginalWallArt,ground:number,art:ReferenceFacadeArt,samples:readonly{u:number;collision:{height:number}}[]){
 assert.ok(Math.abs(w.width-29.690089272071205)<1e-7);assert.equal(art.rows.length,3);assert.equal(samples.length,9);
 const stoneTop=ground+.85;
 w.rect(0,w.minY,w.width,stoneTop-w.minY,'#9c998d','etelaranta-observed-granite-basement');
 for(let y=w.minY+.5;y<stoneTop;y+=.55)w.line(0,y,w.width,y,'#858378',.035);
 for(let x=.4;x<w.width;x+=1.8)w.line(x,w.minY,x,stoneTop,'#858378',.035);
 const floorAt=(x:number)=>{const a=[{u:0,collision:samples[0]!.collision},...samples,{u:w.width,collision:samples.at(-1)!.collision}];for(let i=1;i<a.length;i++){const l=a[i-1]!,r=a[i]!;if(x<=r.u)return l.collision.height+(r.collision.height-l.collision.height)*(x-l.u)/Math.max(1e-9,r.u-l.u);}throw Error('Basement opening outside measured source floor');};
 for(const[x,width,kind]of[[2.7,2.6,'garage'],[6.3,1.3,'door'],[10.1,1.45,'door']]as const){
  const bottom=floorAt(x)+.12,height=2.1,left=x-width/2;
  assert.ok(bottom+height<ground+1.1,'Basement entrance must stay below the actual main window row');
  w.rect(left-.1,bottom-.1,width+.2,height+.2,'#a5a095','etelaranta-basement-surround');
  w.rect(left,bottom,width,height,kind==='garage'?'#43483f':'#806545','etelaranta-original-basement-'+kind);
  if(kind==='garage')for(let u=left+.12;u<left+width;u+=.19)w.line(u,bottom,u,bottom+height,'#777c6c',.035);
  else{w.rect(left+.15,bottom+.25,width-.3,height-.5,'#7d8c7d');w.line(x,bottom,x,bottom+height,'#9b7b4d',.07);}
 }
 for(const x of[.28,w.width-.48])w.rect(x,ground+5.35,.25,Math.max(.2,w.maxY-ground-5.65),'#d7d3c3','etelaranta-west-upper-pilaster');
 for(let i=1;i<art.rows[1]!.axes.length;i++){const x=(art.rows[1]!.axes[i-1]!+art.rows[1]!.axes[i]!)/2;w.rect(x-.2,ground+5.35,.4,Math.max(.2,w.maxY-ground-5.65),'#ddd8ca','etelaranta-west-observed-interwindow-pilaster');}
 for(const x of art.rows[1]!.axes){w.rect(x-.83,ground+5.7,1.66,.17,'#d8d1c1','etelaranta-west-middle-sill-belt');w.pieces.push(`<ellipse data-feature="etelaranta-west-small-roundel" cx="${x}" cy="${w.maxY-ground-5.92}" rx=".13" ry=".1" fill="#e4ddce"/>`);}
 const cornice=w.maxY-.82;w.rect(0,cornice-.2,w.width,.14,'#8c8071','etelaranta-west-cornice-shadow');
 for(let x=.15;x<w.width-.1;x+=.38)w.rect(x,cornice,.19,.22,'#ddd7c7','etelaranta-west-original-dentils');
}
