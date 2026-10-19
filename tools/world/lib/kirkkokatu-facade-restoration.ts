import type { FacadeRestorationEvidence, FacadeRestorationModule, FacadeSourceImage } from './facade-restoration-types.ts';

export const KIRKKOKATU_PAGE = 52;
export const KIRKKOKATU_MASTER_SHA256 = 'dbbdbf2671d32505899cdde28fe406cf9aa93598a787923358780150c6a5a562';
type Point = readonly [number, number];
type Quad = readonly [Point, Point, Point, Point];
// VTJ103027182F, north street wall. Actual source vertices, image UVs, west-bottom clockwise.
export const KIRKKOKATU_NORTH_QUAD: Quad = [[0.020588811486959457, 0.0011060237884521484], [0.7160789370536804, 0.0009765625], [0.7017055749893188, 0.23967128992080688], [0.0009765625, 0.23967128992080688]];
export const KIRKKOKATU_EAST_QUAD: Quad = [[0.611328125, 0.923556387424469], [0.6113446354866028, 0.27654337882995605], [0.8492034077644348, 0.2421875], [0.8514975905418396, 0.8938674926757812]];
export const KIRKKOKATU_NORTH_AXES = [0.080, 0.209, 0.297, 0.385, 0.473, 0.561, 0.649, 0.737, 0.866, 0.916] as const;
const BODY_TOP = 0.94, PAIRED_START = 0.803;
const DONOR_AXIS = 0.510;
// The north's paired eastern end is its own architectural group. The matching clean east end
// contains both frames and their common surround; do not replace it with two isolated single bays.
export const KIRKKOKATU_PAIRED_DONOR = { targetAxes: [0.866, 0.916], sourceAxes: [0.851, 0.911], top: 0.65 } as const;
const HORIZONTAL_METRES_RATIO = Math.hypot(32.278, 1.952) / Math.hypot(29.781, 1.676);
// Equal base height1.686079m. East's interpolated top at this donor is17.421109m; north top17.350m.
const VERTICAL_METRES_RATIO = (17.350 - 1.686079) / (17.421109 - 1.686079);
function mirroredPlasterOffset(offset: number, start: number, span: number): number {
  if (offset <= start) return offset;
  const phase = ((offset - start) / span) % 2;
  return start + span * (phase <= 1 ? phase : 2 - phase);
}

// The real source wall is two affine UV triangles, not an interpolated rectangular atlas crop.
function uvPoint(q: Quad, u: number, v: number): Point {
  return u + v >= 1
    ? [q[3][0] * (1 - u) + q[2][0] * (u + v - 1) + q[1][0] * (1 - v), q[3][1] * (1 - u) + q[2][1] * (u + v - 1) + q[1][1] * (1 - v)]
    : [q[3][0] * v + q[1][0] * u + q[0][0] * (1 - u - v), q[3][1] * v + q[1][1] * u + q[0][1] * (1 - u - v)];
}
function barycentric(p: Point, a: Point, b: Point, c: Point): readonly [number, number, number] | null {
  const det = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
  if (Math.abs(det) < 1e-12) throw new Error('Kirkkokatu facade source triangle is degenerate');
  const u = ((b[1] - c[1]) * (p[0] - c[0]) + (c[0] - b[0]) * (p[1] - c[1])) / det;
  const v = ((c[1] - a[1]) * (p[0] - c[0]) + (a[0] - c[0]) * (p[1] - c[1])) / det;
  return u >= 0 && v >= 0 && u + v <= 1 ? [u, v, 1 - u - v] : null;
}
function physicalPoint(p: Point): Point | null {
  const q = KIRKKOKATU_NORTH_QUAD, top = barycentric(p, q[3], q[2], q[1]);
  if (top) return [top[1] + top[2], top[0] + top[1]];
  const bottom = barycentric(p, q[3], q[1], q[0]);
  return bottom ? [bottom[1], bottom[0]] : null;
}
function sample(image: FacadeSourceImage, quad: Quad, u: number, v: number, ch: number): number {
  const p = uvPoint(quad, u, v), x = Math.max(0, Math.min(image.width - 1, p[0] * image.width - 0.5)), y = Math.max(0, Math.min(image.height - 1, p[1] * image.height - 0.5));
  const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(image.width - 1, x0 + 1), y1 = Math.min(image.height - 1, y0 + 1), tx = x - x0, ty = y - y0;
  const at = (xx: number, yy: number) => image.data[(yy * image.width + xx) * 4 + ch]!;
  return (at(x0, y0) * (1 - tx) + at(x1, y0) * tx) * (1 - ty) + (at(x0, y1) * (1 - tx) + at(x1, y1) * tx) * ty;
}
function shadeFit(source: FacadeSourceImage): { gain: number[]; samples: number[] } {
  const ratios: number[][] = [[], [], []];
  // Original, crown-free north plaster between the central upper windows. Compare the homologous
  // east plaster beside the donor frame; window glazing never supplies a lighting anchor.
  for (const gap of [0.341, 0.429, 0.517, 0.605, 0.693]) for (let x = 0; x < 10; x++) for (let y = 0; y < 20; y++) {
    const northU = gap - 0.008 + x / 9 * 0.016, v = 0.73 + y / 19 * 0.15;
    const eastU = DONOR_AXIS + (x % 2 ? 1 : -1) * (0.034 + Math.floor(x / 2) / 4 * 0.006);
    for (let ch = 0; ch < 3; ch++) {
      const north = sample(source, KIRKKOKATU_NORTH_QUAD, northU, v, ch), east = sample(source, KIRKKOKATU_EAST_QUAD, eastU, v * VERTICAL_METRES_RATIO, ch);
      if (north > 25 && east > 100) ratios[ch]!.push(north / east);
    }
  }
  if (ratios.some(r => r.length < 200)) throw new Error('Kirkkokatu north shade lacks enough clean plaster anchors');
  const gain = ratios.map(r => r.sort((a, b) => a - b)[Math.floor(r.length / 2)]!);
  if (gain.some(g => g < 0.15 || g > 1.2)) throw new Error('Kirkkokatu north shade is outside source-bound range');
  return { gain, samples: ratios.map(r => r.length) };
}

