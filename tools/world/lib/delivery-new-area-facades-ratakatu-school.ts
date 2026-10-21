// Individually observed recessed upper wall above the Norssi entrance porch.
import assert from'node:assert/strict';import type{OriginalWallArt}from'../author_senate_facade_charts.ts';
function roundWindow(w:OriginalWallArt,x:number,y:number,width:number,height:number,id:string){
 const shape=(left:number,bottom:number,span:number,tall:number,fill:string,key:string)=>{const right=left+span,base=w.maxY-bottom,spring=w.maxY-bottom-tall+span/2;w.pieces.push(`<path data-feature="${key}" d="M${left},${base}V${spring}A${span/2},${span/2} 0 0 1 ${right},${spring}V${base}Z" fill="${fill}"/>`);};
 shape(x-width/2-.19,y-.13,width+.38,height+.30,'#9a5144',id+'-brick-arch');shape(x-width/2-.055,y-.025,width+.11,height+.08,'#d6ccba',id+'-pale-rim');shape(x-width/2,y,width,height,'#68796e',id+'-frame');shape(x-width/2+.09,y+.10,width-.18,height-.20,'#99a7a0',id+'-glass');w.line(x,y+.1,x,y+height-.20,'#d9d5bf',.07);w.line(x-width/2+.09,y+height*.48,x+width/2-.09,y+height*.48,'#d9d5bf',.07);w.rect(x-width/2-.20,y-.20,width+.40,.12,'#a16854',id+'-sill');
}
export function renderRatakatuSchoolRecessedUpper(w:OriginalWallArt){
 assert.ok(w.width>27&&w.width<28&&w.minY>14&&w.minY<15&&w.maxY>25&&w.maxY<26);
 const axes=[.10,.19,.28,.41,.50,.59,.72,.81,.90].map(f=>w.width*f);
 for(const[i,x]of axes.entries()){roundWindow(w,x,w.maxY-4.6,1.6,2.9,`norssi-upper-${i}`);roundWindow(w,x,w.maxY-8.4,1.22,1.85,`norssi-lower-${i}`);}
 for(const fraction of[.335,.665])w.rect(w.width*fraction-.09,w.minY,.18,w.maxY-w.minY,'#b4a48d','norssi-recess-bay-divider');
 w.rect(0,w.maxY-.40,w.width,.27,'#985345','norssi-original-brick-cap');
 for(let x=.13;x<w.width;x+=.34)w.rect(x,w.maxY-.70,.17,.30,'#995646','norssi-original-brick-corbel');w.rect(0,w.maxY-.11,w.width,.11,'#5f6056','norssi-original-dark-roof-edge');
}
export function renderRatakatuSchoolPorch(w:OriginalWallArt){
 assert.ok(w.width>26&&w.width<29&&w.minY>5&&w.minY<7&&w.maxY>14&&w.maxY<15);
 const base=w.maxY-5.55;
 w.rect(0,w.minY,w.width,base+.16-w.minY,'#87877c','norssi-porch-stone-base');
 for(const[i,f]of[.095,.19,.285,.715,.81,.905].entries())roundWindow(w,w.width*f,base+.46,1.85,3.35,`norssi-porch-round-window-${i}`);
 const centre=w.width/2,left=centre-3.75,right=centre+3.75,top=w.maxY-.8,spring=top-2.25;
 // Broad brick entrance arch and original central timber door beneath it.
 w.pieces.push(`<path data-feature="norssi-original-wide-entry-arch" d="M${left},${w.maxY-base}V${w.maxY-spring}Q${centre},${w.maxY-top-1.9} ${right},${w.maxY-spring}V${w.maxY-base}" stroke="#9b5445" stroke-width=".53" fill="none"/>`);
 w.rect(centre-1.10,base,2.20,2.95,'#6b4d35','norssi-original-timber-entrance');
 for(const dx of[-.57,.57])for(const y of[.22,1.12,2.0])w.rect(centre+dx-.41,base+y,.82,.58,'#8d6946','norssi-original-door-panel');w.line(centre,base,centre,base+2.95,'#be9b6e',.07);
 const fanBase=w.maxY-base-2.95;w.pieces.push(`<path data-feature="norssi-original-door-fanlight" d="M${centre-1.1},${fanBase}A1.1,1.1 0 0 1 ${centre+1.1},${fanBase}Z" fill="#53665b" stroke="#9c7954" stroke-width=".10"/>`);w.line(centre,base+2.97,centre,base+4.00,'#9c7954',.065);
 for(const sign of[-1,1])roundWindow(w,centre+sign*2.46,base+.39,1.06,2.55,`norssi-entry-side-${sign}`);
 w.rect(0,w.maxY-.22,w.width,.22,'#606259','norssi-porch-dark-cap');
 for(const[leftPart,rightPart]of[[.015,.335],[.665,.985]]as const)for(let x=w.width*leftPart;x<w.width*rightPart;x+=.35)w.rect(x,w.maxY-.61,.17,.28,'#9d5b49','norssi-porch-brick-dentil');
}
