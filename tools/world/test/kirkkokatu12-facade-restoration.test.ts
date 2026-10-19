import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KIRKKOKATU12_DONOR_SHA256, KIRKKOKATU12_MASTER_SHA256, KIRKKOKATU12_NORTH_QUAD, KIRKKOKATU12_REAR_QUAD, kirkkokatu12Restoration } from '../lib/kirkkokatu12-facade-restoration.ts';

type Point = readonly [number, number];
type Quad = readonly [Point, Point, Point, Point];
type Image = { data: Uint8Array; width: number; height: number; pngSha256: string };
function point(q: Quad, u: number, v: number): Point {
  // Independent bilinear test marks have finite interiors; the production mapping uses actual triangles.
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
function paint(image: Image, q: Quad, b: readonly [number, number, number, number], color: readonly number[]): void {
  const polygon = [point(q, b[0], b[1]), point(q, b[2], b[1]), point(q, b[2], b[3]), point(q, b[0], b[3])];
  for (let y = Math.max(0, Math.floor(Math.min(...polygon.map(p => p[1])) * image.height)); y <= Math.min(image.height - 1, Math.ceil(Math.max(...polygon.map(p => p[1])) * image.height)); y++) {
    for (let x = Math.max(0, Math.floor(Math.min(...polygon.map(p => p[0])) * image.width)); x <= Math.min(image.width - 1, Math.ceil(Math.max(...polygon.map(p => p[0])) * image.width)); x++) {
      if (inside(polygon, (x + 0.5) / image.width, (y + 0.5) / image.height)) for (let ch = 0; ch < 3; ch++) image.data[(y * image.width + x) * 4 + ch] = color[ch]!;
    }
  }
}
function make(width: number, height: number, rgb: readonly number[], pngSha256: string): Image {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set([...rgb, 183], i);
  return { data, width, height, pngSha256 };
}
function fixture() {
  const north = make(1024, 256, [110, 105, 95], KIRKKOKATU12_MASTER_SHA256), rear = make(1024, 1024, [220, 210, 190], KIRKKOKATU12_DONOR_SHA256);
  paint(rear, KIRKKOKATU12_REAR_QUAD, [0.040, 0.045, 0.090, 0.140], [150, 155, 160]);
  paint(rear, KIRKKOKATU12_REAR_QUAD, [0.447, 0.250, 0.495, 0.310], [90, 140, 180]);
  paint(rear, KIRKKOKATU12_REAR_QUAD, [0.440, 0.270, 0.445, 0.295], [25, 30, 35]);
  paint(rear, KIRKKOKATU12_REAR_QUAD, [0.413, 0.340, 0.425, 1], [150, 150, 150]);
  paint(rear, KIRKKOKATU12_REAR_QUAD, [0.603, 0.340, 0.615, 1], [150, 150, 150]);
  return { north, rear, sources: new Map([[62, rear], [67, north]]) };
}
function read(data: Uint8Array, u: number, v: number): number[] {
  const p = point(KIRKKOKATU12_NORTH_QUAD, u, v), i = (Math.floor(p[1] * 256) * 1024 + Math.floor(p[0] * 1024)) * 4;
  return Array.from(data.subarray(i, i + 4));
}
function glassRuns(output: Uint8Array, bay: number, v: number): number[] {
  const widths: number[] = []; let inGlass = false;
  for (let i = 0; i <= 800; i++) {
    const p = read(output, (bay + i / 800) / 7, v), glass = p[2]! > p[0]! + 20;
    if (glass && !inGlass) widths.push(0);
    if (glass) widths[widths.length - 1]!++;
    inGlass = glass;
  }
  return widths;
}

test('seven source-aligned structural bays retain one western portal and six five-pane ground windows', () => {
  const { north, rear, sources } = fixture(), originalNorth = north.data.slice(), originalRear = rear.data.slice(), output = north.data.slice();
  const evidence = kirkkokatu12Restoration.apply(67, output, 1024, 256, sources);
  for (let bay = 0; bay < 7; bay++) {
    assert.ok(read(output, (bay + 0.03) / 7, 0.60)[0]! < 90, `structural pier missing in bay${bay + 1}`);
    assert.ok(read(output, (bay + 0.50) / 7, 0.60)[0]! > 100, `bay centre overwritten in bay${bay + 1}`);
    if (bay === 0) {
      assert.equal(glassRuns(output, bay, 0.275).length, 0, 'the portal must not become an office window');
      assert.ok(read(output, 0.5 / 7, 0.275)[0]! < 20, 'deep portal recess must remain visible');
    } else {
      const runs = glassRuns(output, bay, 0.275);
      assert.equal(runs.length, 5, `ordinary bay${bay + 1} must contain five panes`);
      assert.ok(runs.slice(1, 4).every(w => w > runs[0]! * 1.6 && w > runs[4]! * 1.6), `bay${bay + 1} must contain three broad and two narrow panes: ${runs}`);
    }
  }
  assert.deepEqual(north.data, originalNorth);
  assert.deepEqual(rear.data, originalRear);
  assert.ok(evidence[0]!.changedTexels > 0);
});

test('ordinary bays keep a barred basement ribbon beneath the full-rank windows', () => {
  const { north, sources } = fixture(), output = north.data.slice();
  kirkkokatu12Restoration.apply(67, output, 1024, 256, sources);
  for (let bay = 1; bay < 7; bay++) {
    const runs = glassRuns(output, bay, 0.135);
    assert.ok(runs.length >= 15 && runs.length <= 24, `basement grille disappeared or became a door in bay${bay + 1}: ${runs.length}`);
    const stone = read(output, (bay + 0.5) / 7, 0.06);
    assert.ok(stone[0]! > 50 && Math.abs(stone[2]! - stone[0]!) < 15, 'granite base must remain material, without glass/portal loss');
  }
});

test('all writes stay within the north source triangles and preserve alpha; other target pages are untouched', () => {
  const { north, sources } = fixture(), output = north.data.slice(), before = output.slice();
  kirkkokatu12Restoration.apply(67, output, 1024, 256, sources);
  let outside = 0;
  for (let y = 0; y < 256; y++) for (let x = 0; x < 1024; x++) {
    const i = (y * 1024 + x) * 4;
    assert.equal(output[i + 3], before[i + 3]);
    if (inside(KIRKKOKATU12_NORTH_QUAD, (x + 0.5) / 1024, (y + 0.5) / 256)) continue;
    assert.deepEqual(output.subarray(i, i + 4), before.subarray(i, i + 4)); outside++;
  }
  assert.ok(outside > 30000);
  const partyWall = new Uint8Array([1, 2, 3, 183]);
  assert.deepEqual(kirkkokatu12Restoration.apply(64, partyWall, 1, 1, new Map()), []);
  assert.deepEqual(partyWall, Uint8Array.from([1, 2, 3, 183]));
});

test('both source identities, dimensions and shade anchors are checked before writing', () => {
  const { north, rear, sources } = fixture(), output = north.data.slice(), before = output.slice();
  assert.throws(() => kirkkokatu12Restoration.apply(67, output, 1024, 256, new Map([[62, { ...rear, pngSha256: 'changed' }], [67, north]])), /masters changed/);
  assert.throws(() => kirkkokatu12Restoration.apply(67, output, 1024, 256, new Map([[62, rear], [67, { ...north, height: 1024 }]])), /dimensions invalid/);
  const dark = { ...rear, data: new Uint8Array(rear.data.length) };
  assert.throws(() => kirkkokatu12Restoration.apply(67, output, 1024, 256, new Map([[62, dark], [67, north]])), /clean concrete beam anchors/);
  assert.deepEqual(output, before);
  assert.equal(sources.get(62), rear);
});
