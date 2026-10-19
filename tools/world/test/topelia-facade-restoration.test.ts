import assert from 'node:assert/strict';
import { test } from 'node:test';
import { topeliaRestoration } from '../lib/facade-restoration.ts';
import { topeliaFacets } from '../lib/topelia-facade-map.ts';

type Point = readonly [number, number];
const hashes = ['39d1a2587a5630829733b64bd7cdbeb00c8421ee25336e4132518ab75044c296', '2fcce158ffaba2f0646d5a7c685101ad8316d04ec02e96534bc2c7dd9c6180cc'];
function pixels(size: number): Uint8Array {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) data.set([30 + x % 211, 20 + y % 221, 45 + (x + y) % 199, 173], (y * size + x) * 4);
  return data;
}
const fixture = () => new Map([23,24].map((page, i) => { const data = new Uint8Array(1024 * 1024 * 4); for (let p = 0; p < data.length; p += 4) data.set([160,170,180,173],p); return [page, { width: 1024, height: 1024, data, pngSha256: hashes[i]! }]; }));
// Half-plane polygon test independently checks authoring confinement in image space.
function inside(triangle: readonly Point[], x: number, y: number): boolean {
  const sides = triangle.map((a, i) => { const b = triangle[(i + 1) % 3]!; return (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]); });
  return sides.every(v => v >= -1e-8) || sides.every(v => v <= 1e-8);
}
test('Topelia edits only licensed wall charts and preserves alpha and native donor buffers', () => {
  const sources = fixture(), beforeSources = [...sources.values()].map(s => s.data.slice()), size = 512;
  let total = 0;
  for (const page of [23,24]) {
    const before = pixels(size), output = before.slice();
    const evidence = topeliaRestoration.apply(page, output, size, size, sources);
    const charts = Object.values(topeliaFacets).flat().filter(f => f.page === page).flatMap(f => [...f.triangles]);
    let changed = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      assert.equal(output[i + 3], before[i + 3], 'alpha must remain original');
      if (output[i] === before[i] && output[i + 1] === before[i + 1] && output[i + 2] === before[i + 2]) continue;
      assert.ok(charts.some(t => inside(t.uv, (x + .5) / size, (y + .5) / size)), `write outside Topelia wall charts: page${page} ${x},${y}`);
      changed++;
    }
    assert.equal(evidence.length, 1); assert.ok(changed > 1000); total += changed;
  }
  assert.ok(total > 30000);
  [...sources.values()].forEach((source, i) => assert.deepEqual(source.data, beforeSources[i], 'source masters must never be mutated'));
});

test('Topelia retains clean upper portico, north wing windows, annex upper windows and gables', () => {
  const sources = fixture(), size = 512;
  const protectedSets = [
    { facets: topeliaFacets.center, height: 10.05 },
    { facets: [...topeliaFacets.northOuter, ...topeliaFacets.northInner], height: 8 },
    { facets: topeliaFacets.annexNorth, height: 15.05 },
    { facets: topeliaFacets.annexSouth, height: 11.65 },
    { facets: topeliaFacets.annexEast, height: 8.8 }
  ];
  for (const page of [23,24]) {
    const before = pixels(size), output = before.slice(); topeliaRestoration.apply(page, output, size, size, sources);
    let checks = 0;
    for (const { facets, height } of protectedSets) for (const f of facets) {
      if (f.page !== page) continue;
      for (const t of f.triangles) for (let a = .05; a < .95; a += .10) for (let b = .05; a + b < .95; b += .10) {
        const q = [a,b,1-a-b], h = q.reduce((s,v,i) => s + v * t.plane[i]![1], 0); if (h < height) continue;
        const uv = [0,1].map(k => q.reduce((s,v,i) => s + v * t.uv[i]![k]!, 0)), i = (Math.floor(uv[1]! * size) * size + Math.floor(uv[0]! * size)) * 4;
        assert.deepEqual(output.subarray(i, i + 4), before.subarray(i, i + 4), `protected architecture page${page} H${h}`); checks++;
      }
    }
    assert.ok(checks > 100);
  }
});

test('changed Topelia identity and malformed dimensions fail before writes; unrelated pages stay untouched', () => {
  const sources = fixture(), output = pixels(512), before = output.slice();
  assert.deepEqual(topeliaRestoration.apply(44, output, 512, 512, new Map()), []);
  const changed = new Map(sources); changed.set(23, { ...sources.get(23)!, pngSha256: 'different' });
  assert.throws(() => topeliaRestoration.apply(23, output, 512, 512, changed), /master23 changed/);
  const malformed = new Map(sources); malformed.set(24, { ...sources.get(24)!, width: 512 });
  assert.throws(() => topeliaRestoration.apply(23, output, 512, 512, malformed), /dimensions invalid/);
  assert.deepEqual(output, before);
});

test('both real north-annex porch roofs, doors and steps remain exactly original', () => {
  const sources = fixture(), size = 1024, before = pixels(size), output = before.slice();
  topeliaRestoration.apply(24, output, size, size, sources);
  let checks = 0;
  for (const f of topeliaFacets.annexNorth) for (const t of f.triangles) {
    for (let a = .025; a < .975; a += .025) for (let b = .025; a + b < .975; b += .025) {
      const q = [a,b,1-a-b], e = q.reduce((s,v,i) => s + v * t.plane[i]![0], 0), h = q.reduce((s,v,i) => s + v * t.plane[i]![1], 0);
      if (h < 7 || h > 11.5 || ![[-124.4,-121.3],[-109.1,-105.3]].some(([lo,hi]) => e >= lo! && e <= hi!)) continue;
      const uv = [0,1].map(k => q.reduce((s,v,i) => s + v * t.uv[i]![k]!, 0)), i = (Math.floor(uv[1]! * size) * size + Math.floor(uv[0]! * size)) * 4;
      assert.deepEqual(output.subarray(i, i + 4), before.subarray(i, i + 4), `real porch/door changed at east${e},height${h}`); checks++;
    }
  }
  assert.ok(checks > 100);
});

test('south-end reconstruction leaves unconfirmed western windows and porch exactly original', () => {
  const sources = fixture(), size = 1024, before = pixels(size), output = before.slice();
  topeliaRestoration.apply(24, output, size, size, sources);
  let checks = 0;
  for (const f of topeliaFacets.mainSouthEnd) for (const t of f.triangles) {
    for (let a = .04; a < .96; a += .04) for (let b = .04; a + b < .96; b += .04) {
      const q = [a,b,1-a-b], e = q.reduce((s,v,i) => s + v * t.plane[i]![0], 0); if (e > -100.9) continue;
      const uv = [0,1].map(k => q.reduce((s,v,i) => s + v * t.uv[i]![k]!, 0)), i = (Math.floor(uv[1]! * size) * size + Math.floor(uv[0]! * size)) * 4;
      assert.deepEqual(output.subarray(i, i + 4), before.subarray(i, i + 4)); checks++;
    }
  }
  assert.ok(checks > 150);
});
