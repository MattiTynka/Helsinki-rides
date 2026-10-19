import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { eraseVegetation, repairFacadeMask, type VegetationOptions, type VegetationRepairDiagnostics } from '../lib/vegetation.ts';
import { restoreUniversityFacade, assertUniversityMaster, UNIVERSITY_MASTER_SHA256 } from '../lib/facade-restoration.ts';

const options: VegetationOptions = { margin: 1, elevationDeg: [30, 60], sideways: .6, greenOverRed: 4, greenOverBlue: 0, minValue: 20, minSaturation: .15, reachMetres: 4, closeMetres: .4, holeMetres: 3, darkLuma: 75, dilate: 2, bayMetres: [2, 2], minBayCorrelation: .9, maxChartEraseFraction: .08, maxRegionMetres: 4, maxBoundaryError: 10 };
function facade(w = 80, h = 48) {
  const image = new Uint8Array(w * h * 4).fill(255);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const value = y % 16 < 2 ? 225 : x % 8 < 4 ? 70 : 180;
    image.set([value, value, value, 255], (y * w + x) * 4);
  }
  return image;
}
function inputs(w = 80, h = 48) { return { mask: new Uint8Array(w * h), axis: new Uint8Array(w * h), scale: new Float32Array(w * h).fill(4) }; }

test('small occlusion uses one matching window bay and preserves all remaining facade bytes', () => {
  const w = 80, h = 48, expected = facade(w, h), image = Uint8Array.from(expected), { mask, axis, scale } = inputs(w, h);
  for (let y = 20; y < 24; y++) for (let x = 28; x < 30; x++) { const i = y * w + x; mask[i] = 1; image.set([10, 155, 25, 255], i * 4); }
  const diagnostics: VegetationRepairDiagnostics = { candidates: 0, changed: 0, decisions: [] };
  assert.equal(repairFacadeMask(image, w, h, mask, axis, scale, options, diagnostics), 8);
  assert.deepEqual(image, expected);
  assert.equal(diagnostics.decisions.length, 1);
  assert.equal(diagnostics.decisions[0]!.boundaryError, 0);
});

test('extensive canopy is retained instead of smoothing windows and pilasters away', () => {
  const w = 80, h = 48, image = facade(w, h), { mask, axis, scale } = inputs(w, h);
  for (let y = 8; y < 32; y++) for (let x = 20; x < 50; x++) { mask[y * w + x] = 1; image.set([10, 155, 25, 255], (y * w + x) * 4); }
  const before = Uint8Array.from(image);
  assert.equal(repairFacadeMask(image, w, h, mask, axis, scale, options), 0);
  assert.deepEqual(image, before);
});

test('window detail with no repeated donor never gets a fallback plaster or blur patch', () => {
  const w = 80, h = 48, image = facade(w, h), { mask, axis, scale } = inputs(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * w + x, value = 40 + ((x * 71 + y * 37 + x * y * 13) % 170); image.set([value, value, value, 255], i * 4); }
  for (let y = 20; y < 24; y++) for (let x = 28; x < 30; x++) mask[y * w + x] = 1;
  const before = Uint8Array.from(image);
  assert.equal(repairFacadeMask(image, w, h, mask, axis, scale, options), 0);
  assert.deepEqual(image, before);
});

test('production restoration never performs automatic erasure, even for a valid repeated donor', () => {
  const image = facade(), before = Uint8Array.from(image);
  const diagnostics: VegetationRepairDiagnostics = { candidates: 10, changed: 10, decisions: [] };
  assert.equal(eraseVegetation(image, 80, 48, [], { ...options, mode: 'restore-original' }, diagnostics), 0);
  assert.deepEqual(image, before);
  assert.equal(diagnostics.changed, 0);
  assert.match(diagnostics.decisions[0]!.reason, /automatic erasure disabled/);
});

const master = 'data/work/m0/citymodel-v2/textures/7f81c3cb1aa8e9e6.png';
test('curated source mapping refuses changed or unrelated master bytes', () => {
  assert.throws(() => assertUniversityMaster(new Uint8Array([0, 1, 2, 3])), /master changed/);
});
test('University reconstruction retains original upper windows, all donor pixels and other UV charts', { skip: !existsSync(master) }, async () => {
  const bytes = readFileSync(master);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), UNIVERSITY_MASTER_SHA256);
  assertUniversityMaster(bytes);
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const image = Uint8Array.from(data), result = restoreUniversityFacade(image, info.width, info.height);
  let changed = 0;
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    const i = (y * info.width + x) * 4;
    if (image[i] === data[i] && image[i + 1] === data[i + 1] && image[i + 2] === data[i + 2]) continue;
    changed++;
    assert.ok(x / info.width < .43 && y / info.height >= .343 && (y + .5) / info.height <= .547376, `changed protected chart/window pixel${x},${y}`);
    assert.equal(image[i + 3], data[i + 3]);
  }
  assert.ok(changed > 50000);
  assert.equal(result.retainedUpperHeightFraction, .41);
  assert.ok(result.gain.every(g => g >= .2 && g <= 1.6));
});
