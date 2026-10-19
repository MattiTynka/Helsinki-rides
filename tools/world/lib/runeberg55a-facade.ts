// VTJ103219240W, Tykistönkatu side only. The Runeberginkatu balcony elevation is not a donor.
import type { FacadeRestorationModule, FacadeSourceImage } from './facade-restoration-types.ts';

type Point = readonly [number, number];
type Box = readonly [number, number, number, number];
export const RUNE_BERG55A_PAGE = 2624;
export const RUNE_BERG55A_MASTER_SHA256 = 'db1641b020f60e042c7b401f55fae61af01425befae65fb5381e3731ff916212';
// Physical west-bottom, east-bottom, east-top, west-top; native image coordinates (top-left origin).
export const RUNE_BERG55A_QUAD = [
  [0.9155318737030029, 0.8193762898445129], [0.7080078125, 0.8361493945121765],
  [0.7080078125, 0.4703453779220581], [0.9177349805831909, 0.455078125],
] as const;
export const RUNE_BERG55A_LAYOUT = {
  residentialStoreys: 5,
  ordinaryAxes: [0.467, 0.808],
  ordinaryWindowU: [[0.38, 0.555], [0.72, 0.90]],
  ordinaryRows: [[0.292, 0.357], [0.429, 0.494], [0.566, 0.633], [0.702, 0.770]],
  ordinaryBandCentres: [0.278, 0.415, 0.552, 0.689],
  wideWestU: [0, 0.285],
  wideRows: [[0.270, 0.333], [0.407, 0.470], [0.544, 0.607], [0.681, 0.744]],
  wideBandCentres: [0.261, 0.398, 0.535, 0.672],
  donorOrdinaryV: [0.843, 0.930],
  donorWideV: [0.814, 0.880],
  donorPlaster: [0.58, 0.68, 0.778, 0.808],
  donorOrdinaryBand: [0.58, 0.68, 0.821, 0.831],
  donorWideBand: [0.04, 0.25, 0.800, 0.811],
  protectedGroundTop: 0.255,
  protectedUpperBottom: 0.815,
  protectedEastStart: 0.965,
} as const;

const clamp = (v: number, low = 0, high = 1) => Math.max(low, Math.min(high, v));
const mirror = (v: number) => { const n = ((v % 2) + 2) % 2; return n < 1 ? n : 2 - n; };
function weights(p: Point, a: Point, b: Point, c: Point): readonly [number, number, number] | null {
  const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
  if (Math.abs(d) < 1e-12) throw new Error('Runeberg55a pinned chart is degenerate');
  const wa = ((b[1] - c[1]) * (p[0] - c[0]) + (c[0] - b[0]) * (p[1] - c[1])) / d;
  const wb = ((c[1] - a[1]) * (p[0] - c[0]) + (a[0] - c[0]) * (p[1] - c[1])) / d;
  return wa >= 0 && wb >= 0 && wa + wb <= 1 ? [wa, wb, 1 - wa - wb] : null;
}

/** Exact source part1 triangles5/6 (raw primitive1 triangles14/15), not their rectangular atlas bounds. */
export function runeberg55aPhysicalPoint(p: Point): Point | null {
  const q = RUNE_BERG55A_QUAD, east = weights(p, q[1], q[2], q[3]);
  if (east) return [east[0] + east[1], east[1] + east[2]];
  const west = weights(p, q[1], q[3], q[0]);
  return west ? [west[0], west[1]] : null;
}
export function runeberg55aUvPoint(u: number, v: number): Point {
  const q = RUNE_BERG55A_QUAD;
  return u + v >= 1
    ? [0, 1].map(k => q[1][k]! * (1 - v) + q[2][k]! * (u + v - 1) + q[3][k]! * (1 - u)) as unknown as Point
    : [0, 1].map(k => q[0][k]! * (1 - u - v) + q[1][k]! * u + q[3][k]! * v) as unknown as Point;
}
export function runeberg55aProtected(u: number, v: number): boolean {
  const a = RUNE_BERG55A_LAYOUT;
  if (v <= a.protectedGroundTop || v >= a.protectedUpperBottom || u >= a.protectedEastStart) return true;
  if (u >= 0.41 && u <= 0.52 && v >= 0.727 && v <= 0.754) return true;
  // These eastern window cores are visible and clean in the immutable target photograph.
  return u >= 0.755 && u <= 0.865 && a.ordinaryRows.some(([low, high]) => v >= low + 0.012 && v <= high - 0.012);
}

