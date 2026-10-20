// Bounded reconstruction of the Senate Square entrance architecture. Source heights and the
// register footprints are anchors; the photographed stair subdivision is an authored approximation.
import assert from 'node:assert/strict';
import earcut from 'earcut';
import polygonClipping from 'polygon-clipping';
import type {GroundPiece} from './ground.ts';
import {clipGroundToRectangle, type AppendRectangle} from './append-city-cells.ts';
import {prepareNativeFrontier} from './frontier-ground.ts';

export type Point3 = readonly [number, number, number];
export type GroundTriangle = readonly [Point3, Point3, Point3];
export interface EntranceFrame { origin: readonly [number, number]; uphill: readonly [number, number] }
export interface EntrancePatch {
  id: string; region: AppendRectangle; pieces: GroundPiece[];
  observations: Record<string, unknown>;
}
export const UNIVERSITY_REGION: AppendRectangle = [-85, -8, -72, 17];
export const UNIVERSITY_FRAME: EntranceFrame = {
  origin: [-75.19622930752615, 3.7074210496225333],
  uphill: [-0.9985005276798564, 0.05474591292441413],
};
export const UNIVERSITY_FOOT_HEIGHT = 1.1293973522573535;
export const UNIVERSITY_LOWER_RISE = 1.4650545450210744;
export const UNIVERSITY_UPPER_RISE = 1.4;

/** Highest actual rendered support, not the coarse fallback terrain. */
export function surfaceHeight(triangles: readonly GroundTriangle[], x: number, z: number): number | null {
  let result = -Infinity;
  for (const [a, b, c] of triangles) {
    const d = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]);
    if (Math.abs(d) < 1e-10) continue;
    const u = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / d;
    const v = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / d;
    if (u >= -1e-6 && v >= -1e-6 && u + v <= 1 + 1e-6) result = Math.max(result, u * a[1] + v * b[1] + (1 - u - v) * c[1]);
  }
  return Number.isFinite(result) ? result : null;
}

/** All triangle-edge stations on the replacement boundary. Subdivision preserves the actual
 * piecewise-linear adjoining floor, including intersections between overlapping source surfaces. */
export function boundaryStations(triangles: readonly GroundTriangle[], region: AppendRectangle): [number[], number[], number[], number[]] {
  const [x0, z0, x1, z1] = region;
  const lines = [[0, z0, x0, x1], [2, x1, z0, z1], [0, z1, x0, x1], [2, x0, z0, z1]] as const;
  return lines.map(([vary, fixed, low, high]) => {
    const other = vary === 0 ? 2 : 0, intervals: {a: number; b: number; ya: number; yb: number}[] = [];
    const stations = new Set<number>([low, high]);
    for (const triangle of triangles) {
      const points: {s: number; y: number}[] = [];
      for (let i = 0; i < 3; i++) {
        const a = triangle[i]!, b = triangle[(i + 1) % 3]!;
        if (a[other] === fixed) points.push({s: a[vary], y: a[1]});
        if ((a[other] < fixed && b[other] > fixed) || (a[other] > fixed && b[other] < fixed)) {
          const t = (fixed - a[other]) / (b[other] - a[other]); points.push({s: a[vary] + (b[vary] - a[vary]) * t, y: a[1] + (b[1] - a[1]) * t});
        }
      }
      points.sort((a, b) => a.s - b.s);
      const a = points[0], b = points.at(-1);
      if (!a || !b || b.s - a.s < 1e-8 || b.s < low || a.s > high) continue;
      const lo = Math.max(low, a.s), hi = Math.min(high, b.s), at = (s: number) => a.y + (b.y - a.y) * (s - a.s) / (b.s - a.s);
      intervals.push({a: lo, b: hi, ya: at(lo), yb: at(hi)}); stations.add(lo); stations.add(hi);
    }
    for (let i = 0; i < intervals.length; i++) for (let j = i + 1; j < intervals.length; j++) {
      const p = intervals[i]!, q = intervals[j]!, lo = Math.max(p.a, q.a), hi = Math.min(p.b, q.b);
      if (hi - lo < 1e-8) continue;
      const height = (v: typeof p, s: number) => v.ya + (v.yb - v.ya) * (s - v.a) / (v.b - v.a);
      const dl = height(p, lo) - height(q, lo), dh = height(p, hi) - height(q, hi);
      if (dl * dh < 0) stations.add(lo + (hi - lo) * dl / (dl - dh));
    }
    return [...stations].sort((a, b) => a - b).filter((s, i, all) => i === 0 || s - all[i - 1]! > 1e-7);
  }) as [number[], number[], number[], number[]];
}

