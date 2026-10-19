// Exact water/safety-cell raster used by the offline coastal safety builder.
// Full cells use scanline spans; only boundary cells require polygon clipping.
// Introduction baseline coastal-mask.ts SHA-256:
// 3d5d33b429feccd1a9c615c0fdc8fe2a21a872594314940f348a2fa6cb00c36f.
import polygonClipping from 'polygon-clipping';
import type { TerrainGrid } from '../../../packages/world-schema/src/index.ts';
import { signedArea, type LocalPolygon, type Ring } from './geometry.ts';

type Interval = [number, number];
type Geometry = [number, number][][][];
export interface CoastalRasterStats {
  polygons: number;
  candidateCells: number;
  scanlineRows: number;
  boundaryCells: number;
  exactClips: number;
  interiorCells: number;
  wetCells: number;
}
export interface CoastalRaster {
  /** Row-major terrain cells, with stride nx-1 (not terrain vertex stride nx). */
  readonly wet: Uint8Array;
  readonly stats: CoastalRasterStats;
}

const areaOf = (geometry: Geometry) => geometry.reduce((sum, polygon) => sum + Math.abs(signedArea(polygon[0]!)) - polygon.slice(1).reduce((holes, ring) => holes + Math.abs(signedArea(ring)), 0), 0);

function mergedIntervals(intervals: Interval[]): Interval[] {
  intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const result: Interval[] = [];
  for (const interval of intervals) {
    const previous = result.at(-1);
    if (previous && interval[0] <= previous[1] + 1) previous[1] = Math.max(previous[1], interval[1]);
    else result.push([...interval]);
  }
  return result;
}

/** All ring edges, including hole edges, mark their touched grid cells. The
 * extra cell at an integral boundary is deliberate: endpoint/grid-line contact
 * must never make a partially wet cell look like a full interior cell. */
function boundaryRows(polygon: LocalPolygon, terrain: TerrainGrid, bounds: readonly number[]): Map<number, Interval[]> {
  const [ix0, ix1, iz0, iz1] = bounds as [number, number, number, number];
  const rows = new Map<number, Interval[]>(), r = terrain.resolution;
  const append = (iz: number, first: number, last: number) => {
    first = Math.max(ix0, first); last = Math.min(ix1, last);
    if (first > last) return;
    let intervals = rows.get(iz); if (!intervals) rows.set(iz, intervals = []);
    intervals.push([first, last]);
  };
  for (const ring of polygon.rings) for (let j = 0, k = ring.length - 1; j < ring.length; k = j++) {
    const a = ring[k]!, b = ring[j]!;
    const ax = (a[0] - terrain.x0) / r, az = (-a[1] - terrain.z0) / r;
    const bx = (b[0] - terrain.x0) / r, bz = (-b[1] - terrain.z0) / r;
    const dx = bx - ax, dz = bz - az;
    const firstRow = Math.max(iz0, Math.floor(Math.min(az, bz)) - 1), lastRow = Math.min(iz1, Math.floor(Math.max(az, bz)));
    for (let iz = firstRow; iz <= lastRow; iz++) {
      let from = 0, to = 1;
      if (dz === 0) { if (az < iz || az > iz + 1) continue; }
      else {
        const t0 = (iz - az) / dz, t1 = (iz + 1 - az) / dz;
        from = Math.max(0, Math.min(t0, t1)); to = Math.min(1, Math.max(t0, t1));
        if (from > to) continue;
      }
      const x0 = ax + dx * from, x1 = ax + dx * to;
      append(iz, Math.floor(Math.min(x0, x1)) - 1, Math.floor(Math.max(x0, x1)));
    }
  }
  for (const [row, intervals] of rows) rows.set(row, mergedIntervals(intervals));
  return rows;
}

/** Outer-ring even/odd intervals minus the union of all hole intervals. Using
 * a hole counter also preserves pointInPolygon's exclusion for nested holes. */
function interiorIntervals(rings: readonly Ring[], y: number): Interval[] {
  const events: { x: number; outer: number; holes: number }[] = [];
  for (const [ringIndex, ring] of rings.entries()) {
    const crossings: number[] = [];
    for (let j = 0, k = ring.length - 1; j < ring.length; k = j++) {
      const a = ring[k]!, b = ring[j]!;
      if ((a[1] > y) !== (b[1] > y)) crossings.push((b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]);
    }
    crossings.sort((a, b) => a - b);
    if (crossings.length % 2) throw new Error('Water ring has an odd scanline intersection count');
    for (let j = 0; j < crossings.length; j += 2) {
      events.push({ x: crossings[j]!, outer: ringIndex ? 0 : 1, holes: ringIndex ? 1 : 0 });
      events.push({ x: crossings[j + 1]!, outer: ringIndex ? 0 : -1, holes: ringIndex ? -1 : 0 });
    }
  }
  events.sort((a, b) => a.x - b.x);
  const result: Interval[] = []; let outer = 0, holes = 0, previous = 0;
  for (let i = 0; i < events.length;) {
    const x = events[i]!.x;
    if (outer > 0 && holes === 0 && x > previous) result.push([previous, x]);
    do { const event = events[i++]!; outer += event.outer; holes += event.holes; } while (i < events.length && events[i]!.x === x);
    previous = x;
  }
  return result;
}

