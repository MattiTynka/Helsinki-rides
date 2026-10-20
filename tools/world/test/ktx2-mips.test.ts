import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dropTopMip, readKtx2Layout } from '../lib/ktx2-mips.ts';

const IDENTIFIER = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];

/** Same layout as the Basis encoder's output: level index, DFD, KVD, then levels smallest first. */
function ktx2(width: number, height: number, levels: Uint8Array[], scheme = 2): Uint8Array {
  const dfd = Buffer.from('DFD-test'), kvd = Buffer.from('KVD-'), dfdOffset = 80 + 24 * levels.length;
  const header = Buffer.alloc(dfdOffset);
  Buffer.from(IDENTIFIER).copy(header);
  [0, 1, width, height, 0, 0, 1, levels.length, scheme].forEach((v, i) => header.writeUInt32LE(v, 12 + 4 * i));
  header.writeUInt32LE(dfdOffset, 48); header.writeUInt32LE(dfd.length, 52);
  header.writeUInt32LE(dfdOffset + dfd.length, 56); header.writeUInt32LE(kvd.length, 60);
  let cursor = dfdOffset + dfd.length + kvd.length;
  for (let level = levels.length - 1; level >= 0; level--) {
    const at = 80 + 24 * level;
    header.writeBigUInt64LE(BigInt(cursor), at); header.writeBigUInt64LE(BigInt(levels[level]!.length), at + 8);
    header.writeBigUInt64LE(BigInt(levels[level]!.length * 4), at + 16);
    cursor += levels[level]!.length;
  }
  return Buffer.concat([header, dfd, kvd, ...[...levels].reverse()]);
}

test('dropping the top mip keeps the descriptors and every smaller level byte for byte', () => {
  const levels = [Buffer.from('largest-level-data'), Buffer.from('middle'), Buffer.from('s')];
  const source = ktx2(1024, 832, levels), before = Buffer.from(source);
  const reduced = dropTopMip(source), layout = readKtx2Layout(reduced);
  assert.deepEqual(Buffer.from(source), before);
  assert.deepEqual([layout.width, layout.height, layout.levelCount], [512, 416, 2]);
  assert.deepEqual(Buffer.from(reduced), Buffer.from(ktx2(512, 416, levels.slice(1))));
  assert.deepEqual(layout.levels.map(l => l.uncompressedByteLength), [24, 4]);
  assert.deepEqual(readKtx2Layout(dropTopMip(reduced)).levels.length, 1);
});

test('textures whose levels are not independent or not packed are refused', () => {
  const levels = [Buffer.from('largest'), Buffer.from('small')];
  assert.throws(() => dropTopMip(ktx2(8, 8, levels, 1)), /Zstandard/);
  assert.throws(() => dropTopMip(ktx2(8, 8, levels.slice(0, 1))), /no smaller mip/);
  assert.throws(() => dropTopMip(Buffer.concat([ktx2(8, 8, levels), Buffer.from([0])])), /trailing/);
  assert.throws(() => dropTopMip(Buffer.from('not a texture at all, just some bytes padding it out to eighty bytes long....')), /Not a KTX2/);
});
