import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { partitionCoarseCell } from '../../../apps/game/src/render/coarse-batching.ts';
import { disposeCellResources, geometryBytesOf } from '../../../apps/game/src/render/cell-resources.ts';
import { CityScene } from '../../../apps/game/src/render/scene.ts';

const entry = createRequire(new URL('../../../apps/game/package.json', import.meta.url)).resolve('three');
const THREE = await import(new URL('./three.module.js', pathToFileURL(entry)).href);

function fixture(indexed = true) {
  const root = new THREE.Group(), geometry = new THREE.BufferGeometry();
  const positions = [0, 0, -10, 1, 0, -10, 0, 1, -10, 128, 0, -10, 129, 0, -10, 128, 1, -10, 256, 0, -10, 257, 0, -10, 256, 1, -10];
  if (indexed) positions.push(9999, 9999, 9999); // Deliberately unreferenced: bounds must ignore it.
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const count = positions.length / 3, packed = new THREE.InterleavedBuffer(new Float32Array(count * 5).map((_, i) => i / 17), 5);
  geometry.setAttribute('normal', new THREE.InterleavedBufferAttribute(packed, 3, 0));
  geometry.setAttribute('uv', new THREE.InterleavedBufferAttribute(packed, 2, 3));
  geometry.setAttribute('color', new THREE.Uint8BufferAttribute(new Uint8Array(count * 4).map((_, i) => i * 7), 4, true));
  if (indexed) geometry.setIndex([0, 1, 2, 3, 4, 5, 0, 1, 2, 6, 7, 8]); // Includes an identical repeated triangle.
  const material = new THREE.MeshStandardMaterial(), mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'source'; root.add(mesh); root.updateMatrixWorld(true);
  return { root, geometry, material, mesh };
}
function meshes(root: any): any[] {
  const result: any[] = []; root.traverse((node: any) => { if (node.isMesh) result.push(node); }); return result;
}
function triangles(root: any): string[] {
  root.updateWorldMatrix(true, true);
  const result: string[] = [], p = new THREE.Vector3();
  for (const mesh of meshes(root)) {
    const geometry = mesh.geometry, count = geometry.index?.count ?? geometry.getAttribute('position').count;
    for (let start = 0; start < count; start += 3) {
      const vertices = [];
      for (let k = 0; k < 3; k++) {
        const id = geometry.index ? geometry.index.getX(start + k) : start + k;
        const attributes = Object.entries(geometry.attributes).map(([name, attribute]) => {
          const a = attribute as any; return [name, Array.from({ length: a.itemSize }, (_, component) => a.getComponent(id, component))];
        });
        vertices.push([p.fromBufferAttribute(geometry.getAttribute('position'), id).applyMatrix4(mesh.matrixWorld).toArray(), attributes]);
      }
      result.push(JSON.stringify(vertices));
    }
  }
  return result.sort();
}

test('every indexed/nonindexed triangle, winding and attribute binding survives exactly once', () => {
  for (const indexed of [true, false]) {
    const f = fixture(indexed), before = triangles(f.root), attributes = { ...f.geometry.attributes };
    const bytes = Object.values(attributes).map((a: any) => Array.from((a.data ?? a).array));
    const result = partitionCoarseCell(f.root);
    assert.deepEqual(result, { meshes: 1, batches: 3 }); assert.deepEqual(triangles(f.root), before);
    for (const batch of meshes(f.root)) {
      assert.equal(batch.material, f.material);
      for (const [name, attribute] of Object.entries(attributes)) assert.equal(batch.geometry.getAttribute(name), attribute);
    }
    assert.deepEqual(Object.values(attributes).map((a: any) => Array.from((a.data ?? a).array)), bytes);
    assert.equal(f.mesh.parent, null); assert.equal(f.geometry.index, null); assert.deepEqual(Object.keys(f.geometry.attributes), []);
    assert.deepEqual(partitionCoarseCell(f.root), { meshes: 0, batches: 0 }, 'already bucketed subsets do not split again');
  }
});

