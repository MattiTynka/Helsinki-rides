// An opt-in, source-derived ground grade for surveyed surface carriageways.
// It does not change the input terrain, bridge heights, source footprints or the
// protected accepted district. A grade is an authored approximation, not a new
// engineering height survey.
import assert from 'node:assert/strict';
import earcut from 'earcut';
import polygonClipping from 'polygon-clipping';
import { cellId, cellIndexFor, sampleTerrain, type TerrainGrid } from '../../../packages/world-schema/src/index.ts';
import { bbox, cleanRing, pointInPolygon, PolygonGrid, ringDistance, segmentDistance, signedArea, type LocalPolygon, type Pt } from './geometry.ts';
import { closeSurfaceBoundaries, type Finish, type GroundPiece, type SurfaceBoundary } from './ground.ts';
import { createRawDeckTieIn, meshRawDeckTieIn } from './raw-deck-grade.ts';

type Area = { minX: number; maxX: number; minZ: number; maxZ: number };
export interface CarriagewayGradeOptions {
  readonly area: Area;
  readonly protectedArea: Area;
  /** The grid is shared by all carriageways, including adjoining source parts. */
  readonly gridMetres: number;
  /** Maximum rise/run on either grid axis. A triangle is bounded by sqrt(2)
   * times this value in any horizontal direction. This is authoring policy. */
  readonly maxAxisGrade: number;
  readonly protectedMarginMetres?: number;
  /** Explicit source bridge IDs whose existing raw grade is sound. Their node
   * heights are never constrained; this only avoids unrelated wall projection. */
  readonly rawSourceDeckPartIds?: readonly string[];
  /** Preserve raw interpolation only inside exact source decks. Ordinary roads
   * meet their real boundary over this compact 4-8m zone. */
  readonly rawDeckTieInMetres?: number;
}
interface GradeNode { readonly x: number; readonly n: number; readonly raw: number; readonly sources: string[]; height: number }
export interface CarriagewayGradeCell { readonly ix: number; readonly iy: number; readonly polygons: { source: string; rings: Pt[][] }[]; readonly nodes: readonly [number, number, number, number] }

class MinHeap {
  private readonly entries: [number, number][] = [];
  push(id: number, value: number) { const e: [number, number] = [id, value]; let i = this.entries.length; this.entries.push(e); while (i) { const p = (i - 1) >> 1; if (this.entries[p]![1] <= value) break; this.entries[i] = this.entries[p]!; i = p; } this.entries[i] = e; }
  pop(): [number, number] | undefined { const first = this.entries[0], last = this.entries.pop(); if (!this.entries.length || !last) return first; let i = 0; while (i * 2 + 1 < this.entries.length) { const a = i * 2 + 1, b = a + 1, k = b < this.entries.length && this.entries[b]![1] < this.entries[a]![1] ? b : a; if (last[1] <= this.entries[k]![1]) break; this.entries[i] = this.entries[k]!; i = k; } this.entries[i] = last; return first; }
}

/** Symmetric lower/upper Lipschitz envelopes of the measured source samples.
 * The midpoint changes neither a planar admissible slope nor a flat road. It
 * removes isolated extrema without selecting an invented absolute elevation. */
export function constrainedGrade(nodes: readonly { x: number; n: number; raw: number }[], gridMetres: number, maxAxisGrade: number): number[] {
  assert.ok(gridMetres > 0 && Number.isFinite(gridMetres)); assert.ok(maxAxisGrade > 0 && maxAxisGrade <= 0.4);
  const ids = new Map(nodes.map((p, i) => [`${Math.round(p.x / gridMetres)}:${Math.round(p.n / gridMetres)}`, i]));
  const neighbors = nodes.map(p => [[1, 0], [-1, 0], [0, 1], [0, -1]].flatMap(([dx, dy]) => {
    const id = ids.get(`${Math.round(p.x / gridMetres) + dx!}:${Math.round(p.n / gridMetres) + dy!}`); return id === undefined ? [] : [id];
  }));
  const envelope = (sign: number) => {
    const h = nodes.map(p => p.raw * sign), queue = new MinHeap(); h.forEach((v, i) => queue.push(i, v));
    while (true) { const q = queue.pop(); if (!q) break; const [id, value] = q; if (value > h[id]! + 1e-12) continue;
      for (const next of neighbors[id]!) { const candidate = value + gridMetres * maxAxisGrade; if (candidate < h[next]! - 1e-12) { h[next] = candidate; queue.push(next, candidate); } }
    }
    return h;
  };
  const lower = envelope(1), negativeUpper = envelope(-1);
  return lower.map((h, i) => (h - negativeUpper[i]!) / 2);
}

