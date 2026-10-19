// Small reviewed exceptions where a retained source road crosses a surveyed
// shared surface. These are authored grade approximations, not new road land.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import polygonClipping from 'polygon-clipping';
import type { RoadGraph, TerrainGrid } from '../../../packages/world-schema/src/index.ts';
import { applyCarriagewayGrade, buildCarriagewayGrade, type CarriagewayGradeOptions } from './carriageway-grade.ts';
import { bbox, pointInPolygon, ringDistance, signedArea, type LocalPolygon, type Pt } from './geometry.ts';
import type { GroundPiece } from './ground.ts';

type Geometry = Pt[][][];
export interface DrivableCorridorPlan {
  readonly schemaVersion: 1;
  readonly sourceHashes: { readonly roads: string; readonly osm: string; readonly streetParts: string };
  readonly vehicleHalfWidthMetres: number;
  readonly marginMetres: number;
  readonly reviewedGeometry?: {
    readonly baselineRoadsSha256: string;
    readonly lanePointsSha256: Readonly<Record<string, string>>;
  };
  readonly corridors: readonly {
    readonly id: string;
    readonly wayId: number;
    readonly laneIds: readonly string[];
    /** Measured stations along each retained lane, in its travel direction. */
    readonly stationsMetres: Readonly<Record<string, readonly [number, number]>>;
    readonly sourcePartIds: readonly string[];
    readonly reason: string;
  }[];
}
type Area = CarriagewayGradeOptions['protectedArea'];
const areaOf = (g: Geometry) => g.reduce((sum, p) => sum + Math.abs(signedArea(p[0]!)) - p.slice(1).reduce((s, r) => s + Math.abs(signedArea(r)), 0), 0);
const inside = (point: Pt, p: LocalPolygon) => pointInPolygon(point, p.rings) || p.rings.some(r => ringDistance(point, r) < 1e-7);
function union(geometries: Geometry[]): Geometry {
  const present = geometries.filter(g => g.length);
  return present.length ? polygonClipping.union(present[0]!, ...present.slice(1)) as Geometry : [];
}
function clip(operation: 'intersection' | 'difference', a: Geometry, b: Geometry): Geometry {
  if (!a.length || !b.length) return operation === 'intersection' ? [] : a;
  try { return polygonClipping[operation](a, b) as Geometry; }
  catch (original) {
    const snap = (g: Geometry): Geometry => g.map(p => p.map(r => r.map(([x, n]) => [Math.round(x * 1e7) / 1e7, Math.round(n * 1e7) / 1e7])));
    try { return polygonClipping[operation](snap(a), snap(b)) as Geometry; }
    catch (retry) { throw new AggregateError([original, retry], 'Reviewed corridor clip failed at source and 0.1um precision'); }
  }
}
function sourceIsProtected(p: LocalPolygon): boolean {
  return /silta|portaat|tukimuuri|avokallio|pensas/.test(`${p.properties['paatyyppi'] ?? ''} ${p.properties['alatyyppi'] ?? ''}`.toLowerCase());
}
function sourceCanBeReviewed(p: LocalPolygon): boolean {
  return (p.properties['paatyyppi'] === 'Ajorata' && ['Ajorata', 'Tonttiliittymä'].includes(String(p.properties['alatyyppi']))) ||
    (p.properties['paatyyppi'] === 'Kevyt liikenne' && ['Kevyt liikenne', 'Jalankulkualue', 'Jalkakäytävä'].includes(String(p.properties['alatyyppi'])));
}
function stationSlice(points: readonly Pt[], stations: readonly [number, number]): Pt[] {
  const lengths = [0];
  for (let i = 1; i < points.length; i++) lengths.push(lengths[i - 1]! + Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1]));
  assert.ok(stations.length === 2 && stations.every(Number.isFinite) && stations[0] >= 0 && stations[1] > stations[0] && stations[1] <= lengths.at(-1)! + 1e-6, 'Corridor stations must be a bounded interval on the retained lane');
  const at = (s: number): Pt => {
    for (let i = 1; i < points.length; i++) if (s <= lengths[i]! + 1e-8) {
      const t = (s - lengths[i - 1]!) / (lengths[i]! - lengths[i - 1]! || 1), a = points[i - 1]!, b = points[i]!;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    return [...points.at(-1)!];
  };
  return [at(stations[0]), ...points.filter((_, i) => lengths[i]! > stations[0] && lengths[i]! < stations[1]), at(stations[1])];
}
function rectangle(area: Area, margin: number): LocalPolygon {
  const ring: Pt[] = [[area.minX - margin, -area.maxZ - margin], [area.maxX + margin, -area.maxZ - margin], [area.maxX + margin, -area.minZ + margin], [area.minX - margin, -area.minZ + margin]];
  return { id: 'accepted-district-and-margin', rings: [ring], bbox: bbox([ring]), properties: {} };
}

