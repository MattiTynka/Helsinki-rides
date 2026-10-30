import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {containsSupportedArea, supportsSegment, geodeticToGk25, pointAlong, polylineLength, validateRoadGraph, type GameplayBundle, type RoadGraph, type RoadLane, type RoadConnector, type VehicleDefinition, type Vec3} from '../../../packages/world-schema/src/index.ts';
import {pointInPolygon, type LocalPolygon} from './geometry.ts';
import {sourceSha256} from './source-files.ts';
import {supportsVehiclePose, supportsVehicleTransition, vehicleCoverageFootprint, VEHICLE_COVERAGE_CLEARANCE, type VehicleCoveragePose} from '../../../packages/sim/src/coverage-footprint.ts';
import type {InheritedWalkingSourceAuthority}from './inherited-road-bundle-context.ts';
import type {ReviewedRetainedWalkingCrossing} from './reviewed-retained-walking-crossing.ts';
import {mergeQualifiedFootways, type WalkingRouteSelection, type QualifiedFootwayAuthority} from './expansion-footway-merge.ts';
import {reviewedUdenmaankatuSourceParts,reviewedUdenmaankatuFloorSupport} from './reviewed-udenmaankatu-crossing.ts';
import type {UdenmaankatuRoadRoles} from './road-finite-crossing-context.ts';
import {reviewedPlazaSourceParts,reviewedPlazaFloorSupport} from './reviewed-plaza-service-corridors.ts';
import type {PlazaRoadRoles} from './inherited-road-bundle-context.ts';
import {qualifyPublicParkingAisleParts, type PublicParkingAisleReview} from './reviewed-vehicle-surfaces.ts';
import {assertReviewedEhrenstromSourceJoinRecord, reviewedEhrenstromSourceJoinContains, type ReviewedEhrenstromSourceJoin} from './reviewed-ehrenstrom-source-join.ts';
import {carryCurrentNavigation,currentCarryIds,assertCurrentNavigationCarry,type CurrentNavigationCarry}from './current-navigation-carry.ts';

type Rectangle = readonly [number, number, number, number];
export interface RoadSourceElement {type: 'node' | 'way' | 'relation'; id: number; lat?: number; lon?: number; nodes?: number[]; tags?: Record<string, string>; members?: {type: string; ref: number; role: string}[]}
export interface RoadQualification {id: string; partIds: string[]; surfaceReviews?: PublicParkingAisleReview[]}
export interface ReviewedRecordSurface {parts: readonly LocalPolygon[]; bridgeParts?: readonly LocalPolygon[]; sourceWitnesses: unknown}
export interface RoadRecordConflict {kind: 'nodes' | 'lanes' | 'connectors' | 'parking' | 'footways'; id: string; acceptedSha256: string; candidateSha256: string; reason: string}
export interface RoadMergeSelection {
  schemaVersion: 1;
  regions: Rectangle[];
  acceptedAnchorLaneIds: string[];
  lanes: RoadQualification[];
  /** Every retained lane segment made playable by the new supported area needs a fresh physical check. */
  retainedLanes?: RoadQualification[];
  footways?: RoadQualification[];
  retainedFootways?: RoadQualification[];
  walkingRoutes?: WalkingRouteSelection[];
  connectors: RoadQualification[];
  /** Explicit geometry may replace neither an accepted connector nor an accepted lane. */
  seamConnectors: {connector: RoadConnector; osmNodeId: number; partIds: string[]; retainedBoundary?: true; surfaceReviews?: PublicParkingAisleReview[]}[];
  /** Known refreshed-source conflicts are retained as witnesses; accepted records always win. */
  retainedConflicts: RoadRecordConflict[];
  structures: {wayId: number; kind: 'bridge'; partIds: string[]; reason: string}[];
  levelTransitions: {nodeId: number; fromWayId: number; toWayId: number; reason: string}[];
}
export interface RoadSupportTriangle {id: string; points: readonly [Vec3, Vec3, Vec3]; tag: string}
type RoadVehicleGeometry = Pick<VehicleDefinition, 'id' | 'collider' | 'wheels' | 'wheelRadius' | 'wheelWidth' | 'suspension'>;
export interface RoadPhysicalEnvelope {definitionIds: string[]; definitionsSha256: string; bodyHalfLength: number; bodyHalfWidth: number; tyreOuterHalfWidth: number; clearanceMetres: number; definitions: readonly RoadVehicleGeometry[]}
export function deriveRoadPhysicalEnvelope(definitions: readonly RoadVehicleGeometry[]): RoadPhysicalEnvelope {
  assert.ok(definitions.length > 0 && definitions.length <= 32 && new Set(definitions.map(definition => definition.id)).size === definitions.length, 'All usable vehicle definitions are required');
  let halfLength = 0, halfWidth = 0, tyreHalfWidth = 0;
  for (const definition of definitions) {
    assert.ok(definition.wheelRadius > 0 && definition.wheelWidth > 0 && definition.wheels.length >= 2);
    for (const box of [definition.collider, ...definition.collider.skid ? [definition.collider.skid] : []]) {
      assert.ok([...box.halfExtents, ...box.centre].every(Number.isFinite) && box.halfExtents.every(value => value > 0));
      halfWidth = Math.max(halfWidth, Math.abs(box.centre[0]) + box.halfExtents[0]); halfLength = Math.max(halfLength, Math.abs(box.centre[2]) + box.halfExtents[2]);
    }
    for (const wheel of definition.wheels) {assert.ok(wheel.position.every(Number.isFinite)); tyreHalfWidth = Math.max(tyreHalfWidth, Math.abs(wheel.position[0]) + definition.wheelWidth / 2); halfLength = Math.max(halfLength, Math.abs(wheel.position[2]) + definition.wheelRadius);}
  }
  assert.ok(halfLength <= 10 && halfWidth <= 4 && tyreHalfWidth <= 4);
  return {definitionIds: definitions.map(definition => definition.id), definitionsSha256: sourceSha256(JSON.stringify(definitions)), bodyHalfLength: halfLength + .1, bodyHalfWidth: Math.max(halfWidth, tyreHalfWidth) + .1, tyreOuterHalfWidth: tyreHalfWidth, clearanceMetres: .1, definitions};
}

