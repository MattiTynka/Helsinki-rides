import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { GlbLoader } from '../src/world/loader.ts';
import { CellVisualStream } from '../src/world/cell-streaming.ts';
import { disposeCellResources } from '../src/render/cell-resources.ts';
import type { CellDescriptor } from '@helsinki/world-schema';
import type { WebGLRenderer } from 'three';

const entry = createRequire(new URL('../package.json', import.meta.url)).resolve('three');
const THREE = await import(new URL('./three.module.js', pathToFileURL(entry)).href);
const url = 'https://example.invalid/world/release/cells/cell.glb';
const originalFetch = globalThis.fetch;
type Json = Record<string, any>;
class Progress extends Event { constructor(type: string, values: ProgressEventInit) { super(type); Object.assign(this, values); } }

function globals(values: Record<string, unknown>): () => void {
  const previous = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  return () => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  };
}

function fixture(material: Json = { pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }): Json {
  const binary = Buffer.alloc(104);
  new Float32Array(binary.buffer, binary.byteOffset, 9).set([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  new Float32Array(binary.buffer, binary.byteOffset + 36, 9).set([0, 0, 1, 0, 0, 1, 0, 0, 1]);
  new Float32Array(binary.buffer, binary.byteOffset + 72, 6).set([0, 0, 1, 0, 0, 1]);
  new Uint16Array(binary.buffer, binary.byteOffset + 96, 3).set([0, 1, 2]);
  return {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
    buffers: [{ uri: 'data:application/octet-stream;base64,' + binary.toString('base64'), byteLength: binary.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 36 },
      { buffer: 0, byteOffset: 72, byteLength: 24 }, { buffer: 0, byteOffset: 96, byteLength: 6 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' }, { bufferView: 2, componentType: 5126, count: 3, type: 'VEC2' },
      { bufferView: 3, componentType: 5123, count: 3, type: 'SCALAR' }],
    images: [{ uri: '../textures/shared.ktx2' }], textures: [{ extensions: { KHR_texture_basisu: { source: 0 } } }],
    extensionsUsed: ['KHR_texture_basisu', ...Object.keys(material.extensions ?? {})], extensionsRequired: ['KHR_texture_basisu'],
    materials: [{ name: 'facade', ...material }],
  };
}

function setup(document: Json, fail: () => boolean = () => false): { loader: GlbLoader; restore: () => void; failures: string[] } {
  const failures: string[] = [], error = console.error;
  const restore = globals({
    self: globalThis, ProgressEvent: Progress,
    __WORLD_DEPLOYMENT__: { appBase: '/', pages: false, worldBaseUrl: null, release: null, manifestSha256: null },
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const target = input instanceof Request ? input.url : String(input);
      if (target === url) return new Response(JSON.stringify(document));
      if (target.startsWith('data:')) return originalFetch(input, init);
      throw new Error(`Unexpected test request ${target}`);
    },
  });
  console.error = (...args: unknown[]) => {
    if (String(args[0]).startsWith("THREE.GLTFLoader: Couldn't load texture")) failures.push(String(args[1]));
    else error(...args);
  };
  const loader = new GlbLoader({ extensions: { has: () => false } } as unknown as WebGLRenderer);
  // The real loader, material extensions, associations and completion hook run.
  // Only the image request/transcoder result is supplied, without a GPU worker.
  loader.ktx2.load = (_target, onLoad, _progress, onError) => {
    if (fail()) onError?.(new Error('injected texture HTTP 503'));
    else onLoad?.(new THREE.CompressedTexture([{ data: new Uint8Array(8), width: 4, height: 4 }], 4, 4, THREE.RGB_S3TC_DXT1_Format));
  };
  return { loader, failures, restore: () => { loader.dispose(); console.error = error; restore(); } };
}

test('failed external KTX2 is never resident; a later stream retry restores its facade map', async () => {
  let fail = true, now = 0, attempts = 0;
  const { loader, failures, restore } = setup(fixture(), () => fail);
  const descriptor = { id: 'c_p00_p00', cx: 0, cz: 0, boundsXZ: [0, 0, 128, 128], buildings: [], buildingIds: [], sourceTiles: [],
    visual: { lod0: { path: 'cells/cell.glb', bytes: 1, sha256: 'a'.repeat(64), triangles: 1, drawCalls: 1, atlases: 1, textureBytesEstimate: 8 } },
    collision: { path: 'cell.hcol', bytes: 1, sha256: 'b'.repeat(64), triangles: 1 } } as CellDescriptor;
  const shown: any[] = [];
  const stream = new CellVisualStream([descriptor], {
    load: async (_cell, signal) => {
      attempts++;
      const gltf = await loader.load(url, signal);
      return { scene: gltf.scene, textureBytes: 8, geometryBytes: 104 };
    },
    show: (_cell, resource) => shown.push(resource.scene), dispose: (_cell, resource) => disposeCellResources(resource.scene),
  }, { textureBudgetBytes: 1024, geometryBudgetBytes: 1024, radius: 100, lookaheadSeconds: 0, maxLookahead: 0, now: () => now });
  const focus = { x: 64, z: 64, velocityX: 0, velocityZ: 0 };
  try {
    stream.update(focus); await stream.settle();
    assert.equal(attempts, 1); assert.equal(failures.length, 1); assert.equal(shown.length, 0);
    assert.equal(stream.stats().residentCells, 0); assert.equal(stream.stats().failedLoads, 1);
    assert.match(stream.stats().errors[0]!, /missing.*baseColorTexture.*map/);
    fail = false; now = 2999; stream.update(focus); await stream.settle(); assert.equal(attempts, 1);
    now = 3001; stream.update(focus); await stream.settle();
    assert.equal(attempts, 2); assert.equal(shown.length, 1); assert.equal(stream.stats().residentCells, 1);
    assert.deepEqual(stream.stats().errors, []); assert.equal(shown[0].children[0].material.map.isTexture, true);
  } finally { stream.dispose(); restore(); }
});

test('non-streamed loads reject missing images, while concurrent successful loads retain their own resources', async () => {
  let requests = 0;
  const { loader, restore } = setup(fixture(), () => requests++ === 0);
  try {
    const [failed, loaded] = await Promise.allSettled([loader.load(url), loader.load(url)]);
    assert.equal(failed.status, 'rejected');
    if (failed.status === 'rejected') assert.match(String(failed.reason), /missing.*baseColorTexture/);
    assert.equal(loaded.status, 'fulfilled');
    if (loaded.status === 'fulfilled') {
      assert.equal((loaded.value.scene.children[0] as any).material.map.isTexture, true);
      assert.equal(loaded.value.scene.children.length, 1, 'A rejected parse cannot clear a concurrent scene');
      disposeCellResources(loaded.value.scene);
    }
    const retry = await loader.load(url);
    assert.equal((retry.scene.children[0] as any).material.map.isTexture, true);
    disposeCellResources(retry.scene);
  } finally { restore(); }
});

const cases: [string, string, string][] = [
  ['', 'baseColorTexture', 'map'], ['', 'metallicRoughnessTexture', 'metalnessMap'], ['', 'metallicRoughnessTexture', 'roughnessMap'],
  ['', 'normalTexture', 'normalMap'], ['', 'occlusionTexture', 'aoMap'], ['', 'emissiveTexture', 'emissiveMap'],
  ['KHR_materials_clearcoat', 'clearcoatTexture', 'clearcoatMap'], ['KHR_materials_clearcoat', 'clearcoatRoughnessTexture', 'clearcoatRoughnessMap'],
  ['KHR_materials_clearcoat', 'clearcoatNormalTexture', 'clearcoatNormalMap'],
  ['KHR_materials_iridescence', 'iridescenceTexture', 'iridescenceMap'], ['KHR_materials_iridescence', 'iridescenceThicknessTexture', 'iridescenceThicknessMap'],
  ['KHR_materials_sheen', 'sheenColorTexture', 'sheenColorMap'], ['KHR_materials_sheen', 'sheenRoughnessTexture', 'sheenRoughnessMap'],
  ['KHR_materials_transmission', 'transmissionTexture', 'transmissionMap'], ['KHR_materials_volume', 'thicknessTexture', 'thicknessMap'],
  ['KHR_materials_specular', 'specularTexture', 'specularIntensityMap'], ['KHR_materials_specular', 'specularColorTexture', 'specularColorMap'],
  ['EXT_materials_bump', 'bumpTexture', 'bumpMap'], ['KHR_materials_anisotropy', 'anisotropyTexture', 'anisotropyMap'],
];

function slotFixture(extension: string, field: string): Json {
  const reference = { index: 0 };
  return fixture(extension ? { extensions: { [extension]: { [field]: reference } } }
    : field === 'baseColorTexture' || field === 'metallicRoughnessTexture' ? { pbrMetallicRoughness: { [field]: reference } } : { [field]: reference });
}

test('every supported material texture slot is checked through source material associations', async t => {
  for (const [extension, field, slot] of cases) await t.test(slot, async () => {
    const { loader, restore } = setup(slotFixture(extension, field));
    try {
      const accepted = await loader.load(url, new AbortController().signal);
      assert.equal((accepted.scene.children[0] as any).material[slot].isTexture, true);
      disposeCellResources(accepted.scene);
      loader.loader.register(parser => ({ name: 'test_drop_one_slot', beforeRoot: async () => {
        const material = await parser.getDependency('material', 0);
        material[slot] = null;
      } }));
      await assert.rejects(loader.load(url, new AbortController().signal), new RegExp(`missing.*${field}.*${slot}`));
    } finally { restore(); }
  });
});

test('unlit intentionally ignores lit-only maps; default materials and transformed texture coordinates remain valid', async () => {
  for (const material of [
    { pbrMetallicRoughness: { baseColorTexture: { index: 0 } }, normalTexture: { index: 0 }, extensions: { KHR_materials_unlit: {} } },
    { pbrMetallicRoughness: { baseColorTexture: { index: 0, texCoord: 1, extensions: { KHR_texture_transform: { offset: [.1, .2] } } } } },
    {},
  ]) {
    const document = fixture(material);
    if (Object.keys(material).length === 0) delete document.meshes[0].primitives[0].material;
    else if (!material.extensions) { document.extensionsUsed.push('KHR_texture_transform'); document.meshes[0].primitives[0].attributes.TEXCOORD_1 = 2; }
    const { loader, restore } = setup(document);
    try {
      const result = await loader.load(url, new AbortController().signal);
      assert.equal(result.scene.children.length, 1); disposeCellResources(result.scene);
    } finally { restore(); }
  }
});

test('malformed references, lost material mappings and unknown texture declarations fail closed', async () => {
  for (const kind of ['index', 'association', 'unknown']) {
    const document = fixture();
    if (kind === 'index') document.materials[0].pbrMetallicRoughness.baseColorTexture.index = '0';
    if (kind === 'unknown') document.materials[0].extensions = { future_material_extension: { mysteryTexture: { index: 0 } } };
    const { loader, restore } = setup(document);
    if (kind === 'association') loader.loader.register(parser => ({ name: 'test_remove_material_association', beforeRoot: async () => {
      const material = await parser.getDependency('material', 0); parser.associations.delete(material);
    } }));
    try { await assert.rejects(loader.load(url, new AbortController().signal), /invalid texture index|source association|unsupported texture declaration/); }
    finally { restore(); }
  }
});

test('line and point conversions retain validation through their primitive source association', async () => {
  for (const mode of [0, 1, 2, 3]) {
    const document = fixture({ pbrMetallicRoughness: { baseColorTexture: { index: 0 } }, normalTexture: { index: 0 } });
    document.meshes[0].primitives[0].mode = mode;
    const { loader, restore } = setup(document);
    try {
      const result = await loader.load(url, new AbortController().signal);
      const renderable = result.scene.children[0] as any;
      assert.equal(renderable.material.map.isTexture, true);
      assert.ok(renderable.isLine || renderable.isPoints);
      renderable.geometry.dispose(); renderable.material.map.dispose(); renderable.material.dispose();
    } finally { restore(); }
  }
});

test('rejected parses dispose shared geometry, original and cloned materials, orphan nodes and ImageBitmaps exactly once', async () => {
  const document = fixture({ pbrMetallicRoughness: { baseColorTexture: { index: 0 } }, normalTexture: { index: 1 }, occlusionTexture: { index: 1 } });
  document.images.push({ uri: '../textures/normal.png' }); document.textures.push({ source: 1 });
  document.materials.push({ name: 'orphan', pbrMetallicRoughness: { baseColorTexture: { index: 1 } } });
  document.meshes.push({ primitives: [{ ...document.meshes[0].primitives[0], material: 1 }] });
  // Missing normals force the real loader to clone its source materials.
  delete document.meshes[0].primitives[0].attributes.NORMAL;
  document.nodes.push({ mesh: 1 }); document.scenes.push({ nodes: [0] });
  const { loader, restore, failures } = setup(document, () => true);
  class Bitmap { width = 4; height = 4; closes = 0; close(): void { this.closes++; this.width = this.height = 0; } }
  const bitmaps: Bitmap[] = [], disposals = new Map<any, number>();
  let orphan: any;
  const savedFetch = globalThis.fetch;
  const restoreBitmap = globals({ ImageBitmap: Bitmap, createImageBitmap: async () => { const bitmap = new Bitmap(); bitmaps.push(bitmap); return bitmap; },
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const target = input instanceof Request ? input.url : String(input);
      return target.endsWith('/normal.png') ? new Response(new Uint8Array([137, 80, 78, 71])) : savedFetch(input, init);
    },
  });
  loader.loader.register(parser => ({ name: 'test_watch_partial_resources', beforeRoot: async () => {
    orphan = await parser.getDependency('node', 1);
    const first = await parser.getDependency('scene', 0), second = await parser.getDependency('scene', 1);
    const watch = (value: any) => { if (value && !disposals.has(value) && (value.isMaterial || value.isTexture || value.isBufferGeometry)) {
      disposals.set(value, 0); value.addEventListener('dispose', () => disposals.set(value, disposals.get(value)! + 1));
    } };
    for (const root of [first, second, orphan]) root.traverse((node: any) => { watch(node.geometry); watch(node.material); });
    for (const value of parser.associations.keys()) watch(value);
  } }));
  try {
    await assert.rejects(loader.load(url, new AbortController().signal), /missing.*baseColorTexture/);
    assert.equal(failures.length, 1); assert.ok(disposals.size >= 6, 'Includes source and cloned materials plus off-scene geometry');
    assert.ok(disposals.has(orphan.geometry), 'The orphan is not retained by the final scene associations');
    for (const [resource, count] of disposals) assert.equal(count, 1, `${resource.type} ${resource.name}: disposal count`);
    assert.equal(bitmaps.length, 1); assert.equal(bitmaps[0]!.closes, 1, 'One bitmap may back several original and cloned texture handles');
  } finally { restoreBitmap(); restore(); }
});
