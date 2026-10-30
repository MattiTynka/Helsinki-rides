import assert from 'node:assert/strict';
import {containsSupportedArea, supportsSegment, pointAlong, polylineLength, geodeticToGk25, type RoadGraph, type Vec3} from '../../../packages/world-schema/src/index.ts';
import {pointInPolygon, type LocalPolygon} from './geometry.ts';
import {sourceSha256} from './source-files.ts';
import type {RoadCollisionSupport, RoadCoverage, RoadSourceElement, RoadQualification} from './expansion-road-merge.ts';
import {assertReviewedRetainedWalkingCrossing, type ReviewedRetainedWalkingCrossing} from './reviewed-retained-walking-crossing.ts';
import {qualifyReviewedInheritedWalkingDrainSources}from './reviewed-inherited-walking-drains.ts';
import type {InheritedWalkingSourceAuthority}from './inherited-road-bundle-context.ts';
import {reviewedBridgeWalkingParts, reviewedBridgeWalkingGapContains, type ReviewedBridgeWalkingSource} from './bridge-walking-source.ts';

export interface WalkingRouteSelection {id: string; steps: {wayId: number; fromNode: number; toNode: number}[]}
interface Exposure {id: string; intervals: [number, number][]}
/** Constructed only after source/registration and literal final-floor review. */
export interface QualifiedFootwayAuthority {
  sourceWaySha256: string;
  sourcePoints?: readonly Vec3[];
  sourceNodePoints?: ReadonlyMap<number, Vec3>;
  bridge?: {wayId: number; layer: number};
  municipalBridgeSource?: ReviewedBridgeWalkingSource;
  support: Pick<RoadCollisionSupport, 'at'>;
  receipt: unknown;
}
const RADIUS = .38; // Native CHARACTER.radius .32 plus pedestrian proposal clearance .06; also contains player .34 guard.
const worldPoint = (node: RoadSourceElement, origin: Vec3): Vec3 => {assert.ok(Number.isFinite(node.lat) && Number.isFinite(node.lon)); const [e, n] = geodeticToGk25(node.lat!, node.lon!); return [e - origin[0], 0, origin[1] - n];};
function nearestStation(points: readonly Vec3[], point: Vec3) {
  let distance = Infinity, station = 0, walked = 0;
  for (let i = 1; i < points.length; i++) {const a = points[i - 1]!, b = points[i]!, dx = b[0] - a[0], dz = b[2] - a[2], squared = dx * dx + dz * dz, length = Math.sqrt(squared); if (!length) continue;
    const t = Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[2] - a[2]) * dz) / squared)), gap = Math.hypot(point[0] - a[0] - dx * t, point[2] - a[2] - dz * t);
    if (gap < distance) {distance = gap; station = walked + length * t;} walked += length;
  }
  return {distance, station};
}
function slice(points: readonly Vec3[], from: number, to: number) {
  let walked = 0; const a = Math.min(from, to), b = Math.max(from, to), result = [pointAlong(points, a).point];
  for (let i = 1; i < points.length; i++) {walked += Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![2] - points[i - 1]![2]); if (walked > a + 1e-8 && walked < b - 1e-8) result.push([...points[i]!]);}
  result.push(pointAlong(points, b).point); if (to < from) result.reverse(); return result;
}
export function inspectFootwayAdmission(points: readonly Vec3[], ranges: readonly (readonly [number, number])[], coverage: RoadCoverage) {
  const admitted: [number, number][] = [], closed: [number, number][] = [];
  for (const [from, to] of ranges) for (let i = 0, n = Math.max(1, Math.ceil((to - from) / .25)); i < n; i++) {
    const lo = from + (to - from) * i / n, hi = from + (to - from) * (i + 1) / n, a = pointAlong(points, lo).point, b = pointAlong(points, hi).point;
    const target = supportsSegment(coverage, [Math.fround(a[0]), Math.fround(a[2])], [Math.fround(b[0]), Math.fround(b[2])], RADIUS) ? admitted : closed, previous = target.at(-1);
    if (previous && Math.abs(previous[1] - lo) < 1e-8) previous[1] = hi; else target.push([lo, hi]);
  }
  return {radiusMetres: RADIUS, stepMetres: .25, guard: 'Float32 projected capsule supportsSegment', admittedIntervals: admitted, closedIntervals: closed};
}

