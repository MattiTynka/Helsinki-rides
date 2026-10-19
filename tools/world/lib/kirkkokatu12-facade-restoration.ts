import type { FacadeRestorationEvidence, FacadeRestorationModule, FacadeSourceImage } from './facade-restoration-types.ts';

type Point = readonly [number, number];
type Quad = readonly [Point, Point, Point, Point];
export const KIRKKOKATU12_TARGET_PAGE = 67;
export const KIRKKOKATU12_MASTER_SHA256 = 'e25e9fde5bbcaf74e93b0c016782d5506b6848848c68841cb7371bd05d741192';
export const KIRKKOKATU12_DONOR_SHA256 = 'd296aaf61c28a41d5d6bd125e1742dc8eee987f06a4ef9fbae397ca5d7399ea0';
// VTJ1030176245. Image UVs: physical west-bottom/east-bottom/east-top/west-top.
export const KIRKKOKATU12_NORTH_QUAD: Quad = [[0.9978744983673096, 0.8913155198097229], [0.041284509003162384, 0.9922807216644287], [0.002421480603516102, 0.10868239402770996], [0.9684590101242065, 0.007695019245147705]];
export const KIRKKOKATU12_REAR_QUAD: Quad = [[0.6376953125, 0.832576334476471], [0.6379071474075317, 0.020120561122894287], [0.9430810809135437, 0.0009765625], [0.9430810809135437, 0.8216087222099304]];
export const KIRKKOKATU12_ARCHITECTURE = { structuralBays: 7, portalBayFromWest: 1, ordinaryGroundPanes: ['narrow', 'large', 'large', 'large', 'narrow'], basementGrille: true } as const;
const DONOR_BAY = [0.413, 0.615] as const;
const PANE_EDGES = [0.065, 0.152, 0.384, 0.616, 0.848, 0.935] as const;
const WIDTH_METRES = Math.hypot(53.355, 3.064), HEIGHT_METRES = 20.3;
const mirror = (v: number) => { const p = ((v % 2) + 2) % 2; return p <= 1 ? p : 2 - p; };

