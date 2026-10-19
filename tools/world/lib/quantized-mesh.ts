// Cesium quantized-mesh 1.0 terrain tiles (geographic TMS scheme, EPSG:4326): tile addressing, decoding and height
// sampling for the terrain import. Format: https://github.com/CesiumGS/quantized-mesh (header, zig-zag delta coded
// u/v/height, high-water-mark coded indices, edge lists, extensions; the extensions are skipped).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { gk25ToGeodetic } from '../../../packages/world-schema/src/index.ts';

/** Tile size in degrees at a zoom level: level 0 is two tiles, 180° each. */
export const tileDegrees = (z: number): number => 180 / 2 ** z;

/** Inclusive x/y range of the tiles at `z` that meet a geographic box (degrees); y counts from the south (TMS). */
export function tileRange(z: number, south: number, west: number, north: number, east: number): { x0: number; x1: number; y0: number; y1: number } {
  const d = tileDegrees(z);
  return { x0: Math.floor((west + 180) / d), x1: Math.floor((east + 180) / d), y0: Math.floor((south + 90) / d), y1: Math.floor((north + 90) / d) };
}

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

export function decodeQuantizedMesh(bytes: Uint8Array): QuantizedTile {
  const raw = bytes[0] === 0x1f && bytes[1] === 0x8b ? new Uint8Array(gunzipSync(bytes)) : bytes;
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
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

/** Linear height at a quantized (u, v) inside the tile, from the triangle that contains it; null outside every
 *  triangle. Triangles are bucketed on first use. */
export class TileSampler {
  private readonly buckets: number[][];
  private static readonly B = 64;
  readonly tile: QuantizedTile;
  constructor(tile: QuantizedTile) {
    this.tile = tile;
    const B = TileSampler.B, size = 32768 / B, I = tile.indices;
    this.buckets = Array.from({ length: B * B }, () => []);
    for (let t = 0; t < I.length; t += 3) {
      const us = [tile.u[I[t]!]!, tile.u[I[t + 1]!]!, tile.u[I[t + 2]!]!], vs = [tile.v[I[t]!]!, tile.v[I[t + 1]!]!, tile.v[I[t + 2]!]!];
      const bx0 = Math.floor(Math.min(...us) / size), bx1 = Math.min(B - 1, Math.floor(Math.max(...us) / size));
      const by0 = Math.floor(Math.min(...vs) / size), by1 = Math.min(B - 1, Math.floor(Math.max(...vs) / size));
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

export interface TerrainSnapshot {
  readonly zoom: number;
  readonly tiles: number;
  readonly vertices: number;
  readonly triangles: number;
  /** Height in metres at an EPSG:3879 point, linear inside the containing tile triangle; null outside the snapshot. */
  heightAtEN(easting: number, northing: number): number | null;
}

/** Load a snapshot written by fetch_terrain.ts (its folder holds tiles.json and the tiles), checking each tile hash. */
export function loadTerrainSnapshot(dir: string, sha256: (b: Uint8Array) => string): TerrainSnapshot {
  const index = JSON.parse(readFileSync(path.join(dir, 'tiles.json'), 'utf8')) as { zoom: number; tiles: { file: string; x: number; y: number; sha256: string }[] };
  const samplers = new Map<string, TileSampler>();
  let vertices = 0, triangles = 0;
  for (const t of index.tiles) {
    const bytes = new Uint8Array(readFileSync(path.join(dir, t.file)));
    if (sha256(bytes) !== t.sha256) throw new Error(`${t.file} does not match its hash`);
    const tile = decodeQuantizedMesh(bytes);
    vertices += tile.u.length; triangles += tile.indices.length / 3;
    samplers.set(`${t.x}/${t.y}`, new TileSampler(tile));
  }
  const d = tileDegrees(index.zoom);
  return {
    zoom: index.zoom, tiles: index.tiles.length, vertices, triangles,
    heightAtEN(easting, northing) {
      const [lat, lon] = gk25ToGeodetic(easting, northing);
      const fx = (lon + 180) / d, fy = (lat + 90) / d, x = Math.floor(fx), y = Math.floor(fy);
      const s = samplers.get(`${x}/${y}`);
      return s ? s.heightAt((fx - x) * 32767, (fy - y) * 32767) : null;
    },
  };
}