test('subset-only bounds restore offscreen culling while retaining triangles crossing bucket boundaries', () => {
  const f = fixture(); partitionCoarseCell(f.root);
  const camera = new THREE.PerspectiveCamera(60, 1, .1, 300); camera.updateMatrixWorld(true);
  const frustum = new THREE.Frustum().setFromProjectionMatrix(camera.projectionMatrix.clone().multiply(camera.matrixWorldInverse));
  const batches = meshes(f.root);
  assert.deepEqual(batches.map(batch => frustum.intersectsObject(batch)), [true, false, false]);
  for (const batch of batches) {
    const geometry = batch.geometry, box = new THREE.Box3(), p = new THREE.Vector3();
    for (const id of geometry.index.array) {
      p.fromBufferAttribute(geometry.getAttribute('position'), id); box.expandByPoint(p);
      assert.ok(geometry.boundingSphere.containsPoint(p));
    }
    assert.ok(geometry.boundingBox.equals(box)); assert.ok(geometry.boundingSphere.radius < 1);
  }
  const crossing = fixture(false);
  crossing.geometry.getAttribute('position').setXYZ(0, -200, 0, -10);
  crossing.geometry.getAttribute('position').setXYZ(1, 200, 0, -10);
  partitionCoarseCell(crossing.root);
  const wide = meshes(crossing.root).find(mesh => mesh.geometry.index.array.includes(0));
  assert.ok(frustum.intersectsObject(wide), 'centroid bucketing never clips a crossing triangle');
});

test('nested local/world transforms, children, flags and sibling order remain intact, including shear', () => {
  const f = fixture(), parent = new THREE.Group(), child = new THREE.Object3D(), sibling = new THREE.Object3D();
  f.root.remove(f.mesh); f.root.add(parent); parent.add(sibling, f.mesh); f.mesh.add(child);
  f.root.position.set(5, 3, -7); f.root.rotation.set(.2, -.3, .4); f.root.scale.set(3, .4, 2);
  parent.rotation.set(.5, .9, .1); parent.scale.set(.3, 4, 1.3);
  f.mesh.position.set(3, 4, 5); f.mesh.rotation.set(.3, -.7, .2); f.mesh.scale.set(-1.2, 2, .7);
  f.mesh.layers.set(3); f.mesh.renderOrder = 7; f.mesh.castShadow = true; f.mesh.receiveShadow = true;
  child.position.set(3, 2, 1); f.root.updateMatrixWorld(true);
  const before = triangles(f.root), originalWorld = f.mesh.matrixWorld.clone(), childWorld = child.matrixWorld.clone();
  const result = partitionCoarseCell(f.root); assert.equal(result.meshes, 1);
  assert.equal(parent.children[0], sibling); assert.equal(child.parent, parent.children[1]); assert.ok(child.matrixWorld.equals(childWorld));
  assert.deepEqual(triangles(f.root), before);
  for (const batch of meshes(f.root)) {
    assert.ok(batch.matrixWorld.equals(originalWorld)); assert.equal(batch.layers.mask, 1 << 3); assert.equal(batch.renderOrder, 7);
    assert.equal(batch.castShadow, true); assert.equal(batch.receiveShadow, true);
    const sphere = batch.geometry.boundingSphere.clone().applyMatrix4(batch.matrixWorld), p = new THREE.Vector3();
    for (const id of batch.geometry.index.array) {
      p.fromBufferAttribute(batch.geometry.getAttribute('position'), id).applyMatrix4(batch.matrixWorld);
      assert.ok(sphere.containsPoint(p), 'actual Three-transformed sphere includes all vertices even under parent shear');
    }
  }
});

test('nested partitioned meshes preserve child geometry and live shared geometry prevents premature retirement', () => {
  const f = fixture(), nested = fixture(); f.mesh.add(nested.mesh);
  const transparent = new THREE.Mesh(f.geometry, new THREE.MeshBasicMaterial({ transparent: true })); f.root.add(transparent);
  const before = triangles(f.root); let retired = 0; f.geometry.addEventListener('dispose', () => retired++);
  assert.equal(partitionCoarseCell(f.root).meshes, 2); assert.equal(retired, 0);
  assert.ok(f.geometry.index); assert.ok(f.geometry.getAttribute('position')); assert.deepEqual(triangles(f.root), before);
  assert.equal(transparent.parent, f.root);
});