export function mergeQualifiedFootways(options: {accepted: RoadGraph; candidate: RoadGraph; coverage: RoadCoverage; acceptedCoverage: RoadCoverage; origin: Vec3; osm: {elements: RoadSourceElement[]}; parts: readonly LocalPolygon[]; support: RoadCollisionSupport;
  newFootways: readonly RoadQualification[]; retainedFootways: readonly RoadQualification[]; carriedFootways?:readonly RoadQualification[];exposure: readonly Exposure[]; routes: readonly WalkingRouteSelection[]; reviewedFootways?: ReadonlyMap<string, QualifiedFootwayAuthority>; reviewedRetainedCrossings?:ReadonlyMap<string,ReviewedRetainedWalkingCrossing>; reviewedInheritedWalkingSources?:ReadonlyMap<string,InheritedWalkingSourceAuthority>}) {
  const carried=options.carriedFootways??[],old = new Map(options.accepted.footways.map(record => [record.id, record])), fresh = new Map(options.candidate.footways.map(record => [record.id, record])), selected = new Map([...options.newFootways, ...options.retainedFootways,...carried].map(ref => [ref.id, ref]));
  assert.equal(selected.size, options.newFootways.length + options.retainedFootways.length+carried.length, 'Duplicate walking qualification');
  assert.ok(carried.every(r=>old.has(r.id)&&!options.exposure.some(e=>e.id===r.id)),'Carried walking route must already be preserved, with access independently unchanged');
  assert.deepEqual(options.retainedFootways.map(ref => ref.id).sort(), options.exposure.map(ref => ref.id).sort(), 'Every newly exposed retained footway needs an explicit disposition');
  const nodes = new Map(options.osm.elements.filter(e => e.type === 'node').map(e => [e.id, e])), ways = new Map(options.osm.elements.filter(e => e.type === 'way').map(e => [e.id, e]));
  const additions = options.newFootways.map(ref => {const record = fresh.get(ref.id); assert.ok(record && !old.has(ref.id), 'New footway replaces accepted identity'); return record;});
  const records = new Map([...options.accepted.footways, ...additions].map(record => [record.id, record]));
  for (const id of options.reviewedFootways?.keys() ?? []) assert.ok(!old.has(id) && selected.has(id), 'Reviewed walking exceptions require an explicitly selected new record');
  for(const id of options.reviewedRetainedCrossings?.keys()??[])assert.ok(old.has(id)&&options.retainedFootways.some(r=>r.id===id),'Reviewed crossing requires an explicitly selected retained record');
  for(const id of options.reviewedInheritedWalkingSources?.keys()??[])assert.ok(old.has(id)&&selected.has(id),'Inherited walking source requires a selected retained record');
  function source(id: string, retainedCrossing=false) {
    assert.match(id, /^w\d+$/); const way = ways.get(Number(id.slice(1))); assert.ok(way?.nodes && way.tags, `Missing current full walking source ${id}`); const tags = way.tags, access = tags.foot ?? tags.access;
    assert.ok(access === undefined || ['yes', 'designated', 'permissive'].includes(access), `Non-public walking access ${id}`);
    assert.ok(['footway', 'pedestrian', 'path', 'living_street', 'cycleway'].includes(tags.highway!) && (tags.highway !== 'cycleway' || ['yes', 'designated', 'permissive'].includes(tags.foot!) || retainedCrossing), `Source is not a public footway ${id}`);
    const reviewed = options.reviewedFootways?.get(id); if (reviewed) assert.equal(reviewed.sourceWaySha256, sourceSha256(JSON.stringify(way)), 'Reviewed walking source identity changed');
    assert.ok(!tags.tunnel || tags.tunnel === 'no');
    if ((tags.bridge && tags.bridge !== 'no') || Number(tags.layer ?? 0) !== 0) assert.ok(reviewed?.bridge?.wayId === way.id && reviewed.bridge.layer === Number(tags.layer ?? 0) && tags.bridge && tags.bridge !== 'no', `Unqualified walking structure ${id}`);
    const points = way.nodes.map(id => {const node = nodes.get(id); assert.ok(node); return worldPoint(node, options.origin);});
    const nodePoints = way.nodes.map((node, i) => reviewed?.sourceNodePoints?.get(node) ?? points[i]!);
    if (reviewed?.sourceNodePoints) assert.deepEqual([...reviewed.sourceNodePoints.keys()], way.nodes, 'Registered walking source node sequence changed');
    return {way, tags, points: reviewed?.sourcePoints ?? points, nodePoints, reviewed};
  }
  function physical(id: string, points: readonly Vec3[], intervals: readonly (readonly [number, number])[], retainedAudit=false) {
    const qualification = selected.get(id); assert.ok(qualification?.partIds.length, `Missing walking source corridor ${id}`);
    const crossing=retainedAudit?options.reviewedRetainedCrossings?.get(id):undefined;
    const crossingReceipt=crossing?assertReviewedRetainedWalkingCrossing(crossing,records.get(id)!,ways.get(Number(id.slice(1)))!,options.exposure.find(e=>e.id===id)!.intervals):undefined;
    const inheritedBinding=options.reviewedInheritedWalkingSources?.get(id),inheritedSource=inheritedBinding?qualifyReviewedInheritedWalkingDrainSources(inheritedBinding.authority,{...inheritedBinding,record:records.get(id)!}):undefined;
    const authority = source(id,!!crossingReceipt), triangles = new Set<string>(); let samples = 0, maxHeightDeviation = 0;
    const declared = qualification.partIds.flatMap(partId => {
      const part = options.parts.find(part => part.id === partId); assert.ok(part, `Missing walking source surface ${partId}`);
      if (['Ajorata', 'Kevyt liikenne', 'Muu rakenneosa'].includes(String(part.properties.paatyyppi))) return [part];
      const clipped=inheritedSource?.parts.filter(p=>p.id===partId)??[];if(clipped.length){for(const clip of clipped)assert.deepEqual(clip.properties,part.properties,'Inherited source subtype changed');return clipped;}
      assert.ok(part.properties.paatyyppi === 'Silta' && authority.reviewed?.municipalBridgeSource, `Non-public walking surface ${partId}`);
      // Complete role/source verification grants only this source part's clipped
      // pedestrian sheet; cycle/vehicle bridge bands contribute no support.
      return reviewedBridgeWalkingParts(authority.reviewed.municipalBridgeSource, id, partId);
    });
    for (const [from, to] of intervals) for (let i = 0, n = Math.max(1, Math.ceil((to - from) / .25)); i <= n; i++) {
      const station = from + (to - from) * i / n, {point, tangent} = pointAlong(points, station), centre = point.map(Math.fround) as Vec3;
      assert.ok(nearestStation(authority.points, centre).distance <= .02, `Walking path ${id} diverges from its current OSM source`);
      assert.ok(containsSupportedArea(options.coverage, centre[0], centre[2], RADIUS), `Walking capsule ${id} leaves supported geography at ${centre[0]},${centre[2]}`);
      for (const [dx, dz] of [[0, 0], ...Array.from({length: 16}, (_, k) => [Math.cos(k * Math.PI / 8) * RADIUS, Math.sin(k * Math.PI / 8) * RADIUS])]) {
        const x = centre[0] + dx!, z = centre[2] + dz!, along = dx! * tangent[0] + dz! * tangent[1], expectedY = pointAlong(points, Math.max(0, Math.min(polylineLength(points), station + along))).point[1];
        assert.ok(declared.some(part => pointInPolygon([x, -z], part.rings)) || (authority.reviewed?.municipalBridgeSource && reviewedBridgeWalkingGapContains(authority.reviewed.municipalBridgeSource, id, qualification.partIds, x, z)), `Walking ${id} lacks municipal source support at ${x},${z}`);
        const hit = (authority.reviewed?.support ?? options.support).at(x, expectedY, z); assert.ok(hit, `Walking ${id} lacks native road/pavement support at ${x},${expectedY},${z}`); triangles.add(hit.triangle); maxHeightDeviation = Math.max(maxHeightDeviation, hit.deviation); samples++;
      }
    }
    return {id, intervals, samples, radiusMetres: RADIUS, stepMetres: .25, sourceWaySha256: sourceSha256(JSON.stringify(authority.way)), sourcePartIds: qualification.partIds, collisionTriangles: [...triangles].sort(), maxHeightDeviation, heightToleranceMetres: .2, ...(inheritedSource?{reviewedInheritedWalkingSource:inheritedSource.sourceWitnesses}:{}), ...(crossingReceipt?{reviewedRetainedCrossing:crossingReceipt}:{}), ...(authority.reviewed ? {reviewedSourceAndFloor: authority.reviewed.receipt} : {})};
  }
  const audits = [];
  for (const ref of [...options.retainedFootways, ...options.newFootways]) {
    const record = records.get(ref.id)!; const intervals = old.has(ref.id) ? options.exposure.find(exposure => exposure.id === ref.id)!.intervals : [[0, polylineLength(record.points)] as [number, number]];
    const admission = inspectFootwayAdmission(record.points, intervals, options.coverage); audits.push({id: ref.id, retained: old.has(ref.id), admission, physical: physical(ref.id, record.points, admission.admittedIntervals,old.has(ref.id))});
  }
  assert.ok(options.routes.length > 0 && options.routes.length <= 100, 'Explicit source-connected walking return routes required');
  const routes = options.routes.map(route => {
    assert.ok(route.steps.length >= 2 && route.steps.length <= 100); const steps = [];
    for (let i = 0; i < route.steps.length; i++) {
      const step = route.steps[i]!, previous = route.steps[(i + route.steps.length - 1) % route.steps.length]!; assert.equal(previous.toNode, step.fromNode, 'Walking route join lacks exact shared OSM node identity');
      const id = `w${step.wayId}`, record = records.get(id); assert.ok(record && selected.has(id), 'Walking route uses an unqualified record'); const authority = source(id);
      const from = authority.way.nodes!.indexOf(step.fromNode), to = authority.way.nodes!.indexOf(step.toNode); assert.ok(from >= 0 && to >= 0 && from !== to);
      const oneWay = authority.tags['oneway:foot']; assert.ok(!oneWay || ['no', 'yes', '-1'].includes(oneWay)); if (oneWay === 'yes') assert.ok(to > from); if (oneWay === '-1') assert.ok(to < from);
      const a = nearestStation(record.points, authority.nodePoints[from]!), b = nearestStation(record.points, authority.nodePoints[to]!); assert.ok(a.distance <= .02 && b.distance <= .02, 'Walking route node is not on its preserved source geometry');
      const points = slice(record.points, a.station, b.station);
      for (let j = 1; j < points.length; j++) assert.ok(supportsSegment(options.coverage, [Math.fround(points[j - 1]![0]), Math.fround(points[j - 1]![2])], [Math.fround(points[j]![0]), Math.fround(points[j]![2])], RADIUS), `Walking route ${route.id} has a closed capsule interval on ${id}`);
      steps.push({...step, id, sourceIndices: [from, to], recordStations: [a.station, b.station], points, physical: physical(id, record.points, [[Math.min(a.station, b.station), Math.max(a.station, b.station)]])});
    }
    const start = steps[0]!.points[0]!; assert.ok(containsSupportedArea(options.acceptedCoverage, start[0], start[2], RADIUS), 'Walking route has no accepted starting capsule');
    assert.ok(steps.some(step => step.points.some(point => !containsSupportedArea(options.acceptedCoverage, point[0], point[2]))), 'Walking route never enters expansion');
    for (let i = 0; i < steps.length; i++) {const a = steps[i]!.points.at(-1)!, b = steps[(i + 1) % steps.length]!.points[0]!; assert.ok(Math.hypot(a[0] - b[0], a[2] - b[2]) <= .02 && Math.abs(a[1] - b[1]) <= .2, 'Walking source join has a physical gap'); assert.ok(supportsSegment(options.coverage, [a[0], a[2]], [b[0], b[2]], RADIUS));}
    return {id: route.id, steps, connectedAcceptedOutAndBack: true};
  });
  return {footways: [...options.accepted.footways, ...additions], receipt: {status: 'PASS_SOURCE_AND_NATIVE_WALKING_NETWORK_PENDING_ACTUAL_CONTROLS', newFootwayIds: additions.map(record => record.id), retainedAudits: audits.filter(audit => audit.retained), newAudits: audits.filter(audit => !audit.retained), routes, actualWalkingRequired: true}};
}