/** Round end caps keep a curb from crossing the retained lane's endpoint.
 * Their radius is only the reviewed buffer half-width; all caps are still
 * clipped to the exact surveyed source and checked for full vehicle support.
 * Interior joins fill the swept offset wedges. */
function strip(points: readonly Pt[], halfWidth: number): Geometry {
  const pieces: Geometry[] = [], sides: { a: Pt; b: Pt; normal: Pt }[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = points[i]!, dx = b[0] - a[0], dn = b[1] - a[1], length = Math.hypot(dx, dn);
    if (length < 1e-8) continue;
    const normal: Pt = [-dn / length * halfWidth, dx / length * halfWidth];
    sides.push({ a, b, normal });
    pieces.push([[[[a[0] + normal[0], a[1] + normal[1]], [a[0] - normal[0], a[1] - normal[1]], [b[0] - normal[0], b[1] - normal[1]], [b[0] + normal[0], b[1] + normal[1]]]]]);
  }
  for (let i = 1; i < sides.length; i++) {
    const previous = sides[i - 1]!, next = sides[i]!, p = next.a;
    if (Math.hypot(previous.b[0] - p[0], previous.b[1] - p[1]) > 1e-7) continue;
    for (const side of [-1, 1]) pieces.push([[[p, [p[0] + previous.normal[0] * side, p[1] + previous.normal[1] * side], [p[0] + next.normal[0] * side, p[1] + next.normal[1] * side]]]]);
  }
  if (sides.length) for (const centre of [sides[0]!.a, sides.at(-1)!.b]) {
    const cap: Pt[] = Array.from({ length: 32 }, (_, i) => [centre[0] + Math.cos(i * Math.PI / 16) * halfWidth, centre[1] + Math.sin(i * Math.PI / 16) * halfWidth]);
    pieces.push([[cap]]);
  }
  return union(pieces);
}