export function buildCarriagewayGrade(parts: readonly LocalPolygon[], terrain: TerrainGrid, options: CarriagewayGradeOptions) {
  const { area, protectedArea: keep, gridMetres: grid, maxAxisGrade } = options;
  assert.ok(Number.isInteger(grid) && grid > 0 && 128 % grid === 0);
  const margin = options.protectedMarginMetres ?? grid * 2;
  assert.ok(Number.isFinite(margin) && margin >= grid);
  const protectedRing: Pt[] = [[keep.minX - margin, -keep.maxZ - margin], [keep.maxX + margin, -keep.maxZ - margin], [keep.maxX + margin, -keep.minZ + margin], [keep.minX - margin, -keep.minZ + margin]];
  const rawDeckIds = new Set(options.rawSourceDeckPartIds ?? []);
  for (const id of rawDeckIds) assert.ok(parts.some(p => p.id === id && ((p.properties['paatyyppi'] === 'Silta' && p.properties['alatyyppi'] === 'Ajorata (Silta)') || (p.properties['paatyyppi'] === 'Ajorata' && p.properties['alatyyppi'] === 'Ajorata'))), `Raw source deck ${id} is not an exact surveyed carriageway`);
  const eligible: LocalPolygon[] = parts.filter(p => (p.properties['paatyyppi'] === 'Ajorata' && p.properties['alatyyppi'] === 'Ajorata') || rawDeckIds.has(p.id)).flatMap(p => {
    const clipped = polygonClipping.difference([p.rings], [[protectedRing]]) as Pt[][][];
    return clipped.map(rings => ({ ...p, rings, bbox: bbox(rings) }));
  });
  const originals = new Map(parts.map(p => [p.id, p]));
  const nodeSources = new Map<string, Set<LocalPolygon>>(), cellSources = new Map<string, { ix: number; iy: number; polygons: { source: string; rings: Pt[][] }[] }>();
  let footprintArea = 0;
  for (const p of eligible) {
    const [x0, n0, x1, n1] = p.bbox;
    for (let ix = Math.floor(Math.max(x0, area.minX) / grid); ix * grid < Math.min(x1, area.maxX); ix++) for (let iy = Math.floor(Math.max(n0, -area.maxZ) / grid); iy * grid < Math.min(n1, -area.minZ); iy++) {
      const x = ix * grid, n = iy * grid;
      const intersection = polygonClipping.intersection([p.rings], [[[[Math.max(x, area.minX), Math.max(n, -area.maxZ)], [Math.min(x + grid, area.maxX), Math.max(n, -area.maxZ)], [Math.min(x + grid, area.maxX), Math.min(n + grid, -area.minZ)], [Math.max(x, area.minX), Math.min(n + grid, -area.minZ)]]]]) as Pt[][][];
      if (!intersection.length) continue;
      const cellKey = `${ix}:${iy}`, cell = cellSources.get(cellKey) ?? { ix, iy, polygons: [] };
      for (const rings of intersection) { const a = Math.abs(signedArea(rings[0]!)) - rings.slice(1).reduce((s, r) => s + Math.abs(signedArea(r)), 0); if (a < 1e-9) continue; footprintArea += a; cell.polygons.push({ source: p.id, rings }); }
      if (!cell.polygons.length) continue; cellSources.set(cellKey, cell);
      for (const [a, b] of [[ix, iy], [ix + 1, iy], [ix + 1, iy + 1], [ix, iy + 1]]) { const key = `${a}:${b}`, sources = nodeSources.get(key) ?? new Set(); sources.add(originals.get(p.id)!); nodeSources.set(key, sources); }
    }
  }
  const nodes: GradeNode[] = [], nodeIds = new Map<string, number>();
  for (const [key, sourceSet] of nodeSources) {
    const [ix, iy] = key.split(':').map(Number), x = ix! * grid, n = iy! * grid, point: Pt = [x, n];
    // Keep ordinary source slopes at grid corners. Outside a narrow roadway,
    // limit only the contribution of a nearby building/stair extremum relative
    // to its nearest actual source carriageway sample.
    let q = point, distance = Infinity;
    for (const p of sourceSet) {
      if (pointInPolygon(point, p.rings)) { q = point; distance = 0; break; }
      for (const r of p.rings) for (let i = 0; i < r.length; i++) { const match = segmentDistance(point, r[i]!, r[(i + 1) % r.length]!); if (match.d < distance) { q = match.q; distance = match.d; } }
    }
    const reference = sampleTerrain(terrain, q[0], -q[1]), original = sampleTerrain(terrain, x, -n), allowance = Number.isFinite(distance) ? maxAxisGrade * distance + 0.05 : 0;
    const raw = distance === 0 ? original : reference + Math.max(-allowance, Math.min(allowance, original - reference)); assert.ok(Number.isFinite(raw));
    nodeIds.set(key, nodes.length); nodes.push({ x, n, raw, height: raw, sources: [...sourceSet].map(p => p.id).sort() });
  }
  const heights = constrainedGrade(nodes, grid, maxAxisGrade); nodes.forEach((p, i) => p.height = p.sources.some(id => rawDeckIds.has(id)) ? p.raw : heights[i]!);
  const cells: CarriagewayGradeCell[] = [...cellSources.values()].map(c => ({ ...c, nodes: [[c.ix, c.iy], [c.ix + 1, c.iy], [c.ix + 1, c.iy + 1], [c.ix, c.iy + 1]].map(([x, y]) => nodeIds.get(`${x}:${y}`)!) as [number, number, number, number] }));
  const cellMap = new Map(cells.map(c => [`${c.ix}:${c.iy}`, c]));
  const sample = (x: number, n: number): number | null => {
    let ix = Math.floor(x / grid), iy = Math.floor(n / grid), cell = cellMap.get(`${ix}:${iy}`);
    if (!cell) for (const [dx, dy] of [[-1, 0], [0, -1], [-1, -1]]) { const next = cellMap.get(`${ix + dx!}:${iy + dy!}`); if (next && x >= next.ix * grid - 1e-8 && x <= (next.ix + 1) * grid + 1e-8 && n >= next.iy * grid - 1e-8 && n <= (next.iy + 1) * grid + 1e-8) { cell = next; ix = next.ix; iy = next.iy; break; } }
    if (!cell) return null;
    const u = x / grid - ix, v = n / grid - iy, [a, b, c, d] = cell.nodes.map(i => nodes[i]!.height);
    return v <= u ? a! + (b! - a!) * u + (c! - b!) * v : a! + (c! - d!) * u + (d! - a!) * v;
  };
  const rawDeckTieIn = options.rawDeckTieInMetres === undefined ? null : createRawDeckTieIn(nodes, cells, heights, eligible.filter(p => rawDeckIds.has(p.id)), grid, options.rawDeckTieInMetres);
  const changed = nodes.filter(p => Math.abs(p.height - p.raw) > 1e-7);
  const protectedSurfaces = parts.filter(p => (p.properties['paatyyppi'] === 'Silta' && !rawDeckIds.has(p.id)) || (p.properties['paatyyppi'] === 'Varusteet' && p.properties['alatyyppi'] === 'Tukimuuri') || (p.properties['paatyyppi'] === 'Muut alueet' && p.properties['alatyyppi'] === 'Avokallio'));
  return { parts: eligible, protectedSurfaces, nodes, cells, sample: rawDeckTieIn?.sample ?? sample, rawDeckTieIn, options, stats: { parts: new Set(cells.flatMap(c => c.polygons.map(p => p.source))).size, cells: cells.length, nodes: nodes.length, changedNodes: changed.length,
    footprintArea, maxSourceSampleCorrectionMetres: changed.reduce((m, p) => Math.max(m, Math.abs(p.height - p.raw)), 0), changedNodeBoundsENU: changed.length ? bbox([changed.map(p => [p.x, p.n] as Pt)]) : null,
    gridMetres: grid, maxAxisGrade, rawSourceDeckPartIds: [...rawDeckIds], rawDeckTieInMetres: rawDeckTieIn?.width ?? null, authoringPolicy: 'Midpoint of source-derived upper/lower grade envelopes; no absolute heights invented; source terrain and other bridges remain unchanged' } };
}

