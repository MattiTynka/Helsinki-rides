import assert from 'node:assert/strict';
import { test } from 'node:test';
import { containsSupportedArea, supportedMotionFraction, supportsSegment, supportsConvexFootprint, validateSupportedArea, type SupportedArea, type Vec2 } from '../src/index.ts';

const rectangle = (x0: number, z0: number, x1: number, z1: number): Vec2[] => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
const playArea = { minX: -100, maxX: 100, minZ: -100, maxZ: 100 };
const mask: SupportedArea = { schemaVersion: 1, regions: [{ id: 'city', outer: rectangle(-90, -90, 90, 90), holes: [rectangle(10, -50, 11, 50)] }] };
const coverage = { playArea, supportedArea: mask };

test('qualified coverage excludes a canal and the unbuilt envelope without changing legacy worlds', () => {
  assert.deepEqual(validateSupportedArea(mask, playArea), []);
  assert.equal(containsSupportedArea(coverage, 0, 0), true);
  assert.equal(containsSupportedArea(coverage, 10.5, 0), false);
  assert.equal(containsSupportedArea(coverage, 10, 0), false, 'hole boundary remains excluded');
  assert.equal(containsSupportedArea(coverage, 95, 0), false);
  assert.equal(containsSupportedArea({ playArea }, 10.5, 0), true);
  assert.equal(containsSupportedArea({ playArea }, 95, 0), true);
  assert.equal(containsSupportedArea(coverage, 9.8, 0, 0.4), false, 'full radius matters');
});

test('convex footprints retain enclosed exclusions, swept canals, clearance and ordered topology', () => {
  const content = { playArea: { minX: -20, minZ: -20, maxX: 20, maxZ: 20 }, supportedArea: { schemaVersion: 1 as const,
    regions: [{ id: 'land', outer: [[-20,-20],[20,-20],[20,20],[-20,20]] as Vec2[], holes: [[[0,0],[.001,0],[.001,.001],[0,.001]] as Vec2[]] }] } };
  assert.equal(supportsConvexFootprint(content,[[-2,-2],[2,-2],[2,2],[-2,2]],.1),false,'a whole tiny hole enclosed by the footprint is excluded');
  assert.equal(supportsConvexFootprint(content,[[-2,1],[2,1],[2,5],[-2,5]],.1),true);
  assert.equal(supportsConvexFootprint(content,[[-2,.05],[2,.05],[2,5],[-2,5]],.1),false,'interior boundary clearance matters');
  assert.equal(supportsConvexFootprint(content,[[-2,1],[2,5],[2,1],[-2,5]],0),false,'bow-tie input rejects');
  assert.equal(supportsConvexFootprint(content,[[-2,-1],[-1,-1],[2,1],[1,1]],0),false,'swept interior crosses hole');
  assert.equal(supportsConvexFootprint({playArea:content.playArea},[[-2,-2],[2,-2],[2,2],[-2,2]],.1),true);
});

test('safe endpoints cannot cross a narrow canal or hop between separate components', () => {
  assert.equal(supportsSegment(coverage, [0, 0], [20, 0], 0.4), false);
  assert.equal(supportsSegment(coverage, [0, 60], [20, 60], 0.4), true, 'qualified land around the canal remains connected');
  assert.equal(supportsSegment(coverage, [0, 50.2], [20, 50.2], 0.4), false, 'grazing the hole fails footprint clearance');
  const separate = { playArea, supportedArea: { schemaVersion: 1 as const, regions: [
    { id: 'west', outer: rectangle(-90, -30, -5, 30) }, { id: 'east', outer: rectangle(5, -30, 90, 30) },
  ] } };
  assert.equal(supportsSegment(separate, [-10, 0], [10, 0], 0.4), false);
  const fraction = supportedMotionFraction(coverage, [0, 0], [20, 0], 0.4);
  assert.ok(fraction > 0.47999 && fraction < 0.480001);
  assert.equal(supportsSegment(coverage, [0, 0], [20 * fraction, 0], 0.4), true);
  assert.equal(supportedMotionFraction({ playArea }, [0, 0], [20, 0], 0.4), 1);
});

