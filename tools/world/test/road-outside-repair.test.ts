import assert from 'node:assert/strict';
import {test} from 'node:test';
import {assertOutsideOnlyPolylineRepair, repairOutsidePolyline} from '../lib/road-outside-repair.ts';
import {pointAlong, type Vec3} from '../../../packages/world-schema/src/index.ts';
import {RoadCollisionSupport} from '../lib/expansion-road-merge.ts';
const accepted = {playArea: {minX: -10, maxX: 0, minZ: -10, maxZ: 10}}, expanded = {playArea: {...accepted.playArea, maxX: 10}};
test('current-area projection also retains the original accounting boundary knot',()=>{
 const original={playArea:{minX:0,maxX:10,minZ:-5,maxZ:5}},current={playArea:{...original.playArea,maxX:30}},future={playArea:{...original.playArea,maxX:50}},before:Vec3[]=[[0,0,0],[40,4,0]],project=(x:number)=>({height:x/10,triangles:['literal-source']});
 const implicit=repairOutsidePolyline(before,current,future,project);assert.throws(()=>assertOutsideOnlyPolylineRepair(before,implicit.points,original),/boundary/);
 const explicit=repairOutsidePolyline(before,current,future,project,.25,original);assert.deepEqual(explicit.points.find(p=>p[0]===10),[10,1,0]);assertOutsideOnlyPolylineRepair(before,explicit.points,original);assertOutsideOnlyPolylineRepair(before,explicit.points,current);
});
test('outside repair preserves inside interpolation and inserts an exact old boundary point', () => {
  const before: Vec3[] = [[-2, 0, 0], [2, 0, 0]], result = repairOutsidePolyline(before, accepted, expanded, x => ({height: Math.max(0, x), triangles: ['source-face']}));
  assert.deepEqual(result.points.find(p => p[0] === 0), [0, 0, 0]); assert.deepEqual(result.points.at(-1), [2, 2, 0]);
  for (const s of [.1, .5, 1, 1.75, 2]) assert.deepEqual(pointAlong(result.points, s).point, pointAlong(before, s).point);
  assert.equal(result.proof.acceptedPiecewiseGeometryPreserved, true); assert.ok(result.proof.projectedPoints > 1);
});
test('keeping old inside vertices alone does not preserve a crossing segment', () => {
  assert.throws(() => assertOutsideOnlyPolylineRepair([[-2, 0, 0], [2, 0, 0]], [[-2, 0, 0], [2, 4, 0]], accepted), /protected boundary interpolation/);
});
test('unsupported protected boundary, holes, and moved source paths fail closed', () => {
  assert.throws(() => repairOutsidePolyline([[-2, 0, 0], [2, 0, 0]], accepted, expanded, () => ({height: 1, triangles: ['face']})), /Protected old boundary/);
  assert.throws(() => repairOutsidePolyline([[-2, 0, 0], [2, 0, 0]], accepted, expanded, x => x > 1 ? null : {height: 0, triangles: ['face']}), /No unique native/);
  assert.throws(() => assertOutsideOnlyPolylineRepair([[-2, 0, 0], [2, 0, 0]], [[-2, 0, 0], [0, 0, 1], [2, 0, 0]], accepted), /source XZ polyline/);
});
test('native reprojection rejects vertically stacked road levels', () => {
  const points: [Vec3, Vec3, Vec3] = [[-2, 0, -2], [-2, 0, 2], [2, 0, 2]];
  const support = new RoadCollisionSupport([{id: 'ground', points, tag: 'road:asphalt'}, {id: 'deck', points: points.map(p => [p[0], p[1] + 4, p[2]]) as [Vec3, Vec3, Vec3], tag: 'road:asphalt'}]);
  assert.throws(() => support.project(-1, 0), /Ambiguous native road levels/); assert.equal(support.at(-1, 0, 0)?.height, 0);
});

test('a supported island repairs only outside geometry while keeping shared island endpoints continuous', () => {
  const island = {playArea: expanded.playArea, supportedArea: {schemaVersion: 1 as const, regions: [{id: 'accepted', outer: [[-10, -10], [0, -10], [0, 10], [-10, 10]] as [number, number][]}, {id: 'island', outer: [[1, -2], [3, -2], [3, 2], [1, 2]] as [number, number][]}]}};
  const result = repairOutsidePolyline([[-2, 0, 0], [4, 0, 0]], accepted, island, () => ({height: 1, triangles: ['island']}));
  assert.deepEqual(result.points.find(p => p[0] === 1), [1, 1, 0]); assert.deepEqual(result.points.find(p => p[0] === 3), [3, 1, 0]);
  assert.deepEqual(pointAlong(result.points, 1).point, [-1, 0, 0]);
});
