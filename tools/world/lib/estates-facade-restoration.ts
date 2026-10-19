// House of the Estates: exact-building CC BY 4.0 photographs, projected through original wall UVs.
// The original Helsinki masters are completely scaffold wrapped, so there is no native clean donor.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { FacadeRestorationModule, FacadeRestorationEvidence, FacadeExternalSources, FacadeExternalSourceImage } from './facade-restoration-types.ts';

type Point = readonly [number, number];
type Vec3 = readonly [number, number, number];
interface Wall { page: number; normal: Vec3; bounds: { min: Vec3; max: Vec3 }; triangles: { positions: [Vec3, Vec3, Vec3]; uvs: [Point, Point, Point] }[] }
const assets = new URL('../../../content/assets/facades/estates/', import.meta.url);
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export const ESTATES_INPUTS = {
  'wall-mapping.json': 'a42fb15c6e0fac14a78040f706d20876f27552698e10642aa5bb9f0735d90ffa',
  'front-2021.jpg': 'de916b7a4ab9b909845e926e63fa72ebdd2ebf8ab11934c8e73f6bd405e004b0',
  'park-2022.jpg': '389cc0a3cea129acd9974409747bfdbc7ab37649b237e33ee8905cafe5c4298e',
} as const;
const masterHashes = new Map([[55, '627bcedf4eebdd268e8d188a26af9404150f1dfc35a676991654b60cca528605'], [56, '60390bd3805cdb5aebc1294e039388928a02d0b56cc209ad4775946071f0070e'], [58, '87015bd2a771c57e4ae59c337844304fa028d1fab3a1f5899f1157639c85904d']]);
function input(name: keyof typeof ESTATES_INPUTS): Buffer { const bytes = readFileSync(new URL(name, assets)); if (sha(bytes) !== ESTATES_INPUTS[name]) throw new Error(`Estates input changed: ${name}`); return bytes; }
const walls = (JSON.parse(input('wall-mapping.json').toString()) as { walls: Wall[] }).walls;
const W = 1824;
interface Donors { front: FacadeExternalSourceImage; park: FacadeExternalSourceImage }
function donorsFrom(sources?: FacadeExternalSources): Donors {
  const front = sources?.get('estates-front-2021'), park = sources?.get('estates-park-2022');
  if (front?.sha256 !== ESTATES_INPUTS['front-2021.jpg'] || park?.sha256 !== ESTATES_INPUTS['park-2022.jpg']) throw new Error('Estates external donor missing or changed');
  for (const image of [front, park]) if (image.data.length !== image.width * image.height * 4 || image.width < 1000) throw new Error('Estates donor dimensions invalid');
  return { front, park };
}
const clamp = (x: number, min: number, max: number) => Math.max(min, Math.min(max, x));
function sample(image: FacadeExternalSourceImage, x: number, y: number, ch: number): number {
  const {data, width, height: imageHeight} = image;
  x = clamp(x * width / W, 0, width - 1); y = clamp(y * width / W, 0, imageHeight - 1);
  const a = Math.floor(x), b = Math.floor(y), tx = x - a, ty = y - b;
  const at = (xx: number, yy: number) => data[(Math.min(imageHeight - 1, yy) * width + Math.min(width - 1, xx)) * 4 + ch]!;
  return (at(a, b) * (1 - tx) + at(a + 1, b) * tx) * (1 - ty) + (at(a, b + 1) * (1 - tx) + at(a + 1, b + 1) * tx) * ty;
}
function frontSample(front: FacadeExternalSourceImage, x: number, y: number, ch: number): number {
  // Rectangular panel previews extend beyond the sloping photographic cornice. No sky is
  // allowed into the actual wall UV charts, including their uppermost sample centres.
  const roofY = x < 542 ? 483 - (x - 240) * .045 : x > 1284 ? 468 + (x - 1284) * .035 : 433 - Math.min(x - 542, 1284 - x) * .36;
  y = Math.max(y, roofY + 4);
  const perspective = clamp((y - 470) / 608, 0, 1);
  if (x < 542) x = Math.max(x, 270 - 44 * perspective);
  if (x > 1284) x = Math.min(x, 1558 + 45 * perspective);
  // The two independent lamps/flowerpots occlude the plain outer pilasters and column feet.
  // Retain the unique central coat of arms and all three doors. Match pilaster plaster vertically;
  // complete the outer fluted column/base from the adjacent clear column at the same elevation.
  if (y > 824 && y < 982 && ((x > 641 && x < 702) || (x > 1138 && x < 1195))) return sample(front, x, 735 + (y - 824) * .4, ch);
  if (y >= 982 && y < 1015 && x > 641 && x < 702) return sample(front, x + 160, y, ch);
  if (y >= 982 && y < 1015 && x > 1138 && x < 1195) return sample(front, x - 163, y, ch);
  if (y > 824 && y < 1070 && ((x > 555 && x <= 641) || (x >= 1195 && x < 1280))) {
    const left = x < 900;
    if (y < 982) return sample(front, x, 735 + (y - 824) * .40, ch);
    if (y < 1010) return sample(front, left ? 545 + (x - 555) % 18 : 1290 + (x - 1195) % 18, y, ch);
    return sample(front, left ? 740 + (x - 555) : 1000 + (x - 1195), y, ch);
  }
  if (y >= 1015 && y < 1050 && x > 630 && x < 702) return sample(front, x + 120, y, ch);
  if (y >= 1015 && y < 1050 && x > 1138 && x < 1200) return sample(front, x - 120, y, ch);
  const diagonalWireY = 645.5 - .244 * (x - 1450);
  if (x > 1460 && x < 1600 && Math.abs(y - diagonalWireY) < 2.8) return (sample(front, x, diagonalWireY - 5, ch) + sample(front, x, diagonalWireY + 5, ch)) / 2;
  // Two photographed tram wires cross otherwise clear architecture. Only the few wire pixels
  // interpolate their immediate vertical neighbours; window edges and decorative bands remain.
  for (const line of [[810, 0.015], [845, 0.006]] as const) {
    const wireY = line[0] + (x - 100) * line[1];
    if (Math.abs(y - wireY) < 2.5) return (sample(front, x, wireY - 4, ch) + sample(front, x, wireY + 4, ch)) / 2;
  }
  return sample(front, x, y, ch);
}