test('cell bytes deduplicate shared attributes and each unload disposes all subset resources exactly once', () => {
  for (let cycle = 0; cycle < 4; cycle++) {
    const f = fixture(), expectedBytes = geometryBytesOf(f.root), events = { retired: 0, material: 0, texture: 0 };
    const texture = new THREE.Texture(); f.material.map = texture;
    f.geometry.addEventListener('dispose', () => events.retired++); f.material.addEventListener('dispose', () => events.material++);
    texture.addEventListener('dispose', () => events.texture++);
    partitionCoarseCell(f.root); assert.equal(geometryBytesOf(f.root), expectedBytes);
    assert.deepEqual(events, { retired: 1, material: 0, texture: 0 });
    const subsets = meshes(f.root).map(mesh => mesh.geometry), disposed = new Map<any, number>();
    for (const geometry of subsets) geometry.addEventListener('dispose', () => disposed.set(geometry, (disposed.get(geometry) ?? 0) + 1));
    disposeCellResources(f.root);
    assert.equal(f.root.children.length, 0); assert.equal(geometryBytesOf(f.root), 0);
    assert.deepEqual([...disposed.values()], [1, 1, 1]); assert.deepEqual(events, { retired: 1, material: 1, texture: 1 });
  }
});

test('unsupported groups, morphs, partial ranges, deformation and invalid geometry remain untouched', () => {
  const cases: Array<(f: ReturnType<typeof fixture>) => void> = [
    f => f.geometry.addGroup(0, 3, 0), f => { f.geometry.morphAttributes.position = [f.geometry.getAttribute('position').clone()]; },
    f => f.geometry.setDrawRange(3, 3), f => { f.material.transparent = true; }, f => { f.mesh.animations.push(new THREE.AnimationClip()); },
    f => { f.mesh.material = [f.material]; }, f => { f.mesh.material = new THREE.ShaderMaterial(); },
    f => { f.material.displacementMap = new THREE.Texture(); }, f => { f.mesh.onBeforeRender = () => {}; },
    f => { f.material.onBeforeCompile = () => {}; }, f => { f.mesh.geometry.index.setX(0, 9999); },
    f => { f.geometry.getAttribute('position').setX(0, NaN); },
    f => { f.mesh.matrixAutoUpdate = false; f.mesh.matrix.elements[3] = .1; },
  ];
  for (const alter of cases) {
    const f = fixture(); alter(f); const index = f.geometry.index, attributes = { ...f.geometry.attributes }; let disposed = 0;
    f.geometry.addEventListener('dispose', () => disposed++);
    assert.deepEqual(partitionCoarseCell(f.root), { meshes: 0, batches: 0 });
    assert.equal(f.mesh.parent, f.root); assert.equal(f.geometry.index, index); assert.deepEqual(f.geometry.attributes, attributes); assert.equal(disposed, 0);
  }
});

test('CityScene partitions exclusively low/lod2 and preserves complete cell triangle/memory accounting', async () => {
  for (const [preset, lod, expected] of [['low', 'lod2', 3], ['standard', 'lod2', 1], ['low', 'lod0', 1]] as const) {
    const f = fixture(), originalBytes = geometryBytesOf(f.root);
    const city = Object.assign(Object.create(CityScene.prototype), { lighting: 'lit', preset }) as CityScene;
    const loader = { load: async () => ({ scene: f.root }) } as unknown as Parameters<CityScene['loadCell']>[0];
    const descriptor = { id: 'test', visual: { lod0: { path: 'full.glb' }, lod2: { path: 'coarse.glb' } } } as Parameters<CityScene['loadCell']>[2];
    const view = await city.loadCell(loader, '/', descriptor, lod);
    assert.equal(meshes(view.group).length, expected); assert.equal(view.triangles, 4); assert.equal(view.geometryBytes, originalBytes);
    disposeCellResources(view.group);
  }
});
