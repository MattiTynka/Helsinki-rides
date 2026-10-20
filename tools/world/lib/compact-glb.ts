/** Lossless publication cleanup. Does not decode or re-encode geometry or images. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFacadeGlb} from './facade-glb.ts';

type Json = Record<string, any>;
const resourceNames = ['meshes', 'accessors', 'bufferViews', 'materials', 'textures', 'images', 'samplers'] as const;
type ResourceName = typeof resourceNames[number];
type Selection = Record<ResourceName, Set<number>>;
type IndexMaps = Record<ResourceName, Map<number, number>>;
const materialExtensions = new Set([
  'KHR_materials_unlit', 'KHR_materials_specular', 'KHR_materials_clearcoat',
  'KHR_materials_emissive_strength', 'KHR_materials_ior', 'KHR_materials_transmission',
  'KHR_materials_volume', 'KHR_materials_sheen', 'KHR_materials_iridescence',
  'KHR_materials_anisotropy', 'KHR_materials_dispersion', 'KHR_materials_pbrSpecularGlossiness',
]);
const textureExtensions = new Set(['KHR_texture_basisu', 'EXT_texture_webp', 'EXT_texture_avif']);
const extensionScopes: Record<string, Set<string>> = {
  root: new Set(['KHR_lights_punctual', 'KHR_materials_variants']),
  buffers: new Set(['EXT_meshopt_compression']),
  bufferViews: new Set(['EXT_meshopt_compression']),
  nodes: new Set(['KHR_lights_punctual', 'EXT_mesh_gpu_instancing']),
  primitives: new Set(['KHR_materials_variants', 'KHR_draco_mesh_compression']),
  materials: materialExtensions,
  textureInfo: new Set(['KHR_texture_transform']),
  textures: textureExtensions,
};
const align4 = (n: number) => Math.ceil(n / 4) * 4;
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

export interface GlbCompactionReceipt {
  originalBytes: number;
  compactedBytes: number;
  savedBytes: number;
  originalSha256: string;
  compactedSha256: string;
  /** Hash of reachable JSON with physical offsets normalized and exact payload hashes attached. */
  semanticSha256: string;
  retainedPhysicalBytes: number;
  resources: Record<ResourceName, {before: number; after: number}>;
  /** Per retained view, in output order; compressed hashes are the original encoded stream. */
  bufferViews: {originalIndex: number; compactedIndex: number; rawSha256?: string; compressedSha256?: string}[];
  images: {originalIndex: number; compactedIndex: number; sha256?: string; uri?: string}[];
}

/** External images are restricted to the publication builder's content-addressed texture directory. */
export function isCompactedTextureUri(uri: unknown): uri is string {
  return typeof uri === 'string' && /^(?:\.\.\/)?textures\/[a-f0-9]{64}\.(?:ktx2|png|jpe?g|webp)$/.test(uri);
}

/**
 * Keeps every node, scene, animation, skin, camera and opaque extras object, including named empty
 * sockets. Prunes only resource arrays no retained node/animation/skin/material references. Unknown
 * extensions fail closed: their indices cannot safely be guessed. Virtual meshopt fallback buffers
 * are repacked independently of their exact, unchanged encoded streams in physical buffer 0.
 */