/** Spatially indexed road faces. Bare-earth safety terrain is deliberately not a drivable deck witness. */
export class RoadCollisionSupport {
  private readonly triangles: RoadSupportTriangle[] = [];
  private readonly buckets = new Map<string, number[]>();
  constructor(triangles: readonly RoadSupportTriangle[], acceptsTag = (tag: string) => tag.startsWith('road:')) {
    for (const triangle of triangles) {
      assert.ok(triangle.points.length === 3 && triangle.points.every(point => point.length === 3 && point.every(Number.isFinite)));
      if (!acceptsTag(triangle.tag)) continue;
      const [a, b, c] = triangle.points;
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
      const normal = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
      if (normal[1]! / Math.hypot(...normal) < .65) continue;
      const id = this.triangles.push(triangle) - 1;
      const bounds = [Math.min(...triangle.points.map(p => p[0])), Math.min(...triangle.points.map(p => p[2])), Math.max(...triangle.points.map(p => p[0])), Math.max(...triangle.points.map(p => p[2]))];
      assert.ok((bounds[2]! - bounds[0]!) * (bounds[3]! - bounds[1]!) < 1_000_000, 'Unbounded road support face');
      for (let x = Math.floor(bounds[0]! / 16); x <= Math.floor(bounds[2]! / 16); x++) for (let z = Math.floor(bounds[1]! / 16); z <= Math.floor(bounds[3]! / 16); z++) {
        const key = `${x},${z}`, bucket = this.buckets.get(key) ?? []; bucket.push(id); this.buckets.set(key, bucket);
      }
    }
  }
  private hits(x: number, z: number) {
    const hits: {triangle: string; height: number}[] = [];
    for (const id of this.buckets.get(`${Math.floor(x / 16)},${Math.floor(z / 16)}`) ?? []) {
      const triangle = this.triangles[id]!, [a, b, c] = triangle.points;
      const den = (b[2] - c[2]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[2] - c[2]); if (Math.abs(den) < 1e-12) continue;
      const u = ((b[2] - c[2]) * (x - c[0]) + (c[0] - b[0]) * (z - c[2])) / den;
      const v = ((c[2] - a[2]) * (x - c[0]) + (a[0] - c[0]) * (z - c[2])) / den, w = 1 - u - v;
      if (Math.min(u, v, w) < -1e-7) continue;
      hits.push({triangle: triangle.id, height: u * a[1] + v * b[1] + w * c[1]});
    }
    return hits;
  }
  /** Reprojection may use only one unambiguous road level, never the nearest stacked road. */
  project(x: number, z: number) {
    const hits = this.hits(x, z); if (!hits.length) return null;
    const heights = hits.map(hit => hit.height);
    assert.ok(Math.max(...heights) - Math.min(...heights) <= .0001, `Ambiguous native road levels at ${x},${z}`);
    return {height: hits[0]!.height, triangles: hits.map(hit => hit.triangle)};
  }
  at(x: number, y: number, z: number) {
    let best: {triangle: string; height: number; deviation: number} | null = null;
    for (const hit of this.hits(x, z)) {const deviation = Math.abs(hit.height - y); if (deviation <= .2 && (!best || deviation < best.deviation)) best = {...hit, deviation};}
    return best;
  }
}

const recordHash = (record: unknown) => sourceSha256(JSON.stringify(record));
const inRegion = (point: Vec3, regions: readonly Rectangle[]) => regions.some(([x0, z0, x1, z1]) => point[0] >= x0 && point[0] <= x1 && point[2] >= z0 && point[2] <= z1);
function unique<T extends {id: string}>(records: readonly T[], label: string) {
  const result = new Map(records.map(record => [record.id, record])); assert.equal(result.size, records.length, `Duplicate ${label} ID`); return result;
}

export type RoadCoverage = Pick<GameplayBundle, 'playArea' | 'supportedArea'>;
function coverageEdges(coverage: RoadCoverage) {
  const b = coverage.playArea, rectangle = [[b.minX, b.minZ], [b.maxX, b.minZ], [b.maxX, b.maxZ], [b.minX, b.maxZ]];
  const rings: readonly (readonly (readonly number[])[])[] = [rectangle, ...coverage.supportedArea?.regions.flatMap(region => [region.outer, ...region.holes ?? []]) ?? []];
  return rings.flatMap(ring => ring.map((a, i) => [a, ring[(i + 1) % ring.length]!] as const));
}

/** Exact segment/boundary intersections find short newly exposed tails that a distance sampler can miss. */
export function inspectRetainedPathExposure(records: readonly {id: string; points: readonly Vec3[]}[], accepted: RoadCoverage, expanded: RoadCoverage) {
  const edges = [...coverageEdges(accepted), ...coverageEdges(expanded)], exposed = [];
  for (const lane of records) {
    const intervals: [number, number][] = []; let distance = 0;
    for (let i = 1; i < lane.points.length; i++) {
      const a = lane.points[i - 1]!, b = lane.points[i]!, dx = b[0] - a[0], dz = b[2] - a[2], length = Math.hypot(dx, dz); if (!length) continue;
      const knots = [0, 1];
      for (const [p, q] of edges) {
        const ex = q[0]! - p[0]!, ez = q[1]! - p[1]!, px = p[0]! - a[0], pz = p[1]! - a[2], denominator = dx * ez - dz * ex;
        if (Math.abs(denominator) > 1e-12) {const t = (px * ez - pz * ex) / denominator, u = (px * dz - pz * dx) / denominator; if (t > 0 && t < 1 && u >= 0 && u <= 1) knots.push(t);}
        else if (Math.abs(px * dz - pz * dx) < 1e-8) for (const point of [p, q]) {const t = ((point[0]! - a[0]) * dx + (point[1]! - a[2]) * dz) / (length * length); if (t > 0 && t < 1) knots.push(t);}
      }
      const sorted = [...new Set(knots)].sort((a, b) => a - b);
      for (let j = 1; j < sorted.length; j++) {
        const lo = sorted[j - 1]!, hi = sorted[j]!; if (hi - lo < 1e-10) continue;
        const t = (lo + hi) / 2, x = a[0] + dx * t, z = a[2] + dz * t;
        if (containsSupportedArea(expanded, x, z) && !containsSupportedArea(accepted, x, z)) {
          const from = distance + lo * length, to = distance + hi * length, previous = intervals.at(-1);
          if (previous && Math.abs(previous[1] - from) < 1e-8) previous[1] = to; else intervals.push([from, to]);
        }
      }
      distance += length;
    }
    if (intervals.length) exposed.push({id: lane.id, acceptedRecordSha256: recordHash(lane), intervals, newlyExposedMetres: intervals.reduce((sum, [a, b]) => sum + b - a, 0)});
  }
  return exposed;
}
export const inspectRetainedRoadExposure = (graph: RoadGraph, accepted: RoadCoverage, expanded: RoadCoverage) => inspectRetainedPathExposure(graph.lanes, accepted, expanded);
export const isPublicWalkingGroundTag = (tag: string) => /^(road|raised):(asphalt|slabs|setts|cobble|gravel)$/.test(tag);

