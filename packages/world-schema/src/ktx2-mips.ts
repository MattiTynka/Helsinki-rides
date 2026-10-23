// Browser-safe KTX2 mip-level surgery (AC-9): drop a texture's largest mip levels without re-encoding, so every
// remaining level keeps its exact stored bytes. Same layout rules as tools/world/lib/ktx2-mips.ts, but plain Errors and
// DataView reads only, with every offset and length checked against the buffer (the input is a fetched file).

const IDENTIFIER = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const HEADER_BYTES = 80;
const LEVEL_ENTRY_BYTES = 24;
export const KTX2_SUPERCOMPRESSION_ZSTANDARD = 2;

export interface Ktx2Level { byteOffset: number; byteLength: number; uncompressedByteLength: number }
export interface Ktx2Layout {
  width: number; height: number; levelCount: number; supercompression: number;
  dfd: [number, number]; kvd: [number, number]; levels: Ktx2Level[];
}

function fail(message: string): never { throw new Error(message); }

/** KTX2 stores 64-bit offsets; anything a browser can hold fits in the low 32 bits. */
function u64(view: DataView, at: number): number {
  if (view.getUint32(at + 4, true) !== 0) fail('KTX2 offset or length out of range');
  return view.getUint32(at, true);
}

function viewOf(bytes: Uint8Array): DataView { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); }

function within(offset: number, length: number, total: number): boolean { return offset <= total && length <= total - offset; }

export function readKtx2Layout(bytes: Uint8Array): Ktx2Layout {
  if (bytes.byteLength < HEADER_BYTES || IDENTIFIER.some((value, i) => bytes[i] !== value)) fail('Not a KTX2 file');
  const view = viewOf(bytes), total = bytes.byteLength;
  const levelCount = view.getUint32(40, true);
  if (levelCount < 1 || levelCount > 32 || !within(HEADER_BYTES, LEVEL_ENTRY_BYTES * levelCount, total)) fail('Invalid KTX2 level index');
  const levels: Ktx2Level[] = [];
  for (let i = 0; i < levelCount; i++) {
    const at = HEADER_BYTES + LEVEL_ENTRY_BYTES * i;
    const level = { byteOffset: u64(view, at), byteLength: u64(view, at + 8), uncompressedByteLength: u64(view, at + 16) };
    if (!within(level.byteOffset, level.byteLength, total)) fail('KTX2 level outside the file');
    levels.push(level);
  }
  const dfd: [number, number] = [view.getUint32(48, true), view.getUint32(52, true)];
  const kvd: [number, number] = [view.getUint32(56, true), view.getUint32(60, true)];
  if (!within(dfd[0], dfd[1], total) || !within(kvd[0], kvd[1], total)) fail('KTX2 descriptor outside the file');
  return { width: view.getUint32(20, true), height: view.getUint32(24, true), levelCount, supercompression: view.getUint32(44, true), dfd, kvd, levels };
}

/**
 * Accepts only the layout the city textures use: a single 2D Zstandard-supercompressed image (UASTC), level index,
 * DFD, KVD and level data packed back to back with the smallest level first. Level 0 is then the file's tail, so
 * the result is the same header for one fewer level, followed by the source's DFD, KVD and level 1..n-1 bytes.
 */
function dropTopMip(bytes: Uint8Array): Uint8Array {
  const layout = readKtx2Layout(bytes), view = viewOf(bytes), n = layout.levelCount;
  if (layout.supercompression !== KTX2_SUPERCOMPRESSION_ZSTANDARD) fail('Only Zstandard-supercompressed KTX2 levels are independent');
  if (n < 2) fail('Texture has no smaller mip level');
  if (layout.width < 1 || layout.height < 1 || view.getUint32(28, true) !== 0 || view.getUint32(32, true) !== 0 || view.getUint32(36, true) !== 1) {
    fail('Only single 2D images are supported');
  }
  if (u64(view, 64) !== 0 || u64(view, 72) !== 0) fail('Zstandard KTX2 must not carry global data');
  const [dfdOffset, dfdLength] = layout.dfd, [kvdOffset, kvdLength] = layout.kvd;
  if (dfdOffset !== HEADER_BYTES + LEVEL_ENTRY_BYTES * n || dfdLength % 4 !== 0 || (kvdLength !== 0 && kvdOffset !== dfdOffset + dfdLength)) {
    fail('Unexpected KTX2 descriptor layout');
  }
  let cursor = dfdOffset + dfdLength + kvdLength;
  for (let level = n - 1; level >= 0; level--) {
    const entry = layout.levels[level]!;
    if (entry.byteOffset !== cursor || entry.byteLength <= 0) fail('KTX2 levels must be packed smallest first');
    cursor += entry.byteLength;
  }
  if (cursor !== bytes.byteLength) fail('KTX2 file has trailing bytes');
  const shift = LEVEL_ENTRY_BYTES, top = layout.levels[0]!;
  const out = new Uint8Array(bytes.byteLength - shift - top.byteLength), write = viewOf(out);
  out.set(bytes.subarray(0, HEADER_BYTES));
  write.setUint32(20, Math.max(1, layout.width >> 1), true);
  write.setUint32(24, Math.max(1, layout.height >> 1), true);
  write.setUint32(40, n - 1, true);
  write.setUint32(48, dfdOffset - shift, true);
  write.setUint32(56, kvdLength ? kvdOffset - shift : 0, true);
  for (let level = 1; level < n; level++) {
    const entry = layout.levels[level]!, at = HEADER_BYTES + LEVEL_ENTRY_BYTES * (level - 1);
    write.setUint32(at, entry.byteOffset - shift, true); write.setUint32(at + 4, 0, true);
    write.setUint32(at + 8, entry.byteLength, true); write.setUint32(at + 12, 0, true);
    write.setUint32(at + 16, entry.uncompressedByteLength, true); write.setUint32(at + 20, 0, true);
  }
  out.set(bytes.subarray(dfdOffset, top.byteOffset), dfdOffset - shift);
  return out;
}

/** Drops the `n` largest mip levels; `n = 0` returns the input itself. Throws when the layout does not qualify. */
export function dropTopMips(bytes: Uint8Array, n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0) fail('Mip drop count must be a non-negative integer');
  let out = bytes;
  for (let i = 0; i < n; i++) out = dropTopMip(out);
  return out;
}