export function rasterizeCoastalWater(terrain: TerrainGrid, water: readonly LocalPolygon[]): CoastalRaster {
  const areaThreshold = 1e-7;
  if (!(terrain.resolution > 0) || !Number.isInteger(terrain.nx) || !Number.isInteger(terrain.nz) || terrain.nx < 2 || terrain.nz < 2) throw new Error('Invalid water raster grid');
  const width = terrain.nx - 1, height = terrain.nz - 1, wet = new Uint8Array(width * height), r = terrain.resolution;
  const stats: CoastalRasterStats = { polygons: water.length, candidateCells: 0, scanlineRows: 0, boundaryCells: 0, exactClips: 0, interiorCells: 0, wetCells: 0 };
  for (const polygon of water) {
    const [x0, y0, x1, y1] = polygon.bbox;
    const ix0 = Math.max(0, Math.floor((x0 - terrain.x0) / r)), ix1 = Math.min(width - 1, Math.floor((x1 - terrain.x0) / r));
    const iz0 = Math.max(0, Math.floor((-y1 - terrain.z0) / r)), iz1 = Math.min(height - 1, Math.floor((-y0 - terrain.z0) / r));
    if (ix0 > ix1 || iz0 > iz1) continue;
    stats.candidateCells += (ix1 - ix0 + 1) * (iz1 - iz0 + 1);
    const rows = boundaryRows(polygon, terrain, [ix0, ix1, iz0, iz1]);
    // Tiny cells near the clipping threshold (or catastrophic coordinate
    // cancellation) retain the reference's exact clipping calculation.
    const magnitude = Math.max(Math.abs(x0), Math.abs(x1), Math.abs(y0), Math.abs(y1)) + 1;
    const fillWholeCells = r * r > Math.max(areaThreshold * 4, Number.EPSILON * 64 * magnitude * magnitude);
    const markSpan = (iz: number, first: number, last: number) => {
      if (first > last) return;
      wet.fill(1, iz * width + first, iz * width + last + 1); stats.interiorCells += last - first + 1;
    };
    for (let iz = iz0; iz <= iz1; iz++) {
      const boundary = rows.get(iz) ?? [];
      if (fillWholeCells) {
        stats.scanlineRows++;
        for (const [left, right] of interiorIntervals(polygon.rings, -(terrain.z0 + (iz + .5) * r))) {
          let first = Math.max(ix0, Math.ceil((left - terrain.x0) / r - .5));
          const last = Math.min(ix1, Math.floor((right - terrain.x0) / r - .5));
          for (const [edgeFirst, edgeLast] of boundary) {
            if (edgeLast < first) continue;
            if (edgeFirst > last) break;
            markSpan(iz, first, Math.min(last, edgeFirst - 1)); first = Math.max(first, edgeLast + 1);
            if (first > last) break;
          }
          markSpan(iz, first, last);
        }
      }
      const candidates: Interval[] = fillWholeCells ? boundary : [[ix0, ix1]];
      for (const [first, last] of candidates) for (let ix = first; ix <= last; ix++) {
        stats.boundaryCells++; const index = iz * width + ix; if (wet[index]) continue;
        const x = terrain.x0 + ix * r, z = terrain.z0 + iz * r;
        const square: Ring = [[x, -z], [x + r, -z], [x + r, -z - r], [x, -z - r]];
        stats.exactClips++;
        if (areaOf(polygonClipping.intersection([polygon.rings], [[square]]) as Geometry) >= areaThreshold) wet[index] = 1;
      }
    }
  }
  for (const cell of wet) stats.wetCells += cell;
  return { wet, stats };
}

/** Reference-compatible four-corner lowering. The completed v3 water-corner
 * mask was verified across all 3,013,551 source-grid vertices before adoption. */
export function lowerTerrainUnderWaterRaster(terrain: TerrainGrid, mask: { readonly water: readonly LocalPolygon[] }, floorY: number): { terrain: TerrainGrid; loweredSamples: number; stats: CoastalRasterStats } {
  if (!Number.isFinite(floorY)) throw new Error('Invalid underwater safety floor');
  const { wet, stats } = rasterizeCoastalWater(terrain, mask.water), heights = terrain.heights.slice(), width = terrain.nx - 1;
  for (let iz = 0; iz < terrain.nz - 1; iz++) for (let ix = 0; ix < width; ix++) {
    if (!wet[iz * width + ix]) continue;
    const first = iz * terrain.nx + ix;
    for (const index of [first, first + 1, first + terrain.nx, first + terrain.nx + 1]) heights[index] = Math.min(heights[index]!, floorY);
  }
  let loweredSamples = 0;
  for (let i = 0; i < heights.length; i++) if (heights[i] !== terrain.heights[i]) loweredSamples++;
  return { terrain: { ...terrain, heights }, loweredSamples, stats };
}
