// Keep the original encoded image bytes; only their storage location changes.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFacadeGlb } from './facade-glb.ts';

export interface SharedImage { path: string; bytes: Uint8Array; sha256: string }
const align4 = (n: number) => Math.ceil(n / 4) * 4;

export function packGlb(json: unknown, bin: Uint8Array): Uint8Array {
  const text = Buffer.from(JSON.stringify(json)), padded = Buffer.alloc(align4(text.length), 0x20);
  text.copy(padded);
  const out = Buffer.alloc(28 + padded.length + align4(bin.length));
  out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(out.length, 8);
  out.writeUInt32LE(padded.length, 12); out.writeUInt32LE(0x4e4f534a, 16); padded.copy(out, 20);
  out.writeUInt32LE(align4(bin.length), 20 + padded.length); out.writeUInt32LE(0x004e4942, 24 + padded.length);
  Buffer.from(bin).copy(out, 28 + padded.length);
  return out;
}

/** Caller compacts this GLB afterwards to remove the now-unreferenced embedded images. */
export function externalizeCellImages(bytes: Uint8Array): { bytes: Uint8Array; images: SharedImage[] } {
  const original = readFacadeGlb(bytes), json = structuredClone(original.json), images: SharedImage[] = [];
  for (const image of json.images ?? []) {
    const item = image as typeof image & { uri?: string };
    if (item.uri !== undefined) {
      assert.match(item.uri, /^\.\.\/textures\/[0-9a-f]{64}\.(?:ktx2|png)$/);
      continue;
    }
    assert.ok(Number.isInteger(image.bufferView), 'Cell image must be embedded');
    const view = json.bufferViews[image.bufferView!]!;
    assert.ok(view?.buffer === 0 && !view.extensions, 'Cell image requires a plain physical buffer view');
    const offset = view.byteOffset ?? 0;
    assert.ok(offset >= 0 && view.byteLength > 0 && offset + view.byteLength <= original.bin.length);
    assert.ok(image.mimeType === 'image/ktx2' || image.mimeType === 'image/png', 'Unsupported shared texture format');
    const payload = new Uint8Array(original.bin.subarray(offset, offset + view.byteLength)), sha256 = createHash('sha256').update(payload).digest('hex');
    const suffix = image.mimeType === 'image/ktx2' ? 'ktx2' : 'png', path = `textures/${sha256}.${suffix}`;
    item.uri = `../${path}`; delete item.bufferView;
    images.push({ path, bytes: payload, sha256 });
  }
  return { bytes: images.length ? packGlb(json, original.bin) : bytes.slice(), images };
}