// These actual source quads use the west-bottom/east-top diagonal. No rectangular atlas bounding-box writes.
function uvPoint(q: Quad, u: number, v: number): Point {
  return u >= v
    ? [q[0][0] * (1 - u) + q[1][0] * (u - v) + q[2][0] * v, q[0][1] * (1 - u) + q[1][1] * (u - v) + q[2][1] * v]
    : [q[0][0] * (1 - v) + q[2][0] * u + q[3][0] * (v - u), q[0][1] * (1 - v) + q[2][1] * u + q[3][1] * (v - u)];
}
function barycentric(p: Point, a: Point, b: Point, c: Point): readonly [number, number, number] | null {
  const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
  if (Math.abs(d) < 1e-12) throw new Error('Kirkkokatu12 source triangle is degenerate');
  const u = ((b[1] - c[1]) * (p[0] - c[0]) + (c[0] - b[0]) * (p[1] - c[1])) / d;
  const v = ((c[1] - a[1]) * (p[0] - c[0]) + (a[0] - c[0]) * (p[1] - c[1])) / d;
  return u >= 0 && v >= 0 && u + v <= 1 ? [u, v, 1 - u - v] : null;
}
function physicalPoint(p: Point): Point | null {
  const q = KIRKKOKATU12_NORTH_QUAD, bottom = barycentric(p, q[2], q[1], q[0]);
  if (bottom) return [bottom[0] + bottom[1], bottom[0]];
  const top = barycentric(p, q[2], q[0], q[3]);
  return top ? [top[0], top[0] + top[2]] : null;
}
function sample(image: FacadeSourceImage, quad: Quad, u: number, v: number, ch: number): number {
  const p = uvPoint(quad, u, v), x = Math.max(0, Math.min(image.width - 1, p[0] * image.width - 0.5)), y = Math.max(0, Math.min(image.height - 1, p[1] * image.height - 0.5));
  const x0 = Math.floor(x), y0 = Math.floor(y), tx = x - x0, ty = y - y0;
  const at = (xx: number, yy: number) => image.data[(yy * image.width + xx) * 4 + ch]!;
  return (at(x0, y0) * (1 - tx) + at(Math.min(image.width - 1, x0 + 1), y0) * tx) * (1 - ty)
    + (at(x0, Math.min(image.height - 1, y0 + 1)) * (1 - tx) + at(Math.min(image.width - 1, x0 + 1), Math.min(image.height - 1, y0 + 1)) * tx) * ty;
}
function shadeFit(north: FacadeSourceImage, rear: FacadeSourceImage): { gain: number[]; samples: number[] } {
  const ratios: number[][] = [[], [], []];
  for (const centre of [0.10, 0.20, 0.30, 0.40, 0.65, 0.75, 0.85]) for (let x = 0; x < 10; x++) for (let y = 0; y < 20; y++) {
    const u = centre - 0.01 + x / 9 * 0.02, v = 0.815 + y / 19 * 0.020, phase = u * 7 % 1;
    for (let ch = 0; ch < 3; ch++) {
      const n = sample(north, KIRKKOKATU12_NORTH_QUAD, u, v, ch), r = sample(rear, KIRKKOKATU12_REAR_QUAD, DONOR_BAY[0] + phase * (DONOR_BAY[1] - DONOR_BAY[0]), v, ch);
      if (n > 25 && r > 100) ratios[ch]!.push(n / r);
    }
  }
  if (ratios.some(r => r.length < 200)) throw new Error('Kirkkokatu12 north lacks enough clean concrete beam anchors');
  const gain = ratios.map(r => r.sort((a, b) => a - b)[Math.floor(r.length / 2)]!);
  if (gain.some(g => g < 0.15 || g > 1.2)) throw new Error('Kirkkokatu12 north shade is outside source-bound range');
  return { gain, samples: ratios.map(r => r.length) };
}
function jointCoverage(distance: number, footprint: number): number {
  const halfJoint = 0.01, halfPixel = footprint / 2;
  return Math.max(0, Math.min(halfJoint, distance + halfPixel) - Math.max(-halfJoint, distance - halfPixel)) / footprint;
}
function granite(rear: FacadeSourceImage, u: number, v: number, ch: number, footprint: number): number {
  // Complete same-building rear basement stone patch, clear of pipes, fences, and doors.
  const x = u * WIDTH_METRES, y = v * HEIGHT_METRES;
  const stone = sample(rear, KIRKKOKATU12_REAR_QUAD, 0.040 + 0.050 * mirror(x / 1.85), 0.045 + 0.095 * mirror(y / 1.93), ch);
  const course = y / 0.55, yy = y % 0.55, xx = ((x / 1.25 + (Math.floor(course) % 2 ? 0.5 : 0)) % 1) * 1.25;
  // A20mm joint is smaller than a native wall texel. Integrate its coverage rather than creating
  // sparse black dashes when the georeferenced UV chart crosses the pixel grid obliquely.
  const coverage = Math.max(jointCoverage(Math.min(yy, 0.55 - yy), footprint), jointCoverage(Math.min(xx, 1.25 - xx), footprint));
  return stone * (1 - 0.20 * coverage);
}
function groundPixel(rear: FacadeSourceImage, u: number, v: number, bay: number, phase: number, ch: number, footprint: number): number {
  const stone = granite(rear, u, v, ch, footprint), metal = sample(rear, KIRKKOKATU12_REAR_QUAD, 0.443, 0.282, ch) * 0.35;
  const glass = (a: number, b: number) => sample(rear, KIRKKOKATU12_REAR_QUAD, 0.447 + 0.048 * a, 0.250 + 0.060 * b, ch);
  if (bay === 0) {
    // Reference-verified western drive passage: authored opaque recess/gate; never turn it into a window.
    if (phase > 0.065 && phase < 0.740 && v < 0.335) {
      const gateBar = v < 0.18 && (((phase - 0.065) / 0.675 * 24) % 1 < 0.20 || Math.abs(v - 0.045) < 0.003 || Math.abs(v - 0.155) < 0.003);
      return gateBar ? metal * 1.7 : metal * 0.32;
    }
    if (phase > 0.760 && phase < 0.940 && v > 0.235 && v < 0.335) return (phase * 100 % 1 < 0.20) ? metal * 1.5 : metal * 0.40;
    return stone;
  }
  if (phase >= PANE_EDGES[0] && phase <= PANE_EDGES[5] && v >= 0.235 && v <= 0.322) {
    if (v < 0.240 || v > 0.317 || PANE_EDGES.some(edge => Math.abs(phase - edge) < 0.006)) return metal;
    const pane = Math.min(4, PANE_EDGES.findIndex(edge => edge > phase) - 1), a = PANE_EDGES[pane]!, b = PANE_EDGES[pane + 1]!;
    return glass((phase - a) / (b - a), (v - 0.235) / 0.087);
  }
  if (phase > 0.065 && phase < 0.935 && v > 0.105 && v < 0.165) {
    const bar = ((phase - 0.065) / 0.87 * 20) % 1 < 0.18 || v < 0.110 || v > 0.160;
    return bar ? metal : glass((phase - 0.065) / 0.87, (v - 0.105) / 0.060) * 0.72;
  }
  return stone;
}

