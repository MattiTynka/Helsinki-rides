import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { AssetLibrary, type PreparedAsset } from '../../../apps/game/src/render/assets.ts';
import { assetWarmupRoot } from '../../../apps/game/src/render/warmup.ts';
import { SkinnedMeshCuller } from '../../../apps/game/src/render/skinned-culling.ts';

const entry = createRequire(new URL('../../../apps/game/package.json', import.meta.url)).resolve('three');
const THREE = await import(new URL('./three.module.js', pathToFileURL(entry)).href);
const { clone } = await import(new URL('../examples/jsm/utils/SkeletonUtils.js', pathToFileURL(entry)).href);

test('character preparation analyses shared skin geometry before the first spawned view', () => {
  const source = new THREE.Group(), geometry = new THREE.BufferGeometry();
  const positions = new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3);
  geometry.setAttribute('position', positions);
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Array(12).fill(0), 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial()), bone = new THREE.Bone();
  mesh.add(bone); source.add(mesh); mesh.bind(new THREE.Skeleton([bone])); source.updateMatrixWorld(true);
  const before = Array.from(positions.array), bind = mesh.bindMatrix.clone(), inverse = mesh.skeleton.boneInverses[0]!.clone();
  let reads = 0, disposed = false;
  const getX = positions.getX.bind(positions); positions.getX = (index: number) => { reads++; return getX(index); };
  geometry.addEventListener('dispose', () => { disposed = true; });
  const asset = { kind: 'character', asset: { id: 'character-test', scene: source, clips: new Map(), height: 1 } } as PreparedAsset;
  const warm = assetWarmupRoot(source, asset, new AssetLibrary());
  assert.ok(reads >= positions.count, 'skin analysis must happen during loading');
  warm.dispose(); reads = 0;
  const actor = clone(source), culler = new SkinnedMeshCuller(actor);
  assert.equal(reads, 0, 'a spawned skeleton reuses the prepared geometry analysis');
  actor.updateMatrixWorld(true); culler.update();
  assert.equal(actor.children[0]!.frustumCulled, true);
  assert.equal(disposed, false); assert.deepEqual(Array.from(positions.array), before);
  assert.ok(mesh.bindMatrix.equals(bind)); assert.ok(mesh.skeleton.boneInverses[0]!.equals(inverse));
  culler.dispose();
});