export function entrancePoint(frame: EntranceFrame, along: number, across: number, y: number): [number, number, number] {
  const [ux, uz] = frame.uphill;
  assert.ok(Math.abs(Math.hypot(ux, uz) - 1) < 1e-6, 'Entrance frame must be orthonormal');
  return [frame.origin[0] + ux * along - uz * across, y, frame.origin[1] + uz * along + ux * across];
}

function mesh(tag: string): GroundPiece { return {cell: '', finish: 'slabs', level: 'raised', tag, positions: [], uvs: [], indices: []}; }
function polygon(piece: GroundPiece, input: readonly Point3[]) {
  const points = input.filter((p, i) => i === 0 || Math.hypot(...p.map((v, k) => v - input[i - 1]![k]!)) > 1e-10);
  if (points.length > 1 && Math.hypot(...points[0]!.map((v, k) => v - points.at(-1)![k]!)) < 1e-10) points.pop();
  if (points.length < 3) return;
  const offset = piece.positions.length / 3;
  const a = points[0]!, b = points[1]!, c = points[2]!, e = b.map((value, i) => value - a[i]!), edgeLength = Math.hypot(...e);
  const u = e.map(value => value / edgeLength), q = c.map((value, i) => value - a[i]!), dot = q.reduce((sum, value, i) => sum + value * u[i]!, 0);
  const v0 = q.map((value, i) => value - dot * u[i]!), vLength = Math.hypot(...v0), v = v0.map(value => value / vLength);
  assert.ok(edgeLength > 1e-8 && vLength > 1e-8, 'Entrance face must have positive area');
  for (const p of points) {
    const relative = p.map((value, i) => value - a[i]!);
    piece.positions.push(...p); piece.uvs.push(relative.reduce((sum, value, i) => sum + value * u[i]!, 0) / 1.2, relative.reduce((sum, value, i) => sum + value * v[i]!, 0) / 1.2);
  }
  for (let i = 1; i + 1 < points.length; i++) {
    const a = points[0]!, b = points[i]!, c = points[i + 1]!, u = b.map((v, k) => v - a[k]!), v = c.map((value, k) => value - a[k]!);
    if (Math.hypot(u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!) > 1e-10) piece.indices.push(offset, offset + i, offset + i + 1);
  }
}
function up(piece: GroundPiece, points: readonly Point3[]) {
  const [a, b, c] = points as [Point3, Point3, Point3];
  polygon(piece, (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]) < 0 ? [...points].reverse() : points);
}
function wall(piece: GroundPiece, a: Point3, b: Point3, floor: number) {
  // Two windings retain the current ground material's one-sided rendering contract.
  const ps: Point3[] = [a, b, [b[0], floor, b[2]], [a[0], floor, a[2]]];
  polygon(piece, ps); polygon(piece, [...ps].reverse());
}
export function entranceBox(frame: EntranceFrame, along0: number, along1: number, across0: number, across1: number, top: number, bottom: number, tag: string): GroundPiece {
  assert.ok(along1 > along0 && across1 > across0 && top > bottom);
  const piece = mesh(tag), ps = [[along0, across0], [along1, across0], [along1, across1], [along0, across1]].map(([s, t]) => entrancePoint(frame, s!, t!, top));
  up(piece, ps);
  for (let i = 0; i < 4; i++) wall(piece, ps[i]!, ps[(i + 1) % 4]!, bottom);
  return piece;
}
export function entranceFlight(frame: EntranceFrame, start: number, run: number, width: number, steps: number, bottom: number, rise: number, tag: string, across = 0): GroundPiece[] {
  assert.ok(run > 0 && width > 0 && Number.isInteger(steps) && steps > 0 && rise > 0);
  return Array.from({length: steps}, (_, i) => entranceBox(frame, start + run * i / steps, start + run * (i + 1) / steps, across - width / 2, across + width / 2, bottom + rise * (i + 1) / steps, bottom - .05, tag));
}

