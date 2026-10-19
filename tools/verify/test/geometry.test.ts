import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exteriorSamples, interiorSamples, pointInPolygon, quantile, type XZ } from '../geometry.ts';

const square: XZ[] = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]];
const hole: XZ[] = [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]];

test('polygon membership honours holes', () => {
  assert.ok(pointInPolygon([1, 1], [square]));
  assert.ok(!pointInPolygon([5, 5], [square, hole]));
  assert.ok(!pointInPolygon([11, 5], [square]));
});

test('interior samples keep their inset and exterior samples stay outside', () => {
  const inside = interiorSamples([square], 1, 2);
  assert.ok(inside.length > 0 && inside.every(([x, z]) => x >= 2 && x <= 8 && z >= 2 && z <= 8));
  const outside = exteriorSamples([square], 3, 5);
  assert.equal(outside.length, 8);
  assert.ok(outside.every(p => !pointInPolygon(p, [square])));
});

test('quantile picks from the sorted values', () => {
  assert.equal(quantile([5, 1, 3], 0), 1);
  assert.equal(quantile([5, 1, 3], 0.5), 3);
  assert.equal(quantile([5, 1, 3], 1), 5);
});
