// Exact projection of the city's 3D Tiles into the runtime frame, as tools/world/convert_city_model.ts does it:
// ECEF to GRS80 geodetic, EPSG:3879 by Krüger's series, then runtime = (E − E0, h − H0, −(N − N0)). The tiles store
// N2000 heights as ellipsoidal heights, so h is used as N2000 directly. Browser-safe; runs in the live-cell worker.
import { geodeticToGk25, gk25ToGeodetic } from '@helsinki/world-schema';
import type { Origin } from '../contract.ts';

/** Grid square side in metres (LIVE_CELL_SIZE in @helsinki/sim). */
export const SQUARE = 128;
const DEG = Math.PI / 180;

export const IDENTITY: readonly number[] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Column-major 4×4 product a · b, summed in the tools' order so results match bit for bit. */
export function multiply4(a: readonly number[], b: readonly number[]): number[] {
  const r = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) for (let row = 0; row < 4; row++) for (let k = 0; k < 4; k++) r[c * 4 + row]! += a[k * 4 + row]! * b[c * 4 + k]!;
  return r;
}

/** Column-major 4×4 times the point (x, y, z). */
export function apply4(m: readonly number[], x: number, y: number, z: number): [number, number, number] {
  return [m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, m[2]! * x + m[6]! * y + m[10]! * z + m[14]!];
}

/** ECEF metres to geodetic latitude and longitude in degrees and ellipsoidal height, GRS80 (10 fixed iterations). */
export function ecefToGeodetic(x: number, y: number, z: number): [number, number, number] {
  const a = 6378137, f = 1 / 298.257222101, e2 = f * (2 - f), p = Math.hypot(x, y); // GRS80
  let lat = Math.atan2(z, p * (1 - e2)), h = 0;
  for (let i = 0; i < 10; i++) {
    const n = a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
    h = p / Math.cos(lat) - n;
    lat = Math.atan2(z, p * (1 - e2 * n / (n + h)));
  }
  return [lat * 180 / Math.PI, Math.atan2(y, x) * 180 / Math.PI, h];
}

/** ECEF metres to the runtime frame (X east, Y up, Z south) of `origin`. */
export function ecefToRuntime(origin: Origin, x: number, y: number, z: number): [number, number, number] {
  const [lat, lon, h] = ecefToGeodetic(x, y, z);
  const [e, n] = geodeticToGk25(lat, lon);
  return [e - origin[0], h - origin[2], -(n - origin[1])];
}

/** Runtime XZ to geodetic latitude and longitude in degrees. */
export function runtimeToGeodetic(origin: Origin, x: number, z: number): [number, number] {
  return gk25ToGeodetic(x + origin[0], origin[1] - z);
}

/** Geodetic bounds in radians, as a 3D Tiles region's first four numbers. */
export interface GeodeticBox { west: number; south: number; east: number; north: number }

/** The square [cx·128, +128] × [cz·128, +128] of runtime XZ grown by `pad` metres, bounded by its projected corners. */
export function squareGeodeticBox(cx: number, cz: number, origin: Origin, pad: number): GeodeticBox {
  const x0 = cx * SQUARE - pad, x1 = (cx + 1) * SQUARE + pad, z0 = cz * SQUARE - pad, z1 = (cz + 1) * SQUARE + pad;
  const corners = [runtimeToGeodetic(origin, x0, z0), runtimeToGeodetic(origin, x1, z0), runtimeToGeodetic(origin, x0, z1), runtimeToGeodetic(origin, x1, z1)];
  return {
    west: Math.min(...corners.map(c => c[1])) * DEG, south: Math.min(...corners.map(c => c[0])) * DEG,
    east: Math.max(...corners.map(c => c[1])) * DEG, north: Math.max(...corners.map(c => c[0])) * DEG,
  };
}
