import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extendTerrainPreservingBase } from '../lib/terrain-extension.ts';
import type { TerrainGrid } from '../../../packages/world-schema/src/index.ts';

const grid = (x0: number, z0: number, nx: number, nz: number, fill = 7): TerrainGrid => ({ x0, z0, resolution: 1, nx, nz, heights: new Float32Array(nx * nz).fill(fill) });
test('west and south extension retains all accepted safety edits and exact shared-boundary bits', () => {
  const base = grid(-2, -1, 3, 2); base.heights.set([-0, -30, 1.25, 5.5, 9, 3]);
  const expanded = grid(-4, -1, 5, 4, 42), before = expanded.heights.slice();
  const { terrain, audit } = extendTerrainPreservingBase(base, expanded);
  assert.deepEqual(audit.baseOffset, [2, 0]); assert.equal(audit.preservedGridPoints, 6); assert.equal(audit.addedGridPoints, 14);
  assert.deepEqual(Array.from(terrain.heights), [42, 42, -0, -30, 1.25, 42, 42, 5.5, 9, 3, 42, 42, 42, 42, 42, 42, 42, 42, 42, 42]);
  assert.equal(Object.is(terrain.heights[2], -0), true); assert.deepEqual(expanded.heights, before);
});
test('north/east extension correctly offsets row-major data without transposing axes', () => {
  const base = grid(0, 0, 2, 2); base.heights.set([1, 2, 3, 4]);
  const result = extendTerrainPreservingBase(base, grid(0, -2, 3, 4, 0));
  assert.deepEqual(Array.from(result.terrain.heights), [0, 0, 0, 0, 0, 0, 1, 2, 0, 3, 4, 0]);
});
test('partial overlap, incompatible resolution, sub-grid origins and invalid heights fail before mutation', () => {
  const base = grid(0, 0, 2, 2);
  assert.throws(() => extendTerrainPreservingBase(base, grid(1, 0, 3, 3)), /contain/);
  assert.throws(() => extendTerrainPreservingBase(base, { ...grid(-2, -2, 5, 5), resolution: 2 }), /resolution/);
  assert.throws(() => extendTerrainPreservingBase(base, grid(-.5, 0, 4, 3)), /align/);
  assert.throws(() => extendTerrainPreservingBase(base, { ...grid(-1, 0, 4, 3), heights: new Float32Array([NaN]) }), /height count/);
  const bad = grid(-1, 0, 4, 3); bad.heights[0] = Infinity;
  assert.throws(() => extendTerrainPreservingBase(base, bad), /nonfinite/);
  assert.throws(() => extendTerrainPreservingBase(base, base), /add grid/);
});
