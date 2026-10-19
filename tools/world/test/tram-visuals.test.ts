import {test} from 'node:test';
import assert from 'node:assert/strict';
import {tramFootprints,drapeTramFootprints,qualifyTramCoverageFringes,DEFAULT_TRAM_PROFILE,type TramTrack,type TramGroundTriangle} from '../lib/tram-visuals.ts';

const track=(wayId:number,points:[number,number,number][]):TramTrack=>({wayId,tags:{railway:'tram'},points:points.map(([nodeId,x,z])=>({nodeId,x,z}))});
function ground(y:(x:number,z:number)=>number=(x)=>x*.1):TramGroundTriangle[]{
 const p=(x:number,z:number)=>[x,y(x,z),z] as [number,number,number];return[
  {id:'a',vertices:[p(-2,-2),p(12,2),p(12,-2)],visual:{node:'source_ground_slabs',primitive:0,triangle:0},collision:{collider:'g:source',triangles:[0]},tag:'road'},
  {id:'b',vertices:[p(-2,-2),p(-2,2),p(12,2)],visual:{node:'source_ground_slabs',primitive:0,triangle:1},collision:{collider:'g:source',triangles:[1]},tag:'road'},
 ];
}
const bounds={minX:0,maxX:10,minZ:-2,maxZ:2};
test('1000mm measuring-face gauge is independent of head width and OSM source axis stays fixed',()=>{
 const source=track(12,[[1,0,0],[2,10,0]]),before=structuredClone(source),r=tramFootprints([source]);assert.deepEqual(source,before);
 const heads=r.filter(f=>f.kind==='head');assert.equal(heads.length,2);
 const intervals=heads.map(h=>h.polygon.map(p=>p[1]));assert.equal(Math.max(...intervals[0]!),-.5);assert.equal(Math.min(...intervals[1]!),.5);
 assert.ok(Math.abs(Math.max(...intervals[1]!)-Math.min(...intervals[1]!)-DEFAULT_TRAM_PROFILE.headWidthMetres)<1e-12);
 assert.throws(()=>tramFootprints([{...source,tags:{railway:'tram',tracks:'2'}}]),/multiple-track/);
});
test('degree-two OSM way joins share the continuation offset and do not invent a smoothing curve',()=>{
 const a=track(12,[[1,0,0],[2,5,0]]),b=track(13,[[2,5,0],[3,10,1]]),pieces=tramFootprints([a,b]);
 const left=pieces.find(p=>p.wayId===12&&p.kind==='head'&&p.polygon[0]![1]<0)!,right=pieces.find(p=>p.wayId===13&&p.kind==='head'&&p.polygon[3]![1]<0)!;
 assert.deepEqual(left.polygon[1],right.polygon[0]);assert.deepEqual(left.polygon[2],right.polygon[3]);
 assert.ok(left.polygon[1]![0]!==5,'Real offset-line intersection need not equal centreline vertex X');
});
test('a cut fork with two outgoing source branches is not misread as a backwards through continuation',()=>{
 const pieces=tramFootprints([track(12,[[1,0,0],[2,5,0]]),track(13,[[1,0,0],[3,5,.2]])]);assert.equal(pieces.length,12);
 for(const f of pieces)for(const p of f.polygon)assert.ok(Math.abs(p[0])<6&&Math.abs(p[1])<1,'Fork offsets must remain local');
});
test('rail triangles follow the exact sloping ground plane plus3mm and clip at cell bounds',()=>{
 const f=tramFootprints([track(12,[[1,-1,0],[2,11,0]])]),mesh=drapeTramFootprints(f,ground(),bounds);
 assert.ok(mesh.stats.triangles>0);assert.ok(mesh.stats.missingArea<1e-8);assert.ok(mesh.stats.maximumLiftError<1e-6);
 for(let i=0;i<mesh.positions.length;i+=3){const[x,y,z]=mesh.positions.slice(i,i+3) as [number,number,number];assert.ok(x>=0&&x<=10&&z>=-2&&z<=2);assert.ok(Math.abs(y-x*.1-.003)<1e-6);}
 assert.equal(new Set(mesh.bindings.flatMap(b=>b.ground.collision.triangles)).size,2);
});
test('all source grade breaks survive draping and unsupported rail area stays explicit',()=>{
 const f=tramFootprints([track(12,[[1,0,0],[2,10,0]])]),mesh=drapeTramFootprints(f,ground().slice(0,1),bounds);
 assert.ok(mesh.stats.missingArea>.1);assert.ok(mesh.stats.coveredArea<mesh.stats.expectedArea);
});
test('turnout/crossing overlaps and duplicate coplanar source ground are emitted once',()=>{
 const f=tramFootprints([track(12,[[1,0,0],[2,10,0]]),track(13,[[3,0,0],[4,10,0]])]),g=ground(),single=drapeTramFootprints(f,g,bounds),duplicates=drapeTramFootprints(f,[...g,...g.map(t=>({...t,id:t.id+'-duplicate'}))],bounds);
 assert.ok(Math.abs(single.stats.coveredArea-single.stats.expectedArea)<1e-8);assert.equal(duplicates.stats.triangles,single.stats.triangles);assert.deepEqual(duplicates.positions,single.positions);
});
test('the visible upper envelope splits crossing support planes instead of clipping through either floor',()=>{
 const f=tramFootprints([track(12,[[1,0,0],[2,10,0]])]),g=[...ground(x=>x*.1),...ground(x=>1-x*.1).map(t=>({...t,id:'other-'+t.id}))],mesh=drapeTramFootprints(f,g,bounds);
 assert.ok(mesh.stats.missingArea<1e-8);for(let i=0;i<mesh.positions.length;i+=3){const x=mesh.positions[i]!,y=mesh.positions[i+1]!;assert.ok(Math.abs(y-Math.max(x*.1,1-x*.1)-.003)<1e-6);}
});
test('coarse keeps the steel-head gauge without grooves, guards or extra height',()=>{
 const f=tramFootprints([track(12,[[1,0,0],[2,10,0]])]),detail=drapeTramFootprints(f,ground(),bounds),coarse=drapeTramFootprints(f,ground(),bounds,true);
 assert.ok(coarse.stats.expectedArea<detail.stats.expectedArea);assert.ok(Math.abs(coarse.stats.expectedArea-1.2)<1e-8);assert.ok(coarse.stats.missingArea<1e-8);
 assert.throws(()=>drapeTramFootprints(f,ground(),bounds,false,{...DEFAULT_TRAM_PROFILE,liftMetres:.006}),/at most3mm/);
});
test('single-ribbon UV maps the1m measuring faces to the exact original20/44head boundary',()=>{
 const f=tramFootprints([track(12,[[1,0,0],[2,10,0]])]),mesh=drapeTramFootprints(f,ground(()=>0),bounds);
 for(let i=0;i<mesh.positions.length/3;i++){const z=mesh.positions[i*3+2]!,u=mesh.uvs[i*2]!;assert.ok(Math.abs(u-(Math.abs(z)-.45)/.11)<1e-6);}
 assert.ok(Math.abs((.5-.45)/.11-20/44)<1e-15);
});
test('whole-fragment numerical coverage proof cannot qualify a real unsupported strip',()=>{
 const thin=qualifyTramCoverageFringes([[[[12,-1],[12.000001,-1],[12.000001,1],[12,1],[12,-1]]]],ground());assert.equal(thin[0]!.qualified,true);assert.ok(thin[0]!.maximumDistanceToGroundUpperBound<=thin[0]!.allowedDistance);
 const hole=qualifyTramCoverageFringes([[[[12,-1],[12.05,-1],[12.05,1],[12,1],[12,-1]]]],ground());assert.equal(hole[0]!.qualified,false);assert.ok(hole[0]!.maximumDistanceToGroundUpperBound>.01);
});