type Vertex = [number, number, number, number, number]; // runtime xyz, uv
type Geometry = Pt[][][];
const geometryArea = (g: Geometry) => g.reduce((sum, p) => sum + Math.abs(signedArea(p[0]!)) - p.slice(1).reduce((s, r) => s + Math.abs(signedArea(r)), 0), 0);
function stableClip(operation: 'intersection' | 'difference', a: Geometry, b: Geometry, onPrecisionRetry: () => void): Geometry {
  try { return polygonClipping[operation](a, b) as Geometry; }
  catch (original) {
    // Double-precision source rings can meet a grid edge within 1e-13m. Retry
    // on a common 0.1 micrometre lattice, far below runtime Float32 precision.
    // Never skip a failed polygon, which would silently open a support hole.
    const snap = (g: Geometry): Geometry => g.map(p => p.map(r => r.map(([x, n]) => [Math.round(x * 1e7) / 1e7, Math.round(n * 1e7) / 1e7])));
    try { const result = polygonClipping[operation](snap(a), snap(b)) as Geometry; onPrecisionRetry(); return result; }
    catch (retry) { throw new AggregateError([original, retry], `Carriageway ${operation} failed at source and 0.1um precision`); }
  }
}

/** Remove only the source carriageway footprint, including vertical wall wedges
 * that incorrectly crossed it. Unaffected pieces retain identity and ordering. */
