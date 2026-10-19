// Origin height from the city terrain model (decision 0005): a least-squares plane through the terrain on a 1 m grid
// over an 8 to 20 m annulus around the projected origin, one 0.5 m rejection pass, evaluated at the centre. The
// annulus skips the statue's stepped base, which the terrain model contains. Prints the heightDerivation record.
//   node tools/world/derive_origin_height.ts --tiles data/raw/helsinki-terrain/senate-district --easting 25497350 --northing 6672960
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { loadTerrainSnapshot } from './lib/quantized-mesh.ts';

const { values } = parseArgs({ options: { tiles: { type: 'string' }, easting: { type: 'string' }, northing: { type: 'string' } } });
if (!values.tiles || !values.easting || !values.northing) throw new Error('--tiles, --easting and --northing are required');
const E0 = Number(values.easting), N0 = Number(values.northing);
const terrain = loadTerrainSnapshot(values.tiles, b => createHash('sha256').update(b).digest('hex'));
let samples: [number, number, number][] = [];
for (let dy = -20; dy <= 20; dy++) for (let dx = -20; dx <= 20; dx++) {
  const r = Math.hypot(dx, dy);
  if (r < 8 || r > 20) continue;
  const h = terrain.heightAtEN(E0 + dx, N0 + dy);
  if (h !== null) samples.push([dx, dy, h]);
}
/** Plane h = a + b·dx + c·dy by the normal equations. */
function fit(s: [number, number, number][]): [number, number, number] {
  let n = 0, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sh = 0, sxh = 0, syh = 0;
  for (const [x, y, h] of s) { n++; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; sh += h; sxh += x * h; syh += y * h; }
  const m = [[n, sx, sy], [sx, sxx, sxy], [sy, sxy, syy]], v = [sh, sxh, syh];
  const det = (a: number[][]) => a[0]![0]! * (a[1]![1]! * a[2]![2]! - a[1]![2]! * a[2]![1]!) - a[0]![1]! * (a[1]![0]! * a[2]![2]! - a[1]![2]! * a[2]![0]!) + a[0]![2]! * (a[1]![0]! * a[2]![1]! - a[1]![1]! * a[2]![0]!);
  const D = det(m);
  return [0, 1, 2].map(i => det(m.map((row, r) => row.map((x, c) => (c === i ? v[r]! : x)))) / D) as [number, number, number];
}
const total = samples.length;
let [a, b, c] = fit(samples);
samples = samples.filter(([x, y, h]) => Math.abs(h - (a + b * x + c * y)) <= 0.5);
[a, b, c] = fit(samples);
const rms = Math.sqrt(samples.reduce((s, [x, y, h]) => s + (h - (a + b * x + c * y)) ** 2, 0) / samples.length);
console.log(JSON.stringify({
  method: 'least-squares plane through the city terrain model (2021_terrain) on a 1 m grid over an 8 to 20 m annulus around (E0, N0), one 0.5 m rejection pass',
  height: Math.round(a * 100) / 100, heightUnrounded: a, slopePerMetre: [b, c], samples: total, kept: samples.length, rmsMeters: Math.round(rms * 1000) / 1000,
}, null, 1));