/** Conservative certified intervals under the actual runtime guard. Boundary slivers remain explicitly closed. */
export function roadCoveragePose(points: readonly Vec3[], distance: number): VehicleCoveragePose {
  const {point, tangent} = pointAlong(points, distance), yaw = Math.atan2(tangent[0], tangent[1]);
  return {position: point.map(Math.fround) as Vec3, rotation: [0, Math.fround(Math.sin(yaw / 2)), 0, Math.fround(Math.cos(yaw / 2))], steerAngle: 0};
}
export function inspectRoadAdmission(points: readonly Vec3[], ranges: readonly (readonly [number, number])[], coverage: RoadCoverage, envelope: RoadPhysicalEnvelope) {
  const admitted: [number, number][] = [], closed: {interval: [number, number]; kind: string; point: Vec3; blockedDefinitions: string[]}[] = [];
  for (const [from, to] of ranges) for (let i = 0, steps = Math.max(1, Math.ceil((to - from) / .25)); i < steps; i++) {
    const lo = from + (to - from) * i / steps, hi = from + (to - from) * (i + 1) / steps, a = roadCoveragePose(points, lo), b = roadCoveragePose(points, hi);
    if (envelope.definitions.every(definition => supportsVehicleTransition(coverage, definition, a, b))) {
      const previous = admitted.at(-1); if (previous && Math.abs(previous[1] - lo) < 1e-8) previous[1] = hi; else admitted.push([lo, hi]);
    } else {
      const pose = roadCoveragePose(points, (lo + hi) / 2), point = [...pose.position] as Vec3, blockedDefinitions = envelope.definitions.filter(definition => !supportsVehiclePose(coverage, definition, pose.position, pose.rotation, pose.steerAngle)).map(definition => definition.id);
      const kind = blockedDefinitions.length ? 'runtime-footprint-closed' : 'boundary-transition-not-certified';
      const previous = closed.at(-1); if (previous && previous.kind === kind && JSON.stringify(previous.blockedDefinitions) === JSON.stringify(blockedDefinitions) && Math.abs(previous.interval[1] - lo) < 1e-8) previous.interval[1] = hi;
      else closed.push({interval: [lo, hi], kind, point, blockedDefinitions});
    }
  }
  return {guard: 'packages/sim/src/coverage-footprint.ts supportsVehiclePose/supportsVehicleTransition', definitionIds: envelope.definitionIds, definitionsSha256: envelope.definitionsSha256,
    admittedIntervals: admitted, closedIntervals: closed, stepMetres: .25, continuousProjectedFootprintSweeps: true, posePolicy: 'Float32 runtime position/quaternion, upright lane-tangent yaw, zero steering; actual steering/pitch/roll remains runtime travel verification'};
}

