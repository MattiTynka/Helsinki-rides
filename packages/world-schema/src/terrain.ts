// Terrain heightfield: runtime-frame grid of heights (metres above the origin height) sampled every `resolution`
// metres, row-major with x fastest. Heights come from the city terrain model, sampled as delivered
// (tools/world/build_terrain.ts, decision 0005). Binary: 'HTER', u32 version, f32 x0, f32 z0,
// f32 resolution, u32 nx, u32 nz, then nx*nz float32 heights.
export const HTER_MAGIC = 'HTER';
export const HTER_VERSION = 1;

export interface TerrainGrid {
  readonly x0: number;
  readonly z0: number;
  readonly resolution: number;
  readonly nx: number;
  readonly nz: number;
  readonly heights: Float32Array;
}

export function encodeTerrain(t: TerrainGrid): Uint8Array {
  if (t.heights.length !== t.nx * t.nz) throw new Error('terrain heights do not match nx*nz');
  const out = new Uint8Array(28 + t.heights.byteLength);
  const dv = new DataView(out.buffer);
  out.set(new TextEncoder().encode(HTER_MAGIC), 0);
  dv.setUint32(4, HTER_VERSION, true);
  dv.setFloat32(8, t.x0, true);
  dv.setFloat32(12, t.z0, true);
  dv.setFloat32(16, t.resolution, true);
  dv.setUint32(20, t.nx, true);
  dv.setUint32(24, t.nz, true);
  out.set(new Uint8Array(t.heights.buffer, t.heights.byteOffset, t.heights.byteLength), 28);
  return out;
}

export function parseTerrain(bytes: Uint8Array): TerrainGrid {
  if (new TextDecoder().decode(bytes.subarray(0, 4)) !== HTER_MAGIC) throw new Error('not an HTER terrain');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(4, true) !== HTER_VERSION) throw new Error('unsupported terrain version');
  const nx = dv.getUint32(20, true), nz = dv.getUint32(24, true);
  const heights = new Float32Array(nx * nz);
  // Copy so callers never depend on the fetch buffer's alignment.
  heights.set(new Float32Array(bytes.buffer.slice(bytes.byteOffset + 28, bytes.byteOffset + 28 + nx * nz * 4)));
  return { x0: dv.getFloat32(8, true), z0: dv.getFloat32(12, true), resolution: dv.getFloat32(16, true), nx, nz, heights };
}

/** Bilinear height at runtime XZ; outside the grid the nearest edge is used. */
export function sampleTerrain(t: TerrainGrid, x: number, z: number): number {
  const fx = Math.min(Math.max((x - t.x0) / t.resolution, 0), t.nx - 1);
  const fz = Math.min(Math.max((z - t.z0) / t.resolution, 0), t.nz - 1);
  const ix = Math.min(Math.floor(fx), t.nx - 2), iz = Math.min(Math.floor(fz), t.nz - 2);
  const tx = fx - ix, tz = fz - iz;
  const h = t.heights;
  const a = h[iz * t.nx + ix]!, b = h[iz * t.nx + ix + 1]!, c = h[(iz + 1) * t.nx + ix]!, d = h[(iz + 1) * t.nx + ix + 1]!;
  return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
}
