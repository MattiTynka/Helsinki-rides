import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeCollisionBundle, parseCollisionBundle } from '../src/collision.ts';
import { encodeTerrain, parseTerrain, sampleTerrain } from '../src/terrain.ts';

test('HCOL round-trips colliders, tags and the header', () => {
  const bytes = encodeCollisionBundle({ originId: 'o', frame: 'X-east,Y-up,Z-south', cell: 'c_p00_p00', surfaceTags: ['road', 'curb'] }, [
    { id: 'g', group: 'ground', ref: 'surface-1', positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 1]), indices: new Uint32Array([0, 2, 1, 1, 2, 3]), triangleTags: new Uint16Array([0, 1]) },
    { id: 'b', group: 'buildings', ref: 'BID_1', positions: new Float32Array([0, 0, 0, 0, 3, 0, 1, 0, 0]), indices: new Uint32Array([0, 1, 2]), triangleTags: new Uint16Array([0]) },
  ]);
  const bundle = parseCollisionBundle(bytes);
  assert.equal(bundle.header.cell, 'c_p00_p00');
  assert.deepEqual(bundle.header.surfaceTags, ['road', 'curb']);
  assert.equal(bundle.colliders.length, 2);
  assert.deepEqual(Array.from(bundle.colliders[0]!.indices), [0, 2, 1, 1, 2, 3]);
  assert.deepEqual(Array.from(bundle.colliders[0]!.triangleTags), [0, 1]);
  assert.equal(bundle.colliders[1]!.ref, 'BID_1');
  assert.equal(bundle.colliders[1]!.positions[4], 3);
  assert.throws(() => encodeCollisionBundle({ originId: 'o', frame: 'X-east,Y-up,Z-south', cell: 'x', surfaceTags: [] }, [{ id: 'bad', group: 'ground', ref: null, positions: new Float32Array(9), indices: new Uint32Array([0, 1]), triangleTags: new Uint16Array(1) }]));
});

test('HTER round-trips and samples bilinearly', () => {
  const heights = new Float32Array([0, 1, 2, 1, 2, 3]); // nx 3, nz 2: h = x + z
  const bytes = encodeTerrain({ x0: -10, z0: 5, resolution: 2, nx: 3, nz: 2, heights });
  const t = parseTerrain(bytes);
  assert.equal(t.nx, 3); assert.equal(t.nz, 2); assert.equal(t.resolution, 2); assert.equal(t.x0, -10); assert.equal(t.z0, 5);
  assert.equal(sampleTerrain(t, -10, 5), 0);
  assert.equal(sampleTerrain(t, -6, 7), 3);
  assert.ok(Math.abs(sampleTerrain(t, -9, 6) - 1) < 1e-6, 'midpoint');
  assert.equal(sampleTerrain(t, 100, 100), 3, 'clamped outside the grid');
});