test('normalization rejects malformed, overlapping, self-crossing and excessive rings', () => {
  for (const bad of [
    { schemaVersion: 1, regions: [] },
    { ...mask, extra: true },
    { schemaVersion: 1, regions: [{ id: 'invalid', outer: rectangle(-200, -1, 1, 1) }] },
    { schemaVersion: 1, regions: [{ id: 'invalid', outer: [[0, 0], [2, 2], [0, 2], [2, 0]] }] },
    { schemaVersion: 1, regions: [{ id: 'invalid', outer: [[0, 0], [1, 0], [0, Infinity]] }] },
    { schemaVersion: 1, regions: [{ id: 'invalid', outer: rectangle(0, 0, 10, 10), holes: [rectangle(0, 1, 2, 2)] }] },
    { schemaVersion: 1, regions: [{ id: 'invalid', outer: rectangle(0, 0, 10, 10), holes: [rectangle(1, 1, 5, 5), rectangle(4, 4, 8, 8)] }] },
    { schemaVersion: 1, regions: [{ id: 'a', outer: rectangle(0, 0, 10, 10) }, { id: 'b', outer: rectangle(10, 0, 20, 10) }] },
    { schemaVersion: 1, regions: Array.from({ length: 129 }, (_, i) => ({ id: `r${i}`, outer: rectangle(0, 0, 1, 1) })) },
    { schemaVersion: 1, regions: [{ id: 'large', outer: Array.from({ length: 4097 }, (_, i) => [Math.cos(i), Math.sin(i)]) }] },
  ]) assert.ok(validateSupportedArea(bad, playArea).length > 0);
});


test('source topology retains true tiny holes and nearly collinear positive area without changing clearance', () => {
  const area = { minX: -2000, minZ: -2000, maxX: 2000, maxZ: 2000 };
  const hole: Vec2[] = [[-1390.8315884463755,890.0218386138237],[-1390.8313242397091,890.0230204413725],[-1390.8315000012517,890.0221998402849]];
  const supportedArea: SupportedArea = { schemaVersion: 1, regions: [{ id: 'tiny-source-hole', outer: rectangle(-1500,-1500,1500,1500), holes: [hole] }] };
  assert.deepEqual(validateSupportedArea(supportedArea, area), []);
  for (const p of hole) assert.equal(containsSupportedArea({ playArea: area, supportedArea }, ...p), false);
  assert.equal(containsSupportedArea({ playArea: area, supportedArea }, -1390.83147, 890.0223, .4), false);
  assert.deepEqual(validateSupportedArea({ schemaVersion: 1, regions: [{ id: 'thin', outer: [[0,0],[1,1e-16],[2,0],[1,-1e-16]] }] }, area), []);
  assert.ok(validateSupportedArea({ schemaVersion: 1, regions: [{ id: 'zero', outer: [[0,0],[1,1],[2,2]] }] }, area).length);
});

test('bounded source masks permit8192 holes and65536 total vertices without removing exclusions', () => {
  const area = { minX: 0, minZ: 0, maxX: 700, maxZ: 700 };
  const build = (count: number): SupportedArea => ({ schemaVersion: 1, regions: [{ id: 'many', outer: rectangle(0,0,700,700),
    holes: Array.from({ length: count }, (_, i) => rectangle(1+(i%128)*5,1+Math.floor(i/128)*5,2+(i%128)*5,2+Math.floor(i/128)*5)) }] });
  assert.deepEqual(validateSupportedArea(build(8192), area), []);
  assert.ok(validateSupportedArea(build(8193), area).length);
  const circle = (count: number): SupportedArea => ({schemaVersion: 1, regions: [{id: 'maximum', outer: Array.from({length: count}, (_, i) => [350+349*Math.cos(i*2*Math.PI/count),350+349*Math.sin(i*2*Math.PI/count)])}]});
  assert.deepEqual(validateSupportedArea(circle(65536), area), []);
  assert.ok(validateSupportedArea(circle(65537), area).length);
  const sharedCap: SupportedArea = {schemaVersion: 1, regions: [{...circle(65536).regions[0]!, holes: [rectangle(300,300,301,301)]}]};
  assert.ok(validateSupportedArea(sharedCap, area).length, 'outer and hole vertices share the global cap');
});

