// Close evidenced vertical cracks between independently tessellated ground tops.
// This is separate from wall/curb-bottom qualification: neither existing floor
// nor an existing wall is moved or reclassified to manufacture ownership.
import assert from 'node:assert/strict';
import polygonClipping from 'polygon-clipping';
import { pointInPolygon, ringDistance, type LocalPolygon, type Pt } from './geometry.ts';
import { meshVerticalSeals } from './vertical-seal-mesh.ts';

export type FloorPoint = [number, number, number];
export interface FloorSource { id: string; cell: string; positions: ArrayLike<number>; indices: ArrayLike<number>; triangleTags: readonly string[] }
export interface FloorInterfaceOptions {
  protectedArea: { minX: number; maxX: number; minZ: number; maxZ: number };
  protectedMarginMetres?: number; wallMasks?: readonly LocalPolygon[];
  waterMasks?: readonly LocalPolygon[]; registeredDecks?: readonly LocalPolygon[];
  maximumGapMetres?: number; floatToleranceMetres?: number;
}
export interface FloorInterfaceSeal {
  cell: string; sourceId: string; sideTag: 'wall';
  upperSourceId: string; upperTriangle: number; upperTag: string;
  lowerSourceId: string; lowerTriangle: number; lowerTag: string;
  top: [FloorPoint, FloorPoint]; bottom: [FloorPoint, FloorPoint];
  gap: [number, number]; sourceFloorGap: [number, number]; length: number; polygon: FloorPoint[][]; section: Pt[][];
  actualUpperEdge: [FloorPoint, FloorPoint]; actualLowerEdge: [FloorPoint, FloorPoint];
  existingCoverageTriangles: { sourceId: string; triangle: number }[];
}
interface Triangle { source: FloorSource; triangle: number; p: FloorPoint[]; tag: string; normalY: number; den: number }
interface Edge { a: FloorPoint; b: FloorPoint; third: FloorPoint; triangle: Triangle; count: number }
interface Line { lo: number; hi: number; ya: number; yb: number }
interface FloorLine extends Line { edge: Edge; side: number }
interface MaskInterval { lo: number; hi: number; kind: 'accepted' | 'wall' | 'water' | 'deck'; id: string }
const xyz = (p: FloorPoint) => p.join(',');
const height = (line: Line, t: number) => line.ya + (line.yb - line.ya) * (t - line.lo) / (line.hi - line.lo);
const at = (a: FloorPoint, b: FloorPoint, f: number): FloorPoint => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
function planeHeight(triangle: Triangle, x: number, z: number) {
  const [a, b, c] = triangle.p as [FloorPoint, FloorPoint, FloorPoint], u = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / triangle.den, v = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / triangle.den;
  return { height: u * a[1] + v * b[1] + (1 - u - v) * c[1], inside: u >= -1e-8 && v >= -1e-8 && u + v <= 1 + 1e-8 };
}
function buckets(points: readonly FloorPoint[], tolerance = 0): string[] {
  const result: string[] = [];
  for (let x = Math.floor((Math.min(...points.map(p => p[0])) - tolerance) / 4); x <= Math.floor((Math.max(...points.map(p => p[0])) + tolerance) / 4); x++)
    for (let z = Math.floor((Math.min(...points.map(p => p[2])) - tolerance) / 4); z <= Math.floor((Math.max(...points.map(p => p[2])) + tolerance) / 4); z++) result.push(`${x}:${z}`);
  return result;
}
function splitValues(lines: readonly Line[], extra: readonly number[]) {
  const values = [...extra, ...lines.flatMap(l => [l.lo, l.hi])];
  for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
    const a = lines[i]!, b = lines[j]!, lo = Math.max(a.lo, b.lo), hi = Math.min(a.hi, b.hi); if (hi <= lo) continue;
    const d0 = height(a, lo) - height(b, lo), d1 = height(a, hi) - height(b, hi);
    if (d0 * d1 < 0) values.push(lo + (hi - lo) * d0 / (d0 - d1));
  }
  values.sort((a, b) => a - b); return values.filter((v, i) => !i || v - values[i - 1]! > 1e-9);
}
function minimumConvexWidth(ring: readonly Pt[]) {
  let width = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!, dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy);
    if (length < 1e-15) continue;
    const offsets = ring.map(p => ((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / length);
    width = Math.min(width, Math.max(...offsets) - Math.min(...offsets));
  }
  return Number.isFinite(width) ? width : 0;
}
/** Near-parallel source boundaries can independently qualify despite having
 * competing soil ownership. Withhold both physical veneers rather than choose
 * a floor or discard source geometry to make the additions fit. */
