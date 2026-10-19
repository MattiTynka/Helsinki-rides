// A curated homologous facade from the SAME licensed LoD2 page. This is a complete architectural bay group,
// not a foliage-shaped fill. The two University wings have matching five-bay, two-storey pilaster elevations.
// Quad corners come from the original texture44 wall vertices (lower-left, lower-right, upper-right, upper-left).
// Opposite-wing illumination is fitted against the target's unoccluded upper storey. No external image is used.
import { createHash } from 'node:crypto';
import { topeliaFacets } from './topelia-facade-map.ts';
import type { FacadeSourceImage, FacadeSources, FacadeRestorationModule } from './facade-restoration-types.ts';
export const UNIVERSITY_PAGE = 44;
export const UNIVERSITY_MASTER_SHA256 = 'd7b3b3ee2fd8b1cb64c6ff3496f8fb42db77149e571f077e52089fa68526f90b';
export function assertUniversityMaster(bytes: Uint8Array): void {
  if (createHash('sha256').update(bytes).digest('hex') !== UNIVERSITY_MASTER_SHA256) throw new Error('University master changed; curated facade mapping requires review');
}

type Facet = { readonly page: number; readonly triangles: readonly { readonly uv: readonly Point[]; readonly plane: readonly Point[]; readonly depth: readonly number[] }[] };
type FacetSample = { readonly color: number[]; readonly depth: number };
const TOP_ELIA_HASHES = new Map([[23, '39d1a2587a5630829733b64bd7cdbeb00c8421ee25336e4132518ab75044c296'], [24, '2fcce158ffaba2f0646d5a7c685101ad8316d04ec02e96534bc2c7dd9c6180cc']]);
function barycentric(a: Point, b: Point, c: Point, x: number, y: number): number[] | null {
  const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
  if (Math.abs(d) < 1e-10) return null;
  const u = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / d;
  const v = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / d;
  return u < -1e-6 || v < -1e-6 || u + v > 1.000001 ? null : [u, v, 1 - u - v];
}
function sourceColor(image: FacadeSourceImage, u: number, v: number): number[] {
  const x = Math.max(0, Math.min(image.width - 1, u * image.width - .5)), y = Math.max(0, Math.min(image.height - 1, v * image.height - .5));
  const ix = Math.floor(x), iy = Math.floor(y), tx = x - ix, ty = y - iy;
  return [0, 1, 2].map(ch => {
    const at = (xx: number, yy: number) => image.data[(Math.min(image.height - 1, yy) * image.width + Math.min(image.width - 1, xx)) * 4 + ch]!;
    return (at(ix, iy) * (1 - tx) + at(ix + 1, iy) * tx) * (1 - ty) + (at(ix, iy + 1) * (1 - tx) + at(ix + 1, iy + 1) * tx) * ty;
  });
}
function sampleFacets(facets: readonly Facet[], sources: FacadeSources, along: number, height: number): FacetSample | null {
  let result: FacetSample | null = null;
  for (const f of facets) for (const t of f.triangles) {
    const q = barycentric(t.plane[0]!, t.plane[1]!, t.plane[2]!, along, height); if (!q) continue;
    const d = q.reduce((s, w, i) => s + w * t.depth[i]!, 0); if (result && result.depth > d) continue;
    const uv = [0, 1].map(k => q.reduce((s, w, i) => s + w * t.uv[i]![k]!, 0));
    const master = sources.get(f.page); if (!master) throw new Error(`Topelia master${f.page} not loaded`);
    result = { color: sourceColor(master, uv[0]!, uv[1]!), depth: d };
  }
  return result;
}
type PaintSample = { readonly color: readonly number[]; readonly alpha?: number };
function paintFacets(rgba: Uint8Array, w: number, h: number, page: number, facets: readonly Facet[], sample: (along: number, height: number) => PaintSample | null): number {
  const changed = new Set<number>();
  for (const f of facets) { if (f.page !== page) continue; for (const t of f.triangles) {
    const xs = t.uv.map(p => p[0] * w), ys = t.uv.map(p => p[1] * h);
    for (let y = Math.max(0, Math.floor(Math.min(...ys))); y <= Math.min(h - 1, Math.ceil(Math.max(...ys))); y++) for (let x = Math.max(0, Math.floor(Math.min(...xs))); x <= Math.min(w - 1, Math.ceil(Math.max(...xs))); x++) {
      const q = barycentric(t.uv[0]!, t.uv[1]!, t.uv[2]!, (x + .5) / w, (y + .5) / h); if (!q) continue;
      const p = [0, 1].map(k => q.reduce((s, weight, i) => s + weight * t.plane[i]![k]!, 0));
      const value = sample(p[0]!, p[1]!); if (!value) continue;
      const index = y * w + x, alpha = value.alpha ?? 1;
      for (let ch = 0; ch < 3; ch++) rgba[index * 4 + ch] = Math.round(Math.max(0, Math.min(255, value.color[ch]! * alpha + rgba[index * 4 + ch]! * (1 - alpha))));
      changed.add(index);
    }
  }}
  return changed.size;
}
const repeat = (x: number, period: number) => ((x % period) + period) % period;
const fadeBelow = (height: number, full: number, end: number) => { const t = Math.max(0, Math.min(1, (end - height) / (end - full))); return t * t * (3 - 2 * t); };
// These are real porch roofs/doors/steps, confirmed by the clear Topelia B-talo courtyard photograph.
// Dark porch shadows must not be classified as photographed tree silhouettes.
export const TOPELIA_NORTH_PORCHES = [
  { minEast: -124.6, maxEast: -121.1, maxHeight: 11.85 },
  { minEast: -109.3, maxEast: -105.1, maxHeight: 11.85 }
] as const;
/** Whole homologous bays from the same licensed Topelia masters. No foliage mask or external pixels. */
export const topeliaRestoration: FacadeRestorationModule = {
  id: 'topelia-unioninkatu38', targetPages: [23, 24], sourcePages: [23, 24],
  apply(page, rgba, w, h, sources) {
    if (page !== 23 && page !== 24) return [];
    for (const [p, hash] of TOP_ELIA_HASHES) {
      const master = sources.get(p);
      if (master?.pngSha256 !== hash) throw new Error(`Topelia master${p} changed; curated facade requires review`);
      if (master.width !== 1024 || master.height !== 1024 || master.data.length !== 1024 * 1024 * 4) throw new Error(`Topelia master${p} dimensions invalid`);
    }
    if (rgba.length !== w * h * 4) throw new Error('Topelia target dimensions invalid');
    const f = topeliaFacets;
    const required = (facets: readonly Facet[], along: number, height: number) => {
      const v = sampleFacets(facets, sources, along, height);
      if (!v) throw new Error(`Topelia donor outside architectural chart at ${along},${height}`);
      return v.color;
    };
    // Far northern wing granite is intact; its matching horizontal courses replace only the low plinth.
    const granite = (along: number, height: number) => required(f.northOuter, 247.4 + repeat(along, 2.4), Math.max(5.96, Math.min(7.7, height)));
    const north = [...f.northInner, ...f.northOuter];
    const northColor = (n: number, z: number) => z < 7.75 ? granite(n, z) : required(north, Math.max(226.68, Math.min(252.15, n)), Math.min(16.19, z));
    let changed = paintFacets(rgba, w, h, page, f.south, (n, z) => {
      const sourceN = 252.15 - (n - 185.492004) * (25.47 / 25.468994);
      return { color: northColor(sourceN, z) };
    });
    changed += paintFacets(rgba, w, h, page, north, (n, z) => z < 7.75 ? { color: granite(n, z) } : null);
    // Keep the portico's upper windows/columns/roof. The rightmost lower central bay is unobscured.
    const centralLower = (n: number, z: number): PaintSample | null => {
      if (z >= 9.85) return null;
      if (z < 7.75) return { color: granite(n, z) };
      const sourceN = 222.96 + repeat(n - 211.38, 2.88);
      return { color: required(f.center, sourceN, z), alpha: fadeBelow(z, 9.65, 9.85) };
    };
    changed += paintFacets(rgba, w, h, page, f.center, centralLower);
    changed += paintFacets(rgba, w, h, page, f.mainReturns, (n, z) => z < 7.75 ? { color: granite(n, z) } : null);
    // Native projection is not uniformly spaced: preserve each source window centre with explicit bay edges.
    const annexWall = (facets: readonly Facet[], start: number, edges: readonly number[], donorIndex: number, ranges: readonly [number, number, number][], keep: (e: number, z: number) => boolean = () => false) => paintFacets(rgba, w, h, page, facets, (e, z) => {
      if (keep(e, z)) return null;
      const position = (e - start) * 40, bay = edges.findIndex((hi, i) => i > 0 && position <= hi) - 1;
      const range = ranges.find(([lo, hi]) => bay >= lo && bay <= hi); if (!range || z >= range[2]) return null;
      const u = (position - edges[bay]!) / (edges[bay + 1]! - edges[bay]!);
      const donorE = start + (edges[donorIndex]! + u * (edges[donorIndex + 1]! - edges[donorIndex]!)) / 40;
      return { color: required(facets, donorE, Math.max(6.88, z)), alpha: fadeBelow(z, range[2] - .18, range[2]) };
    });
    changed += annexWall(f.annexNorth, -130.5, [0,147.5,261.5,374,489.5,611,735.5,867,1005.5,1136.5,1261,1384,1539.7], 4, [[0,1,14.9],[2,2,11.85],[6,7,11.85],[9,11,11.95]],
      (e,z) => TOPELIA_NORTH_PORCHES.some(p => e >= p.minEast && e <= p.maxEast && z <= p.maxHeight));
    changed += annexWall(f.annexSouth, -129.41, [0,153,267,381.5,494,604.5,716,828.5,941.5,1053.5,1166,1278.5,1390.5,1534.3], 7, [[1,6,11.45],[9,10,10.2],[12,12,10.4]]);
    // The annex's granite donor is its own intact western interval; do not repeat low donor shrub pixels.
    changed += paintFacets(rgba, w, h, page, f.annexSouth, (e, z) => z < 7.5 ? { color: required(f.annexSouth, -125.4 + repeat(e, 1.2), Math.max(6.88, z)), alpha: fadeBelow(z, 7.32, 7.5) } : null);
    // The five-bay east end is clean above its lower sill. Use its clean first bay, keeping both ranks intact.
    changed += paintFacets(rgba, w, h, page, f.annexEast, (n, z) => {
      if (z >= 8.6) return null;
      const color = z < 7.75 ? granite(n, z) : required(f.annexEast, 148.55 + repeat(n - 148.55, 2.88), z);
      return { color, alpha: fadeBelow(z, 8.4, 8.6) };
    });
    // A clear south-gate photograph confirms the eastern A-building end panel is blank plaster.
    // Western windows and the uncertain porch stay original; do not invent openings behind the crown.
    const median = (values: number[]) => values.sort((a,b) => a-b)[Math.floor(values.length / 2)]!;
    const endGain = [0,1,2].map(ch => {
      const target: number[] = [], donor: number[] = [];
      for (let e = -110.2; e <= -109.7; e += .1) for (let z = 11.0; z <= 11.7; z += .1) {
        target.push(required(f.mainSouthEnd, e, z)[ch]!);
        donor.push(required(f.mainNorthEnd, -100.7 + (e + 110.2), z)[ch]!);
      }
      const gain = median(target) / Math.max(1, median(donor));
      if (gain < .65 || gain > 3) throw new Error(`Topelia blank end illumination fit is not plausible: channel${ch} gain${gain}`);
      return gain;
    });
    changed += paintFacets(rgba, w, h, page, f.mainSouthEnd, (e,z) => {
      if (e < -100.6) return null;
      if (z < 7.75) return { color: granite(e,z) };
      const donor = required(f.mainNorthEnd, -100.9 + repeat(e + 100.6, 1.5), Math.min(16.30,z));
      return { color: donor.map((v,ch) => v * endGain[ch]!) };
    });
    return [{ id: 'topelia-whole-bay-reconstruction', page, changedTexels: changed, targetAddress: 'Topelia, Unioninkatu38', sourcePages: [23, 24], mainWingBays: 9, annexNorthBays: 12, annexSouthBays: 13,
      method: 'Exact original UV/world triangles; mirrored homologous six-plus-three main wing; same-wall annex window bays; intact granite courses; bounded lower central bay',
      protectedNorthPorches: TOPELIA_NORTH_PORCHES,
      mainSouthEnd: { restoredMinEast: -100.6, donorEastInterval: [-100.9,-99.4], gain: endGain, preservedWesternOpenings: true },
      limits: 'Licensed same-building architecture reconstructs occluded pixels. Original roof geometry and both real north-annex porches/entrances/steps are retained. Only the reference-confirmed blank eastern south-end panel is reconstructed; western end openings and foliage remain original. Reference Street View and courtyard photographs inform architecture only; no external image pixels are used. Clean upper portico and annex roof bands remain original.' }];
  }
};
type Point = readonly [number, number];
type Quad = readonly [Point, Point, Point, Point];
const donor: Quad = [[0.011788812, 0.001165748], [0.491384327, 0.000976741], [0.486414611, 0.340979815], [0.000976562, 0.340658069]];
const target: Quad = [[0.023936773, 0.34375], [0.428597271, 0.34375], [0.410342634, 0.688758612], [0.001475119, 0.688878715]];
const point = (q: Quad, u: number, v: number): Point => [0, 1].map(k => q[0][k]! * (1 - u) * (1 - v) + q[1][k]! * u * (1 - v) + q[2][k]! * u * v + q[3][k]! * (1 - u) * v) as unknown as Point;
function inverse(q: Quad, x: number, y: number): Point {
  let u = (x - q[0][0]) / (q[1][0] - q[0][0]), v = (y - q[0][1]) / (q[3][1] - q[0][1]);
  for (let it = 0; it < 5; it++) {
    const p = point(q, u, v), ex = p[0] - x, ey = p[1] - y;
    const du = [0, 1].map(k => (q[1][k]! - q[0][k]!) * (1 - v) + (q[2][k]! - q[3][k]!) * v);
    const dv = [0, 1].map(k => (q[3][k]! - q[0][k]!) * (1 - u) + (q[2][k]! - q[1][k]!) * u);
    const determinant = du[0]! * dv[1]! - du[1]! * dv[0]!;
    if (Math.abs(determinant) < 1e-12) throw new Error('degenerate curated facade quad');
    u -= (ex * dv[1]! - ey * dv[0]!) / determinant;
    v -= (ey * du[0]! - ex * du[1]!) / determinant;
  }
  return [u, v];
}
export interface UniversityFacadeRestoration {
  readonly method: string;
  readonly targetAddress: string;
  readonly donor: Quad;
  readonly target: Quad;
  readonly changedTexels: number;
  readonly gain: readonly number[];
  readonly bias: readonly number[];
  readonly cleanContextSamples: number;
  readonly cleanContextMeanAbsoluteError: number;
  readonly retainedUpperHeightFraction: number;
  readonly limits: string;
}