/** Replace terrain humps with a bounded apron. The outer edge agrees with every source ground
 * segment. The interior is level at the foot; raised architecture supplies its own solid faces. */
export function entranceApron(triangles: readonly GroundTriangle[], region: AppendRectangle, targetHeight: (x: number, z: number) => number, feather = 1.5): GroundPiece {
  assert.ok(feather > 0);
  const piece = mesh('entrance:apron'), stations = boundaryStations(triangles, region), [x0, z0, x1, z1] = region;
  const nx = Math.ceil(x1 - x0), nz = Math.ceil(z1 - z0);
  const yAt = (x: number, z: number) => {
    const old = surfaceHeight(triangles, x, z); assert.ok(old !== null, `Missing source apron support at ${x},${z}`);
    const w = Math.min(1, Math.max(0, Math.min(x - x0, x1 - x, z - z0, z1 - z) / feather));
    return old * (1 - w) + targetHeight(x, z) * w;
  };
  for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) {
    const xa = x0 + (x1 - x0) * ix / nx, xb = x0 + (x1 - x0) * (ix + 1) / nx;
    const za = z0 + (z1 - z0) * iz / nz, zb = z0 + (z1 - z0) * (iz + 1) / nz;
    const ring: [number, number][] = [[xa, za]];
    if (iz === 0) for (const s of stations[0]) if (s > xa + 1e-8 && s < xb - 1e-8) ring.push([s, za]);
    ring.push([xb, za]);
    if (ix === nx - 1) for (const s of stations[1]) if (s > za + 1e-8 && s < zb - 1e-8) ring.push([xb, s]);
    ring.push([xb, zb]);
    if (iz === nz - 1) for (const s of [...stations[2]].reverse()) if (s > xa + 1e-8 && s < xb - 1e-8) ring.push([s, zb]);
    ring.push([xa, zb]);
    if (ix === 0) for (const s of [...stations[3]].reverse()) if (s > za + 1e-8 && s < zb - 1e-8) ring.push([xa, s]);
    const offset = piece.positions.length / 3;
    for (const [x, z] of ring) { piece.positions.push(x, yAt(x, z), z); piece.uvs.push(x / 1.2, z / 1.2); }
    // A centre fan retains every XY-collinear station, even when its source Y changes.
    // Earcut is allowed to discard such points and would leave a 3D slit against the old floor.
    const cx = (xa + xb) / 2, cz = (za + zb) / 2, centre = piece.positions.length / 3;
    piece.positions.push(cx, yAt(cx, cz), cz); piece.uvs.push(cx / 1.2, cz / 1.2);
    for (let i = 0; i < ring.length; i++) piece.indices.push(centre, offset + (i + 1) % ring.length, offset + i);
  }
  return piece;
}

/** The source register footprint groups the flanking blocks with the lower flight. They must
 * remain distinct: eight lower risers, landing, four broad upper risers, then three door bays. */
export function universityEntrance(triangles: readonly GroundTriangle[]): EntrancePatch {
  const frame = UNIVERSITY_FRAME, foot = UNIVERSITY_FOOT_HEIGHT, landing = foot + UNIVERSITY_LOWER_RISE, top = landing + UNIVERSITY_UPPER_RISE;
  const pieces: GroundPiece[] = [{...entranceApron(triangles, UNIVERSITY_REGION, () => foot), tag: 'entrance:university-apron'}];
  pieces.push(...entranceFlight(frame, 0, 2.8, 13.4, 8, foot, UNIVERSITY_LOWER_RISE, 'entrance:university-lower'));
  pieces.push(entranceBox(frame, 2.8, 4.1, -6.7, 6.7, landing, foot - .05, 'entrance:university-landing'));
  pieces.push(...entranceFlight(frame, 4.1, 1.4, 11, 4, landing, UNIVERSITY_UPPER_RISE / 2, 'entrance:university-upper-broad'));
  for (const across of [-3.8, 0, 3.8]) pieces.push(...entranceFlight(frame, 5.5, 1.4, 2.6, 4, landing + UNIVERSITY_UPPER_RISE / 2, UNIVERSITY_UPPER_RISE / 2, 'entrance:university-door-bay', across));
  pieces.push(entranceBox(frame, 6.9, 7.6, -5.5, 5.5, top, foot - .05, 'entrance:university-door-landing'));
  for (const side of [-1, 1]) {
    const a = side < 0 ? -8.45 : 6.7, b = side < 0 ? -6.7 : 8.45;
    pieces.push(entranceBox(frame, 0, 4.1, a, b, landing + .2, foot - .05, 'entrance:university-cheek'));
    const centre = side * 1.9;
    pieces.push(entranceBox(frame, 5.5, 7.6, centre - .6, centre + .6, top + .12, foot - .05, 'entrance:university-column-plinth'));
  }
  return {id: 'university', region: UNIVERSITY_REGION, pieces, observations: {
    sourceParts: ['472018', '472023', '472024', '472025'], osmWay: '27184047', sourceFlight: 'ylre-472018+472023+472024',
    streetViewPanorama: 'IQJ0fJOOhTjz_4nEZ8JIAQ', streetViewDate: 'August 2024',
    lowerSteps: 8, upperBroadSteps: 4, upperDoorBaySteps: 4, lowerWidth: 13.4, outerWidth: 16.9, upperWidth: 11,
    footHeight: foot, landingHeight: landing, doorHeight: top, frame,
    limitations: 'Subdivision, tread run, upper rise and plinth dimensions are reference-led approximations, not a measured architectural survey. Google imagery supplies visual observations only.',
  }};
}

