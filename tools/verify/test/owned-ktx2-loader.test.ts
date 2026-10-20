import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {test} from 'node:test';
import {OwnedKtx2Loader} from '../../../apps/game/src/world/owned-ktx2-loader.ts';
import {disposeCellResources} from '../../../apps/game/src/render/cell-resources.ts';

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
function container(): Uint8Array {
  const data = createDefaultContainer();
  data.pixelWidth = data.pixelHeight = 4; data.levelCount = 1;
  data.dataFormatDescriptor[0].colorModel = 166;
  data.levels = [{levelData: new Uint8Array(16), uncompressedByteLength: 16}];
  return write(data);
}
function loader(transcode: () => void = () => {}): OwnedKtx2Loader {
  const instance = new OwnedKtx2Loader();
  instance.workerConfig = {} as typeof instance.workerConfig;
  instance.init = async () => {};
  // The installed parser, in-flight request coalescing, task cache, texture construction
  // and cloning remain real. Only the external WASM worker's pixel result is supplied.
  instance.workerPool.postMessage = async () => {
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

test('concurrent shared KTX2 requests keep one transcode but own independent sampler and disposal handles', async () => {
  let requests = 0, transcodes = 0;
  const restore = globals({
    ProgressEvent: Progress,
    fetch: async () => {requests++; await new Promise(resolve => setImmediate(resolve)); return new Response(Uint8Array.from(container()));},
  });
  try {
    assert.equal(THREE.Cache.enabled, false);
    const ktx = loader(() => transcodes++);
    const [a, b] = await Promise.all([ktx.loadAsync('https://example.invalid/shared.ktx2'), ktx.loadAsync('https://example.invalid/shared.ktx2')]);
    assert.equal(requests, 1); assert.equal(transcodes, 1, 'The vendor cache still avoids duplicate transcoding');
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

test('direct KTX2 parse callbacks also own separate handles when the input buffer is cached', async () => {
  let transcodes = 0;
  const ktx = loader(() => transcodes++), bytes = container().buffer as ArrayBuffer;
  const parse = () => new Promise<KtxTexture>((resolve, reject) => ktx.parse(bytes, resolve, reject));
  const [a, b] = await Promise.all([parse(), parse()]);
  assert.equal(transcodes, 1); assert.notEqual(a, b); assert.equal(a.source, b.source);
});

test('failed shared KTX2 decoding propagates to every callback without creating owned textures', async () => {
  const ktx = loader(() => {throw new Error('transcode rejected');}), bytes = container().buffer as ArrayBuffer;
  const parse = () => new Promise<KtxTexture>((resolve, reject) => ktx.parse(bytes, resolve, reject));
  const results = await Promise.allSettled([parse(), parse()]);
  for (const result of results) {assert.equal(result.status, 'rejected'); if (result.status === 'rejected') assert.match(String(result.reason), /transcode rejected/);}
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
