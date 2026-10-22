// Terrain heightfield: runtime-frame grid of heights (metres above the origin height) sampled every `resolution`
// metres, row-major with x fastest. Heights come from the city terrain model, sampled as delivered
// (tools/world/build_terrain.ts, decision 0005). Binary: 'HTER', u32 version, f32 x0, f32 z0,
// f32 resolution, u32 nx, u32 nz, then nx*nz float32 heights.
export const HTER_MAGIC = 'HTER';
export const HTER_VERSION = 1;
/** Lossless prior-row uint32 deltas, split into byte planes before gzip storage. */
export const HTER_COMPACT_VERSION = 2;

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

/** Smaller gzip input without quantizing heights, including signed zero and every Float32 bit. */
export function encodeCompactTerrain(t: TerrainGrid): Uint8Array {
  const out = encodeTerrain(t), dv = new DataView(out.buffer), count = t.heights.length;
  dv.setUint32(4, HTER_COMPACT_VERSION, true);
  const source = new DataView(t.heights.buffer, t.heights.byteOffset, t.heights.byteLength);
  for (let i = 0; i < count; i++) {
    const delta = (source.getUint32(i * 4, true) - (i >= t.nx ? source.getUint32((i - t.nx) * 4, true) : 0)) >>> 0;
    for (let plane = 0; plane < 4; plane++) out[28 + plane * count + i] = (delta >>> (plane * 8)) & 255;
  }
  return out;
}

/** `copy:false` is for immutable runtime payloads; authoring callers retain independent, zero-offset height storage. */
export function parseTerrain(bytes: Uint8Array, options: { copy?: boolean } = {}): TerrainGrid {
  if (bytes.byteLength < 28) throw new Error('truncated HTER terrain header');
  if (new TextDecoder().decode(bytes.subarray(0, 4)) !== HTER_MAGIC) throw new Error('not an HTER terrain');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = dv.getUint32(4, true);
  if (version !== HTER_VERSION && version !== HTER_COMPACT_VERSION) throw new Error('unsupported terrain version');
  const nx = dv.getUint32(20, true), nz = dv.getUint32(24, true);
  const count = nx * nz, resolution = dv.getFloat32(16, true), x0 = dv.getFloat32(8, true), z0 = dv.getFloat32(12, true);
  if (nx < 2 || nz < 2 || !Number.isSafeInteger(count) || count > 16_777_216 || bytes.byteLength !== 28 + count * 4) throw new Error('terrain height count or byte length is invalid');
  if (![x0, z0, resolution].every(Number.isFinite) || resolution <= 0) throw new Error('terrain grid coordinates are invalid');
  // Native v1 fetch buffers are aligned. Retain their immutable storage instead of making two whole-grid copies.
  // Unaligned callers receive one allocation, while compact v2 expands directly into its sole height allocation.
  const aligned = (bytes.byteOffset + 28) % 4 === 0;
  const heights = version === HTER_VERSION && aligned && options.copy === false
    ? new Float32Array(bytes.buffer, bytes.byteOffset + 28, count) : new Float32Array(count);
  if (version === HTER_VERSION && heights.buffer !== bytes.buffer) {
    const target = new Uint8Array(heights.buffer);
    target.set(bytes.subarray(28));
  } else if (version === HTER_COMPACT_VERSION) {
    const target = new Uint32Array(heights.buffer);
    for (let i = 0; i < count; i++) {
      const delta = (bytes[28 + i]! | (bytes[28 + count + i]! << 8) | (bytes[28 + 2 * count + i]! << 16) | (bytes[28 + 3 * count + i]! << 24)) >>> 0;
      target[i] = (delta + (i >= nx ? target[i - nx]! : 0)) >>> 0;
    }
  }
  return { x0, z0, resolution, nx, nz, heights };
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
