import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { bankRestoration } from '../lib/bank-facade-restoration.ts';
import type { FacadeSourceImage } from '../lib/facade-restoration-types.ts';

type Point = [number, number];
const charts = JSON.parse(readFileSync(new URL('../../../content/helsinki/facade-restorations/bank.json', import.meta.url), 'utf8')).charts as { id: string; page: number; pngSha256: string; triangles: { uv: Point[] }[] }[];
function fixture() {
  return new Map(bankRestoration.sourcePages.map(page => {
    const width = 1024, height = page === 33 ? 256 : page === 34 ? 512 : 1024, data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data.set([120 + x % 21, 120 + y % 21, 120 + (x + y) % 21, 173], (y * width + x) * 4);
    return [page, { width, height, data, pngSha256: charts.find(c => c.page === page)!.pngSha256 }] as const;
  }));
}
function inside(points: Point[], x: number, y: number) {
  let result = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i]!, b = points[j]!;
    if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) result = !result;
  }
  return result;
}
test('Bank repairs remain inside the intended original wall triangles; alpha and native donors stay unchanged', () => {
  const sources = fixture(), originals = new Map([...sources].map(([p, s]) => [p, s.data.slice()]));
  for (const page of bankRestoration.targetPages) {
    const source = sources.get(page)!, output = source.data.slice();
    const report = bankRestoration.apply(page, output, source.width, source.height, sources);
    assert.ok(report.some(r => r.changedTexels > 1000));
    const ids = page === 29 ? [2, 21] : page === 30 ? [1] : page === 31 ? [7, 11, 12, 29, 37] : page === 34 ? [27] : [0];
    const triangles = charts.filter(c => ids.some(id => c.id.startsWith(`bank-${id}-`))).flatMap(c => c.triangles);
    let changed = 0, outside = 0;
    for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) {
      const i = (y * source.width + x) * 4;
      assert.equal(output[i + 3], 173);
      const differs = output[i] !== source.data[i] || output[i + 1] !== source.data[i + 1] || output[i + 2] !== source.data[i + 2];
      if (differs) {
        changed++;
        assert.ok(triangles.some(t => inside(t.uv, (x + .5) / source.width, (y + .5) / source.height)), `outside page ${page} chart at ${x},${y}`);
      } else outside++;
    }
    assert.ok(changed > 1000 && outside > 1000);
  }
  for (const [page, source] of sources) assert.deepEqual(source.data, originals.get(page));
});
test('Bank input guards reject drift before any target mutation', () => {
  const sources = fixture(), source = sources.get(30)!, output = source.data.slice();
  const bad = new Map<number, FacadeSourceImage>(sources);
  bad.set(33, { ...sources.get(33)!, pngSha256: 'changed' });
  assert.throws(() => bankRestoration.apply(30, output, source.width, source.height, bad), /master 33 changed/);
  bad.set(33, { ...sources.get(33)!, height: 1024 });
  assert.throws(() => bankRestoration.apply(30, output, source.width, source.height, bad), /dimensions invalid/);
  assert.deepEqual(bankRestoration.apply(28, output, source.width, source.height, new Map()), []);
  assert.deepEqual(output, source.data);
});
