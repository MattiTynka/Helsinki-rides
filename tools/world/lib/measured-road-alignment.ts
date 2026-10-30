import assert from 'node:assert/strict';
import {pointAlong, polylineLength, type Vec3} from '../../../packages/world-schema/src/index.ts';
import {pointInPolygon, type LocalPolygon} from './geometry.ts';

type XZ = readonly [number, number];
interface AlignmentBounds {
  maximumShiftMetres: number;
  maximumShiftSlope: number;
  sourceHalfEnvelopeMetres: number;
  stationStepMetres: number;
  crossSectionHalfLengthMetres: number;
  longitudinalHalfEnvelopeMetres?: number;
}
interface AlignmentStation {
  distance: number; point: Vec3; tangent: [number, number]; interval: [number, number];
  allowedShift: [number, number]; feasibleShift: [number, number]; shift: number;
}
const cross = (a: XZ, b: XZ) => a[0] * b[1] - a[1] * b[0];

/** Exact intersections with the reviewed carriageway rings. No gap is bridged by this measurement. */
export function carriagewayCrossSection(point: XZ, tangent: XZ, parts: readonly LocalPolygon[], halfLength: number): [number, number][] {
  const direction: XZ = [-tangent[1], tangent[0]], knots = [-halfLength, halfLength];
  for (const part of parts) for (const ring of part.rings) for (let i = 0; i < ring.length; i++) {
    const rawA = ring[i]!, rawB = ring[(i + 1) % ring.length]!, a: XZ = [rawA[0], -rawA[1]], b: XZ = [rawB[0], -rawB[1]];
    const edge: XZ = [b[0] - a[0], b[1] - a[1]], delta: XZ = [a[0] - point[0], a[1] - point[1]], denominator = cross(direction, edge);
    if (Math.abs(denominator) < 1e-12) continue;
    const distance = cross(delta, edge) / denominator, fraction = cross(delta, direction) / denominator;
    if (fraction >= 0 && fraction <= 1 && distance >= -halfLength && distance <= halfLength) knots.push(distance);
  }
  const sorted = [...new Set(knots)].sort((a, b) => a - b), intervals: [number, number][] = [];
  for (let i = 1; i < sorted.length; i++) {
    const lo = sorted[i - 1]!, hi = sorted[i]!; if (!(hi > lo)) continue;
    const middle = (lo + hi) / 2, x = point[0] + direction[0] * middle, z = point[1] + direction[1] * middle;
    if (!parts.some(part => pointInPolygon([x, -z], part.rings))) continue;
    const previous = intervals.at(-1);
    if (previous?.[1] === lo) previous[1] = hi; else intervals.push([lo, hi]);
  }
  return intervals;
}

/** A common bounded translation of an explicitly two-lane source axis.
 * The feasible intervals reserve both lane offsets plus the actual vehicle envelope.
 * Forward/backward propagation limits lateral slope without averaging across source gaps.
 * This constructs candidate graph geometry only; complete footprint, native floor and driving gates follow.
 */
