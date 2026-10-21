/** Original material/trim details for individually observed Linjat elevations.
 * Opening locations remain the exact source-bound plan's responsibility. */
import assert from'node:assert/strict';
import type{OriginalWallArt}from'../author_senate_facade_charts.ts';
import{readReferenceFacadeArt,type ReferenceFacadeArt}from'./delivery-new-area-facades-reference-art.ts';
type Floor={u:number;collision:{height:number}};
const timberIds=new Set(['toinen-linja-12-103151970W-northeast-20261021','toinen-linja-12-103151970W-northwest-20261021','toinen-linja-12-103151972Y-northeast-20261021','toinen-linja-12-103151972Y-northwest-20261021']);
const officeId='toinen-linja-14-alppikatu-northwest-20261021';
function horizontalExclusions(a:ReferenceFacadeArt,datum:number,y:number){return[...a.rows.flatMap(r=>y>=datum+r.bottom-.25&&y<=datum+r.bottom+r.height+.4?r.axes.map(x=>[x-r.width/2-.25,x+r.width/2+.25]as[number,number]):[]),...a.groundOpenings.flatMap(o=>y<=datum+o.bottom+o.height+1&&y>=datum-1?[[o.x-o.width/2-.22,o.x+o.width/2+.22]as[number,number]]:[])].sort((l,r)=>l[0]-r[0]);}
function clearSpans(width:number,excluded:readonly[number,number][]){const spans:[number,number][]=[],stop=(x:number)=>Math.max(0,Math.min(width,x));let at=0;for(const[l,r]of excluded){if(stop(l)>at)spans.push([at,stop(l)]);at=Math.max(at,stop(r));}if(at<width)spans.push([at,width]);return spans;}
function floorAt(samples:readonly Floor[],x:number){assert.equal(samples.length,9);if(x<=samples[0]!.u)return samples[0]!.collision.height;for(let i=1;i<samples.length;i++){const a=samples[i-1]!,b=samples[i]!;if(x<=b.u)return a.collision.height+(b.collision.height-a.collision.height)*(x-a.u)/(b.u-a.u);}return samples.at(-1)!.collision.height;}
function belowBase(samples:readonly Floor[],width:number,y:number){const p=[{u:0,collision:samples[0]!.collision},...samples,{u:width,collision:samples.at(-1)!.collision}],out:[number,number][]=[];for(let i=1;i<p.length;i++){const a=p[i-1]!,b=p[i]!,lo=a.collision.height+.23,hi=b.collision.height+.23;if(y<lo&&y<hi)out.push([a.u,b.u]);else if(y<lo||y<hi){const cut=a.u+(b.u-a.u)*(y-lo)/(hi-lo);out.push(y<lo?[a.u,cut]:[cut,b.u]);}}return out;}
export function renderLinjatMaterialDetails(w:OriginalWallArt,datum:number,a:ReferenceFacadeArt,samples:readonly Floor[],id:string){
 readReferenceFacadeArt(a);assert.ok(timberIds.has(id)||id===officeId,'Unreviewed Linjat material/architecture role');
 if(id===officeId){
  // Exact metric clay-brick courses on opaque spandrels/piers only. Window glass
  // is not striped and the observed horizontal opening bands stay untouched.
  const rowHeight=.12,moduleWidth=.26;
  for(let y=w.minY,k=0;y<w.maxY;y+=rowHeight,k++){
   const spans=clearSpans(w.width,[...horizontalExclusions(a,datum,y),...belowBase(samples,w.width,y)].sort((l,r)=>l[0]-r[0]));for(const[l,r]of spans)w.line(l,y,r,y,'#986951',.012);
   for(let x=(k%2)*moduleWidth/2;x<w.width;x+=moduleWidth){const middle=y+rowHeight/2;if(y<floorAt(samples,x)+.23||horizontalExclusions(a,datum,middle).some(([l,r])=>x>=l&&x<=r))continue;w.line(x,y,x,Math.min(w.maxY,y+rowHeight),'#986951',.010);}
  }
  for(const row of a.rows)for(const x of row.axes){const left=x-row.width/2,y=datum+row.bottom;for(let k=1;k<6;k++)w.line(left+row.width*k/6,y+.09,left+row.width*k/6,y+row.height-.09,a.frameColour,.035);w.rect(left-.08,y-.18,row.width+.16,.08,'#b5aa91','linjat-office-observed-window-sill');}
  return;
 }
 // The actually observed timber houses have horizontal upper clapboard and a
 // lower vertical-board apron. No additional storeys/openings are introduced.
 for(let y=datum+2.1;y<w.maxY-.45;y+=.16)for(const[l,r]of clearSpans(w.width,horizontalExclusions(a,datum,y)))w.line(l,y,r,y,'#c6bc9e',.018);
 const apronTop=datum+Math.min(2.02,...a.rows.map(r=>r.bottom-.25));
 for(let x=.11;x<w.width;x+=.15){const low=floorAt(samples,x)+.28,high=apronTop;if(high<=low||a.groundOpenings.some(o=>x>=o.x-o.width/2-.22&&x<=o.x+o.width/2+.22))continue;w.line(x,low,x,high,'#c7bc9c',.016);}
 for(const[rIndex,row]of a.rows.entries())for(const[i,x]of row.axes.entries()){
  const y=datum+row.bottom,left=x-row.width/2,top=y+row.height,transom=y+row.height*.72;
  w.line(left,transom,left+row.width,transom,'#eee8d5',.075);
  // Small diagonal upper panes are visibly present in the historic white trim.
  const panels=Math.max(1,Math.round(row.width/.65));for(let k=0;k<panels;k++){const l=left+k*row.width/panels,r=left+(k+1)*row.width/panels;w.line(l+.055,transom+.055,r-.055,top-.055,'#e9e4d1',.045);w.line(l+.055,top-.055,r-.055,transom+.055,'#e9e4d1',.045);}
  w.rect(left-.23,top+.18,row.width+.46,.13,'#e3dbc6',`linjat-timber-lintel-${rIndex}-${i}`);w.line(left-.26,top+.33,left+row.width+.26,top+.33,'#bcb297',.035);
 }
 w.rect(0,w.maxY-.40,w.width,.16,'#ddd2b7','linjat-timber-eave');
 if(id==='toinen-linja-12-103151972Y-northeast-20261021')for(const o of a.groundOpenings.filter(o=>o.kind==='door')){const y=floorAt(samples,o.x)+o.bottom,left=o.x-o.width/2;w.rect(left,y,o.width,o.height,'#88938d','linjat-observed-blue-gray-timber-door');for(const v of[1/3,2/3])w.line(left+o.width*v,y+.08,left+o.width*v,y+o.height-.08,'#abb1a4',.025);}
}
