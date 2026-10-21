// Original line and plaster artwork of the individually inspected Bulevardi22.
// Its existing native bay geometry supplies the projections; no photo pixels.
import assert from'node:assert/strict';
import type{OriginalWallArt}from'../author_senate_facade_charts.ts';
import type{FacadeChart,FacadeTriangle}from'./facade-charts.ts';
import{validateFacadeTriangle}from'./facade-charts.ts';
/** Project a common elevation onto each unchanged source plane, including returns. */
export function chartInProjectedElevation(chart:FacadeChart,points:readonly FacadeTriangle[],frame:{origin:readonly[number,number];axis:readonly[number,number];width:number;minY:number;maxY:number}):FacadeChart{
 const ratio=chart.uAxis[0]*frame.axis[0]+chart.uAxis[2]*frame.axis[1];assert.ok(ratio>.05&&ratio<=1.000001);
 const local=chart.bounds[0],first=[chart.origin[0]+chart.uAxis[0]*local,chart.origin[2]+chart.uAxis[2]*local],global=(first[0]!-frame.origin[0])*frame.axis[0]+(first[1]!-frame.origin[1])*frame.axis[1],start=local-global/ratio;
 const result={...chart,bounds:[start,frame.minY,start+frame.width/ratio,frame.maxY]as const};for(const triangle of points)validateFacadeTriangle(triangle,result);return result;
}
function window(w:OriginalWallArt,x:number,y:number,width:number,height:number,id:string){
 w.rect(x-width/2-.10,y-.10,width+.20,height+.22,'#eee9d9',id+'-cream-frame');w.rect(x-width/2,y,width,height,'#687b7c',id);
 w.rect(x-width/2+.05,y+.08,width*.38,height-.16,'#a4afad');w.rect(x+.03,y+.08,width*.35,height-.16,'#839391');
 w.line(x,y,x,y+height,'#f1ede1',.055);w.line(x-width/2,y+height*.74,x+width/2,y+height*.74,'#eee9dc',.06);w.rect(x-width/2-.15,y-.14,width+.30,.10,'#d4cebb');
}
export function renderBulevardi22(w:OriginalWallArt,ground:number){
 const W=w.width,top=w.maxY;assert.ok(W>35&&W<37&&top-ground>18&&top-ground<23);
 w.rect(0,w.minY,W,top-w.minY,'#d2b874','b22-warm-yellow-plaster');
 const belt=ground+3.55;w.rect(0,ground,W,3.55,'#c4bfae','b22-ground-stone');w.rect(0,w.minY,W,Math.max(.2,ground-w.minY+.30),'#74726b','b22-granite-plinth');
 for(const y of [belt-.18,belt+.08,top-.46,top-.15])w.rect(0,y,W,.16,'#e9e4d4','b22-continuous-cream-belt');
 const bottoms=[ground+4.28,ground+8.17,ground+11.93,ground+15.61],heights=[2.64,2.45,2.26,1.89];
 // East wing and central flat front: visible paired/triple light-framed groups.
 const flatAxes=[1.35,2.67,3.99,14.13,16.68,17.75,18.82,21.20,28.34,29.49,30.64,33.38];
 for(let row=0;row<4;row++)for(const[xIndex,x]of flatAxes.entries())window(w,x,bottoms[row]!,xIndex===3||xIndex===7||xIndex===11?.64:.79,heights[row]!,`b22-flat-${row+1}-${xIndex+1}`);
 // The native polygonal and rounded bays have continuous cream vertical frames.
 for(const[left,right,axes]of [[6.129,9.933,[6.68,7.73,8.67,9.39]],[9.933,12.918,[10.52,11.55,12.37]],[22.6196,25.7753,[23.22,24.20,25.16]]]as const){
  w.rect(left,belt+.24,.14,top-belt-.55,'#eee8d7');w.rect(right-.14,belt+.24,.14,top-belt-.55,'#eee8d7');
  for(let row=0;row<4;row++)for(const[i,x]of axes.entries())window(w,x,bottoms[row]!,row===3?.50:.60,heights[row]!,`b22-bay-${left}-${row+1}-${i+1}`);
  for(let row=0;row<3;row++)w.rect(left,bottoms[row]!+heights[row]!+.22,right-left,.13,'#e6decc');
 }
 // One gently arched cream ornament above the central triple middle-row group.
 w.pieces.push(`<path data-feature="b22-central-shallow-arch" d="M 16.05 ${top-bottoms[1]!-heights[1]!-.17} Q 17.75 ${top-bottoms[1]!-heights[1]!-.75} 19.45 ${top-bottoms[1]!-heights[1]!-.17}" fill="none" stroke="#ece5d0" stroke-width=".12"/>`);
 for(const[x,width]of [[2.8,4.5],[7.8,2.5],[12,2.1],[17.7,4.3],[24.2,2.5],[29.5,4.1],[33.5,2.2]]as const){
  w.rect(x-width/2,ground+.30,width,belt-ground-.54,'#556a6a','b22-glazed-shopfront');w.line(x,ground+.32,x,belt-.25,'#dedccc',.08);
 }
 w.rect(16.73,ground+.12,2.04,3.17,'#69503b','b22-central-timber-door');for(const x of[17.22,17.73]){w.rect(x-.28,ground+.42,.49,1.2,'#826544');w.rect(x-.28,ground+1.89,.49,1.0,'#80958f');}w.line(17.75,ground+.13,17.75,ground+3.26,'#bda77f',.06);
 w.rect(0,top-.12,W,.12,'#7e8077','b22-dark-roof-edge');
}