function ambiguousAdditionSeals(seals: readonly FloorInterfaceSeal[], tolerance: number) {
  const records = seals.map((seal, i) => ({ seal, i, points: [seal.top[0], seal.top[1], seal.bottom[1], seal.bottom[0]].map(p => p.map(Math.fround) as FloorPoint) }));
  const grid = new Map<string, number[]>(), ambiguous = new Set<number>();
  for (const record of records) for (const k of buckets(record.points, tolerance)) { const key = `${record.seal.cell}:${k}`, old = grid.get(key) ?? []; old.push(record.i); grid.set(key, old); }
  for (const a of records) {
    const start = a.points[0]!, dx = a.points[1]![0] - start[0], dz = a.points[1]![2] - start[2], length = Math.hypot(dx, dz); if (length === 0) continue;
    const project = (p: FloorPoint): Pt => [((p[0] - start[0]) * dx + (p[2] - start[2]) * dz) / length, p[1]];
    const ring = a.points.map(project), minY = Math.min(...ring.map(p => p[1])), maxY = Math.max(...ring.map(p => p[1]));
    const nearby = new Set(buckets(a.points, tolerance).flatMap(k => grid.get(`${a.seal.cell}:${k}`) ?? []));
    for (const i of nearby) {
      if (i <= a.i) continue; const b = records[i]!;
      if (b.points.some(p => Math.abs((p[0] - start[0]) * dz - (p[2] - start[2]) * dx) / length > tolerance)) continue;
      const other = b.points.map(project), xs = other.map(p => p[0]), ys = other.map(p => p[1]);
      if (Math.min(...xs) >= length || Math.max(...xs) <= 0 || Math.min(...ys) >= maxY || Math.max(...ys) <= minY) continue;
      const intersection = polygonClipping.intersection([[ring]], [[other]]) as Pt[][][];
      if (!intersection.some(poly => minimumConvexWidth(poly[0]!) > tolerance)) continue;
      ambiguous.add(a.i); ambiguous.add(i);
    }
  }
  return ambiguous;
}
function maskIntervals(polygon: LocalPolygon, reference: Edge, unit: [number, number], lo: number, hi: number, kind: MaskInterval['kind'], tolerance: number): MaskInterval[] {
  const A = [reference.a[0] + unit[0] * lo, -(reference.a[2] + unit[1] * lo)], B = [reference.a[0] + unit[0] * hi, -(reference.a[2] + unit[1] * hi)];
  if (Math.max(A[0]!, B[0]!) < polygon.bbox[0] - tolerance || Math.min(A[0]!, B[0]!) > polygon.bbox[2] + tolerance || Math.max(A[1]!, B[1]!) < polygon.bbox[1] - tolerance || Math.min(A[1]!, B[1]!) > polygon.bbox[3] + tolerance) return [];
  const values = [lo, hi];
  for (const ring of polygon.rings) for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!, ex = b[0] - a[0], ez = -b[1] + a[1], ax = a[0] - reference.a[0], az = -a[1] - reference.a[2], den = unit[0] * ez - unit[1] * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = (ax * ez - az * ex) / den, u = (ax * unit[1] - az * unit[0]) / den;
    if (t > lo && t < hi && u >= 0 && u <= 1) values.push(t);
  }
  values.sort((a, b) => a - b);
  return values.slice(0, -1).flatMap((a, i) => {
    const b = values[i + 1]!, t = (a + b) / 2, p: Pt = [reference.a[0] + unit[0] * t, -(reference.a[2] + unit[1] * t)];
    return b - a > 1e-9 && (pointInPolygon(p, polygon.rings) || polygon.rings.some(r => ringDistance(p, r) <= tolerance)) ? [{ lo: a, hi: b, kind, id: polygon.id }] : [];
  });
}

