import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { CharacterAim } from '../../../apps/game/src/render/character-aim.ts';

const entry = createRequire(new URL('../../../apps/game/package.json', import.meta.url)).resolve('three');
const THREE = await import(new URL('./three.module.js', pathToFileURL(entry)).href);

test('upper body converges the authored barrel on the reticle while preserving two-hand grip and legs', () => {
  const model = new THREE.Group(), hips = new THREE.Bone(), spine = new THREE.Bone(), right = new THREE.Bone(), left = new THREE.Bone(), leg = new THREE.Bone(), pistol = new THREE.Group();
  spine.name = 'DEF-Spine'; model.add(hips); hips.add(spine, leg); spine.position.y = 1;
  spine.add(right, left); right.position.set(.03, .38, .48); left.position.set(-.04, .38, .48); right.add(pistol);
  pistol.rotation.y = 5.44 * Math.PI / 180;
  const correction = new CharacterAim(model, pistol), target = new THREE.Vector3(-.55, 3.5, 10);
  model.updateWorldMatrix(true, true);
  const base = spine.quaternion.clone(), gripDistance = right.getWorldPosition(new THREE.Vector3()).distanceTo(left.getWorldPosition(new THREE.Vector3()));
  for (let frame = 0; frame < 100; frame++) {
    correction.restore(); assert.ok(spine.quaternion.angleTo(base) < 1e-8, 'prior correction never accumulates');
    correction.apply(target, 1);
    const muzzle = pistol.localToWorld(new THREE.Vector3(0, 0, .14)), direction = new THREE.Vector3(0, 0, 1).applyQuaternion(pistol.getWorldQuaternion(new THREE.Quaternion()));
    assert.ok(direction.angleTo(target.clone().sub(muzzle)) < 1e-5, 'visible barrel converges to target after muzzle translation');
    assert.ok(Math.abs(right.getWorldPosition(new THREE.Vector3()).distanceTo(left.getWorldPosition(new THREE.Vector3())) - gripDistance) < 1e-10);
    assert.equal(leg.quaternion.angleTo(new THREE.Quaternion()), 0);
  }
  correction.restore(); assert.ok(spine.quaternion.angleTo(base) < 1e-8);
});

test('sudden camera reversal clamps torso twist rather than turning the upper body backwards', () => {
  const model = new THREE.Group(), spine = new THREE.Bone(), pistol = new THREE.Group();
  spine.name = 'DEF-Spine'; model.add(spine); spine.position.y = 1; spine.add(pistol); pistol.position.set(0, .4, .5);
  const correction = new CharacterAim(model, pistol);
  correction.apply(new THREE.Vector3(0, 1.4, -10), 1);
  const d = new THREE.Vector3(0, 0, 1).applyQuaternion(pistol.getWorldQuaternion(new THREE.Quaternion()));
  assert.ok(d.z > .6 && Math.abs(Math.atan2(d.x, d.z)) < .9);
});