/** Source-space sample for the three west-facing planes. u runs from the north wing to the south. */
export function estatesFrontPixel(donors: Donors, north: number, height: number, ch: number, centralOverride?: boolean): number {
  // The oblique city axes are retained: north is the actual surveyed Y coordinate at this plane.
  // Each projecting plane has its own photo interval; merging them into one quad distorts the bays.
  const central = centralOverride ?? (north >= 180.15 && north <= 199.5);
  const top = central ? 21.14708 : 21.27608;
  const cornicePhoto = central ? 432 : 485;
  const anchors = [[1.02108, 1078], [7.5, 806], [16.4, 609], [19.0, 525], [top, cornicePhoto], [24.48008, 299]];
  let y = anchors[0]![1]!;
  for (let i = 1; i < anchors.length; i++) {
    const a = anchors[i - 1]!, b = anchors[i]!;
    if (height <= b[0]!) { y = a[1]! + (height - a[0]!) / (b[0]! - a[0]!) * (b[1]! - a[1]!); break; }
  }
  let x: number;
  const floorFraction = clamp((y - 470) / (1078 - 470), 0, 1);
  if (central) x = 542 + (199.428 - north) / (199.428 - 179.983) * 742;
  else if (north > 199.5) x = 542 - (north - 199.614) / (208.905 - 199.614) * (542 - (265 - 44 * floorFraction));
  else x = 1284 + (180.245 - north) / (180.245 - 170.789) * ((1562 + 45 * floorFraction) - 1284);
  return frontSample(donors.front, x, y, ch);
}

function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }
function band(value: number, anchors: readonly Point[]): number {
  if (value <= anchors[0]![0]) return anchors[0]![1];
  for (let i = 1; i < anchors.length; i++) {
    const a = anchors[i - 1]!, b = anchors[i]!;
    if (value <= b[0]) return lerp(a[1], b[1], (value - a[0]) / (b[0] - a[0]));
  }
  return anchors.at(-1)![1];
}

