import assert from 'node:assert/strict';
import {test} from 'node:test';
import {canopyIntersectsFrontier, validateTreeFrontierSelection} from '../lib/frontier-tree-selection.ts';

test('west/corner selection includes canopy overhang but excludes distant trees at the same northing', () => {
  const selection = {regions: [[-1798, 763, -1787, 774]] as [number, number, number, number][]};
  validateTreeFrontierSelection(selection);
  assert.equal(canopyIntersectsFrontier([[-1786, 760], [-1789, 768], [-1784, 777]], selection).selected, true);
  assert.equal(canopyIntersectsFrontier([[200, 760], [205, 768], [209, 777]], selection).selected, false);
  assert.equal(canopyIntersectsFrontier([[-1790, 775], [-1788, 779]], selection).selected, false);
  assert.equal(canopyIntersectsFrontier([[-1790, 774], [-1788, 779]], selection).selected, true, 'boundary contact stays in the inspection');
  assert.equal(canopyIntersectsFrontier([[200, 760], [205, 768], [209, 777]], {bands: [[763, 774]]}).selected, true, 'legacy whole-width band behavior remains');
});

test('ambiguous, empty and invalid bounds fail before inspecting any trees', () => {
  for (const bad of [{}, {bands: []}, {bands: [[2, 1]]}, {regions: [[0, 0, Infinity, 2]]}, {bands: [[1, 2]], regions: [[0, 0, 1, 1]]}]) {
    assert.throws(() => validateTreeFrontierSelection(bad as Parameters<typeof validateTreeFrontierSelection>[0]));
  }
});