export function clipGroundForCarriageways(pieces: readonly GroundPiece[], footprints: readonly LocalPolygon[], keepInside = false) {
  const grid = new PolygonGrid(footprints, 16), output: GroundPiece[] = [];
  let changedPieces = 0, removedTriangles = 0, precisionRetries = 0;
  for (const piece of pieces) {
    const positions = piece.positions.slice(), uvs = piece.uvs.slice(), indices: number[] = [];
    let changed = false;
    const append = (vertices: Vertex[]) => {
      const base = positions.length / 3;
      for (const v of vertices) { positions.push(v[0], v[1], v[2]); uvs.push(v[3], v[4]); }
      for (let i = 1; i + 1 < vertices.length; i++) indices.push(base, base + i, base + i + 1);
    };
    for (let i = 0; i < piece.indices.length; i += 3) {
      const ids = piece.indices.slice(i, i + 3), vertices = ids.map(id => [...piece.positions.slice(id * 3, id * 3 + 3), ...piece.uvs.slice(id * 2, id * 2 + 2)] as Vertex);
      const projected = vertices.map(v => [v[0], -v[2]] as Pt), box = bbox([projected]);
      const near = new Set<LocalPolygon>();
      for (let x = Math.floor(box[0] / 16); x <= Math.floor(box[2] / 16); x++) for (let n = Math.floor(box[1] / 16); n <= Math.floor(box[3] / 16); n++) for (const p of grid.candidates(x * 16, n * 16)) if (p.bbox[0] <= box[2] && p.bbox[2] >= box[0] && p.bbox[1] <= box[3] && p.bbox[3] >= box[1]) near.add(p);
      if (!near.size) { if (!keepInside) indices.push(...ids); else changed = true; continue; }
      const inside = (p: Pt) => [...near].some(f => pointInPolygon(p, f.rings));
      const area = signedArea(projected);
      if (Math.abs(area) < 1e-9) {
        // Project a vertical face onto its longest horizontal edge. Split its
        // true 3D geometry at source polygon crossings instead of dropping the
        // entire wall or pretending its zero projected area means no overlap.
        const pair = [[0, 1], [1, 2], [2, 0]].sort(([a, b], [c, d]) => Math.hypot(projected[d!]![0] - projected[c!]![0], projected[d!]![1] - projected[c!]![1]) - Math.hypot(projected[b!]![0] - projected[a!]![0], projected[b!]![1] - projected[a!]![1]))[0]!;
        const a = projected[pair[0]!]!, b = projected[pair[1]!]!, dx = b[0] - a[0], dn = b[1] - a[1], length2 = dx * dx + dn * dn;
        if (length2 < 1e-16) { indices.push(...ids); continue; }
        const ts = [0, 1];
        for (const p of near) for (const r of p.rings) for (let k = 0; k < r.length; k++) { const c = r[k]!, d = r[(k + 1) % r.length]!, ex = d[0] - c[0], en = d[1] - c[1], den = dx * en - dn * ex; if (Math.abs(den) < 1e-12) continue;
          const t = ((c[0] - a[0]) * en - (c[1] - a[1]) * ex) / den, u = ((c[0] - a[0]) * dn - (c[1] - a[1]) * dx) / den; if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t); }
        ts.sort((a, b) => a - b);
        if (!ts.slice(0, -1).some((t, k) => inside([a[0] + dx * (t + ts[k + 1]!) / 2, a[1] + dn * (t + ts[k + 1]!) / 2]))) { if (!keepInside) indices.push(...ids); else changed = true; continue; }
        changed = true; removedTriangles++;
        const scalar = (v: Vertex) => ((v[0] - a[0]) * dx + (-v[2] - a[1]) * dn) / length2;
        const clip = (input: Vertex[], edge: number, above: boolean): Vertex[] => { const out: Vertex[] = []; for (let k = 0; k < input.length; k++) { const p = input[k]!, q = input[(k + 1) % input.length]!, s = scalar(p), t = scalar(q), pIn = above ? s >= edge : s <= edge, qIn = above ? t >= edge : t <= edge; if (pIn) out.push(p); if (pIn !== qIn) { const f = (edge - s) / (t - s); out.push(p.map((v, axis) => v + (q[axis]! - v) * f) as Vertex); } } return out; };
        for (let k = 0; k + 1 < ts.length; k++) if (ts[k + 1]! - ts[k]! > 1e-9 && inside([a[0] + dx * (ts[k]! + ts[k + 1]!) / 2, a[1] + dn * (ts[k]! + ts[k + 1]!) / 2]) === keepInside) append(clip(clip(vertices, ts[k]!, true), ts[k + 1]!, false));
        continue;
      }
      const cut = [...near].map(p => p.rings), overlap = stableClip('intersection', [[projected]], cut, () => precisionRetries++);
      if (geometryArea(overlap) < 1e-9) { if (!keepInside) indices.push(...ids); else changed = true; continue; }
      changed = true; removedTriangles++;
      const rest = keepInside ? overlap : stableClip('difference', [[projected]], cut, () => precisionRetries++), [a, b, c] = projected as [Pt, Pt, Pt], den = area * 2;
      for (const polygon of rest) {
        const flat: number[] = [], holes: number[] = []; polygon.forEach((ring, k) => { if (k) holes.push(flat.length / 2); for (const p of cleanRing(ring)) flat.push(...p); });
        const triangles = earcut(flat, holes, 2), base = positions.length / 3;
        for (let k = 0; k < flat.length; k += 2) { const x = flat[k]!, n = flat[k + 1]!, u = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (n - c[1])) / den, v = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (n - c[1])) / den;
          const at = (axis: number) => vertices[0]![axis]! * u + vertices[1]![axis]! * v + vertices[2]![axis]! * (1 - u - v);
          positions.push(x, at(1), -n); uvs.push(at(3), at(4)); }
        for (let k = 0; k < triangles.length; k += 3) { const [a, b, c] = triangles.slice(k, k + 3); indices.push(base + a!, base + (area > 0 ? b! : c!), base + (area > 0 ? c! : b!)); }
      }
    }
    if (!changed) output.push(piece);
    else { changedPieces++; if (indices.length) output.push({ ...piece, positions, uvs, indices }); }
  }
  return { pieces: output, changedPieces, removedTriangles, precisionRetries };
}

function roadFinish(p: LocalPolygon): Finish {
  const mat = String(p.properties['materiaali'] ?? '').toLowerCase();
  if (mat.includes('nupukivi')) return 'setts';
  if (mat.includes('noppakivi') || mat.includes('kenttäkivi') || mat.includes('mukulakivi')) return 'cobble';
  if (mat.includes('laatta') || mat.includes('betonikivi') || mat.includes('graniitti')) return 'slabs';
  if (mat.includes('sora') || mat.includes('kivituhka') || mat.includes('hiekka')) return 'gravel';
  return 'asphalt';
}

/** Shared planar triangles prevent T-junctions sampling different terrain
 * chords. The source polygon remains the exact lateral limit of every road. */