export const PALACE_REGION: AppendRectangle = [70, -23, 83, 18];
export const PALACE_NORTH_APPROACH = [73.75, -10.45] as const;
export const PALACE_SOUTH_APPROACH = [73.75, 3.75] as const;
export const PALACE_NORTH_FRAME: EntranceFrame = {origin: [75.87785547917186, -10.379735439920985], uphill: [.998524595, -.054301319]};
export const PALACE_SOUTH_FRAME: EntranceFrame = {origin: [76.3428, 3.75], uphill: [.999237, -.039057]};

// Exterior curb of City street part58569, including both genuine frontage returns. Only the
// first/last points extend the same surveyed frontage edges to the bounded work rectangle.
export const PALACE_CURB: readonly (readonly [number, number])[] = [
  [77.4702 + (78.6653 - 77.4702) * (-23 + 47.4207) / (-19.2751 + 47.4207), -23],
  [78.6653, -19.2751], [72.0137, -19.0312], [73.2961, 12.7909], [80.0262, 12.5831],
  [80.0262 + (81.1977 - 80.0262) * (18 - 12.5831) / (38.4468 - 12.5831), 18],
];

/** Earcut may remove XY-collinear perimeter points. Reinsert each in the returned triangle
 * edge so a changing height remains an exact piecewise-linear boundary after Float32 export. */
export function retainedBoundaryTriangles(ring: readonly (readonly [number, number])[]): number[] {
  const ids = earcut(ring.flat()), used = new Set(ids);
  for (let id = 0; id < ring.length; id++) {
    if (used.has(id)) continue;
    const p = ring[id]!;
    if ([...used].some(i => Math.hypot(ring[i]![0] - p[0], ring[i]![1] - p[1]) < 1e-9)) continue;
    let inserted = false;
    for (let t = 0; t < ids.length && !inserted; t += 3) for (let k = 0; k < 3; k++) {
      const a = ids[t + k]!, b = ids[t + (k + 1) % 3]!, c = ids[t + (k + 2) % 3]!, pa = ring[a]!, pb = ring[b]!;
      const dx = pb[0] - pa[0], dz = pb[1] - pa[1], length2 = dx * dx + dz * dz;
      if (length2 < 1e-16) continue;
      const s = ((p[0] - pa[0]) * dx + (p[1] - pa[1]) * dz) / length2;
      if (s <= 1e-8 || s >= 1 - 1e-8 || Math.abs((p[0] - pa[0]) * dz - (p[1] - pa[1]) * dx) > 1e-8) continue;
      ids.splice(t, 3, a, id, c, id, b, c); used.add(id); inserted = true; break;
    }
    assert.ok(inserted, 'Every distinct source boundary station must remain in the floor triangulation');
  }
  return ids;
}

