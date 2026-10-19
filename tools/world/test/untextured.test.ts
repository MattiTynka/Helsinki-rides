import assert from 'node:assert/strict';
import { test } from 'node:test';
import { splitBySlope } from '../lib/untextured.ts';

test('untextured triangles split into wall, roof and underside by the Y of their normal', () => {
  // Runtime frame, Y up. A wall facing +Z, a roof facing up and a floor facing down, one triangle each.
  const positions = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 1, -1, 0, 0, -1];
  const wall = [0, 1, 2], roof = [3, 2, 4], floor = [0, 5, 1], degenerate = [0, 0, 1];
  const s = splitBySlope(positions, [...wall, ...roof, ...floor, ...degenerate], 0.3);
  assert.deepEqual([...s.wall], wall);
  assert.deepEqual([...s.roof], roof);
  assert.deepEqual([...s.under], floor);
});
