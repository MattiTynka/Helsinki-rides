import assert from 'node:assert/strict';
import type {OriginalWallArt} from '../author_senate_facade_charts.ts';

export type ObservedWallFinish={kind:'plain';colour:string}|{kind:'brick';colour:string;mortarColour:string;moduleWidth:number;moduleHeight:number};
export function observedFinishFaceGroups(plan:{faces?:unknown;planes?:unknown},finish:ObservedWallFinish):{id:string;faces:{part:number;triangle:number}[]}[] {
  assert.ok((plan.faces===undefined)!==(plan.planes===undefined),'Exactly one explicit face list or plane list is required');
  const groups=plan.faces===undefined?plan.planes:[{id:'single',faces:plan.faces}];assert.ok(Array.isArray(groups)&&groups.length>0&&groups.length<=64);
  readObservedWallFinish(finish);
  const ids=new Set<string>(),faces=new Set<string>();
  return groups.map(g=>{assert.ok(g&&typeof g==='object');assert.deepEqual(Object.keys(g).sort(),['faces','id']);assert.ok(typeof g.id==='string'&&/^[a-z0-9-]{1,80}$/.test(g.id)&&!ids.has(g.id));ids.add(g.id);assert.ok(Array.isArray(g.faces)&&g.faces.length>0&&g.faces.length<=2000);
    return{id:g.id,faces:g.faces.map((f:any)=>{assert.deepEqual(Object.keys(f).sort(),['part','triangle']);assert.ok(Number.isSafeInteger(f.part)&&f.part>=0&&Number.isSafeInteger(f.triangle)&&f.triangle>=0);const key=`${f.part}:${f.triangle}`;assert.ok(!faces.has(key),'Repeated native face across finish planes');faces.add(key);return{part:f.part,triangle:f.triangle};})};});
}
/** Brick planes require their own metric artwork. A shared uniform tile remains
 * valid for plain finishes, but reusing a first plane's brick chart rescales the
 * modules on every differently sized return. */
export function observedFinishAtlasLayout(planes:readonly{id:string;width:number;height:number}[],finish:ObservedWallFinish):{size:512|1024;pixels:readonly(readonly[number,number,number,number])[];sharedPlainTile:boolean;texelsPerMetre:number|null;gutter:number}{
 readObservedWallFinish(finish);assert.ok(planes.length>0&&planes.length<=64);assert.equal(new Set(planes.map(p=>p.id)).size,planes.length);
 for(const p of planes)assert.ok(Number.isFinite(p.width)&&Number.isFinite(p.height)&&p.width>0&&p.width<=200&&p.height>0&&p.height<=100);
 if(planes.length===1||finish.kind==='plain')return{size:512,pixels:planes.map(()=>[2,2,508,508]as const),sharedPlainTile:planes.length>1,texelsPerMetre:null,gutter:2};
 const size=1024 as const,gutter=8,total=planes.reduce((s,p)=>s+p.width*p.height,0),maximum=Math.max(...planes.flatMap(p=>[p.width,p.height]));let density=Math.min(64,Math.sqrt(size*size*.55/total),(size-gutter*2)/maximum);
 for(;;){let x=gutter,y=gutter,rowHeight=0,fits=true;const pixels:(readonly[number,number,number,number])[]=[],items=planes.map((p,i)=>({i,width:Math.max(3,Math.ceil(p.width*density)),height:Math.max(3,Math.ceil(p.height*density))})).sort((a,b)=>b.height-a.height||b.width-a.width||a.i-b.i);
  for(const p of items){if(x+p.width+gutter>size){x=gutter;y+=rowHeight+gutter;rowHeight=0;}if(y+p.height+gutter>size){fits=false;break;}pixels[p.i]=[x,y,p.width,p.height];x+=p.width+gutter;rowHeight=Math.max(rowHeight,p.height);}
  if(fits)return{size,pixels,sharedPlainTile:false,texelsPerMetre:density,gutter};density*=.85;assert.ok(density>.01,'Observed physical finish planes do not fit the bounded atlas');
 }
}
export function readObservedWallFinish(value:unknown):ObservedWallFinish {
  assert.ok(value&&typeof value==='object'&&!Array.isArray(value));const f=value as ObservedWallFinish;
  assert.ok(f.kind==='plain'||f.kind==='brick');
  assert.deepEqual(Object.keys(f).sort(),(f.kind==='plain'?['kind','colour']:['kind','colour','mortarColour','moduleWidth','moduleHeight']).sort());
  for(const c of f.kind==='plain'?[f.colour]:[f.colour,f.mortarColour])assert.match(c,/^#[0-9a-f]{6}$/i);
  if(f.kind==='brick'){assert.ok(Number.isFinite(f.moduleWidth)&&f.moduleWidth>=.15&&f.moduleWidth<=2);assert.ok(Number.isFinite(f.moduleHeight)&&f.moduleHeight>=.08&&f.moduleHeight<=1);}
  return f;
}
/** A finish has no windows, floors, doors or assumed ground. It is only valid
 * when the plan records the actual observed material role of this source plane. */
export function renderObservedWallFinish(w:OriginalWallArt,finish:ObservedWallFinish) {
  const f=readObservedWallFinish(finish);assert.ok(w.width>0&&w.width<=200&&w.maxY>w.minY&&w.maxY-w.minY<=100);
  w.rect(0,w.minY,w.width,w.maxY-w.minY,f.colour,'observed-uninterrupted-wall-finish');
  if(f.kind==='plain')return;
  let row=0;
  for(let y=w.minY;y<w.maxY;y+=f.moduleHeight,row++) {
    w.line(0,y,w.width,y,f.mortarColour,.014);
    for(let x=(row%2)*f.moduleWidth/2;x<w.width;x+=f.moduleWidth)w.line(x,y,x,Math.min(w.maxY,y+f.moduleHeight),f.mortarColour,.014);
  }
}