/** The caller must verify UNIVERSITY_MASTER_SHA256 before using this source-specific map. */
export function restoreUniversityFacade(rgba: Uint8Array, w: number, h: number): UniversityFacadeRestoration {
  if (rgba.length !== w * h * 4 || w < 128 || h < 128) throw new Error('curated facade source dimensions invalid');
  const source = Uint8Array.from(rgba);
  const sample = (uv: Point, ch: number) => {
    const x = Math.max(0, Math.min(w - 1, uv[0] * w - 0.5)), y = Math.max(0, Math.min(h - 1, uv[1] * h - 0.5));
    const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1), tx = x - x0, ty = y - y0;
    const at = (xx: number, yy: number) => source[(yy * w + xx) * 4 + ch]!;
    return (at(x0, y0) * (1 - tx) + at(x1, y0) * tx) * (1 - ty) + (at(x0, y1) * (1 - tx) + at(x1, y1) * tx) * ty;
  };
  const pixels: { i: number; uv: Point; u: number; v: number }[] = [];
  const x0 = Math.max(0, Math.floor(Math.min(...target.map(p => p[0])) * w)), x1 = Math.min(w - 1, Math.ceil(Math.max(...target.map(p => p[0])) * w));
  const y0 = Math.max(0, Math.floor(Math.min(...target.map(p => p[1])) * h)), y1 = Math.min(h - 1, Math.ceil(Math.max(...target.map(p => p[1])) * h));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const [u, v] = inverse(target, (x + 0.5) / w, (y + 0.5) / h);
    if (u < 0 || u > 1 || v < 0 || v > 1) continue;
    pixels.push({ i: y * w + x, uv: point(donor, u, v), u, v });
  }
  // The target's top storey is intact; the photographed crown is on its lower storey. Matching facade
  // observations include windows and pilasters, so a flat plaster fill cannot pass this fit by construction.
  const context = pixels.filter(p => p.v >= 0.62 && p.v <= 0.94 && p.u >= 0.03 && p.u <= 0.97);
  const gain = [1, 1, 1], bias = [0, 0, 0];
  const error = (p: typeof pixels[number]) => [0, 1, 2].reduce((s, ch) => s + Math.abs(source[p.i * 4 + ch]! - (sample(p.uv, ch) * gain[ch]! + bias[ch]!)), 0) / 3;
  const quantile = (values: number[], q: number) => values.sort((a, b) => a - b)[Math.floor((values.length - 1) * q)]!;
  const luma = (p: typeof pixels[number], fromDonor: boolean) => [0.299, 0.587, 0.114].reduce((s, weight, ch) => s + weight * (fromDonor ? sample(p.uv, ch) : source[p.i * 4 + ch]!), 0);
  const sourceLow = quantile(context.map(p => luma(p, true)), 0.3), sourceHigh = quantile(context.map(p => luma(p, true)), 0.7);
  const targetLow = quantile(context.map(p => luma(p, false)), 0.3), targetHigh = quantile(context.map(p => luma(p, false)), 0.7);
  // Direct sun casts shadows onto the donor pilasters which do not exist in the target's diffuse shade.
  // Fit only corresponding dark window and bright plaster samples; arbitrary per-pixel regression would
  // flatten the architecture because those cast-shadow boundaries are not the same surface feature.
  const windows = context.filter(p => luma(p, true) <= sourceLow && luma(p, false) <= targetLow);
  const plaster = context.filter(p => luma(p, true) >= sourceHigh && luma(p, false) >= targetHigh);
  if (windows.length < 100 || plaster.length < 100) throw new Error('curated facade lacks matched window/plaster illumination samples');
  for (let ch = 0; ch < 3; ch++) {
    const loSource = quantile(windows.map(p => sample(p.uv, ch)), 0.5), hiSource = quantile(plaster.map(p => sample(p.uv, ch)), 0.5);
    const loTarget = quantile(windows.map(p => source[p.i * 4 + ch]!), 0.5), hiTarget = quantile(plaster.map(p => source[p.i * 4 + ch]!), 0.5);
    gain[ch] = (hiTarget - loTarget) / (hiSource - loSource); bias[ch] = loTarget - gain[ch]! * loSource;
    if (gain[ch]! < 0.2 || gain[ch]! > 1.6 || Math.abs(bias[ch]!) > 80) throw new Error(`curated facade illumination fit is not plausible: channel${ch} gain${gain[ch]} bias${bias[ch]}`);
  }
  const meanError = context.reduce((sum, p) => sum + error(p), 0) / context.length;
  let changed = 0;
  for (const p of pixels) {
    // The crown tip reaches v~.56. Retain all clean upper architecture above .59 exactly; the narrow
    // .57..59 transition avoids an exposure seam without touching the source upper-window tops/cornice.
    if (p.v >= 0.59) continue;
    const t = Math.max(0, Math.min(1, (0.59 - p.v) / 0.02)), alpha = t * t * (3 - 2 * t);
    for (let ch = 0; ch < 3; ch++) rgba[p.i * 4 + ch] = Math.max(0, Math.min(255, Math.round((sample(p.uv, ch) * gain[ch]! + bias[ch]!) * alpha + source[p.i * 4 + ch]! * (1 - alpha))));
    changed++;
  }
  return { method: 'curated lower five-bay elevation, bilinear quad reprojection and matched window/plaster illumination anchors', targetAddress: 'University main building northeast wing, Yliopistonkatu2 / Unioninkatu', donor, target,
    changedTexels: changed, gain, bias, cleanContextSamples: windows.length + plaster.length, cleanContextMeanAbsoluteError: meanError, retainedUpperHeightFraction: 0.41,
    limits: 'Uses the same building opposite-wing architecture as a documented lower-storey reconstruction; hidden pixels are not recovered. The upper41% remains exactly original. Geometry/UVs/five-bay width/floor-height mapping fixed; donor cast-shadow pattern may differ. No external reference pixels.' };
}
