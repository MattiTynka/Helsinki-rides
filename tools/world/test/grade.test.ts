import assert from 'node:assert/strict';
import { test } from 'node:test';
import { removeVeil } from '../lib/grade.ts';

test('the grade maps the veil to black and leaves chart padding black', () => {
  const px = Uint8Array.from([23, 30, 35, 255, 0, 0, 0, 255, 255, 255, 255, 255]);
  removeVeil(px, { veil: [23, 30, 35], saturation: 1.15, sharpenSigma: 0 });
  assert.deepEqual(Array.from(px), [0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255]);
});