export function resolveDrivableCorridors(plan: DrivableCorridorPlan, input: {
  readonly roads: RoadGraph;
  readonly parts: readonly LocalPolygon[];
  readonly sourceHashes: DrivableCorridorPlan['sourceHashes'];
  readonly protectedArea: Area;
  readonly protectedMarginMetres: number;
  readonly foundations: readonly LocalPolygon[];
  readonly fixedSupports?: readonly LocalPolygon[];
  readonly rawDeckPartIds?: readonly string[];
}) {
  assert.equal(plan.schemaVersion, 1);
  for (const key of ['roads', 'osm', 'streetParts'] as const) {
    assert.match(plan.sourceHashes[key], /^[a-f0-9]{64}$/);
    assert.equal(plan.sourceHashes[key], input.sourceHashes[key], `Reviewed corridor ${key} hash changed`);
  }
  assert.equal(input.roads.source.sha256, plan.sourceHashes.osm, 'Road graph is not bound to the reviewed OSM snapshot');
  assert.ok(plan.vehicleHalfWidthMetres >= 0.967 && plan.vehicleHalfWidthMetres <= 1, 'Corridor must fit the measured vehicle');
  assert.ok(plan.marginMetres >= 0.15 && plan.marginMetres <= 0.2, 'Corridor margin must remain narrowly bounded');
  assert.ok(plan.corridors.length > 0 && plan.corridors.length <= 16);
  const byId = new Map(input.parts.map(p => [p.id, p])), lanes = new Map(input.roads.lanes.map(l => [l.id, l]));
  const rawIds = new Set(input.rawDeckPartIds ?? []), protectedSources = input.parts.filter(p => sourceIsProtected(p) || rawIds.has(p.id));
  const keep = rectangle(input.protectedArea, input.protectedMarginMetres);
  const protectedSurfaces = [...protectedSources, ...input.foundations, ...(input.fixedSupports ?? []), keep];
  const reviewedIds = new Set<string>(), parts: LocalPolygon[] = [];
  const records: { id: string; wayId: number; laneIds: readonly string[]; stationsMetres: Readonly<Record<string, readonly [number, number]>>; sourcePartIds: readonly string[]; area: number; widthProbes: number }[] = [];
  for (const declaration of plan.corridors) {
    assert.ok(declaration.id && !reviewedIds.has(declaration.id), 'Corridor declarations need unique identities'); reviewedIds.add(declaration.id);
    assert.ok(declaration.reason.trim().length > 0 && Number.isSafeInteger(declaration.wayId));
    assert.ok(declaration.laneIds.length > 0 && declaration.sourcePartIds.length > 0);
    const sourceParts = input.parts.filter(p => declaration.sourcePartIds.includes(p.id));
    for (const id of declaration.sourcePartIds) assert.ok(byId.has(id), `Missing reviewed corridor source ${id}`);
    assert.ok(sourceParts.every(p => sourceCanBeReviewed(p) && !sourceIsProtected(p) && !rawIds.has(p.id)), 'Only reviewed shared surfaces and driveways can become a drivable corridor');
    assert.deepEqual(Object.keys(declaration.stationsMetres).sort(), [...declaration.laneIds].sort(), 'Every selected lane requires explicit bounded stations');
    const reviewed: Geometry = union(sourceParts.map(p => [p.rings]));
    const axes = declaration.laneIds.map(id => {
      const lane = lanes.get(id); assert.ok(lane, `Missing reviewed corridor lane ${id}`);
      assert.equal(lane.wayId, declaration.wayId, `Corridor lane ${id} changed source way`);
      if (plan.reviewedGeometry) {
        assert.match(plan.reviewedGeometry.baselineRoadsSha256, /^[a-f0-9]{64}$/);
        const expected = plan.reviewedGeometry.lanePointsSha256[id];
        assert.ok(expected, `Corridor lane ${id} has no reviewed literal geometry`);
        assert.equal(createHash('sha256').update(JSON.stringify(lane.points)).digest('hex'), expected, `Corridor lane ${id} differs from its reviewed literal geometry`);
      }
      assert.ok(lane.width >= plan.vehicleHalfWidthMetres * 2, `Lane ${id} cannot fit the vehicle`);
      assert.ok(!['steps', 'footway', 'path', 'cycleway', 'pedestrian'].includes(lane.highway), `Lane ${id} is not a retained drivable road`);
      return stationSlice(lane.points.map(p => [p[0], -p[2]] as Pt), declaration.stationsMetres[id]!);
    });
    const selected = clip('intersection', union(axes.map(points => strip(points, plan.vehicleHalfWidthMetres + plan.marginMetres))), reviewed);
    assert.ok(areaOf(selected) > 1e-7, `Corridor ${declaration.id} has no reviewed source intersection`);
    for (const forbidden of protectedSurfaces) assert.ok(areaOf(clip('intersection', selected, [forbidden.rings])) <= 1e-7, `Corridor ${declaration.id} intersects protected source ${forbidden.id}`);
    // The margin may be clipped by a narrower real source road. The physical
    // vehicle must still have support in reviewed or ordinary surveyed roads.
    const supportParts = [...sourceParts, ...input.parts.filter(p => p.properties['paatyyppi'] === 'Ajorata' && p.properties['alatyyppi'] === 'Ajorata' && !rawIds.has(p.id))];
    const vehicleStrip = union(axes.map(points => strip(points, plan.vehicleHalfWidthMetres)));
    const unsupported = clip('difference', vehicleStrip, union(supportParts.map(p => [p.rings]))), unsupportedArea = areaOf(unsupported);
    assert.ok(unsupportedArea <= 1e-7, `Corridor ${declaration.id} physical vehicle strip lacks reviewed or ordinary surveyed source support (${unsupportedArea} m2; bounds ${unsupported.length ? bbox(unsupported.flat()) : 'empty'})`);
    for (const forbidden of protectedSurfaces) assert.ok(areaOf(clip('intersection', vehicleStrip, [forbidden.rings])) <= 1e-7, `Corridor ${declaration.id} physical vehicle strip intersects protected source ${forbidden.id}`);
    let widthProbes = 0;
    for (const axis of axes) for (let i = 1; i < axis.length; i++) {
      const a = axis[i - 1]!, b = axis[i]!, dx = b[0] - a[0], dn = b[1] - a[1], length = Math.hypot(dx, dn); if (length < 1e-8) continue;
      for (let s = 0, count = Math.max(1, Math.ceil(length / 0.25)); s <= count; s++) {
        const x = a[0] + dx * s / count, n = a[1] + dn * s / count;
        for (const across of [-plan.vehicleHalfWidthMetres, 0, plan.vehicleHalfWidthMetres]) {
          const p: Pt = [x - dn / length * across, n + dx / length * across]; widthProbes++;
          assert.ok(supportParts.some(source => inside(p, source)), `Corridor ${declaration.id} has no surveyed vehicle support at ${p}`);
          assert.ok(!protectedSurfaces.some(source => inside(p, source)), `Corridor ${declaration.id} vehicle intersects protected source at ${p}`);
        }
      }
    }
    for (const source of sourceParts) for (const [index, rings] of clip('intersection', selected, [source.rings]).entries()) {
      parts.push({ id: `drivable-corridor:${declaration.id}:${source.id}:${index}`, rings, bbox: bbox(rings), properties: { ...source.properties, paatyyppi: 'Ajorata', alatyyppi: 'Ajorata', corridorSourcePartId: source.id, corridorWayId: declaration.wayId } });
    }
    records.push({ id: declaration.id, wayId: declaration.wayId, laneIds: declaration.laneIds, stationsMetres: declaration.stationsMetres, sourcePartIds: declaration.sourcePartIds, area: areaOf(selected), widthProbes });
  }
  return { parts, sourceParts: input.parts, fixedSupports: [...input.foundations, ...(input.fixedSupports ?? [])], placementGuards: protectedSurfaces, records, stats: { corridors: records.length, sourceParts: new Set(records.flatMap(r => r.sourcePartIds)).size, footprintArea: records.reduce((n, r) => n + r.area, 0), endCaps: 'round within the reviewed buffer half-width', authoringPolicy: 'Source-bound retained-road corridor with symmetric constrained grade; no new surveyed height or land is claimed' } };
}

