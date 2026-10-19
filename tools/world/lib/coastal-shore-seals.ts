import { pointInPolygon, type LocalPolygon } from './geometry.ts';

export type ShorePoint = [number, number, number];
export interface ShoreAuthoritySegment { id: string; a: [number, number]; b: [number, number]; drySide?: 1 | -1 }
export interface ShoreMesh { cell: string; primitiveName: string; primitiveIndex: number; positions: Float32Array; indices: Uint32Array }
export interface ShoreSeal {
  id: string; cell: string; primitiveName: string; primitiveIndex: number; colliderId: string;
  top: [ShorePoint, ShorePoint]; bottom: [ShorePoint, ShorePoint];
  source: { kind: 'coast'; shoreSegment: string; visualTriangles: number[]; visualVertices: number[]; topBinding: 'edge' | 'triangle-plane-intersection'; sourceLandPartIds: string[]; coverageTriangles: { primitiveName: string; primitiveIndex: number; triangle: number }[]; structuralAbutment: boolean; bridgeEndBankIds?: string[] };
}
export interface ShoreRejection { reason: string; cell: string; primitiveName: string; top: [ShorePoint, ShorePoint]; shoreSegment?: string }
export interface ShoreBridgeEndBank {
  id: string; shoreSegment: string; lo: number; hi: number; bridgeWays: number[]; endpointNodes: number[]; deckPartIds: string[]; dryPartIds: string[];
  proofs: { way: number; endpointNode: number; endpoint: [number, number]; deckPart: string; dryComponent: LocalPolygon; dryAdjacency: { id: string; shared: [[number, number], [number, number]] }[]; endpointShoreDistanceMetres: number; axisTowardWater: [number, number]; axisAwayOnLand: [number, number] }[];
}
export interface ShoreSealOptions { protectedArea?: { minX: number; maxX: number; minZ: number; maxZ: number }; protectedMarginMetres?: number; bridgeEndBanks?: readonly ShoreBridgeEndBank[]; bridgeEndBanksOnly?: boolean }
interface Triangle { mesh: ShoreMesh; id: number; vertices: number[]; p: ShorePoint[]; normalY: number }
interface Edge { triangle: Triangle; a: ShorePoint; b: ShorePoint; vertices: number[]; topBinding: 'edge' | 'triangle-plane-intersection' }
interface Line { lo: number; hi: number; ya: number; yb: number }
interface Candidate { edge: Edge; line: Line; structural: boolean }
interface FaceSlice { triangle: Triangle; lines: Line[] }
const EPS = .001, HEIGHT_EPS = 1e-5;
const pointKey = (p: ShorePoint) => p.join(',');
const height = (l: Line, t: number) => l.ya + (l.yb - l.ya) * (t - l.lo) / (l.hi - l.lo);
function project(p: ShorePoint, s: ShoreAuthoritySegment) {
  const dx = s.b[0] - s.a[0], dz = s.b[1] - s.a[1], length = Math.hypot(dx, dz);
  return { t: ((p[0] - s.a[0]) * dx + (p[2] - s.a[1]) * dz) / (length * length), side: (dx * (p[2] - s.a[1]) - dz * (p[0] - s.a[0])) / length, length };
}
function line(a: ShorePoint, b: ShorePoint, s: ShoreAuthoritySegment): Line | null {
  const ta = project(a, s).t, tb = project(b, s).t;
  if (Math.abs(ta - tb) * project(a, s).length < 1e-6) return null;
  return ta < tb ? { lo: ta, hi: tb, ya: a[1], yb: b[1] } : { lo: tb, hi: ta, ya: b[1], yb: a[1] };
}
function clipSourceEdge(a: ShorePoint, b: ShorePoint, s: ShoreAuthoritySegment) {
  const dx = b[0] - a[0], dz = b[2] - a[2], squaredLength = dx * dx + dz * dz;
  if (squaredLength === 0) return null;
  const sourceStation = (p: readonly [number, number]) => ((p[0] - a[0]) * dx + (p[1] - a[2]) * dz) / squaredLength;
  const A = sourceStation(s.a), B = sourceStation(s.b), lo = Math.max(0, Math.min(A, B)), hi = Math.min(1, Math.max(A, B));
  if ((hi - lo) * Math.sqrt(squaredLength) < EPS) return null;
  // Interpolate the old edge itself, including its height. Adjacent canonical
  // segments use the same station at their common source vertex, so a small
  // coastline bend cannot create overlapping added veneers at that vertex.
  const at = (u: number): ShorePoint => u === 0 ? a : u === 1 ? b : [a[0] + dx * u, a[1] + (b[1] - a[1]) * u, a[2] + dz * u];
  return { a: at(lo), b: at(hi), clipped: lo > 0 || hi < 1 };
}
function contains(p: ShorePoint, polygons: readonly LocalPolygon[]) {
  return polygons.some(q => p[0] >= q.bbox[0] - EPS && p[0] <= q.bbox[2] + EPS && -p[2] >= q.bbox[1] - EPS && -p[2] <= q.bbox[3] + EPS && pointInPolygon([p[0], -p[2]], q.rings));
}
const ordinaryLand = (p: LocalPolygon) => ['Ajorata', 'Kevyt liikenne', 'Muu rakenneosa'].includes(String(p.properties['paatyyppi'])) && !['Portaat', 'Tukimuuri'].includes(String(p.properties['alatyyppi']));
const openStructure = (p: LocalPolygon) => p.properties['paatyyppi'] === 'Silta' || p.properties['man_made'] === 'pier';
/** Exact source footprint intersections, with no buffer becoming dry land. */
function polygonIntervals(s: ShoreAuthoritySegment, polygon: LocalPolygon) {
  const dx = s.b[0] - s.a[0], dz = s.b[1] - s.a[1], values = [0, 1];
  for (const ring of polygon.rings) for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!, ex = b[0] - a[0], ez = -b[1] + a[1], ax = a[0] - s.a[0], az = -a[1] - s.a[1], denominator = dx * ez - dz * ex;
    if (Math.abs(denominator) < 1e-12) continue;
    const t = (ax * ez - az * ex) / denominator, u = (ax * dz - az * dx) / denominator;
    if (t > 0 && t < 1 && u >= 0 && u <= 1) values.push(t);
  }
  values.sort((a, b) => a - b);
  return values.slice(0, -1).flatMap((lo, i) => { const hi = values[i + 1]!, mid = (lo + hi) / 2; return hi - lo > 1e-10 && pointInPolygon([s.a[0] + dx * mid, -(s.a[1] + dz * mid)], polygon.rings) ? [{ lo, hi, id: polygon.id }] : []; });
}
/** Canonical water boundaries are shore authority. Artificial world rectangle
 * closure is clipping machinery, never evidence of a real quay. */