export function compactGlb(bytes: Uint8Array): {bytes: Uint8Array; receipt: GlbCompactionReceipt} {
  const original = readFacadeGlb(bytes), source = original.json as Json;
  assert.equal(source.asset?.version, '2.0', 'Compaction requires glTF 2.0');
  assert.ok(Array.isArray(source.buffers) && source.buffers.length, 'Missing GLB buffers');
  for (const [i, buffer] of source.buffers.entries()) {
    assert.equal(buffer.uri, undefined, 'External buffers are unsupported');
    integer(buffer.byteLength, `buffer ${i} byteLength`);
    if (i) assert.equal(buffer.extensions?.EXT_meshopt_compression?.fallback, true, 'Only meshopt virtual buffers are supported after buffer 0');
  }
  assert.equal(source.buffers[0].byteLength, original.bin.length, 'Physical buffer length mismatch');
  validateExtensions(source, 'root');
  const allowedDeclarations = new Set(['KHR_mesh_quantization', ...Object.values(extensionScopes).flatMap(s => [...s])]);
  for (const name of [...source.extensionsUsed ?? [], ...source.extensionsRequired ?? []]) assert.ok(allowedDeclarations.has(name), `Unsupported GLB extension: ${name}`);
  for (const key of resourceNames) assert.ok(source[key] === undefined || Array.isArray(source[key]), `Invalid ${key} array`);
  // Conservatively retain resources referred to by every node, including nodes outside scene roots.
  // This preserves authoring sockets and runtime objects looked up by their names.
  const selected = Object.fromEntries(resourceNames.map(key => [key, new Set<number>()])) as Selection;
  function add(key: ResourceName, index: unknown): void {
    if (index === undefined) return;
    integer(index, `${key} reference`);
    assert.ok(source[key]?.[index as number], `Missing ${key}[${index}]`);
    const id = index as number;
    if (selected[key].has(id)) return;
    selected[key].add(id);
    const item = source[key][id];
    if (key === 'meshes') for (const primitive of item.primitives) {
      for (const accessor of Object.values(primitive.attributes ?? {})) add('accessors', accessor);
      add('accessors', primitive.indices);
      for (const target of primitive.targets ?? []) for (const accessor of Object.values(target)) add('accessors', accessor);
      add('materials', primitive.material);
      add('bufferViews', primitive.extensions?.KHR_draco_mesh_compression?.bufferView);
      for (const mapping of primitive.extensions?.KHR_materials_variants?.mappings ?? []) add('materials', mapping.material);
    }
    if (key === 'accessors') {
      add('bufferViews', item.bufferView);
      add('bufferViews', item.sparse?.indices?.bufferView);
      add('bufferViews', item.sparse?.values?.bufferView);
    }
    if (key === 'materials') for (const info of materialTextureInfos(item)) add('textures', info.index);
    if (key === 'textures') {
      add('samplers', item.sampler); add('images', item.source);
      for (const name of textureExtensions) add('images', item.extensions?.[name]?.source);
    }
    if (key === 'images') {
      if (item.uri !== undefined) {
        assert.ok(isCompactedTextureUri(item.uri), `Unsupported external texture URI: ${item.uri}`);
        assert.equal(item.bufferView, undefined, 'Image must use a URI or a buffer view');
      } else add('bufferViews', item.bufferView);
    }
  }
  for (const node of source.nodes ?? []) {
    add('meshes', node.mesh);
    for (const accessor of Object.values(node.extensions?.EXT_mesh_gpu_instancing?.attributes ?? {})) add('accessors', accessor);
  }
  for (const skin of source.skins ?? []) add('accessors', skin.inverseBindMatrices);
  for (const animation of source.animations ?? []) for (const sampler of animation.samplers ?? []) {
    add('accessors', sampler.input); add('accessors', sampler.output);
  }
  const maps = Object.fromEntries(resourceNames.map(key => [key, new Map([...selected[key]].sort((a, b) => a - b).map((old, i) => [old, i]))])) as IndexMaps;
  const json = structuredClone(source);
  for (const key of resourceNames) if (source[key]) json[key] = [...maps[key].keys()].map(i => structuredClone(source[key][i]));
  function remap(key: ResourceName, value: unknown): number {
    integer(value, `${key} reference`);
    const result = maps[key].get(value as number);
    assert.notEqual(result, undefined, `Unretained ${key}[${value}]`);
    return result!;
  }
  for (const node of json.nodes ?? []) {
    if (node.mesh !== undefined) node.mesh = remap('meshes', node.mesh);
    const attributes = node.extensions?.EXT_mesh_gpu_instancing?.attributes;
    if (attributes) for (const name of Object.keys(attributes)) attributes[name] = remap('accessors', attributes[name]);
  }
  for (const mesh of json.meshes ?? []) for (const primitive of mesh.primitives) {
    for (const name of Object.keys(primitive.attributes ?? {})) primitive.attributes[name] = remap('accessors', primitive.attributes[name]);
    if (primitive.indices !== undefined) primitive.indices = remap('accessors', primitive.indices);
    for (const target of primitive.targets ?? []) for (const name of Object.keys(target)) target[name] = remap('accessors', target[name]);
    if (primitive.material !== undefined) primitive.material = remap('materials', primitive.material);
    const draco = primitive.extensions?.KHR_draco_mesh_compression;
    if (draco) draco.bufferView = remap('bufferViews', draco.bufferView);
    for (const mapping of primitive.extensions?.KHR_materials_variants?.mappings ?? []) mapping.material = remap('materials', mapping.material);
  }
  for (const skin of json.skins ?? []) if (skin.inverseBindMatrices !== undefined) skin.inverseBindMatrices = remap('accessors', skin.inverseBindMatrices);
  for (const animation of json.animations ?? []) for (const sampler of animation.samplers ?? []) {
    sampler.input = remap('accessors', sampler.input); sampler.output = remap('accessors', sampler.output);
  }
  for (const accessor of json.accessors ?? []) {
    if (accessor.bufferView !== undefined) accessor.bufferView = remap('bufferViews', accessor.bufferView);
    if (accessor.sparse) {
      accessor.sparse.indices.bufferView = remap('bufferViews', accessor.sparse.indices.bufferView);
      accessor.sparse.values.bufferView = remap('bufferViews', accessor.sparse.values.bufferView);
    }
  }
  for (const material of json.materials ?? []) for (const info of materialTextureInfos(material)) info.index = remap('textures', info.index);
  for (const texture of json.textures ?? []) {
    if (texture.source !== undefined) texture.source = remap('images', texture.source);
    if (texture.sampler !== undefined) texture.sampler = remap('samplers', texture.sampler);
    for (const name of textureExtensions) if (texture.extensions?.[name]) texture.extensions[name].source = remap('images', texture.extensions[name].source);
  }
  for (const image of json.images ?? []) if (image.bufferView !== undefined) image.bufferView = remap('bufferViews', image.bufferView);

  const beforeRepack = snapshot(json, original.bin);
  const ranges: {start: number; end: number; offset: number}[][] = source.buffers.map(() => []);
  function range(buffer: unknown, start: unknown, length: unknown) {
    integer(buffer, 'buffer reference'); integer(start, 'buffer range offset'); integer(length, 'buffer range length');
    assert.ok(source.buffers[buffer as number], 'Missing referenced buffer');
    assert.ok((start as number) + (length as number) <= source.buffers[buffer as number].byteLength, 'Buffer view exceeds its buffer');
    if (!length) return;
    ranges[buffer as number]!.push({start: Math.floor((start as number) / 4) * 4, end: Math.min(align4((start as number) + (length as number)), source.buffers[buffer as number].byteLength), offset: 0});
  }
  for (const view of json.bufferViews ?? []) {
    range(view.buffer, view.byteOffset ?? 0, view.byteLength);
    const compression = view.extensions?.EXT_meshopt_compression;
    if (compression) {
      assert.equal(compression.buffer, 0, 'Meshopt streams must be in physical buffer 0');
      range(compression.buffer, compression.byteOffset ?? 0, compression.byteLength);
    } else assert.equal(view.buffer, 0, 'Virtual buffer view must have meshopt compression');
  }
  const pieces: Uint8Array[] = [];
  for (const [id, intervals] of ranges.entries()) {
    intervals.sort((a, b) => a.start - b.start);
    const merged: typeof intervals = [];
    for (const interval of intervals) {
      const last = merged.at(-1);
      if (last && last.end >= interval.start) last.end = Math.max(last.end, interval.end);
      else merged.push({...interval});
    }
    let cursor = 0;
    for (const interval of merged) {
      interval.offset = cursor;
      if (!id) {
        pieces.push(original.bin.subarray(interval.start, interval.end));
        if (align4(interval.end - interval.start) > interval.end - interval.start) pieces.push(new Uint8Array(align4(interval.end - interval.start) - (interval.end - interval.start)));
      }
      cursor += align4(interval.end - interval.start);
    }
    ranges[id] = merged;
    json.buffers[id].byteLength = cursor;
  }
  function offset(buffer: number, start: number, length: number): number {
    if (!length) return 0;
    const found = ranges[buffer]!.find(r => r.start <= start && r.end >= start + length);
    assert.ok(found, 'Missing retained byte range');
    return found.offset + start - found.start;
  }
  for (const view of json.bufferViews ?? []) {
    view.byteOffset = offset(view.buffer, view.byteOffset ?? 0, view.byteLength);
    const compression = view.extensions?.EXT_meshopt_compression;
    if (compression) compression.byteOffset = offset(compression.buffer, compression.byteOffset ?? 0, compression.byteLength);
  }
  const bin = Buffer.concat(pieces);
  assert.equal(bin.length, json.buffers[0].byteLength);
  const afterRepack = snapshot(json, bin);
  assert.deepEqual(afterRepack, beforeRepack, 'Retained GLB metadata or encoded bytes changed');
  const output = pack(json, bin);
  const resources = Object.fromEntries(resourceNames.map(key => [key, {before: source[key]?.length ?? 0, after: json[key]?.length ?? 0}])) as GlbCompactionReceipt['resources'];
  return {bytes: output, receipt: {
    originalBytes: bytes.length, compactedBytes: output.length, savedBytes: bytes.length - output.length,
    originalSha256: sha(bytes), compactedSha256: sha(output), semanticSha256: sha(JSON.stringify(afterRepack)),
    retainedPhysicalBytes: bin.length, resources,
    bufferViews: [...maps.bufferViews.keys()].map((originalIndex, compactedIndex) => ({originalIndex, compactedIndex, ...afterRepack.payloads[compactedIndex]})),
    images: [...maps.images.keys()].map((originalIndex, compactedIndex) => {
      const image = json.images[compactedIndex];
      return image.uri !== undefined ? {originalIndex, compactedIndex, uri: image.uri} : {originalIndex, compactedIndex, sha256: afterRepack.payloads[image.bufferView]!.rawSha256};
    }),
  }};
}