export function findFloorInterfaceSeals(sources: readonly FloorSource[], options: FloorInterfaceOptions) {
  const tolerance = options.floatToleranceMetres ?? .0001, maximumGap = options.maximumGapMetres ?? .15;
  assert.ok(tolerance > 0 && tolerance <= .0002); assert.ok(maximumGap > 0 && maximumGap <= .15);
  const margin = options.protectedMarginMetres ?? 0; assert.ok(Number.isFinite(margin) && margin >= 0);
  const seals: FloorInterfaceSeal[] = [], counts: Record<string, number> = {}, rejections: { cell: string; reason: string; top: [FloorPoint, FloorPoint] }[] = [];
  const count = (reason: string) => { counts[reason] = (counts[reason] ?? 0) + 1; };
  for (const cell of [...new Set(sources.map(s => s.cell))]) {
    const triangles: Triangle[] = [], seenTriangles = new Map<string, number>();
    for (const source of sources.filter(s => s.cell === cell)) for (let i = 0; i < source.indices.length; i += 3) {
      const p = [0, 1, 2].map(k => [0, 1, 2].map(a => Math.fround(source.positions[source.indices[i + k]! * 3 + a]!)) as FloorPoint), [a, b, c] = p as [FloorPoint, FloorPoint, FloorPoint], u = b.map((v, k) => v - a[k]!), v = c.map((v, k) => v - a[k]!), nx = u[1]! * v[2]! - u[2]! * v[1]!, ny = u[2]! * v[0]! - u[0]! * v[2]!, nz = u[0]! * v[1]! - u[1]! * v[0]!, length = Math.hypot(nx, ny, nz);
      if (length < 1e-10) continue;
      const triangle = { source, triangle: i / 3, p, tag: source.triangleTags[i / 3]!, normalY: ny / length, den: (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]) }, key = p.map(xyz).sort().join('|'), previous = seenTriangles.get(key);
      if (previous !== undefined) { if (triangle.normalY > triangles[previous]!.normalY) triangles[previous] = triangle; continue; }
      seenTriangles.set(key, triangles.length); triangles.push(triangle);
    }
    const edgeMap = new Map<string, Edge>(), coverageGrid = new Map<string, Triangle[]>();
    for (const triangle of triangles) {
      if (Math.abs(triangle.normalY) < .3) for (const key of buckets(triangle.p, tolerance)) { const values = coverageGrid.get(key) ?? []; values.push(triangle); coverageGrid.set(key, values); }
      if (!(triangle.tag.startsWith('raised:') || triangle.tag.startsWith('road:')) || triangle.normalY <= .3) continue;
      for (let j = 0; j < 3; j++) { const a = triangle.p[j]!, b = triangle.p[(j + 1) % 3]!, key = [xyz(a), xyz(b)].sort().join('|'), old = edgeMap.get(key); if (old) old.count++; else edgeMap.set(key, { a, b, third: triangle.p[(j + 2) % 3]!, triangle, count: 1 }); }
    }
    const edges = [...edgeMap.values()].filter(e => {
      if (e.count !== 1) return false;
      const dx = e.b[0] - e.a[0], dz = e.b[2] - e.a[2], length = Math.hypot(dx, dz);
      if (length <= 1e-6) return false;
      // Two sides of a Float32 sliver do not prove separate exterior soil.
      // Closing both would create almost coplanar veneers around that sliver.
      if (Math.abs(dx * (e.third[2] - e.a[2]) - dz * (e.third[0] - e.a[0])) / length <= tolerance) { count('ambiguous-thin-floor'); return false; }
      return true;
    }), edgeGrid = new Map<string, number[]>();
    for (const [i, edge] of edges.entries()) for (const key of buckets([edge.a, edge.b], tolerance)) { const values = edgeGrid.get(key) ?? []; values.push(i); edgeGrid.set(key, values); }
    const assigned = new Set<number>();
    for (let seed = 0; seed < edges.length; seed++) {
      if (assigned.has(seed)) continue;
      const reference = edges[seed]!, dx = reference.b[0] - reference.a[0], dz = reference.b[2] - reference.a[2], length = Math.hypot(dx, dz), unit: [number, number] = [dx / length, dz / length];
      const project = (p: FloorPoint) => (p[0] - reference.a[0]) * unit[0] + (p[2] - reference.a[2]) * unit[1], side = (p: FloorPoint) => unit[0] * (p[2] - reference.a[2]) - unit[1] * (p[0] - reference.a[0]);
      const group = [seed]; assigned.add(seed);
      for (let j = 0; j < group.length; j++) for (const key of buckets([edges[group[j]!]!.a, edges[group[j]!]!.b], tolerance)) for (const i of edgeGrid.get(key) ?? []) {
        if (assigned.has(i)) continue; const edge = edges[i]!;
        // Only a real shared source line can own this floor interface. The
        // wider physical tolerance remains for old-face coverage, not for
        // turning neighbouring parallel floor boundaries into a shared line.
        if (Math.abs(side(edge.a)) > 1e-8 || Math.abs(side(edge.b)) > 1e-8) continue;
        group.push(i); assigned.add(i);
      }
      const lines: FloorLine[] = group.map(i => {
        const edge = edges[i]!, a = project(edge.a), b = project(edge.b), lo = Math.min(a, b), hi = Math.max(a, b);
        const p = (t: number) => [reference.a[0] + unit[0] * t, reference.a[2] + unit[1] * t];
        const A = p(lo), B = p(hi);
        // Split using the actual soil planes at the shared line. Projected
        // original-edge heights can differ by microns and leave bow-tie tips.
        return { lo, hi, ya: planeHeight(edge.triangle, A[0]!, A[1]!).height, yb: planeHeight(edge.triangle, B[0]!, B[1]!).height, edge, side: Math.sign(side(edge.third)) };
      }).filter(l => l.side !== 0);
      if (!lines.some(l => l.side > 0) || !lines.some(l => l.side < 0)) { count('single-sided-boundary'); continue; }
      const lo = Math.min(...lines.map(l => l.lo)), hi = Math.max(...lines.map(l => l.hi)), referencePoint = (t: number, y = 0): FloorPoint => [reference.a[0] + unit[0] * t, y, reference.a[2] + unit[1] * t];
      const nearby = [...new Set(buckets([referencePoint(lo), referencePoint(hi)], tolerance).flatMap(key => coverageGrid.get(key) ?? []))];
      const coverFaces = nearby.filter(t => t.p.every(p => Math.abs(side(p)) <= tolerance)).map(triangle => ({ triangle, lines: triangle.p.map((p, i) => { const q = triangle.p[(i + 1) % 3]!, a = project(p), b = project(q); return Math.abs(a - b) < 1e-9 ? null : a < b ? { lo: a, hi: b, ya: p[1], yb: q[1] } : { lo: b, hi: a, ya: q[1], yb: p[1] }; }).filter((l): l is Line => !!l) })).filter(f => f.lines.length >= 2);
      const keep = options.protectedArea, protectedMask: LocalPolygon = { id: 'accepted-area-margin', bbox: [keep.minX - margin, -keep.maxZ - margin, keep.maxX + margin, -keep.minZ + margin], properties: {}, rings: [[[keep.minX - margin, -keep.maxZ - margin], [keep.maxX + margin, -keep.maxZ - margin], [keep.maxX + margin, -keep.minZ + margin], [keep.minX - margin, -keep.minZ + margin]]] };
      const masks = [...maskIntervals(protectedMask, reference, unit, lo, hi, 'accepted', tolerance), ...(options.wallMasks ?? []).flatMap(p => maskIntervals(p, reference, unit, lo, hi, 'wall', tolerance)), ...(options.waterMasks ?? []).flatMap(p => maskIntervals(p, reference, unit, lo, hi, 'water', tolerance)), ...(options.registeredDecks ?? []).flatMap(p => maskIntervals(p, reference, unit, lo, hi, 'deck', tolerance))];
      const points = splitValues([...lines, ...coverFaces.flatMap(f => f.lines)], masks.flatMap(m => [m.lo, m.hi]));
      for (let i = 0; i + 1 < points.length; i++) {
        const a = points[i]!, b = points[i + 1]!, mid = (a + b) / 2; if (b - a < 1e-6) continue;
        const active = lines.filter(l => mid > l.lo && mid < l.hi), positive = active.filter(l => l.side > 0).sort((a, b) => height(b, mid) - height(a, mid))[0], negative = active.filter(l => l.side < 0).sort((a, b) => height(b, mid) - height(a, mid))[0]; if (!positive || !negative) continue;
        const upper = height(positive, mid) >= height(negative, mid) ? positive : negative, lower = upper === positive ? negative : positive;
        const position = (t: number): FloorPoint => at(upper.edge.a, upper.edge.b, (t - project(upper.edge.a)) / (project(upper.edge.b) - project(upper.edge.a)));
        const A = position(a), B = position(b), floorA = planeHeight(lower.edge.triangle, A[0], A[2]), floorB = planeHeight(lower.edge.triangle, B[0], B[2]);
        const reject = (reason: string) => { count(reason); rejections.push({ cell, reason, top: [A, B] }); };
        // A near-parallel boundary with a horizontal hole cannot be repaired by
        // an invented vertical wall. Its lower points must lie on real soil.
        if (!floorA.inside || !floorB.inside) { reject('no-exact-lower-floor-support'); continue; }
        const gap: [number, number] = [A[1] - floorA.height, B[1] - floorB.height];
        if (Math.max(...gap) <= tolerance) { count('already-joined'); continue; }
        if (Math.min(...gap) < -tolerance) { reject('crossing-profile-uncertainty'); continue; }
        const guarded = masks.filter(m => mid > m.lo && mid < m.hi), blocked = guarded.find(m => m.kind === 'accepted' || m.kind === 'wall' || (m.kind === 'water' && !guarded.some(d => d.kind === 'deck')));
        if (blocked) { reject(`${blocked.kind}:${blocked.id}`); continue; }
        const upperLine: Line = { lo: a, hi: b, ya: A[1], yb: B[1] }, lowerLine: Line = { lo: a, hi: b, ya: floorA.height, yb: floorB.height };
        const coverage = coverFaces.map(f => { const crossing = f.lines.filter(l => mid > l.lo && mid < l.hi).sort((a, b) => height(a, mid) - height(b, mid)); return crossing.length >= 2 ? { low: crossing[0]!, high: crossing.at(-1)!, triangle: f.triangle } : null; }).filter((c): c is NonNullable<typeof c> => !!c).filter(c => height(c.high, mid) > height(lowerLine, mid) && height(c.low, mid) < height(upperLine, mid)).sort((a, b) => height(a.low, mid) - height(b.low, mid));
        let bottom = lowerLine;
        const emit = (low: Line, high: Line) => {
          if (height(high, mid) - height(low, mid) <= tolerance) return;
          const actualGap: [number, number] = [height(high, a) - height(low, a), height(high, b) - height(low, b)];
          if (Math.min(...actualGap) < -1e-10) { reject('actual-profile-crossing-uncertainty'); return; }
          if (Math.max(...actualGap) > maximumGap + tolerance) { reject('above-offset-bound'); return; }
          const top: [FloorPoint, FloorPoint] = [[A[0], height(high, a), A[2]], [B[0], height(high, b), B[2]]], base: [FloorPoint, FloorPoint] = [[A[0], Math.min(height(low, a), height(high, a)), A[2]], [B[0], Math.min(height(low, b), height(high, b)), B[2]]];
          seals.push({ cell, sourceId: `g:${cell}`, sideTag: 'wall', upperSourceId: upper.edge.triangle.source.id, upperTriangle: upper.edge.triangle.triangle, upperTag: upper.edge.triangle.tag, lowerSourceId: lower.edge.triangle.source.id, lowerTriangle: lower.edge.triangle.triangle, lowerTag: lower.edge.triangle.tag, top, bottom: base, gap: actualGap, sourceFloorGap: gap, length: b - a, polygon: [[top[0], top[1], base[1], base[0]]], section: [[[0, top[0][1]], [1, top[1][1]], [1, base[1][1]], [0, base[0][1]]]], actualUpperEdge: [upper.edge.a, upper.edge.b], actualLowerEdge: [lower.edge.a, lower.edge.b], existingCoverageTriangles: coverage.map(c => ({ sourceId: c.triangle.source.id, triangle: c.triangle.triangle })) });
        };
        for (const c of coverage) { if (height(c.low, mid) > height(bottom, mid)) emit(bottom, c.low); if (height(c.high, mid) > height(bottom, mid)) bottom = c.high; if (height(bottom, mid) >= height(upperLine, mid)) break; }
        if (height(bottom, mid) < height(upperLine, mid)) emit(bottom, upperLine); else count('existing-face-coverage');
      }
    }
  }
  const ambiguous = ambiguousAdditionSeals(seals, tolerance);
  for (const i of ambiguous) { const seal = seals[i]!; count('ambiguous-near-plane-addition'); rejections.push({ cell: seal.cell, reason: 'ambiguous-near-plane-addition', top: seal.top }); }
  return { seals: seals.filter((_, i) => !ambiguous.has(i)), rejections, counts };
}

/** Exactly two Float32 XZ stations; all nondegenerate faces remain vertical. */
export function meshFloorInterfaceSeals(seals: readonly FloorInterfaceSeal[]) {
  return meshVerticalSeals(seals);
}