export function sourceShoreSegments(water: readonly LocalPolygon[], area: { minX: number; maxX: number; minZ: number; maxZ: number }): ShoreAuthoritySegment[] {
  const result: ShoreAuthoritySegment[] = [];
  for (const polygon of water) for (const [ringIndex, ring] of polygon.rings.entries()) for (let i = 0; i < ring.length; i++) {
    const aa = ring[i]!, bb = ring[(i + 1) % ring.length]!, a: [number, number] = [aa[0], -aa[1]], b: [number, number] = [bb[0], -bb[1]], length = Math.hypot(a[0] - b[0], a[1] - b[1]);
    if (length < EPS) continue;
    if ([area.minX, area.maxX].some(x => Math.abs(a[0] - x) < EPS && Math.abs(b[0] - x) < EPS) || [area.minZ, area.maxZ].some(z => Math.abs(a[1] - z) < EPS && Math.abs(b[1] - z) < EPS)) continue;
    const midpoint: ShorePoint = [(a[0] + b[0]) / 2, 0, (a[1] + b[1]) / 2], nx = -(b[1] - a[1]) / length, nz = (b[0] - a[0]) / length;
    const leftWet = contains([midpoint[0] + nx * .0001, 0, midpoint[2] + nz * .0001], water), rightWet = contains([midpoint[0] - nx * .0001, 0, midpoint[2] - nz * .0001], water);
    if (leftWet === rightWet) throw new Error(`Ambiguous canonical shore sides at ${polygon.id}:${ringIndex}:${i}`);
    result.push({ id: `${polygon.id}:${ringIndex}:${i}`, a, b, drySide: leftWet ? -1 : 1 });
  }
  return result;
}
function uniqueTriangles(meshes: readonly ShoreMesh[]) {
  const result: Triangle[] = [], seen = new Map<string, number>();
  for (const mesh of meshes) for (let i = 0; i < mesh.indices.length; i += 3) {
    const vertices = [mesh.indices[i]!, mesh.indices[i + 1]!, mesh.indices[i + 2]!], p = vertices.map(id => Array.from(mesh.positions.subarray(id * 3, id * 3 + 3)) as ShorePoint), key = p.map(pointKey).sort().join('|');
    const a = p[0]!, b = p[1]!, c = p[2]!, ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2], nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (Math.hypot(nx, ny, nz) < 1e-12) continue;
    const triangle = { mesh, id: i / 3, vertices, p, normalY: ny / Math.hypot(nx, ny, nz) }, previous = seen.get(key);
    if (previous !== undefined) { if (triangle.normalY > result[previous]!.normalY) result[previous] = triangle; continue; }
    seen.set(key, result.length); result.push(triangle);
  }
  return result;
}
function protectedInterval(edge: Edge, options: ShoreSealOptions) {
  const area = options.protectedArea; if (!area) return false;
  const m = options.protectedMarginMetres ?? 0;
  // Withhold even a partial intersection; no new accepted-area wall or vertex.
  let lo = 0, hi = 1;
  for (const [a, d, min, max] of [[edge.a[0], edge.b[0] - edge.a[0], area.minX - m, area.maxX + m], [edge.a[2], edge.b[2] - edge.a[2], area.minZ - m, area.maxZ + m]]) {
    if (Math.abs(d!) < 1e-12) { if (a! < min! || a! > max!) return false; }
    else { let x = (min! - a!) / d!, y = (max! - a!) / d!; if (x > y) [x, y] = [y, x]; lo = Math.max(lo, x); hi = Math.min(hi, y); }
  }
  return hi >= lo;
}
/** Cross-section of an actual upward triangle continuing into source water.
 * Equal-height continuation is an open bridge/pier surface, not a land bank. */