function addBoundaryStations(ring: readonly (readonly [number, number])[], region: AppendRectangle, stations: ReturnType<typeof boundaryStations>): [number, number][] {
  const [x0, z0, x1, z1] = region, result: [number, number][] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!; result.push([a[0], a[1]]);
    let values: number[] | null = null, varying: 0 | 1 = 0;
    if (Math.abs(a[1] - z0) < 1e-8 && Math.abs(b[1] - z0) < 1e-8) values = stations[0];
    else if (Math.abs(a[0] - x1) < 1e-8 && Math.abs(b[0] - x1) < 1e-8) {values = stations[1]; varying = 1;}
    else if (Math.abs(a[1] - z1) < 1e-8 && Math.abs(b[1] - z1) < 1e-8) values = stations[2];
    else if (Math.abs(a[0] - x0) < 1e-8 && Math.abs(b[0] - x0) < 1e-8) {values = stations[3]; varying = 1;}
    if (!values) continue;
    const low = Math.min(a[varying], b[varying]), high = Math.max(a[varying], b[varying]);
    const inside = values.filter(s => s > low + 1e-8 && s < high - 1e-8).sort((p, q) => a[varying] < b[varying] ? p - q : q - p);
    for (const s of inside) result.push(varying === 0 ? [s, a[1]] : [a[0], s]);
  }
  return result;
}

/** The old floor may contain overlapping layers with different heights at one cut station.
 * Close all of those actual cut edges with disjoint vertical return bands. Sampling one maximum
 * height cannot represent that topology. No floor outside the rectangle is raised or removed. */
export function apronBoundaryReturns(source: readonly GroundTriangle[], floors: readonly GroundPiece[], region: AppendRectangle): GroundPiece {
  const result = mesh('entrance:palace-retaining-boundary-return');
  const next: GroundTriangle[] = floors.flatMap(p => Array.from({length: p.indices.length / 3}, (_, t) => [0, 1, 2].map(k => p.positions.slice(p.indices[t * 3 + k]! * 3, p.indices[t * 3 + k]! * 3 + 3)) as unknown as GroundTriangle));
  const stations = boundaryStations([...source, ...next], region), [x0, z0, x1, z1] = region;
  const lines = [[0, z0], [2, x1], [0, z1], [2, x0]] as const;
  type Interval = {a: number; b: number; ya: number; yb: number};
  for (const [line, [vary, fixed]] of lines.entries()) {
    const other = vary === 0 ? 2 : 0;
    const intervals = (triangles: readonly GroundTriangle[]): Interval[] => triangles.flatMap(triangle => {
      const [a, b, c] = triangle;
      if (Math.abs((b[0] - a[0]) * (c[2] - a[2]) - (c[0] - a[0]) * (b[2] - a[2])) < 1e-10) return [];
      const points: {s: number; y: number}[] = [];
      for (let i = 0; i < 3; i++) {
        const p = triangle[i]!, q = triangle[(i + 1) % 3]!;
        if (p[other] === fixed) points.push({s: p[vary], y: p[1]});
        if ((p[other] < fixed && q[other] > fixed) || (p[other] > fixed && q[other] < fixed)) {
          const t = (fixed - p[other]) / (q[other] - p[other]); points.push({s: p[vary] + (q[vary] - p[vary]) * t, y: p[1] + (q[1] - p[1]) * t});
        }
      }
      points.sort((p, q) => p.s - q.s); const p = points[0], q = points.at(-1);
      return p && q && q.s - p.s > 1e-8 ? [{a: p.s, b: q.s, ya: p.y, yb: q.y}] : [];
    });
    const old = intervals(source), current = intervals(next), height = (v: Interval, s: number) => v.ya + (v.yb - v.ya) * (s - v.a) / (v.b - v.a);
    for (let i = 0; i + 1 < stations[line]!.length; i++) {
      const a = stations[line]![i]!, b = stations[line]![i + 1]!, mid = (a + b) / 2;
      const active = [...old, ...current].filter(v => v.a <= mid && v.b >= mid), newActive = current.filter(v => v.a <= mid && v.b >= mid);
      if (!newActive.length || !active.length) continue;
      active.sort((p, q) => height(p, mid) - height(q, mid)); const lower = active[0]!, upper = active.at(-1)!;
      if (Math.max(Math.abs(height(upper, a) - height(lower, a)), Math.abs(height(upper, b) - height(lower, b))) < 1e-7) continue;
      const point = (s: number, y: number): Point3 => vary === 0 ? [s, y, fixed] : [fixed, y, s];
      const quad = [point(a, height(upper, a)), point(b, height(upper, b)), point(b, height(lower, b)), point(a, height(lower, a))];
      polygon(result, quad); polygon(result, [...quad].reverse());
    }
  }
  return result;
}