function meshCarriagewayGradeLegacy(grade: ReturnType<typeof buildCarriagewayGrade>, cellSize: number, onPrecisionRetry: () => void) {
  const pieces: GroundPiece[] = [], source = new Map(grade.parts.map(p => [p.id, p])), grid = grade.stats.gridMetres;
  for (const cell of grade.cells) {
    const x = cell.ix * grid, n = cell.iy * grid, corners: Pt[] = [[x, n], [x + grid, n], [x + grid, n + grid], [x, n + grid]];
    const h = cell.nodes.map(i => grade.nodes[i]!.height), groups = new Map<Finish, Geometry>(); let claimed: Geometry = [];
    for (const p of cell.polygons) {
      const finish = roadFinish(source.get(p.source)!), original = [p.rings], available = claimed.length ? stableClip('difference', original, claimed, onPrecisionRetry) : original;
      if (!available.length) continue; claimed = claimed.length ? polygonClipping.union(claimed, available) as Geometry : available;
      const old = groups.get(finish) ?? []; groups.set(finish, [...old, ...available]);
    }
    for (const [finish, geom] of groups) {
      const positions: number[] = [], uvs: number[] = [], indices: number[] = [], scale = finish === 'asphalt' ? 6 : finish === 'setts' || finish === 'cobble' ? 2 : finish === 'gravel' ? 4 : 3;
      for (const ids of [[0, 1, 2], [0, 2, 3]]) {
        const triangle = ids.map(i => corners[i]!), clipped = stableClip('intersection', geom, [[triangle]], onPrecisionRetry);
        for (const polygon of clipped) {
          const flat: number[] = [], holes: number[] = []; polygon.forEach((r, i) => { if (i) holes.push(flat.length / 2); for (const p of cleanRing(r)) flat.push(...p); });
          const ix = earcut(flat, holes, 2), base = positions.length / 3;
          for (let i = 0; i < flat.length; i += 2) { const px = flat[i]!, pn = flat[i + 1]!, u = (px - x) / grid, v = (pn - n) / grid;
            const height = ids[1] === 1 ? h[0]! + (h[1]! - h[0]!) * u + (h[2]! - h[1]!) * v : h[0]! + (h[2]! - h[3]!) * u + (h[3]! - h[0]!) * v;
            positions.push(px, height, -pn); uvs.push(px / scale, pn / scale); }
          for (const i of ix) indices.push(base + i);
        }
      }
      if (indices.length) pieces.push({ cell: cellId(...cellIndexFor(x + grid / 2, -(n + grid / 2), cellSize)), finish, level: 'road', tag: `road:${finish}`, positions, uvs, indices });
    }
  }
  return pieces;
}

export function meshCarriagewayGrade(grade: ReturnType<typeof buildCarriagewayGrade>, cellSize: number, onPrecisionRetry: () => void = () => {}) {
  return meshRawDeckTieIn(grade, cellSize, (field, size) => meshCarriagewayGradeLegacy(field, size, onPrecisionRetry));
}

type HeightTriangle = { points: [number, number, number][]; den: number; level: string; tag: string };
export function createGroundSupportSampler(pieces: readonly GroundPiece[]) {
  const buckets = new Map<string, HeightTriangle[]>();
  for (const p of pieces) for (let i = 0; i < p.indices.length; i += 3) {
    const points = [0, 1, 2].map(k => p.positions.slice(p.indices[i + k]! * 3, p.indices[i + k]! * 3 + 3) as [number, number, number]);
    const [a, b, c] = points as [[number, number, number], [number, number, number], [number, number, number]], den = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
    if (Math.abs(den) < 1e-10) continue;
    const triangle = { points, den, level: p.level, tag: p.tag };
    for (let x = Math.floor(Math.min(...points.map(p => p[0])) / 4); x <= Math.floor(Math.max(...points.map(p => p[0])) / 4); x++) for (let z = Math.floor(Math.min(...points.map(p => p[2])) / 4); z <= Math.floor(Math.max(...points.map(p => p[2])) / 4); z++) {
      const key = `${x}:${z}`, list = buckets.get(key) ?? []; list.push(triangle); buckets.set(key, list);
    }
  }
  const interpolate = (t: HeightTriangle, x: number, z: number) => {
    const [a, b, c] = t.points as [[number, number, number], [number, number, number], [number, number, number]], u = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / t.den, v = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / t.den;
    return { inside: u >= -1e-8 && v >= -1e-8 && u + v <= 1 + 1e-8, height: u * a[1] + v * b[1] + (1 - u - v) * c[1] };
  };
  return (x: number, z: number, atX = x, atZ = z) => {
    let best: { height: number; level: string; tag: string } | null = null;
    for (const t of buckets.get(`${Math.floor(x / 4)}:${Math.floor(z / 4)}`) ?? []) { const q = interpolate(t, x, z); if (q.inside && (!best || q.height > best.height)) best = { height: interpolate(t, atX, atZ).height, level: t.level, tag: t.tag }; }
    return best;
  };
}

/** Match the road's grid and diagonals before applying a nonlinear transition.
 * Otherwise an old long sidewalk edge can span a new road-plane breakpoint,
 * recreating a T-junction height seam despite agreeing endpoint samples. */
