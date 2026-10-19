import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { SceneryInstanceCuller } from '../../../apps/game/src/render/scenery-culling.ts';
import { CityScene, type CellView } from '../../../apps/game/src/render/scene.ts';
import { Game } from '../../../apps/game/src/game.ts';
import type { SceneryDocument } from '../../../packages/world-schema/src/index.ts';

const entry = createRequire(new URL('../../../apps/game/package.json', import.meta.url)).resolve('three');
const THREE = await import(new URL('./three.module.js', pathToFileURL(entry)).href);
function box(x0: number, x1: number, y0 = -2, y1 = 2, z0 = -2, z1 = 2) {
  return new THREE.Frustum(new THREE.Plane(new THREE.Vector3(1, 0, 0), -x0), new THREE.Plane(new THREE.Vector3(-1, 0, 0), x1),
    new THREE.Plane(new THREE.Vector3(0, 1, 0), -y0), new THREE.Plane(new THREE.Vector3(0, -1, 0), y1),
    new THREE.Plane(new THREE.Vector3(0, 0, 1), -z0), new THREE.Plane(new THREE.Vector3(0, 0, -1), z1));
}
function batch(xs: number[]) {
  const geometry = new THREE.BoxGeometry(.2, .2, .2), material = new THREE.MeshBasicMaterial(), mesh = new THREE.InstancedMesh(geometry, material, xs.length);
  xs.forEach((x, i) => mesh.setMatrixAt(i, new THREE.Matrix4().makeTranslation(x, 0, 0)));
  return mesh;
}
test('culling compacts original indices, restores reappearing instances and uploads only changed visibility', () => {
  const mesh = batch([0, 10, 20]), original = mesh.instanceMatrix.array.slice(), culler = new SceneryInstanceCuller(mesh), fullBound = mesh.boundingSphere.clone();
  const geometryVersion = mesh.geometry.getAttribute('position').version;
  assert.equal(mesh.geometry.boundingSphere, null, 'the culler does not write shared template bounds');
  let version = mesh.instanceMatrix.version;
  assert.equal(culler.update(box(-1, 1)), true); assert.equal(mesh.count, 1); assert.equal(mesh.instanceMatrix.version, version + 1);
  assert.deepEqual(mesh.instanceMatrix.array.slice(0, 16), original.slice(0, 16));
  version = mesh.instanceMatrix.version;
  assert.equal(culler.update(box(-1, 1)), false); assert.equal(mesh.instanceMatrix.version, version);
  assert.equal(culler.update(box(19, 21)), true); assert.equal(mesh.count, 1);
  assert.deepEqual(mesh.instanceMatrix.array.slice(0, 16), original.slice(32, 48), 'a returning source index is not read from the old compact buffer');
  assert.equal(culler.update(box(100, 110)), true); assert.equal(mesh.count, 0);
  version = mesh.instanceMatrix.version; assert.equal(culler.update(box(100, 110)), false); assert.equal(mesh.instanceMatrix.version, version);
  assert.equal(culler.update(box(-30, 30)), true); assert.equal(mesh.count, 3); assert.deepEqual(mesh.instanceMatrix.array, original);
  assert.deepEqual(mesh.boundingSphere, fullBound, 'the full source aggregate remains conservative after empty/subset draws');
  culler.update(box(19, 21)); culler.restore(); assert.deepEqual(mesh.instanceMatrix.array, original); assert.equal(mesh.count, 3);
  version = mesh.instanceMatrix.version; culler.restore(); assert.equal(mesh.instanceMatrix.version, version);
  assert.equal(mesh.geometry.getAttribute('position').version, geometryVersion);
});
test('geometry offsets, rotation, scale and parent world transforms participate in cached bounds', () => {
  const geometry = new THREE.BoxGeometry(.2, .4, .6).translate(4, 0, 0), material = new THREE.MeshBasicMaterial(), mesh = new THREE.InstancedMesh(geometry, material, 1);
  const instance = new THREE.Matrix4().compose(new THREE.Vector3(5, 2, -3), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2), new THREE.Vector3(2, 3, 4));
  mesh.setMatrixAt(0, instance); mesh.rotation.z = .3;
  const parent = new THREE.Group(); parent.position.set(100, -20, 40); parent.scale.set(2, 3, 1); parent.add(mesh); parent.updateMatrixWorld(true);
  const center = new THREE.Vector3(4, 0, 0).applyMatrix4(instance).applyMatrix4(mesh.matrixWorld), culler = new SceneryInstanceCuller(mesh);
  const vertices = geometry.getAttribute('position'), cached = (culler as any).worldSpheres[0];
  for (let i = 0; i < vertices.count; i++) assert.ok(cached.containsPoint(new THREE.Vector3().fromBufferAttribute(vertices, i).applyMatrix4(instance).applyMatrix4(mesh.matrixWorld)), 'composed nonuniform transforms never shrink the cached bound through a vertex');
  culler.update(box(center.x - 2, center.x + 2, center.y - 2, center.y + 2, center.z - 2, center.z + 2)); assert.equal(mesh.count, 1);
  culler.update(box(-2, 2)); assert.equal(mesh.count, 0, 'local origin is not mistaken for the world placement');
});
test('a sphere intersecting the frustum remains visible when its origin is outside', () => {
  const mesh = batch([1.1]), culler = new SceneryInstanceCuller(mesh);
  assert.equal(culler.update(box(-1, 1)), false); assert.equal(mesh.count, 1, 'bounds are conservative at the view edge');
});
test('empty meshes and cache disposal never dispose shared geometry or material', () => {
  const mesh = batch([]), culler = new SceneryInstanceCuller(mesh); let disposed = 0;
  mesh.geometry.addEventListener('dispose', () => disposed++); mesh.material.addEventListener('dispose', () => disposed++);
  const version = mesh.instanceMatrix.version; assert.equal(culler.update(box(-1, 1)), false); culler.restore(); assert.equal(mesh.count, 0); assert.equal(mesh.instanceMatrix.version, version);
  culler.dispose(); assert.equal(disposed, 0); assert.throws(() => culler.update(box(-1, 1)), /disposed/);
});

