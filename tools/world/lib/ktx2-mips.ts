// Drop a KTX2 texture's largest mip level without re-encoding: every remaining level keeps its exact stored bytes.
import assert from 'node:assert/strict';

const IDENTIFIER = Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
const ZSTANDARD = 2;

export interface Ktx2Level { byteOffset: number; byteLength: number; uncompressedByteLength: number }
export interface Ktx2Layout {
  width: number; height: number; levelCount: number; supercompression: number;
  dfd: [number, number]; kvd: [number, number]; levels: Ktx2Level[];
}

export function readKtx2Layout(bytes: Uint8Array): Ktx2Layout {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.ok(b.length >= 80 && b.subarray(0, 12).equals(IDENTIFIER), 'Not a KTX2 file');
  const levelCount = b.readUInt32LE(40), levels: Ktx2Level[] = [];
  assert.ok(levelCount >= 1 && b.length >= 80 + 24 * levelCount, 'Invalid KTX2 level index');
  for (let i = 0; i < levelCount; i++) {
    const at = 80 + 24 * i;
    levels.push({ byteOffset: Number(b.readBigUInt64LE(at)), byteLength: Number(b.readBigUInt64LE(at + 8)), uncompressedByteLength: Number(b.readBigUInt64LE(at + 16)) });
  }
  return {
    width: b.readUInt32LE(20), height: b.readUInt32LE(24), levelCount, supercompression: b.readUInt32LE(44),
    dfd: [b.readUInt32LE(48), b.readUInt32LE(52)], kvd: [b.readUInt32LE(56), b.readUInt32LE(60)], levels,
  };
}

/**
 * Accepts only the layout the city textures use: a single 2D Zstandard-supercompressed image (UASTC), level index,
 * DFD, KVD and level data packed back to back with the smallest level first. Level 0 is then the file's tail, so
 * the result is the same header for one fewer level, followed by the source's DFD, KVD and level 1..n-1 bytes.
 */
export function dropTopMip(bytes: Uint8Array): Uint8Array {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), layout = readKtx2Layout(b), n = layout.levelCount;
  assert.equal(layout.supercompression, ZSTANDARD, 'Only Zstandard-supercompressed KTX2 levels are independent');
  assert.ok(n >= 2, 'Texture has no smaller mip level');
  assert.ok(b.readUInt32LE(28) === 0 && b.readUInt32LE(32) === 0 && b.readUInt32LE(36) === 1, 'Only single 2D images are supported');
  assert.ok(b.readBigUInt64LE(64) === 0n && b.readBigUInt64LE(72) === 0n, 'Zstandard KTX2 must not carry global data');
  const [dfdOffset, dfdLength] = layout.dfd, [kvdOffset, kvdLength] = layout.kvd;
  assert.ok(dfdOffset === 80 + 24 * n && dfdLength % 4 === 0 && (kvdLength === 0 || kvdOffset === dfdOffset + dfdLength), 'Unexpected KTX2 descriptor layout');
  let cursor = dfdOffset + dfdLength + kvdLength;
  for (let level = n - 1; level >= 0; level--) {
    const entry = layout.levels[level]!;
    assert.ok(entry.byteOffset === cursor && entry.byteLength > 0, 'KTX2 levels must be packed smallest first');
    cursor += entry.byteLength;
  }
  assert.equal(cursor, b.length, 'KTX2 file has trailing bytes');
  const shift = 24, top = layout.levels[0]!;
  const out = Buffer.alloc(b.length - shift - top.byteLength);
  b.copy(out, 0, 0, 80);
  out.writeUInt32LE(Math.max(1, layout.width >> 1), 20);
  out.writeUInt32LE(Math.max(1, layout.height >> 1), 24);
  out.writeUInt32LE(n - 1, 40);
  out.writeUInt32LE(dfdOffset - shift, 48);
  out.writeUInt32LE(kvdLength ? kvdOffset - shift : 0, 56);
  for (let level = 1; level < n; level++) {
    const entry = layout.levels[level]!, at = 80 + 24 * (level - 1);
    out.writeBigUInt64LE(BigInt(entry.byteOffset - shift), at);
    out.writeBigUInt64LE(BigInt(entry.byteLength), at + 8);
    out.writeBigUInt64LE(BigInt(entry.uncompressedByteLength), at + 16);
  }
  b.copy(out, dfdOffset - shift, dfdOffset, top.byteOffset);
  assertSameLevels(b, out);
  return out;
}

/** Every level of `reduced` is the next larger level index of `source`, byte for byte. */
export function assertSameLevels(source: Uint8Array, reduced: Uint8Array): void {
  const a = readKtx2Layout(source), r = readKtx2Layout(reduced);
  assert.equal(r.levelCount, a.levelCount - 1);
  assert.deepEqual([r.width, r.height], [Math.max(1, a.width >> 1), Math.max(1, a.height >> 1)]);
  assert.equal(r.supercompression, a.supercompression);
  assert.deepEqual(Buffer.from(reduced.subarray(12, 20)), Buffer.from(source.subarray(12, 20)), 'Format changed');
  assert.deepEqual(Buffer.from(reduced.subarray(r.dfd[0], r.dfd[0] + r.dfd[1])), Buffer.from(source.subarray(a.dfd[0], a.dfd[0] + a.dfd[1])), 'DFD changed');
  assert.deepEqual(Buffer.from(reduced.subarray(r.kvd[0], r.kvd[0] + r.kvd[1])), Buffer.from(source.subarray(a.kvd[0], a.kvd[0] + a.kvd[1])), 'KVD changed');
  for (let level = 0; level < r.levelCount; level++) {
    const x = r.levels[level]!, y = a.levels[level + 1]!;
    assert.equal(x.uncompressedByteLength, y.uncompressedByteLength);
    assert.ok(Buffer.from(reduced.subarray(x.byteOffset, x.byteOffset + x.byteLength)).equals(Buffer.from(source.subarray(y.byteOffset, y.byteOffset + y.byteLength))), `Mip level ${level + 1} changed`);
  }
}