function clearWingBay(donors: Donors, u: number, y: number, ch: number): number {
  const read = (t: number) => {
    // The right front wing recedes in the photograph. Undo both its widening towards the
    // ground and the measured cornice slope before repeating a surveyed side-window axis.
    const across = .06 + t * .88;
    const px = 1284 + across * (278 + 45 * clamp((y - 470) / 608, 0, 1));
    return frontSample(donors.front, px, y - across * 5.6, ch);
  };
  const value = read(u);
  if (y < 610 || y > 800) return value;
  const left = read(.01), right = read(.99);
  return clamp(value + (left + right) / 2 - lerp(left, right, u), 0, 255);
}

/** Five bays are visible in the exact-building rear photo; retain the distinct rear arch shape. */
export function estatesRearPixel(donors: Donors, u: number, z: number, ch: number): number {
  const bay = clamp(u, 0, .999999) * 5 % 1;
  if (z < 2) return sample(donors.front, 1500 + bay * 35, band(z, [[1.021, 1095], [2, 1010]]), ch);
  if (z < 5.8) {
    // Fountain and fence cover the rear basement. Use the clear same-building wing basement,
    // retaining small arches rather than stretching the tall upper arches to ground level.
    return clearWingBay(donors, .1 + bay * .8, band(z, [[1.021, 1078], [2.0, 1009], [5.8, 821]]), ch);
  }
  if (z < 10.0) return sample(donors.park, 1080 + bay * 92, band(z, [[5.8, 753], [10, 626]]), ch);
  const y = band(z, [[10, 626], [16.9, 458], [19, 405], [21.76, 345]]);
  if (z > 19) return sample(donors.park, 900 + bay * 110, y, ch);
  // The fourth bay is clear of the tree on the left and the fountain below it.
  return sample(donors.park, 958 + bay * 109, y, ch);
}

/** Recessed side centre: three axes; the two projecting end bays are mapped separately. */
export function estatesSidePixel(donors: Donors, u: number, z: number, ch: number): number {
  const bay = clamp(u, 0, .999999) * 3 % 1;
  // The source also has a higher parapet over portions of this side. Give it an actual clean
  // cornice band; a clamped photographic top row would make visible vertical colour streaks.
  if (z > 21.1) return sample(donors.park, 900 + bay * 100, 385 - (z - 21.1) * 6, ch);
  if (z < 2) return sample(donors.front, 1500 + bay * 35, band(z, [[1.021, 1095], [2, 1010]]), ch);
  if (z < 5.8) return clearWingBay(donors, .1 + bay * .8, band(z, [[1.021, 1078], [2, 1009], [5.8, 821]]), ch);
  if (z < 10.0) {
    const windowU = (bay - .5) * 1.75 + .5;
    const photoX = windowU < 0 || windowU > 1 ? 1082 + (bay * 7 % 5) : 1080 + windowU * 92;
    return sample(donors.park, photoX, band(z, [[5.8, 753], [10, 626]]), ch);
  }
  const y = band(z, [[10, 810], [17.9, 608], [19.2, 558], [21.1, 485]]);
  return clearWingBay(donors, bay, y, ch);
}

function wallPixel(donors: Donors, wall: Wall, p: Vec3, ch: number): number {
  const [x, n, z] = p;
  if (wall.normal[0] < -.9 && wall.bounds.max[0] < 90) return estatesFrontPixel(donors, n, z, ch, wall.bounds.max[0] < 83);
  if (wall.bounds.min[2] > 20) {
    // Clerestory and parapet returns have no doors or full storey windows.
    return sample(donors.park, 900 + ((x + n) * 13 % 100), band(z - wall.bounds.min[2], [[0, 398], [2.5, 375], [5, 365]]), ch);
  }
  if (wall.normal[0] > .9 && x < 130 && n >= 184.15 && n <= 201.2) return estatesRearPixel(donors, (n - 184.159) / (201.190 - 184.159), z, ch);
  if (Math.abs(wall.normal[1]) > .9) {
    const south = wall.normal[1] < 0, start = south ? 102.764 : 99.77, end = south ? 120.010 : 117.04;
    if (x >= start && x <= end && (n < 174 || n > 208)) return estatesSidePixel(donors, (x - start) / (end - start), z, ch);
  }
  const horizontalAxis = Math.abs(wall.normal[0]) > .9 ? 1 : 0;
  const extent = wall.bounds.max[horizontalAxis] - wall.bounds.min[horizontalAxis];
  const u = clamp((p[horizontalAxis] - wall.bounds.min[horizontalAxis]) / Math.max(extent, .01), 0, 1);
  // The front photo's balustrade occupies rows1005–1078, which this corner mapping projects
  // onto z1.02–2.76 m. It belongs only to the west entrance. Use unobstructed same-building
  // stone below the first window on the side/rear corners and narrow return walls.
  if (z < 2.8) return sample(donors.front, 1500 + u * 35, band(z, [[1.021, 1095], [2.8, 1010]]), ch);
  const y = band(z, [[1.021, 1078], [7.5, 806], [16.4, 609], [19, 525], [21.27, 485], [23.5, 500]]);
  // Corner blocks show a single upper rectangle and lower arch. Narrow recess returns are
  // masonry only; inventing another full window on a 20 cm connector would repeat the defect.
  const photoX = extent < 4.5 ? 1500 + u * 48 : 1284 + u * 278;
  return frontSample(donors.front, photoX, y, ch);
}