function sample(source: FacadeSourceImage, u: number, v: number): number[] {
  const p = runeberg55aUvPoint(u, v), x = clamp(p[0] * source.width - 0.5, 0, source.width - 1), y = clamp(p[1] * source.height - 0.5, 0, source.height - 1);
  const x0 = Math.floor(x), y0 = Math.floor(y), tx = x - x0, ty = y - y0;
  const at = (xx: number, yy: number, c: number) => source.data[(yy * source.width + xx) * 4 + c]!;
  return [0, 1, 2].map(c => (at(x0, y0, c) * (1 - tx) + at(Math.min(source.width - 1, x0 + 1), y0, c) * tx) * (1 - ty)
    + (at(x0, Math.min(source.height - 1, y0 + 1), c) * (1 - tx) + at(Math.min(source.width - 1, x0 + 1), Math.min(source.height - 1, y0 + 1), c) * tx) * ty);
}
function patch(source: FacadeSourceImage, box: Box, u: number, v: number): number[] {
  return sample(source, box[0] + clamp(u) * (box[1] - box[0]), box[2] + clamp(v) * (box[3] - box[2]));
}
function shade(source: FacadeSourceImage, v: number): number[] {
  // Clear plaster beside the eastern window column supplies this same elevation's height-dependent light.
  const heights = [0.26, 0.385, 0.52, 0.655, 0.79], base = sample(source, 0.63, 0.795);
  const next = heights.findIndex(h => h > v), k = next < 0 ? heights.length - 2 : Math.max(0, next - 1);
  const low = heights[k]!, high = heights[k + 1]!, t = clamp((v - low) / (high - low));
  const a = sample(source, 0.945, low), b = sample(source, 0.945, high);
  return base.map((c, i) => clamp((a[i]! * (1 - t) + b[i]! * t) / Math.max(1, c), 0.65, 1.15));
}

/** Named architecture only. No green mask, automatic erasure, external photo pixels or balcony repetition. */
export function runeberg55aPixel(u: number, v: number, source: FacadeSourceImage): { rgb: number[]; role: string } | null {
  if (u < 0 || u > 1 || v < 0 || v > 1 || runeberg55aProtected(u, v)) return null;
  const a = RUNE_BERG55A_LAYOUT;
  if (u <= a.wideWestU[1]) {
    for (const [low, high] of a.wideRows) if (v >= low && v <= high) {
      return { rgb: patch(source, [0, a.wideWestU[1], ...a.donorWideV], u / a.wideWestU[1], (v - low) / (high - low)), role: 'wide-west-window-return' };
    }
    for (const centre of a.wideBandCentres) if (Math.abs(v - centre) <= 0.005) {
      return { rgb: patch(source, a.donorWideBand, mirror(u * 8), (v - centre + 0.005) / 0.01), role: 'wide-return-sill-band' };
    }
  } else {
    for (const [low, high] of a.ordinaryRows) if (v >= low && v <= high) {
      for (const [column, [left, right]] of a.ordinaryWindowU.entries()) if (u >= left && u <= right) {
        return { rgb: patch(source, [left, right, ...a.donorOrdinaryV], (u - left) / (right - left), (v - low) / (high - low)), role: `ordinary-window-column${column + 1}` };
      }
    }
    for (const centre of a.ordinaryBandCentres) if (Math.abs(v - centre) <= 0.005) {
      return { rgb: patch(source, a.donorOrdinaryBand, mirror(u * 8), (v - centre + 0.005) / 0.01), role: 'ordinary-sill-band' };
    }
  }
  const light = shade(source, v), rgb = patch(source, a.donorPlaster, mirror(u * 8.3 + v * 0.25), mirror(v * 14 + u * 0.07));
  return { rgb: rgb.map((c, k) => c * light[k]!), role: 'same-face-plaster' };
}