/** A single floor owner on each side of the exact surveyed curb. Old raised-ground sheets
 * and curb slivers are replaced together, rather than preserving their folds at a patch cut. */
export function palaceApron(triangles: readonly GroundTriangle[], roadTriangles: readonly GroundTriangle[], base: (x: number, z: number) => number): GroundPiece[] {
  const region = PALACE_REGION, [x0, z0, x1, z1] = region;
  const walkRing = [...PALACE_CURB.map(p => [...p] as [number, number]), [x1, z1] as [number, number], [x1, z0] as [number, number]];
  const walk = [[walkRing]], stations = boundaryStations(triangles, region);
  const sidewalk = mesh('entrance:palace-apron'), road = {...mesh('entrance:palace-road'), finish: 'setts' as const}, curb = mesh('entrance:palace-retaining-curb');
  const height = (x: number, z: number, isRoad: boolean) => {
    const distance = Math.min(x - x0, x1 - x, z - z0, z1 - z), w = Math.max(0, Math.min(1, distance / 1.5));
    // Only the exterior feather consults the original visible floor. At this clean boundary,
    // an overlapping fallback can be a few centimetres higher than the road-specific mesh.
    // Its actual stations and heights must close the join; interior humps are fully replaced.
    const old = surfaceHeight(triangles, x, z);
    assert.ok(old !== null, 'Source must support every exterior apron boundary');
    return old * (1 - w) + (base(x, z) - (isRoad ? .12 : 0)) * w;
  };
  for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) {
    const tile: [number, number][][] = [[[x, z], [x + 1, z], [x + 1, z + 1], [x, z + 1]]];
    for (const isRoad of [false, true]) {
      const clipped = (isRoad ? polygonClipping.difference([tile], walk) : polygonClipping.intersection([tile], walk)) as [number, number][][][];
      const piece = isRoad ? road : sidewalk;
      for (const polygon of clipped) {
        assert.equal(polygon.length, 1, 'One-metre curb tiles must not contain a hole');
        const ring = addBoundaryStations(polygon[0]!.slice(0, -1), region, stations);
        const ids = retainedBoundaryTriangles(ring), offset = piece.positions.length / 3;
        for (const [px, pz] of ring) {piece.positions.push(px, height(px, pz, isRoad), pz); piece.uvs.push(px / 2, pz / 2);}
        for (let i = 0; i < ids.length; i += 3) {
          const a = ring[ids[i]!]!, b = ring[ids[i + 1]!]!, c = ring[ids[i + 2]!]!;
          const up = (b[1] - a[1]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[1] - a[1]);
          piece.indices.push(offset + ids[i]!, offset + ids[i + (up < 0 ? 2 : 1)]!, offset + ids[i + (up < 0 ? 1 : 2)]!);
        }
      }
    }
  }
  for (let i = 0; i + 1 < PALACE_CURB.length; i++) {
    const a = PALACE_CURB[i]!, b = PALACE_CURB[i + 1]!, length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const splits = new Set([0, 1]);
    // Match the exact tile-boundary segmentation of the adjacent floor meshes.
    for (const axis of [0, 1] as const) if (a[axis] !== b[axis]) for (let k = Math.ceil(Math.min(a[axis], b[axis])); k < Math.max(a[axis], b[axis]); k++) splits.add((k - a[axis]) / (b[axis] - a[axis]));
    const ts = [...splits].filter(t => t >= 0 && t <= 1).sort((p, q) => p - q);
    for (let k = 0; k + 1 < ts.length; k++) {
      const at = (t: number) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t] as const, p = at(ts[k]!), q = at(ts[k + 1]!);
      const ps: Point3[] = [[p[0], height(p[0], p[1], false), p[1]], [q[0], height(q[0], q[1], false), q[1]], [q[0], height(q[0], q[1], true), q[1]], [p[0], height(p[0], p[1], true), p[1]]];
      if (Math.max(Math.abs(ps[0]![1] - ps[3]![1]), Math.abs(ps[1]![1] - ps[2]![1])) < 1e-8 || length < 1e-8) continue;
      polygon(curb, ps); polygon(curb, [...ps].reverse());
    }
  }
  return [sidewalk, road, curb, apronBoundaryReturns(triangles, [sidewalk, road], region)];
}