export function measurePairedRoadAlignment(axis: readonly Vec3[], parts: readonly LocalPolygon[], bounds: AlignmentBounds) {
  assert.ok(axis.length >= 2 && axis.length <= 10_000 && axis.every(p => p.every(Number.isFinite)));
  assert.ok(parts.length > 0 && parts.length <= 128 && parts.every(p => p.properties.alatyyppi === 'Ajorata'), 'Reviewed carriageway polygons required');
  assert.ok(bounds.maximumShiftMetres > 0 && bounds.maximumShiftMetres <= 2 && bounds.maximumShiftSlope > 0 && bounds.maximumShiftSlope <= .2);
  assert.ok(bounds.sourceHalfEnvelopeMetres >= 2 && bounds.sourceHalfEnvelopeMetres <= 5 && bounds.stationStepMetres >= .1 && bounds.stationStepMetres <= .5);
  assert.ok(bounds.crossSectionHalfLengthMetres >= 6 && bounds.crossSectionHalfLengthMetres <= 20);
  const longitudinalHalfEnvelope = bounds.longitudinalHalfEnvelopeMetres ?? 0;
  assert.ok(longitudinalHalfEnvelope >= 0 && longitudinalHalfEnvelope <= 5);
  const length = polylineLength(axis); assert.ok(length > 2 && length < 2000);
  const count = Math.ceil(length / bounds.stationStepMetres), stations: AlignmentStation[] = [];
  for (let i = 0; i <= count; i++) {
    const distance = length * i / count, {point, tangent} = pointAlong(axis, distance);
    const intervals = carriagewayCrossSection([point[0], point[2]], tangent, parts, bounds.crossSectionHalfLengthMetres);
    const containing = intervals.filter(([lo, hi]) => lo <= 0 && hi >= 0);
    assert.equal(containing.length, 1, `Source axis lacks one continuous carriageway at station ${distance}`);
    const interval = containing[0]!;
    assert.ok(interval[0] > -bounds.crossSectionHalfLengthMetres && interval[1] < bounds.crossSectionHalfLengthMetres, 'Source cross-section is truncated');
    const allowedShift: [number, number] = [Math.max(-bounds.maximumShiftMetres, interval[0] + bounds.sourceHalfEnvelopeMetres), Math.min(bounds.maximumShiftMetres, interval[1] - bounds.sourceHalfEnvelopeMetres)];
    // Both vehicles' longitudinal overhang must fit the same shared translation.
    // A centre-only cross-section can put the front corner onto a curved traffic island.
    const longitudinalSteps = Math.max(1, Math.ceil(longitudinalHalfEnvelope * 2 / .25));
    for (let j = 0; longitudinalHalfEnvelope > 0 && j <= longitudinalSteps; j++) {
      const along = -longitudinalHalfEnvelope + longitudinalHalfEnvelope * 2 * j / longitudinalSteps;
      const p: XZ = [point[0] + tangent[0] * along, point[2] + tangent[1] * along];
      const intervals = carriagewayCrossSection(p, tangent, parts, bounds.crossSectionHalfLengthMetres);
      const containing = intervals.filter(([lo, hi]) => lo <= 0 && hi >= 0);
      assert.equal(containing.length, 1, `Longitudinal vehicle envelope lacks one carriageway at station ${distance}, overhang ${along}`);
      const corridor = containing[0]!;
      assert.ok(corridor[0] > -bounds.crossSectionHalfLengthMetres && corridor[1] < bounds.crossSectionHalfLengthMetres, 'Vehicle overhang cross-section is truncated');
      allowedShift[0] = Math.max(allowedShift[0], corridor[0] + bounds.sourceHalfEnvelopeMetres);
      allowedShift[1] = Math.min(allowedShift[1], corridor[1] - bounds.sourceHalfEnvelopeMetres);
    }
    assert.ok(allowedShift[0] <= allowedShift[1], `Two complete vehicle corridors do not fit station ${distance}`);
    stations.push({distance, point, tangent, interval, allowedShift, feasibleShift: [...allowedShift], shift: 0});
  }
  for (const direction of [1, -1]) for (let n = 1; n < stations.length; n++) {
    const i = direction === 1 ? n : stations.length - n - 1, previous = stations[i - direction]!, current = stations[i]!;
    const change = Math.abs(current.distance - previous.distance) * bounds.maximumShiftSlope;
    current.feasibleShift[0] = Math.max(current.feasibleShift[0], previous.feasibleShift[0] - change);
    current.feasibleShift[1] = Math.min(current.feasibleShift[1], previous.feasibleShift[1] + change);
    assert.ok(current.feasibleShift[0] <= current.feasibleShift[1], `Source corridor needs an excessive lateral slope near ${current.distance}`);
  }
  for (const station of stations) station.shift = Math.max(station.feasibleShift[0], Math.min(0, station.feasibleShift[1]));
  // Convex averaging preserves the Lipschitz bound; clamping between the feasible
  // Lipschitz envelopes keeps the source-width and displacement constraints intact.
  for (let pass = 0; pass < 16; pass++) {
    const previous = stations.map(s => s.shift);
    for (let i = 1; i + 1 < stations.length; i++) {
      const station = stations[i]!, average = (previous[i - 1]! + 2 * previous[i]! + previous[i + 1]!) / 4;
      station.shift = Math.max(station.feasibleShift[0], Math.min(average, station.feasibleShift[1]));
    }
  }
  for (let i = 1; i < stations.length; i++) assert.ok(Math.abs(stations[i]!.shift - stations[i - 1]!.shift) <= (stations[i]!.distance - stations[i - 1]!.distance) * bounds.maximumShiftSlope + 1e-10, 'Smoothed alignment exceeds slope bound');
  return {length, bounds, stations, maximumShiftMetres: Math.max(...stations.map(s => Math.abs(s.shift))), minimumSourceWidthMetres: Math.min(...stations.map(s => s.interval[1] - s.interval[0]))};
}

/** Interpolated miter frames retain the existing native road offset convention. */
export function pairedAlignedRoadPoints(axis: readonly Vec3[], profile: ReturnType<typeof measurePairedRoadAlignment>, offset: number): Vec3[] {
  assert.ok(Number.isFinite(offset) && Math.abs(offset) <= 3);
  const frames: [number, number][] = axis.map((point, i) => {
    const a = axis[Math.max(0, i - 1)]!, b = axis[Math.min(axis.length - 1, i + 1)]!, dx = b[0] - a[0], dz = b[2] - a[2], length = Math.hypot(dx, dz); assert.ok(length > 0);
    let scale = 1;
    if (i > 0 && i + 1 < axis.length) {
      const ux = point[0] - a[0], uz = point[2] - a[2], vx = b[0] - point[0], vz = b[2] - point[2];
      const cosine = (ux * vx + uz * vz) / (Math.hypot(ux, uz) * Math.hypot(vx, vz));
      scale = Math.min(2, 1 / Math.max(.5, Math.cos(Math.acos(Math.max(-1, Math.min(1, cosine))) / 2)));
    }
    return [-dz / length * scale, dx / length * scale];
  });
  const distances = [0]; for (let i = 1; i < axis.length; i++) distances.push(distances.at(-1)! + Math.hypot(axis[i]![0] - axis[i - 1]![0], axis[i]![2] - axis[i - 1]![2]));
  const points: Vec3[] = []; let segment = 1;
  for (const station of profile.stations) {
    while (segment + 1 < axis.length && distances[segment]! < station.distance) segment++;
    const t = (station.distance - distances[segment - 1]!) / (distances[segment]! - distances[segment - 1]!), a = frames[segment - 1]!, b = frames[segment]!;
    const normal = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], shift = offset + station.shift;
    points.push([station.point[0] + normal[0]! * shift, station.point[1], station.point[2] + normal[1]! * shift]);
  }
  return points;
}
