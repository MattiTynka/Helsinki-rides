import assert from 'node:assert/strict';
import type { TerrainGrid } from '../../../packages/world-schema/src/index.ts';

function validateGrid(grid: TerrainGrid, label: string) {
  assert.ok([grid.x0, grid.z0, grid.resolution].every(Number.isFinite) && grid.resolution > 0, `${label}: invalid grid coordinates`);
  assert.ok(Number.isSafeInteger(grid.nx) && Number.isSafeInteger(grid.nz) && grid.nx >= 2 && grid.nz >= 2, `${label}: invalid dimensions`);
  assert.equal(grid.heights.length, grid.nx * grid.nz, `${label}: height count differs`);
  assert.ok(grid.heights.every(Number.isFinite), `${label}: nonfinite height`);
}

/** Extend the heightfield without losing monument, coastline or safety edits in the accepted rectangle. */
export function extendTerrainPreservingBase(base: TerrainGrid, expanded: TerrainGrid) {
  validateGrid(base, 'base'); validateGrid(expanded, 'expanded');
  assert.equal(base.resolution, expanded.resolution, 'Terrain resolution must match');
  const dx = (base.x0 - expanded.x0) / base.resolution;
  const dz = (base.z0 - expanded.z0) / base.resolution;
  assert.ok(Number.isSafeInteger(dx) && Number.isSafeInteger(dz), 'Terrain origins must align exactly on the same grid');
  assert.ok(dx >= 0 && dz >= 0 && dx + base.nx <= expanded.nx && dz + base.nz <= expanded.nz, 'Expanded terrain must contain the complete accepted grid');
  assert.ok(expanded.nx * expanded.nz > base.nx * base.nz, 'Expanded terrain must add grid points');
  const heights = expanded.heights.slice();
  // Copy typed bytes, including signed zero. Re-sampling the old rectangle would invalidate its authored safety edits.
  const source = new Uint32Array(base.heights.buffer, base.heights.byteOffset, base.heights.length);
  const target = new Uint32Array(heights.buffer, heights.byteOffset, heights.length);
  let overriddenGridPoints = 0;
  for (let z = 0; z < base.nz; z++) {
    const offset = (z + dz) * expanded.nx + dx;
    for (let x = 0; x < base.nx; x++) if (target[offset + x] !== source[z * base.nx + x]) overriddenGridPoints++;
    target.set(source.subarray(z * base.nx, (z + 1) * base.nx), offset);
  }
  return { terrain: { ...expanded, heights }, audit: {
    preservedGridPoints: base.nx * base.nz, addedGridPoints: expanded.nx * expanded.nz - base.nx * base.nz,
    overriddenGridPoints, baseOffset: [dx, dz], method: 'Exact uint32 row copies of all accepted Float32 heights, including the shared boundary',
  } };
}