export const kirkkokatuRestoration: FacadeRestorationModule = {
  id: 'kirkkokatu16-north-street-wall', targetPages: [KIRKKOKATU_PAGE], sourcePages: [KIRKKOKATU_PAGE],
  apply(page, rgba, width, height, sources): FacadeRestorationEvidence[] {
    if (page !== KIRKKOKATU_PAGE) return [];
    const source = sources.get(KIRKKOKATU_PAGE);
    if (!source || source.pngSha256 !== KIRKKOKATU_MASTER_SHA256) throw new Error('Kirkkokatu page52 master changed; curated wall mapping requires review');
    if (source.width !== 1024 || source.height !== 1024 || source.data.length !== 1024 * 1024 * 4 || width < 128 || height < 128 || rgba.length !== width * height * 4) throw new Error('Kirkkokatu facade image dimensions invalid');
    const { gain, samples } = shadeFit(source);
    let changedTexels = 0;
    const q = KIRKKOKATU_NORTH_QUAD, x0 = Math.floor(Math.min(...q.map(p => p[0])) * width), x1 = Math.ceil(Math.max(...q.map(p => p[0])) * width), y0 = Math.floor(Math.min(...q.map(p => p[1])) * height), y1 = Math.ceil(Math.max(...q.map(p => p[1])) * height);
    for (let y = Math.max(0, y0); y <= Math.min(height - 1, y1); y++) for (let x = Math.max(0, x0); x <= Math.min(width - 1, x1); x++) {
      const p = physicalPoint([(x + 0.5) / width, (y + 0.5) / height]);
      if (!p) continue;
      const [u, v] = p;
      if (v >= BODY_TOP) continue;
      const paired = u >= PAIRED_START;
      // Most of the upper rank is already clear. Only the photographed crown around axis2 reaches
      // it; retain the other seven original single upper windows instead of needlessly repeating them.
      const inUpperBay = u > 0.118 && u < 0.273;
      const repairTop = !paired && inUpperBay ? BODY_TOP : 0.65;
      if (v >= repairTop) continue;
      const axis = KIRKKOKATU_NORTH_AXES.slice(0, 8).reduce((nearest, axis) => Math.abs(axis - u) < Math.abs(nearest - u) ? axis : nearest);
      const delta = (u - axis) * HORIZONTAL_METRES_RATIO;
      // The original north photo is too dark to resolve the arch glazing reliably. The same building's
      // clear east central bay has the verified matching three-rank architecture: lower two arches and
      // rectangular top. Copy its full frame/glass profile at equal physical width and height, never
      // mirror a half across an uncertain apex. Only the finite blank plaster beyond the frame repeats.
      const pairedU = 0.881 + (u - 0.891) * 1.2;
      const pairedDonorU = paired
        ? (pairedU <= 0.963 ? pairedU : 0.963 - mirroredPlasterOffset(pairedU - 0.963, 0, 0.018))
        : DONOR_AXIS + Math.sign(delta) * mirroredPlasterOffset(Math.abs(delta), 0.030, 0.010);
      // Pedestrians touch only the east pair's lowest plinth in the source photograph. Its clear
      // central plinth has the same course heights and supplies this finite strip below the windows.
      const donorU = paired && v < 0.115 ? DONOR_AXIS : pairedDonorU;
      const upperEdge = v > 0.65 ? Math.min((u - 0.118) / 0.008, (0.273 - u) / 0.008) : 1;
      const edge = Math.min(1, (repairTop - v) / 0.008, upperEdge);
      const index = (y * width + x) * 4;
      let changed = false;
      for (let ch = 0; ch < 3; ch++) {
        const donor = Math.max(0, Math.min(255, sample(source, KIRKKOKATU_EAST_QUAD, donorU, v * VERTICAL_METRES_RATIO, ch) * gain[ch]!));
        const value = Math.round(rgba[index + ch]! * (1 - edge) + donor * edge);
        if (value !== rgba[index + ch]) changed = true;
        rgba[index + ch] = value;
      }
      if (changed) changedTexels++;
    }
    return [{ id: 'kirkkokatu16-north-matched-arch-bays', page, changedTexels, targetQuad: KIRKKOKATU_NORTH_QUAD,
      windowAxesWestToEast: KIRKKOKATU_NORTH_AXES, pairedEndDonor: KIRKKOKATU_PAIRED_DONOR, originalClearUpperWindowsRetained: true,
      donorQuad: KIRKKOKATU_EAST_QUAD, donorAxis: DONOR_AXIS, gain, illuminationAnchorSamples: samples,
      physicalScale: { horizontal: HORIZONTAL_METRES_RATIO, vertical: VERTICAL_METRES_RATIO },
      limits: 'Same-building reconstruction from the clean east central bay and homologous east paired end, whose lower arched glass heads match the north street reference. Retains ten north axis positions, the paired end architecture, cornice and clear original upper windows. The paired lower glass/plaster also contained photographed vegetation and is reconstructed as a whole pair. Whole window profiles and finite same-row plaster strips supply hidden detail; north shade is source-fitted. No external imagery or geometry changes; other page52 charts stay exact.' }];
  },
};
