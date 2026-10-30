// Live terrain (docs/live-kartta-cells-plan-2026-10-30.md, section 3): the city's quantized-mesh 1.0 terrain tiles
// (geographic TMS, EPSG:4326) decoded and sampled on a live square's 2 m lattice exactly as build_terrain.ts sampled the
// release terrain through tools/world/lib/quantized-mesh.ts: the floor tile of the point, the linear height of the
// first containing triangle in its bucket, N2000 heights as delivered minus the origin height. Pure and browser-safe;
// tile bytes arrive already decompressed (the HTTP layer undoes brotli or gzip content encoding).
import { gk25ToGeodetic } from '@helsinki/world-schema';
import { LIVE_GROUND_N, LIVE_GROUND_STEP, LIVE_TERRAIN_ZOOM, type Origin, type TerrainTileAddress } from '../contract.ts';

const SQUARE = (LIVE_GROUND_N - 1) * LIVE_GROUND_STEP;
/** Metres added around the square when choosing tiles, so points on its edge never miss a tile. */
const TILE_PAD = 2;
/** Quantized units a point may lie outside a neighbouring tile and still be sampled there (edge fallback only). */
const EDGE_SLACK = 1;

/** Tile size in degrees at a zoom level: level 0 is two tiles, 180° each. */
const tileDegrees = (z: number): number => 180 / 2 ** z;

export interface QuantizedTile {
  readonly minHeight: number;
  readonly maxHeight: number;
  /** Per vertex, quantized to 0..32767 across the tile (u west to east, v south to north). */
  readonly u: Uint16Array;
  readonly v: Uint16Array;
  /** Per vertex, metres. */
  readonly height: Float64Array;
  readonly indices: Uint32Array;
}

const zigZag = (n: number): number => (n >> 1) ^ -(n & 1);

/** Decode a quantized-mesh 1.0 tile (header, zig-zag delta u/v/height, high-water-mark indices; the rest is skipped). */
export function decodeQuantizedMesh(bytes: Uint8Array): QuantizedTile {
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) throw new Error('quantized-mesh tile is still gzip-compressed');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 24;
  const minHeight = view.getFloat32(o, true), maxHeight = view.getFloat32(o + 4, true);
  o = 88;
  const n = view.getUint32(o, true); o += 4;
  const u = new Uint16Array(n), v = new Uint16Array(n), h = new Uint16Array(n);
  for (const [arr, start] of [[u, o], [v, o + n * 2], [h, o + n * 4]] as const) {
    let value = 0;
    for (let i = 0; i < n; i++) { value += zigZag(view.getUint16(start + i * 2, true)); arr[i] = value; }
  }
  o += n * 6;
  const wide = n > 65536;
  if (wide && o % 4) o += 4 - (o % 4);
  else if (o % 2) o += 1;
  const triangles = view.getUint32(o, true); o += 4;
  const indices = new Uint32Array(triangles * 3);
  let highest = 0;
  for (let i = 0; i < indices.length; i++) {
    const code = wide ? view.getUint32(o + i * 4, true) : view.getUint16(o + i * 2, true);
    indices[i] = highest - code;
    if (code === 0) highest++;
  }
  const height = new Float64Array(n);
  for (let i = 0; i < n; i++) height[i] = minHeight + (h[i]! / 32767) * (maxHeight - minHeight);
  return { minHeight, maxHeight, u, v, height, indices };
}

/** Linear height at a quantized (u, v) from the containing triangle; null outside every triangle. The bucket layout and
 *  triangle order match the offline TileSampler, so shared triangle edges resolve to the same triangle. */
class TileSampler {
  private static readonly B = 64;
  private readonly buckets: number[][];
  private readonly tile: QuantizedTile;

  constructor(tile: QuantizedTile) {
    this.tile = tile;
    const B = TileSampler.B, size = 32768 / B, I = tile.indices;
    this.buckets = Array.from({ length: B * B }, () => []);
    for (let t = 0; t < I.length; t += 3) {
      const ua = tile.u[I[t]!]!, ub = tile.u[I[t + 1]!]!, uc = tile.u[I[t + 2]!]!;
      const va = tile.v[I[t]!]!, vb = tile.v[I[t + 1]!]!, vc = tile.v[I[t + 2]!]!;
      const bx0 = Math.floor(Math.min(ua, ub, uc) / size), bx1 = Math.min(B - 1, Math.floor(Math.max(ua, ub, uc) / size));
      const by0 = Math.floor(Math.min(va, vb, vc) / size), by1 = Math.min(B - 1, Math.floor(Math.max(va, vb, vc) / size));
      for (let by = by0; by <= by1; by++) for (let bx = bx0; bx <= bx1; bx++) this.buckets[by * B + bx]!.push(t);
    }
  }

  heightAt(pu: number, pv: number): number | null {
    const B = TileSampler.B, size = 32768 / B, { u, v, height, indices: I } = this.tile;
    const bucket = this.buckets[Math.min(B - 1, Math.max(0, Math.floor(pv / size))) * B + Math.min(B - 1, Math.max(0, Math.floor(pu / size)))]!;
    for (const t of bucket) {
      const a = I[t]!, b = I[t + 1]!, c = I[t + 2]!;
      const ax = u[a]!, ay = v[a]!, bx = u[b]!, by = v[b]!, cx = u[c]!, cy = v[c]!;
      const det = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
      if (det === 0) continue;
      const l1 = ((bx - pu) * (cy - pv) - (cx - pu) * (by - pv)) / det;
      const l2 = ((cx - pu) * (ay - pv) - (ax - pu) * (cy - pv)) / det;
      const l3 = 1 - l1 - l2;
      if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue;
      return l1 * height[a]! + l2 * height[b]! + l3 * height[c]!;
    }
    return null;
  }
}