function visitWall(wall: Wall, width: number, height: number, visit: (i: number, p: Vec3) => void): void {
  for (const tri of wall.triangles) {
    const p = tri.uvs.map(uv => [uv[0] * width, (1 - uv[1]) * height] as Point), [a, b, c] = p as [Point, Point, Point];
    const den = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    if (Math.abs(den) < 1e-10) continue;
    for (let y = Math.max(0, Math.floor(Math.min(...p.map(p => p[1])))); y < Math.min(height, Math.ceil(Math.max(...p.map(p => p[1])))); y++) {
      for (let x = Math.max(0, Math.floor(Math.min(...p.map(p => p[0])))); x < Math.min(width, Math.ceil(Math.max(...p.map(p => p[0])))); x++) {
        const u = ((b[1] - c[1]) * (x + .5 - c[0]) + (c[0] - b[0]) * (y + .5 - c[1])) / den;
        const v = ((c[1] - a[1]) * (x + .5 - c[0]) + (a[0] - c[0]) * (y + .5 - c[1])) / den;
        if (u < -1e-8 || v < -1e-8 || u + v > 1 + 1e-8) continue;
        const world = [0, 1, 2].map(k => tri.positions[0][k]! * u + tri.positions[1][k]! * v + tri.positions[2][k]! * (1 - u - v)) as unknown as Vec3;
        visit((y * width + x) * 4, world);
      }
    }
  }
}
export const estatesRestoration: FacadeRestorationModule = {
  id: 'estates-reference-architecture', targetPages: [55, 56, 58], sourcePages: [55, 56, 58],
  externalSources: [{id: 'estates-front-2021', file: 'content/assets/facades/estates/front-2021.jpg', sha256: ESTATES_INPUTS['front-2021.jpg']}, {id: 'estates-park-2022', file: 'content/assets/facades/estates/park-2022.jpg', sha256: ESTATES_INPUTS['park-2022.jpg']}],
  supportFiles: [{file: 'content/assets/facades/estates/wall-mapping.json', sha256: ESTATES_INPUTS['wall-mapping.json']}],
  apply(page, rgba, width, height, sources, externalSources): FacadeRestorationEvidence[] {
    if (!masterHashes.has(page)) return [];
    if (rgba.length !== width * height * 4 || width < 128 || height < 128) throw new Error('Estates target dimensions invalid');
    for (const [id, hash] of masterHashes) if (sources.get(id)?.pngSha256 !== hash) throw new Error(`Estates master page${id} changed`);
    const donors = donorsFrom(externalSources);
    const touched = new Set<number>();
    for (const wall of walls.filter(w => w.page === page)) {
      visitWall(wall, width, height, (i, p) => { for (let ch = 0; ch < 3; ch++) rgba[i + ch] = Math.round(wallPixel(donors, wall, p, ch)); touched.add(i); });
    }
    return [{ id: 'estates-licensed-architecture', page, changedTexels: touched.size, method: 'Exact-building CC BY 4.0 front/rear donors; original surveyed wall UV triangles; separate portico/corners, three-bay rectangular side centres and five-bay arched rear', inputs: ESTATES_INPUTS,
      limits: 'Photographic architecture reconstruction on existing planar walls, not new sculpted geometry. Lamps, pots, trees, fountain and fence excluded with same-building masonry/bay donors. Side hidden details use analogous clean same-building bays; rear basement uses clear wing arches. Original roof page57 preserved. Requires native close/oblique review before acceptance.' }];
  },
};