test('point contacts preserve excluded topology while shared edges, nesting and overlapping wedges reject', () => {
  const area = { minX: -20, minZ: -20, maxX: 20, maxZ: 20 }, outer = rectangle(-20,-20,20,20);
  const validate = (holes: Vec2[][]) => validateSupportedArea({ schemaVersion: 1, regions: [{ id: 'topology', outer, holes }] }, area);
  assert.deepEqual(validate([rectangle(0,0,2,2),rectangle(2,2,4,4)]), []);
  const invalid: Vec2[][][] = [
    [rectangle(0,0,3,3),rectangle(2,2,4,4)],
    [rectangle(0,0,2,2),rectangle(2,0,4,2)],
    [rectangle(-5,-5,5,5),rectangle(-1,-1,1,1)],
    [rectangle(-5,-5,5,5),[[0,-5],[5,0],[0,5],[-5,0]]],
    [[[0,0],[6,0],[6,6],[4,6],[4,2],[2,2],[2,6],[0,6]],[[2,2],[4,6],[6,0]]],
  ];
  for (const holes of invalid) assert.ok(validate(holes).length, 'positive overlap must fail even if all contacts are at vertices');
  const supportedArea: SupportedArea = { schemaVersion: 1, regions: [{ id: 'outer-touch', outer: rectangle(0,0,10,10), holes: [[[0,5],[2,4],[2,6]]] }] };
  assert.deepEqual(validateSupportedArea(supportedArea, area), []);
  assert.equal(containsSupportedArea({ playArea: area, supportedArea }, 0, 5), false, 'hole exclusion wins at the outer contact');
  assert.ok(validateSupportedArea({ schemaVersion: 1, regions: [{ id: 'escape', outer: [[0,0],[6,0],[6,6],[4,6],[4,2],[2,2],[2,6],[0,6]], holes: [[[2,2],[4,6],[2,6]]] }] }, area).length);
});

test('indexed queries preserve ray endpoints, radius tangencies, interior cache and concave segment exclusion', () => {
  for (const margin of [0,.4,3]) {
    assert.equal(containsSupportedArea(coverage,10,0,margin), false);
    assert.equal(containsSupportedArea(coverage,0,60,margin), true);
  }
  assert.equal(containsSupportedArea(coverage,9.6,0,.4), true);
  assert.equal(containsSupportedArea(coverage,9.60000002,0,.4), false);
  const area = { minX: -3000, minZ: -3000, maxX: 3000, maxZ: 3000 };
  const detailed: SupportedArea = { schemaVersion: 1, regions: [{ id: 'maximum', outer: Array.from({ length:4096 }, (_, i) => [64+2200*Math.cos(i*2*Math.PI/4096),64+2200*Math.sin(i*2*Math.PI/4096)]) }] };
  const full = { playArea: area, supportedArea: detailed };
  const fraction = supportedMotionFraction(full,[2263.5,64],[2263.7,64],.4);
  assert.ok(fraction>0.49999 && fraction<0.50001);
  assert.equal(supportsSegment(full,[2263.5,64],[2263.5+.2*fraction,64],.4), true);
  const concave: SupportedArea = { schemaVersion: 1, regions: [{ id: 'elbow', outer: [[-100,-100],[500,-100],[500,100],[100,100],[100,500],[-100,500]] }] };
  assert.equal(supportsSegment({ playArea: area, supportedArea: concave },[50,300],[300,50],.4), false);
});