function splitAtGradeGrid(piece: GroundPiece, grid: number): GroundPiece {
  const positions: number[] = [], uvs: number[] = [], indices: number[] = [];
  const clip = (input: Vertex[], distance: (v: Vertex) => number): Vertex[] => {
    const out: Vertex[] = [];
    for (let i = 0; i < input.length; i++) {
      const a = input[i]!, b = input[(i + 1) % input.length]!, da = distance(a), db = distance(b), aIn = da >= -1e-10, bIn = db >= -1e-10;
      if (aIn) out.push(a);
      if (aIn !== bIn) { const t = da / (da - db); out.push(a.map((v, k) => v + (b[k]! - v) * t) as Vertex); }
    }
    return out;
  };
  const append = (polygon: Vertex[]) => {
    for (let i = 1; i + 1 < polygon.length; i++) {
      const [a, b, c] = [polygon[0]!, polygon[i]!, polygon[i + 1]!], u = b.map((v, k) => v - a[k]!), v = c.map((v, k) => v - a[k]!);
      if (Math.hypot(u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!) < 1e-12) continue;
      for (const p of [a, b, c]) { indices.push(positions.length / 3); positions.push(p[0], p[1], p[2]); uvs.push(p[3], p[4]); }
    }
  };
  for (let i = 0; i < piece.indices.length; i += 3) {
    const triangle = [0, 1, 2].map(k => { const id = piece.indices[i + k]!; return [...piece.positions.slice(id * 3, id * 3 + 3), ...piece.uvs.slice(id * 2, id * 2 + 2)] as Vertex; });
    const minX = Math.min(...triangle.map(v => v[0])), maxX = Math.max(...triangle.map(v => v[0])), minN = Math.min(...triangle.map(v => -v[2])), maxN = Math.max(...triangle.map(v => -v[2]));
    const ix0 = Math.floor(minX / grid), ix1 = Math.max(ix0, Math.ceil(maxX / grid) - 1), iy0 = Math.floor(minN / grid), iy1 = Math.max(iy0, Math.ceil(maxN / grid) - 1);
    for (let ix = ix0; ix <= ix1; ix++) for (let iy = iy0; iy <= iy1; iy++) {
      const x = ix * grid, n = iy * grid;
      const polygon = clip(clip(clip(clip(triangle, v => v[0] - x), v => x + grid - v[0]), v => -v[2] - n), v => n + grid + v[2]);
      if (polygon.length < 3) continue;
      const diagonal = (v: Vertex) => (v[0] - x) - (-v[2] - n);
      append(clip(polygon, diagonal));
      if (!polygon.every(v => Math.abs(diagonal(v)) < 1e-9)) append(clip(polygon, v => -diagonal(v)));
    }
  }
  return { ...piece, positions, uvs, indices };
}

/** One shared displacement at each horizontal coordinate keeps existing
 * sidewalk/fallback/kerb/wall joints together. It reaches the corrected road
 * plus the intended curb and fades to the original ground within 4-16 m. */
