import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { inspectTextureOwnership, textureStorageBytes } from '../../../apps/game/src/review/texture-ownership.ts';

const entry = createRequire(new URL('../../../apps/game/package.json', import.meta.url)).resolve('three');
const THREE = await import(new URL('./three.module.js', pathToFileURL(entry)).href);
const image = () => { const t = new THREE.Texture({ width: 8, height: 4 }); t.generateMipmaps = true; return t; };
const mesh = (texture: any) => new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ map: texture }));
function properties() {
  const entries = new Map<object, Record<string, unknown>>();
  return { entries, has: (key: object) => entries.has(key), get: (key: object) => {
    assert.ok(entries.has(key), 'Diagnostic must not ask renderer to create properties for an unuploaded/disposed object'); return entries.get(key)!;
  } };
}

test('shared GPU handles count once while logical ownership and source sharing remain visible', () => {
  const a = image(), b = a.clone(), root = new THREE.Group().add(mesh(a), mesh(b)), props = properties(), allocation = {};
  props.entries.set(a, { __webglTexture: allocation }); props.entries.set(b, { __webglTexture: allocation });
  const s = inspectTextureOwnership(root, props, 1);
  assert.equal(s.materialTextureHandles, 2); assert.equal(s.logicalTextureHandles, 2); assert.equal(s.ownedGpuTextures, 1);
  assert.equal(s.ownedGpuBytes, 172); assert.equal(s.sharedBytesSaved, 172); assert.equal(s.sharedHandleSavings, 1);
  assert.deepEqual(s.sharedAllocations[0]!.sourceIds, [a.source.id]); assert.equal(s.unaccountedGpuTextures, 0);
  assert.equal(JSON.stringify(s).includes('__webglTexture'), false, 'No GL allocation objects are exposed');
});

test('sampler variants or sequentially decoded Sources retain separate physical allocations', () => {
  const a = image(), sampler = a.clone(), separate = image(), props = properties(); sampler.wrapS = THREE.RepeatWrapping;
  const root = new THREE.Group().add(mesh(a), mesh(sampler), mesh(separate));
  for (const t of [a, sampler, separate]) props.entries.set(t, { __webglTexture: {} });
  const s = inspectTextureOwnership(root, props, 3);
  assert.equal(s.logicalTextureHandles, 3); assert.equal(s.ownedGpuTextures, 3); assert.equal(s.ownedGpuBytes, 516); assert.equal(s.sharedBytesSaved, 0);
});

test('never uploaded and disposed textures remain logical owners without invented allocations', () => {
  const waiting = image(), disposed = image(), active = image(), props = properties();
  const root = new THREE.Group().add(mesh(waiting), mesh(disposed), mesh(active)); root.visible = false;
  props.entries.set(disposed, { __webglTexture: {} }); props.entries.delete(disposed); props.entries.set(active, { __webglTexture: {} });
  const s = inspectTextureOwnership(root, props, 2);
  assert.equal(s.logicalTextureHandles, 3); assert.equal(s.unuploadedTextureHandles, 2); assert.equal(s.ownedGpuTextures, 1);
  assert.equal(s.unaccountedGpuTextures, 1, 'Unknown renderer allocations remain an explicit failure signal');
});

test('bone palettes and compiled DFG uniforms account their actual scalar storage once', () => {
  const root = new THREE.Group(), props = properties(), material = new THREE.MeshStandardMaterial();
  const skeleton = new THREE.Skeleton(Array.from({ length: 71 }, () => new THREE.Bone())); skeleton.computeBoneTexture();
  const a = new THREE.SkinnedMesh(new THREE.BufferGeometry(), material), b = new THREE.SkinnedMesh(new THREE.BufferGeometry(), material);
  a.skeleton = b.skeleton = skeleton; root.add(a, b);
  const lut = new THREE.DataTexture(new Uint16Array(16 * 16 * 2), 16, 16, THREE.RGFormat, THREE.HalfFloatType);
  props.entries.set(material, { uniforms: { dfgLUT: { value: lut }, duplicate: { value: lut } } });
  props.entries.set(skeleton.boneTexture!, { __webglTexture: {} }); props.entries.set(lut, { __webglTexture: {} });
  const s = inspectTextureOwnership(root, props, 2);
  assert.equal(s.materialTextureHandles, 0); assert.equal(s.boneTextureHandles, 1); assert.equal(s.logicalTextureHandles, 2);
  assert.equal(s.uniformTextureHandles, 1); assert.equal(s.ownedGpuBytes, 20 * 20 * 16 + 16 * 16 * 4);
  assert.equal(s.unaccountedGpuTextures, 0); assert.equal(s.uniformAllocations[0]!.bytes, 1024);
  assert.deepEqual(s.uniformAllocations[0]!.uniforms, ['dfgLUT', 'duplicate']);
});

test('compressed allocations include every uploaded mip exactly', () => {
  const t = new THREE.CompressedTexture([{ data: new Uint8Array(64), width: 8, height: 8 },
    { data: new Uint8Array(16), width: 4, height: 4 }, { data: new Uint8Array(16), width: 2, height: 2 },
    { data: new Uint8Array(16), width: 1, height: 1 }], 8, 8, THREE.RGBA_BPTC_Format);
  assert.equal(textureStorageBytes(t), 112);
});

test('unknown allocated storage and conflicting alias sizes cannot pass as zero measured bytes', () => {
  const override = image(); override.internalFormat = 'RGBA16F';
  assert.equal(textureStorageBytes(override), null, 'Upload component size alone cannot size overridden GPU storage');
  const unknown = image(); unknown.type = THREE.UnsignedInt248Type;
  const a = image(), b = image(); b.image = { width: 16, height: 16 };
  const props = properties(), shared = {}; props.entries.set(a, { __webglTexture: shared }); props.entries.set(b, { __webglTexture: shared });
  props.entries.set(unknown, { __webglTexture: {} });
  const s = inspectTextureOwnership(new THREE.Group().add(mesh(a), mesh(b), mesh(unknown)), props, 2);
  assert.equal(s.unmeasuredGpuTextures, 2); assert.equal(s.unaccountedGpuTextures, 0); assert.equal(s.ownedGpuBytes, 0);
  assert.equal(s.unmeasuredTextureIds.length, 3);
});
