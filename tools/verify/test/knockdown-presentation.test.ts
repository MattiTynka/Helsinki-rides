import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { CharacterView } from '../../../apps/game/src/render/characters.ts';
import { knockdownProgress } from '../../../apps/game/src/render/knockdown-presentation.ts';
import type { CharacterState } from '../../../packages/sim/src/index.ts';

const entry = createRequire(new URL('../../../apps/game/package.json', import.meta.url)).resolve('three');
const THREE = await import(new URL('./three.module.js', pathToFileURL(entry)).href);
const timing = { fallSeconds: 1.4, holdSeconds: .6, riseSeconds: 1.6 };

test('knockdown has continuous collapse, floor hold and recovery, and never recovers a dead actor', () => {
  for (const [elapsed, progress] of [[0, 0], [.7, .5], [1.4, 1], [1.8, 1], [2, 1], [2.8, .5], [3.6, 0]]) {
    assert.ok(Math.abs(knockdownProgress({ ...timing, elapsed: elapsed! }, true)! - progress!) < 1e-12);
  }
  assert.equal(knockdownProgress({ ...timing, elapsed: 3 }, false), null);
  assert.equal(knockdownProgress(null, true), null);
  assert.equal(knockdownProgress({ ...timing, elapsed: NaN }, true), null);
});

test('legacy civilian collapse samples forward then backward without restarting the action each frame', () => {
  const model = new THREE.Group(), hips = new THREE.Bone(); hips.name = 'hips'; model.add(hips);
  const idle = new THREE.AnimationClip('idle', 1, [new THREE.NumberKeyframeTrack('hips.position[y]', [0, 1], [1, 1])]);
  const death = new THREE.AnimationClip('death', 1.4, [new THREE.NumberKeyframeTrack('hips.position[y]', [0, 1.4], [1, 0])]);
  const clips = new Map([['idle', idle], ['death', death]]);
  const assets = { cloneCharacter: () => ({ root: model, asset: { id: 'civilian', scene: model, clips, height: 1.7 } }), clonePistol: () => null } as unknown as ConstructorParameters<typeof CharacterView>[0];
  const view = new CharacterView(assets, 'civilian', new THREE.MeshBasicMaterial());
  const state = { id: 'civilian', position: [0, 0, 0], yaw: 0, clip: 'death', speed: 0, alive: true, health: 100, aiming: false, inVehicle: null, grounded: true, verticalSpeed: 0, jumpPhase: 'grounded', jumpPhaseTime: 0, jumpKind: null, groundDistance: 0, landingSpeed: 0, climb: null } as CharacterState;
  for (const elapsed of [.7, 1.4, 1.8, 2.8, 3.6]) {
    view.update({ ...state, knockdown: { ...timing, elapsed } }, 1 / 60, false);
    assert.ok(Math.abs(hips.position.y - (1 - knockdownProgress({ ...timing, elapsed }, true)!)) < 1e-6);
    assert.equal(view.actions.get('death')!.getEffectiveWeight(), 1);
    assert.equal(view.actions.get('death')!.paused, true);
  }
  view.update({ ...state, clip: 'idle' }, 1 / 60, false);
  assert.equal(view.actions.get('death')!.paused, false);
  assert.ok(hips.position.y > .99, 'standing recovery transitions back into ordinary idle');
  view.dispose();
});
