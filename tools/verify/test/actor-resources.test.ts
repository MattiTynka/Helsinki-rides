import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { AssetLibrary } from '../../../apps/game/src/render/assets.ts';
import { CharacterView } from '../../../apps/game/src/render/characters.ts';
import { VehicleView } from '../../../apps/game/src/render/vehicles.ts';
import type { VehicleDefinition } from '../../../packages/world-schema/src/index.ts';

const entry = createRequire(new URL('../../../apps/game/package.json', import.meta.url)).resolve('three');
const THREE = await import(new URL('./three.module.js', pathToFileURL(entry)).href);
type Disposable = { addEventListener: (event: 'dispose', callback: () => void) => void };
function disposalCount(resource: Disposable): () => number {
  let count = 0;
  resource.addEventListener('dispose', () => count++);
  return () => count;
}

function characterFixture() {
  const assets = new AssetLibrary(), source = new THREE.Group();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 1, 0, 1, 0, 0], 3));
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Array(12).fill(0), 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
  const texture = new THREE.Texture(), material = new THREE.MeshStandardMaterial({ map: texture });
  const bone = new THREE.Bone(); bone.name = 'hip';
  const socket = new THREE.Group(); socket.name = 'SOCKET_HAND_R'; bone.add(socket); source.add(bone);
  const skeleton = new THREE.Skeleton([bone]);
  for (let i = 0; i < 2; i++) {
    const mesh = new THREE.SkinnedMesh(geometry, material);
    mesh.name = `skin-${i}`; mesh.bind(skeleton); source.add(mesh);
  }
  skeleton.computeBoneTexture();
  const idle = new THREE.AnimationClip('idle', 1, [new THREE.VectorKeyframeTrack('hip.position', [0, 1], [0, 0, 0, 0, .1, 0])]);
  assets.characters.set('fixture-character', { id: 'fixture-character', scene: source, height: 1, clips: new Map([['idle', idle]]) });
  // Object3D.clone preserves a pistol's skeleton as well as its other shared
  // resources. It must never be mistaken for one of the character palettes.
  const pistol = new THREE.SkinnedMesh(geometry, material); pistol.bind(skeleton); assets.pistol = pistol;
  return { assets, source, skeleton, geometry, material, texture, idle };
}

test('character despawn releases palettes, shadow and mixer bindings while retaining shared assets', () => {
  const f = characterFixture(), parent = new THREE.Group(), shadowMaterial = new THREE.MeshBasicMaterial();
  const sharedDisposals = [f.geometry, f.material, f.texture, f.skeleton.boneTexture!, shadowMaterial].map(disposalCount);
  const view = new CharacterView(f.assets, 'fixture-character', shadowMaterial);
  parent.add(view.root);
  const palettes = new Set<InstanceType<typeof THREE.Skeleton>>();
  view.model.traverse((node: InstanceType<typeof THREE.Object3D>) => {
    const mesh = node as InstanceType<typeof THREE.SkinnedMesh>;
    if (mesh.isSkinnedMesh && mesh !== view.pistol) palettes.add(mesh.skeleton);
  });
  assert.equal(palettes.size, 2);
  const paletteDisposals = [...palettes].map(skeleton => {
    assert.notEqual(skeleton, f.skeleton);
    skeleton.computeBoneTexture();
    return disposalCount(skeleton.boneTexture!);
  });
  const shadowDisposals = disposalCount(view.shadow.geometry);
  view.prepareForRender(); view.mixer.update(.1);
  assert.ok(view.mixer.stats.actions.inUse > 0);
  assert.ok(view.mixer.stats.bindings.inUse > 0);
  const sourceClip = JSON.stringify(f.idle.toJSON());
  view.dispose(); view.dispose();
  assert.equal(view.root.parent, null);
  assert.equal(parent.children.length, 0);
  assert.equal(shadowDisposals(), 1);
  assert.deepEqual(paletteDisposals.map(count => count()), [1, 1]);
  assert.ok([...palettes].every(skeleton => skeleton.boneTexture === null));
  assert.equal(view.mixer.stats.actions.total, 0);
  assert.equal(view.mixer.stats.bindings.total, 0);
  assert.deepEqual(sharedDisposals.map(count => count()), [0, 0, 0, 0, 0]);
  assert.equal(JSON.stringify(f.idle.toJSON()), sourceClip);
  const sibling = new CharacterView(f.assets, 'fixture-character', shadowMaterial);
  sibling.mixer.update(.1);
  assert.equal((sibling.model.getObjectByName('skin-0') as InstanceType<typeof THREE.SkinnedMesh>).geometry, f.geometry);
  sibling.dispose();
});

function vehicleFixture() {
  const assets = new AssetLibrary(), source = new THREE.Group();
  const geometry = new THREE.BoxGeometry(1, 1, 2), texture = new THREE.Texture();
  const material = new THREE.MeshStandardMaterial({ name: 'car_body', map: texture });
  source.add(new THREE.Mesh(geometry, material));
  const lampSources = ['car_lamp_head', 'car_lamp_tail', 'car_lamp_blue', 'car_lamp_marker'].map(name => new THREE.MeshStandardMaterial({ name, map: texture }));
  for (const lamp of lampSources) source.add(new THREE.Mesh(geometry, lamp));
  // Exercise array materials and independent copies of a reused source lamp.
  source.add(new THREE.Mesh(geometry, [material, lampSources[0]!, lampSources[0]!]));
  const farBody = new THREE.BoxGeometry(1, 1, 2), farLamp = new THREE.PlaneGeometry(.1, .1);
  assets.vehicles.set('fixture-car', { id: 'fixture-car', scene: source, far: { body: farBody, lamps: new Map([['car_lamp_head', farLamp]]) } });
  const definition = { assetId: 'fixture-car', wheels: [], wheelRadius: 0.3, collider: { halfExtents: [1, 1, 2], centre: [0, 1, 0] } } as unknown as VehicleDefinition;
  return { assets, source, geometry, material, texture, lampSources, farBody, farLamp, definition };
}