function buildRoadTransition(pieces: readonly GroundPiece[], boundaries: readonly SurfaceBoundary[], grade: ReturnType<typeof buildCarriagewayGrade>, foundations: readonly LocalPolygon[]) {
  const support = createGroundSupportSampler(pieces), protectedGrid = new PolygonGrid(grade.protectedSurfaces, 16), foundationGrid = new PolygonGrid(foundations, 16), keep = grade.options.protectedArea, margin = grade.options.protectedMarginMetres ?? grade.stats.gridMetres * 2;
  type Segment = { a: Pt; b: Pt; heightA: number; heightB: number; radius: number };
  const segments: Segment[] = [], buckets = new Map<string, Segment[]>();
  let missingExteriorSamples = 0, maxBoundaryDisplacement = 0;
  for (const edge of boundaries) {
    const length = Math.hypot(edge.b[0] - edge.a[0], edge.b[2] - edge.a[2]), count = Math.max(1, Math.ceil(length / 0.5));
    const samples = Array.from({ length: count + 1 }, (_, i) => {
      const t = i / count, x = edge.a[0] + (edge.b[0] - edge.a[0]) * t, z = edge.a[2] + (edge.b[2] - edge.a[2]) * t, newHeight = edge.a[1] + (edge.b[1] - edge.a[1]) * t;
      let old = null;
      for (const distance of [1e-4, 0.01, 0.05, 0.25, 0.5, 1]) { old = support(x + edge.outside[0] * distance, z + edge.outside[1] * distance, x, z); if (old) break; }
      if (!old) missingExteriorSamples++;
      // The road is the boundary constraint even where the previous wall cut
      // had no support immediately outside it. Exterior samples set only the
      // feather width, never whether that boundary anchor exists.
      const delta = old ? newHeight + (old.level === 'raised' ? 0.12 : old.tag === 'raised:yard' ? -0.03 : 0) - old.height : 0;
      maxBoundaryDisplacement = Math.max(maxBoundaryDisplacement, Math.abs(delta));
      return { point: [x, -z] as Pt, delta, height: newHeight };
    });
    for (let i = 0; i < count; i++) {
      const a = samples[i], b = samples[i + 1]; if (!a || !b) continue;
      const radius = Math.min(16, Math.max(4, Math.max(Math.abs(a.delta), Math.abs(b.delta)) / 0.25)), segment = { a: a.point, b: b.point, heightA: a.height, heightB: b.height, radius };
      segments.push(segment);
      for (let x = Math.floor((Math.min(a.point[0], b.point[0]) - radius) / 4); x <= Math.floor((Math.max(a.point[0], b.point[0]) + radius) / 4); x++) for (let n = Math.floor((Math.min(a.point[1], b.point[1]) - radius) / 4); n <= Math.floor((Math.max(a.point[1], b.point[1]) + radius) / 4); n++) { const key = `${x}:${n}`, list = buckets.get(key) ?? []; list.push(segment); buckets.set(key, list); }
    }
  }
  const cache = new Map<string, { base: number; weight: number } | null>();
  const sample = (x: number, z: number, ordinarySide = false): { base: number; weight: number } | null => {
    if (x >= keep.minX - margin && x <= keep.maxX + margin && z >= keep.minZ - margin && z <= keep.maxZ + margin) return null;
    if (!ordinarySide && protectedGrid.candidates(x, -z).some(p => pointInPolygon([x, -z], p.rings) || p.rings.some(r => ringDistance([x, -z], r) < 1e-6))) return null;
    const key = `${x}:${z}`, cached = cache.get(key); if (cached !== undefined) return cached;
    const nearbyFoundations = new Set<LocalPolygon>();
    for (const dx of [-2, 0, 2]) for (const dn of [-2, 0, 2]) for (const p of foundationGrid.candidates(x + dx, -z + dn)) nearbyFoundations.add(p);
    let foundationDistance = Infinity;
    for (const p of nearbyFoundations) { if (pointInPolygon([x, -z], p.rings)) { cache.set(key, null); return null; } for (const r of p.rings) foundationDistance = Math.min(foundationDistance, ringDistance([x, -z], r)); }
    if (foundationDistance <= 0.1) { cache.set(key, null); return null; }
    const foundationT = Math.min(1, Math.max(0, (foundationDistance - 0.1) / 2)), foundationWeight = foundationT * foundationT * (3 - 2 * foundationT);
    let sum = 0, fades = 0, weights = 0;
    for (const s of buckets.get(`${Math.floor(x / 4)}:${Math.floor(-z / 4)}`) ?? []) {
      const q = segmentDistance([x, -z], s.a, s.b); if (q.d >= s.radius) continue;
      const weight = 1 / Math.max(q.d, 1e-4) ** 4, t = q.d / s.radius, fade = 1 - t * t * (3 - 2 * t);
      sum += (s.heightA + (s.heightB - s.heightA) * q.t) * weight; fades += fade * weight; weights += weight;
    }
    const result = weights ? { base: sum / weights, weight: fades / weights * foundationWeight } : null; cache.set(key, result); return result;
  };
  let changedVertices = 0, maxDisplacement = 0;
  const apply = (input: readonly GroundPiece[], protectedPieces: GroundPiece[]): GroundPiece[] => input.flatMap(original => {
    let active = false;
    for (let i = 0; i < original.positions.length && !active; i += 3) active = (sample(original.positions[i]!, original.positions[i + 2]!)?.weight ?? 0) > 1e-9;
    if (!active) return [original];
    // A triangle can straddle a rock/deck boundary a few centimetres from the
    // roadway. Pinning one vertex then interpolates its old height back across
    // the corrected curb. Split at the exact source mask; duplicate boundary
    // vertices let the ordinary side follow the road without flattening rock.
    const ordinary = clipGroundForCarriageways([original], grade.protectedSurfaces).pieces;
    protectedPieces.push(...clipGroundForCarriageways([original], grade.protectedSurfaces, true).pieces);
    return ordinary.map(part => {
    const p = splitAtGradeGrid(part, grade.stats.gridMetres);
    let positions: number[] | null = null;
    for (let i = 0; i < p.positions.length; i += 3) {
      const q = sample(p.positions[i]!, p.positions[i + 2]!, true); if (!q) continue;
      const target = q.base + (p.level === 'raised' ? 0.12 : p.tag === 'raised:yard' ? -0.03 : 0), delta = q.weight * (target - p.positions[i + 1]!); if (Math.abs(delta) < 1e-7) continue;
      if (!positions) positions = p.positions.slice(); positions[i + 1] = p.positions[i + 1]! + delta; changedVertices++; maxDisplacement = Math.max(maxDisplacement, Math.abs(delta));
    }
    return positions ? { ...p, positions } : part;
    });
  });
  const at = (x: number, z: number): number => { const q = sample(x, z), old = support(x, z); return q && old ? q.weight * (q.base + (old.level === 'raised' ? 0.12 : old.tag === 'raised:yard' ? -0.03 : 0) - old.height) : 0; };
  return { at, sample, apply, stats: () => ({ segments: segments.length, missingExteriorSamples, maxBoundaryDisplacement, changedVertices, maxDisplacement, maximumFeatherMetres: 16, transitionPolicy: 'Shared absolute road grade with intended raised curb, smooth compact blend to existing exterior surfaces; exact source rock/deck split; zero at registered foundations and accepted margin' }) };
}

