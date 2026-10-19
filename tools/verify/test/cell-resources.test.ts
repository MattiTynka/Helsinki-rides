import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { CityScene, type CellView } from '../../../apps/game/src/render/scene.ts';
import { disposeCellResources, geometryBytesOf, textureBytesOf } from '../../../apps/game/src/render/cell-resources.ts';
import type { SceneryDocument } from '../../../packages/world-schema/src/index.ts';

const entry = createRequire(new URL('../../../apps/game/package.json', import.meta.url)).resolve('three');
const THREE = await import(new URL('./three.module.js', pathToFileURL(entry)).href);

function scene(): CityScene {
  return Object.assign(Object.create(CityScene.prototype), {
    scene: new THREE.Scene(), cells: new Map(), fallbackCells: new Map(), sceneryDefinitions: new Map(), sceneryCellViews: new Map(),
    sceneryMaterials: new Map(), sceneryRoot: new THREE.Group(), sceneryAssets: null, sceneryStreamed: false, lighting: 'lit', preset: 'low',
  }) as CityScene;
}
function view(id: string, lod: 'lod0' | 'lod1' | 'lod2'): CellView {
  return { id, lod, group: new THREE.Group(), triangles: 0, textureBytes: 0, geometryBytes: 0, descriptor: {} } as CellView;
}

test('cell memory is counted once per owned buffer/texture and disposal releases every unique resource', () => {
  const root = new THREE.Group(), geometry = new THREE.BoxGeometry(1, 1, 1);
  const texture = new THREE.CompressedTexture([{ data: new Uint8Array(16), width: 4, height: 4 }, { data: new Uint8Array(4), width: 2, height: 2 }], 4, 4);
  const material = new THREE.MeshStandardMaterial({ map: texture, emissiveMap: texture });
  root.add(new THREE.Mesh(geometry, material), new THREE.Mesh(geometry, material));
  assert.equal(textureBytesOf([root, root]), 20);
  const expected = Object.values(geometry.attributes).reduce((n: number, a) => n + (a as { array: ArrayBufferView }).array.byteLength, 0) + geometry.index.array.byteLength;
  assert.equal(geometryBytesOf(root), expected);
  const events = { geometry: 0, material: 0, texture: 0 };
  geometry.addEventListener('dispose', () => events.geometry++);
  material.addEventListener('dispose', () => events.material++);
  texture.addEventListener('dispose', () => events.texture++);
  new THREE.Scene().add(root);
  disposeCellResources(root);
  assert.deepEqual(events, { geometry: 1, material: 1, texture: 1 });
  assert.equal(root.parent, null); assert.equal(root.children.length, 0);
});

test('disposing an independent cell closes each owned ImageBitmap once even when several textures share its source', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'ImageBitmap');
  class Bitmap { width = 4; height = 4; closes = 0; close(): void { this.closes++; } }
  Object.defineProperty(globalThis, 'ImageBitmap', { value: Bitmap, configurable: true });
  try {
    const shared = new Bitmap(), second = new Bitmap(), actor = new Bitmap();
    const firstMap = new THREE.Texture(shared as unknown as ImageBitmap), secondMap = new THREE.Texture(shared as unknown as ImageBitmap);
    const thirdMap = new THREE.Texture(second as unknown as ImageBitmap), actorMap = new THREE.Texture(actor as unknown as ImageBitmap);
    const root = new THREE.Group();
    const material = new THREE.MeshStandardMaterial({ map: firstMap, normalMap: secondMap, emissiveMap: thirdMap });
    root.add(new THREE.Mesh(new THREE.BoxGeometry(), material), new THREE.Mesh(new THREE.BoxGeometry(), material));
    const independentActor = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ map: actorMap }));
    let textureDisposals = 0;
    [firstMap, secondMap, thirdMap, actorMap].forEach(texture => texture.addEventListener('dispose', () => textureDisposals++));
    disposeCellResources(root); disposeCellResources(root);
    assert.equal(shared.closes, 1); assert.equal(second.closes, 1); assert.equal(actor.closes, 0);
    assert.equal(textureDisposals, 3); assert.equal(independentActor.material.map, actorMap);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'ImageBitmap', previous);
    else Reflect.deleteProperty(globalThis, 'ImageBitmap');
  }
});

test('detail removal restores coarse ground and late disposal cannot detach a newer view', () => {
  const city = scene(), coarse = view('a', 'lod2'), old = view('a', 'lod0'), current = view('a', 'lod0');
  city.showCell(coarse); city.showCell(old);
  assert.equal(coarse.group.visible, false);
  city.showCell(current);
  city.disposeCell(old);
  assert.equal(city.cells.get('a'), current);
  assert.equal(current.group.parent, city.scene);
  assert.equal(coarse.group.visible, false);
  city.disposeCell(current);
  assert.equal(coarse.group.visible, true);
  assert.equal(city.cells.size, 0);
});

