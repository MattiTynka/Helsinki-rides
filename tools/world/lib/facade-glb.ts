// Replace embedded image byte ranges while retaining every geometry/compression payload byte. Serializing a
// glTF-Transform Document would needlessly recompress this frozen ground/building candidate.
import assert from 'node:assert/strict';
export interface FacadeGlbJson {
  buffers: { byteLength: number; uri?: string }[];
  bufferViews: { buffer: number; byteOffset?: number; byteLength: number; extensions?: { EXT_meshopt_compression?: { buffer: number; byteOffset?: number; byteLength: number } } }[];
  images?: { name?: string; bufferView?: number; mimeType?: string }[];
  [key: string]: unknown;
}
const aligned = (n: number) => (n + 3) & ~3;
export function readFacadeGlb(bytes: Uint8Array): { json: FacadeGlbJson; bin: Uint8Array } {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.readUInt32LE(0) !== 0x46546c67 || b.readUInt32LE(4) !== 2 || b.readUInt32LE(8) !== b.length || b.readUInt32LE(16) !== 0x4e4f534a) throw new Error('invalid GLB header');
  const n = b.readUInt32LE(12), offset = 20 + n;
  if (b.readUInt32LE(offset + 4) !== 0x004e4942 || offset + 8 + b.readUInt32LE(offset) !== b.length) throw new Error('invalid GLB BIN chunk');
  const json = JSON.parse(b.subarray(20, offset).toString('utf8')) as FacadeGlbJson;
  return { json, bin: b.subarray(offset + 8, offset + 8 + json.buffers[0]!.byteLength) };
}
export function replaceFacadeImages(bytes: Uint8Array, replacements: ReadonlyMap<number, Uint8Array>): Uint8Array {
  const original = readFacadeGlb(bytes), json = structuredClone(original.json);
  const ranges = [...replacements].map(([image, data]) => {
    const bv = json.images?.[image]?.bufferView;
    if (bv === undefined || json.bufferViews[bv]?.buffer !== 0) throw new Error(`image${image} is not embedded in physical buffer0`);
    const view = json.bufferViews[bv]!;
    return { bv, start: view.byteOffset ?? 0, end: aligned((view.byteOffset ?? 0) + view.byteLength), data };
  }).sort((a, b) => a.start - b.start);
  for (let i = 0; i < ranges.length; i++) if (ranges[i]!.end > original.bin.length || (i && ranges[i - 1]!.end > ranges[i]!.start)) throw new Error('overlapping or invalid image payload ranges');
  const remap = (offset: number) => offset + ranges.reduce((delta, r) => delta + (offset >= r.end ? aligned(r.data.length) - (r.end - r.start) : 0), 0);
  const pieces: Uint8Array[] = [];
  let cursor = 0;
  for (const r of ranges) { pieces.push(original.bin.subarray(cursor, r.start), r.data, new Uint8Array(aligned(r.data.length) - r.data.length)); cursor = r.end; }
  pieces.push(original.bin.subarray(cursor));
  const bin = Buffer.concat(pieces), replaced = new Set(ranges.map(r => r.bv));
  for (let i = 0; i < json.bufferViews.length; i++) {
    const view = json.bufferViews[i]!, old = original.json.bufferViews[i]!;
    if (view.buffer === 0) {
      const offset = old.byteOffset ?? 0;
      if (!replaced.has(i) && ranges.some(r => offset < r.end && offset + old.byteLength > r.start)) throw new Error('image range aliases a non-image buffer view');
      view.byteOffset = remap(offset);
      if (replaced.has(i)) view.byteLength = ranges.find(r => r.bv === i)!.data.length;
    }
    const compression = view.extensions?.EXT_meshopt_compression;
    if (compression?.buffer === 0) compression.byteOffset = remap(compression.byteOffset ?? 0);
  }
  json.buffers[0]!.byteLength = bin.length;
  const text = Buffer.from(JSON.stringify(json)), padded = Buffer.alloc(aligned(text.length), 0x20); text.copy(padded);
  const out = Buffer.alloc(12 + 8 + padded.length + 8 + aligned(bin.length));
  out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(padded.length, 12); out.writeUInt32LE(0x4e4f534a, 16); padded.copy(out, 20);
  out.writeUInt32LE(aligned(bin.length), 20 + padded.length); out.writeUInt32LE(0x004e4942, 24 + padded.length); bin.copy(out, 28 + padded.length);
  const result = readFacadeGlb(out);
  for (let i = 0; i < json.bufferViews.length; i++) {
    if (replaced.has(i)) continue;
    const old = original.json.bufferViews[i]!, next = result.json.bufferViews[i]!;
    if (old.buffer === 0) assert.deepEqual(result.bin.subarray(next.byteOffset ?? 0, (next.byteOffset ?? 0) + next.byteLength), original.bin.subarray(old.byteOffset ?? 0, (old.byteOffset ?? 0) + old.byteLength), `non-image view${i} changed`);
    const before = old.extensions?.EXT_meshopt_compression, after = next.extensions?.EXT_meshopt_compression;
    if (before?.buffer === 0 && after) assert.deepEqual(result.bin.subarray(after.byteOffset ?? 0, (after.byteOffset ?? 0) + after.byteLength), original.bin.subarray(before.byteOffset ?? 0, (before.byteOffset ?? 0) + before.byteLength), `compressed view${i} changed`);
  }
  const normalize = (j: FacadeGlbJson) => {
    const q = structuredClone(j); q.buffers[0]!.byteLength = 0;
    for (let i = 0; i < q.bufferViews.length; i++) {
      const view = q.bufferViews[i]!;
      if (view.buffer === 0) view.byteOffset = 0;
      if (replaced.has(i)) view.byteLength = 0;
      const compression = view.extensions?.EXT_meshopt_compression;
      if (compression?.buffer === 0) compression.byteOffset = 0;
    }
    return q;
  };
  assert.deepEqual(normalize(result.json), normalize(original.json), 'non-image GLB semantics changed');
  return out;
}
