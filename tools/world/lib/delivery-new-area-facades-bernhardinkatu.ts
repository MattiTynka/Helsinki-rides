// Individually observed northern street front of the German congregation annex.
import assert from 'node:assert/strict';
import type {OriginalWallArt} from '../author_senate_facade_charts.ts';
import type {ReferenceFacadeArt} from './delivery-new-area-facades-reference-art.ts';

export function qualifyBernhardinkatuAnnexGround(p:{id:string;building:{id:string;vtj:string};triangles:number[];observedGroundProfile:{kind:string;manifestSha256:string;sampleHeights:number[];horizontalDatumFromNativeTop:number}},expected:string,maxY:number,samples:readonly{collision:{height:number}}[]){
 assert.equal(p.id,'bernhardinkatu-4-annex-north-20261021');assert.equal(p.building.vtj,'103046324Y');
 assert.equal(p.building.id,'BID_b3768187-2d44-4707-8248-2cecc2787a45');
 assert.deepEqual(p.triangles,[213,214,215,216,217,258,259,260,261,274,275,276,277]);
 assert.equal(p.observedGroundProfile.kind,'source-measured-sloped-plinth-horizontal-opening-bands');assert.equal(p.observedGroundProfile.manifestSha256,expected);
 assert.equal(p.observedGroundProfile.sampleHeights.length,9);assert.equal(samples.length,9);
 samples.forEach((s,i)=>assert.ok(Number.isFinite(s.collision.height)&&Math.abs(s.collision.height-p.observedGroundProfile.sampleHeights[i]!)<1e-6,'Requalify changed observed street floor'));
 assert.equal(p.observedGroundProfile.horizontalDatumFromNativeTop,-5.8);assert.ok(Number.isFinite(maxY));
 return maxY+p.observedGroundProfile.horizontalDatumFromNativeTop;
}

export function renderBernhardinkatu4AnnexBrick(w:OriginalWallArt,ground:number,art:ReferenceFacadeArt,floors:readonly{u:number;collision:{height:number}}[]) {
 assert.ok(w.width>19&&w.width<21&&art.rows.length===1&&art.rows[0]!.axes.length===6);
 const row=art.rows[0]!;
 assert.equal(floors.length,9);
 // Only the plinth follows the measured street. Windows and cornice stay level.
 w.rect(0,w.minY,w.width,ground+row.bottom-.35-w.minY,art.wallColour,'annex-brick-below-level-windows');
 const edge=[[0,floors[0]!.collision.height+.85],...floors.map(s=>[s.u,s.collision.height+.85]),[w.width,floors.at(-1)!.collision.height+.85]];
 w.pieces.push(`<polygon data-feature="annex-source-measured-sloping-stone-plinth" points="0,${w.maxY-w.minY} ${edge.map(([u,y])=>`${u},${w.maxY-y!}`).join(' ')} ${w.width},${w.maxY-w.minY}" fill="${art.groundColour}"/>`);
 const clearOfOpening=(x:number,y:number)=>!row.axes.some(axis=>Math.abs(x-axis)<row.width/2+.30&&y>ground+row.bottom-.35&&y<ground+row.bottom+row.height+.45);
 // Painted brick joints stop around the six observed openings and pale surrounds.
 for(let course=0,y=Math.max(...floors.map(s=>s.collision.height))+.94;y<w.maxY-.12;y+=.135,course++) {
  for(let x=0;x<w.width;x+=.28){const end=Math.min(w.width,x+.28);if(clearOfOpening((x+end)/2,y))w.line(x,y,end,y,'#a57661',.012);}
  for(let x=(course%2)*.14;x<w.width;x+=.28)if(clearOfOpening(x,y+.067))w.line(x,y,x,Math.min(y+.135,w.maxY-.12),'#a57661',.012);
 }
 for(const x of [2.62,6.06,9.45,13.02,19.42])w.rect(Math.max(0,x-.10),Math.max(...floors.map(s=>s.collision.height))+.92,.20,Math.max(.05,w.maxY-Math.max(...floors.map(s=>s.collision.height))-1.13),'#8e5140','annex-observed-brick-pilaster');
 const belt=w.maxY-1.05;
 for(let x=.22;x<w.width-.2;x+=.34)w.rect(x,belt,.19,.15,'#6f463a','annex-corbelling');
 for(const y of [w.maxY-.18,w.maxY-.46,w.maxY-.80])w.line(0,y,w.width,y,'#754c3f',.065);
 for(let x=.18;x<w.width;x+=1.1)w.line(x,w.minY,x,Math.min(...floors.map(s=>s.collision.height))+.83,'#a59f91',.035);
}