function integer(value: unknown, label: string): asserts value is number {
  assert.ok(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0, `Invalid ${label}`);
}

/** Only known material texture-info fields carry resource indices; extras remain opaque metadata. */
function materialTextureInfos(material: Json): Json[] {
  const result: Json[] = [];
  const visit = (object: Json) => {
    for (const [name, value] of Object.entries(object)) {
      if (name === 'extras' || name === 'extensions') continue;
      if (name.endsWith('Texture') && value !== undefined) {
        assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'Invalid material texture info');
        integer(value.index, 'texture info index'); result.push(value);
      }
    }
  };
  visit(material); if (material.pbrMetallicRoughness) visit(material.pbrMetallicRoughness);
  for (const [name, extension] of Object.entries(material.extensions ?? {})) if (materialExtensions.has(name)) visit(extension as Json);
  return result;
}

function validateExtensions(value: any, scope: string): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { for (const item of value) validateExtensions(item, scope); return; }
  for (const name of Object.keys(value.extensions ?? {})) {
    assert.ok(extensionScopes[scope]?.has(name), `Unsupported GLB extension ${name} on ${scope}`);
    // Material extension texture infos may themselves contain KHR_texture_transform.
    if (scope === 'materials') for (const [key, info] of Object.entries(value.extensions[name])) if (key.endsWith('Texture')) validateExtensions(info, 'textureInfo');
  }
  for (const [name, item] of Object.entries(value)) {
    if (name === 'extras' || name === 'extensions') continue;
    const next = name.endsWith('Texture') ? 'textureInfo' : name === 'pbrMetallicRoughness' ? 'materials' : name;
    validateExtensions(item, next);
  }
}

