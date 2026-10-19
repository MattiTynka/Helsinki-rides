// Curated side elevations of the National Library, licensed City of Helsinki LoD2 page28 only.
// The source UV elevation and the Library's 1957 side-elevation drawing (2011 RHS, PDF p18) agree:
// 12 Corinthian pilasters, 11 panels, rectangular windows only in panels4/6/8, and 3 clerestory lunettes.
// The front elevation has a different window pattern and is deliberately not used as a donor.
import type { FacadeRestorationEvidence, FacadeRestorationModule, FacadeSourceImage } from './facade-restoration-types.ts';

export const LIBRARY_PAGE = 28;
export const LIBRARY_MASTER_SHA256 = '855cb58302da8e2233cff2b519f191d6214a5e657c2b08a2e9fdb4887058d36e';
export const LIBRARY_SIDE_ARCHITECTURE = { pilasters: 12, panels: 11, windowPanels: [4, 6, 8], clerestoryWindows: 3 } as const;
type Point = readonly [number, number];
type Quad = readonly [Point, Point, Point, Point];
// Image UVs, physical west-bottom/east-bottom/east-top/west-top, from the actual page28 wall vertices.
export const LIBRARY_SOUTH_QUAD: Quad = [[0.6630996465682983, 0.0009765625], [0.0009765625, 0.0009765625], [0.009936599992215633, 0.2592724561691284], [0.6779460310935974, 0.2593921422958374]];
export const LIBRARY_NORTH_QUAD: Quad = [[0.02248765341937542, 0.26171875], [0.6605584621429443, 0.26171875], [0.6443849205970764, 0.5302639603614807], [0.0009765625, 0.5305005311965942]];
// The slight outer margins belong to the corner masonry; the 12 pilaster axes are regularly spaced inside it.
const FIRST_PILASTER = 0.0215, LAST_PILASTER = 0.9815;
const PANEL = (LAST_PILASTER - FIRST_PILASTER) / 11;
const KEEP_UPPER = 0.82;
const PLINTH_TOP = 0.155;
const BLEND = 0.005;

const point = (quad: Quad, u: number, v: number): Point => [0, 1].map(k => quad[0][k]! * (1 - u) * (1 - v) + quad[1][k]! * u * (1 - v) + quad[2][k]! * u * v + quad[3][k]! * (1 - u) * v) as unknown as Point;
function inverse(quad: Quad, x: number, y: number): Point {
  let u = 0.5, v = 0.5;
  for (let i = 0; i < 6; i++) {
    const p = point(quad, u, v), ex = p[0] - x, ey = p[1] - y;
    const du = [0, 1].map(k => (quad[1][k]! - quad[0][k]!) * (1 - v) + (quad[2][k]! - quad[3][k]!) * v);
    const dv = [0, 1].map(k => (quad[3][k]! - quad[0][k]!) * (1 - u) + (quad[2][k]! - quad[1][k]!) * u);
    const det = du[0]! * dv[1]! - du[1]! * dv[0]!;
    if (Math.abs(det) < 1e-12) throw new Error('Library facade UV quad is degenerate');
    u -= (ex * dv[1]! - ey * dv[0]!) / det;
    v -= (ey * du[0]! - ex * du[1]!) / det;
  }
  return [u, v];
}
function sample(image: Pick<FacadeSourceImage, 'data' | 'width' | 'height'>, uv: Point, channel: number): number {
  const x = Math.max(0, Math.min(image.width - 1, uv[0] * image.width - 0.5)), y = Math.max(0, Math.min(image.height - 1, uv[1] * image.height - 0.5));
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(image.width - 1, x0 + 1), y1 = Math.min(image.height - 1, y0 + 1), tx = x - x0, ty = y - y0;
  const at = (xx: number, yy: number) => image.data[(yy * image.width + xx) * 4 + channel]!;
  return (at(x0, y0) * (1 - tx) + at(x1, y0) * tx) * (1 - ty) + (at(x0, y1) * (1 - tx) + at(x1, y1) * tx) * ty;
}
function pixels(quad: Quad, width: number, height: number, visit: (index: number, u: number, v: number) => void): void {
  const x0 = Math.max(0, Math.floor(Math.min(...quad.map(p => p[0])) * width)), x1 = Math.min(width - 1, Math.ceil(Math.max(...quad.map(p => p[0])) * width));
  const y0 = Math.max(0, Math.floor(Math.min(...quad.map(p => p[1])) * height)), y1 = Math.min(height - 1, Math.ceil(Math.max(...quad.map(p => p[1])) * height));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const [u, v] = inverse(quad, (x + 0.5) / width, (y + 0.5) / height);
    if (u >= 0 && u <= 1 && v >= 0 && v <= 1) visit((y * width + x) * 4, u, v);
  }
}
function southDonor(u: number, v: number): { u: number; section: number } | null {
  if (v < PLINTH_TOP) {
    // Panel3 has the source's only complete foreground-free granite course. Repeat its stone at the
    // original height; do not retain photographed bushes/fence posts or stretch plaster into the base.
    const phase = ((u - FIRST_PILASTER) / PANEL % 1 + 1) % 1;
    return { u: FIRST_PILASTER + (2 + Math.max(0.06, Math.min(0.94, phase))) * PANEL, section: 0 };
  }
  if (v >= KEEP_UPPER) {
    // The crown just touches the otherwise clean corner of the entablature, beyond the last lunette.
    return u > 0.90 && v < 0.89 ? { u: FIRST_PILASTER + LAST_PILASTER - u, section: 4 } : null;
  }
  const panel = Math.floor((u - FIRST_PILASTER) / PANEL);
  if (panel === 4 || panel === 6) return { u: u - (panel - 2) * PANEL, section: 1 }; // blank panels5/7 <- blank panel3
  if (panel === 5 || panel === 7) return { u: u - (panel - 3) * PANEL, section: 2 }; // window panels6/8 <- window panel4
  if (panel >= 8) return { u: FIRST_PILASTER + LAST_PILASTER - u, section: 3 }; // three blank outer panels, west -> east
  return null;
}
function southPixel(source: FacadeSourceImage, u: number, v: number, channel: number): number {
  const donor = southDonor(u, v);
  if (!donor) return sample(source, point(LIBRARY_SOUTH_QUAD, u, v), channel);
  return sample(source, point(LIBRARY_SOUTH_QUAD, Math.max(0, Math.min(1, donor.u)), v), channel);
}
function median(values: number[]): number { values.sort((a, b) => a - b); return values[Math.floor(values.length / 2)]!; }

