import assert from 'node:assert/strict';
import {pointAlong, polylineLength, type Vec3} from '../../../packages/world-schema/src/index.ts';
import {pointInPolygon, type LocalPolygon} from './geometry.ts';
import {carriagewayCrossSection} from './measured-road-alignment.ts';

type Interval = [number, number];
export interface SingleLaneAlignmentBounds {
  maximumShiftMetres: number;
  maximumShiftSlope: number;
  sourceHalfEnvelopeMetres: number;
  longitudinalHalfEnvelopeMetres: number;
  stationStepMetres: number;
  crossSectionHalfLengthMetres: number;
}

function intersectIntervals(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const result: Interval[] = [];
  for (const x of a) for (const y of b) {
    const lo = Math.max(x[0], y[0]), hi = Math.min(x[1], y[1]);
    if (lo <= hi) result.push([lo, hi]);
  }
  return result;
}

function segmentSourceCovered(a: Vec3, b: Vec3, parts: readonly LocalPolygon[]): boolean {
  const dx = b[0] - a[0], dn = a[2] - b[2], knots = [0, 1];
  for (const part of parts) for (const ring of part.rings) for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!, q = ring[(i + 1) % ring.length]!, ex = q[0] - p[0], en = q[1] - p[1];
    const px = p[0] - a[0], pn = p[1] + a[2], denominator = dx * en - dn * ex;
    if (denominator !== 0) {
      const t = (px * en - pn * ex) / denominator, u = (px * dn - pn * dx) / denominator;
      if (t > 0 && t < 1 && u >= 0 && u <= 1) knots.push(t);
    } else if (px * dn - pn * dx === 0 && dx * dx + dn * dn > 0) {
      for (const v of [p, q]) {const t = ((v[0] - a[0]) * dx + (v[1] + a[2]) * dn) / (dx * dx + dn * dn); if (t > 0 && t < 1) knots.push(t);}
    }
  }
  const sorted = [...new Set(knots)].sort((a, b) => a - b);
  return sorted.slice(1).every((hi, i) => {const t = (sorted[i]! + hi) / 2; return parts.some(p => pointInPolygon([a[0] + dx * t, -a[2] + dn * t], p.rings));});
}

/** Candidate geometry for one explicitly selected NEW lane. The source interval
 * must be unique for the complete longitudinal body at every station. This never
 * chooses a different parallel carriageway, changes a source polygon, or certifies
 * a junction turn. Final continuous vehicle/serialized floor checks remain required. */
