// 2D geometry helpers for the world tools: rings are [x, y][] in the working frame (X east, Y north) unless noted.
import { readFileSync } from 'node:fs';

export type Pt = [number, number];
export type Ring = Pt[];

export function ringArea(r: Ring): number {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j]![0] + r[i]![0]) * (r[j]![1] - r[i]![1]);
  return a / 2; // positive for clockwise in a y-up frame? No: positive when counter-clockwise with this formula sign flipped
}

/** Signed area, positive for counter-clockwise rings in a right-handed (X east, Y north) frame. */
export function signedArea(r: Ring): number {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += r[j]![0] * r[i]![1] - r[i]![0] * r[j]![1];
  return a / 2;
}

export function ensureCcw(r: Ring): Ring {
  return signedArea(r) < 0 ? [...r].reverse() : r;
}

export function pointInRing(p: Pt, r: Ring): boolean {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const xi = r[i]![0], yi = r[i]![1], xj = r[j]![0], yj = r[j]![1];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Outer ring plus holes. */
export function pointInPolygon(p: Pt, rings: readonly Ring[]): boolean {
  if (rings.length === 0 || !pointInRing(p, rings[0]!)) return false;
  for (let i = 1; i < rings.length; i++) if (pointInRing(p, rings[i]!)) return false;
  return true;
}

export function bbox(rings: readonly Ring[]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rings) for (const [x, y] of r) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
  return [x0, y0, x1, y1];
}

export function centroid(r: Ring): Pt {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const f = r[j]![0] * r[i]![1] - r[i]![0] * r[j]![1];
    a += f; cx += (r[j]![0] + r[i]![0]) * f; cy += (r[j]![1] + r[i]![1]) * f;
  }
  if (Math.abs(a) < 1e-9) return r[0] ?? [0, 0];
  return [cx / (3 * a), cy / (3 * a)];
}

/** Distance from p to the segment ab, with the closest parameter t. */
export function segmentDistance(p: Pt, a: Pt, b: Pt): { d: number; t: number; q: Pt } {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2)) : 0;
  const q: Pt = [a[0] + dx * t, a[1] + dy * t];
  return { d: Math.hypot(p[0] - q[0], p[1] - q[1]), t, q };
}

export function ringDistance(p: Pt, r: Ring): number {
  let best = Infinity;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) best = Math.min(best, segmentDistance(p, r[j]!, r[i]!).d);
  return best;
}

/** Douglas-Peucker simplification keeping the ring closed. */
export function simplifyRing(r: Ring, tolerance: number): Ring {
  if (r.length <= 4) return r;
  const keep = new Uint8Array(r.length);
  keep[0] = 1; keep[r.length - 1] = 1;
  const stack: [number, number][] = [[0, r.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let worst = -1, worstD = tolerance;
    for (let i = s + 1; i < e; i++) {
      const { d } = segmentDistance(r[i]!, r[s]!, r[e]!);
      if (d > worstD) { worstD = d; worst = i; }
    }
    if (worst >= 0) { keep[worst] = 1; stack.push([s, worst], [worst, e]); }
  }
  const out: Ring = [];
  for (let i = 0; i < r.length; i++) if (keep[i]) out.push(r[i]!);
  if (out.length >= 2 && out[0]![0] === out[out.length - 1]![0] && out[0]![1] === out[out.length - 1]![1]) out.pop();
  return out.length >= 3 ? out : r;
}

/** Remove a duplicated closing vertex and consecutive duplicates. */
export function cleanRing(r: Ring): Ring {
  const out: Ring = [];
  for (const p of r) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(last[0] - p[0], last[1] - p[1]) > 1e-6) out.push([p[0], p[1]]);
  }
  if (out.length > 1 && Math.hypot(out[0]![0] - out[out.length - 1]![0], out[0]![1] - out[out.length - 1]![1]) <= 1e-6) out.pop();
  return out;
}

export interface LocalPolygon {
  readonly id: string;
  readonly rings: Ring[];
  readonly bbox: [number, number, number, number];
  readonly properties: Record<string, unknown>;
}

/** GeoJSON (EPSG:3879) polygons / multipolygons to working-frame polygons; each MultiPolygon part becomes its own entry. */
export function loadGeoJsonPolygons(file: string, E0: number, N0: number, idOf: (props: Record<string, unknown>, i: number) => string): LocalPolygon[] {
  const gj = JSON.parse(readFileSync(file, 'utf8')) as { features: { geometry: { type: string; coordinates: unknown }; properties: Record<string, unknown> }[] };
  const out: LocalPolygon[] = [];
  gj.features.forEach((f, i) => {
    const polys: number[][][][] = f.geometry.type === 'Polygon' ? [f.geometry.coordinates as number[][][]]
      : f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates as number[][][][] : [];
    polys.forEach((poly, k) => {
      const rings = poly.map((ring, ri) => {
        const r = cleanRing(ring.map(([e, n]) => [e! - E0, n! - N0] as Pt));
        return ri === 0 ? ensureCcw(r) : (signedArea(r) > 0 ? [...r].reverse() : r);
      }).filter(r => r.length >= 3);
      if (rings.length === 0) return;
      const id = idOf(f.properties, i) + (polys.length > 1 ? `#${k}` : '');
      out.push({ id, rings, bbox: bbox(rings), properties: f.properties });
    });
  });
  return out;
}

/** Uniform grid index over polygon bboxes for fast point queries. */
export class PolygonGrid<T extends { bbox: [number, number, number, number]; rings: Ring[] }> {
  private readonly cells = new Map<string, T[]>();
  private readonly size: number;
  readonly items: readonly T[];
  constructor(items: readonly T[], cellSize = 16) {
    this.items = items;
    this.size = cellSize;
    for (const it of items) {
      const [x0, y0, x1, y1] = it.bbox;
      for (let cx = Math.floor(x0 / cellSize); cx <= Math.floor(x1 / cellSize); cx++)
        for (let cy = Math.floor(y0 / cellSize); cy <= Math.floor(y1 / cellSize); cy++) {
          const key = `${cx},${cy}`;
          let list = this.cells.get(key);
          if (!list) this.cells.set(key, list = []);
          list.push(it);
        }
    }
  }
  candidates(x: number, y: number): readonly T[] {
    return this.cells.get(`${Math.floor(x / this.size)},${Math.floor(y / this.size)}`) ?? [];
  }
  /** All items whose polygon contains the point. */
  containing(x: number, y: number): T[] {
    const out: T[] = [];
    for (const it of this.candidates(x, y)) {
      const [x0, y0, x1, y1] = it.bbox;
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      if (pointInPolygon([x, y], it.rings)) out.push(it);
    }
    return out;
  }
}
