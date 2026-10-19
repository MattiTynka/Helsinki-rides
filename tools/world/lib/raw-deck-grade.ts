// Exact source decks retain a private raw interpolation. Ordinary roads meet
// their real boundary through a compact transition rather than borrowing the
// deck's unconstrained grid corners outside its footprint.
import assert from 'node:assert/strict';
import earcut from 'earcut';
import polygonClipping from 'polygon-clipping';
import { cellId, cellIndexFor } from '../../../packages/world-schema/src/index.ts';
import { cleanRing, pointInPolygon, ringDistance, segmentDistance, type LocalPolygon, type Pt } from './geometry.ts';
import { type Finish, type GroundPiece } from './ground.ts';

interface DeckNode { readonly x: number; readonly n: number; readonly raw: number }
interface DeckCell {
  readonly ix: number;
  readonly iy: number;
  readonly nodes: readonly [number, number, number, number];
  readonly polygons: readonly { source: string; rings: Pt[][] }[];
}
export interface RawDeckTieIn {
  readonly sample: (x: number, n: number) => number | null;
  readonly rawAt: (x: number, n: number) => number | null;
  readonly baseAt: (x: number, n: number) => number | null;
  readonly rawContains: (x: number, n: number) => boolean;
  readonly masks: readonly LocalPolygon[];
  readonly width: number;
  readonly grid: number;
}

export function createRawDeckTieIn(nodes: readonly DeckNode[], cells: readonly DeckCell[],
  constrained: readonly number[], masks: readonly LocalPolygon[], grid: number, width: number): RawDeckTieIn {
  assert.ok(Number.isInteger(grid) && grid > 0 && nodes.every(p => Number.isFinite(p.raw)));
  assert.ok(constrained.length === nodes.length && constrained.every(Number.isFinite));
  assert.ok(Number.isFinite(width) && width >= 4 && width <= 8, 'Raw deck tie-in must stay within 4-8m');
  const raw = nodes.map(p => p.raw), ordinary = [...constrained];
  const cellMap = new Map(cells.map(c => [`${c.ix}:${c.iy}`, c]));
  const edges = masks.flatMap(p => p.rings.flatMap(r => r.map((a, i) => ({ a, b: r[(i + 1) % r.length]! }))));
  function interpolate(values: readonly number[], x: number, n: number): number | null {
    let ix = Math.floor(x / grid), iy = Math.floor(n / grid), cell = cellMap.get(`${ix}:${iy}`);
    if (!cell) for (const [dx, dy] of [[-1, 0], [0, -1], [-1, -1]]) {
      const next = cellMap.get(`${ix + dx!}:${iy + dy!}`);
      if (next && x >= next.ix * grid - 1e-8 && x <= (next.ix + 1) * grid + 1e-8 && n >= next.iy * grid - 1e-8 && n <= (next.iy + 1) * grid + 1e-8) {
        cell = next; ix = next.ix; iy = next.iy; break;
      }
    }
    if (!cell) return null;
    const u = x / grid - ix, v = n / grid - iy, [a, b, c, d] = cell.nodes.map(i => values[i]!);
    return v <= u ? a! + (b! - a!) * u + (c! - b!) * v : a! + (c! - d!) * u + (d! - a!) * v;
  }
  const rawAt = (x: number, n: number) => interpolate(raw, x, n);
  const baseAt = (x: number, n: number) => interpolate(ordinary, x, n);
  const rawContains = (x: number, n: number) => masks.some(p => pointInPolygon([x, n], p.rings) || p.rings.some(r => ringDistance([x, n], r) <= 1e-6));
  const sample = (x: number, n: number): number | null => {
    const base = baseAt(x, n); if (base === null) return null;
    if (rawContains(x, n)) return rawAt(x, n);
    let correction = 0, weights = 0;
    for (const edge of edges) {
      const q = segmentDistance([x, n], edge.a, edge.b); if (q.d >= width) continue;
      const source = rawAt(...q.q), ordinaryBoundary = baseAt(...q.q);
      assert.ok(source !== null && ordinaryBoundary !== null, 'Raw source boundary lacks an interpolation cell');
      const t = q.d / width, fade = 1 - t * t * (3 - 2 * t), weight = 1 / Math.max(q.d, 1e-4) ** 4;
      correction += (source - ordinaryBoundary) * fade * weight; weights += weight;
    }
    return base + (weights ? correction / weights : 0);
  };
  return { sample, rawAt, baseAt, rawContains, masks, width, grid };
}