/** C0 joined ramp sections bend behind the stair piers and end on the terrace's actual edge.
 * Ramp floor and side cheeks have one owner; apron remains strictly below every raised section. */
export function perimeterRamp(sections: readonly {a: readonly [number, number]; b: readonly [number, number]; y: number}[], base: (x: number, z: number) => number): GroundPiece[] {
  assert.ok(sections.length >= 2);
  const floor = mesh('entrance:palace-perimeter-ramp'), cheeks = mesh('entrance:palace-retaining-ramp');
  for (let i = 0; i + 1 < sections.length; i++) {
    const a = sections[i]!, b = sections[i + 1]!, ps: Point3[] = [[a.a[0], a.y, a.a[1]], [a.b[0], a.y, a.b[1]], [b.b[0], b.y, b.b[1]], [b.a[0], b.y, b.a[1]]];
    up(floor, ps);
    for (const [p, q] of [[ps[0]!, ps[3]!], [ps[1]!, ps[2]!]] as const) {
      const wallPoints: Point3[] = [p, q, [q[0], base(q[0], q[2]), q[2]], [p[0], base(p[0], p[2]), p[2]]];
      if (Math.max(p[1] - wallPoints[3]![1], q[1] - wallPoints[2]![1]) < 1e-8) continue;
      polygon(cheeks, wallPoints); polygon(cheeks, [...wallPoints].reverse());
    }
  }
  return [floor, cheeks];
}

/** End-flight step counts come from the opened street-level reference. Their two different
 * source approach heights determine a common riser and a level terrace, rather than allowing
 * the coarse terrain's erroneous west-facing "central flight" to define the architecture. */
