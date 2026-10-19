// Coordinate frames (plan section 2): ETRS-GK25 (EPSG:3879) and N2000 for every working file, a surveyed origin
// recorded in content/helsinki/world-origin.json, local metres in two frames:
//   working frame  (cell builder, Blender):  X east, Y north, Z up
//   runtime frame  (sim, renderer):         X east, Y up,    Z south  ->  runtime = (E - E0, H - H0, -(N - N0))
// The transverse Mercator mapping is Krüger's series in Karney's (2011) form to n^6, exact to well under a
// millimetre inside the Helsinki metropolitan area; EPSG:3879 is GK25: central meridian 25° E, scale 1,
// false easting 25 500 000 m, false northing 0, on the GRS80 ellipsoid.

export type Vec3 = [number, number, number];
export type Vec2 = [number, number];

export interface WorldOrigin {
  readonly id: string;
  readonly crs: 'EPSG:3879';
  readonly heightDatum: 'N2000';
  /** [E0, N0, H0] in EPSG:3879 metres and N2000 metres. */
  readonly originProjected: Vec3;
}

const A_GRS80 = 6378137;
const F_GRS80 = 1 / 298.257222101;
const GK25_LON0 = 25 * Math.PI / 180;
const GK25_FALSE_EASTING = 25_500_000;
const GK25_FALSE_NORTHING = 0;
const GK25_SCALE = 1;

const n = F_GRS80 / (2 - F_GRS80);
const n2 = n * n, n3 = n2 * n, n4 = n3 * n, n5 = n4 * n, n6 = n5 * n;
const A_RECT = A_GRS80 / (1 + n) * (1 + n2 / 4 + n4 / 64 + n6 / 256);
const ALPHA = [
  n / 2 - 2 * n2 / 3 + 5 * n3 / 16 + 41 * n4 / 180 - 127 * n5 / 288 + 7891 * n6 / 37800,
  13 * n2 / 48 - 3 * n3 / 5 + 557 * n4 / 1440 + 281 * n5 / 630 - 1983433 * n6 / 1935360,
  61 * n3 / 240 - 103 * n4 / 140 + 15061 * n5 / 26880 + 167603 * n6 / 181440,
  49561 * n4 / 161280 - 179 * n5 / 168 + 6601661 * n6 / 7257600,
  34729 * n5 / 80640 - 3418889 * n6 / 1995840,
  212378941 * n6 / 319334400,
];
const BETA = [
  n / 2 - 2 * n2 / 3 + 37 * n3 / 96 - n4 / 360 - 81 * n5 / 512 + 96199 * n6 / 604800,
  n2 / 48 + n3 / 15 - 437 * n4 / 1440 + 46 * n5 / 105 - 1118711 * n6 / 3870720,
  17 * n3 / 480 - 37 * n4 / 840 - 209 * n5 / 4480 + 5569 * n6 / 90720,
  4397 * n4 / 161280 - 11 * n5 / 504 - 830251 * n6 / 7257600,
  4583 * n5 / 161280 - 108847 * n6 / 3991680,
  20648693 * n6 / 638668800,
];
const DELTA = [
  2 * n - 2 * n2 / 3 - 2 * n3 + 116 * n4 / 45 + 26 * n5 / 45 - 2854 * n6 / 675,
  7 * n2 / 3 - 8 * n3 / 5 - 227 * n4 / 45 + 2704 * n5 / 315 + 2323 * n6 / 945,
  56 * n3 / 15 - 136 * n4 / 35 - 1262 * n5 / 105 + 73814 * n6 / 2835,
  4279 * n4 / 630 - 332 * n5 / 35 - 399572 * n6 / 14175,
  4174 * n5 / 315 - 144838 * n6 / 6237,
  601676 * n6 / 22275,
];
const E2N = 2 * Math.sqrt(n) / (1 + n);