/** Qualify sampled full lane width plus the existing vehicle body's overhang against source and collision. */
function physicalProof(id: string, points: readonly Vec3[], width: number, partIds: readonly string[], parts: readonly LocalPolygon[], support: Pick<RoadCollisionSupport, 'at'>, coverage: RoadCoverage, envelope: RoadPhysicalEnvelope, intervals?: readonly (readonly [number, number])[], collectFailures = false, reviewedParkingPartIds: ReadonlySet<string> = new Set(), reviewedClippedParts: readonly LocalPolygon[] = [], reviewedBridgeParts: readonly LocalPolygon[] = [], reviewedSourceJoins: readonly ReviewedEhrenstromSourceJoin[] = [], reviewedPlazaParts:readonly LocalPolygon[] = [], reviewedFiniteCrossingParts:readonly LocalPolygon[] = []) {
  assert.ok(reviewedSourceJoins.length <= 1, 'Duplicate literal source-join authority');
  const sourceJoinWitnesses = reviewedSourceJoins.map(authority => assertReviewedEhrenstromSourceJoinRecord(authority, id, points, width));
  assert.ok(width > 0 && width <= 20 && partIds.length > 0 && new Set(partIds).size === partIds.length, `Invalid source corridor: ${id}`);
  assert.ok(reviewedClippedParts.every(part => partIds.includes(part.id)), 'Unused reviewed crossing component');
  assert.ok(reviewedBridgeParts.every(part=>partIds.includes(part.id)), 'Unused reviewed bridge component');
  assert.ok(reviewedPlazaParts.every(part=>partIds.includes(part.id)),'Unused reviewed plaza component');
  assert.ok(reviewedFiniteCrossingParts.every(part=>partIds.includes(part.id)),'Unused reviewed finite crossing component');
  const selected = partIds.flatMap(partId => {const part = parts.find(p => p.id === partId); assert.ok(part, `Missing carriageway part ${partId}`);
    const finiteCrossing=reviewedFiniteCrossingParts.filter(p=>p.id===partId);
    if(finiteCrossing.length){assert.equal(part.id,'59319');assert.equal(part.properties.paatyyppi,'Kevyt liikenne');assert.equal(part.properties.alatyyppi,'Jalankulkualue');for(const clipped of finiteCrossing)assert.deepEqual(clipped.properties,part.properties,'Finite crossing source subtype changed');return finiteCrossing;}
    const plaza=reviewedPlazaParts.filter(p=>p.id===partId);
    if(plaza.length){for(const clipped of plaza){assert.deepEqual(clipped.properties,part.properties,'Plaza source subtype changed');assert.equal((clipped as LocalPolygon&{sourceFeatureGeometrySha256:string}).sourceFeatureGeometrySha256,recordHash(part),'Plaza raw source geometry changed');}return plaza;}
    const bridge=reviewedBridgeParts.filter(p=>p.id===partId);
    if(bridge.length){assert.equal(part.properties.paatyyppi,'Silta');assert.equal(part.properties.alatyyppi,'Ajorata (Silta)');for(const clipped of bridge)assert.deepEqual(clipped.properties,part.properties,'Bridge source subtype changed');return bridge;}
    const clipped = reviewedClippedParts.filter(p => p.id === partId);
    if (clipped.length) {assert.ok(part.properties.paatyyppi === 'Ajorata' && part.properties.alatyyppi === 'Ajorata, muu'); for (const p of clipped) assert.deepEqual(p.properties, part.properties, 'Clipped source subtype changed'); return clipped;}
    assert.ok(String(part.properties.alatyyppi).normalize('NFC') === 'Ajorata' || reviewedParkingPartIds.has(partId) && part.properties.paatyyppi === 'Ajorata' && part.properties.alatyyppi === 'Pys\u00e4k\u00f6intialue', `Non-carriageway support part ${partId}`); return [part];});
  const length = polylineLength(points), ranges = intervals ?? [[0, length]];
  assert.ok(length > 0 && length < 5000 && ranges.every(([from, to]) => from >= 0 && to <= length + 1e-7 && to > from), `Invalid qualified path length: ${id}`);
  const halfWidth = width / 2, acrossCount = Math.ceil(halfWidth * 4) + 1;
  const across = Array.from({length: acrossCount}, (_, i) => -halfWidth + 2 * halfWidth * i / (acrossCount - 1));
  const witnesses = new Set<string>(); let samples = 0, maxHeightDeviation = 0, failureCount = 0;
  const failures: {message: string; point: Vec3; kind: string; stationMetres: number; alongMetres: number; lateralMetres: number}[] = [], failureCounts: Record<string, number> = {};
  const nominalFailures: typeof failures = [], nominalFailureCounts: Record<string, number> = {}; let nominalFailureCount = 0;
  let sample = {stationMetres: 0, alongMetres: 0, lateralMetres: 0};
  const check = (condition: unknown, message: string, point: Vec3, kind: string, nominal = false) => {
    if (condition) return;
    if (nominal) {nominalFailureCount++; nominalFailureCounts[kind] = (nominalFailureCounts[kind] ?? 0) + 1; if (nominalFailures.length < 16) nominalFailures.push({message, point, kind, ...sample}); return;}
    if (!collectFailures) assert.fail(message);
    failureCount++; failureCounts[kind] = (failureCounts[kind] ?? 0) + 1; if (failures.length < 16) failures.push({message, point, kind, ...sample});
  };
  for (const [from, to] of ranges) for (let i = 0, steps = Math.max(1, Math.ceil((to - from) / .25)); i <= steps; i++) {
    const s = from + (to - from) * i / steps, {point: centre, tangent} = pointAlong(points, s);
    const samplesXZ = across.map(offset => ({along: 0, lateral: offset, nominal: true}));
    sample = {stationMetres: s, alongMetres: 0, lateralMetres: 0};
    const seen = new Set<string>(), add = (x: number, z: number) => {
      const key = `${x.toFixed(7)},${z.toFixed(7)}`; if (seen.has(key)) return; seen.add(key);
      const dx = x - centre[0], dz = z - centre[2]; samplesXZ.push({along: dx * tangent[0] + dz * tangent[1], lateral: -dx * tangent[1] + dz * tangent[0], nominal: false});
    };
    const pose = roadCoveragePose(points, s);
    for (const definition of envelope.definitions) {
      check(supportsVehiclePose(coverage, definition, pose.position, pose.rotation, 0), `Path ${id} swept body crosses unsupported geography (${definition.id})`, centre, 'sweptSupportedArea');
      const hull = vehicleCoverageFootprint(definition, pose), clearance = VEHICLE_COVERAGE_CLEARANCE;
      for (let k = 0; k < hull.length; k++) {
        const a = hull[k]!, b = hull[(k + 1) % hull.length]!, dx = b[0] - a[0], dz = b[1] - a[1], edge = Math.hypot(dx, dz);
        for (let j = 0, count = Math.max(1, Math.ceil(edge / .25)); j <= count; j++) {
          const x = a[0] + dx * j / count, z = a[1] + dz * j / count;
          add(x, z); add(x + dz / edge * clearance, z - dx / edge * clearance);
        }
        for (let angle = 0; angle < 16; angle++) add(a[0] + Math.cos(angle * Math.PI / 8) * clearance, a[1] + Math.sin(angle * Math.PI / 8) * clearance);
      }
      const minX = Math.min(...hull.map(p => p[0])), maxX = Math.max(...hull.map(p => p[0])), minZ = Math.min(...hull.map(p => p[1])), maxZ = Math.max(...hull.map(p => p[1]));
      for (let x = minX; x <= maxX; x += .5) for (let z = minZ; z <= maxZ; z += .5) if (pointInPolygon([x, z], [hull])) add(x, z);
    }
    for (const {along, lateral, nominal} of samplesXZ) {
      const x = centre[0] + tangent[0] * along! - tangent[1] * lateral!, z = centre[2] + tangent[1] * along! + tangent[0] * lateral!;
      const projected = pointAlong(points, Math.max(0, Math.min(length, s + along!))).point;
      const point: Vec3 = [x, projected[1], z];
      sample = {stationMetres: s, alongMetres: along!, lateralMetres: lateral!};
      check(containsSupportedArea(coverage, x, z), `Path ${id} leaves supported geography at ${x},${z}`, point, 'supportedArea', nominal);
      check(selected.some(part => pointInPolygon([x, -z], part.rings)) || reviewedSourceJoins.some(authority => reviewedEhrenstromSourceJoinContains(authority, id, x, z)), `Path ${id} lacks full-width/body source support at ${x},${z}`, point, nominal ? 'laneWidthSource' : 'bodySource', nominal);
      const hit = support.at(x, projected[1], z); check(hit, `Path ${id} lacks road collision at ${x},${projected[1]},${z}`, point, nominal ? 'laneWidthCollision' : 'bodyCollision', nominal);
      samples++; if (hit) {maxHeightDeviation = Math.max(maxHeightDeviation, hit.deviation); witnesses.add(hit.triangle);}
    }
  }
  return {id, intervals: ranges, sourcePartIds: [...partIds], ...(sourceJoinWitnesses.length ? {sourceJoinWitnesses} : {}), ...(reviewedParkingPartIds.size ? {reviewedParkingPartIds: [...reviewedParkingPartIds]} : {}), samples, stepMetres: .25, laneWidthMetres: width, vehicleEnvelope: envelope, heightToleranceMetres: .2, maxHeightDeviation,
    collisionTriangles: [...witnesses].sort(), failureCount, failureCounts, failures, nominalFailureCount, nominalFailureCounts, nominalFailures, nominalLaneEdgeIsNotVehicleEnvelope: true,
    bodySampling: 'each usable definition: actual upright projected body/skid/tyres; 0.25 m boundary, 0.50 m interior, 16 clearance directions per hull corner; exact supported-area footprint gate', symmetricMaximumEnvelopeIsDiagnosticOnly: true};
}
export {physicalProof as inspectRoadPhysicalSupport};
/** Opaque source and floor roles are consumed independently. The exact exposure
 * is checked before narrower admitted samples; ordinary support remains first. */
export function inspectReviewedPlazaRoadPhysicalSupport(roles:PlazaRoadRoles,input:{lane:RoadLane;intervals:readonly(readonly[number,number])[];admittedIntervals:readonly(readonly[number,number])[];way:RoadSourceElement;partIds:readonly string[];parts:readonly LocalPolygon[];support:Pick<RoadCollisionSupport,'at'>;coverage:RoadCoverage;envelope:RoadPhysicalEnvelope}){
 const clipped=reviewedPlazaSourceParts(roles.sourceAuthority,input.lane,input.intervals,input.way),floor=reviewedPlazaFloorSupport(roles.floorAuthority,input.lane,input.intervals);
 // Bind the exact existing sampler arithmetic, including its final subdivision
 // endpoint, rather than introducing a separate rounding/tolerance policy.
 assert.deepEqual(input.admittedIntervals,inspectRoadAdmission(input.lane.points,input.intervals,input.coverage,input.envelope).admittedIntervals,'Plaza admission differs from exact approved-exposure replay');
 const additive={at:(x:number,y:number,z:number)=>input.support.at(x,y,z)??floor.at(x,y,z)};
 const result=physicalProof(input.lane.id,input.lane.points,input.lane.width,input.partIds,input.parts,additive,input.coverage,input.envelope,input.admittedIntervals,true,new Set(),[],[],[],clipped);
 floor.verifyInputs();return result;
}


