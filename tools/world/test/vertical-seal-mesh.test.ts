import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {meshVerticalSeals,type VerticalSeal} from '../lib/vertical-seal-mesh.ts';
const seal=(section:number[][][]):VerticalSeal=>({top:[[0,2,0],[4,2,2]],bottom:[[0,0,0],[4,0,2]],section:section as any,polygon:section.map(r=>r.map(([t,h])=>[4*t!,h!,2*t!] as const))});
function vertical(mesh:ReturnType<typeof meshVerticalSeals>){assert.ok(mesh.indices.length>0);for(let i=0;i<mesh.indices.length;i+=3){const[a,b,c]=[0,1,2].map(k=>mesh.positions.slice(mesh.indices[i+k]!*3,mesh.indices[i+k]!*3+3)),u=b!.map((x,k)=>x-a![k]!),v=c!.map((x,k)=>x-a![k]!);assert.ok((u[2]!*v[0]!-u[0]!*v[2]!)===0);assert.ok(Math.hypot(u[1]!*v[2]!-u[2]!*v[1]!,u[0]!*v[1]!-u[1]!*v[0]!)>0);}}
test('quad and triangular sections preserve area and every Float32 face has a vertical pair',()=>{
 for(const section of [[[[0,0],[1,0],[1,2],[0,2]]],[[[.3,0],[.7,0],[1,2]]]]){const s=seal(section),before=JSON.stringify(s),m=meshVerticalSeals([s]);vertical(m);assert.ok(m.stats.maximumSectionAreaError<1e-12);assert.equal(JSON.stringify(s),before);}
});
test('partial old-face subtraction and holes remain empty with exact even-odd area',()=>{
 const s=seal([[[0,0],[1,0],[1,2],[0,2]],[[.25,.5],[.25,1.5],[.75,1.5],[.75,.5]]]),m=meshVerticalSeals([s]);vertical(m);assert.equal(m.stats.sectionAreaBefore,1.5);assert.equal(m.stats.sectionAreaAfter,1.5);
 // Every emitted triangle lies in a station strip; none can bridge the hole.
 for(let i=0;i<m.positions.length;i+=9){const t=(m.positions[i]!+m.positions[i+3]!+m.positions[i+6]!)/12,h=(m.positions[i+1]!+m.positions[i+4]!+m.positions[i+7]!)/3;assert.ok(!(t>.25&&t<.75&&h>.5&&h<1.5));}
});
test('non-normalized section stations use the paired actual source XZ instead of audit top interpolation',()=>{
 const s=seal([[[3,0],[4,0],[4,1],[3,1]]]);const m=meshVerticalSeals([s]);vertical(m);assert.ok(m.positions.filter((_,i)=>i%3===0).every(x=>x===12||x===16));
});
test('the actual worst earcut/F32 horizontal sliver stays vertical without changing qualified area',()=>{
 const f=JSON.parse(readFileSync(new URL('./fixtures/vertical-seal-sliver.json',import.meta.url),'utf8')),m=meshVerticalSeals([f.seal]);vertical(m);assert.ok(m.stats.maximumSectionAreaError<1e-12);assert.equal(m.stats.maximumNormalY,0);
});
test('only Float32-collapsed or zero-area faces may be skipped',()=>{
 const s=seal([[[0,0],[1,0],[1,1],[0,1]]]);s.polygon[0]!.forEach((p:any)=>{p[0]=Math.fround(1000+p[0]*1e-9);p[2]=Math.fround(1000+p[2]*1e-9);});const m=meshVerticalSeals([s]);assert.equal(m.indices.length,0);assert.equal(m.stats.collapsedStationIntervals,1);assert.equal(m.stats.sectionAreaBefore,m.stats.sectionAreaAfter);
});
test('the actual external-hole precision witness cannot become an outside island or remove its source quad',()=>{
 const f=JSON.parse(readFileSync(new URL('./fixtures/vertical-seal-external-hole.json',import.meta.url),'utf8')),m=meshVerticalSeals([f.seal]);vertical(m);assert.ok(Math.abs(m.stats.sectionAreaAfter-f.sourceArea)<1e-12);assert.ok(m.stats.holeAreaOutsideOuter>0);assert.equal(m.stats.holeAreaInsideOuter,0);
 const xs=f.seal.top.map((p:number[])=>p[0]);for(let i=0;i<m.positions.length;i+=3)assert.ok(m.positions[i]!>=Math.min(...xs)&&m.positions[i]!<=Math.max(...xs));
});
test('overlapping holes are subtracted as a union within the outer polygon',()=>{
 const s=seal([[[0,0],[1,0],[1,2],[0,2]],[[.2,.25],[.8,.25],[.8,1.25],[.2,1.25]],[[.4,.75],[.9,.75],[.9,1.75],[.4,1.75]]]),m=meshVerticalSeals([s]);vertical(m);assert.ok(Math.abs(m.stats.sectionAreaAfter-1.1)<1e-12);assert.ok(m.stats.maximumSectionAreaError<1e-12);
});
