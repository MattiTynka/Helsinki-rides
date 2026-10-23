import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from 'three';
import { adaptCityMaterial } from '../src/render/city-materials.ts';
import { CityScene, type CellView } from '../src/render/scene.ts';
import type { MaterialClass } from '../src/render/quality-tiers.ts';
import type { SceneryDocument } from '@helsinki/world-schema';

function facade(baked = true): THREE.MeshStandardMaterial {
  const map = new THREE.Texture();
  const material = new THREE.MeshStandardMaterial({ map, color: 0x808080, roughness: .4, metalness: .3, side: THREE.DoubleSide,
    transparent: true, opacity: .9, alphaTest: .25, vertexColors: true, depthWrite: false, depthTest: true, toneMapped: true });
  material.name = 'facade'; material.envMapIntensity = .7;
  material.userData = { bakedLighting: baked, source: 'register' };
  return material;
}
const snapshot = (m: THREE.MeshStandardMaterial) => ({ roughness: m.roughness, metalness: m.metalness, envMapIntensity: m.envMapIntensity,
  color: m.color.getHex(), emissive: m.emissive.getHex(), emissiveMap: m.emissiveMap, map: m.map, toneMapped: m.toneMapped, version: m.version,
  alphaToCoverage: m.alphaToCoverage, userData: JSON.stringify(m.userData) });

test('standard class adapts a clone: flattened PBR and the baked-light rule, source untouched', () => {
  const source = facade(), before = snapshot(source);
  let disposed = 0; source.addEventListener('dispose', () => disposed++);
  const adapted = adaptCityMaterial(source, { lighting: 'lit', materialClass: 'standard' }) as THREE.MeshStandardMaterial;
  assert.notEqual(adapted, source); assert.equal(adapted.type, 'MeshStandardMaterial');
  assert.equal(adapted.roughness, 1); assert.equal(adapted.metalness, 0); assert.equal(adapted.envMapIntensity, 0);
  assert.equal(adapted.map, source.map); assert.equal(adapted.emissiveMap, source.map);
  assert.ok(adapted.emissive.equals(new THREE.Color().setScalar(.72)));
  assert.ok(adapted.color.equals(source.color.clone().multiplyScalar(.45)));
  assert.deepEqual(snapshot(source), before); assert.equal(disposed, 0);
  const again = adaptCityMaterial(source, { lighting: 'lit', materialClass: 'standard' }) as THREE.MeshStandardMaterial;
  assert.ok(again.color.equals(adapted.color), 'the baked diffuse factor is applied exactly once per adaptation');
  const plain = facade(false), unbaked = adaptCityMaterial(plain, { lighting: 'lit', materialClass: 'standard' }) as THREE.MeshStandardMaterial;
  assert.equal(unbaked.color.getHex(), plain.color.getHex()); assert.equal(unbaked.emissiveMap, null);
});

test('lambert class keeps maps, colour, transparency, sides and the baked rule once', () => {
  const source = facade(), before = snapshot(source);
  const adapted = adaptCityMaterial(source, { lighting: 'lit', materialClass: 'lambert' }) as THREE.MeshLambertMaterial;
  assert.ok(adapted instanceof THREE.MeshLambertMaterial);
  assert.equal(adapted.map, source.map); assert.equal(adapted.emissiveMap, source.map);
  assert.ok(adapted.emissive.equals(new THREE.Color().setScalar(.72)));
  assert.ok(adapted.color.equals(source.color.clone().multiplyScalar(.45)));
  for (const key of ['side', 'transparent', 'opacity', 'alphaTest', 'vertexColors', 'depthWrite', 'depthTest', 'name', 'toneMapped'] as const) assert.equal(adapted[key], source[key], key);
  assert.deepEqual(adapted.userData, source.userData); assert.notEqual(adapted.userData, source.userData);
  assert.deepEqual(snapshot(source), before);
  const twice = adaptCityMaterial(source, { lighting: 'lit', materialClass: 'lambert' }) as THREE.MeshLambertMaterial;
  assert.ok(twice.color.equals(adapted.color));
  const plain = facade(false);
  plain.emissive.setHex(0x112233); plain.emissiveMap = new THREE.Texture();
  const unbaked = adaptCityMaterial(plain, { lighting: 'lit', materialClass: 'lambert' }) as THREE.MeshLambertMaterial;
  assert.equal(unbaked.color.getHex(), plain.color.getHex()); assert.equal(unbaked.emissive.getHex(), 0x112233); assert.equal(unbaked.emissiveMap, plain.emissiveMap);
});

test('unlit lighting and unlit sources become independent MeshBasic materials', () => {
  for (const materialClass of ['standard', 'lambert'] as const) {
    const source = facade(), before = snapshot(source);
    let disposed = 0; source.addEventListener('dispose', () => disposed++);
    const basic = adaptCityMaterial(source, { lighting: 'unlit', materialClass }) as THREE.MeshBasicMaterial;
    assert.ok(basic instanceof THREE.MeshBasicMaterial); assert.equal(basic.toneMapped, false);
    assert.equal(basic.map, source.map); assert.ok(basic.color.equals(source.color)); assert.equal(basic.name, 'facade');
    for (const key of ['side', 'transparent', 'opacity', 'alphaTest', 'vertexColors'] as const) assert.equal(basic[key], source[key], key);
    assert.deepEqual(snapshot(source), before); assert.equal(disposed, 0, 'the caller owns disposal of its source');
    const unlitSource = new THREE.MeshBasicMaterial({ name: 'sign', alphaTest: .5 });
    const clone = adaptCityMaterial(unlitSource, { lighting: 'lit', materialClass }) as THREE.MeshBasicMaterial;
    assert.notEqual(clone, unlitSource); assert.equal(clone.type, 'MeshBasicMaterial'); assert.equal(clone.toneMapped, false);
    assert.equal(unlitSource.toneMapped, true); assert.equal(clone.name, 'sign'); assert.equal(clone.alphaTest, .5);
  }
});

