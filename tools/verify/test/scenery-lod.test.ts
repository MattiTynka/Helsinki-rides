import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createFoliageLods, sceneryLodLevel } from '../../../apps/game/src/render/scenery-lod.ts';
import { SceneryInstanceCuller } from '../../../apps/game/src/render/scenery-culling.ts';
import { CityScene, type CellView } from '../../../apps/game/src/render/scene.ts';
import type { SceneryDocument } from '../../../packages/world-schema/src/index.ts';

const entry = createRequire(new URL('../../../apps/game/package.json', import.meta.url)).resolve('three');
const THREE = await import(new URL('./three.module.js', pathToFileURL(entry)).href);
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const bytes = readFileSync(new URL('./fixtures/scenery-foliage-models.json', import.meta.url));
assert.equal(sha(bytes), '4db75d9fd13553913e19ab21a5427b9a2f9b50fe017509c8ba6b418744030bff');
interface ArrayFixture { type: string; base64: string; sha256: string }
interface ModelFixture { name: string; sourceCards: number; min: number[]; max: number[]; indices: ArrayFixture; attributes: Record<string, ArrayFixture & { itemSize: number; normalized: boolean }> }
const fixture = JSON.parse(bytes.toString('utf8')) as { source: { sha256: string }; models: ModelFixture[] };
assert.equal(fixture.source.sha256, 'ad3978765df75d695c5756b53c9ff2f1f418bf964a28e0ae910661882c6f2690');
function array(f: ArrayFixture) {
  const raw = Uint8Array.from(Buffer.from(f.base64, 'base64')); assert.equal(sha(raw), f.sha256);
  switch (f.type) { case 'Float32Array': return new Float32Array(raw.buffer); case 'Uint16Array': return new Uint16Array(raw.buffer); case 'Uint32Array': return new Uint32Array(raw.buffer); case 'Int16Array': return new Int16Array(raw.buffer); case 'Uint8Array': return raw; default: throw Error('Unsupported fixture attribute'); }
}
function geometry(f: ModelFixture) {
  const g = new THREE.BufferGeometry();
  for (const [key, name] of Object.entries({ POSITION: 'position', NORMAL: 'normal', TEXCOORD_0: 'uv', COLOR_0: 'color' })) {
    const a = f.attributes[key]; if (a) g.setAttribute(name, new THREE.BufferAttribute(array(a), a.itemSize, a.normalized));
  }
  g.setIndex(new THREE.BufferAttribute(array(f.indices), 1));
  g.boundingBox = new THREE.Box3(new THREE.Vector3().fromArray(f.min), new THREE.Vector3().fromArray(f.max));
  g.boundingSphere = new THREE.Sphere(g.boundingBox.getCenter(new THREE.Vector3()), g.boundingBox.min.distanceTo(g.boundingBox.max) / 2);
  return g;
}
const raw = (a: ArrayBufferView) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);

test('actual accepted three tree models produce deterministic nested whole-card foliage, exact shared attributes and source winding', () => {
  let indexBytes = 0;
  for (const model of fixture.models) {
    const g = geometry(model), attributeEntries = Object.entries(g.attributes) as [string, { array: ArrayBufferView }][], attributes = Object.fromEntries(attributeEntries.map(([k, a]) => [k, sha(raw(a.array))])), index = g.index!.array.slice(), bounds = g.boundingSphere!.clone();
    const lod = createFoliageLods(g)!; assert.ok(lod); assert.equal(lod.sourceCards, model.sourceCards); assert.equal(lod.midCards.length, 160); assert.equal(lod.farCards.length, 80);
    assert.deepEqual(lod.midCards, createFoliageLods(g)!.midCards); assert.deepEqual(lod.farCards, createFoliageLods(g)!.farCards);
    assert.ok(lod.farCards.every(k => lod.midCards.includes(k))); assert.ok(lod.mandatoryCards.every(k => lod.farCards.includes(k))); assert.ok(lod.mandatoryCards.length <= 26);
    for (const [level, cards] of [[lod.mid, lod.midCards], [lod.far, lod.farCards]] as const) {
      assert.deepEqual(Array.from(level.index!.array), cards.flatMap(k => Array.from(index.slice(k * 6, k * 6 + 6))), 'every source triangle, original winding and whole card is retained exactly');
      for (const [key, a] of attributeEntries) { assert.equal(level.getAttribute(key), a); assert.equal(sha(raw(a.array)), attributes[key]); }
      assert.deepEqual(level.boundingSphere, bounds); indexBytes += level.index!.array.byteLength;
    }
    assert.deepEqual(g.index!.array, index); assert.deepEqual(g.boundingSphere, bounds);
  }
  assert.equal(indexBytes, 8640, 'all six shared distance geometries add only8640index bytes and no vertex/texture copies');
});