/** Geodetic latitude and longitude in degrees (GRS80 / ETRS89) to EPSG:3879 easting and northing in metres. */
export function geodeticToGk25(latDeg: number, lonDeg: number): Vec2 {
  const phi = latDeg * Math.PI / 180;
  const lambda = lonDeg * Math.PI / 180 - GK25_LON0;
  const sinPhi = Math.sin(phi);
  const t = Math.sinh(Math.atanh(sinPhi) - E2N * Math.atanh(E2N * sinPhi));
  const xi0 = Math.atan2(t, Math.cos(lambda));
  const eta0 = Math.atanh(Math.sin(lambda) / Math.sqrt(1 + t * t));
  let xi = xi0, eta = eta0;
  for (let j = 1; j <= 6; j++) {
    const a = ALPHA[j - 1]!;
    xi += a * Math.sin(2 * j * xi0) * Math.cosh(2 * j * eta0);
    eta += a * Math.cos(2 * j * xi0) * Math.sinh(2 * j * eta0);
  }
  return [GK25_FALSE_EASTING + GK25_SCALE * A_RECT * eta, GK25_FALSE_NORTHING + GK25_SCALE * A_RECT * xi];
}

/** EPSG:3879 easting and northing in metres to geodetic latitude and longitude in degrees. */
export function gk25ToGeodetic(easting: number, northing: number): Vec2 {
  const eta = (easting - GK25_FALSE_EASTING) / (GK25_SCALE * A_RECT);
  const xi = (northing - GK25_FALSE_NORTHING) / (GK25_SCALE * A_RECT);
  let xi0 = xi, eta0 = eta;
  for (let j = 1; j <= 6; j++) {
    const b = BETA[j - 1]!;
    xi0 -= b * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    eta0 -= b * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  const chi = Math.asin(Math.sin(xi0) / Math.cosh(eta0));
  let phi = chi;
  for (let j = 1; j <= 6; j++) phi += DELTA[j - 1]! * Math.sin(2 * j * chi);
  const lambda = GK25_LON0 + Math.atan2(Math.sinh(eta0), Math.cos(xi0));
  return [phi * 180 / Math.PI, lambda * 180 / Math.PI];
}

/** Projected EPSG:3879 / N2000 point to runtime metres (X east, Y up, Z south). */
export function projectedToRuntime(origin: WorldOrigin, easting: number, northing: number, height: number): Vec3 {
  const [E0, N0, H0] = origin.originProjected;
  return [easting - E0, height - H0, -(northing - N0)];
}

/** Runtime metres back to EPSG:3879 / N2000. */
export function runtimeToProjected(origin: WorldOrigin, p: Vec3): Vec3 {
  const [E0, N0, H0] = origin.originProjected;
  return [p[0] + E0, N0 - p[2], p[1] + H0];
}

/** Working frame (east, north, up metres from the origin) to the runtime frame. */
export function enuToRuntime(p: Vec3): Vec3 {
  return [p[0], p[2], -p[1]];
}

/** Runtime frame to the working frame. */
export function runtimeToEnu(p: Vec3): Vec3 {
  return [p[0], -p[2], p[1]];
}

/**
 * Compass heading (degrees, 0 = north = -Z, 90 = east = +X) to a yaw about +Y for an asset whose local forward is +Z.
 * forward(yaw) = (sin yaw, 0, cos yaw) must equal (sin h, 0, -cos h), hence yaw = pi - h.
 */
export function yawForHeading(headingDeg: number): number {
  return Math.PI - headingDeg * Math.PI / 180;
}

/** Inverse of yawForHeading, normalised to [0, 360). */
export function headingForYaw(yaw: number): number {
  const h = (Math.PI - yaw) * 180 / Math.PI;
  return ((h % 360) + 360) % 360;
}

/** Runtime XZ to the 128 m cell that owns it (half-open ownership, floor handles negatives). */
export function cellIndexFor(x: number, z: number, cellSize: number): Vec2 {
  return [Math.floor(x / cellSize), Math.floor(z / cellSize)];
}

export function cellId(cx: number, cz: number): string {
  const f = (v: number) => (v < 0 ? 'm' : 'p') + String(Math.abs(v)).padStart(2, '0');
  return `c_${f(cx)}_${f(cz)}`;
}
