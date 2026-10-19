import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellId, cellIndexFor, geodeticToGk25, gk25ToGeodetic, headingForYaw, projectedToRuntime, runtimeToProjected, yawForHeading, type WorldOrigin } from '../src/coordinates.ts';

const origin: WorldOrigin = { id: 'test', originProjected: [25497350, 6672960, 7.29] } as WorldOrigin;

test('GK25 projection round-trips and keeps the central meridian at E 25 500 000', () => {
  const [e, n] = geodeticToGk25(60.1695, 24.9522);
  const [lat, lon] = gk25ToGeodetic(e, n);
  assert.ok(Math.abs(lat - 60.1695) < 1e-9 && Math.abs(lon - 24.9522) < 1e-9, `round trip ${lat},${lon}`);
  const [eMeridian] = geodeticToGk25(60.1695, 25);
  assert.ok(Math.abs(eMeridian - 25500000) < 1e-5, `central meridian easting ${eMeridian}`);
  // Senate Square is west of the meridian and roughly 6.67 million metres north.
  assert.ok(e < 25500000 && e > 25495000 && n > 6672000 && n < 6674000, `${e},${n}`);
});

test('runtime frame is X east, Y up, Z south relative to the origin', () => {
  const p = projectedToRuntime(origin, 25497360, 6672980, 10.29);
  assert.deepEqual(p.map(v => Math.round(v * 1000) / 1000), [10, 3, -20]);
  const back = runtimeToProjected(origin, p);
  assert.deepEqual(back.map(v => Math.round(v * 1000) / 1000), [25497360, 6672980, 10.29]);
});

test('headings: north faces -Z, east faces +X', () => {
  const north = yawForHeading(0), east = yawForHeading(90);
  assert.ok(Math.abs(Math.cos(north) + 1) < 1e-12 && Math.abs(Math.sin(north)) < 1e-12, `north yaw ${north}`);
  assert.ok(Math.abs(Math.sin(east) - 1) < 1e-12, `east yaw ${east}`);
  assert.ok(Math.abs(headingForYaw(yawForHeading(300)) - 300) < 1e-9);
});

test('cell ids follow the sign-letter convention', () => {
  assert.deepEqual(cellIndexFor(-1, -1, 128), [-1, -1]);
  assert.deepEqual(cellIndexFor(127.9, 0, 128), [0, 0]);
  assert.equal(cellId(-1, 2), 'c_m01_p02');
});