test('far source cards retain exact canopy extrema in all26axis/diagonal directions', () => {
  for (const model of fixture.models) {
    const g = geometry(model), far = createFoliageLods(g)!.far, p = g.getAttribute('position');
    for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) {
      if (!x && !y && !z) continue;
      const value = (i: number) => p.getX(i) * x + p.getY(i) * y + p.getZ(i) * z;
      let source = -Infinity, distant = -Infinity;
      for (let i = 0; i < g.index!.count; i++) source = Math.max(source, value(g.index!.getX(i)));
      for (let i = 0; i < far.index!.count; i++) distant = Math.max(distant, value(far.index!.getX(i)));
      assert.equal(distant, source, `${model.name}: whole-crown silhouette direction ${x},${y},${z}`);
    }
  }
});

test('unsupported or shared-vertex foliage topology keeps the complete source geometry', () => {
  assert.equal(createFoliageLods(new THREE.BoxGeometry()), null);
  const g = geometry(fixture.models[0]!); g.index!.setX(6, 0); assert.equal(createFoliageLods(g), null, 'cards sharing vertices cannot be independently thinned');
  const drawRange = geometry(fixture.models[0]!); drawRange.setDrawRange(0, 12); assert.equal(createFoliageLods(drawRange), null);
});

test('distance bands preserve all crowns, full detail within120m and hysteresis through both transitions', () => {
  for (const previous of [0, 1, 2] as const) { assert.equal(sceneryLodLevel(119.99, previous), 0); assert.equal(sceneryLodLevel(10000, previous), 2); }
  assert.equal(sceneryLodLevel(131.99, 0), 0); assert.equal(sceneryLodLevel(132.01, 0), 1); assert.equal(sceneryLodLevel(125, 1), 1);
  assert.equal(sceneryLodLevel(263.99, 1), 1); assert.equal(sceneryLodLevel(264.01, 1), 2); assert.equal(sceneryLodLevel(250, 2), 2); assert.equal(sceneryLodLevel(239.99, 2), 1);
});

function frustum() { return new THREE.Frustum(new THREE.Plane(new THREE.Vector3(1, 0, 0), 1000), new THREE.Plane(new THREE.Vector3(-1, 0, 0), 1000), new THREE.Plane(new THREE.Vector3(0, 1, 0), 1000), new THREE.Plane(new THREE.Vector3(0, -1, 0), 1000), new THREE.Plane(new THREE.Vector3(0, 0, 1), 1000), new THREE.Plane(new THREE.Vector3(0, 0, -1), 1000)); }
test('every visible tree occupies exactly one foliage tier, restores its own source matrix and has no stationary uploads', () => {
  const meshes = [0, 1, 2].map(() => new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial(), 3));
  const cullers = meshes.map((m, level) => { [0, 170, 330].forEach((x, k) => m.setMatrixAt(k, new THREE.Matrix4().makeTranslation(x, 0, 0))); return new SceneryInstanceCuller(m, level as 0 | 1 | 2); });
  const camera = new THREE.Vector3(0, 0, 0), view = frustum(); cullers.forEach(c => c.update(view, camera)); assert.deepEqual(meshes.map(m => m.count), [1, 1, 1]);
  const sourceIndices = () => meshes.flatMap(m => Array.from({ length: m.count }, (_, k) => m.instanceMatrix.array[k * 16 + 12]!)).sort((a, b) => a - b);
  assert.deepEqual(sourceIndices(), [0, 170, 330]); const versions = meshes.map(m => m.instanceMatrix.version);
  cullers.forEach(c => assert.equal(c.update(view, camera), false)); assert.deepEqual(meshes.map(m => m.instanceMatrix.version), versions);
  camera.x = 330; cullers.forEach(c => c.update(view, camera)); assert.deepEqual(meshes.map(m => m.count), [1, 1, 1]); assert.deepEqual(sourceIndices(), [0, 170, 330]);
  assert.equal(meshes[0]!.instanceMatrix.array[12], 330); assert.equal(meshes[2]!.instanceMatrix.array[12], 0);
  cullers.forEach(c => c.dispose()); assert.throws(() => cullers[0]!.update(view, camera), /disposed/);
});

