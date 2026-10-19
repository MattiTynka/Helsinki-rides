import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {findGroundInterfaceSeals,meshGroundInterfaceSeals,type GroundInterfaceSource} from '../lib/ground-interface-seals.ts';
import {bbox,type LocalPolygon} from '../lib/geometry.ts';
const options={protectedArea:{minX:-20,maxX:-10,minZ:-20,maxZ:-10}};
const mesh=(id:string,tag:string,positions:number[],indices=[0,1,2,0,2,3]):GroundInterfaceSource=>({id,cell:'cell',tag,positions,indices});
const floor=mesh('floor','raised:yard',[0,0,0,2,0,0,2,0,2,0,0,2],[0,2,1,0,3,2]);
const side=mesh('side','curb',[0,.14,0,2,.14,0,2,.3,0,0,.3,0]);
const mask=(id:string,rings:[number,number][][]):LocalPolygon=>({id,rings,bbox:bbox(rings),properties:{}});
const rayTriangle=(O:number[],D:number[],a:number[],b:number[],c:number[])=>{const sub=(a:number[],b:number[])=>a.map((v,i)=>v-b[i]!),cross=(a:number[],b:number[])=>[a[1]!*b[2]!-a[2]!*b[1]!,a[2]!*b[0]!-a[0]!*b[2]!,a[0]!*b[1]!-a[1]!*b[0]!],dot=(a:number[],b:number[])=>a.reduce((s,v,i)=>s+v*b[i]!,0),e1=sub(b,a),e2=sub(c,a),h=cross(D,e2),den=dot(e1,h);if(Math.abs(den)<1e-10)return false;const f=1/den,s=sub(O,a),u=f*dot(s,h),q=cross(s,e1),v=f*dot(D,q);return u>=0&&v>=0&&u+v<=1&&f*dot(e2,q)>=0;};
function hits(source:GroundInterfaceSource,O:number[],D:number[]){for(let i=0;i<source.indices.length;i+=3){const v=[0,1,2].map(k=>Array.from({length:3},(_,a)=>source.positions[source.indices[i+k]!*3+a]!));if(rayTriangle(O,D,v[0]!,v[1]!,v[2]!))return true;}return false;}

test('a floating lower curb edge closes to actual coincident support, preserving input arrays',()=>{
 const before=JSON.stringify([floor,side]),result=findGroundInterfaceSeals([floor,side],options);assert.equal(result.seals.length,1);assert.ok(result.seals[0]!.gap.every(v=>Math.abs(v-.14)<1e-6));const added=meshGroundInterfaceSeals(result.seals);assert.ok(added.indices.length>0);assert.equal(JSON.stringify([floor,side]),before);
 for(let i=0;i<added.positions.length;i+=3){assert.equal(added.positions[i+2],0);assert.ok(added.positions[i+1]!>=0&&added.positions[i+1]!<=.140001,'Only the missing vertical interface may be filled');}
});
test('coincident sound support, upper edges, absent source edge, and excessive gaps do not create seals',()=>{
 const joined=mesh('joined','curb',[0,0,0,2,0,0,2,.3,0,0,.3,0]);assert.equal(findGroundInterfaceSeals([floor,joined],options).seals.length,0);
 const raised=mesh('too-high','curb',[0,.3,0,2,.3,0,2,.6,0,0,.6,0]);assert.equal(findGroundInterfaceSeals([floor,raised],options).seals.length,0);
 assert.equal(findGroundInterfaceSeals([side],options).seals.length,0);
 const displaced={...floor,positions:Array.from(floor.positions,(v,i)=>i%3===2?v+.001:v)};assert.equal(findGroundInterfaceSeals([side,displaced],options).seals.length,0,'A 1mm plan offset is not Float32 error and cannot become paving');
});
test('highest coincident lower support wins; a floor above the opening is not a side face',()=>{
 const lower=mesh('lower','raised:yard',[0,-.01,0,2,-.01,0,2,-.01,2,0,-.01,2],[0,2,1,0,3,2]);
 const upper=mesh('upper','raised:asphalt',[0,.2,0,2,.2,0,2,.2,2,0,.2,2],[0,2,1,0,3,2]);
 const r=findGroundInterfaceSeals([floor,lower,upper,side],options);assert.ok(r.seals.length);assert.ok(r.seals.every(s=>s.bottom.every(p=>Math.abs(p[1])<1e-6)));assert.ok(hits({...side,...meshGroundInterfaceSeals(r.seals)},[1,.07,-1],[0,0,1]));
});
test('existing full or partial vertical coverage is subtracted rather than duplicated or dropping the whole interval',()=>{
 const full=mesh('closed','curb',[0,0,0,2,0,0,2,.14,0,0,.14,0]);assert.equal(findGroundInterfaceSeals([floor,side,full],options).seals.length,0);
 const partial=mesh('partial','curb',[0,0,0,1,0,0,1,.14,0,0,.14,0]),r=findGroundInterfaceSeals([floor,side,partial],options),added={...side,...meshGroundInterfaceSeals(r.seals)};
 assert.ok(hits(added,[1.5,.07,-1],[0,0,1]));assert.equal(hits(added,[.5,.07,-1],[0,0,1]),false);assert.ok(r.counts.partialExistingFace);
});
test('accepted interiors, explicit masks and water remain open; a real supported deck permits its lower side only',()=>{
 assert.equal(findGroundInterfaceSeals([floor,side],{...options,protectedArea:{minX:-1,maxX:3,minZ:-1,maxZ:1}}).seals.length,0);
 const water=mask('water',[[[-1,-3],[3,-3],[3,1],[-1,1],[-1,-3]]]),deck=mask('actual-deck',[[[0,-2],[2,-2],[2,0],[0,0],[0,-2]]]);
 assert.equal(findGroundInterfaceSeals([floor,side],{...options,waterMasks:[water]}).seals.length,0);
 assert.ok(findGroundInterfaceSeals([floor,side],{...options,waterMasks:[water],registeredDecks:[deck]}).seals.length);
 assert.equal(findGroundInterfaceSeals([side],{...options,waterMasks:[water],registeredDecks:[deck]}).seals.length,0,'A real deck mask alone never invents ground or closes its underside');
 assert.equal(findGroundInterfaceSeals([floor,side],{...options,excludedMasks:[water],registeredDecks:[deck]}).seals.length,0);
});
test('actual frozen Uspenski and bridge-wedge rays miss the old mesh and hit the source-bound appended geometry',()=>{
 const fixture=JSON.parse(readFileSync(new URL('./fixtures/ground-interface-seams.json',import.meta.url),'utf8'));
 for(const f of fixture.fixtures){const s:GroundInterfaceSource={id:f.id,cell:f.cell,positions:f.positions,indices:f.indices,triangleTags:f.triangleTags},before=JSON.stringify(s),r=findGroundInterfaceSeals([s],options),a={id:'appended',cell:f.cell,...meshGroundInterfaceSeals(r.seals)};
  for(const ray of f.rays){assert.equal(hits(s,ray.origin,ray.direction),false,`${f.id} ${ray.pixel} negative control`);assert.ok(hits(a,ray.origin,ray.direction),`${f.id} ${ray.pixel} missing vertical must be closed`);}
  assert.equal(JSON.stringify(s),before);
 }
});