test('optional low-preset lod1 loads its own payload and uses the same complete-cell ownership as lod0', async () => {
  const city = scene(), urls: string[] = [];
  const loader = { load: async (url: string) => { urls.push(url); return { scene: new THREE.Group() }; } } as unknown as Parameters<CityScene['loadCell']>[0];
  const descriptor = { id: 'a', visual: { lod0: { path: 'full.glb' }, lod1: { path: 'reduced.glb' } } } as Parameters<CityScene['loadCell']>[2];
  const low = await city.loadCell(loader, '/release/', descriptor, 'lod1');
  assert.equal(low.lod, 'lod1'); assert.equal(urls[0], '/release/reduced.glb');
  const coarse = view('a', 'lod2'); city.showCell(coarse); city.showCell(low);
  assert.equal(city.cells.get('a'), low); assert.equal(coarse.group.visible, false);
  city.disposeCell(low); assert.equal(coarse.group.visible, true);
  const withoutOptional = { ...descriptor, visual: { lod0: descriptor.visual.lod0 } };
  const full = await city.loadCell(loader, '/release/', withoutOptional, 'lod1');
  assert.equal(full.lod, 'lod0'); assert.equal(urls[1], '/release/full.glb');
});

test('scene cell loading forwards cancellation through to its loader without mounting a view', async () => {
  const city = scene(), controller = new AbortController();
  let received: AbortSignal | undefined;
  const loader = { load: async (_url: string, signal?: AbortSignal) => { received = signal; return { scene: new THREE.Group() }; } } as unknown as Parameters<CityScene['loadCell']>[0];
  const descriptor = { id: 'a', visual: { lod0: { path: 'full.glb' } } } as Parameters<CityScene['loadCell']>[2];
  const loaded = await city.loadCell(loader, '/release/', descriptor, 'lod0', controller.signal);
  assert.equal(received, controller.signal); assert.equal(loaded.group.parent, null); assert.equal(city.cells.size, 0);
});

test('scenery instance buffers follow visible cells without disposing shared tree templates', () => {
  const city = scene(), tree = new THREE.Group(), trunk = new THREE.Group();
  trunk.name = 'tree';
  const geometry = new THREE.BoxGeometry(1, 3, 1), material = new THREE.MeshStandardMaterial();
  trunk.add(new THREE.Mesh(geometry, material)); tree.add(trunk);
  let disposedGeometry = 0, disposedMaterial = 0, disposedInstances = 0;
  geometry.addEventListener('dispose', () => disposedGeometry++);
  material.addEventListener('dispose', () => disposedMaterial++);
  const doc: SceneryDocument = { schemaVersion: 1, originId: 'test', frame: 'test', assets: [], instances: [
    { id: 'first', asset: 'trees', node: 'tree', position: [10, 0, 10], yaw: 0, scale: [1, 1, 1] },
    { id: 'second', asset: 'trees', node: 'tree', position: [1010, 0, 10], yaw: 0, scale: [1, 1, 1] },
  ] };
  const scenery = city.addScenery(doc, new Map([['trees', tree]]), 128, true);
  assert.equal(city.sceneryStats().residentInstances, 0);
  const near = view('c_p00_p00', 'lod2'); city.showCell(near);
  assert.equal(city.sceneryStats().residentInstances, 1);
  scenery.traverse(node => { if ((node as unknown as { isInstancedMesh?: boolean }).isInstancedMesh) node.addEventListener('dispose' as never, () => { disposedInstances++; }); });
  city.disposeCell(near);
  assert.equal(city.sceneryStats().residentInstances, 0);
  assert.equal(disposedInstances, 1);
  assert.equal(disposedGeometry, 0); assert.equal(disposedMaterial, 0);
  city.showCell(view('c_p07_p00', 'lod2'));
  assert.equal(city.sceneryStats().residentInstances, 1);
});

test('low tree culling batches preserve every exact transform inside the same resident city cell', () => {
  const city = scene(), tree = new THREE.Group(), template = new THREE.Mesh(new THREE.BoxGeometry(1, 3, 1), new THREE.MeshStandardMaterial());
  template.name = 'tree'; tree.add(template);
  const positions = [[10, 0, 10], [45, 2, 10], [90, 3, 80]] as const;
  const doc: SceneryDocument = { schemaVersion: 1, originId: 'test', frame: 'test', assets: [], instances: positions.map((position, i) => ({
    id: `tree-${i}`, asset: 'trees', node: 'tree', position: [...position], yaw: i * .2, scale: [1, 2, 1],
  })) };
  const scenery = city.addScenery(doc, new Map([['trees', tree]]), 128, true), cell = view('c_p00_p00', 'lod2');
  city.showCell(cell);
  const meshes: InstanceType<typeof THREE.InstancedMesh>[] = [];
  scenery.traverse(node => { if ((node as unknown as { isInstancedMesh?: boolean }).isInstancedMesh) meshes.push(node as InstanceType<typeof THREE.InstancedMesh>); });
  assert.equal(meshes.length, 3);
  assert.equal(meshes.reduce((count, mesh) => count + mesh.count, 0), 3);
  assert.equal(city.sceneryStats().residentCells, 1);
  assert.equal(city.sceneryStats().residentInstances, 3);
  let disposed = 0;
  meshes.forEach((mesh, i) => {
    assert.equal(mesh.geometry, template.geometry);
    const actual = new THREE.Matrix4(), expected = new THREE.Matrix4().compose(new THREE.Vector3(...positions[i]!),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), i * .2), new THREE.Vector3(1, 2, 1));
    mesh.getMatrixAt(0, actual);
    assert.ok(actual.elements.every((value: number, j: number) => Math.abs(value - expected.elements[j]!) < 1e-6));
    mesh.addEventListener('dispose' as never, () => disposed++);
  });
  city.disposeCell(cell); assert.equal(disposed, 3); assert.equal(city.sceneryStats().residentInstances, 0);
});