export const runeberg55aRestoration: FacadeRestorationModule = {
  id: 'runeberg55a-tykistonkatu-tree-restoration', targetPages: [RUNE_BERG55A_PAGE], sourcePages: [RUNE_BERG55A_PAGE],
  apply(page, rgba, width, height, sources) {
    if (page !== RUNE_BERG55A_PAGE) return [];
    const source = sources.get(page);
    if (!source || source.pngSha256 !== RUNE_BERG55A_MASTER_SHA256 || source.width !== 1024 || source.height !== 1024 || source.data.length !== 1024 * 1024 * 4) throw new Error('Runeberg55a source master changed; review pinned Tykistonkatu mapping');
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 128 || height < 128 || width !== height || rgba.length !== width * height * 4) throw new Error('Runeberg55a target dimensions invalid');
    let changedTexels = 0, protectedTexels = 0;
    const roles: Record<string, number> = {};
    const q = RUNE_BERG55A_QUAD, minX = Math.max(0, Math.floor(Math.min(...q.map(p => p[0])) * width)), maxX = Math.min(width, Math.ceil(Math.max(...q.map(p => p[0])) * width));
    const minY = Math.max(0, Math.floor(Math.min(...q.map(p => p[1])) * height)), maxY = Math.min(height, Math.ceil(Math.max(...q.map(p => p[1])) * height));
    for (let y = minY; y < maxY; y++) for (let x = minX; x < maxX; x++) {
      const p = runeberg55aPhysicalPoint([(x + 0.5) / width, (y + 0.5) / height]); if (!p) continue;
      const pixel = runeberg55aPixel(...p, source); if (!pixel) { protectedTexels++; continue; }
      // A narrow same-face blend avoids a cut at the retained upper row, ground opening and chart returns.
      const blend = clamp(Math.min((p[1] - 0.255) / 0.012, (0.815 - p[1]) / 0.012, p[0] / 0.008, (0.965 - p[0]) / 0.008));
      const index = (y * width + x) * 4; let changed = false;
      for (let c = 0; c < 3; c++) { const next = Math.round(clamp(rgba[index + c]! * (1 - blend) + pixel.rgb[c]! * blend, 0, 255)); if (next !== rgba[index + c]) changed = true; rgba[index + c] = next; }
      if (changed) { changedTexels++; roles[pixel.role] = (roles[pixel.role] ?? 0) + 1; }
    }
    return [{ id: this.id, page, changedTexels, protectedTexels, roles, ordinaryWindowAxes: RUNE_BERG55A_LAYOUT.ordinaryAxes, residentialStoreys: 5,
      limits: 'Exact VTJ103219240W Tykistonkatu part1 triangles5/6 only. Four foliage-obscured residential rows restored from the intact fifth row on the same face, with a distinct clipped wide west return and sill levels. Entire ground-floor chart v<=0.255 (uncertain left shopfront plus original right opening/canopy), intact upper row/cornice v>=0.815, clean eastern window cores, one clean left second-row curtain core and east junction retained. Baked foliage remains in the protected ground region; this is a residential-crown repair, not a claim of complete building cleanup. Reference: Helsinki City Museum hkm.335C42C2-031B-4BFD-A721-1158C9AD7668, Sari Schulman, CC BY4.0, visual reference only. Production pixels exclusively immutable licensed municipal source page2624; alpha/geometry/UVs unchanged.' }];
  },
};