export function palaceEntrance(triangles: readonly GroundTriangle[], roadTriangles: readonly GroundTriangle[] = triangles): EntrancePatch {
  const northFoot = surfaceHeight(triangles, ...PALACE_NORTH_APPROACH), southFoot = surfaceHeight(triangles, ...PALACE_SOUTH_APPROACH);
  assert.ok(northFoot !== null && southFoot !== null && northFoot > southFoot, 'Palace source approach anchors must rise northwards');
  const riser = (northFoot - southFoot) / 2, top = northFoot + 5 * riser;
  assert.ok(riser >= .12 && riser <= .23, 'Street reference and source approaches must give a plausible common riser');
  const base = (_x: number, z: number) => northFoot + (southFoot - northFoot) * (z - PALACE_NORTH_APPROACH[1]) / (PALACE_SOUTH_APPROACH[1] - PALACE_NORTH_APPROACH[1]);
  const pieces: GroundPiece[] = palaceApron(triangles, roadTriangles, base);
  const north = {...PALACE_NORTH_FRAME, uphill: PALACE_NORTH_FRAME.uphill.map(v => v / Math.hypot(...PALACE_NORTH_FRAME.uphill)) as [number, number]};
  const south = {...PALACE_SOUTH_FRAME, uphill: PALACE_SOUTH_FRAME.uphill.map(v => v / Math.hypot(...PALACE_SOUTH_FRAME.uphill)) as [number, number]};
  pieces.push(...entranceFlight(north, 0, 5 * .35, 3.7, 5, northFoot, 5 * riser, 'entrance:palace-north'));
  pieces.push(entranceBox(north, 5 * .35, 2.6862596548093065, -1.85, 1.85, top, northFoot - .05, 'entrance:palace-north-landing'));
  pieces.push(...entranceFlight(south, 0, 7 * .35, 3.7, 7, southFoot, 7 * riser, 'entrance:palace-south'));
  pieces.push(entranceBox(south, 7 * .35, 2.84, -1.85, 1.85, top, southFoot - .05, 'entrance:palace-south-landing'));
  const terrace: EntranceFrame = {origin: [78.56015188740258, -10.525601513593926], uphill: [south.uphill[0], south.uphill[1]]};
  pieces.push(entranceBox(terrace, 0, 1.65, -1.8, 16.2, top, southFoot - .08, 'entrance:palace-retaining-terrace'));
  const section = (along0: number, along1: number, across: number) => ({a: entrancePoint(terrace, along0, across, top).filter((_, i) => i !== 1) as [number, number], b: entrancePoint(terrace, along1, across, top).filter((_, i) => i !== 1) as [number, number], y: top});
  pieces.push(...perimeterRamp([
    {a: [76.35, -18.4], b: [78.15, -18.4], y: base(77.25, -18.4)},
    {a: [77.4, -15.4], b: [79.2, -15.4], y: (base(77.25, -18.4) + top) / 2},
    section(.25, 1.45, -1.8),
  ], base));
  pieces.push(...perimeterRamp([
    {a: [77.4, 11.6], b: [79, 11.6], y: base(78.2, 11.6)},
    {a: [78, 8.6], b: [79.6, 8.6], y: (base(78.2, 11.6) + top) / 2},
    section(.25, 1.45, 16.2),
  ], base));
  for (const [frame, run, foot] of [[north, 2.6862596548093065, northFoot], [south, 2.84, southFoot]] as const) for (const side of [-1, 1]) {
    const a = side < 0 ? -2.27 : 1.85, b = side < 0 ? -1.85 : 2.27;
    pieces.push(entranceBox(frame, -.08, run + .08, a, b, top + .18, foot - .08, 'entrance:palace-cheek'));
  }
  // The central facade is a vertical granite wall, three basement grilles and a railing,
  // with clear openings over both end flights. It has no central stair flight.
  for (let t = 1.9; t <= 12.4; t += .7) pieces.push(entranceBox(terrace, -.035, .005, t - .018, t + .018, top + .98, top, 'entrance:palace-iron-post'));
  for (const y of [top + .18, top + .96]) pieces.push(entranceBox(terrace, -.04, .01, 1.9, 12.4, y + .025, y - .025, 'entrance:palace-iron-rail'));
  for (const centre of [3.3, 7, 10.7]) {
    pieces.push(entranceBox(terrace, -.042, -.01, centre - .56, centre + .56, top - .18, top - .67, 'entrance:palace-grille'));
  }
  return {id: 'palace', region: PALACE_REGION, pieces, observations: {
    sourceParts: ['58581', '58582', '58583', '58584', '58585', '58586', '58588', '58590', '58591', '58594', '58595', '58596'],
    streetViewPanorama: 'BUK0H3Kabg3u9WBVC-pg3Q', streetViewDate: 'August 2024', northSteps: 5, southSteps: 7,
    uphillDirection: 'east', northApproach: [...PALACE_NORTH_APPROACH, northFoot], southApproach: [...PALACE_SOUTH_APPROACH, southFoot],
    riser, treadDepth: .35, northLandingDepth: 2.6862596548093065 - 5 * .35, southLandingDepth: 2.84 - 7 * .35,
    terraceHeight: top, northFrame: north, southFrame: south,
    surveyedCurb: PALACE_CURB, perimeterRamps: 'Two smooth section lofts bend behind the source lamp piers to the common terrace. Their approach heights follow the source street grade; their final sections share the exact terrace boundary.',
    limitations: 'Step counts and architectural subdivision are street-level observations. Width, rail, grille, pier and ramp subdivisions are original approximations fitted to licensed register footprints and existing source street/terrace height anchors. Noisy terrain bumps are not architectural authority. Geometry outside the expanded entrance perimeter remains exact.',
  }};
}

/** Every emitted vertex on a shared grid edge is rounded by the same Float32 serialization. */
export function entranceCells(patches: readonly EntrancePatch[], cellSize = 128): GroundPiece[] {
  const result: GroundPiece[] = [];
  for (const patch of patches) {
    const [x0, z0, x1, z1] = patch.region;
    for (let cx = Math.floor(x0 / cellSize); cx < Math.ceil(x1 / cellSize); cx++) for (let cz = Math.floor(z0 / cellSize); cz < Math.ceil(z1 / cellSize); cz++) {
      const cell = `c_${cx < 0 ? 'm' : 'p'}${String(Math.abs(cx)).padStart(2, '0')}_${cz < 0 ? 'm' : 'p'}${String(Math.abs(cz)).padStart(2, '0')}`;
      for (const piece of clipGroundToRectangle(patch.pieces, [cx * cellSize, cz * cellSize, (cx + 1) * cellSize, (cz + 1) * cellSize])) result.push({...piece, cell});
    }
  }
  return prepareNativeFrontier(result).pieces;
}