function city(materialClass: MaterialClass | undefined, preset: 'low' | 'standard' = 'low'): CityScene {
  return Object.assign(Object.create(CityScene.prototype), {
    scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(), cells: new Map(), fallbackCells: new Map(), sceneryDefinitions: new Map(),
    sceneryCellViews: new Map(), sceneryMaterials: new Map(), sceneryFoliageLods: new Map(), sceneryRoot: new THREE.Group(), sceneryCulling: null,
    sceneryAssets: null, sceneryStreamed: false, lighting: 'lit', preset, materialClass,
  }) as CityScene;
}

test('city cells adopt the scene material class and release their never-rendered source materials', async () => {
  for (const [materialClass, type] of [['lambert', 'MeshLambertMaterial'], ['standard', 'MeshStandardMaterial'], [undefined, 'MeshStandardMaterial']] as const) {
    const source = facade(), group = new THREE.Group(), geometry = new THREE.BoxGeometry();
    group.add(new THREE.Mesh(geometry, source), new THREE.Mesh(geometry, [source, source]));
    let disposed = 0; source.addEventListener('dispose', () => disposed++);
    const loader = { load: async () => ({ scene: group }) } as unknown as Parameters<CityScene['loadCell']>[0];
    const descriptor = { id: 'a', visual: { lod1: { path: 'cell.glb' }, lod0: { path: 'full.glb' } } } as Parameters<CityScene['loadCell']>[2];
    const view = await city(materialClass).loadCell(loader, '/', descriptor, 'lod1');
    const [single, multi] = view.group.children as THREE.Mesh[];
    const adapted = single!.material as THREE.Material;
    assert.equal(adapted.type, type, String(materialClass)); assert.notEqual(adapted, source);
    assert.deepEqual(multi!.material, [adapted, adapted], 'one adapted material per source within a cell');
    assert.equal(disposed, 1, 'the cell GLB source material is released once');
    assert.ok((adapted as THREE.MeshStandardMaterial).color.equals(source.color.clone().multiplyScalar(.45)));
  }
});

test('scenery materials are cached per source and class; the asset library source is never changed', () => {
  const scene = city('standard', 'standard'), source = facade(), before = snapshot(source);
  source.alphaTest = .5;
  const tree = new THREE.Group(), node = new THREE.Mesh(new THREE.BoxGeometry(), source); node.name = 'tree'; tree.add(node);
  const doc = { schemaVersion: 1, originId: 'o', frame: 'f', assets: [], instances: [{ id: 't', asset: 'trees', node: 'tree', position: [1, 0, 1], yaw: 0, scale: [1, 1, 1] }] } as unknown as SceneryDocument;
  const root = scene.addScenery(doc, new Map([['trees', tree]]), 128, true), cell = { id: 'c_p00_p00', lod: 'lod2', group: new THREE.Group() } as CellView;
  const material = () => { const found: THREE.Material[] = []; root.traverse(o => { if ((o as THREE.InstancedMesh).isInstancedMesh) found.push((o as THREE.InstancedMesh).material as THREE.Material); }); return found[0]!; };
  scene.showCell(cell);
  const standard = material();
  assert.equal(standard.type, 'MeshStandardMaterial'); assert.notEqual(standard, source);
  assert.equal(standard.alphaToCoverage, true, 'multisampled presets smooth alpha-tested foliage on the adapted material');
  scene.disposeCell(cell);
  (scene as unknown as { materialClass: MaterialClass }).materialClass = 'lambert';
  scene.showCell(cell);
  const lambert = material();
  assert.equal(lambert.type, 'MeshLambertMaterial', 'a rebuilt group never reuses the other class');
  scene.disposeCell(cell);
  (scene as unknown as { materialClass: MaterialClass }).materialClass = 'standard';
  scene.showCell(cell);
  assert.equal(material(), standard, 'the cached adaptation is reused');
  assert.ok((material() as THREE.MeshStandardMaterial).color.equals(source.color.clone().multiplyScalar(.45)), 'the baked factor never compounds');
  assert.deepEqual(snapshot(source), before); assert.equal(source.alphaTest, .5);
  assert.equal(source.alphaToCoverage, false);
  const low = city('lambert', 'low'), lowRoot = low.addScenery(doc, new Map([['trees', tree]]), 128, true);
  low.showCell({ id: 'c_p00_p00', lod: 'lod2', group: new THREE.Group() } as CellView);
  let lowMaterial: THREE.Material | null = null;
  lowRoot.traverse(o => { if ((o as THREE.InstancedMesh).isInstancedMesh) lowMaterial = (o as THREE.InstancedMesh).material as THREE.Material; });
  assert.equal(lowMaterial!.type, 'MeshLambertMaterial'); assert.equal(lowMaterial!.alphaToCoverage, false, 'the low preset has no multisampling');
});
