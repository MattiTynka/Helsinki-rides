import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { CityScene } from '../../../apps/game/src/render/scene.ts';
import { UploadQueue } from '../../../apps/game/src/render/upload-queue.ts';

const entry = createRequire(new URL('../../../apps/game/package.json', import.meta.url)).resolve('three');
const THREE = await import(new URL('./three.module.js', pathToFileURL(entry)).href);

// Replace only the GPU boundary; exercise the production preparation and state restoration with real scene objects.
function fixture(parallel: boolean, failDraw = false) {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
  const existing = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  const light = new THREE.DirectionalLight(); scene.add(existing, light);
  const root = new THREE.Group(); root.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()));
  const originalTarget = new THREE.WebGLRenderTarget(8, 8);
  const viewport = new THREE.Vector4(1, 2, 3, 4), scissor = new THREE.Vector4(5, 6, 7, 8);
  let target = originalTarget, face = 2, level = 1, scissorTest = true, draws = 0;
  let complete!: () => void;
  const compiling = new Promise<void>(resolve => { complete = resolve; });
  const renderer = {
    properties: { has: () => false }, outputColorSpace: THREE.SRGBColorSpace, autoClear: false,
    compileAsync: () => compiling, getContext: () => ({ getExtension: () => parallel ? {} : null }),
    getRenderTarget: () => target, getActiveCubeFace: () => face, getActiveMipmapLevel: () => level,
    getViewport: (v: InstanceType<typeof THREE.Vector4>) => v.copy(viewport),
    getScissor: (v: InstanceType<typeof THREE.Vector4>) => v.copy(scissor), getScissorTest: () => scissorTest,
    setRenderTarget: (t: typeof target, f = 0, l = 0) => { target = t; face = f; level = l; },
    setViewport: (v: typeof viewport) => viewport.copy(v), setScissor: (v: typeof scissor) => scissor.copy(v),
    setScissorTest: (v: boolean) => { scissorTest = v; },
    render: (s: typeof scene) => {
      assert.equal(s, scene); assert.ok(root.parent === scene); assert.equal(existing.visible, false);
      assert.equal(light.visible, true); assert.equal(root.children[0]!.frustumCulled, false);
      assert.notEqual(target, originalTarget); assert.equal(target.texture.colorSpace, THREE.SRGBColorSpace);
      assert.equal((target as unknown as { isXRRenderTarget: boolean }).isXRRenderTarget, true);
      draws++; if (failDraw) throw new Error('GPU draw failed');
    },
  };
  const uploads = new UploadQueue({ requestFrame: callback => Number(setTimeout(callback, 0)), cancelFrame: clearTimeout });
  const city = Object.assign(Object.create(CityScene.prototype), { scene, camera, renderer, uploads, offscreen: null, parallelCompile: null }) as CityScene;
  return { city, root, complete, draws: () => draws, restored: () => {
    assert.equal(root.parent, null); assert.equal(root.children[0]!.frustumCulled, true);
    assert.equal(existing.visible, true); assert.equal(light.visible, true); assert.equal(target, originalTarget);
    assert.equal(face, 2); assert.equal(level, 1); assert.equal(renderer.autoClear, false); assert.equal(scissorTest, true);
    assert.deepEqual(viewport.toArray(), [1, 2, 3, 4]); assert.deepEqual(scissor.toArray(), [5, 6, 7, 8]); uploads.dispose();
  } };
}

for (const parallel of [true, false]) test(`preparation finishes the first GPU draw before publication (parallel compilation ${parallel})`, async () => {
  const f = fixture(parallel); let published = false;
  const preparing = f.city.prepareObject(f.root).then(() => { published = true; });
  await Promise.resolve(); assert.equal(published, false); assert.equal(f.draws(), 0);
  f.complete(); await preparing;
  assert.equal(f.draws(), 1, 'completed shader linking alone must not publish a never-drawn model'); f.restored();
});

test('a failed warm-up draw rejects publication and restores the renderer', async () => {
  const f = fixture(true, true), preparing = f.city.prepareObject(f.root); f.complete();
  await assert.rejects(preparing, /GPU draw failed/); assert.equal(f.draws(), 1); f.restored();
});

test('cancellation during compilation never draws or publishes', async () => {
  const f = fixture(true), abort = new AbortController(), preparing = f.city.prepareObject(f.root, abort.signal);
  await Promise.resolve(); abort.abort(); f.complete(); await assert.rejects(preparing, { name: 'AbortError' });
  assert.equal(f.draws(), 0); f.restored();
});
