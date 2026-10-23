import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dropTopMips, readKtx2Layout } from '../src/ktx2-mips.ts';
// The asset tool is the reference implementation; it is imported by this test only (it needs node:assert and Buffer).
import { dropTopMip } from '../../../tools/world/lib/ktx2-mips.ts';

const IDENTIFIER = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];

/** The Basis encoder's UASTC layout: header, level index, DFD, KVD, then levels smallest first. */
function container(width: number, height: number, levelCount: number, options: { scheme?: number; depth?: number; layers?: number; faces?: number } = {}): Uint8Array {
  const levels = Array.from({ length: levelCount }, (_, level) => {
    const bytes = new Uint8Array(Math.max(3, 40 >> level) + level);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (level * 37 + i * 11) & 0xff;
    return bytes;
  });
  const dfd = new Uint8Array(44).map((_, i) => 0x40 + i), kvd = new TextEncoder().encode('\u0012\u0000\u0000\u0000KTXwriter\u0000test\u0000\u0000\u0000');
  const dfdOffset = 80 + 24 * levelCount, total = dfdOffset + dfd.length + kvd.length + levels.reduce((sum, l) => sum + l.length, 0);
  const bytes = new Uint8Array(total), view = new DataView(bytes.buffer);
  bytes.set(IDENTIFIER);
  [0, 1, width, height, options.depth ?? 0, options.layers ?? 0, options.faces ?? 1, levelCount, options.scheme ?? 2].forEach((v, i) => view.setUint32(12 + 4 * i, v, true));
  view.setUint32(48, dfdOffset, true); view.setUint32(52, dfd.length, true);
  view.setUint32(56, dfdOffset + dfd.length, true); view.setUint32(60, kvd.length, true);
  bytes.set(dfd, dfdOffset); bytes.set(kvd, dfdOffset + dfd.length);
  let cursor = dfdOffset + dfd.length + kvd.length;
  for (let level = levelCount - 1; level >= 0; level--) {
    const at = 80 + 24 * level, data = levels[level]!;
    view.setUint32(at, cursor, true); view.setUint32(at + 8, data.length, true); view.setUint32(at + 16, data.length * 4, true);
    bytes.set(data, cursor); cursor += data.length;
  }
  return bytes;
}

const same = (a: Uint8Array, b: Uint8Array) => assert.deepEqual(Array.from(a), Array.from(b));

test('dropTopMips equals the asset tool byte for byte, once and twice, for 3 to 5 levels', () => {
  for (const [width, height, levels] of [[256, 256, 3], [1024, 832, 4], [2048, 1920, 5], [300, 150, 5]] as const) {
    const source = container(width, height, levels), before = source.slice();
    const once = dropTopMips(source, 1), twice = dropTopMips(source, 2);
    same(once, dropTopMip(source));
    same(twice, dropTopMip(dropTopMip(source)));
    same(source, before);
    const layout = readKtx2Layout(twice);
    assert.deepEqual([layout.width, layout.height, layout.levelCount], [width >> 2, height >> 2, levels - 2]);
  }
  const subview = new Uint8Array(512);
  const inner = container(128, 64, 3);
  subview.set(inner, 7);
  same(dropTopMips(subview.subarray(7, 7 + inner.length), 1), dropTopMip(inner));
});

test('n = 0 returns the input itself and n must be a non-negative integer', () => {
  const source = container(256, 256, 3);
  assert.equal(dropTopMips(source, 0), source);
  for (const n of [-1, .5, Number.NaN]) assert.throws(() => dropTopMips(source, n), /non-negative integer/);
  assert.throws(() => dropTopMips(source, 3), /no smaller mip/);
});

test('rejects BasisLZ, global data, non-2D images, trailing bytes and truncated or out-of-range indexes', () => {
  assert.throws(() => dropTopMips(container(256, 256, 3, { scheme: 1 }), 1), /Zstandard/);
  assert.throws(() => dropTopMips(container(256, 256, 3, { scheme: 0 }), 1), /Zstandard/);
  assert.throws(() => dropTopMips(withGlobalData(container(256, 256, 3)), 1), /global data/);
  for (const shape of [{ depth: 4 }, { layers: 2 }, { faces: 6 }]) assert.throws(() => dropTopMips(container(256, 256, 3, shape), 1), /single 2D/);
  assert.throws(() => dropTopMips(container(256, 0, 3), 1), /single 2D/);
  const trailing = new Uint8Array(container(256, 256, 3).length + 1); trailing.set(container(256, 256, 3));
  assert.throws(() => dropTopMips(trailing, 1), /trailing/);
  const full = container(256, 256, 4);
  assert.throws(() => dropTopMips(full.subarray(0, 79), 1), /Not a KTX2/);
  assert.throws(() => dropTopMips(full.subarray(0, 80 + 24 * 3), 1), /level index/);
  assert.throws(() => dropTopMips(full.subarray(0, full.length - 5), 1), /outside the file/);
  const huge = full.slice(); new DataView(huge.buffer).setUint32(80 + 4, 1, true);
  assert.throws(() => dropTopMips(huge, 1), /out of range/);
  const scrambled = full.slice(), view = new DataView(scrambled.buffer);
  const [a, b] = [view.getUint32(80, true), view.getUint32(104, true)];
  view.setUint32(80, b, true); view.setUint32(104, a, true);
  assert.throws(() => dropTopMips(scrambled, 1), /packed smallest first/);
  assert.throws(() => readKtx2Layout(new TextEncoder().encode('x'.repeat(96))), /Not a KTX2/);
});

/** A BasisLZ-style supercompression global data block (here on an otherwise Zstandard container). */
function withGlobalData(bytes: Uint8Array): Uint8Array {
  const out = bytes.slice(), view = new DataView(out.buffer);
  view.setUint32(64, 80, true); view.setUint32(72, 16, true);
  return out;
}
