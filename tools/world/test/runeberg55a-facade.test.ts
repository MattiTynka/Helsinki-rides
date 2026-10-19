import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { RUNE_BERG55A_LAYOUT, RUNE_BERG55A_MASTER_SHA256, RUNE_BERG55A_PAGE, RUNE_BERG55A_QUAD, runeberg55aPhysicalPoint, runeberg55aPixel, runeberg55aRestoration, runeberg55aUvPoint } from '../lib/runeberg55a-facade.ts';

function fixture() {
  const data = new Uint8Array(1024 * 1024 * 4);
  for (let y = 0; y < 1024; y++) for (let x = 0; x < 1024; x++) {
    const p = runeberg55aPhysicalPoint([(x + .5) / 1024, (y + .5) / 1024]);
    let rgb = [165, 150, 120];
    if (p && p[1] >= .843 && p[1] <= .930 && p[0] >= .38 && p[0] <= .555) rgb = [30, 40, 50];
    if (p && p[1] >= .843 && p[1] <= .930 && p[0] >= .72 && p[0] <= .90) rgb = [70, 85, 100];
    if (p && p[1] >= .814 && p[1] <= .880 && p[0] <= .285) rgb = [20, 35, 65];
    data.set([...rgb, 173], (y * 1024 + x) * 4);
  }
  return new Map([[RUNE_BERG55A_PAGE, { width: 1024, height: 1024, data, pngSha256: RUNE_BERG55A_MASTER_SHA256 }]]);
}
function inPolygon(x: number, y: number): boolean {
  let inside = false;
  const q = RUNE_BERG55A_QUAD;
  for (let i = 0, j = q.length - 1; i < q.length; j = i++) {
    const a = q[i]!, b = q[j]!;
    if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

test('Runeberg55a rejects changed masters and malformed targets before writing', () => {
  const sources = fixture(), original = sources.get(RUNE_BERG55A_PAGE)!;
  const output = new Uint8Array(256 * 256 * 4).fill(97), before = output.slice();
  for (const invalid of ['missing', 'hash', 'size', 'pixels']) {
    const broken = new Map(sources);
    if (invalid === 'missing') broken.clear();
    if (invalid === 'hash') broken.set(RUNE_BERG55A_PAGE, { ...original, pngSha256: 'wrong' });
    if (invalid === 'size') broken.set(RUNE_BERG55A_PAGE, { ...original, width: 512 });
    if (invalid === 'pixels') broken.set(RUNE_BERG55A_PAGE, { ...original, data: new Uint8Array(4) });
    assert.throws(() => runeberg55aRestoration.apply(RUNE_BERG55A_PAGE, output, 256, 256, broken), /source master changed/);
    assert.deepEqual(output, before);
  }
  assert.throws(() => runeberg55aRestoration.apply(RUNE_BERG55A_PAGE, output, 128, 512, sources), /dimensions invalid/);
  assert.deepEqual(runeberg55aRestoration.apply(2615, output, 256, 256, new Map()), []);
  assert.deepEqual(output, before);
});

test('Runeberg55a clips shared-page writes to the exact wall polygon at production and native sizes', () => {
  const sources = fixture(), source = sources.get(RUNE_BERG55A_PAGE)!;
  const sourceHash = createHash('sha256').update(source.data).digest('hex');
  for (const size of [256, 512, 1024]) {
    const output = new Uint8Array(size * size * 4).fill(211), before = output.slice();
    const evidence = runeberg55aRestoration.apply(RUNE_BERG55A_PAGE, output, size, size, sources);
    assert.ok(evidence[0]!.changedTexels > 1000);
    let outside = 0, protectedCount = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const index = (y * size + x) * 4, uv = [(x + .5) / size, (y + .5) / size] as const;
      assert.equal(output[index + 3], before[index + 3]);
      if (!inPolygon(...uv)) { outside++; assert.deepEqual(output.subarray(index, index + 4), before.subarray(index, index + 4)); }
      const p = runeberg55aPhysicalPoint(uv);
      // Explicit independently stated acceptance regions, including the actual unique shop opening/canopy.
      if (p && (p[1] <= .255 || p[1] >= .815 || p[0] >= .965 || (p[0] >= .41 && p[0] <= .52 && p[1] >= .727 && p[1] <= .754) || (p[0] >= .755 && p[0] <= .865 && [[.304, .345], [.441, .482], [.578, .621], [.714, .758]].some(([lo, hi]) => p[1] >= lo! && p[1] <= hi!)))) {
        protectedCount++; assert.deepEqual(output.subarray(index, index + 4), before.subarray(index, index + 4));
      }
    }
    assert.ok(outside > size * size * .8); assert.ok(protectedCount > 500);
  }
  assert.equal(createHash('sha256').update(source.data).digest('hex'), sourceHash);
});

test('Runeberg55a keeps its five-row asymmetric architecture and repairs windows and plaster, not only bands', () => {
  const sources = fixture(), source = sources.get(RUNE_BERG55A_PAGE)!;
  assert.equal(RUNE_BERG55A_LAYOUT.residentialStoreys, 5);
  for (const [low, high] of RUNE_BERG55A_LAYOUT.ordinaryRows) {
    const window = runeberg55aPixel(.4, (low + high) / 2, source)!, wall = runeberg55aPixel(.63, (low + high) / 2, source)!;
    assert.equal(window.role, 'ordinary-window-column1'); assert.ok(window.rgb[0]! < 50);
    assert.equal(wall.role, 'same-face-plaster'); assert.ok(wall.rgb[0]! > 140);
  }
  for (const [low, high] of RUNE_BERG55A_LAYOUT.wideRows) {
    const wide = runeberg55aPixel(.13, (low + high) / 2, source)!;
    assert.equal(wide.role, 'wide-west-window-return'); assert.ok(wide.rgb[2]! > wide.rgb[0]! * 2);
  }
  for (const p of [[.4, .15], [.8, .15], [.8, .22], [.45, .88], [.98, .5], [.81, .6], [.467, .74]]) assert.equal(runeberg55aPixel(p[0]!, p[1]!, source), null);
  const output = new Uint8Array(512 * 512 * 4).fill(211), evidence = runeberg55aRestoration.apply(RUNE_BERG55A_PAGE, output, 512, 512, sources)[0]!;
  const roles = evidence['roles'] as Record<string, number>, bands = (roles['ordinary-sill-band'] ?? 0) + (roles['wide-return-sill-band'] ?? 0);
  assert.ok(roles['same-face-plaster']! > bands * 5);
  assert.ok((roles['ordinary-window-column1']! + roles['wide-west-window-return']!) > bands * 2);
  for (const [u, v] of [[.05, .3], [.45, .7], [.95, .8]]) {
    const p = runeberg55aPhysicalPoint(runeberg55aUvPoint(u!, v!))!;
    assert.ok(Math.abs(p[0] - u!) < 1e-10 && Math.abs(p[1] - v!) < 1e-10);
  }
});