function wetContinuation(triangle: Triangle, s: ShoreAuthoritySegment): Line | null {
  const projected = triangle.p.map(p => project(p, s)), side = s.drySide ?? 1;
  if (triangle.normalY <= 1e-6 || !projected.some(p => p.side * side < -EPS)) return null;
  const intersections: ShorePoint[] = [];
  for (let j = 0; j < 3; j++) {
    const a = triangle.p[j]!, b = triangle.p[(j + 1) % 3]!, da = projected[j]!.side, db = projected[(j + 1) % 3]!.side;
    if (Math.abs(da) <= EPS) intersections.push(a);
    if (da * db < 0) { const t = da / (da - db); intersections.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]); }
  }
  if (intersections.length < 2) return null;
  intersections.sort((a, b) => project(a, s).t - project(b, s).t);
  return line(intersections[0]!, intersections.at(-1)!, s);
}
function breakpoints(lines: readonly Line[]) {
  const values = lines.flatMap(l => [l.lo, l.hi]);
  for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
    const a = lines[i]!, b = lines[j]!, lo = Math.max(a.lo, b.lo), hi = Math.min(a.hi, b.hi); if (hi <= lo) continue;
    const d0 = height(a, lo) - height(b, lo), d1 = height(a, hi) - height(b, hi);
    if (d0 * d1 < 0) values.push(lo + (hi - lo) * d0 / (d0 - d1));
  }
  values.sort((a, b) => a - b); return values.filter((v, i) => !i || v - values[i - 1]! > 1e-10);
}
/** Pure source-bound selection. Resolve stacked top surfaces by their actual
 * highest dry envelope; subtract existing vertical faces before adding gaps.
 * No existing vertex moves and no horizontal land is created. */
