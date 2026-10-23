import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {test} from 'node:test';
import {OwnedKtx2Loader, ktx2Supercompression} from '../../../apps/game/src/world/owned-ktx2-loader.ts';
import {dropTopMips} from '../../../packages/world-schema/src/ktx2-mips.ts';
import {disposeCellResources} from '../../../apps/game/src/render/cell-resources.ts';
import {textureMemory} from '../../../apps/game/src/testapi.ts';

const entry = createRequire(new URL('../../../apps/game/package.json', import.meta.url)).resolve('three');
const THREE = await import(new URL('./three.module.js', pathToFileURL(entry)).href);
const {createDefaultContainer, write} = await import(new URL('../examples/jsm/libs/ktx-parse.module.js', pathToFileURL(entry)).href);
const {GLTFLoader} = await import(new URL('../examples/jsm/loaders/GLTFLoader.js', pathToFileURL(entry)).href);
type KtxTexture = Awaited<ReturnType<OwnedKtx2Loader['loadAsync']>>;

function globals(values: Record<string, unknown>): () => void {
  const previous = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, {value, configurable: true, writable: true});
  return () => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  };
}
function container(supercompressionScheme = 0): Uint8Array {
  const data = createDefaultContainer();
  data.pixelWidth = data.pixelHeight = 4; data.levelCount = 1; data.supercompressionScheme = supercompressionScheme;
  data.dataFormatDescriptor[0].colorModel = 166;
  data.levels = [{levelData: new Uint8Array(16), uncompressedByteLength: 16}];
  return write(data);
}
/** Zstandard, two levels, 128 px: a mip drop of one actually happens (the result is 64 px). */
function qualifying(size = 128, levelCount = 2, supercompressionScheme = 2): Uint8Array {
  const data = createDefaultContainer();
  data.pixelWidth = data.pixelHeight = size; data.levelCount = levelCount; data.supercompressionScheme = supercompressionScheme;
  data.dataFormatDescriptor[0].colorModel = 166;
  data.levels = Array.from({length: levelCount}, (_, level) => ({levelData: new Uint8Array(48 >> level).fill(level + 1), uncompressedByteLength: (size >> level) ** 2}));
  return write(data);
}
/** `posted` receives a copy of every buffer the vendor loader hands to the transcoder worker, i.e. what reached super.parse. */
function loader(transcode: () => void = () => {}, posted: Uint8Array[] = []): OwnedKtx2Loader {
  const instance = new OwnedKtx2Loader();
  instance.workerConfig = {} as typeof instance.workerConfig;
  instance.init = async () => {};
  // The installed parser, in-flight request coalescing, task cache, texture construction
  // and cloning remain real. Only the external WASM worker's pixel result is supplied.
  instance.workerPool.postMessage = async (message: {buffer: ArrayBuffer}) => {
    posted.push(new Uint8Array(message.buffer).slice());
    transcode();
    return {data: {type: 'transcode', data: {
      faces: [{mipmaps: [{data: new Uint8Array(8), width: 4, height: 4}]}],
      width: 4, height: 4, format: THREE.RGB_S3TC_DXT1_Format, type: THREE.UnsignedByteType, dfdFlags: 0,
    }}} as MessageEvent;
  };
  return instance;
}
const cell = (texture: KtxTexture) => new THREE.Group().add(new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({map: texture})));
class Progress extends Event { constructor(type: string, values: ProgressEventInit) {super(type); Object.assign(this, values);} }

/**
 * The ownership tests run twice: without a mip drop on the minimal container, and with setMipDrop(1) on a qualifying
 * one, where the stripped buffer is memoised per input buffer so the vendor task cache still sees one buffer.
 */
const VARIANTS = [
  {label: '', mipDrop: 0, source: () => container()},
  {label: ' (setMipDrop(1), qualifying container)', mipDrop: 1, source: () => qualifying()},
] as const;
/** Exactly one buffer reached super.parse: the input itself, or (mip drop) its stripped form, which is shorter. */
function assertPosted(posted: Uint8Array[], input: Uint8Array, mipDrop: 0 | 1): void {
  assert.equal(posted.length, 1);
  assert.deepEqual(Array.from(posted[0]!), Array.from(dropTopMips(input, mipDrop)));
  if (mipDrop) assert.ok(posted[0]!.length < input.length, 'the dropped container is shorter than the input');
}