export const kirkkokatu12Restoration: FacadeRestorationModule = {
  id: 'kirkkokatu12-north-street-wall', targetPages: [67], sourcePages: [62, 67],
  apply(page, rgba, width, height, sources): FacadeRestorationEvidence[] {
    if (page !== 67) return [];
    const north = sources.get(67), rear = sources.get(62);
    if (!north || !rear || north.pngSha256 !== KIRKKOKATU12_MASTER_SHA256 || rear.pngSha256 !== KIRKKOKATU12_DONOR_SHA256) throw new Error('Kirkkokatu12 source masters changed; curated restoration requires review');
    if (north.width !== 1024 || north.height !== 256 || north.data.length !== 1024 * 256 * 4 || rear.width !== 1024 || rear.height !== 1024 || rear.data.length !== 1024 * 1024 * 4 || width < 128 || height < 128 || rgba.length !== width * height * 4) throw new Error('Kirkkokatu12 image dimensions invalid');
    const { gain, samples } = shadeFit(north, rear);
    let changedTexels = 0;
    const footprint = Math.max(WIDTH_METRES / width, HEIGHT_METRES / height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const p = physicalPoint([(x + 0.5) / width, (y + 0.5) / height]);
      if (!p) continue;
      const [u, v] = p, bay = Math.min(6, Math.floor(u * 7)), phase = Math.min(1, u * 7 - bay), index = (y * width + x) * 4;
      let changed = false;
      for (let ch = 0; ch < 3; ch++) {
        const body = v < 0.34 ? groundPixel(rear, u, v, bay, phase, ch, footprint) : sample(rear, KIRKKOKATU12_REAR_QUAD, DONOR_BAY[0] + phase * (DONOR_BAY[1] - DONOR_BAY[0]), v, ch);
        const value = Math.round(Math.max(0, Math.min(255, body * gain[ch]!)));
        if (value !== rgba[index + ch]) changed = true;
        rgba[index + ch] = value;
      }
      if (changed) changedTexels++;
    }
    return [{ id: 'kirkkokatu12-seven-bay-north-with-western-passage', page, changedTexels, targetQuad: KIRKKOKATU12_NORTH_QUAD, donorQuad: KIRKKOKATU12_REAR_QUAD,
      architecture: KIRKKOKATU12_ARCHITECTURE, donorBay: DONOR_BAY, gain, illuminationAnchorSamples: samples, ordinaryGroundPaneEdges: PANE_EDGES,
      portal: { bayFromWest: 1, opaqueRecess: [0.065, 0.740, 0, 0.335], sideGrille: [0.760, 0.940, 0.235, 0.335], geometryUnchanged: true },
      limits: 'Only the licensed page67 north wall is reconstructed. Same-building clean rear grid supplies seven structural bays and upper ranks. Ground granite, three large plus two narrow panes, barred basement ribbon, and western gated drive passage are authored from same-building material/window pixels to match observed street architecture. Google is a visual reference only; no Google pixels, new doors, geometry/collision changes, or page64 party-wall edits.' }];
  },
};
