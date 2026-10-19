import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { SkinnedMeshCuller } from '../../../apps/game/src/render/skinned-culling.ts';

const entry = createRequire(new URL('../../../apps/game/package.json', import.meta.url)).resolve('three');
const THREE = await import(new URL('./three.module.js', pathToFileURL(entry)).href);

function fixture(detached = false, weightError = 0) {
  const root = new THREE.Group(), parent = new THREE.Group(); root.add(parent);
  const geometry = new THREE.BufferGeometry(), positions: number[] = [], indices: number[] = [], weights: number[] = [];
  for (let i = 0; i < 45; i++) {
    positions.push(Math.sin(i * 1.7) * .8, (i % 9) * .23, Math.cos(i * .9) * .4);
    const a = (i % 5) / 4;
    indices.push(0, 1, 999, 999); weights.push(a * (1 + weightError), (1 - a) * (1 + weightError), 0, 0);
  }
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(indices, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4));
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial()), bone = new THREE.Bone(), tip = new THREE.Bone();
  tip.position.set(.1, 1, .07); bone.add(tip); parent.add(mesh);
  if (detached) root.add(bone); else mesh.add(bone);
  root.position.set(17, 3, -12); root.rotation.set(.12, .4, -.18); parent.rotation.set(.2, -.3, .1);
  parent.position.set(.4, -.2, .3); mesh.rotation.set(-.15, .2, .3); mesh.position.set(.3, .4, -.2);
  root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton([bone, tip]); mesh.bind(skeleton);
  if (detached) mesh.bindMode = THREE.DetachedBindMode;
  root.updateMatrixWorld(true); mesh.frustumCulled = false;
  return { root, parent, geometry, mesh, bone, tip };
}
function containsActualVertices(mesh: any) {
  assert.equal(mesh.frustumCulled, true);
  const local = mesh.boundingSphere, world = local.clone().applyMatrix4(mesh.matrixWorld), point = new THREE.Vector3();
  for (let i = 0; i < mesh.geometry.getAttribute('position').count; i++) {
    mesh.getVertexPosition(i, point);
    assert.ok(local.distanceToPoint(point) <= 1e-8, `posed local vertex ${i} escaped by ${local.distanceToPoint(point)}`);
    point.applyMatrix4(mesh.matrixWorld);
    assert.ok(world.distanceToPoint(point) <= 1e-8, `posed world vertex ${i} escaped by ${world.distanceToPoint(point)}`);
  }
}
function immutableState(f: ReturnType<typeof fixture>) {
  return JSON.stringify({
    positions: Array.from(f.geometry.getAttribute('position').array), weights: Array.from(f.geometry.getAttribute('skinWeight').array),
    indices: Array.from(f.geometry.getAttribute('skinIndex').array), bind: f.mesh.bindMatrix.elements, inverseBind: f.mesh.bindMatrixInverse.elements,
    meshMatrix: f.mesh.matrix.elements, meshWorld: f.mesh.matrixWorld.elements,
    bones: f.mesh.skeleton.bones.map((b: any) => [b.matrix.elements, b.matrixWorld.elements]), inverses: f.mesh.skeleton.boneInverses.map((m: any) => m.elements),
    material: f.mesh.material.uuid, geometrySphere: f.geometry.boundingSphere, visible: f.mesh.visible,
  });
}

test('bone-influence spheres enclose actual Three skinned vertices through 120 poses', () => {
  const f = fixture(), culler = new SkinnedMeshCuller(f.root);
  for (let i = 0; i < 120; i++) {
    f.bone.rotation.set(Math.sin(i * .2), i * .07, Math.cos(i * .17));
    f.tip.rotation.set(i * .13, Math.sin(i * .1), -.3 * i);
    f.tip.position.set(.1 + Math.sin(i) * .4, 1 + Math.cos(i * .2), .07);
    f.root.position.set(1300 + i, 2, -800); f.root.updateMatrixWorld(true);
    const before = immutableState(f); culler.update(); containsActualVertices(f.mesh);
    assert.equal(immutableState(f), before, 'no geometry, weights, pose/bind matrices, materials or visibility change');
  }
});

test('attached and detached bindings remain conservative under nonuniform scale and shear', () => {
  for (const detached of [false, true]) {
    const f = fixture(detached), culler = new SkinnedMeshCuller(f.root);
    for (let i = 0; i < 50; i++) {
      f.root.scale.set(i % 2 ? -.4 : .4, 3.1, 1.7); f.root.rotation.set(.4, i * .17, .2);
      f.parent.scale.set(2.5, .35, .8); f.mesh.rotation.set(.2, .7 + i * .12, .6);
      f.bone.scale.set(.7, 2.2, .6); f.bone.rotation.set(.2, i * .07, .7); f.tip.rotation.set(.9, -.4, i * .12);
      f.root.updateMatrixWorld(true); culler.update(); containsActualVertices(f.mesh);
    }
  }
});

