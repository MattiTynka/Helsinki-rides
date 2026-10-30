import test from 'node:test';
import assert from 'node:assert/strict';
import type {LocalPolygon} from '../lib/geometry.ts';
import {measureSingleLaneAlignment} from '../lib/measured-single-lane-alignment.ts';

const rectangle = (id: string, x0: number, z0: number, x1: number, z1: number): LocalPolygon => ({id, properties: {alatyyppi: 'Ajorata'}, rings: [[[x0,-z0],[x1,-z0],[x1,-z1],[x0,-z1]]], bbox: [x0,-z1,x1,-z0]});
const bounds = {maximumShiftMetres: 2, maximumShiftSlope: .2, sourceHalfEnvelopeMetres: 1.115, longitudinalHalfEnvelopeMetres: 2.545, stationStepMetres: .25, crossSectionHalfLengthMetres: 10};
test('measures a new ordinary lane within its actual narrow source carriageway', () => {
  const result = measureSingleLaneAlignment([[0,4,0],[20,5,0]], [rectangle('ordinary',-4,-2.7,24,.5)], bounds);
  assert.ok(Math.abs(result.maximumShiftMetres - .615) < 1e-12);
  assert.ok(Math.abs(result.minimumMeasuredWidthMetres - 3.2) < 1e-12);
  assert.ok(result.points.every(p => Math.abs(p[2] + .615) < 1e-12));
  assert.deepEqual(result.points[0]?.slice(0,2), [0,4]);
  assert.deepEqual(result.points.at(-1)?.slice(0,2), [20,5]);
});
test('does not bridge a source gap or pick an ambiguous parallel carriageway', () => {
  assert.throws(() => measureSingleLaneAlignment([[0,0,0],[20,0,0]], [rectangle('left',-4,-3,9,3),rectangle('right',9.001,-3,24,3)], bounds), /exact source gap/);
  assert.throws(() => measureSingleLaneAlignment([[0,0,0],[20,0,0]], [rectangle('a',-4,-4,24,-.01),rectangle('b',-4,.01,24,4)], bounds), /Ambiguous parallel/);
});
test('fails body overhang and rejects transit strip as ordinary carriageway', () => {
  assert.throws(() => measureSingleLaneAlignment([[0,0,0],[20,0,0]], [rectangle('too-short',0,-3,20,3)], bounds), /source corridor is absent/);
  const transit = rectangle('transit',-4,-3,24,3); transit.properties.alatyyppi = 'Ajorata, muu';
  assert.throws(() => measureSingleLaneAlignment([[0,0,0],[20,0,0]], [transit], bounds), /ordinary carriageway/);
});
