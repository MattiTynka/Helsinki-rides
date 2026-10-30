import assert from 'node:assert/strict';
import {test} from 'node:test';
import {assertHorizontalSubdivision} from '../lib/road-horizontal-subdivision.ts';
import type {Vec3} from '../../../packages/world-schema/src/index.ts';
test('reviewed XZ permits only forward subdivisions while heights project independently', () => {
  const before: Vec3[] = [[0, 0, 0], [2, 1, 0], [2, 2, 3]];
  assert.doesNotThrow(() => assertHorizontalSubdivision(before, [[0, 5, 0], [1, 6, 0], [2, 7, 0], [2, 8, 1], [2, 9, 3]]));
  assert.throws(() => assertHorizontalSubdivision(before, [[0, 0, 0], [1, 0, 1], [2, 0, 3]]), /bend removed/);
  assert.throws(() => assertHorizontalSubdivision(before, [[0, 0, 0], [1, 0, 0], [.5, 0, 0], [2, 0, 0], [2, 0, 3]]), /reverses/);
  assert.throws(() => assertHorizontalSubdivision(before, [[0, 0, 0], [1, 0, .00001], [2, 0, 0], [2, 0, 3]]), /leaves/);
});