/** A single field gives ordinary roads and reviewed shared surfaces the same
 * constrained grid nodes. In particular, corridor ends must not be stitched to
 * a second independently constrained field with a vertical gap. */
export function buildDrivableCorridorGrade(resolved: ReturnType<typeof resolveDrivableCorridors>, terrain: TerrainGrid, options: CarriagewayGradeOptions) {
  const field = buildCarriagewayGrade([...resolved.sourceParts, ...resolved.parts], terrain, options);
  // Foundation sampling alone cannot pin a triangle spanning its boundary.
  // Split at the exact nearby building/source-stair masks as well. The full
  // source polygon is retained; only masks in the new joins' maximum 16m
  // neighborhood participate. Bush placement guards do not alter roads
  // citywide, and heuristic entrance terraces are not independent sources.
  const nearbyFixed = resolved.fixedSupports.filter(f => resolved.parts.some(p => f.bbox[0] <= p.bbox[2] + 16 && f.bbox[2] >= p.bbox[0] - 16 && f.bbox[1] <= p.bbox[3] + 16 && f.bbox[3] >= p.bbox[1] - 16));
  field.protectedSurfaces = [...new Set([...field.protectedSurfaces, ...nearbyFixed])];
  return field;
}

export function applyDrivableCorridors(pieces: readonly GroundPiece[], kerbs: readonly GroundPiece[],
  resolved: ReturnType<typeof resolveDrivableCorridors>, terrain: TerrainGrid, options: CarriagewayGradeOptions,
  cellSize: number, foundations: readonly LocalPolygon[]) {
  const field = buildDrivableCorridorGrade(resolved, terrain, options);
  const graded = applyCarriagewayGrade(pieces, kerbs, field, cellSize, foundations);
  return { ...graded, stats: { ...graded.stats, corridorPlan: resolved.stats, corridorDeclarations: resolved.records } };
}
