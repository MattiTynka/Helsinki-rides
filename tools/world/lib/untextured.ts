// Untextured LoD2 surfaces (plan section 4.3, decision 0004): flat colours split by face slope. Triangles are in the
// runtime frame (Y up); walls and roofs get a solid tile in the facade atlas, undersides keep the city model's colour.
import type { RgbaImage } from './gltf.ts';

export interface SlopeSplit { wall: Uint32Array; roof: Uint32Array; under: Uint32Array }

/** Sorts triangles by the Y component of their unit normal: roof at or above `limit`, underside at or below
 *  `-limit`, wall in between. Degenerate triangles are dropped. Indices still refer to `positions`. */
export function splitBySlope(positions: ArrayLike<number>, indices: ArrayLike<number>, limit: number): SlopeSplit {
  const out = { wall: [] as number[], roof: [] as number[], under: [] as number[] };
  const P = positions;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t]! * 3, c = indices[t + 1]! * 3, d = indices[t + 2]! * 3;
    const ux = P[c]! - P[a]!, uy = P[c + 1]! - P[a + 1]!, uz = P[c + 2]! - P[a + 2]!, vx = P[d]! - P[a]!, vy = P[d + 1]! - P[a + 1]!, vz = P[d + 2]! - P[a + 2]!;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, len = Math.hypot(nx, ny, nz);
    if (len < 1e-9) continue;
    const up = ny / len;
    out[up >= limit ? 'roof' : up <= -limit ? 'under' : 'wall'].push(indices[t]!, indices[t + 1]!, indices[t + 2]!);
  }
  return { wall: Uint32Array.from(out.wall), roof: Uint32Array.from(out.roof), under: Uint32Array.from(out.under) };
}

/** A square tile of one 8-bit sRGB colour for the facade atlas. */
export function solidTile(rgb: readonly [number, number, number], size: number): RgbaImage {
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = rgb[0]; data[i + 1] = rgb[1]; data[i + 2] = rgb[2]; data[i + 3] = 255; }
  return { width: size, height: size, data };
}
