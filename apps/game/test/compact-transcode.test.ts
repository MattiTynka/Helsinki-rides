import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { OwnedKtx2Loader } from '../src/world/owned-ktx2-loader.ts';
import { GlbLoader } from '../src/world/loader.ts';
import { createWorldDeployment } from '../src/world/urls.ts';
import { cityMaterials, textureFormats, textureMemory } from '../src/testapi.ts';

type Support = Partial<Record<'astcSupported' | 'astcHDRSupported' | 'etc1Supported' | 'etc2Supported' | 'dxtSupported' | 'bptcSupported' | 'pvrtcSupported', boolean>>;
const config = (support: Support) => ({ astcSupported: false, astcHDRSupported: false, etc1Supported: false, etc2Supported: false, dxtSupported: false, bptcSupported: false, pvrtcSupported: false, ...support });

test('the compact transcode preference drops 8 bpp targets only when a 4 bpp opaque format exists', () => {
  const cases: [Support, boolean, Support][] = [
    [{ bptcSupported: true, dxtSupported: true }, true, { bptcSupported: false, dxtSupported: true }],
    [{ astcSupported: true, astcHDRSupported: true, etc2Supported: true }, true, { astcSupported: false, astcHDRSupported: false, etc2Supported: true }],
    [{ astcSupported: true, etc2Supported: true, dxtSupported: true }, true, { astcSupported: false, etc2Supported: true, dxtSupported: true }],
    [{ bptcSupported: true }, false, { bptcSupported: true }],
    [{ astcSupported: true }, false, { astcSupported: true }],
    [{ etc1Supported: true, astcSupported: true }, false, { etc1Supported: true, astcSupported: true }],
  ];
  for (const [support, changed, expected] of cases) {
    const loader = new OwnedKtx2Loader();
    loader.workerConfig = config(support);
    assert.equal(loader.preferCompactTranscode(), changed, JSON.stringify(support));
    assert.deepEqual(loader.workerConfig, config(expected), JSON.stringify(support));
  }
  const undetected = new OwnedKtx2Loader();
  assert.equal(undetected.preferCompactTranscode(), false, 'support must be detected first');
  const started = new OwnedKtx2Loader();
  started.workerConfig = config({ bptcSupported: true, dxtSupported: true });
  started.transcoderPending = Promise.resolve();
  assert.equal(started.preferCompactTranscode(), false, 'workers already hold a snapshot of the configuration');
  assert.equal(started.workerConfig.bptcSupported, true);
});

test('GlbLoader applies the preference right after support detection and reports a copy of the configuration', () => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, '__WORLD_DEPLOYMENT__');
  Object.defineProperty(globalThis, '__WORLD_DEPLOYMENT__', { configurable: true, value: createWorldDeployment({ appBase: '/', pages: false }) });
  try {
    const extensions = new Set(['WEBGL_compressed_texture_s3tc', 'EXT_texture_compression_bptc']);
    const renderer = { extensions: { has: (name: string) => extensions.has(name) } } as unknown as ConstructorParameters<typeof GlbLoader>[0];
    const compact = new GlbLoader(renderer, { compactTranscode: true }), standard = new GlbLoader(renderer);
    assert.equal(compact.transcodeConfig().bptcSupported, false); assert.equal(compact.transcodeConfig().dxtSupported, true);
    assert.equal(standard.transcodeConfig().bptcSupported, true);
    const copy = compact.transcodeConfig(); copy.bptcSupported = true;
    assert.equal(compact.transcodeConfig().bptcSupported, false, 'callers cannot change the worker configuration');
    compact.dispose(); standard.dispose();
  } finally {
    if (prior) Object.defineProperty(globalThis, '__WORLD_DEPLOYMENT__', prior); else Reflect.deleteProperty(globalThis, '__WORLD_DEPLOYMENT__');
  }
});

test('texture census reports formats and memory by supercompression class without double counting', () => {
  const compressed = (bytes: number, format: number, supercompression?: 'zstd' | 'basislz' | 'none') => {
    const texture = new THREE.CompressedTexture([{ data: new Uint8Array(bytes), width: 4, height: 4 }], 4, 4, format as THREE.CompressedPixelFormat);
    if (supercompression) texture.userData['ktx2'] = { supercompression, mipDropped: 0 };
    return texture;
  };
  const zstd = compressed(2 ** 20, THREE.RGB_S3TC_DXT1_Format, 'zstd'), basis = compressed(2 ** 19, THREE.RGB_ETC2_Format, 'basislz');
  const untagged = compressed(2 ** 18, THREE.RGBA_BPTC_Format), raw = compressed(2 ** 18, THREE.RGBA_ASTC_4x4_Format, 'none');
  const image = new THREE.Texture({ width: 256, height: 256 }); image.generateMipmaps = false;
  const root = new THREE.Scene(), geometry = new THREE.BoxGeometry();
  root.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ map: zstd, emissiveMap: zstd })),
    new THREE.Mesh(geometry, [new THREE.MeshLambertMaterial({ map: basis }), new THREE.MeshBasicMaterial({ map: untagged, alphaMap: raw })]),
    new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ map: image })));
  const memory = textureMemory(root);
  assert.equal(memory.textures, 5); assert.equal(memory.mib, 2.25);
  assert.deepEqual(memory.byClass, { zstd: 1, basislz: .5, image: .25, other: .5 });
  assert.equal(memory.duplicateMiB, 0);
  assert.deepEqual(textureFormats(root), { compressed: { [THREE.RGB_S3TC_DXT1_Format]: 1, [THREE.RGB_ETC2_Format]: 1, [THREE.RGBA_BPTC_Format]: 1, [THREE.RGBA_ASTC_4x4_Format]: 1 }, image: 1 });
});

test('city material census counts unique materials per resident group kind', () => {
  const lambert = new THREE.MeshLambertMaterial(), basic = new THREE.MeshBasicMaterial(), geometry = new THREE.BoxGeometry();
  const detail = new THREE.Group().add(new THREE.Mesh(geometry, lambert), new THREE.Mesh(geometry, [lambert, basic]));
  const coarse = new THREE.Group().add(new THREE.Mesh(geometry, new THREE.MeshLambertMaterial()));
  const scenery = new THREE.Group().add(new THREE.InstancedMesh(geometry, new THREE.MeshStandardMaterial(), 1));
  assert.deepEqual(cityMaterials([detail], [coarse, coarse], scenery), {
    detail: { MeshLambertMaterial: 1, MeshBasicMaterial: 1 }, coarse: { MeshLambertMaterial: 1 }, scenery: { MeshStandardMaterial: 1 },
  });
  assert.deepEqual(cityMaterials([], [], null), { detail: {}, coarse: {}, scenery: {} });
});