export function measureSingleLaneAlignment(axis: readonly Vec3[], parts: readonly LocalPolygon[], bounds: SingleLaneAlignmentBounds) {
  assert.ok(axis.length >= 2 && axis.length <= 10_000 && axis.every(p => p.length === 3 && p.every(Number.isFinite)));
  assert.ok(parts.length > 0 && parts.length <= 128 && parts.every(p => p.properties.alatyyppi === 'Ajorata'), 'Explicit ordinary carriageway polygons required');
  assert.ok(bounds.maximumShiftMetres > 0 && bounds.maximumShiftMetres <= 2);
  assert.ok(bounds.maximumShiftSlope > 0 && bounds.maximumShiftSlope <= .2);
  assert.ok(bounds.sourceHalfEnvelopeMetres >= 1 && bounds.sourceHalfEnvelopeMetres <= 3);
  assert.ok(bounds.longitudinalHalfEnvelopeMetres >= 2 && bounds.longitudinalHalfEnvelopeMetres <= 5);
  assert.ok(bounds.stationStepMetres >= .1 && bounds.stationStepMetres <= .5);
  assert.ok(bounds.crossSectionHalfLengthMetres >= 6 && bounds.crossSectionHalfLengthMetres <= 20);
  const length = polylineLength(axis); assert.ok(length > 0 && length < 2000);
  const count = Math.ceil(length / bounds.stationStepMetres);
  const stations = Array.from({length: count + 1}, (_, i) => {
    const distance = length * i / count, {point, tangent} = pointAlong(axis, distance);
    let feasible: Interval[] = [[-bounds.maximumShiftMetres, bounds.maximumShiftMetres]];
    const overhangSteps = Math.ceil(2 * bounds.longitudinalHalfEnvelopeMetres / .25);
    let minimumMeasuredWidth = Infinity;
    for (let j = 0; j <= overhangSteps; j++) {
      const along = -bounds.longitudinalHalfEnvelopeMetres + 2 * bounds.longitudinalHalfEnvelopeMetres * j / overhangSteps;
      const p: [number, number] = [point[0] + tangent[0] * along, point[2] + tangent[1] * along];
      const source = carriagewayCrossSection(p, tangent, parts, bounds.crossSectionHalfLengthMetres);
      const corridors = source.filter(([lo, hi]) => lo > -bounds.crossSectionHalfLengthMetres && hi < bounds.crossSectionHalfLengthMetres && hi - lo >= 2 * bounds.sourceHalfEnvelopeMetres);
      const intervals = corridors.map(([lo, hi]): Interval => [lo + bounds.sourceHalfEnvelopeMetres, hi - bounds.sourceHalfEnvelopeMetres]);
      feasible = intersectIntervals(feasible, intervals);
      assert.ok(feasible.length, `Complete vehicle source corridor is absent at station ${distance}, overhang ${along}`);
      minimumMeasuredWidth = Math.min(minimumMeasuredWidth, ...corridors.filter(([lo, hi]) => feasible.some(([a, b]) => a >= lo && b <= hi)).map(([lo, hi]) => hi - lo));
    }
    assert.equal(feasible.length, 1, `Ambiguous parallel source carriageways at station ${distance}`);
    return {distance, point, tangent, allowedShift: [...feasible[0]!] as Interval, feasibleShift: [...feasible[0]!] as Interval, shift: 0, minimumMeasuredWidth};
  });
  for (const direction of [1, -1]) for (let n = 1; n < stations.length; n++) {
    const i = direction === 1 ? n : stations.length - n - 1, current = stations[i]!, previous = stations[i - direction]!;
    const delta = Math.abs(current.distance - previous.distance) * bounds.maximumShiftSlope;
    current.feasibleShift[0] = Math.max(current.feasibleShift[0], previous.feasibleShift[0] - delta);
    current.feasibleShift[1] = Math.min(current.feasibleShift[1], previous.feasibleShift[1] + delta);
    assert.ok(current.feasibleShift[0] <= current.feasibleShift[1], `Source corridor requires an excessive lateral slope at ${current.distance}`);
  }
  for (const s of stations) s.shift = Math.max(s.feasibleShift[0], Math.min(0, s.feasibleShift[1]));
  for (let pass = 0; pass < 16; pass++) {
    const previous = stations.map(s => s.shift);
    for (let i = 1; i + 1 < stations.length; i++) {
      const s = stations[i]!, average = (previous[i - 1]! + 2 * previous[i]! + previous[i + 1]!) / 4;
      s.shift = Math.max(s.feasibleShift[0], Math.min(average, s.feasibleShift[1]));
    }
  }
  for (let i = 1; i < stations.length; i++) assert.ok(Math.abs(stations[i]!.shift - stations[i - 1]!.shift) <= (stations[i]!.distance - stations[i - 1]!.distance) * bounds.maximumShiftSlope + 1e-10);
  const points: Vec3[] = stations.map(s => [s.point[0] - s.tangent[1] * s.shift, s.point[1], s.point[2] + s.tangent[0] * s.shift]);
  for (let i = 1; i < points.length; i++) assert.ok(segmentSourceCovered(points[i - 1]!, points[i]!, parts), `Registered centreline crosses an exact source gap at station ${stations[i]!.distance}`);
  return {length, bounds, stations, points, maximumShiftMetres: Math.max(...stations.map(s => Math.abs(s.shift))), minimumMeasuredWidthMetres: Math.min(...stations.map(s => s.minimumMeasuredWidth)), status: 'CANDIDATE_PENDING_CONTINUOUS_VEHICLE_NATIVE_FLOOR_AND_TRAVEL'};
}