/** Exact two-record finite crossing; no connector or private continuation role. */
export function inspectReviewedUdenmaankatuRoadPhysicalSupport(roles:UdenmaankatuRoadRoles,input:{lane:RoadLane;intervals:readonly(readonly[number,number])[];admittedIntervals:readonly(readonly[number,number])[];way:RoadSourceElement;partIds:readonly string[];parts:readonly LocalPolygon[];support:Pick<RoadCollisionSupport,'at'>;coverage:RoadCoverage;envelope:RoadPhysicalEnvelope}){
 const clipped=reviewedUdenmaankatuSourceParts(roles.sourceAuthority,input.lane,input.intervals,input.admittedIntervals,input.way),floor=reviewedUdenmaankatuFloorSupport(roles.floorAuthority,input.lane,input.intervals,input.admittedIntervals);
 assert.deepEqual(input.admittedIntervals,inspectRoadAdmission(input.lane.points,input.intervals,input.coverage,input.envelope).admittedIntervals,'Finite crossing admission changed');
 const additive={at:(x:number,y:number,z:number)=>input.support.at(x,y,z)??floor.at(x,y,z)};
 const result=physicalProof(input.lane.id,input.lane.points,input.lane.width,input.partIds,input.parts,additive,input.coverage,input.envelope,input.admittedIntervals,true,new Set(),[],[],[],[],clipped);floor.verifyInputs();return result;
}