/** A tile given to sampleLattice; its triangle buckets are built on first use. */
interface TileEntry { readonly address: TerrainTileAddress; readonly tile: QuantizedTile; sampler: TileSampler | null }

/** Every zoom-18 tile that meets the square's lattice (plus a small pad), x ascending then y ascending (y from the south). */
export function terrainTileAddresses(cx: number, cz: number, origin: Origin): TerrainTileAddress[] {
  const [E0, N0] = origin;
  const x0 = cx * SQUARE - TILE_PAD, x1 = (cx + 1) * SQUARE + TILE_PAD, z0 = cz * SQUARE - TILE_PAD, z1 = (cz + 1) * SQUARE + TILE_PAD;
  const corners = [gk25ToGeodetic(E0 + x0, N0 - z0), gk25ToGeodetic(E0 + x1, N0 - z0), gk25ToGeodetic(E0 + x0, N0 - z1), gk25ToGeodetic(E0 + x1, N0 - z1)];
  const south = Math.min(...corners.map(c => c[0])), north = Math.max(...corners.map(c => c[0]));
  const west = Math.min(...corners.map(c => c[1])), east = Math.max(...corners.map(c => c[1]));
  const d = tileDegrees(LIVE_TERRAIN_ZOOM);
  const tx0 = Math.floor((west + 180) / d), tx1 = Math.floor((east + 180) / d), ty0 = Math.floor((south + 90) / d), ty1 = Math.floor((north + 90) / d);
  const out: TerrainTileAddress[] = [];
  for (let x = tx0; x <= tx1; x++) for (let y = ty0; y <= ty1; y++) out.push({ z: LIVE_TERRAIN_ZOOM, x, y });
  return out;
}

/**
 * Runtime Y of the square's N × N lattice (row-major iz * N + ix; x = cx * 128 + ix * 2, z = cz * 128 + iz * 2).
 * A point takes its floor tile at the finest zoom given, as the release sampler did; if that tile is absent or misses
 * the point, the other tiles within a hair of it are tried in (zoom descending, x, y) order. A non-NaN override wins.
 * NaN where no tile covers the point.
 */
export function sampleLattice(cx: number, cz: number, origin: Origin, tiles: readonly { address: TerrainTileAddress; tile: QuantizedTile }[], overrides: Float32Array | null): Float32Array {
  const N = LIVE_GROUND_N, out = new Float32Array(N * N);
  if (overrides && overrides.length !== N * N) throw new Error(`terrain overrides hold ${overrides.length} values, expected ${N * N}`);
  const [E0, N0, H0] = origin;
  const sorted = [...tiles].sort((a, b) => b.address.z - a.address.z || a.address.x - b.address.x || a.address.y - b.address.y);
  const entries: TileEntry[] = [];
  const byKey = new Map<string, TileEntry>();
  for (const t of sorted) {
    const key = `${t.address.z}/${t.address.x}/${t.address.y}`;
    if (byKey.has(key)) continue;
    const entry: TileEntry = { address: t.address, tile: t.tile, sampler: null };
    byKey.set(key, entry);
    entries.push(entry);
  }
  const zooms: number[] = [];
  for (const e of entries) if (!zooms.includes(e.address.z)) zooms.push(e.address.z);
  const samplerOf = (e: TileEntry): TileSampler => (e.sampler ??= new TileSampler(e.tile));
  const heightAt = (lat: number, lon: number): number | null => {
    for (const z of zooms) {
      const d = tileDegrees(z), fx = (lon + 180) / d, fy = (lat + 90) / d, x = Math.floor(fx), y = Math.floor(fy);
      const e = byKey.get(`${z}/${x}/${y}`);
      const h = e ? samplerOf(e).heightAt((fx - x) * 32767, (fy - y) * 32767) : null;
      if (h !== null) return h;
    }
    for (const e of entries) {
      const d = tileDegrees(e.address.z);
      const pu = ((lon + 180) / d - e.address.x) * 32767, pv = ((lat + 90) / d - e.address.y) * 32767;
      if (pu < -EDGE_SLACK || pu > 32767 + EDGE_SLACK || pv < -EDGE_SLACK || pv > 32767 + EDGE_SLACK) continue;
      const h = samplerOf(e).heightAt(Math.min(32767, Math.max(0, pu)), Math.min(32767, Math.max(0, pv)));
      if (h !== null) return h;
    }
    return null;
  };
  for (let iz = 0; iz < N; iz++) for (let ix = 0; ix < N; ix++) {
    const i = iz * N + ix, override = overrides ? overrides[i]! : NaN;
    if (!Number.isNaN(override)) { out[i] = override; continue; }
    const x = cx * SQUARE + ix * LIVE_GROUND_STEP, z = cz * SQUARE + iz * LIVE_GROUND_STEP;
    const [lat, lon] = gk25ToGeodetic(E0 + x, N0 - z);
    const h = heightAt(lat, lon);
    out[i] = h === null ? NaN : h - H0;
  }
  return out;
}
