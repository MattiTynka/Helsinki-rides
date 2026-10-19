import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { AssetLibrary } from '../../../apps/game/src/render/assets.ts';
import type { GlbLoader } from '../../../apps/game/src/world/loader.ts';
import type { WorldManifest } from '../../../packages/world-schema/src/index.ts';

const entry = createRequire(new URL('../../../apps/game/package.json', import.meta.url)).resolve('three');
const THREE = await import(new URL('./three.module.js', pathToFileURL(entry)).href);
const manifest = { assets: [
  { id: 'vehicle-lumi-gt-far-low', kind: 'prop', path: 'far.glb' },
  { id: 'vehicle-lumi-gt', kind: 'vehicle', path: 'near.glb' },
] } as unknown as WorldManifest;

function car(segments: number) {
  const scene = new THREE.Group(), geometry = new THREE.BoxGeometry(1, 1, 2, segments, segments, segments);
  const material = new THREE.MeshStandardMaterial({ color: 0xaa0000 });
  const body = new THREE.Mesh(geometry, material); body.name = 'BODY'; scene.add(body);
  const door = new THREE.Group(); door.name = 'DOOR_FL'; door.position.set(1, 0, 0); scene.add(door);
  const wheel = new THREE.Group(); wheel.name = 'WHEEL_FL'; wheel.position.set(1, .3, 1); scene.add(wheel);
  const light = new THREE.Mesh(new THREE.PlaneGeometry(.1, .1), new THREE.MeshStandardMaterial({ name: 'car_lamp_head' }));
  light.name = 'headlight'; scene.add(light);
  return { scene, geometry, material };
}

test('optional far geometry wins regardless of arrival order and releases its temporary source', async () => {
  const near = car(3), far = car(1), assets = new AssetLibrary();
  const disposed = { near: 0, far: 0, farMaterial: 0 };
  near.geometry.addEventListener('dispose', () => disposed.near++);
  far.geometry.addEventListener('dispose', () => disposed.far++);
  far.material.addEventListener('dispose', () => disposed.farMaterial++);
  let releaseNear!: () => void;
  const nearReady = new Promise<void>(resolve => { releaseNear = resolve; });
  const loader = { load: async (url: string) => { if (url.endsWith('near.glb')) await nearReady; return { scene: url.endsWith('near.glb') ? near.scene : far.scene }; } } as unknown as GlbLoader;
  const loading = assets.load(loader, '/', manifest, true); releaseNear(); await loading;
  const selected = assets.vehicles.get('vehicle-lumi-gt')!;
  assert.equal(selected.scene, near.scene);
  assert.equal(selected.far.body.attributes.position!.count, 36);
  assert.equal(selected.far.lamps.get('car_lamp_head')!.attributes.position!.count, 6);
  assert.deepEqual(disposed, { near: 0, far: 1, farMaterial: 1 });
  const clone = assets.cloneVehicle('vehicle-lumi-gt');
  assert.equal((clone.getObjectByName('BODY') as InstanceType<typeof THREE.Mesh>).geometry, near.geometry);
  assert.deepEqual(clone.getObjectByName('DOOR_FL')!.position.toArray(), [1, 0, 0]);
  assert.deepEqual(clone.getObjectByName('WHEEL_FL')!.position.toArray(), [1, .3, 1]);
});

test('standard preset skips optional payloads and legacy releases retain their accepted merged far mesh', async () => {
  for (const optional of [true, false]) {
    const near = car(3), assets = new AssetLibrary(), loaded: string[] = [];
    const loader = { load: async (url: string) => { loaded.push(url); return { scene: near.scene }; } } as unknown as GlbLoader;
    const input = optional ? manifest : { assets: manifest.assets.filter(asset => asset.kind === 'vehicle') } as unknown as WorldManifest;
    await assets.load(loader, '/', input, !optional);
    assert.deepEqual(loaded, ['/near.glb']);
    assert.equal(assets.vehicles.get('vehicle-lumi-gt')!.far.body.attributes.position!.count, 324);
  }
});