export function mergeQualifiedRoads(options: {accepted: RoadGraph; candidate: RoadGraph; acceptedCoverage: RoadCoverage; expandedCoverage: RoadCoverage; vehicleEnvelope: RoadPhysicalEnvelope; osm: {elements: RoadSourceElement[]}; originProjected: Vec3; parts: readonly LocalPolygon[]; support: RoadCollisionSupport; walkingSupport?: RoadCollisionSupport; selection: RoadMergeSelection; reviewedSurfaces?: ReadonlyMap<string, ReviewedRecordSurface>; reviewedRoadSupports?: ReadonlyMap<string, Pick<RoadCollisionSupport, 'at'>>; reviewedFootways?: ReadonlyMap<string, QualifiedFootwayAuthority>; reviewedRetainedCrossings?:ReadonlyMap<string,ReviewedRetainedWalkingCrossing>; reviewedInheritedWalkingSources?:ReadonlyMap<string,InheritedWalkingSourceAuthority>; reviewedSourceJoins?: ReadonlyMap<string, readonly ReviewedEhrenstromSourceJoin[]>;reviewedPlaza?:ReadonlyMap<string,PlazaRoadRoles>;reviewedUdenmaankatu?:ReadonlyMap<string,UdenmaankatuRoadRoles>;currentCarry?:{authority:CurrentNavigationCarry;original:RoadGraph;current:RoadGraph}}) {
  const {candidate, osm, originProjected, parts, support} = options;
  const carry=options.currentCarry,originalAccepted=options.accepted;
  for(const refs of[options.selection.lanes,options.selection.connectors,options.selection.footways??[]]){assert.ok(refs.length<=10000);assert.equal(new Set(refs.map(r=>r.id)).size,refs.length,'Duplicate selected record, including actual-current carry');}
  const accepted=carry?carryCurrentNavigation(carry.authority,carry.original,originalAccepted):originalAccepted;
  if(carry)assertCurrentNavigationCarry(carry.authority,carry.original,carry.current,candidate);
  const carriedIds=(kind:'lanes'|'connectors'|'footways')=>new Set(carry?currentCarryIds(carry.authority,kind):[]),carriedLanes=carriedIds('lanes'),carriedConnectors=carriedIds('connectors'),carriedFootwayIds=carriedIds('footways');
  const carriedFootways=(options.selection.footways??[]).filter(r=>carriedFootwayIds.has(r.id));
  const selection:RoadMergeSelection={...options.selection,lanes:options.selection.lanes.filter(r=>!carriedLanes.has(r.id)),connectors:options.selection.connectors.filter(r=>!carriedConnectors.has(r.id)),...(options.selection.footways?{footways:options.selection.footways.filter(r=>!carriedFootwayIds.has(r.id))}:{})};
  assert.equal(selection.schemaVersion, 1); assert.equal(accepted.schemaVersion, 2); assert.equal(candidate.schemaVersion, 2); assert.equal(candidate.originId, accepted.originId);
  assert.deepEqual(validateRoadGraph(accepted), []); assert.deepEqual(validateRoadGraph(candidate), []);
  assert.ok(selection.regions.length > 0 && selection.regions.every(r => r.length === 4 && r.every(Number.isFinite) && r[0] < r[2] && r[1] < r[3]));
  const groups = ['nodes', 'lanes', 'connectors', 'parking', 'footways'] as const, conflicts: RoadRecordConflict[] = [];
  for (const kind of groups) {
    const prior = unique<{id: string}>(accepted[kind], `accepted ${kind}`); unique<{id: string}>(candidate[kind], `candidate ${kind}`);
    for (const fresh of candidate[kind]) {
      const old = prior.get(fresh.id); if (!old || isDeepStrictEqual(old, fresh)) continue;
      const witness = selection.retainedConflicts.find(c => c.kind === kind && c.id === fresh.id);
      assert.ok(witness && witness.reason.trim().length > 0 && witness.acceptedSha256 === recordHash(old) && witness.candidateSha256 === recordHash(fresh), `Unexplained accepted ${kind} conflict: ${fresh.id}`);
      conflicts.push(witness);
    }
  }
  assert.equal(conflicts.length, selection.retainedConflicts.length, 'Unused/duplicate conflict witness');
  const oldLanes = unique(accepted.lanes, 'accepted lane'), oldNodes = unique(accepted.nodes, 'accepted node'), newLaneMap = unique(candidate.lanes, 'candidate lane');
  assert.ok(selection.lanes.length <= 10000 && (selection.lanes.length > 0 || selection.seamConnectors.some(ref => ref.retainedBoundary)), 'An extension needs new lanes or an explicitly qualified retained boundary'); unique(selection.lanes, 'selected lane'); unique(selection.connectors, 'selected connector');
  const newLanes = selection.lanes.map(ref => {const lane = newLaneMap.get(ref.id); assert.ok(lane && !oldLanes.has(lane.id), `New lane is missing or replaces accepted ID: ${ref.id}`); return lane;});
  for (const [id, authorities] of options.reviewedSourceJoins ?? []) {const lane = newLanes.find(lane => lane.id === id); assert.ok(lane && authorities.length === 1, 'Source-join authority belongs only to its selected new lane'); for (const authority of authorities) assertReviewedEhrenstromSourceJoinRecord(authority, id, lane.points, lane.width);}
  for (const id of options.reviewedSurfaces?.keys() ?? []) assert.ok(newLanes.some(lane => lane.id === id) || selection.connectors.some(ref => ref.id === id), 'Reviewed crossing eligibility belongs only to its selected new record');
  const lanes = [...accepted.lanes, ...newLanes], laneById = unique(lanes, 'merged lane');
  const elements = new Map(osm.elements.map(element => [`${element.type}/${element.id}`, element])); assert.equal(elements.size, osm.elements.length, 'Duplicate OSM source identity');
  const ways = new Map(osm.elements.filter(e => e.type === 'way').map(e => [e.id, e]));
  const surfaceEligibilityWitnesses: {recordId: string; parts: ReturnType<typeof qualifyPublicParkingAisleParts>}[] = [];
  const reviewedParkingParts = (ref: {partIds: string[]; surfaceReviews?: PublicParkingAisleReview[]}, recordId: string, wayIds: number[]) => {
    const reviews = ref.surfaceReviews ?? [];
    assert.ok(reviews.every(review => ref.partIds.includes(review.partId)), 'Unused parking surface review');
    const qualified = qualifyPublicParkingAisleParts(reviews, parts, ways, wayIds);
    if (qualified.length) surfaceEligibilityWitnesses.push({recordId, parts: qualified});
    return new Set(qualified.map(part => part.partId));
  };
  const nodeById = unique(candidate.nodes, 'candidate node'), addedNodes = new Map<string, RoadGraph['nodes'][number]>();
  for (const lane of newLanes) for (const id of [lane.from, lane.to]) if (!oldNodes.has(id)) {const node = nodeById.get(id); assert.ok(node, `New lane missing source node ${id}`); addedNodes.set(id, node);}
  const nodes = [...accepted.nodes, ...addedNodes.values()], allNodes = unique(nodes, 'merged node');
  function way(lane: RoadLane) {
    const value = ways.get(lane.wayId); assert.ok(value?.nodes && value.tags, `Missing full OSM way ${lane.wayId}`);
    const access = value.tags.motor_vehicle ?? value.tags.vehicle ?? value.tags.access;
    assert.ok(access === undefined || ['yes', 'permissive', 'designated'].includes(access), `Non-public vehicle access on way ${lane.wayId}`);
    assert.ok(!value.tags.tunnel || value.tags.tunnel === 'no'); assert.ok(!value.tags.indoor || value.tags.indoor === 'no');
    assert.ok(value.tags.highway === lane.highway && value.tags.area !== 'yes', `Source highway mismatch on ${lane.id}`);
    const level = Number(value.tags.layer ?? 0); assert.ok(Number.isInteger(level) && level >= 0, `Unsupported road level ${lane.id}`);
    if (value.tags.bridge && value.tags.bridge !== 'no') {
      const structure = selection.structures.find(s => s.wayId === lane.wayId && s.kind === 'bridge');
      assert.ok(structure && structure.reason.trim().length > 0 && structure.partIds.length > 0 && (oldLanes.has(lane.id) || options.reviewedRoadSupports?.has(lane.id)), `Unqualified bridge ${lane.wayId}`);
      const qualification = selection.lanes.find(ref => ref.id === lane.id);
      if (qualification) assert.ok(structure.partIds.every(id => qualification.partIds.includes(id)), 'Bridge deck source parts missing');
    }
    return {...value, nodes: value.nodes, tags: value.tags, level};
  }
  const physical: ReturnType<typeof physicalProof>[] = [], wayWitnesses: unknown[] = [], pathAdmission: {id: string; admission: ReturnType<typeof inspectRoadAdmission>}[] = [], junctionAdmission: {id: string; definitionIds: string[]; endpointRotationSweeps: true}[] = [];
  const requirePathAdmission = (id: string, points: readonly Vec3[]) => {
    const admission = inspectRoadAdmission(points, [[0, polylineLength(points)]], options.expandedCoverage, options.vehicleEnvelope);
    pathAdmission.push({id, admission});
    if (admission.closedIntervals.length) throw Object.assign(new Error(`Selected path ${id} has runtime footprint closures`), {pathAdmission, retainedAudit});
  };
  const supportedPath = (id: string, points: readonly Vec3[]) => {
    for (let i = 1; i < points.length; i++) assert.ok(supportsSegment(options.expandedCoverage, [points[i - 1]![0], points[i - 1]![2]], [points[i]![0], points[i]![2]]), `Path ${id} crosses unsupported geography`);
  };
  const retainedExposure = inspectRetainedRoadExposure(originalAccepted, options.acceptedCoverage, options.expandedCoverage), retainedQualifications = unique(selection.retainedLanes ?? [], 'retained lane qualification');
  assert.deepEqual([...retainedQualifications.keys()].sort(), retainedExposure.map(tail => tail.id).sort(), 'Every newly exposed retained lane needs an explicit source-bound tail disposition');
  for(const id of options.reviewedPlaza?.keys()??[])assert.ok(retainedQualifications.has(id),'Plaza role belongs only to an explicitly qualified retained lane');
  for(const id of options.reviewedUdenmaankatu?.keys()??[]){assert.ok(retainedQualifications.has(id),'Finite crossing role belongs only to its selected retained lane');assert.ok(!options.reviewedPlaza?.has(id),'Overlapping retained source roles');}
  const retainedAudit: {id: string; error?: string; physical?: ReturnType<typeof physicalProof>; admission: ReturnType<typeof inspectRoadAdmission>}[] = [];
  for (const tail of retainedExposure) {
    const lane = oldLanes.get(tail.id)!, qualification = retainedQualifications.get(tail.id)!;
    assert.ok(!qualification.surfaceReviews?.length, 'New parking authoring reviews cannot change accepted tail qualification');
    const admission = inspectRoadAdmission(lane.points, tail.intervals, options.expandedCoverage, options.vehicleEnvelope);
    try {const source=way(lane),plaza=options.reviewedPlaza?.get(lane.id),finiteCrossing=options.reviewedUdenmaankatu?.get(lane.id);
      const proof=finiteCrossing?inspectReviewedUdenmaankatuRoadPhysicalSupport(finiteCrossing,{lane,intervals:tail.intervals,admittedIntervals:admission.admittedIntervals,way:ways.get(source.id)!,partIds:qualification.partIds,parts,support,coverage:options.expandedCoverage,envelope:options.vehicleEnvelope}):plaza?inspectReviewedPlazaRoadPhysicalSupport(plaza,{lane,intervals:tail.intervals,admittedIntervals:admission.admittedIntervals,way:ways.get(source.id)!,partIds:qualification.partIds,parts,support,coverage:options.expandedCoverage,envelope:options.vehicleEnvelope}):physicalProof(lane.id, lane.points, lane.width, qualification.partIds, parts, support, options.expandedCoverage, options.vehicleEnvelope, admission.admittedIntervals, true);
      physical.push(proof);retainedAudit.push({id:lane.id,physical:proof,admission});} 
    catch (error) {retainedAudit.push({id: lane.id, error: (error as Error).message, admission});}
  }
  const failedTails = retainedAudit.filter(result => result.error || result.physical?.failureCount);
  if (failedTails.length) throw Object.assign(new Error(`${failedTails.length} retained lanes have unqualified newly exposed tails; require a source-bound outside-old-playArea repair disposition, without changing the accepted playable prefix`), {retainedAudit});
  for (const lane of newLanes) {
    const source = way(lane); assert.ok(lane.points.every(p => inRegion(p, selection.regions)), `Lane ${lane.id} leaves declared region`);
    supportedPath(lane.id, lane.points);
    assert.match(lane.id, new RegExp(`^${lane.wayId}:\\d+:[fb]${lane.index}$`), 'New lane identity is not native source-stable');
    const from = /^n(\d+)$/.exec(lane.from), to = /^n(\d+)$/.exec(lane.to); assert.ok(from && to, 'Lane endpoints must retain OSM node identities');
    const fromIndex = source.nodes.indexOf(Number(from[1])), toIndex = source.nodes.indexOf(Number(to[1]));
    assert.ok(fromIndex >= 0 && toIndex >= 0 && fromIndex !== toIndex, `Lane ${lane.id} endpoints are not on its source way`);
    for (const prior of accepted.lanes.filter(prior => prior.wayId === lane.wayId && prior.index === lane.index)) {
      const a = source.nodes.indexOf(Number(prior.from.slice(1))), b = source.nodes.indexOf(Number(prior.to.slice(1)));
      assert.ok(a >= 0 && b >= 0, `Changed source segmentation requires an explicit retained interval disposition: ${lane.id}`);
      if (Math.sign(b - a) !== Math.sign(toIndex - fromIndex)) continue;
      assert.ok(Math.max(Math.min(a, b), Math.min(fromIndex, toIndex)) >= Math.min(Math.max(a, b), Math.max(fromIndex, toIndex)), `New lane duplicates an accepted source interval: ${lane.id}`);
    }
    const oneWay = source.tags.oneway ?? (source.tags.junction === 'roundabout' ? 'yes' : 'no');
    assert.ok(['yes', '1', '-1', 'no', '0', 'false'].includes(oneWay), 'Unqualified one-way interpretation');
    if (oneWay === 'yes' || oneWay === '1') assert.ok(fromIndex < toIndex, `Lane ${lane.id} reverses source one-way`);
    if (oneWay === '-1') assert.ok(fromIndex > toIndex, `Lane ${lane.id} reverses source one-way`);
    for (const id of [lane.from, lane.to]) {
      const sourceNode = elements.get('node/' + id.slice(1)); assert.ok(sourceNode && Number.isFinite(sourceNode.lat) && Number.isFinite(sourceNode.lon));
      const [e, n] = geodeticToGk25(sourceNode.lat!, sourceNode.lon!), node = allNodes.get(id)!;
      assert.ok(Math.hypot(node.position[0] - (e - originProjected[0]), node.position[2] + n - originProjected[1]) <= .02, `Node ${id} needs explicit source registration, not an inferred join`);
    }
    const ref = selection.lanes.find(ref => ref.id === lane.id)!;
    physical.push(physicalProof(lane.id, lane.points, lane.width, ref.partIds, parts, options.reviewedRoadSupports?.get(lane.id) ?? support, options.expandedCoverage, options.vehicleEnvelope, undefined, false, reviewedParkingParts(ref, lane.id, [lane.wayId]), options.reviewedSurfaces?.get(lane.id)?.parts, options.reviewedSurfaces?.get(lane.id)?.bridgeParts, options.reviewedSourceJoins?.get(lane.id)));
    requirePathAdmission(lane.id, lane.points);
    wayWitnesses.push({lane: lane.id, wayId: lane.wayId, sourceWaySha256: recordHash(ways.get(lane.wayId)), fromNode: Number(from[1]), toNode: Number(to[1]), layer: source.level, access: source.tags.motor_vehicle ?? source.tags.vehicle ?? source.tags.access ?? 'public-default', oneway: oneWay});
  }
  const candidateConnectors = unique(candidate.connectors, 'candidate connector'), oldConnectorIds = new Set(accepted.connectors.map(c => c.id));
  const additions: {connector: RoadConnector; partIds: string[]; seam: boolean; osmNodeId: number; retainedBoundary?: true; surfaceReviews?: PublicParkingAisleReview[]}[] = selection.connectors.map(ref => {const connector = candidateConnectors.get(ref.id); assert.ok(connector && !oldConnectorIds.has(ref.id)); return {connector, partIds: ref.partIds, ...(ref.surfaceReviews ? {surfaceReviews: ref.surfaceReviews} : {}), seam: false, osmNodeId: Number(connector.node.slice(1))};});
  additions.push(...selection.seamConnectors.map(ref => ({...ref, seam: true})));
  unique(additions.map(ref => ref.connector), 'new connector'); const boundaryWitnesses = [];
  for (const ref of additions) {
    const connector = ref.connector, from = laneById.get(connector.from), to = laneById.get(connector.to);
    assert.ok(from && to, `New connector has unselected lane references: ${connector.id}`);
    const retainedOnly = oldLanes.has(from.id) && oldLanes.has(to.id);
    assert.ok(!retainedOnly || ref.retainedBoundary && oldNodes.get(connector.node)?.kind === 'boundary', 'A retained-only connection must reopen an explicitly qualified accepted boundary');
    assert.ok(!ref.retainedBoundary || retainedOnly, 'Retained-boundary witness does not match its lane identities');
    assert.ok(!oldConnectorIds.has(connector.id)); assert.equal(connector.id, `${connector.from}>${connector.to}`, 'Connector identity is not source-stable');
    assert.equal(connector.node, `n${ref.osmNodeId}`); assert.equal(from.to, connector.node); assert.equal(to.from, connector.node);
    assert.deepEqual(connector.points[0], from.points.at(-1), 'Connector does not start at the exact retained lane endpoint');
    assert.deepEqual(connector.points.at(-1), to.points[0], 'Connector does not end at the exact retained lane endpoint');
    assert.ok(connector.points.every(point => inRegion(point, selection.regions)), 'Connector leaves declared region');
    supportedPath(connector.id, connector.points);
    const sourceJunction = allNodes.get(connector.node); assert.ok(sourceJunction);
    assert.ok(connector.points.every(point => Math.hypot(point[0] - sourceJunction.position[0], point[2] - sourceJunction.position[2]) <= 40), 'Connector leaves its source junction');
    const a = way(from), b = way(to); assert.ok(a.nodes.includes(ref.osmNodeId) && b.nodes.includes(ref.osmNodeId), 'Crossing lacks shared OSM node membership');
    if (a.level !== b.level) assert.ok(selection.levelTransitions.some(t => t.nodeId === ref.osmNodeId && t.fromWayId === a.id && t.toWayId === b.id && t.reason.trim().length > 0), 'Unqualified stacked-road level transition');
    for (const restriction of osm.elements.filter(e => e.type === 'relation' && e.tags?.type === 'restriction' && e.members?.some(m => m.role === 'from' && m.type === 'way' && m.ref === from.wayId))) {
      const via = restriction.members!.filter(m => m.role === 'via');
      assert.ok(via.length === 1 && via[0]!.type === 'node', `Via-way restriction requires explicit resolution: ${restriction.id}`);
      if (via[0]!.ref !== ref.osmNodeId) continue;
      const target = restriction.members!.find(m => m.role === 'to' && m.type === 'way'), rule = restriction.tags!.restriction ?? restriction.tags!['restriction:motorcar'];
      assert.ok(target && rule && !restriction.tags!['restriction:conditional'], `Unqualified turn restriction ${restriction.id}`);
      assert.ok(rule.startsWith('only_') ? target.ref === to.wayId : rule.startsWith('no_') && target.ref !== to.wayId, `Connector violates OSM turn restriction ${restriction.id}`);
    }
    const crossesAccepted = oldLanes.has(from.id) || oldLanes.has(to.id); assert.equal(ref.seam, crossesAccepted, 'Accepted boundary connector requires explicit seam qualification');
    physical.push(physicalProof(connector.id, connector.points, Math.max(from.width, to.width), ref.partIds, parts, options.reviewedRoadSupports?.get(connector.id) ?? support, options.expandedCoverage, options.vehicleEnvelope, undefined, false, reviewedParkingParts(ref, connector.id, [from.wayId, to.wayId]), options.reviewedSurfaces?.get(connector.id)?.parts, options.reviewedSurfaces?.get(connector.id)?.bridgeParts));
    requirePathAdmission(connector.id, connector.points);
    for (const definition of options.vehicleEnvelope.definitions) {
      assert.ok(supportsVehicleTransition(options.expandedCoverage, definition, roadCoveragePose(from.points, polylineLength(from.points)), roadCoveragePose(connector.points, 0)), `Connector ${connector.id} entrance rotation is outside the supported vehicle corridor (${definition.id})`);
      assert.ok(supportsVehicleTransition(options.expandedCoverage, definition, roadCoveragePose(connector.points, polylineLength(connector.points)), roadCoveragePose(to.points, 0)), `Connector ${connector.id} exit rotation is outside the supported vehicle corridor (${definition.id})`);
    }
    junctionAdmission.push({id: connector.id, definitionIds: options.vehicleEnvelope.definitionIds, endpointRotationSweeps: true});
    if (crossesAccepted) boundaryWitnesses.push({id: connector.id, kind: retainedOnly ? 'retained-boundary' : 'new-lane-boundary', nodeId: ref.osmNodeId, fromWayId: from.wayId, toWayId: to.wayId, fromLayer: a.level, toLayer: b.level, partIds: ref.partIds,
      acceptedLaneSha256: recordHash(oldLanes.has(from.id) ? from : to), connectorSha256: recordHash(connector)});
  }
  assert.ok(boundaryWitnesses.length > 0, 'No qualified accepted/new boundary connection');
  let walking: ReturnType<typeof mergeQualifiedFootways> | undefined;
  if (selection.walkingRoutes) {
    assert.ok(options.walkingSupport, 'Walking route qualification requires serialized native road/pavement support');
    walking = mergeQualifiedFootways({accepted, candidate, acceptedCoverage: options.acceptedCoverage, coverage: options.expandedCoverage, origin: originProjected, osm, parts, support: options.walkingSupport,
      newFootways: selection.footways ?? [], retainedFootways: selection.retainedFootways ?? [],carriedFootways, exposure: inspectRetainedPathExposure(originalAccepted.footways, options.acceptedCoverage, options.expandedCoverage), routes: selection.walkingRoutes, reviewedFootways: options.reviewedFootways, reviewedRetainedCrossings:options.reviewedRetainedCrossings, reviewedInheritedWalkingSources:options.reviewedInheritedWalkingSources});
  } else assert.ok(!selection.footways?.length && !selection.retainedFootways?.length, 'Footway additions require explicit connected walking routes');
  const graph: RoadGraph = {...accepted, nodes, lanes, connectors: [...accepted.connectors, ...additions.map(ref => ref.connector)], ...(walking ? {footways: walking.footways} : {})};
  assert.deepEqual(validateRoadGraph(graph), []); unique(graph.connectors, 'merged connector');
  assert.ok(selection.acceptedAnchorLaneIds.length > 0 && selection.acceptedAnchorLaneIds.every(id => oldLanes.has(id)), 'Accepted traversal anchors required');
  const reachable = (reverse: boolean) => {
    const adjacent = new Map<string, string[]>(); for (const connector of graph.connectors) {const from = reverse ? connector.to : connector.from, to = reverse ? connector.from : connector.to; const neighbours = adjacent.get(from) ?? []; neighbours.push(to); adjacent.set(from, neighbours);}
    const seen = new Set<string>(), stack = [...selection.acceptedAnchorLaneIds]; while (stack.length) {const next = stack.pop()!; if (seen.has(next)) continue; seen.add(next); stack.push(...adjacent.get(next) ?? []);} return seen;
  };
  const outward = reachable(false), returning = reachable(true); for (const lane of newLanes) assert.ok(outward.has(lane.id) && returning.has(lane.id), `New lane ${lane.id} lacks directed out-and-back connection to accepted anchors`);
  for (const {connector} of additions) assert.ok(outward.has(connector.from) && returning.has(connector.to), `Connector ${connector.id} lacks directed out-and-back connection to accepted anchors`);
  for (const kind of groups) assert.deepEqual(graph[kind].slice(0, accepted[kind].length), accepted[kind], `Accepted ${kind} record changed`);
  if(carry)assertCurrentNavigationCarry(carry.authority,carry.original,carry.current,graph);
  return {graph, receipt: {schemaVersion: 1, status: 'PASS_SOURCE_QUALIFIED_ROAD_MERGE_PENDING_RUNTIME', acceptedRecordsPreserved: true,
    acceptedSourceRetained: accepted.source, candidateSource: candidate.source, retainedExposure, retainedAudit, selectedLaneIds: newLanes.map(l => l.id), selectedConnectorIds: additions.map(ref => ref.connector.id),
    acceptedAnchorLaneIds: selection.acceptedAnchorLaneIds, boundaryWitnesses, wayWitnesses, retainedConflicts: conflicts, physical, pathAdmission, junctionAdmission, walking: walking?.receipt ?? {status: 'NOT_QUALIFIED'},
    ...(surfaceEligibilityWitnesses.length ? {surfaceEligibilityWitnesses} : {}), ...(options.reviewedSurfaces?.size ? {reviewedClippedSurfaces: [...options.reviewedSurfaces].map(([id, value]) => ({id, sourceWitnesses: value.sourceWitnesses}))} : {}), sampledSupportOnly: true, runtimeTravelRequired: true, retainedBoundaryClosures: retainedAudit.filter(audit => audit.admission.closedIntervals.length).map(audit => ({id: audit.id, ...audit.admission})), directedReturnToAcceptedAnchors: true}};
}
