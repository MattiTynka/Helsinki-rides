import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KIRKKOKATU_EAST_QUAD, KIRKKOKATU_MASTER_SHA256, KIRKKOKATU_NORTH_AXES, KIRKKOKATU_NORTH_QUAD, kirkkokatuRestoration } from '../lib/kirkkokatu-facade-restoration.ts';

type Point = readonly [number, number];
const size = 1024;
function point(u: number, v: number, q = KIRKKOKATU_NORTH_QUAD): Point {
  // Bilinear fixture coordinates deliberately differ slightly from the production affine triangles;
  // test marks have finite interiors, so window classification cannot depend on sharing its inverse.
  return [q[0][0] * (1 - u) * (1 - v) + q[1][0] * u * (1 - v) + q[2][0] * u * v + q[3][0] * (1 - u) * v,
    q[0][1] * (1 - u) * (1 - v) + q[1][1] * u * (1 - v) + q[2][1] * u * v + q[3][1] * (1 - u) * v];
}
function inside(polygon: readonly Point[], x: number, y: number): boolean {
  let result = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!, b = polygon[j]!;
    if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) result = !result;
  }
  return result;
}
function paintPolygon(data: Uint8Array, polygon: readonly Point[], color: readonly number[]): void {
  for (let y = Math.max(0, Math.floor(Math.min(...polygon.map(p => p[1])) * size)); y <= Math.min(size - 1, Math.ceil(Math.max(...polygon.map(p => p[1])) * size)); y++) {
    for (let x = Math.max(0, Math.floor(Math.min(...polygon.map(p => p[0])) * size)); x <= Math.min(size - 1, Math.ceil(Math.max(...polygon.map(p => p[0])) * size)); x++) {
      if (inside(polygon, (x + 0.5) / size, (y + 0.5) / size)) for (let ch = 0; ch < 3; ch++) data[(y * size + x) * 4 + ch] = color[ch]!;
    }
  }
}
function paint(data: Uint8Array, bounds: readonly [number, number, number, number], color: readonly number[], quad = KIRKKOKATU_NORTH_QUAD): void {
  const [u0, v0, u1, v1] = bounds;
  paintPolygon(data, [point(u0, v0, quad), point(u1, v0, quad), point(u1, v1, quad), point(u0, v1, quad)], color);
}
function arch(data: Uint8Array, bottom: number, spring: number, axis = 0.510): void {
  const points: Point[] = [point(axis - 0.019, bottom, KIRKKOKATU_EAST_QUAD), point(axis + 0.019, bottom, KIRKKOKATU_EAST_QUAD)];
  for (let i = 0; i <= 24; i++) {
    const angle = i / 24 * Math.PI;
    points.push(point(axis + 0.019 * Math.cos(angle), spring + 0.036 * Math.sin(angle), KIRKKOKATU_EAST_QUAD));
  }
  paintPolygon(data, points, [20, 30, 40]);
}
function fixture() {
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < data.length; i += 4) data.set([70, 80, 90, 137], i);
  paint(data, [0, 0, 1, 0.94], [20, 120, 30]);
  paint(data, [0, 0.65, 1, 0.94], [80, 88, 96]);
  paint(data, [0, 0, 1, 1], [200, 180, 160], KIRKKOKATU_EAST_QUAD);
  arch(data, 0.12, 0.30);
  arch(data, 0.43, 0.60);
  for (const axis of [0.851, 0.911]) { arch(data, 0.12, 0.30, axis); arch(data, 0.43, 0.60, axis); }
  paint(data, [0.491, 0.72, 0.529, 0.88], [20, 30, 40], KIRKKOKATU_EAST_QUAD);
  paint(data, [0.940, 0, 1, 0.10], [240, 0, 180], KIRKKOKATU_EAST_QUAD);
  return { width: size, height: size, data, pngSha256: KIRKKOKATU_MASTER_SHA256 };
}
function read(data: Uint8Array, u: number, v: number): number[] {
  const uv = point(u, v), index = (Math.floor(uv[1] * size) * size + Math.floor(uv[0] * size)) * 4;
  return Array.from(data.subarray(index, index + 4));
}