function city(preset: 'low' | 'standard'): CityScene {
  const camera = new THREE.PerspectiveCamera(62, 1, .1, 20); camera.position.set(1, 1, 5); camera.lookAt(1, 0, 1);
  return Object.assign(Object.create(CityScene.prototype), { scene: new THREE.Scene(), camera, cells: new Map(), fallbackCells: new Map(), sceneryDefinitions: new Map(), sceneryCellViews: new Map(), sceneryMaterials: new Map(), sceneryRoot: new THREE.Group(), sceneryCulling: null, sceneryAssets: null, sceneryStreamed: false, lighting: 'unlit', preset }) as CityScene;
}
test('low scene owns caches by residency, uses the final camera and preserves source placements/templates', () => {
  const scene = city('low'), template = new THREE.Group(), geometry = new THREE.BoxGeometry(.2, .2, .2), material = new THREE.MeshBasicMaterial(), node = new THREE.Mesh(geometry, material); node.name = 'tree'; template.add(node);
  let sharedDisposed = 0; geometry.addEventListener('dispose', () => sharedDisposed++); material.addEventListener('dispose', () => sharedDisposed++);
  const document = { originId: 'origin', assets: [], instances: [1, 100].map((x, k) => ({ id: `tree-${k}`, asset: 'trees', node: 'tree', position: [x, 0, 1], yaw: .2, scale: [1, 1, 1] })) } as unknown as SceneryDocument, original = JSON.stringify(document);
  const root = scene.addScenery(document, new Map([['trees', template]]), 128, true), view = { id: 'c_p00_p00', lod: 'lod2', group: new THREE.Group() } as CellView;
  scene.showCell(view); const meshes: any[] = []; root.traverse(o => { if ((o as any).isInstancedMesh) meshes.push(o); });
  scene.prepareSceneryForRender(); assert.equal(meshes.reduce((n, m) => n + m.count, 0), 1); assert.equal(scene.sceneryStats().residentInstances, 2);
  scene.camera.position.set(100, 1, 5); scene.camera.lookAt(100, 0, 1); scene.prepareSceneryForRender();
  assert.equal(meshes.reduce((n, m) => n + m.count, 0), 1); assert.equal(meshes.find(m => m.count === 1).instanceMatrix.array[12], 100);
  scene.disposeCell(view); assert.equal(root.children.length, 0); assert.equal((scene as any).sceneryCulling.meshes.size, 0); assert.equal(sharedDisposed, 0); assert.equal(JSON.stringify(document), original);
});
test('standard scene and render accounting keep their existing behavior', () => {
  const scene = city('standard'), template = new THREE.Group(), node = new THREE.Mesh(new THREE.BoxGeometry(.2, .2, .2), new THREE.MeshBasicMaterial()); node.name = 'tree'; template.add(node);
  const document = { originId: 'origin', assets: [], instances: [1, 100].map((x, k) => ({ id: `tree-${k}`, asset: 'trees', node: 'tree', position: [x, 0, 1], yaw: 0, scale: [1, 1, 1] })) } as unknown as SceneryDocument;
  const root = scene.addScenery(document, new Map([['trees', template]]), 128, false); scene.prepareSceneryForRender(); assert.equal((scene as any).sceneryCulling, null);
  let instances = 0; root.traverse(o => { if ((o as any).isInstancedMesh) instances += (o as any).count; }); assert.equal(instances, 2, 'standard buffers are not compacted by camera visibility');
  const calls: string[] = [], info = { render: { calls: 12, triangles: 345 }, memory: { textures: 6, geometries: 7 } }, context = { config: { preset: 'standard' }, scene: { renderer: { info, render: () => calls.push('draw') }, scene: {}, camera: {}, prepareSceneryForRender: () => calls.push('cull') }, stats: {}, sim: { tick: 8 } };
  Game.prototype.render.call(context as unknown as Game); assert.deepEqual(calls, ['cull', 'draw']); assert.deepEqual(context.stats, { drawCalls: 12, triangles: 345, textures: 6, geometries: 7, tick: 8 });
});