test('hidden character bounds wait until the first visible frame and include its latest transform', () => {
  const f = characterFixture(), view = new CharacterView(f.assets, 'fixture-character', new THREE.MeshBasicMaterial());
  const mesh = view.model.getObjectByName('skin-0') as InstanceType<typeof THREE.SkinnedMesh>;
  view.root.visible = false;
  view.root.position.set(100, 0, 200);
  view.prepareForRender();
  assert.equal(mesh.boundingSphere, null);
  view.root.visible = true;
  view.prepareForRender();
  assert.ok(mesh.boundingSphere && Number.isFinite(mesh.boundingSphere.radius));
  assert.equal(view.root.matrixWorld.elements[12], 100);
  assert.equal(view.root.matrixWorld.elements[14], 200);
  view.dispose();
});

test('vehicle despawn releases every private lamp once across both LODs and retains shared resources', () => {
  const f = vehicleFixture(), parent = new THREE.Group(), shadowMaterial = new THREE.MeshBasicMaterial();
  const sharedDisposals = [f.geometry, f.material, f.texture, ...f.lampSources, f.farBody, f.farLamp, f.assets.farMaterial, shadowMaterial].map(disposalCount);
  const view = new VehicleView(f.assets, 'fixture', f.definition, shadowMaterial, 20);
  parent.add(view.root);
  const materials = new Set<InstanceType<typeof THREE.Material>>();
  view.lod.traverse((node: InstanceType<typeof THREE.Object3D>) => {
    const mesh = node as InstanceType<typeof THREE.Mesh>;
    if (!mesh.isMesh) return;
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (material.name.startsWith('car_lamp')) materials.add(material);
    }
  });
  assert.equal(materials.size, 6, 'the distant LOD reuses this instance headlamp rather than owning another copy');
  assert.ok([...materials].every(material => !f.lampSources.includes(material)));
  const materialDisposals = [...materials].map(disposalCount), shadowDisposals = disposalCount(view.shadow.geometry);
  view.dispose(); view.dispose();
  assert.equal(view.root.parent, null);
  assert.equal(parent.children.length, 0);
  assert.equal(shadowDisposals(), 1);
  assert.deepEqual(materialDisposals.map(count => count()), new Array(6).fill(1));
  assert.deepEqual(sharedDisposals.map(count => count()), new Array(sharedDisposals.length).fill(0));
  const sibling = new VehicleView(f.assets, 'sibling', f.definition, shadowMaterial, 20);
  assert.equal((sibling.lod.levels[1]!.object.children[0] as InstanceType<typeof THREE.Mesh>).geometry, f.farBody);
  sibling.dispose();
});

test('repeated actor spawn and despawn leaves no owned GPU resources alive', () => {
  const character = characterFixture(), vehicle = vehicleFixture(), parent = new THREE.Group(), shadowMaterial = new THREE.MeshBasicMaterial();
  let liveGeometries = 0, liveMaterials = 0, livePalettes = 0;
  for (let i = 0; i < 40; i++) {
    const person = new CharacterView(character.assets, 'fixture-character', shadowMaterial);
    const car = new VehicleView(vehicle.assets, `car-${i}`, vehicle.definition, shadowMaterial, 20);
    parent.add(person.root, car.root);
    for (const view of [person, car]) {
      liveGeometries++;
      view.shadow.geometry.addEventListener('dispose', () => liveGeometries--);
    }
    const materials = new Set<InstanceType<typeof THREE.Material>>();
    car.lod.traverse((node: InstanceType<typeof THREE.Object3D>) => {
      const mesh = node as InstanceType<typeof THREE.Mesh>;
      if (!mesh.isMesh) return;
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) if (material.name.startsWith('car_lamp')) materials.add(material);
    });
    for (const material of materials) {
      liveMaterials++; material.addEventListener('dispose', () => liveMaterials--);
    }
    person.model.traverse((node: InstanceType<typeof THREE.Object3D>) => {
      const mesh = node as InstanceType<typeof THREE.SkinnedMesh>;
      if (!mesh.isSkinnedMesh || mesh === person.pistol) return;
      mesh.skeleton.computeBoneTexture(); livePalettes++;
      mesh.skeleton.boneTexture!.addEventListener('dispose', () => livePalettes--);
    });
    person.dispose(); car.dispose();
    assert.deepEqual([liveGeometries, liveMaterials, livePalettes, parent.children.length], [0, 0, 0, 0], `cycle ${i}`);
  }
});

test('an existing vehicle view switches to its far level at a new detail range', () => {
  const f = vehicleFixture(), view = new VehicleView(f.assets, 'fixture', f.definition, new THREE.MeshBasicMaterial(), 60);
  const camera = new THREE.PerspectiveCamera(); camera.position.set(0, 0, 45); camera.updateMatrixWorld();
  view.root.updateMatrixWorld(true);
  view.lod.update(camera);
  assert.equal(view.lod.getCurrentLevel(), 0, 'detailed within 60 m');
  view.setDetailRange(30);
  assert.equal(view.lod.levels[1]!.distance, 30);
  view.lod.update(camera);
  assert.equal(view.lod.getCurrentLevel(), 1, 'the same car is far detail at 45 m with a 30 m range');
  for (const invalid of [Number.NaN, 0, -5, Number.POSITIVE_INFINITY]) view.setDetailRange(invalid);
  assert.equal(view.lod.levels[1]!.distance, 30, 'invalid ranges are ignored');
  view.dispose();
});