for (const variant of VARIANTS) {
test(`concurrent shared KTX2 requests keep one transcode but own independent sampler and disposal handles${variant.label}`, async () => {
  let requests = 0, transcodes = 0;
  const input = variant.source(), posted: Uint8Array[] = [];
  const restore = globals({
    ProgressEvent: Progress,
    fetch: async () => {requests++; await new Promise(resolve => setImmediate(resolve)); return new Response(Uint8Array.from(input));},
  });
  try {
    assert.equal(THREE.Cache.enabled, false);
    const ktx = loader(() => transcodes++, posted);
    ktx.setMipDrop(variant.mipDrop);
    const [a, b] = await Promise.all([ktx.loadAsync('https://example.invalid/shared.ktx2'), ktx.loadAsync('https://example.invalid/shared.ktx2')]);
    assert.equal(requests, 1); assert.equal(transcodes, 1, 'The vendor cache still avoids duplicate transcoding');
    assertPosted(posted, input, variant.mipDrop);
    assert.equal(a.userData['ktx2'].mipDropped, variant.mipDrop); assert.equal(b.userData['ktx2'].mipDropped, variant.mipDrop);
    assert.notEqual(a, b, 'Two parsed cells must never own the same Texture handle');
    assert.equal(a.source, b.source); assert.equal(a.mipmaps[0]!.data, b.mipmaps[0]!.data, 'Pixel data remains shared');
    const originalWrap = b.wrapS, originalName = b.name;
    a.wrapS = THREE.ClampToEdgeWrapping; a.name = 'cell-a';
    assert.equal(b.wrapS, originalWrap); assert.equal(b.name, originalName);
    let aDisposals = 0, bDisposals = 0;
    a.addEventListener('dispose', () => aDisposals++); b.addEventListener('dispose', () => bDisposals++);
    const first = cell(a), second = cell(b);
    disposeCellResources(first); disposeCellResources(first);
    assert.equal(aDisposals, 1); assert.equal(bDisposals, 0, 'Eviction must not dispose a resident neighbor');
    assert.equal(second.children[0].material.map, b); assert.equal(b.mipmaps[0]!.data.byteLength, 8);
    disposeCellResources(second); assert.equal(bDisposals, 1);
  } finally {restore();}
});

test(`direct KTX2 parse callbacks also own separate handles when the input buffer is cached${variant.label}`, async () => {
  let transcodes = 0;
  const input = variant.source(), posted: Uint8Array[] = [];
  const ktx = loader(() => transcodes++, posted).setMipDrop(variant.mipDrop), bytes = input.slice().buffer as ArrayBuffer;
  const parse = () => new Promise<KtxTexture>((resolve, reject) => ktx.parse(bytes, resolve, reject));
  const [a, b] = await Promise.all([parse(), parse()]);
  assert.equal(transcodes, 1); assert.notEqual(a, b); assert.equal(a.source, b.source);
  assertPosted(posted, input, variant.mipDrop);
  const later = await parse();
  assert.equal(transcodes, 1, 'a later parse of the same buffer is a task cache hit'); assert.equal(later.source, a.source);
});

test(`failed shared KTX2 decoding propagates to every callback without creating owned textures${variant.label}`, async () => {
  const input = variant.source(), posted: Uint8Array[] = [];
  const ktx = loader(() => {throw new Error('transcode rejected');}, posted).setMipDrop(variant.mipDrop), bytes = input.slice().buffer as ArrayBuffer;
  const parse = () => new Promise<KtxTexture>((resolve, reject) => ktx.parse(bytes, resolve, reject));
  const results = await Promise.allSettled([parse(), parse()]);
  for (const result of results) {assert.equal(result.status, 'rejected'); if (result.status === 'rejected') assert.match(String(result.reason), /transcode rejected/);}
  assertPosted(posted, input, variant.mipDrop);
});
}