interface MeshingGrade {
  readonly parts: readonly LocalPolygon[];
  readonly cells: readonly DeckCell[];
  readonly stats: { readonly gridMetres: number };
  readonly rawDeckTieIn: RawDeckTieIn | null;
}
type Geometry = Pt[][][];
const overlaps = (a: readonly number[], b: readonly number[]) => a[0]! <= b[2]! && a[2]! >= b[0]! && a[1]! <= b[3]! && a[3]! >= b[1]!;
function roadFinish(p: LocalPolygon): Finish {
  const material = String(p.properties['materiaali'] ?? '').toLowerCase();
  if (material.includes('nupukivi')) return 'setts';
  if (material.includes('noppakivi') || material.includes('kenttäkivi') || material.includes('mukulakivi')) return 'cobble';
  if (material.includes('laatta') || material.includes('betonikivi') || material.includes('graniitti')) return 'slabs';
  if (material.includes('sora') || material.includes('kivituhka') || material.includes('hiekka')) return 'gravel';
  return 'asphalt';
}
function clip(operation: 'intersection' | 'difference', a: Geometry, b: Geometry): Geometry {
  try { return polygonClipping[operation](a, b) as Geometry; }
  catch (original) {
    const snap = (g: Geometry): Geometry => g.map(p => p.map(r => r.map(([x, n]) => [Math.round(x * 1e7) / 1e7, Math.round(n * 1e7) / 1e7])));
    try { return polygonClipping[operation](snap(a), snap(b)) as Geometry; }
    catch (retry) { throw new AggregateError([original, retry], 'Raw deck source-grid clip failed at source and 0.1um precision'); }
  }
}
function pieceGridKey(piece: GroundPiece, grid: number): string {
  let minX = Infinity, minN = Infinity, maxX = -Infinity, maxN = -Infinity;
  for (let i = 0; i < piece.positions.length; i += 3) {
    minX = Math.min(minX, piece.positions[i]!); maxX = Math.max(maxX, piece.positions[i]!);
    minN = Math.min(minN, -piece.positions[i + 2]!); maxN = Math.max(maxN, -piece.positions[i + 2]!);
  }
  return `${Math.floor((minX + maxX) / 2 / grid)}:${Math.floor((minN + maxN) / 2 / grid)}`;
}

export function meshRawDeckTieIn<Grade extends MeshingGrade>(grade: Grade, cellSize: number,
  legacy: (grade: Grade, cellSize: number) => GroundPiece[]): GroundPiece[] {
  const field = grade.rawDeckTieIn; if (!field) return legacy(grade, cellSize);
  const grid = grade.stats.gridMetres, rawIds = new Set(field.masks.map(p => p.id));
  const source = new Map(grade.parts.map(p => [p.id, p]));
  const selected = grade.cells.filter(c => field.masks.some(p => overlaps(
    [c.ix * grid, c.iy * grid, (c.ix + 1) * grid, (c.iy + 1) * grid],
    [p.bbox[0] - field.width, p.bbox[1] - field.width, p.bbox[2] + field.width, p.bbox[3] + field.width])));
  const keys = new Set(selected.map(c => `${c.ix}:${c.iy}`));
  const unchanged = legacy(grade, cellSize).filter(p => !keys.has(pieceGridKey(p, grid)));
  const pieces: GroundPiece[] = [];
  for (const cell of selected) {
    let claimed: Geometry = [];
    const groups: { source: string; raw: boolean; finish: Finish; geometry: Geometry }[] = [];
    for (const p of cell.polygons) {
      const original = [p.rings], available = claimed.length ? clip('difference', original, claimed) : original;
      if (!available.length) continue;
      claimed = claimed.length ? polygonClipping.union(claimed, available) as Geometry : available;
      const part = source.get(p.source); assert.ok(part, `Missing source road ${p.source}`);
      groups.push({ source: p.source, raw: rawIds.has(p.source), finish: roadFinish(part), geometry: available });
    }
    for (const group of groups) {
      const positions: number[] = [], uvs: number[] = [], indices: number[] = [];
      const step = group.raw ? grid : 0.5;
      const scale = group.finish === 'asphalt' ? 6 : ['setts', 'cobble'].includes(group.finish) ? 2 : group.finish === 'gravel' ? 4 : 3;
      for (let sx = 0; sx < grid; sx += step) for (let sn = 0; sn < grid; sn += step) {
        const x = cell.ix * grid + sx, n = cell.iy * grid + sn;
        const corners: Pt[] = [[x, n], [x + step, n], [x + step, n + step], [x, n + step]];
        for (const ids of [[0, 1, 2], [0, 2, 3]]) {
          const clipped = clip('intersection', group.geometry, [[ids.map(i => corners[i]!)]]);
          for (const polygon of clipped) {
            const flat: number[] = [], holes: number[] = [];
            polygon.forEach((ring, i) => { if (i) holes.push(flat.length / 2); for (const p of cleanRing(ring)) flat.push(...p); });
            if (flat.length < 6) continue;
            const triangles = earcut(flat, holes, 2), base = positions.length / 3;
            for (let i = 0; i < flat.length; i += 2) {
              const px = flat[i]!, pn = flat[i + 1]!, height = group.raw ? field.rawAt(px, pn) : field.sample(px, pn);
              assert.ok(height !== null, 'Source-aware road vertex lacks an interpolation cell');
              positions.push(px, height, -pn); uvs.push(px / scale, pn / scale);
            }
            for (const i of triangles) indices.push(base + i);
          }
        }
      }
      if (indices.length) pieces.push({ cell: cellId(...cellIndexFor((cell.ix + 0.5) * grid, -(cell.iy + 0.5) * grid, cellSize)), finish: group.finish, level: 'road', tag: `road:${group.finish}`, positions, uvs, indices });
    }
  }
  return [...unchanged, ...pieces];
}
