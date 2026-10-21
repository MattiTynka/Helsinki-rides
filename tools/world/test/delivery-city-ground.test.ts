import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildGround} from '../lib/ground.ts';
import {bbox,type LocalPolygon,type Ring} from '../lib/geometry.ts';
const terrain={x0:-4,z0:-4,nx:9,nz:9,resolution:1,heights:new Float32Array(81)};
const rings:Ring[]=[[[-2,-2],[2,-2],[2,2],[-2,2]]],area={minX:-4,minZ:-4,maxX:4,maxZ:4};
const source=(id:string,main:string):LocalPolygon=>({id,rings,bbox:bbox(rings),properties:{paatyyppi:main,alatyyppi:'Ajorata (Silta)',materiaali:'Asfaltti'}});
test('new bridge exclusion retains a different municipal road beneath the exact same footprint',()=>{
  const bridge=source('upper','Silta'),underpass=source('lower','Ajorata');
  const ordinary=buildGround([bridge,underpass],terrain,[],area,.12,128);
  assert.deepEqual(ordinary,buildGround([bridge,underpass],terrain,[],area,.12,128,undefined,[],[]),'Absent/empty opt-in does not alter ordinary output');
  const excluded=buildGround([bridge,underpass],terrain,[],area,.12,128,undefined,[],[{id:'upper',rings}]);
  const road=excluded.pieces.filter(p=>p.tag==='road:asphalt');assert.ok(road.length,'Lower source road is retained');
  const areaOf=(pieces:typeof road)=>pieces.reduce((sum,p)=>sum+p.indices.reduce((n,_,i)=>{if(i%3)return n;const[a,b,c]=p.indices.slice(i,i+3).map(id=>[p.positions[id*3]!,p.positions[id*3+2]!]);return n+Math.abs((b![0]!-a![0]!)*(c![1]!-a![1]!)-(b![1]!-a![1]!)*(c![0]!-a![0]!))/2;},0),0);
  assert.equal(areaOf(road),16,'Exactly one lower source surface remains');
  assert.equal(areaOf(excluded.pieces.filter(p=>p.tag==='raised:yard')),48,'Fallback is removed only in the excluded footprint');
  assert.equal(areaOf(ordinary.pieces.filter(p=>p.tag==='raised:yard')),64,'Ordinary fallback contract remains unchanged');
});
