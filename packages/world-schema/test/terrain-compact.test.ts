import assert from 'node:assert/strict';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { encodeCompactTerrain, encodeTerrain, parseTerrain, sampleTerrain } from '../src/terrain.ts';
test('compact terrain preserves every Float32 bit and bilinear query, including signed zero', () => {
    const bits = new Uint32Array([0, 0x80000000, 0x3f800001, 0xbf800001, 0x3f000000, 0x00000001, 0x7f7fffff, 0x00800000, 0xc1a00000, 0x3eaaaaab, 0x42280000, 0x40a00000]);
    const source = { x0: -128, z0: -64, resolution: 1, nx: 4, nz: 3, heights: new Float32Array(bits.buffer) };
    const compact = encodeCompactTerrain(source), decoded = parseTerrain(compact);
    assert.deepEqual(new Uint32Array(decoded.heights.buffer), bits);
    assert.deepEqual(encodeTerrain(decoded), encodeTerrain(source));
    for (const [x, z] of [[-128, -64], [-127.3, -63.4], [1000, 1000], [-1000, -1000]])
        assert.equal(sampleTerrain(decoded, x!, z!), sampleTerrain(source, x!, z!));
});
test('aligned v1 terrain shares pinned input storage; unaligned terrain copies once and stays correct', () => {
    const source = { x0: 0, z0: 0, resolution: 1, nx: 2, nz: 2, heights: new Float32Array([1, 2, 3, 4]) };
    const bytes = encodeTerrain(source), decoded = parseTerrain(bytes, { copy: false });
    assert.equal(decoded.heights.buffer, bytes.buffer);
    assert.equal(decoded.heights.byteOffset, bytes.byteOffset + 28);
    const unaligned = new Uint8Array(bytes.length + 1);
    unaligned.set(bytes, 1);
    const copied = parseTerrain(unaligned.subarray(1));
    assert.notEqual(copied.heights.buffer, unaligned.buffer);
    assert.deepEqual(copied.heights, source.heights);
    const authoring = parseTerrain(bytes);
    assert.equal(authoring.heights.byteOffset, 0);
    assert.notEqual(authoring.heights.buffer, bytes.buffer);
    authoring.heights[0] = 99;
    assert.equal(decoded.heights[0], 1, 'Authoring mutations must not alter pinned input bytes');
});
test('compact grid exploits repeated neighbouring heights without changing decoded values', () => {
    const nx = 80, nz = 80, heights = Float32Array.from({ length: nx * nz }, (_, i) => Math.fround(3 + Math.sin(i % nx / 15) + Math.floor(i / nx) / 100));
    const source = { x0: -30, z0: 20, resolution: 1, nx, nz, heights };
    const old = encodeTerrain(source), compact = encodeCompactTerrain(source);
    assert.ok(gzipSync(compact).length < gzipSync(old).length * .8);
    assert.deepEqual(encodeTerrain(parseTerrain(compact)), old);
});
test('terrain rejects truncated, excessive, trailing and invalid-coordinate inputs before allocation', () => {
    const bytes = encodeTerrain({ x0: 0, z0: 0, resolution: 1, nx: 2, nz: 2, heights: new Float32Array(4) });
    assert.throws(() => parseTerrain(bytes.subarray(0, 20)), /truncated/);
    assert.throws(() => parseTerrain(bytes.subarray(0, 40)), /byte length/);
    assert.throws(() => parseTerrain(new Uint8Array(bytes.length + 4)), /not an HTER/);
    for (const [offset, value] of [[20, 0xffffffff], [24, 0xffffffff]]) {
        const malformed = bytes.slice();
        new DataView(malformed.buffer).setUint32(offset!, value!, true);
        assert.throws(() => parseTerrain(malformed), /count or byte length/);
    }
    const malformed = bytes.slice();
    new DataView(malformed.buffer).setFloat32(16, NaN, true);
    assert.throws(() => parseTerrain(malformed), /coordinates/);
});