export function qualifyCoastalShoreSeals(meshes: readonly ShoreMesh[], authority: readonly ShoreAuthoritySegment[], structuralDecks: readonly LocalPolygon[], waterY: number, options: ShoreSealOptions = {}) {
  if (!Number.isFinite(waterY)) throw new Error('Invalid water level');
  const triangles = uniqueTriangles(meshes), seals: ShoreSeal[] = [], rejected: ShoreRejection[] = [];
  let shorelineTopEdges = 0, clippedShorelineTopEdges = 0, coveredIntervals = 0, stackedIntervals = 0, structuralAbutments = 0;
  for (const s of authority) {
    const length = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]), candidates: Candidate[] = [], faces: FaceSlice[] = [], wet: Line[] = [], seen = new Set<string>();
    const landIntervals = structuralDecks.filter(ordinaryLand).flatMap(p => polygonIntervals(s, p)), structureIntervals = structuralDecks.filter(openStructure).flatMap(p => polygonIntervals(s, p));
    const banks = options.bridgeEndBanks?.filter(b => b.shoreSegment === s.id) ?? [];
    const sourceLandAt = (t: number) => landIntervals.filter(p => t > p.lo && t < p.hi).map(p => p.id), openStructureAt = (t: number) => structureIntervals.some(p => t > p.lo && t < p.hi);
    for (const triangle of triangles) {
      const projections = triangle.p.map(p => project(p, s));
      if (projections.every(p => p.t < -EPS / length) || projections.every(p => p.t > 1 + EPS / length)) continue;
      const continuation = wetContinuation(triangle, s); if (continuation) wet.push(continuation);
      if (continuation && [...landIntervals, ...banks].some(p => Math.min(p.hi, continuation.hi) > Math.max(p.lo, continuation.lo))) {
        const l = { ...continuation, lo: Math.max(0, continuation.lo), hi: Math.min(1, continuation.hi) };
        l.ya = height(continuation, l.lo); l.yb = height(continuation, l.hi);
        if ((l.hi - l.lo) * length > EPS) {
          const point = (t: number): ShorePoint => [s.a[0] + (s.b[0] - s.a[0]) * t, height(l, t), s.a[1] + (s.b[1] - s.a[1]) * t];
          const edge: Edge = { triangle, a: point(l.lo), b: point(l.hi), vertices: triangle.vertices, topBinding: 'triangle-plane-intersection' };
          if (!protectedInterval(edge, options) && Math.max(l.ya, l.yb) > waterY + HEIGHT_EPS) candidates.push({ edge, line: l, structural: false });
        }
      }
      if (projections.every(p => Math.abs(p.side) <= EPS)) {
        const lines = triangle.p.map((p, j) => line(p, triangle.p[(j + 1) % 3]!, s)).filter((l): l is Line => !!l); if (lines.length >= 2) faces.push({ triangle, lines });
      }
      if (triangle.normalY <= 1e-6) continue;
      for (let j = 0; j < 3; j++) {
        const k = (j + 1) % 3, third = (j + 2) % 3, originalA = triangle.p[j]!, originalB = triangle.p[k]!, pa = projections[j]!, pb = projections[k]!;
        if (Math.abs(pa.side) > EPS || Math.abs(pb.side) > EPS || projections[third]!.side * (s.drySide ?? 1) <= EPS) continue;
        const clipped = clipSourceEdge(originalA, originalB, s); if (!clipped) continue;
        const { a, b } = clipped;
        const l = line(a, b, s); if (!l || (l.hi - l.lo) * length < EPS) continue;
        const edge: Edge = { triangle, a, b, vertices: [triangle.vertices[j]!, triangle.vertices[k]!], topBinding: 'edge' }, key = [pointKey(a), pointKey(b)].sort().join('|'); if (seen.has(key)) continue; seen.add(key); shorelineTopEdges++; if (clipped.clipped) clippedShorelineTopEdges++;
        const reject = (reason: string) => rejected.push({ reason, cell: triangle.mesh.cell, primitiveName: triangle.mesh.primitiveName, top: [a, b], shoreSegment: s.id });
        if (protectedInterval(edge, options)) { reject('accepted-protected-margin'); continue; }
        if (Math.max(a[1], b[1]) <= waterY + HEIGHT_EPS) { reject('at-or-below-water'); continue; }
        const midpoint: ShorePoint = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
        candidates.push({ edge, line: l, structural: contains(midpoint, structuralDecks) });
      }
    }
    if (!candidates.length) continue;
    const water: Line = { lo: Math.min(...candidates.map(c => c.line.lo)), hi: Math.max(...candidates.map(c => c.line.hi)), ya: waterY, yb: waterY }, points = breakpoints([...candidates.map(c => c.line), ...faces.flatMap(f => f.lines), ...wet, water, ...landIntervals.map(p => ({ ...p, ya: waterY, yb: waterY })), ...structureIntervals.map(p => ({ ...p, ya: waterY, yb: waterY })), ...banks.map(p => ({ ...p, ya: waterY, yb: waterY }))]);
    for (let i = 0; i + 1 < points.length; i++) {
      const lo = points[i]!, hi = points[i + 1]!, mid = (lo + hi) / 2; if ((hi - lo) * length < EPS) continue;
      const active = candidates.filter(c => mid > c.line.lo && mid < c.line.hi).sort((a, b) => height(b.line, mid) - height(a.line, mid)); if (!active.length) continue;
      // A matching wet-side face is an actual open span. A lower actual dry
      // bank beneath an elevated bridge remains eligible as an abutment.
      const endpointBanks = banks.filter(b => mid > b.lo && mid < b.hi);
      if (options.bridgeEndBanksOnly && !endpointBanks.length) continue;
      const landIds = [...new Set([...sourceLandAt(mid), ...endpointBanks.flatMap(b => b.dryPartIds)])], provenApproach = (landIds.length > 0 && !openStructureAt(mid)) || endpointBanks.length > 0;
      const eligible = active.filter(c => c.edge.topBinding === 'triangle-plane-intersection' ? provenApproach : provenApproach || !wet.some(w => mid > w.lo && mid < w.hi && Math.abs(height(w, mid) - height(c.line, mid)) < EPS));
      if (!eligible.length) { const c = active[0]!; rejected.push({ reason: 'actual-wet-side-continuation', cell: c.edge.triangle.mesh.cell, primitiveName: c.edge.triangle.mesh.primitiveName, top: [c.edge.a, c.edge.b], shoreSegment: s.id }); continue; }
      const c = eligible[0]!, top = height(c.line, mid); if (top <= waterY + HEIGHT_EPS) continue;
      if (eligible.length > 1) stackedIntervals++;
      const coverage = faces.map(f => { const lines = f.lines.filter(l => mid > l.lo && mid < l.hi).sort((a, b) => height(a, mid) - height(b, mid)); return lines.length >= 2 ? { low: lines[0]!, high: lines.at(-1)!, triangle: f.triangle } : null; }).filter((v): v is NonNullable<typeof v> => !!v).filter(v => height(v.high, mid) > waterY && height(v.low, mid) < top).sort((a, b) => height(a.low, mid) - height(b.low, mid));
      let lower = water;
      const emit = (bottom: Line, upper: Line) => {
        if (height(upper, mid) - height(bottom, mid) <= HEIGHT_EPS) return;
        const point = (t: number, y: number): ShorePoint => { const ea = project(c.edge.a, s).t, eb = project(c.edge.b, s).t, f = (t - ea) / (eb - ea); return [c.edge.a[0] + (c.edge.b[0] - c.edge.a[0]) * f, y, c.edge.a[2] + (c.edge.b[2] - c.edge.a[2]) * f]; };
        const mesh = c.edge.triangle.mesh, structural = c.structural || endpointBanks.length > 0; if (structural) structuralAbutments++;
        seals.push({ id: `${mesh.cell}:shore:${seals.length}`, cell: mesh.cell, primitiveName: mesh.primitiveName, primitiveIndex: mesh.primitiveIndex, colliderId: `g:${mesh.cell}`, top: [point(lo, height(upper, lo)), point(hi, height(upper, hi))], bottom: [point(lo, height(bottom, lo)), point(hi, height(bottom, hi))], source: { kind: 'coast', shoreSegment: s.id, visualTriangles: [c.edge.triangle.id], visualVertices: c.edge.vertices, topBinding: c.edge.topBinding, sourceLandPartIds: landIds, coverageTriangles: coverage.map(v => ({ primitiveName: v.triangle.mesh.primitiveName, primitiveIndex: v.triangle.mesh.primitiveIndex, triangle: v.triangle.id })), structuralAbutment: structural, ...(endpointBanks.length ? { bridgeEndBankIds: endpointBanks.map(b => b.id) } : {}) } });
      };
      for (const v of coverage) { if (height(v.low, mid) > height(lower, mid)) emit(lower, v.low); if (height(v.high, mid) > height(lower, mid)) lower = v.high; if (height(lower, mid) >= top) break; }
      if (height(lower, mid) < top) emit(lower, c.line); else coveredIntervals++;
    }
  }
  return { seals, rejected, stats: { uniqueTriangles: triangles.length, shorelineTopEdges, clippedShorelineTopEdges, qualified: seals.length, rejected: rejected.length, coveredIntervals, stackedIntervals, structuralAbutments } };
}