test('a large crown close to the camera retains full source detail even when its tree origin is remote', () => {
  const g = new THREE.BoxGeometry(80, 80, 80), m = new THREE.InstancedMesh(g, new THREE.MeshBasicMaterial(), 1); m.setMatrixAt(0, new THREE.Matrix4().makeTranslation(170, 0, 0));
  const c = new SceneryInstanceCuller(m, 0); c.update(frustum(), new THREE.Vector3()); assert.equal(m.count, 1, 'distance is from crown surface rather than trunk origin');
});

function scene(preset: 'low' | 'standard'): CityScene {
  const camera = new THREE.PerspectiveCamera(150, 1, .1, 800); camera.position.set(0, 8, 30); camera.lookAt(0, 8, -1);
  return Object.assign(Object.create(CityScene.prototype), { scene: new THREE.Scene(), camera, cells: new Map(), fallbackCells: new Map(), sceneryDefinitions: new Map(), sceneryCellViews: new Map(), sceneryMaterials: new Map(), sceneryFoliageLods: new Map(), sceneryRoot: new THREE.Group(), sceneryCulling: null, sceneryAssets: null, sceneryStreamed: false, lighting: 'unlit', preset }) as CityScene;
}
test('low residency reuses source materials and shared LOD geometry across repeated cell eviction without texture or geometry disposal', () => {
  const source = geometry(fixture.models[0]!), bark = new THREE.BoxGeometry(.2, 10, .2), leafMaterial = new THREE.MeshBasicMaterial({ name: 'tree_leaves', alphaTest: .5 }), barkMaterial = new THREE.MeshBasicMaterial({ name: 'tree_bark' });
  const root = new THREE.Group(), tree = new THREE.Group(); tree.name = 'tree-birch'; root.add(tree); tree.add(new THREE.Mesh(source, leafMaterial), new THREE.Mesh(bark, barkMaterial));
  const document = { originId: 'origin', assets: [], instances: [20, 160, 300].map((z, k) => ({ id: `tree-${k}`, asset: 'scenery-trees', node: 'tree-birch', position: [0, 0, -z], yaw: .2, scale: [1, 1, 1] })) } as unknown as SceneryDocument, before = JSON.stringify(document), city = scene('low');
  city.addScenery(document, new Map([['scenery-trees', root]]), 1024, true);
  const view = { id: 'c_p00_m01', lod: 'lod2', group: new THREE.Group() } as CellView; let disposed = 0;
  for (const resource of [source, bark, leafMaterial, barkMaterial]) resource.addEventListener('dispose', () => disposed++);
  city.showCell(view); city.prepareSceneryForRender(); const first = [...(city as any).sceneryFoliageLods.values()][0]; assert.equal((city as any).sceneryFoliageLods.size, 1);
  assert.equal((city as any).sceneryCellViews.get(view.id).children.length, 4, 'one bark batch and three foliage tiers, independent of32m subdivisions');
  for (const mesh of (city as any).sceneryCellViews.get(view.id).children) if (mesh.userData.sceneryLodLevel !== undefined) assert.equal(mesh.material, leafMaterial); else { assert.equal(mesh.geometry, bark); assert.equal(mesh.material, barkMaterial); }
  for (let i = 0; i < 4; i++) { city.disposeCell(view); assert.equal((city as any).sceneryCulling.meshes.size, 0); city.showCell(view); city.prepareSceneryForRender(); assert.equal([...(city as any).sceneryFoliageLods.values()][0], first); }
  assert.equal(disposed, 0); assert.equal(JSON.stringify(document), before); assert.equal(city.sceneryStats().residentInstances, 3);
});

test('standard preset retains complete original foliage with no distance geometries or distance culling', () => {
  const g = geometry(fixture.models[0]!), material = new THREE.MeshBasicMaterial({ name: 'tree_leaves', alphaTest: .5 }), root = new THREE.Group(), node = new THREE.Mesh(g, material); node.name = 'tree-birch'; root.add(node);
  const document = { originId: 'origin', assets: [], instances: [{ id: 'far', asset: 'scenery-trees', node: 'tree-birch', position: [0, 0, -700], yaw: .2, scale: [1, 1, 1] }] } as unknown as SceneryDocument, city = scene('standard');
  const group = city.addScenery(document, new Map([['scenery-trees', root]])); city.prepareSceneryForRender();
  assert.equal((city as any).sceneryFoliageLods.size, 0); assert.equal((city as any).sceneryCulling, null);
  const meshes: any[] = []; group.traverse(o => { if ((o as any).isInstancedMesh) meshes.push(o); }); assert.equal(meshes.length, 1); assert.equal(meshes[0].geometry, g); assert.equal(meshes[0].material, material); assert.equal(meshes[0].count, 1);
});