test('setMipDrop(1) hands stripped bytes to super.parse only for qualifying containers, falling back silently', async () => {
  const base = Object.getPrototypeOf(OwnedKtx2Loader.prototype) as {parse: OwnedKtx2Loader['parse']};
  const vendorParse = base.parse, handed: ArrayBuffer[] = [], noise: unknown[] = [];
  base.parse = function (buffer: ArrayBuffer, onLoad?: (texture: KtxTexture) => void) {
    handed.push(buffer);
    onLoad?.(new THREE.CompressedTexture([], 4, 4, THREE.RGB_S3TC_DXT1_Format));
  };
  const quiet = (...args: unknown[]) => { noise.push(args); };
  const restore = globals({console: {...console, warn: quiet, error: quiet, log: quiet, info: quiet, debug: quiet}});
  try {
    const parse = (ktx: OwnedKtx2Loader, buffer: ArrayBuffer) => new Promise<KtxTexture>((resolve, reject) => ktx.parse(buffer, resolve, reject));
    const plain = loader(), dropping = loader().setMipDrop(1);
    const trailing = new Uint8Array(qualifying().length + 1); trailing.set(qualifying());
    const cases: [string, Uint8Array, boolean][] = [
      ['zstd 128 px, 2 levels', qualifying(), true],
      ['zstd 256 px, 3 levels', qualifying(256, 3), true],
      ['result under 64 px', qualifying(64, 2), false],
      ['single level', qualifying(128, 1), false],
      ['BasisLZ', qualifying(128, 2, 1), false],
      ['no supercompression', qualifying(128, 2, 0), false],
      ['corrupt layout (trailing byte)', trailing, false],
    ];
    for (const [name, input, drops] of cases) {
      handed.length = 0;
      const without = await parse(plain, input.slice().buffer as ArrayBuffer);
      assert.deepEqual(Array.from(new Uint8Array(handed[0]!)), Array.from(input), `${name}: without the drop the input is handed on`);
      assert.equal(without.userData['ktx2']?.mipDropped ?? 0, 0);
      const buffer = input.slice().buffer as ArrayBuffer;
      const [a, b] = await Promise.all([parse(dropping, buffer), parse(dropping, buffer)]);
      assert.equal(handed[1], handed[2], `${name}: both parses hand the same buffer to super.parse`);
      const expected = drops ? dropTopMips(input, 1) : input;
      assert.deepEqual(Array.from(new Uint8Array(handed[1]!)), Array.from(expected), name);
      assert.equal(handed[1] === buffer, !drops, `${name}: ${drops ? 'a new stripped buffer' : 'the original buffer'}`);
      for (const texture of [a, b]) assert.equal(texture.userData['ktx2']?.mipDropped ?? 0, drops ? 1 : 0, name);
    }
    assert.equal(dropping.setMipDrop(0), dropping, 'chainable');
    handed.length = 0;
    const input = qualifying(), off = await parse(dropping, input.slice().buffer as ArrayBuffer);
    assert.equal(handed[0]!.byteLength, input.length, 'setMipDrop(0) applies to later parses');
    assert.equal(off.userData['ktx2'].mipDropped, 0);
    assert.deepEqual(noise, [], 'no console output on the fallback path');
  } finally { base.parse = vendorParse; restore(); }
});

test('concurrent PNG GLB parses own different ImageBitmaps with the application cache disabled', async () => {
  const savedFetch = globalThis.fetch;
  let requests = 0, decoded = 0;
  class Bitmap {width = 4; height = 4; closes = 0; close(): void {this.closes++; this.width = this.height = 0;} }
  const restore = globals({
    self: globalThis, ProgressEvent: Progress, ImageBitmap: Bitmap,
    createImageBitmap: async () => {decoded++; return new Bitmap();},
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (!url.endsWith('/shared.png')) return savedFetch(input, init);
      requests++; await new Promise(resolve => setImmediate(resolve)); return new Response(new Uint8Array([137, 80, 78, 71]));
    },
  });
  try {
    assert.equal(THREE.Cache.enabled, false, 'Application image caching must stay off while cells own bitmap.close()');
    const binary = Buffer.alloc(68);
    new Float32Array(binary.buffer, binary.byteOffset, 9).set([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    new Float32Array(binary.buffer, binary.byteOffset + 36, 6).set([0, 0, 1, 0, 0, 1]);
    new Uint16Array(binary.buffer, binary.byteOffset + 60, 3).set([0, 1, 2]);
    const document = JSON.stringify({
      asset: {version: '2.0'}, scene: 0, scenes: [{nodes: [0]}], nodes: [{mesh: 0}],
      meshes: [{primitives: [{attributes: {POSITION: 0, TEXCOORD_0: 1}, indices: 2, material: 0}]}],
      buffers: [{uri: 'data:application/octet-stream;base64,' + binary.toString('base64'), byteLength: binary.length}],
      bufferViews: [{buffer: 0, byteOffset: 0, byteLength: 36}, {buffer: 0, byteOffset: 36, byteLength: 24}, {buffer: 0, byteOffset: 60, byteLength: 6}],
      accessors: [{bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0]},
        {bufferView: 1, componentType: 5126, count: 3, type: 'VEC2'}, {bufferView: 2, componentType: 5123, count: 3, type: 'SCALAR'}],
      images: [{uri: '../textures/shared.png'}], textures: [{source: 0}], materials: [{pbrMetallicRoughness: {baseColorTexture: {index: 0}}}],
    });
    const gltf = new GLTFLoader(), [a, b] = await Promise.all([
      gltf.parseAsync(document, 'https://example.invalid/cells/'), gltf.parseAsync(document, 'https://example.invalid/cells/'),
    ]);
    const first = a.scene.children[0].material.map, second = b.scene.children[0].material.map;
    assert.equal(requests, 2); assert.equal(decoded, 2); assert.notEqual(first, second); assert.notEqual(first.image, second.image);
    disposeCellResources(a.scene);
    assert.equal(first.image.closes, 1); assert.equal(second.image.closes, 0); assert.equal(second.image.width, 4);
    disposeCellResources(b.scene); assert.equal(second.image.closes, 1);
  } finally {restore();}
});