test('near-normalized positive weights retain a bound without rewriting source weights', () => {
  const f = fixture(true, 8e-6), culler = new SkinnedMeshCuller(f.root), weights = Array.from(f.geometry.getAttribute('skinWeight').array);
  f.bone.position.set(1000, 500, -700); f.tip.position.set(-80, 40, 20); f.root.updateMatrixWorld(true);
  culler.update(); containsActualVertices(f.mesh); assert.deepEqual(Array.from(f.geometry.getAttribute('skinWeight').array), weights);
});

test('offscreen posed meshes become visible again through actual Three frustum tests', () => {
  const f = fixture(), culler = new SkinnedMeshCuller(f.root), camera = new THREE.PerspectiveCamera(50, 1, .1, 100), frustum = new THREE.Frustum();
  f.root.position.set(0, 0, 0); f.root.rotation.set(0, 0, 0); f.parent.rotation.set(0, 0, 0); f.mesh.rotation.set(0, 0, 0);
  camera.position.set(0, 1, 12); camera.lookAt(0, 1, 0); camera.updateMatrixWorld(true);
  frustum.setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  f.root.position.x = 500; f.root.updateMatrixWorld(true); culler.update(); assert.equal(frustum.intersectsObject(f.mesh), false);
  f.root.position.x = 0; f.tip.rotation.z = 1; f.root.updateMatrixWorld(true); culler.update();
  assert.equal(frustum.intersectsObject(f.mesh), true); assert.equal(f.mesh.visible, true); containsActualVertices(f.mesh);
});

test('morph positions recompute the exact posed sphere for each changed influence', () => {
  const f = fixture(), position = f.geometry.getAttribute('position'), morph = new Float32Array(position.array.length);
  for (let i = 0; i < position.count; i++) { morph[i * 3] = 40; morph[i * 3 + 1] = i % 2 ? 8 : -8; }
  f.geometry.morphAttributes.position = [new THREE.Float32BufferAttribute(morph, 3)]; f.geometry.morphTargetsRelative = true; f.mesh.updateMorphTargets();
  const culler = new SkinnedMeshCuller(f.root); let exactCalls = 0;
  const exact = f.mesh.computeBoundingSphere.bind(f.mesh); f.mesh.computeBoundingSphere = () => { exactCalls++; exact(); };
  for (const influence of [0, 1, -.5, .25]) {
    f.mesh.morphTargetInfluences[0] = influence; f.tip.rotation.z += .4; f.root.updateMatrixWorld(true); culler.update(); containsActualVertices(f.mesh);
  }
  assert.equal(exactCalls, 4);
});

test('malformed weights, bones and changed source versions stay unculled', () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => f.geometry.getAttribute('skinWeight').setXYZW(0, -.1, 1.1, 0, 0),
    (f: ReturnType<typeof fixture>) => f.geometry.getAttribute('skinWeight').setXYZW(0, .4, .4, 0, 0),
    (f: ReturnType<typeof fixture>) => f.geometry.getAttribute('skinIndex').setY(0, 999),
  ]) {
    const f = fixture(); mutate(f); const culler = new SkinnedMeshCuller(f.root); culler.update(); assert.equal(f.mesh.frustumCulled, false);
  }
  const f = fixture(), culler = new SkinnedMeshCuller(f.root); culler.update(); assert.equal(f.mesh.frustumCulled, true);
  f.geometry.getAttribute('position').needsUpdate = true; culler.update(); assert.equal(f.mesh.frustumCulled, false);
});

test('supported per-pose updates never scan vertex attributes, and disposal restores prior state', () => {
  const f = fixture(), oldSphere = new THREE.Sphere(new THREE.Vector3(1, 2, 3), 4); f.mesh.boundingSphere = oldSphere;
  const culler = new SkinnedMeshCuller(f.root), position = f.geometry.getAttribute('position'); let reads = 0;
  const getX = position.getX.bind(position); position.getX = (i: number) => { reads++; return getX(i); };
  for (let i = 0; i < 20; i++) { f.tip.rotation.x += .1; f.root.updateMatrixWorld(true); culler.update(); }
  assert.equal(reads, 0); assert.equal(f.mesh.frustumCulled, true);
  culler.dispose(); assert.equal((culler as any).states.length, 0); assert.equal(f.mesh.frustumCulled, false); assert.equal(f.mesh.boundingSphere, oldSphere);
  culler.update(); assert.equal(f.mesh.boundingSphere, oldSphere);
});
