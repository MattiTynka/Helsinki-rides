import assert from 'node:assert/strict';
import {test} from 'node:test';
import {AcceptedGroundCoverage,clipGroundToRectangle} from '../lib/append-city-cells.ts';
import type {GroundPiece} from '../lib/ground.ts';

type Point=[number,number,number];
const region=[-1800,-1000,900,500] as const;
function piece(points:Point[],indices=[0,1,2,0,2,3]):GroundPiece{return{cell:'test',finish:'slabs',level:'raised',tag:'wall',use:'collision',positions:points.flat(),uvs:points.flatMap(([x,y,z])=>[2*x+3*y+z,x-y+4*z]),indices};}
function triangles(pieces:readonly GroundPiece[]):Point[][]{return pieces.flatMap(p=>Array.from({length:p.indices.length/3},(_,i)=>[0,1,2].map(k=>p.positions.slice(p.indices[i*3+k]!*3,p.indices[i*3+k]!*3+3) as Point)));}
function area(points:Point[][]){return points.reduce((sum,[a,b,c])=>{const u=b!.map((v,k)=>v-a![k]!),v=c!.map((n,k)=>n-a![k]!);return sum+Math.hypot(u[1]!*v[2]!-u[2]!*v[1]!,u[2]!*v[0]!-u[0]!*v[2]!,u[0]!*v[1]!-u[1]!*v[0]!)/2;},0);}
function assertAttributes(pieces:readonly GroundPiece[]){for(const p of pieces){assert.equal(p.tag,'wall');assert.equal(p.use,'collision');for(let i=0;i<p.positions.length/3;i++){const[x,y,z]=p.positions.slice(i*3,i*3+3);assert.ok(Math.abs(p.uvs[i*2]!-(2*x!+3*y!+z!))<1e-9);assert.ok(Math.abs(p.uvs[i*2+1]!-(x!-y!+4*z!))<1e-9);}}}

test('coplanar walls subtract only the 10 square metre overlap and preserve uncovered heights, UVs and winding',()=>{
 const old=piece([[1,0,0],[3,0,0],[3,5,0],[1,5,0]]),source=piece([[0,-2,0],[4,-2,0],[4,7,0],[0,7,0]]),before=structuredClone(source),masks=triangles([old]);
 const coverage=new AcceptedGroundCoverage([...masks,...masks.map(t=>[...t].reverse())]),out=clipGroundToRectangle([source],region,coverage),result=triangles(out);
 assert.equal(coverage.triangles.length,0);assert.equal(coverage.verticalTriangles.length,4);assert.ok(Math.abs(area(result)-26)<1e-9);assert.deepEqual(source,before);assertAttributes(out);
 for(const [a,b,c]of result){const x=(a![0]+b![0]+c![0])/3,y=(a![1]+b![1]+c![1])/3;assert.ok(!(x>1&&x<3&&y>0&&y<5));assert.ok((b![0]-a![0])*(c![1]-a![1])-(b![1]-a![1])*(c![0]-a![0])>0,'source winding preserved');}
 const ys=result.flat().map(p=>p[1]);assert.equal(Math.min(...ys),-2);assert.equal(Math.max(...ys),7);
});

test('vertical subtraction retains perpendicular, separated, touching and nonvertical faces',()=>{
 const old=piece([[-1372,0,-20],[-1368,0,-20],[-1368,5,-20],[-1372,5,-20]]),coverage=new AcceptedGroundCoverage(triangles([old]));
 const cases=[
  piece([[-1370,0,-22],[-1370,0,-18],[-1370,5,-18],[-1370,5,-22]]),
  piece([[-1372,0,-19.999],[-1368,0,-19.999],[-1368,5,-19.999],[-1372,5,-19.999]]),
  piece([[-1368,0,-20],[-1366,0,-20],[-1366,5,-20],[-1368,5,-20]]),
  piece([[-1372,6,-20],[-1368,6,-20],[-1368,8,-20],[-1372,8,-20]]),
  piece([[-1372,0,-22],[-1368,0,-22],[-1368,0,-18],[-1372,0,-18]])
 ];
 for(const source of cases){const out=clipGroundToRectangle([source],region,coverage);assert.ok(Math.abs(area(triangles(out))-area(triangles([source])))<1e-9);assertAttributes(out);}
});

test('wall matching tolerates Float32 source rounding while new XYZ remains on its original plane',()=>{
 const point=(u:number,y:number):Point=>[-1371.77907+u*3.24313,y,-21.452507-u*2.011489],old=piece([point(0,0),point(1,0),point(1,5),point(0,5)]),source=piece([point(-.1,-2),point(1.1,-2),point(1.1,7),point(-.1,7)]);
 const masks=triangles([old]).map(t=>t.map(p=>p.map(Math.fround) as Point)),coverage=new AcceptedGroundCoverage(masks),out=clipGroundToRectangle([source],region,coverage),expected=area(triangles([source]))-area(masks);
 assert.ok(Math.abs(area(triangles(out))-expected)<.001);assertAttributes(out);
 for(const p of triangles(out).flat()){const u=(p[0]+1371.77907)/3.24313;assert.ok(Math.abs(p[2]-(-21.452507-u*2.011489))<1e-10);}
});

test('near-vertical accepted walls do not erase uncovered heights through a thin XZ mask',()=>{
 const point=(x:number,y:number):Point=>[x,y,y*.00002],old=piece([point(1,0),point(3,0),point(3,5),point(1,5)]),source=piece([point(0,-2),point(4,-2),point(4,7),point(0,7)]),coverage=new AcceptedGroundCoverage(triangles([old]));
 const out=clipGroundToRectangle([source],region,coverage);assert.equal(coverage.triangles.length,0);assert.ok(Math.abs(area(triangles(out))-26*Math.sqrt(1+.00002**2))<1e-9);assertAttributes(out);
});

test('actual c_m11_m01 old 6413 / new 5080 retains only the non-overlapping wall area',()=>{
 const accepted:Point[]=[[-1371.779052734375,7.067178726196289,-21.452505111694336],[-1371.779052734375,.9233237504959106,-21.452505111694336],[-1368.535888671875,.9032577276229858,-23.4639949798584]],
 added:Point[]=[[-1371.779052734375,7.151217460632324,-21.452505111694336],[-1371.779052734375,1.4558671712875366,-21.452505111694336],[-1368.535888671875,1.0093388557434082,-23.4639949798584]],
 source=piece(added,[0,1,2]),out=clipGroundToRectangle([source],region,new AcceptedGroundCoverage([accepted]));
 assert.ok(Math.abs(area([added])-area(triangles(out))-10.50858240247861)<1e-6);assert.ok(area(triangles(out))>.35);assert.ok(area(triangles(out))<.37);assertAttributes(out);
 // The original accepted triangle must remove no further positive area from the remaining fragments.
 const secondPass=clipGroundToRectangle(out,region,new AcceptedGroundCoverage([accepted]));assert.ok(Math.abs(area(triangles(secondPass))-area(triangles(out)))<1e-8);
});
