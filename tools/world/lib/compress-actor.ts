/** Lossless storage compression for already accepted actors; no model or animation transforms. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {MeshoptDecoder, MeshoptEncoder} from 'meshoptimizer';
import {readFacadeGlb} from './facade-glb.ts';
import {compactGlb} from './compact-glb.ts';

type Json = Record<string, any>;
const align4 = (n: number) => Math.ceil(n / 4) * 4;
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const componentBytes: Record<number, number> = {5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4};
const elementComponents: Record<string, number> = {SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16};

export interface ActorCompressionReceipt {
  applied: boolean;
  reason: 'compressed' | 'already-compressed' | 'no-smaller-representation';
  originalBytes: number;
  compressedBytes: number;
  savedBytes: number;
  originalSha256: string;
  compressedSha256: string;
  /** Includes every original JSON definition and the exact decoded bytes of every original view. */
  semanticSha256: string;
  compressedViews: number;
  preservedViews: number;
  accessorCount: number;
  animationCount: number;
  skinCount: number;
  nodeCount: number;
  images: {index: number; sha256?: string; uri?: string}[];
}

/**
 * Encodes physical buffer views with raw Meshopt (no quantization, filters, reordering, pruning,
 * resampling or NodeIO serialization). INDICES preserves the precise index sequence; TRIANGLES
 * would be allowed to rotate triangles. Every encoded view is decoded and compared byte for byte
 * before it is accepted. Every original node, accessor, material, clip, socket and extras object
 * remains at the same array index. Returns an independent original copy unless the entire GLB is
 * smaller after the extra extension metadata is included.
 */
