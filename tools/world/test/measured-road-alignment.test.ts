import test from 'node:test';
import assert from 'node:assert/strict';
import {carriagewayCrossSection, measurePairedRoadAlignment, pairedAlignedRoadPoints} from '../lib/measured-road-alignment.ts';
import type {LocalPolygon} from '../lib/geometry.ts';
const rectangle = (id: string, x0: number, x1: number, z0 = -5, z1 = 25): LocalPolygon => ({id, rings: [[[x0, -z0], [x1, -z0], [x1, -z1], [x0, -z1]]], bbox: [x0, -z1, x1, -z0], properties: {alatyyppi: 'Ajorata'}});
const bounds = {maximumShiftMetres: 1.25, maximumShiftSlope: .15, sourceHalfEnvelopeMetres: 2.625, stationStepMetres: .25, crossSectionHalfLengthMetres: 10};
test('measured paired lanes retain their separation while following the source carriageway', () => {
  const axis: [number, number, number][] = [[0, 0, 0], [0, 0, 20]], profile = measurePairedRoadAlignment(axis, [rectangle('road', -2.4, 3.4)], bounds);
  assert.equal(profile.minimumSourceWidthMetres, 5.8); assert.ok(Math.abs(profile.maximumShiftMetres - .225) < 1e-12);
  const forward = pairedAlignedRoadPoints(axis, profile, 1.5), backward = pairedAlignedRoadPoints(axis, profile, -1.5);
  for (let i = 0; i < forward.length; i++) assert.ok(Math.abs(Math.hypot(forward[i]![0] - backward[i]![0], forward[i]![2] - backward[i]![2]) - 3) < 1e-12);
});
test('cross-section never joins carriageway pieces separated by a real gap', () => {
  const sections = carriagewayCrossSection([0, 0], [0, 1], [rectangle('left', -4, -.001), rectangle('right', .001, 4)], 10);
  assert.deepEqual(sections, [[-4, -.001], [.001, 4]]);
  assert.throws(() => measurePairedRoadAlignment([[0, 0, 0], [0, 0, 20]], [rectangle('left', -4, -.001), rectangle('right', .001, 4)], bounds), /continuous carriageway/);
});
test('narrow or abruptly displaced source roads fail without reducing the envelope', () => {
  assert.throws(() => measurePairedRoadAlignment([[0, 0, 0], [0, 0, 20]], [rectangle('narrow', -2, 2)], bounds), /do not fit/);
  const pieces = [rectangle('a', -1.8, 3.8, -5, 10), rectangle('b', -3.8, 1.8, 10, 25)];
  assert.throws(() => measurePairedRoadAlignment([[0, 0, 0], [0, 0, 20]], pieces, bounds), /excessive lateral slope/);
});
test('longitudinal reservation moves a curve-facing corner inward before its centre reaches the narrowed flank', () => {
  const road: LocalPolygon = {id: 'slanted', rings: [[[-3.3, 5], [2.8, 5], [4.3, -25], [-1.8, -25]]], bbox: [-3.3, -25, 4.3, 5], properties: {alatyyppi: 'Ajorata'}};
  const axis: [number, number, number][] = [[0, 0, 0], [0, 0, 20]];
  const centre = measurePairedRoadAlignment(axis, [road], bounds), whole = measurePairedRoadAlignment(axis, [road], {...bounds, longitudinalHalfEnvelopeMetres: 2.6});
  const atTen = (profile: typeof centre) => profile.stations.find(s => Math.abs(s.distance - 10) < 1e-8)!;
  assert.ok(Math.abs(atTen(whole).shift) > Math.abs(atTen(centre).shift) + .1);
  for (const station of whole.stations) for (const along of [-2.6, 0, 2.6]) {
    const section = carriagewayCrossSection([station.point[0], station.point[2] + along], station.tangent, [road], 10)[0]!;
    assert.ok(station.shift - bounds.sourceHalfEnvelopeMetres >= section[0] - 1e-10);
    assert.ok(station.shift + bounds.sourceHalfEnvelopeMetres <= section[1] + 1e-10);
  }
});