function snapshot(json: Json, bin: Uint8Array) {
  const normalized = structuredClone(json);
  const payloads: {rawSha256?: string; compressedSha256?: string}[] = [];
  for (const [i, view] of (json.bufferViews ?? []).entries()) {
    const hashes: typeof payloads[number] = {};
    if (view.buffer === 0) hashes.rawSha256 = sha(bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength));
    const compression = view.extensions?.EXT_meshopt_compression;
    if (compression) hashes.compressedSha256 = sha(bin.subarray(compression.byteOffset ?? 0, (compression.byteOffset ?? 0) + compression.byteLength));
    payloads.push(hashes);
    delete normalized.bufferViews[i].byteOffset;
    if (compression) delete normalized.bufferViews[i].extensions.EXT_meshopt_compression.byteOffset;
  }
  for (const buffer of normalized.buffers) buffer.byteLength = 0;
  return {json: normalized, payloads};
}

function pack(json: Json, bin: Uint8Array): Uint8Array {
  const text = Buffer.from(JSON.stringify(json)), padded = Buffer.alloc(align4(text.length), 0x20); text.copy(padded);
  const output = Buffer.alloc(28 + padded.length + align4(bin.length));
  output.writeUInt32LE(0x46546c67, 0); output.writeUInt32LE(2, 4); output.writeUInt32LE(output.length, 8);
  output.writeUInt32LE(padded.length, 12); output.writeUInt32LE(0x4e4f534a, 16); padded.copy(output, 20);
  output.writeUInt32LE(align4(bin.length), 20 + padded.length); output.writeUInt32LE(0x004e4942, 24 + padded.length); output.set(bin, 28 + padded.length);
  return output;
}
