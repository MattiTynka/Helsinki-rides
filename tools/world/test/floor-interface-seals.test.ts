import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findFloorInterfaceSeals, meshFloorInterfaceSeals, type FloorPoint, type FloorSource } from '../lib/floor-interface-seals.ts';
import type { LocalPolygon } from '../lib/geometry.ts';
import { meshVerticalSeals } from '../lib/vertical-seal-mesh.ts';
const options = { protectedArea: { minX: 100, maxX: 101, minZ: 100, maxZ: 101 }, protectedMarginMetres: 8 };
function floor(a: FloorPoint, b: FloorPoint, side: number, id = 'floor'): FloorSource {
  return { id, cell: 'test', positions: Float32Array.from([...a, ...b, a[0], a[1], side]), indices: Uint32Array.from(side > 0 ? [0, 2, 1] : [0, 1, 2]), triangleTags: ['raised:yard'] };
}
const pair = () => [floor([0, 1, 0], [4, 1, 0], 4, 'upper'), floor([0, .99, 0], [4, .99, 0], -4, 'lower')];
const mask = (id: string, min: number, max: number): LocalPolygon => ({ id, bbox: [min, -1, max, 1], properties: {}, rings: [[[min, -1], [max, -1], [max, 1], [min, 1]]] });
test('opposed existing floor profiles get a vertical join with no source mutation', () => {
  const sources = pair(), before = sources.map(s => Array.from(s.positions)), result = findFloorInterfaceSeals(sources, options);
  assert.equal(result.seals.length, 1); assert.equal(result.seals[0]!.sideTag, 'wall');
  assert.ok(result.seals[0]!.top.every((p, i) => p[0] === result.seals[0]!.bottom[i]![0] && p[2] === result.seals[0]!.bottom[i]![2]));
  assert.deepEqual(sources.map(s => Array.from(s.positions)), before);
});
test('one long boundary matches independently tessellated shorter floor intervals', () => {
  const sources = [floor([0, 1, 0], [4, 1.04, 0], 4, 'upper'), floor([0, .99, 0], [2, 1.01, 0], -4, 'lower-a'), floor([2, 1.01, 0], [4, 1.02, 0], -4, 'lower-b')];
  const result = findFloorInterfaceSeals(sources, options); assert.equal(result.seals.length, 2);
  assert.ok(Math.abs(result.seals.reduce((n, s) => n + s.length, 0) - 4) < 1e-8);
});
test('same-side stacked boundaries cannot invent an exterior interface', () => {
  assert.equal(findFloorInterfaceSeals([floor([0, 1, 0], [4, 1, 0], 4), floor([0, .99, 0], [4, .99, 0], 4)], options).seals.length, 0);
});
test('existing actual vertical coverage is subtracted', () => {
  const wall: FloorSource = { id: 'wall', cell: 'test', positions: Float32Array.from([0, 1, 0, 4, 1, 0, 0, .99, 0, 4, .99, 0]), indices: Uint32Array.from([0, 1, 2, 1, 3, 2]), triangleTags: ['wall', 'wall'] };
  assert.equal(findFloorInterfaceSeals([...pair(), wall], options).seals.length, 0);
  const partial = { ...wall, positions: Float32Array.from([0, 1, 0, 4, 1, 0, 0, .995, 0, 4, .995, 0]) };
  const result = findFloorInterfaceSeals([...pair(), partial], options); assert.ok(result.seals.length);
  assert.ok(result.seals.every(s => s.top.every(p => Math.abs(p[1] - .995) < 1e-6)));
});
test('protected area and exact real-wall footprint split rather than hide the whole join', () => {
  const result = findFloorInterfaceSeals(pair(), { ...options, protectedArea: { minX: 0, maxX: 1, minZ: -1, maxZ: 1 }, protectedMarginMetres: 0, wallMasks: [mask('survey-wall', 2, 3)] });
  assert.equal(result.seals.length, 2); assert.ok(result.seals.every(s => s.top.every(p => p[0] >= 1 && (p[0] <= 2 || p[0] >= 3))));
});
test('source water requires an actual registered supporting deck', () => {
  const water = mask('water', -1, 5); assert.equal(findFloorInterfaceSeals(pair(), { ...options, waterMasks: [water] }).seals.length, 0);
  assert.equal(findFloorInterfaceSeals(pair(), { ...options, waterMasks: [water], registeredDecks: [water] }).seals.length, 1);
});
test('large real level differences and horizontal holes remain explicit rejections', () => {
  const result = findFloorInterfaceSeals([floor([0, 1, 0], [4, 1, 0], 4), floor([0, .5, 0], [4, .5, 0], -4)], options);
  assert.equal(result.seals.length, 0); assert.ok(result.counts['above-offset-bound']);
  const offset = floor([0, .99, .002], [4, .99, .002], -4); assert.equal(findFloorInterfaceSeals([pair()[0]!, offset], options).seals.length, 0);
});
test('crossing actual floor profiles split at their intersection', () => {
  const result = findFloorInterfaceSeals([floor([0, 1, 0], [4, 1, 0], 4), floor([0, .995, 0], [4, 1.005, 0], -4)], options);
  assert.equal(result.seals.length, 2); assert.ok(result.seals.some(s => s.upperSourceId === 'floor'));
  const mesh = meshFloorInterfaceSeals(result.seals); assert.ok(mesh.indices.length);
  for (let i = 0; i < mesh.indices.length; i += 3) { const p = mesh.indices.slice(i, i + 3).map(id => mesh.positions.slice(id * 3, id * 3 + 3)), a = p[0]!, b = p[1]!, c = p[2]!; assert.ok((b[2]! - a[2]!) * (c[0]! - a[0]!) - (b[0]! - a[0]!) * (c[2]! - a[2]!) === 0); }
});
test('actual Music Centre partial edge creates the measured millimetre join', () => {
  const upper: FloorSource = { id: 'g:test', cell: 'test', positions: Float32Array.from([-987.357421875, 1.271650791168213, -400, -984, 1.1124804019927979, -400, -987.3845825195312, 1.4506183862686157, -400.05621337890625]), indices: Uint32Array.from([0, 1, 2]), triangleTags: ['raised:yard'] };
  const lower: FloorSource = { id: 'g:test', cell: 'test', positions: Float32Array.from([-984, .9690479040145874, -396, -984, 1.1124804019927979, -400, -987.4503173828125, 1.268600344657898, -400]), indices: Uint32Array.from([0, 1, 2]), triangleTags: ['raised:yard'] };
  const result = findFloorInterfaceSeals([upper, lower], options); assert.equal(result.seals.length, 1);
  assert.ok(Math.abs(result.seals[0]!.length - 3.357421875) < 1e-9); assert.ok(Math.abs(Math.max(...result.seals[0]!.gap) - .007253781955853356) < 1e-10);
  assert.ok(meshFloorInterfaceSeals(result.seals).indices.length > 0);
});
test('micron-offset source boundaries cannot manufacture a shared profile or bow-tie tip', () => {
  const result = findFloorInterfaceSeals([floor([0, 1, 0], [4, 1, 0], 4, 'upper'), floor([0, 1.000001, .000002], [4, .999, 0], -4, 'lower')], options);
  assert.equal(result.seals.length, 0);
});
test('both boundaries of an ambiguous Float32 soil sliver are withheld', () => {
  const result = findFloorInterfaceSeals([floor([0, 1, 0], [4, 1, 0], .00005, 'sliver'), floor([0, .99, 0], [4, .99, 0], -4, 'lower')], options);
  assert.equal(result.seals.length, 0); assert.ok(result.counts['ambiguous-thin-floor']);
});
test('existing partial curb coverage uses the actual selected source line', () => {
  const points: FloorPoint[][] = [
    [[-1168.0587158203125, 7.266398906707764, -12], [-1170.793701171875, 7.254177570343018, -16], [-1171.5206298828125, 7.163891792297363, -16]],
    [[-1168, 7.152810096740723, -12.445566177368164], [-1170.793701171875, 7.1341776847839355, -16], [-1168.0587158203125, 7.146399021148682, -12]],
    [[-1168.1856689453125, 7.265831470489502, -12.185696601867676], [-1170.793701171875, 7.254177570343018, -16], [-1170.793701171875, 7.1341776847839355, -16]],
    [[-1168.1856689453125, 7.265831470489502, -12.185696601867676], [-1170.793701171875, 7.1341776847839355, -16], [-1168.1856689453125, 7.14583158493042, -12.185696601867676]],
  ];
  const sources: FloorSource[] = points.map((p, i) => ({ id: `actual-${i}`, cell: 'test', positions: Float32Array.from(p.flat()), indices: Uint32Array.from([0, 1, 2]), triangleTags: [i === 0 ? 'raised:slabs' : i === 1 ? 'road:slabs' : 'curb'] }));
  const result = findFloorInterfaceSeals(sources, options);
  assert.ok(result.seals.length); assert.ok(result.seals.reduce((n, s) => n + s.length, 0) < .226);
  assert.deepEqual(meshFloorInterfaceSeals(result.seals), meshVerticalSeals(result.seals));
});
test('a fully covered tall existing interface is not a new above-bound defect', () => {
  const wall: FloorSource = { id: 'wall', cell: 'test', positions: Float32Array.from([0, 1, 0, 4, 1, 0, 0, .5, 0, 4, .5, 0]), indices: Uint32Array.from([0, 1, 2, 1, 3, 2]), triangleTags: ['wall', 'wall'] };
  const result = findFloorInterfaceSeals([floor([0, 1, 0], [4, 1, 0], 4), floor([0, .5, 0], [4, .5, 0], -4), wall], options);
  assert.equal(result.seals.length, 0); assert.equal(result.counts['above-offset-bound'] ?? 0, 0);
});
test('competing near-plane additions are withheld on both source lines', () => {
  const result = findFloorInterfaceSeals([
    floor([0, 1, 0], [4, 1, 0], 4, 'upper-a'), floor([0, .99, 0], [4, .99, 0], -4, 'lower-a'),
    floor([1, 1, .00005], [3, 1, .00005], 4, 'upper-b'), floor([1, .99, .00005], [3, .99, .00005], -4, 'lower-b'),
  ], options);
  assert.equal(result.seals.length, 0); assert.equal(result.counts['ambiguous-near-plane-addition'], 2);
});