test('north restoration keeps irregular source axis spacing and separates window detail from plaster', () => {
  const source = fixture(), before = source.data.slice(), output = before.slice();
  const evidence = kirkkokatuRestoration.apply(52, output, size, size, new Map([[52, source]]));
  for (const axis of KIRKKOKATU_NORTH_AXES.slice(0, 8)) {
    assert.ok(read(output, axis, 0.5)[0]! < 60, `middle window missing at ${axis}`);
    assert.ok(read(output, axis, 0.2)[0]! < 60, `ground window missing at ${axis}`);
  }
  assert.ok(read(output, 0.43, 0.5)[0]! > 60, 'blank space must remain plaster, without an extra window');
  for (const axis of [0.08, 0.297, 0.385, 0.473, 0.561, 0.649, 0.737, 0.866, 0.916]) {
    assert.deepEqual(read(output, axis, 0.80), read(before, axis, 0.80), 'clear upper windows stay original');
  }
  for (const u of [0.825, 0.866, 0.916, 0.975]) for (const v of [0.7, 0.96]) {
    assert.deepEqual(read(output, u, v), read(before, u, v), 'clear upper end group/cornice must stay original');
  }
  assert.deepEqual(source.data, before);
  assert.ok(evidence[0]!.changedTexels > 0);
});

test('the lower end pair is reconstructed as a pair rather than retaining photographed foliage', () => {
  const source = fixture(), output = source.data.slice();
  kirkkokatuRestoration.apply(52, output, size, size, new Map([[52, source]]));
  for (const axis of [0.866, 0.916]) for (const v of [0.2, 0.5, 0.328, 0.628]) {
    const rgba = read(output, axis, v);
    assert.ok(rgba[0]! < 40 && rgba[1]! < 40, `paired glass/arch missing at ${axis},${v}`);
  }
  assert.ok(read(output, 0.891, 0.5)[0]! > 60, 'the pair keeps its central plaster pier');
  assert.ok(read(output, 0.95, 0.5)[1]! < 100, 'foliage must not survive on the outer paired surround');
  const base = read(output, 0.99, 0.05);
  assert.ok(base[1]! > 50 && Math.abs(base[0]! - base[1]!) < 20, 'paired donor pedestrians must not be copied onto the plinth');
});

test('the two lower window ranks retain a curved glass apex instead of a flat cap or rectangular opening', () => {
  const source = fixture(), output = source.data.slice();
  kirkkokatuRestoration.apply(52, output, size, size, new Map([[52, source]]));
  for (const axis of KIRKKOKATU_NORTH_AXES.slice(0, 8)) for (const v of [0.328, 0.628]) {
    assert.ok(read(output, axis, v)[0]! < 40, `arch apex absent at ${axis},${v}`);
    assert.ok(read(output, axis + 0.017, v)[0]! > 60, `arch shoulder incorrectly filled as a rectangular cap at ${axis},${v}`);
  }
  // The obscured upper bay has a rectangular head, a different architectural class.
  assert.ok(read(output, 0.209, 0.86)[0]! < 40);
  assert.ok(read(output, 0.209 + 0.012, 0.86)[0]! < 40);
});

test('only the north wall RGB changes on the shared atlas; alpha and every unrelated chart stay exact', () => {
  const source = fixture(), output = source.data.slice(), before = output.slice();
  kirkkokatuRestoration.apply(52, output, size, size, new Map([[52, source]]));
  let outside = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4;
    assert.equal(output[i + 3], before[i + 3]);
    if (inside(KIRKKOKATU_NORTH_QUAD, (x + 0.5) / size, (y + 0.5) / size)) continue;
    for (let ch = 0; ch < 3; ch++) assert.equal(output[i + ch], before[i + ch], `outside north wall at ${x},${y}`);
    outside++;
  }
  assert.ok(outside > 800000);
});

test('unknown master and malformed dimensions fail before writing and unrelated pages are no-ops', () => {
  const source = fixture(), output = source.data.slice(), before = output.slice();
  assert.deepEqual(kirkkokatuRestoration.apply(51, output, size, size, new Map()), []);
  assert.throws(() => kirkkokatuRestoration.apply(52, output, size, size, new Map([[52, { ...source, pngSha256: 'changed' }]])), /master changed/);
  assert.throws(() => kirkkokatuRestoration.apply(52, output, size, size, new Map([[52, { ...source, height: 512 }]])), /dimensions invalid/);
  const noAnchors = { ...source, data: source.data.slice() };
  paint(noAnchors.data, [0, 0, 1, 1], [0, 0, 0], KIRKKOKATU_EAST_QUAD);
  assert.throws(() => kirkkokatuRestoration.apply(52, output, size, size, new Map([[52, noAnchors]])), /clean plaster anchors/);
  assert.deepEqual(output, before);
});
