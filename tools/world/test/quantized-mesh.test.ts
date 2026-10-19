import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { decodeQuantizedMesh, TileSampler } from '../lib/quantized-mesh.ts';

test('a quantized-mesh tile decodes zig-zag deltas and high-water-mark indices, gzipped or not', () => {
  // One triangle over half the tile: corners SW, SE, NW at heights 10, 20 and the middle of the range.
  const n = 3, b = new Uint8Array(88 + 4 + n * 6 + 4 + 6), dv = new DataView(b.buffer);
  dv.setFloat32(24, 10, true); dv.setFloat32(28, 20, true); dv.setUint32(88, n, true);
  const zz = (d: number) => (d << 1) ^ (d >> 31);
  [[0, 32767, 0], [0, 0, 32767], [0, 32767, 16384]].forEach((vals, a) => vals.forEach((v, i) => dv.setUint16(92 + a * n * 2 + i * 2, zz(v - (vals[i - 1] ?? 0)), true)));
  dv.setUint32(110, 1, true); // triangle count; indices 0, 1, 2 are all new, so every code is 0
  for (const bytes of [b, new Uint8Array(gzipSync(b))]) {
    const tile = decodeQuantizedMesh(bytes);
    assert.deepEqual([...tile.indices], [0, 1, 2]);
    assert.deepEqual([...tile.height].map(h => Math.round(h * 1000) / 1000), [10, 20, 15]);
    const s = new TileSampler(tile);
    assert.equal(s.heightAt(32767 / 2, 0), 15);
    assert.equal(s.heightAt(32767, 32767), null);
  }
});
