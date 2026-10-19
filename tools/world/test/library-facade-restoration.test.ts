import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LIBRARY_MASTER_SHA256, LIBRARY_NORTH_QUAD, LIBRARY_SOUTH_QUAD, libraryRestoration } from '../lib/library-facade-restoration.ts';

type Point = readonly [number, number];
type Quad = readonly [Point, Point, Point, Point];
const size = 1024;
function point(quad: Quad, u: number, v: number): Point {
  return [quad[0][0] * (1 - u) * (1 - v) + quad[1][0] * u * (1 - v) + quad[2][0] * u * v + quad[3][0] * (1 - u) * v,
    quad[0][1] * (1 - u) * (1 - v) + quad[1][1] * u * (1 - v) + quad[2][1] * u * v + quad[3][1] * (1 - u) * v];
}
// Independent polygon membership: does not use the implementation's bilinear inverse/rasterizer.
function inside(polygon: readonly Point[], x: number, y: number): boolean {
  let result = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!, b = polygon[j]!;
    if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) result = !result;
  }
  return result;
}
function paint(data: Uint8Array, quad: Quad, bounds: readonly [number, number, number, number], color: readonly number[]): void {
  const [u0, v0, u1, v1] = bounds, polygon = [point(quad, u0, v0), point(quad, u1, v0), point(quad, u1, v1), point(quad, u0, v1)];
  const x0 = Math.max(0, Math.floor(Math.min(...polygon.map(p => p[0])) * size)), x1 = Math.min(size - 1, Math.ceil(Math.max(...polygon.map(p => p[0])) * size));
  const y0 = Math.max(0, Math.floor(Math.min(...polygon.map(p => p[1])) * size)), y1 = Math.min(size - 1, Math.ceil(Math.max(...polygon.map(p => p[1])) * size));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (inside(polygon, (x + 0.5) / size, (y + 0.5) / size)) {
    for (let ch = 0; ch < 3; ch++) data[(y * size + x) * 4 + ch] = color[ch]!;
  }
}
function fixture() {
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < data.length; i += 4) data.set([220, 220, 220, 173], i);
  const first = 0.0215, panel = 0.96 / 11;
  // One verified clear window bay, plus a unique clean granite donor; all occluded bays/base are green.
  paint(data, LIBRARY_SOUTH_QUAD, [first + 4 * panel, 0.155, 1, 0.73], [20, 90, 30]);
  paint(data, LIBRARY_SOUTH_QUAD, [first + 3.25 * panel, 0.25, first + 3.75 * panel, 0.69], [25, 30, 35]);
  paint(data, LIBRARY_SOUTH_QUAD, [0, 0, 1, 0.155], [20, 90, 30]);
  paint(data, LIBRARY_SOUTH_QUAD, [first + 2.02 * panel, 0, first + 2.98 * panel, 0.155], [105, 100, 95]);
  return { data, width: size, height: size, pngSha256: LIBRARY_MASTER_SHA256 };
}
function read(data: Uint8Array, quad: Quad, u: number, v: number): number[] {
  const uv = point(quad, u, v), index = (Math.floor(uv[1] * size) * size + Math.floor(uv[0] * size)) * 4;
  return Array.from(data.subarray(index, index + 4));
}

test('library repair reconstructs three window axes and blank end bays from the correct side donor', () => {
  const source = fixture(), before = source.data.slice(), output = before.slice();
  const evidence = libraryRestoration.apply(28, output, size, size, new Map([[28, source]]));
  for (const quad of [LIBRARY_SOUTH_QUAD, LIBRARY_NORTH_QUAD]) {
    for (let panel = 1; panel <= 11; panel++) {
      const sample = read(output, quad, 0.0215 + (panel - 0.5) * 0.96 / 11, 0.5);
      assert.ok([4, 6, 8].includes(panel) ? sample[0]! < 50 : sample[0]! > 190, `panel ${panel} has the wrong architectural class: ${sample}`);
      assert.deepEqual(read(output, quad, 0.0215 + (panel - 0.5) * 0.96 / 11, 0.08).slice(0, 3), [105, 100, 95]);
    }
  }
  assert.deepEqual(source.data, before, 'native donor is immutable');
  assert.equal(evidence.length, 2);
  assert.ok(evidence.every(e => e.changedTexels > 0));
});

test('library repair confines writes to its two wall charts and retains alpha and clerestories', () => {
  const source = fixture(), output = source.data.slice(), before = output.slice();
  libraryRestoration.apply(28, output, size, size, new Map([[28, source]]));
  let outside = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = (y * size + x) * 4;
    assert.equal(output[i + 3], before[i + 3], 'alpha changes are forbidden');
    if ([LIBRARY_SOUTH_QUAD, LIBRARY_NORTH_QUAD].some(q => inside(q, (x + 0.5) / size, (y + 0.5) / size))) continue;
    for (let ch = 0; ch < 3; ch++) assert.equal(output[i + ch], before[i + ch], `outside wall chart at ${x},${y}`);
    outside++;
  }
  assert.ok(outside > 600000);
  for (const quad of [LIBRARY_SOUTH_QUAD, LIBRARY_NORTH_QUAD]) for (const u of [0.30, 0.50, 0.70]) {
    assert.deepEqual(read(output, quad, u, 0.91), read(before, quad, u, 0.91), 'clerestory must remain original');
  }
});

test('changed source identity, malformed dimensions and unfit illumination fail before writes; other pages are untouched', () => {
  const source = fixture(), output = source.data.slice(), before = output.slice();
  assert.deepEqual(libraryRestoration.apply(27, output, size, size, new Map()), []);
  assert.throws(() => libraryRestoration.apply(28, output, size, size, new Map([[28, { ...source, pngSha256: 'changed' }]])), /master changed/);
  assert.throws(() => libraryRestoration.apply(28, output, size, size, new Map([[28, { ...source, width: 512 }]])), /dimensions invalid/);
  const dark = { ...source, data: source.data.slice() };
  paint(dark.data, LIBRARY_NORTH_QUAD, [0, 0, 1, 1], [0, 0, 0]);
  assert.throws(() => libraryRestoration.apply(28, output, size, size, new Map([[28, dark]])), /illumination anchors/);
  assert.deepEqual(output, before);
});