test('every parsed KTX2 texture records its supercompression, including cached parses of a transferred buffer', async () => {
  const ktx = loader();
  for (const [scheme, expected] of [[0, 'none'], [1, 'basislz'], [2, 'zstd']] as const) {
    const bytes = container(scheme).buffer as ArrayBuffer;
    assert.equal(ktx2Supercompression(bytes), expected);
    const parse = () => new Promise<KtxTexture>((resolve, reject) => ktx.parse(bytes, resolve, reject));
    const first = await parse();
    assert.deepEqual(first.userData['ktx2'], {supercompression: expected, mipDropped: 0});
    structuredClone(bytes, {transfer: [bytes]});
    assert.equal(bytes.byteLength, 0, 'the transcoder worker owns the original bytes');
    const cached = await parse();
    assert.notEqual(cached, first); assert.deepEqual(cached.userData['ktx2'], {supercompression: expected, mipDropped: 0});
    assert.deepEqual(cached.clone().userData['ktx2'], cached.userData['ktx2'], 'the tag survives GLTFLoader texture clones');
  }
});

test('a raw (uncompressed) KTX2 parsed by the vendor loader counts as other, not as an image, in the texture census', async () => {
  const data = createDefaultContainer();
  data.vkFormat = 37; // VK_FORMAT_R8G8B8A8_UNORM: no transcoder, the vendor loader builds a DataTexture
  data.pixelWidth = data.pixelHeight = 4; data.levelCount = 1;
  data.levels = [{levelData: new Uint8Array(64), uncompressedByteLength: 64}];
  const bytes = write(data).buffer as ArrayBuffer;
  const texture = await new Promise<KtxTexture>((resolve, reject) => loader().parse(bytes, resolve, reject));
  assert.equal(texture.isCompressedTexture, undefined, 'raw KTX2 is not a CompressedTexture');
  assert.deepEqual(texture.userData['ktx2'], {supercompression: 'none', mipDropped: 0});
  const census = textureMemory(cell(texture));
  assert.equal(census.textures, 1);
  assert.deepEqual(census.byClass, {zstd: 0, basislz: 0, image: 0, other: census.mib});
  assert.ok(census.mib > 0);
});

test('the supercompression header read is bounds-checked and rejects unknown containers', () => {
  const valid = container(2);
  assert.equal(ktx2Supercompression(valid.buffer as ArrayBuffer), 'zstd');
  assert.equal(ktx2Supercompression(valid.slice(0, 47).buffer as ArrayBuffer), null, 'truncated header');
  assert.equal(ktx2Supercompression(new ArrayBuffer(0)), null);
  const wrongMagic = valid.slice(); wrongMagic[1] = 0;
  assert.equal(ktx2Supercompression(wrongMagic.buffer as ArrayBuffer), null);
  assert.equal(ktx2Supercompression(container(3).buffer as ArrayBuffer), null, 'ZLIB and future schemes are not classified');
  const offset = valid.slice(); new DataView(offset.buffer).setUint32(44, 2 ** 31, true);
  assert.equal(ktx2Supercompression(offset.buffer as ArrayBuffer), null);
});