function sourceMaskBoundaries(pieces: readonly GroundPiece[], mask: PolygonGrid<LocalPolygon>): SurfaceBoundary[] {
  const boundaries: SurfaceBoundary[] = [], inside = (x: number, z: number) => mask.containing(x, -z).length > 0;
  for (const p of pieces) {
    const edges = new Map<string, { a: number; b: number; count: number }>();
    for (let i = 0; i < p.indices.length; i += 3) for (let k = 0; k < 3; k++) { const a = p.indices[i + k]!, b = p.indices[i + (k + 1) % 3]!, key = a < b ? `${a}:${b}` : `${b}:${a}`, e = edges.get(key) ?? { a, b, count: 0 }; e.count++; edges.set(key, e); }
    for (const e of edges.values()) if (e.count === 1) {
      const a = p.positions.slice(e.a * 3, e.a * 3 + 3) as [number, number, number], b = p.positions.slice(e.b * 3, e.b * 3 + 3) as [number, number, number], dx = b[0] - a[0], dz = b[2] - a[2], length = Math.hypot(dx, dz); if (length < 1e-9) continue;
      const nx = dz / length, nz = -dx / length, mx = (a[0] + b[0]) / 2, mz = (a[2] + b[2]) / 2, left = inside(mx + nx * 1e-5, mz + nz * 1e-5), right = inside(mx - nx * 1e-5, mz - nz * 1e-5);
      if (left === right) continue; boundaries.push({ a, b, outside: left ? [-nx, -nz] : [nx, nz] });
    }
  }
  return boundaries;
}

export function applyCarriagewayGrade(pieces: readonly GroundPiece[], kerbs: readonly GroundPiece[], grade: ReturnType<typeof buildCarriagewayGrade>, cellSize: number, foundations: readonly LocalPolygon[] = []) {
  let roadMeshPrecisionRetries = 0;
  const clipped = clipGroundForCarriageways(pieces, grade.parts), clippedKerbs = clipGroundForCarriageways(kerbs, grade.parts), roads = meshCarriagewayGrade(grade, cellSize, () => roadMeshPrecisionRetries++);
  const boundaries = sourceMaskBoundaries(roads, new PolygonGrid(grade.parts, 16));
  const transition = buildRoadTransition([...pieces, ...kerbs], boundaries, grade, foundations), protectedPieces: GroundPiece[] = [], protectedKerbs: GroundPiece[] = [];
  const outside = transition.apply(clipped.pieces, protectedPieces), outsideKerbs = transition.apply(clippedKerbs.pieces, protectedKerbs);
  const protectedBoundaries = sourceMaskBoundaries([...protectedPieces, ...protectedKerbs], new PolygonGrid(grade.protectedSurfaces, 16));
  // The protected source top is unchanged. A vertical side at its actual mask
  // boundary closes any opening to the separately graded ordinary surface.
  const protectedJoins = closeSurfaceBoundaries([...outside, ...outsideKerbs, ...roads], protectedBoundaries, cellSize, true);
  const joins = closeSurfaceBoundaries([...outside, ...outsideKerbs, ...protectedPieces, ...protectedKerbs], boundaries, cellSize, true);
  let maxJoinVerticalGap = 0, maxOrdinaryCurbGap = 0, protectedBoundaryJoins = 0;
  const ordinaryCurbFlags: { x: number; z: number; gap: number }[] = [];
  const protectedGrid = new PolygonGrid(grade.protectedSurfaces, 16), foundationGrid = new PolygonGrid(foundations, 16);
  for (const p of joins) {
    let protectedBoundary = false, gap = 0;
    for (let a = 0; a < p.positions.length; a += 3) {
      const x = p.positions[a]!, n = -p.positions[a + 2]!;
      if (protectedGrid.candidates(x, n).some(s => pointInPolygon([x, n], s.rings) || s.rings.some(r => ringDistance([x, n], r) < 0.02))) protectedBoundary = true;
      for (const dx of [-2.1, 0, 2.1]) for (const dn of [-2.1, 0, 2.1]) if (foundationGrid.candidates(x + dx, n + dn).some(s => pointInPolygon([x, n], s.rings) || s.rings.some(r => ringDistance([x, n], r) < 2.1))) protectedBoundary = true;
      for (let b = a + 3; b < p.positions.length; b += 3) if (Math.hypot(p.positions[a]! - p.positions[b]!, p.positions[a + 2]! - p.positions[b + 2]!) < 1e-6) gap = Math.max(gap, Math.abs(p.positions[a + 1]! - p.positions[b + 1]!));
    }
    maxJoinVerticalGap = Math.max(maxJoinVerticalGap, gap);
    if (protectedBoundary) protectedBoundaryJoins++; else { maxOrdinaryCurbGap = Math.max(maxOrdinaryCurbGap, gap); if (gap > 0.2) ordinaryCurbFlags.push({ x: p.positions[0]!, z: p.positions[2]!, gap }); }
  }
  return { pieces: [...outside, ...protectedPieces, ...roads, ...joins, ...protectedJoins], kerbs: [...outsideKerbs, ...protectedKerbs], roads, joins, protectedJoins, transitionAt: transition.at, transitionSample: transition.sample,
    stats: { ...grade.stats, clippedPieces: clipped.changedPieces, clippedKerbPieces: clippedKerbs.changedPieces, removedTriangles: clipped.removedTriangles + clippedKerbs.removedTriangles, precisionRetries: clipped.precisionRetries + clippedKerbs.precisionRetries + roadMeshPrecisionRetries, roadMeshPrecisionRetries, roadPieces: roads.length, joinPieces: joins.length, protectedSourceJoins: protectedJoins.length, maxJoinVerticalGap, maxOrdinaryCurbGap, protectedBoundaryJoins, ordinaryCurbFlags: ordinaryCurbFlags.sort((a, b) => b.gap - a.gap).slice(0, 20), transition: transition.stats() } };
}