export const libraryRestoration: FacadeRestorationModule = {
  id: 'library-side-elevations', targetPages: [LIBRARY_PAGE], sourcePages: [LIBRARY_PAGE],
  apply(page, rgba, width, height, sources): FacadeRestorationEvidence[] {
    if (page !== LIBRARY_PAGE) return [];
    const source = sources.get(LIBRARY_PAGE);
    if (!source || source.pngSha256 !== LIBRARY_MASTER_SHA256) throw new Error('Library page28 master changed; curated facade mapping requires review');
    if (source.width !== 1024 || source.height !== 1024 || source.data.length !== source.width * source.height * 4 || rgba.length !== width * height * 4 || width < 128 || height < 128) throw new Error('Library facade image dimensions invalid');
    // Both short sides have the same 12-pilaster/3-window composition. Fit the south donor to the north's
    // unoccluded capital/entablature band; keep the entire original clerestory and upper band untouched.
    const ratios: number[][] = [[], [], []];
    for (let y = 0; y < 20; y++) for (let x = 0; x < 100; x++) {
      const u = 0.03 + x / 99 * 0.94, v = 0.74 + y / 19 * 0.07;
      for (let ch = 0; ch < 3; ch++) {
        const south = southPixel(source, u, v, ch), north = sample(source, point(LIBRARY_NORTH_QUAD, u, v), ch);
        if (south > 90 && north > 50) ratios[ch]!.push(north / south);
      }
    }
    if (ratios.some(r => r.length < 200)) throw new Error('Library north elevation lacks enough clean illumination anchors');
    const gain = ratios.map(r => median(r));
    if (gain.some(g => g < 0.35 || g > 1.4)) throw new Error('Library north illumination fit is outside its source-bound range');
    // Validate the complete fit before changing either chart, so a changed source cannot produce a partial page.
    const counts = [0, 0, 0, 0, 0];
    pixels(LIBRARY_SOUTH_QUAD, width, height, (index, u, v) => {
      const donor = southDonor(u, v);
      if (!donor) return;
      const edge = donor.section === 4 ? Math.min(1, (u - 0.90) / BLEND, (0.89 - v) / BLEND)
        : donor.section === 0 ? Math.min(1, (PLINTH_TOP - v) / BLEND) : Math.min(1, (KEEP_UPPER - v) / BLEND);
      let changed = false;
      for (let ch = 0; ch < 3; ch++) {
        const value = Math.round(rgba[index + ch]! * (1 - edge) + southPixel(source, u, v, ch) * edge);
        if (value !== rgba[index + ch]) changed = true;
        rgba[index + ch] = value;
      }
      if (changed) counts[donor.section]!++;
    });
    let northCount = 0;
    pixels(LIBRARY_NORTH_QUAD, width, height, (index, u, v) => {
      if (v >= KEEP_UPPER) return;
      const edge = Math.min(1, (KEEP_UPPER - v) / BLEND);
      let changed = false;
      for (let ch = 0; ch < 3; ch++) {
        const donor = Math.max(0, Math.min(255, southPixel(source, u, v, ch) * gain[ch]!));
        const value = Math.round(rgba[index + ch]! * (1 - edge) + donor * edge);
        if (value !== rgba[index + ch]) changed = true;
        rgba[index + ch] = value;
      }
      if (changed) northCount++;
    });
    return [{ id: 'library-south-same-elevation-bays', page, changedTexels: counts.reduce((a, b) => a + b, 0), sections: counts,
      southQuad: LIBRARY_SOUTH_QUAD, architecture: LIBRARY_SIDE_ARCHITECTURE,
      donorPlan: 'blank panels5/7 from panel3; window panels6/8 from panel4; outer blank panels9-11 from mirrored panels3-1; granite base from complete panel3 course; far entablature corner from opposite end',
      retainedUpperHeightFraction: 1 - KEEP_UPPER,
      limits: 'Source-bound reconstruction from the same south side, preserving the three central window axes and blank end panels. The clean stone course replaces photographed foreground shrubs/posts, and clean bays replace the baked tree shadow. Hidden pixels are reconstructed, not recovered. Original source grade and geometry remain unchanged.' },
    { id: 'library-north-homologous-side', page, changedTexels: northCount, donorQuad: LIBRARY_SOUTH_QUAD, targetQuad: LIBRARY_NORTH_QUAD,
      gain, illuminationAnchorSamples: ratios.map(r => r.length), architecture: LIBRARY_SIDE_ARCHITECTURE, retainedUpperHeightFraction: 1 - KEEP_UPPER,
      limits: 'The matching 12-pilaster/3-window side elevation supplies the lower north facade; clean upper capitals anchor its shade. The original north clerestory band stays untouched. No front-elevation windows, external imagery or geometry changes.' }];
  },
};
