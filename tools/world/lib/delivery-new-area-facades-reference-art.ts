// Shared drawing primitives; every building still needs its own observed plan.
import assert from 'node:assert/strict';
import type {OriginalWallArt} from '../author_senate_facade_charts.ts';
export interface ReferenceFacadeArt {
  wallColour:string;groundColour:string;surroundColour:string;frameColour:string;glassColour:string;
  groundHeight:number;
  rows:{bottom:number;height:number;width:number;axes:number[];header:'none'|'flat'|'triangle'|'arch'}[];
  groundOpenings:{x:number;bottom:number;width:number;height:number;kind:'glazing'|'door'|'passage'}[];
  bands:{from:'ground'|'top';offset:number;height:number;colour:string}[];
  rustication:{bottom:number;top:number;spacing:number;colour:string}|null;
}
const keys=(v:object,names:readonly string[])=>assert.deepEqual(Object.keys(v).sort(),[...names].sort(),'Unexpected or missing original art fields');
function colour(v:unknown):asserts v is string{assert.ok(typeof v==='string'&&/^#[0-9a-f]{6}$/i.test(v),'Original art colours must be literal RGB hex');}
function number(v:unknown,min:number,max:number):asserts v is number{assert.ok(typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max);}
export function readReferenceFacadeArt(v:unknown):ReferenceFacadeArt {
  assert.ok(v&&typeof v==='object'&&!Array.isArray(v));const a=v as ReferenceFacadeArt;
  keys(a,['wallColour','groundColour','surroundColour','frameColour','glassColour','groundHeight','rows','groundOpenings','bands','rustication']);
  for(const c of[a.wallColour,a.groundColour,a.surroundColour,a.frameColour,a.glassColour])colour(c);number(a.groundHeight,0,8);
  assert.ok(Array.isArray(a.rows)&&a.rows.length<=16&&Array.isArray(a.groundOpenings)&&a.groundOpenings.length<=100&&Array.isArray(a.bands)&&a.bands.length<=40);
  for(const r of a.rows){keys(r,['bottom','height','width','axes','header']);number(r.bottom,0,60);number(r.height,.2,6);number(r.width,.2,5);assert.ok(['none','flat','triangle','arch'].includes(r.header));assert.ok(Array.isArray(r.axes)&&r.axes.length>0&&r.axes.length<=100);for(const x of r.axes)number(x,0,200);assert.equal(new Set(r.axes).size,r.axes.length);}
  for(const o of a.groundOpenings){keys(o,['x','bottom','width','height','kind']);number(o.x,0,200);number(o.bottom,0,4);number(o.width,.3,10);number(o.height,.4,7);assert.ok(['glazing','door','passage'].includes(o.kind));}
  for(const b of a.bands){keys(b,['from','offset','height','colour']);assert.ok(['ground','top'].includes(b.from));number(b.offset,-60,60);number(b.height,.01,2);colour(b.colour);}
  if(a.rustication){keys(a.rustication,['bottom','top','spacing','colour']);number(a.rustication.bottom,0,8);number(a.rustication.top,.1,8);assert.ok(a.rustication.top>a.rustication.bottom);number(a.rustication.spacing,.1,2);colour(a.rustication.colour);}
  return a;
}
export function renderReferenceFacade(w:OriginalWallArt,ground:number,a:ReferenceFacadeArt,options:{skipGroundOpenings?:boolean}={}) {
  readReferenceFacadeArt(a);w.rect(0,w.minY,w.width,w.maxY-w.minY,a.wallColour,'observed-wall-finish');
  w.rect(0,w.minY,w.width,Math.max(.01,ground-w.minY+a.groundHeight),a.groundColour,'observed-ground-storey');
  if(a.rustication)for(let y=a.rustication.bottom;y<a.rustication.top;y+=a.rustication.spacing)w.line(0,ground+y,w.width,ground+y,a.rustication.colour,.035);
  for(const[i,r]of a.rows.entries())for(const[j,x]of r.axes.entries()) {
    assert.ok(x-r.width/2>=-.15&&x+r.width/2<=w.width+.15,'Observed opening extends past this exact elevation');
    assert.ok(ground+r.bottom+r.height<=w.maxY+.1,'Observed opening above selected native wall');
    const left=x-r.width/2,y=ground+r.bottom,id=`observed-row-${i}-opening-${j}`;
    w.rect(left-.12,y-.12,r.width+.24,r.height+.24,a.surroundColour,id+'-surround');
    w.rect(left,y,r.width,r.height,a.frameColour,id+'-frame');w.rect(left+.09,y+.09,r.width-.18,r.height-.18,a.glassColour,id+'-glass');
    w.line(x,y,x,y+r.height,a.frameColour,.07);w.line(left,y+r.height*.69,left+r.width,y+r.height*.69,a.frameColour,.065);
    w.rect(left-.17,y-.17,r.width+.34,.12,a.surroundColour,id+'-sill');
    if(r.header==='flat')w.rect(left-.22,y+r.height+.14,r.width+.44,.13,a.surroundColour,id+'-lintel');
    if(r.header==='triangle'||r.header==='arch') {
      const top=w.maxY-y-r.height-.16;
      const segment=r.header==='triangle'?`L ${x} ${top-.34} L ${left+r.width+.22} ${top}`:`Q ${x} ${top-.54} ${left+r.width+.22} ${top}`;
      w.pieces.push(`<path data-feature="${id}-header" d="M ${left-.22} ${top} ${segment}" fill="none" stroke="${a.surroundColour}" stroke-width=".15"/>`);
    }
  }
  for(const[i,o]of(options.skipGroundOpenings?[]:a.groundOpenings).entries()) {
    const left=o.x-o.width/2,y=ground+o.bottom;assert.ok(left>=-.1&&left+o.width<=w.width+.1&&y+o.height<=w.maxY);
    const fill=o.kind==='passage'?'#353c3c':o.kind==='door'?'#70513e':a.glassColour;
    w.rect(left-.10,y-.10,o.width+.20,o.height+.20,a.surroundColour,`observed-ground-${i}-surround`);w.rect(left,y,o.width,o.height,fill,`observed-ground-${i}`);
    if(o.kind==='glazing')w.line(o.x,y,o.x,y+o.height,a.frameColour,.09);
    if(o.kind==='door'){w.rect(left+.16,y+.35,Math.max(.1,o.width-.32),Math.max(.1,o.height-.75),a.glassColour);w.line(o.x,y,o.x,y+o.height,'#96734e',.07);}
  }
  for(const[i,b]of a.bands.entries())w.rect(0,(b.from==='ground'?ground:w.maxY)+b.offset,w.width,b.height,b.colour,`observed-band-${i}`);
}