export async function compressActor(bytes: Uint8Array): Promise<{bytes: Uint8Array; receipt: ActorCompressionReceipt}> {
  await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready]);
  // Reuse the publication helper's conservative extension/URI contract. This output is deliberately
  // discarded: actor resource arrays must not be pruned or reordered.
  compactGlb(bytes);
  const source = readFacadeGlb(bytes), original = source.json as Json;
  const originalHash = sha(bytes), originalSemantic = JSON.stringify(original);
  const imageReceipts: ActorCompressionReceipt['images'] = (original.images ?? []).map((image: any, index: number) => image.uri !== undefined
    ? {index, uri: image.uri}
    : {index, sha256: sha(viewBytes(original.bufferViews[image.bufferView], source.bin))});
  const decodedViewHashes = (original.bufferViews ?? []).map((view: any) => view.extensions?.EXT_meshopt_compression
    ? null : sha(viewBytes(view, source.bin)));
  const semanticSha256 = sha(JSON.stringify({json: original, bufferViews: decodedViewHashes}));
  const baseReceipt = {
    originalBytes: bytes.length, originalSha256: originalHash, semanticSha256,
    accessorCount: original.accessors?.length ?? 0, animationCount: original.animations?.length ?? 0,
    skinCount: original.skins?.length ?? 0, nodeCount: original.nodes?.length ?? 0, images: imageReceipts,
  };
  const unchanged = (reason: ActorCompressionReceipt['reason']) => ({bytes: bytes.slice(), receipt: {
    ...baseReceipt, applied: false, reason, compressedBytes: bytes.length, savedBytes: 0,
    compressedSha256: originalHash, compressedViews: 0, preservedViews: original.bufferViews?.length ?? 0,
  }});
  if ((original.bufferViews ?? []).some((view: any) => view.extensions?.EXT_meshopt_compression)) return unchanged('already-compressed');
  assert.equal(original.buffers.length, 1, 'Uncompressed actors must have one embedded physical buffer');
  assert.equal(original.buffers[0].uri, undefined, 'External actor buffers are unsupported');
  const json = structuredClone(original), imageViews = new Set<number>((json.images ?? []).flatMap((image: any) => image.bufferView === undefined ? [] : [image.bufferView]));
  const accessorsByView = new Map<number, Json[]>();
  for (const accessor of original.accessors ?? []) if (accessor.bufferView !== undefined) {
    const group = accessorsByView.get(accessor.bufferView) ?? []; group.push(accessor); accessorsByView.set(accessor.bufferView, group);
  }
  const physical: Uint8Array[] = [];
  let physicalOffset = 0, logicalOffset = 0, compressedViews = 0;
  const virtualBuffer = 1;
  for (const [i, view] of json.bufferViews.entries()) {
    const raw = viewBytes(original.bufferViews[i], source.bin);
    const accessors = accessorsByView.get(i) ?? [];
    const indexSizes = new Set(accessors.map(accessor => componentBytes[accessor.componentType]));
    const indexMode = view.target === 34963 && indexSizes.size === 1 && [2, 4].includes([...indexSizes][0]!);
    const strides = new Set(accessors.map(accessor => (componentBytes[accessor.componentType] ?? 0) * (elementComponents[accessor.type] ?? 0)));
    const naturalStride = strides.size === 1 ? [...strides][0]! : 4;
    const stride = indexMode ? [...indexSizes][0]! : view.byteStride ?? (naturalStride > 0 && naturalStride % 4 === 0 && naturalStride <= 256 ? naturalStride : 4);
    let encoded: Uint8Array | undefined, decoded: Uint8Array | undefined;
    const mode = indexMode ? 'INDICES' : 'ATTRIBUTES';
    // Sparse index/value views are left unchanged unless also normal accessor views. No custom
    // extension payload or embedded image is interpreted as vertex/animation data.
    if (!imageViews.has(i) && accessors.length && raw.length && (view.target !== 34963 || indexMode) && stride > 0 && stride <= 256 && (indexMode || stride % 4 === 0)) {
      const count = Math.ceil(raw.length / stride), padded = new Uint8Array(count * stride); padded.set(raw);
      const candidate = MeshoptEncoder.encodeGltfBuffer(padded, count, stride, mode);
      const extension = {buffer: 0, byteOffset: physicalOffset, byteLength: candidate.length, byteStride: stride, count, mode};
      if (align4(candidate.length) + JSON.stringify(extension).length + 45 < align4(raw.length)) {
        decoded = new Uint8Array(padded.length);
        MeshoptDecoder.decodeGltfBuffer(decoded, count, stride, candidate, mode);
        assert.deepEqual(decoded, padded, `Actor view ${i} changed under Meshopt encoding`);
        encoded = candidate;
        view.buffer = virtualBuffer; view.byteOffset = logicalOffset; view.byteLength = padded.length;
        (view.extensions ??= {}).EXT_meshopt_compression = extension;
        logicalOffset += align4(padded.length); compressedViews++;
      }
    }
    const stored = encoded ?? raw;
    if (!encoded) { view.buffer = 0; view.byteOffset = physicalOffset; }
    physical.push(stored, new Uint8Array(align4(stored.length) - stored.length));
    physicalOffset += align4(stored.length);
    assert.equal(sha((decoded ?? raw).subarray(0, raw.length)), decodedViewHashes[i], `Actor view ${i} decoded payload changed`);
  }
  if (!compressedViews) return unchanged('no-smaller-representation');
  json.buffers[0].byteLength = physicalOffset;
  json.buffers.push({byteLength: logicalOffset, extensions: {EXT_meshopt_compression: {fallback: true}}});
  for (const key of ['extensionsUsed', 'extensionsRequired']) if (!(json[key] ?? []).includes('EXT_meshopt_compression')) (json[key] ??= []).push('EXT_meshopt_compression');
  const bin = Buffer.concat(physical);
  assert.equal(bin.length, physicalOffset);
  const normalized = structuredClone(json);
  normalized.buffers = structuredClone(original.buffers);
  for (const key of ['extensionsUsed', 'extensionsRequired']) {
    if (original[key] === undefined) delete normalized[key]; else normalized[key] = structuredClone(original[key]);
  }
  for (const [i, view] of normalized.bufferViews.entries()) {
    const old = original.bufferViews[i];
    view.buffer = old.buffer; view.byteLength = old.byteLength;
    if (old.byteOffset === undefined) delete view.byteOffset; else view.byteOffset = old.byteOffset;
    if (old.extensions === undefined) delete view.extensions; else view.extensions = structuredClone(old.extensions);
  }
  assert.deepEqual(normalized, original, 'Actor JSON semantics changed');
  assert.equal(JSON.stringify(original), originalSemantic, 'Source actor JSON was mutated');
  const output = pack(json, bin);
  if (output.length >= bytes.length) return unchanged('no-smaller-representation');
  const parsed = readFacadeGlb(output);
  for (const [i, view] of (parsed.json.bufferViews as Json[]).entries()) {
    const compression = view.extensions?.EXT_meshopt_compression;
    let raw: Uint8Array;
    if (compression) {
      raw = new Uint8Array(compression.count * compression.byteStride);
      MeshoptDecoder.decodeGltfBuffer(raw, compression.count, compression.byteStride,
        parsed.bin.subarray(compression.byteOffset, compression.byteOffset + compression.byteLength), compression.mode);
      raw = raw.subarray(0, original.bufferViews[i].byteLength);
    } else raw = viewBytes(view, parsed.bin);
    assert.equal(sha(raw), decodedViewHashes[i], `Written actor view ${i} differs from original`);
  }
  for (const image of imageReceipts) if (image.sha256) assert.equal(sha(viewBytes(parsed.json.bufferViews[(parsed.json.images![image.index]!).bufferView!]!, parsed.bin)), image.sha256, `Actor image ${image.index} changed`);
  return {bytes: output, receipt: {
    ...baseReceipt, applied: true, reason: 'compressed', compressedBytes: output.length, savedBytes: bytes.length - output.length,
    compressedSha256: sha(output), compressedViews, preservedViews: json.bufferViews.length - compressedViews,
  }};
}

function viewBytes(view: Json, bin: Uint8Array): Uint8Array {
  assert.ok(view && view.buffer === 0, 'Actor view must reference the physical buffer');
  const offset = view.byteOffset ?? 0;
  assert.ok(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(view.byteLength) && view.byteLength >= 0 && offset + view.byteLength <= bin.length, 'Actor view exceeds physical buffer');
  return bin.subarray(offset, offset + view.byteLength);
}

function pack(json: Json, bin: Uint8Array): Uint8Array {
  const text = Buffer.from(JSON.stringify(json)), padded = Buffer.alloc(align4(text.length), 0x20); text.copy(padded);
  const output = Buffer.alloc(28 + padded.length + align4(bin.length));
  output.writeUInt32LE(0x46546c67, 0); output.writeUInt32LE(2, 4); output.writeUInt32LE(output.length, 8);
  output.writeUInt32LE(padded.length, 12); output.writeUInt32LE(0x4e4f534a, 16); padded.copy(output, 20);
  output.writeUInt32LE(align4(bin.length), 20 + padded.length); output.writeUInt32LE(0x004e4942, 24 + padded.length); output.set(bin, 28 + padded.length);
  return output;
}
